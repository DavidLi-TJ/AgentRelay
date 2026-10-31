'use strict';
// Agent 注册表 v2：实例化架构
// - 内置 agent（默认路径）可启用/停用（config.agents.<type>.enabled）
// - 用户可添加自定义实例（指定类型 + 数据目录，去写死路径），config.customAgents
// - /api/agents 只做廉价计数（不解析会话内容）；会话列表按实例惰性加载 + 30s 缓存
const fs = require('fs');
const path = require('path');
const { HOME, config, saveConfig, ensureDir } = require('./util');
const claude = require('./claude');
const codex = require('./codex');
const zcode = require('./zcode');
const workbuddy = require('./workbuddy');
const opencode = require('./opencode');
const gemini = require('./gemini');
const pi = require('./pi');
const openclaw = require('./openclaw');
const dsh = require('./dsh');
const { lastCompactionIndex } = require('./msx');

const META = {
  claude: { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', color: '#d97757', cli: 'claude' },
  codex: { id: 'codex', name: 'Codex CLI', vendor: 'OpenAI', color: '#10a37f', cli: 'codex' },
  zcode: { id: 'zcode', name: 'ZCode', vendor: 'Z.ai / 智谱', color: '#4f7cff', cli: 'zcode' },
  workbuddy: { id: 'workbuddy', name: 'WorkBuddy', vendor: 'Tencent 腾讯', color: '#3c8cff', cli: null },
  opencode: { id: 'opencode', name: 'OpenCode', vendor: 'sst (open source)', color: '#e8a33d', cli: 'opencode' },
  gemini: { id: 'gemini', name: 'Gemini CLI', vendor: 'Google', color: '#4796e3', cli: 'gemini', experimental: true },
  pi: { id: 'pi', name: 'Pi', vendor: 'earendil-works (open source)', color: '#c9a227', cli: 'pi', experimental: true },
  openclaw: { id: 'openclaw', name: 'OpenClaw', vendor: 'open source', color: '#e05e3d', cli: null, experimental: true },
  dsh: { id: 'dsh', name: 'DeepSeek Harness', vendor: 'deepseek-ai (open source)', color: '#2aa8c9', cli: 'dsh', experimental: true },
};
const ADAPTERS = { claude, codex, zcode, workbuddy, opencode, gemini, pi, openclaw, dsh };

// ---- 实例 ----
function loadInstances() {
  const cfg = config();
  const out = [];
  for (const type of Object.keys(ADAPTERS)) {
    if (cfg.agents?.[type]?.enabled === false) continue;
    const inst = { instanceId: type, type, name: META[type].name, baseDir: null, builtin: true };
    // 实验性适配器：本机未检测到存储时不占主界面（可在设置页手动添加数据目录）
    if (META[type].experimental && !ADAPTERS[type].doctor(inst.baseDir).ok) continue;
    out.push(inst);
  }
  for (const c of cfg.customAgents || []) {
    if (!ADAPTERS[c.type]) continue;
    out.push({
      instanceId: c.instanceId, type: c.type,
      name: c.name || (META[c.type].name + '（自定义）'),
      baseDir: c.dataDir || null, builtin: false,
    });
  }
  return out;
}

function getInstance(instanceId) {
  return loadInstances().find((i) => i.instanceId === instanceId) || null;
}

// ---- 廉价探测（不做内容解析）----
function instanceSummary(inst, { sessions = false, refresh = false } = {}) {
  const a = ADAPTERS[inst.type];
  let available = false, storage = null, count = 0;
  try {
    const d = a.doctor(inst.baseDir);
    available = !!d.ok; storage = d.storage;
    count = d.sessionFiles || 0;
  } catch { }
  if (inst.type === 'zcode' || inst.type === 'opencode') {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const dbp = inst.type === 'zcode'
        ? (inst.baseDir ? path.join(inst.baseDir, 'cli', 'db', 'db.sqlite') : path.join(HOME, '.zcode', 'cli', 'db', 'db.sqlite'))
        : (inst.baseDir ? path.join(inst.baseDir, 'opencode.db') : path.join(HOME, '.local', 'share', 'opencode', 'opencode.db'));
      if (fs.existsSync(dbp)) {
        const db = new DatabaseSync(dbp, { readOnly: true });
        try { count = db.prepare('SELECT count(*) c FROM session').get().c; } finally { db.close(); }
      }
    } catch { }
  }
  const out = {
    id: inst.instanceId, instanceId: inst.instanceId, type: inst.type,
    name: inst.name, baseDir: inst.baseDir, builtin: inst.builtin,
    available, storage, sessionCount: count, sessions: [],
  };
  if (inst.type === 'workbuddy') out.note = available ? null : '已安装，未发现会话';
  if (sessions && available) out.sessions = listInstanceSessions(inst, { refresh });
  return out;
}

