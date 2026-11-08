'use strict';
// VS Code Copilot（内置 Chat/Agent）只读适配器（实验性）
// 存储：workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/<uuid>.jsonl
// 每行一个事件：{id, timestamp, parentId, type, data}
//   session.start{sessionId,copilotVersion,vscodeVersion,startTime}
//   user.message{content,attachments} · assistant.message{content}
//   tool.execution_start{toolCallId,toolName,arguments} · tool.execution_complete{toolCallId,success}
// 已知限制：VS Code 不落工具输出（只存 success 标志），tool_result 记为占位并写入 loss。
// workspace 真实路径由同级 workspace.json 的 file:/// URI 反解。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { nowISO, truncateStr, estimateTokens } = require('./util');

const AGENT = 'vscode';

function defaultRoots() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return [path.join(base, 'Code', 'User', 'workspaceStorage'), path.join(base, 'Code - Insiders', 'User', 'workspaceStorage')];
  }
  if (process.platform === 'darwin') {
    const base = path.join(os.homedir(), 'Library', 'Application Support');
    return [path.join(base, 'Code', 'User', 'workspaceStorage'), path.join(base, 'Code - Insiders', 'User', 'workspaceStorage')];
  }
  const base = path.join(os.homedir(), '.config');
  return [path.join(base, 'Code', 'User', 'workspaceStorage'), path.join(base, 'Code - Insiders', 'User', 'workspaceStorage')];
}

function storageRoot(baseDir) {
  if (baseDir) return baseDir;
  for (const r of defaultRoots()) {
    try { if (fs.existsSync(r)) return r; } catch { }
  }
  return defaultRoots()[0];
}

// workspaceStorage 下所有含 Copilot 会话的 <hash>/GitHub.copilot-chat 目录
function chatDirs(baseDir) {
  const root = storageRoot(baseDir);
  const out = [];
  try {
    for (const h of fs.readdirSync(root)) {
      const d = path.join(root, h, 'GitHub.copilot-chat');
      if (fs.existsSync(path.join(d, 'transcripts'))) out.push({ dir: d, hash: h, root });
    }
  } catch { }
  return out;
}

function transcriptsOf(chatDir) {
  const d = path.join(chatDir, 'transcripts');
  try { return fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(d, f)); } catch { return []; }
}

// workspace.json 的 file:/// URI → 本地路径（盘符形态 c:/demo/app）
function uriToPath(uri) {
  if (!uri) return null;
  try {
    let p = decodeURIComponent(String(uri));
    p = p.replace(/^file:\/\//i, '');
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1); // /c:/x → c:/x
    return p || null;
  } catch { return null; }
}

function workspaceCwd(hashDir) {
  try {
    const wj = JSON.parse(fs.readFileSync(path.join(hashDir, 'workspace.json'), 'utf8'));
    return uriToPath(wj.folder || wj.workspace) || null;
  } catch { return null; }
}

function readJsonl(file) {
  const lines = [];
  try {
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { lines.push(JSON.parse(l)); } catch { }
    }
  } catch { }
  return lines;
}

function doctor(baseDir) {
  const root = storageRoot(baseDir);
  let sessionFiles = 0;
  for (const { dir } of chatDirs(baseDir)) sessionFiles += transcriptsOf(dir).length;
  return {
    ok: sessionFiles > 0,
    storage: root,
    sessionFiles,
    note: sessionFiles > 0 ? '工具输出 VS Code 不持久化（已核实 transcripts/workspace/global state.vscdb/memento 全部位置，仅存于渲染进程内存），接力后的会话该处为占位' : '未发现 Copilot Chat transcripts',
  };
}

function listSessions(baseDir) {
  const out = [];
  for (const { dir, hash } of chatDirs(baseDir)) {
    const cwd = workspaceCwd(path.dirname(dir));
    for (const file of transcriptsOf(dir)) {
      try {
        const info = scanFile(file, cwd);
        if (!info) continue;
        info.hashDir = hash;
        out.push(info);
      } catch { }
    }
  }
  out.sort((a, b) => (b.tsLast || '').localeCompare(a.tsLast || ''));
  return out;
}

