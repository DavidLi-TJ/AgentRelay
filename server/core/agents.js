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
const vscode = require('./vscode');
const cursor = require('./cursor');
const doubao = require('./doubao');
const { lastCompactionIndex } = require('./msx');

// cap = 原生接力能力（单一事实来源；transfer/GUI/CLI/MCP 均读这里，勿再散落硬编码清单）
// t0 同源原生复制 | t1 跨源原生注入 | t2 逐字转写注入（所有 agent 通用兜底，恒 true 不单列）
const META = {
  claude: { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', color: '#d97757', cli: 'claude', cap: { t0: 1, t1: 1 } },
  codex: { id: 'codex', name: 'Codex CLI', vendor: 'OpenAI', color: '#10a37f', cli: 'codex', cap: { t0: 1, t1: 1 } },
  zcode: { id: 'zcode', name: 'ZCode', vendor: 'Z.ai / 智谱', color: '#4f7cff', cli: 'zcode', cap: { t0: 1, t1: 1 } },
  workbuddy: { id: 'workbuddy', name: 'WorkBuddy', vendor: 'Tencent 腾讯', color: '#3c8cff', cli: null, cap: { t0: 0, t1: 1 } },
  opencode: { id: 'opencode', name: 'OpenCode', vendor: 'sst (open source)', color: '#e8a33d', cli: 'opencode', cap: { t0: 0, t1: 1 } },
  gemini: { id: 'gemini', name: 'Gemini CLI', vendor: 'Google', color: '#4796e3', cli: 'gemini', experimental: true, cap: { t0: 1, t1: 1 } },
  pi: { id: 'pi', name: 'Pi', vendor: 'earendil-works (open source)', color: '#c9a227', cli: 'pi', experimental: true, cap: { t0: 1, t1: 1 } },
  openclaw: { id: 'openclaw', name: 'OpenClaw', vendor: 'open source', color: '#e05e3d', cli: null, experimental: true, cap: { t0: 1, t1: 1 } },
  dsh: { id: 'dsh', name: 'DeepSeek Harness', vendor: 'deepseek-ai (open source)', color: '#2aa8c9', cli: 'dsh', experimental: true, cap: { t0: 1, t1: 1 } },
  vscode: { id: 'vscode', name: 'VS Code Copilot', vendor: 'GitHub (open source)', color: '#8957e5', cli: null, experimental: true, cap: { t0: 1, t1: 1 } },
  cursor: { id: 'cursor', name: 'Cursor', vendor: 'Anysphere', color: '#6c7ee1', cli: 'cursor-agent', experimental: true, cap: { t0: 0, t1: 1 } },
  doubao: { id: 'doubao', name: '豆包工作', vendor: 'ByteDance 字节跳动', color: '#3b6dfd', cli: null, experimental: true, cap: { t0: 0, t1: 0 }, note: '会话存于应用内 IndexedDB/云端，无本地原生存储；仅支持 T2 逐字转写写入其项目目录' },
};
const ADAPTERS = { claude, codex, zcode, workbuddy, opencode, gemini, pi, openclaw, dsh, vscode, cursor, doubao };

// DSH 的 T0/T1 依赖 Node ≥23.8 的内置 zstd（写入要压缩、读取要解压）；低版本直接降级到 T2，
// 避免 GUI 按静态 cap 推荐 T1 后才在写入时报错（审核 P2）
if (typeof require('zlib').zstdCompressSync !== 'function') {
  META.dsh.cap = { t0: 0, t1: 0 };
  META.dsh.note = '本机 Node 缺少内置 zstd（需 ≥23.8），DSH 暂只能作为 T2 目标 / 只读源';
}

// ---- 实例 ----
// 内置实例定义（每类型一张默认卡 + WorkBuddy 双版本）。
// hideIfMissing：主界面未检测到存储时不占位（仍可在设置页启停 / 手动添加自定义实例）。
const WORKBUDDY_INTL = 'workbuddy-intl';
function builtinDefs() {
  const defs = [];
  for (const type of Object.keys(ADAPTERS)) {
    const def = { instanceId: type, type, name: META[type].name, baseDir: null, hideIfMissing: !!META[type].experimental };
    if (type === 'workbuddy') {
      // WorkBuddy 国内版（~/.workbuddy）与国际版（~/.workbuddy-ai）是两套独立安装：
      // 拆成两个内置实例，各锁各的目录，绝不互相回退混扫
      def.name = 'WorkBuddy（国内版）';
      def.baseDir = path.join(HOME, '.workbuddy');
    }
    defs.push(def);
  }
  defs.push({
    instanceId: WORKBUDDY_INTL, type: 'workbuddy', name: 'WorkBuddy AI（国际版）',
    baseDir: path.join(HOME, '.workbuddy-ai'), hideIfMissing: true,
  });
  return defs;
}

function loadInstances() {
  const cfg = config();
  const out = [];
  for (const def of builtinDefs()) {
    if (cfg.agents?.[def.instanceId]?.enabled === false) continue;
    const inst = { instanceId: def.instanceId, type: def.type, name: def.name, baseDir: def.baseDir, builtin: true };
    // 未检测到存储时不占主界面（可在设置页手动添加数据目录）
    if (def.hideIfMissing && !ADAPTERS[def.type].doctor(inst.baseDir).ok) continue;
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
    // 原生接力能力 + 实验性标记（META 单一事实源；GUI targetAdvice/recommendMode 读它）
    cap: (META[inst.type] && META[inst.type].cap) || { t0: 0, t1: 0 },
    experimental: !!(META[inst.type] && META[inst.type].experimental),
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
    // 存储签名（主文件 + wal/shm 的 mtime+size）：SQLite 写入多落 WAL，只看主库 mtime 判不出脏
    try {
      const f = msx.source && msx.source.file;
      if (f && fs.existsSync(f)) {
        msx._storeSig = [f, f + '-wal', f + '-shm'].map((p) => {
          try { const st = fs.statSync(p); return st.mtimeMs + ':' + st.size; } catch { return '0:0'; }
        }).join('|');
      }
    } catch { }
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
  // 短 id 前缀（CLI list 只展示 8 位）：跨该类型全部实例收集唯一命中并展开；多命中报错
  let sid = String(sessionId);
  if (sid.length <= 16) {
    const full = new Set();
    for (const inst of insts) {
      try {
        for (const s of listInstanceSessions(inst)) {
          if (s.id === sid || s.id.startsWith(sid)) full.add(s.id);
        }
      } catch { }
      if (full.size > 1) break;
    }
    if (full.size === 1) sid = [...full][0];
    else if (full.size > 1) throw new Error(`id 前缀 "${sid}" 命中 ${full.size} 个会话，请提供更长的前缀或完整 id（list --verbose 可看）`);
  }
  let lastErr = null;
  for (const inst of insts) {
    try {
      const msx = await callReadSession(type, ADAPTERS[type], sid, inst.baseDir);
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
  const counts = new Map(listInstances().map((i) => [i.instanceId || i.id, i.sessionCount || 0]));
  const cfg = config();
  const out = [];
  for (const def of builtinDefs()) {
    const inst = { instanceId: def.instanceId, type: def.type, name: def.name, baseDir: def.baseDir, builtin: true };
    // enabled 只反映用户设置（未设置 = 启用）；"未安装"与"已停用"是两回事
    const enabled = cfg.agents?.[def.instanceId]?.enabled !== false;
    let probe = { ok: false, storage: null };
    try { probe = ADAPTERS[def.type].doctor(inst.baseDir); } catch { }
    out.push({
      ...inst, enabled, available: enabled && probe.ok, storage: probe.storage || null, sessionCount: counts.get(def.instanceId) || 0,
      // 能力单一事实源：设置页同样携带 cap/experimental
      cap: (META[def.type] && META[def.type].cap) || { t0: 0, t1: 0 },
      experimental: !!(META[def.type] && META[def.type].experimental),
      note: META[def.type] && META[def.type].note,
    });
  }
  for (const inst of loadInstances()) {
    if (inst.builtin) continue;
    let probe = { ok: false, storage: null };
    try { probe = ADAPTERS[inst.type].doctor(inst.baseDir); } catch { }
    out.push({
      ...inst, enabled: true, available: probe.ok, storage: probe.storage || inst.baseDir, sessionCount: counts.get(inst.instanceId) || 0,
      cap: (META[inst.type] && META[inst.type].cap) || { t0: 0, t1: 0 },
      experimental: !!(META[inst.type] && META[inst.type].experimental),
      note: (META[inst.type] && META[inst.type].note) || null,
    });
  }
  return out;
}

// ---- 管理：启用/停用 + 自定义实例 ----
// type 可以是 agent 类型（claude…）或内置实例 id（workbuddy-intl 等双版本实例）
function setTypeEnabled(type, enabled) {
  const isBuiltinInst = builtinDefs().some((d) => d.instanceId === type);
  if (!META[type] && !isBuiltinInst) throw new Error('未知 agent 类型: ' + type);
  const cfg = config();
  const agents = { ...(cfg.agents || {}) };
  agents[type] = { ...agents[type], enabled: !!enabled };
  saveConfig({ agents });
  bustListCache();
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
    const expect = {
      claude: 'projects 目录', codex: 'sessions 目录 / state_5.sqlite', zcode: 'cli/db/db.sqlite',
      workbuddy: 'workbuddy.db', opencode: 'opencode.db', dsh: 'sessions 目录（zstd jsonl）',
      vscode: 'workspaceStorage/*/GitHub.copilot-chat/transcripts',
      gemini: 'tmp/*/chats 目录', pi: 'sessions 目录（jsonl）', openclaw: 'agents 目录（jsonl）',
      doubao: 'User Data 目录（豆包桌面端，仅 T2 目标）',
      cursor: 'User/globalStorage/state.vscdb（Cursor 数据目录的上级）',
    }[type] || '存储目录';
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