function listInstances({ sessions = false } = {}) {
  return loadInstances().map((inst) => instanceSummary(inst, { sessions }));
}

// ---- 惰性会话列表（30s 缓存 + 显式刷新）----
const _listCache = new Map(); // instanceId → { at, sessions }
function listInstanceSessions(inst, { refresh = false } = {}) {
  const hit = _listCache.get(inst.instanceId);
  if (!refresh && hit && Date.now() - hit.at < 30000) return hit.sessions;
  const sessions = ADAPTERS[inst.type].listSessions(inst.baseDir) || [];
  _listCache.set(inst.instanceId, { at: Date.now(), sessions });
  return sessions;
}
function bustListCache() { _listCache.clear(); }

// ---- 读取（实例感知；type 兼容旧调用：取该类型第一个实例，逐实例回退）----
// 注意各适配器签名不同：zcode.readSession(id, {dbFile, baseDir})，其余为 readSession(id, baseDir)
function callReadSession(type, adapter, sessionId, baseDir) {
  const pending = type === 'zcode' || type === 'opencode'
    ? adapter.readSession(sessionId, { baseDir })
    : adapter.readSession(sessionId, baseDir);
  return Promise.resolve(pending).then((msx) => {
    try { msx.lastCompactionIndex = lastCompactionIndex(msx.entries, msx.compactions); } catch { }
    return msx;
  });
}

async function readMsxInstance(instanceId, sessionId) {
  const inst = getInstance(instanceId);
  if (!inst) throw new Error(`agent 实例不存在: ${instanceId}`);
  if (!ADAPTERS[inst.type].readSession) throw new Error(`agent ${inst.type} 暂不支持读取`);
  return callReadSession(inst.type, ADAPTERS[inst.type], sessionId, inst.baseDir);
}