function scanFile(file, cwdFallback) {
  const stat = fs.statSync(file);
  const lines = readJsonl(file);
  let id = path.basename(file, '.jsonl'), tsFirst = null, tsLast = null;
  let title = '', version = null, msgCount = 0, toolCalls = 0;
  let cwd = cwdFallback || null;
  for (const o of lines) {
    if (o.timestamp) { if (!tsFirst) tsFirst = o.timestamp; tsLast = o.timestamp; }
    const d = o.data || {};
    if (o.type === 'session.start') {
      id = d.sessionId || id;
      version = d.vscodeVersion || version;
      if (d.startTime && !tsFirst) tsFirst = d.startTime;
    }
    if (o.type === 'user.message' && d.content) {
      if (!title) title = truncateStr(String(d.content).replace(/[\r\n]+/g, ' ').trim(), 60);
      msgCount++;
    }
    if (o.type === 'assistant.message') msgCount++;
    if (o.type === 'tool.execution_start') toolCalls++;
  }
  return {
    id, file, agent: AGENT, title: title || '(无标题)', cwd: cwd || '', version,
    tsFirst, tsLast, msgCount, toolCalls, size: stat.size, archived: false,
  };
}

async function readSession(sessionIdOrFile, baseDir) {
  let file = sessionIdOrFile;
  if (!fs.existsSync(file)) {
    let found = null;
    for (const { dir } of chatDirs(baseDir)) {
      for (const f of transcriptsOf(dir)) {
        const lines = readJsonl(f);
        const start = lines.find((o) => o.type === 'session.start');
        if ((start && start.data && start.data.sessionId === sessionIdOrFile) || path.basename(f, '.jsonl') === sessionIdOrFile) { found = f; break; }
      }
      if (found) break;
    }
    if (!found) throw new Error(`VS Code Copilot 会话不存在: ${sessionIdOrFile}`);
    file = found;
  }
  const stat = fs.statSync(file);
  const lines = readJsonl(file);
  const entries = [];
  const loss = [];
  let title = '';
  let vscodeVersion = null, copilotVersion = null, cwd = null;
  let recordedTokens = 0;
  let toolOutputNote = false;

  const hashDir = path.dirname(path.dirname(file)); // transcripts/.. = GitHub.copilot-chat
  cwd = workspaceCwd(path.dirname(hashDir));

  const openToolCalls = new Map(); // toolCallId → entry（start 时先挂 use，complete 时补 result）
  for (const o of lines) {
    const ts = o.timestamp || null;
    const d = o.data || {};
    if (o.type === 'session.start') {
      vscodeVersion = d.vscodeVersion || vscodeVersion;
      copilotVersion = d.copilotVersion || copilotVersion;
      continue;
    }
    if (o.type === 'user.message') {
      const text = String(d.content ?? '');
      if (!text.trim()) continue; // VS Code 会产出空正文事件（占位/裁剪），跳过
      if (!title) title = truncateStr(text.replace(/[\r\n]+/g, ' ').trim(), 60);
      entries.push({ id: o.id || 'u' + entries.length, ts, role: 'user', kind: 'text', blocks: [{ type: 'text', text }], meta: { attachments: (d.attachments || []).length || undefined } });
      continue;
    }
    if (o.type === 'assistant.message') {
      const text = String(d.content ?? '');
      if (!text.trim()) continue;
      entries.push({ id: o.id || 'a' + entries.length, ts, role: 'assistant', kind: 'text', blocks: [{ type: 'text', text }], meta: {} });
      continue;
    }
    if (o.type === 'tool.execution_start') {
      const use = { id: 't' + entries.length, ts, role: 'assistant', kind: 'text', blocks: [{ type: 'tool_use', id: d.toolCallId, name: d.toolName || 'tool', input: d.arguments ?? {} }], meta: {} };
      entries.push(use);
      openToolCalls.set(d.toolCallId, use);
      continue;
    }
    if (o.type === 'tool.execution_complete') {
      if (!toolOutputNote) { loss.push('VS Code 不保存工具执行输出（只记录成功/失败标志）——tool_result 为占位'); toolOutputNote = true; }
      entries.push({ id: o.id || 'r' + entries.length, ts, role: 'user', kind: 'tool-result', blocks: [{ type: 'tool_result', for: d.toolCallId, output: `[工具执行完成: success=${!!d.success}；输出未由 VS Code 保存]`, isError: !d.success }], meta: {} });
      openToolCalls.delete(d.toolCallId);
      continue;
    }
    // assistant.turn_start / turn_end 等标记：跳过
  }
  if (toolOutputNote) loss.push('如需工具输出原文，请以 Claude Code / Codex 等原生会话为源');

  const stats = {
    entries: entries.length,
    userTurns: entries.filter((e) => e.role === 'user' && e.kind === 'text').length,
    assistantEntries: entries.filter((e) => e.role === 'assistant').length,
    toolCalls: 0, toolResults: 0, thinking: 0, approxTokens: 0, recordedTokens,
  };
  for (const e of entries) {
    stats.approxTokens += estimateTokens(JSON.stringify(e.blocks));
    for (const b of e.blocks || []) {
      if (b.type === 'tool_use') stats.toolCalls++;
      if (b.type === 'tool_result') stats.toolResults++;
      if (b.type === 'thinking') stats.thinking++;
    }
  }
  if (entries.some((e) => (e.blocks || []).some((b) => b.type === 'tool_use'))) {
    // start/complete 交错时保证 use/result 配对完整
    const { enforceToolPairing } = require('./msx');
    enforceToolPairing(entries, loss);
  }

  return {
    arx: 1, id: require('./util').randomUUID(), created_at: nowISO(),
    source: { agent: AGENT, agent_version: copilotVersion, session_id: path.basename(file, '.jsonl'), title: title || '(无标题)', file },
    project: { cwd: cwd || '' },
    env: { model: null, cli_version: vscodeVersion, copilot_version: copilotVersion },
    stats, entries, compactions: [], loss,
    _fileStat: { size: stat.size, mtimeMs: stat.mtimeMs },
  };
}