// 旧接口：按类型读取。先试第一个实例，找不到再遍历其余实例（跨实例找回会话）
async function readMsx(type, sessionId) {
  const insts = loadInstances().filter((i) => i.type === type);
  if (!insts.length) throw new Error(`agent ${type} 未启用或未安装`);
  let lastErr = null;
  for (const inst of insts) {
    try {
      const msx = await callReadSession(type, ADAPTERS[type], sessionId, inst.baseDir);
      if (insts.length > 1) msx._resolvedInstance = inst.instanceId;
      return msx;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error(`agent ${type} 中未找到会话: ${sessionId}`);
}

// ---- 写入目标解析 ----
function writeTarget(instanceId) {
  const inst = getInstance(instanceId);
  if (!inst) throw new Error(`agent 实例不存在: ${instanceId}`);
  return { inst, adapter: ADAPTERS[inst.type] };
}

// 设置页专用：返回全部实例（含已停用的内置实例），enabled 反映真实开关状态
function instancesForSettings() {
  const out = [];
  for (const type of Object.keys(ADAPTERS)) {
    const inst = { instanceId: type, type, name: META[type].name, baseDir: null, builtin: true };
    const enabled = loadInstances().some((i) => i.instanceId === type);
    let probe = { ok: false, storage: null };
    try { probe = ADAPTERS[type].doctor(inst.baseDir); } catch { }
    out.push({ ...inst, enabled, available: enabled && probe.ok, storage: probe.storage || null, sessionCount: 0 });
  }
  for (const inst of loadInstances()) {
    if (inst.builtin) continue;
    let probe = { ok: false, storage: null };
    try { probe = ADAPTERS[inst.type].doctor(inst.baseDir); } catch { }
    out.push({ ...inst, enabled: true, available: probe.ok, storage: probe.storage || inst.baseDir, sessionCount: 0 });
  }
  return out;
}

// ---- 管理：启用/停用 + 自定义实例 ----
function setTypeEnabled(type, enabled) {
  if (!META[type]) throw new Error('未知 agent 类型: ' + type);
  const cfg = config();
  const agents = { ...(cfg.agents || {}) };
  agents[type] = { ...agents[type], enabled: !!enabled };
  saveConfig({ agents });
  return { type, enabled: !!enabled };
}

function addCustomInstance({ type, name, dataDir }) {
  if (!META[type]) throw new Error('未知 agent 类型: ' + type);
  if (!dataDir) throw new Error('dataDir 必填');
  const abs = path.resolve(dataDir);
  if (!fs.existsSync(abs)) throw new Error(`目录不存在: ${abs}`);
  // 探测：该目录下能否找到存储标志
  const probe = ADAPTERS[type].doctor(abs);
  if (!probe.ok) {
    const expect = { claude: 'projects 目录', codex: 'sessions 目录 / state_5.sqlite', zcode: 'cli/db/db.sqlite', workbuddy: 'workbuddy.db' }[type];
    throw new Error(`在 ${abs} 下未找到 ${type} 的存储（应有 ${expect}）`);
  }
  const cfg = config();
  const customAgents = [...(cfg.customAgents || [])];
  const instanceId = `${type}-custom-${Math.random().toString(36).slice(2, 8)}`;
  customAgents.push({ instanceId, type, name: name || (META[type].name + '（自定义）'), dataDir: abs });
  saveConfig({ customAgents });
  const inst = { instanceId, type, name, baseDir: abs, builtin: false };
  return instanceSummary(inst);
}

function removeCustomInstance(instanceId) {
  const cfg = config();
  const customAgents = (cfg.customAgents || []).filter((c) => c.instanceId !== instanceId);
  if (customAgents.length === (cfg.customAgents || []).length) throw new Error('实例不存在或为内置 agent（内置的请用停用开关）');
  saveConfig({ customAgents });
  _listCache.delete(instanceId);
  return { removed: instanceId };
}

// ---- 兼容层 ----
// 旧调用 agentSummary(type)：聚合该类型所有实例（带会话列表）
function agentSummary(type, { sessions = false } = {}) {
  const insts = loadInstances().filter((i) => i.type === type);
  const out = { ...META[type], id: type, available: false, storage: null, sessionCount: 0, sessions: [], instances: [] };
  for (const inst of insts) {
    const s = instanceSummary(inst, { sessions });
    out.instances.push(s);
    out.available = out.available || s.available;
    out.sessionCount += s.sessionCount;
    if (s.sessions && s.sessions.length) out.sessions = out.sessions.concat(s.sessions.map((x) => ({ ...x, _instanceId: inst.instanceId })));
    if (!out.storage && s.storage) out.storage = s.storage;
  }
  if (!insts.length) out.available = false;
  return out;
}

function listAgents({ sessions = false } = {}) {
  // 按类型聚合（保持兼容），同时携带实例明细
  const types = Object.keys(ADAPTERS);
  return types.map((type) => {
    const agg = agentSummary(type, { sessions });
    return agg;
  });
}

// 所有实例（扁平）
function allInstances({ sessions = false } = {}) {
  return loadInstances().map((inst) => instanceSummary(inst, { sessions }));
}

// 所有已知项目目录（接力目标 cwd 候选）
function listTargets() {
  const set = new Map();
  const add = (cwd) => {
    if (!cwd || typeof cwd !== 'string') return;
    if (cwd.startsWith('\\\\?\\')) cwd = cwd.slice(4);
    if (!fs.existsSync(cwd)) return;
    if (/WorkBuddy AI[\/]20\d\d-/.test(cwd)) return; // WorkBuddy 自动时间戳工作区不算项目
    if (path.parse(cwd).root === cwd) return; // 盘根
    if (!set.has(cwd)) set.set(cwd, { cwd, label: path.basename(cwd) || cwd, agents: [] });
  };
  for (const inst of loadInstances()) {
    try {
      for (const s of instanceSummary(inst, { sessions: true }).sessions) add(s.cwd);
    } catch { }
  }
  return [...set.values()].sort((a, b) => a.cwd.localeCompare(b.cwd));
}

function detectWorkbuddy() {
  const candidates = [
    path.join(HOME, '.workbuddy'),
    path.join(HOME, '.workbuddy-ai'),
    path.join(HOME, 'AppData', 'Roaming', 'WorkBuddy AI'),
    path.join(HOME, 'AppData', 'Local', 'workbuddy-ai'),
    path.join(HOME, 'workbuddy'),
    // macOS 桌面端常见容器路径
    path.join(HOME, 'Library', 'Application Support', 'WorkBuddy AI'),
    path.join(HOME, 'Library', 'Application Support', 'workbuddy-ai'),
  ];
  const found = candidates.filter((p) => fs.existsSync(p));
  let dbs = [];
  for (const base of found) {
    try { dbs = dbs.concat(findSqlite(base, 4)); } catch { }
  }
  return { installed: found.length > 0, ok: found.length > 0, paths: found, sqliteFiles: dbs.slice(0, 10), sessionCount: 0, adapter: 'export/T1/T2 可用；无 CLI resume' };
}

function findSqlite(dir, depth) {
  const out = [];
  if (depth <= 0) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findSqlite(p, depth - 1));
    else if (/\.(sqlite|sqlite3|db)$/i.test(e.name)) out.push(p);
  }
  return out;
}

module.exports = {
  META, ADAPTERS, loadInstances, getInstance, instanceSummary, listInstances, allInstances, instancesForSettings,
  listInstanceSessions, bustListCache, readMsxInstance, readMsx, writeTarget,
  setTypeEnabled, addCustomInstance, removeCustomInstance,
  agentSummary, listAgents, listTargets, detectWorkbuddy,
};