// ---------- T1 写入 / T0 复制 ----------
const crypto = require('crypto');
const { ensureDir, openJsonlWriter, writeAtomic } = require('./util');

function normKey(p) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
}

// cwd → 已存在的 workspaceStorage/<hash>（VS Code 以 workspace.json 的 file:/// URI 记录项目）。
// 找不到返回 null：不能凭空造 hash（VS Code 用它定位工作区），此时应改走 T2。
function hashForCwd(cwd, baseDir) {
  const root = storageRoot(baseDir);
  const key = normKey(cwd);
  try {
    for (const h of fs.readdirSync(root)) {
      const wj = path.join(root, h, 'workspace.json');
      if (!fs.existsSync(wj)) continue;
      const p = workspaceCwd(path.join(root, h));
      if (p && normKey(p) === key) return path.join(root, h);
    }
  } catch { }
  return null;
}

// ARX 条目 → Copilot Chat transcript 事件行
function vscodeRowsFrom(entries, loss) {
  const rows = [];
  let prev = null;
  let thinkLoss = false, imageLoss = false, metaSeen = false;
  const push = (type, data, ts) => {
    const id = crypto.randomUUID();
    rows.push({ id, timestamp: ts || new Date().toISOString(), parentId: prev, type, data });
    prev = id;
  };
  for (const e of entries) {
    const ts = e.ts || null;
    for (const b of e.blocks || []) if (b.type === 'image') imageLoss = true; // 用户/助手/元条目里的图片都记损
    if (e.role === 'user' && e.kind === 'text') {
      const txt = (e.blocks || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
      if (txt.trim()) push('user.message', { content: txt, attachments: [] }, ts);
      continue;
    }
    if (e.role === 'meta' || e.role === 'system') {
      const txt = (e.blocks || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
      if (txt.trim()) { metaSeen = true; push('user.message', { content: `[meta] ${txt}`, attachments: [] }, ts); }
      continue;
    }
    if (e.kind === 'tool-result') {
      const b = (e.blocks || []).find((x) => x.type === 'tool_result');
      if (!b) continue;
      const outText = typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? '');
      // VS Code 原生不保存输出（仅 success 标志）；输出放非标字段 output 便于人工/未来版本读取
      push('tool.execution_complete', { toolCallId: b.for || 'call', success: !b.isError, output: outText }, ts);
      continue;
    }
    if (e.role !== 'assistant') continue;
    for (const b of e.blocks || []) {
      if (b.type === 'text' && b.text) push('assistant.message', { content: b.text }, ts);
      else if (b.type === 'thinking' && b.text) thinkLoss = true;
      else if (b.type === 'tool_use') push('tool.execution_start', { toolCallId: b.id || crypto.randomUUID(), toolName: b.name || 'tool', arguments: b.input ?? {} }, ts);
      else if (b.type === 'image') imageLoss = true;
    }
  }
  if (thinkLoss) loss.push('VS Code transcript 无思考(thinking)事件类型，思考块已省略');
  if (imageLoss) loss.push('VS Code transcript 无图片事件类型，图片块已省略');
  if (metaSeen) loss.push('VS Code: [meta] 条目转为用户消息');
  if (rows.some((r) => r.type === 'tool.execution_complete' && r.data.output != null)) {
    loss.push('工具输出写入了非标准字段 tool.execution_complete.output（官方 VS Code 不读取，仅便于人工追溯）');
  }
  return rows;
}

// T1：写 <hash>/GitHub.copilot-chat/transcripts/<uuid>.jsonl（transcripts 为目录扫描式 listing，落盘即可见）
async function writeSession(msx, { cwd, baseDir } = {}) {
  const loss = [...(msx.loss || [])]; // 继承上游（编辑器/读取器）已记录的说明
  const entries = msx.entries || [];
  if (!entries.length) throw new Error('没有可写入的内容条目（过滤条件排除了全部内容）');
  if (!cwd) throw new Error('VS Code Copilot T1 注入需要目标项目 cwd');
  const hashDir = hashForCwd(cwd, baseDir);
  if (!hashDir) {
    throw new Error(`在 VS Code workspaceStorage 中未找到打开过 ${cwd} 的工作区（T1 需要已存在的 workspace hash）：请先用 VS Code 打开该项目一次，或改用 T2 逐字转写注入`);
  }
  const newId = crypto.randomUUID();
  const tdir = ensureDir(path.join(hashDir, 'GitHub.copilot-chat', 'transcripts'));
  const file = path.join(tdir, `${newId}.jsonl`);
  const rows = vscodeRowsFrom(entries, loss);
  const w = openJsonlWriter(file);
  w.write({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), parentId: null, type: 'session.start', data: { sessionId: newId, startTime: new Date().toISOString() } });
  for (const r of rows) w.write(r);
  await w.close();
  return {
    id: newId, path: file, count: rows.length, loss,
    resumeCommand: `VS Code（打开 ${cwd}）→ Chat → History 查看「${(msx.source && msx.source.title) || newId.slice(0, 8)}」（实验性：恢复衔接行为随 VS Code 版本而异）`,
    notes: ['写入前请完全关闭 VS Code 窗口，避免内存态回写覆盖'],
  };
}

// T0：同源原生复制（替换 session.start 的 sessionId + 文件名；其余字节原样）
function rawCopy(sessionId, { baseDir } = {}) {
  for (const { dir } of chatDirs(baseDir)) {
    for (const f of transcriptsOf(dir)) {
      const info = scanFile(f, null);
      if (info.id !== sessionId && path.basename(f, '.jsonl') !== sessionId) continue;
      const newId = crypto.randomUUID();
      const text = fs.readFileSync(f, 'utf8');
      const replaced = info.id ? text.split(info.id).join(newId) : text;
      const newFile = path.join(path.dirname(f), `${newId}.jsonl`);
      writeAtomic(newFile, replaced);
      return { id: newId, path: newFile, count: info.msgCount || 0, loss: ['T0 逐字复制：内容原样保留（仅替换会话 id）'] };
    }
  }
  throw new Error(`VS Code Copilot 会话不存在: ${sessionId}`);
}

module.exports = { listSessions, readSession, doctor, writeSession, rawCopy, hashForCwd };
