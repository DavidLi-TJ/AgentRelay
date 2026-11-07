'use strict';
// Cursor IDE 适配器 —— 🧪 实验性（schema 来自社区逆向：vibe-replay / DoubleAgent / cursor-chat-transfer，本机未安装）
// 存储三代格式（读端全部兼容，按优先级合并）：
//   Gen A (2024)  workspaceStorage/<hash>/state.vscdb ItemTable 'workbench.panel.aichat.view.aichat.chatdata' —— 只读不再单列（多代前的残留，能解析就解析）
//   Gen B (2025)  globalStorage/state.vscdb cursorDiskKV：composerData:<id>（含 fullConversationHeadersOnly）+ bubbleId:<cid>:<bid>
//   Gen C (2026)  同库 composerHeaders 表（composerId/workspaceId/recency...）+ composerConvHeaders:<cid>:<NNNNNN> 分块头
// 工具输出持久化在 bubble.toolFormerData.result（与 VS Code Copilot 不同，工具输出不丢）。
// cwd 由 workspaceStorage/<hash>/workspace.json 的 file:/// URI 反解；composerHeaders.workspaceId → hash。
// T1 写入：写 cursorDiskKV（composerData:* + bubbleId:*）+（表存在时）composerHeaders 行 + workspace ItemTable 注册。
// ⚠ Cursor 必须完全退出：内存态退出时可能回写覆盖外部写入。写前强制 VACUUM INTO 快照（backupTargetsFor）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { HOME, nowISO, truncateStr, safeParse, ensureDir } = require('./util');

const AGENT = 'cursor';

function userDir() {
  if (process.platform === 'win32') return process.env.APPDATA ? path.join(process.env.APPDATA, 'Cursor', 'User') : path.join(HOME, 'AppData', 'Roaming', 'Cursor', 'User');
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User');
  return path.join(HOME, '.config', 'Cursor', 'User');
}
function globalDb(baseDir) {
  if (baseDir) return path.join(baseDir, 'state.vscdb');
  return path.join(userDir(), 'globalStorage', 'state.vscdb');
}
function workspaceStorageRoot(baseDir) {
  if (baseDir) return path.join(path.dirname(baseDir), 'workspaceStorage');
  return path.join(userDir(), 'workspaceStorage');
}

function openDb(file, { readOnly = true } = {}) {
  if (!fs.existsSync(file)) return null;
  try { return new DatabaseSync(file, { readOnly }); } catch { return null; }
}

function tableExists(db, name) {
  try { return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name); } catch { return false; }
}

// workspace.json 的 file:/// URI → 本地路径
function uriToPath(uri) {
  if (!uri) return null;
  try {
    let p = decodeURIComponent(String(uri));
    p = p.replace(/^file:\/\//i, '');
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    return p || null;
  } catch { return null; }
}
function normKey(p) { return String(p || '').trim().replace(/\\/g, '/').replace(/\/$/, '').toLowerCase(); }

// hash → cwd 映射（只读 workspace.json，廉价）
function workspaceCwdMap(baseDir) {
  const root = workspaceStorageRoot(baseDir);
  const map = new Map();
  try {
    for (const h of fs.readdirSync(root)) {
      const wj = path.join(root, h, 'workspace.json');
      if (!fs.existsSync(wj)) continue;
      const p = uriToPath(safeParse(fs.readFileSync(wj, 'utf8'), {})?.folder);
      if (p) map.set(h, p);
    }
  } catch { }
  return map;
}

// Gen B: composerData → {composerId, name, headers:[{bubbleId,type}], createdAt, lastUpdated, workspaceId:null}
// Gen C: composerHeaders 行 value 优先；头部缺失时回落 composerConvHeaders:<cid>:* 分块
function loadComposers(baseDir) {
  const db = openDb(globalDb(baseDir));
  if (!db) return [];
  const out = new Map();
  try {
    const hasHeadersTable = tableExists(db, 'composerHeaders');
    if (hasHeadersTable) {
      let rows = [];
      try { rows = db.prepare('SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, value FROM composerHeaders').all(); } catch { }
      for (const r of rows) {
        if (r.isSubagent) continue; // 子代理会话不是可接力目标
        const v = safeParse(r.value, {}) || {};
        out.set(r.composerId, {
          composerId: r.composerId, name: v.name || null,
          headers: Array.isArray(v.fullConversationHeadersOnly) ? v.fullConversationHeadersOnly : null,
          createdAt: r.createdAt || v.createdAt || null, lastUpdated: r.lastUpdatedAt || v.lastUpdated || null,
          workspaceId: r.workspaceId || null, archived: !!r.isArchived, source: 'composerHeaders',
        });
      }
    }
    // Gen B（也兜 Gen C 里 value 不含 headers 的行）
    let rows2 = [];
    try { rows2 = db.prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'`).all(); } catch { }
    for (const r of rows2) {
      const cid = r.key.slice('composerData:'.length);
      const v = safeParse(r.value, {}) || {};
      const prev = out.get(cid);
      if (prev && Array.isArray(prev.headers)) continue; // Gen C 已有完整头
      out.set(cid, {
        composerId: cid, name: v.name || (prev && prev.name) || null,
        headers: Array.isArray(v.fullConversationHeadersOnly) ? v.fullConversationHeadersOnly : (prev && prev.headers) || null,
        createdAt: v.createdAt || (prev && prev.createdAt) || null,
        lastUpdated: v.lastUpdated || (prev && prev.lastUpdated) || null,
        workspaceId: v.workspaceId || (prev && prev.workspaceId) || null,
        archived: !!(prev && prev.archived), source: prev ? prev.source + '+composerData' : 'composerData',
      });
    }
  } finally { try { db.close(); } catch { } }
  return [...out.values()];
}

// 头部列表兜底：composerConvHeaders:<cid>:<NNNNNN> 分块（Gen C 3.26+ 把头从 value 挪进了分块）。
// LIKE 模式用参数绑定：id 拼进 SQL 字符串字面量既怕引号也怕通配符（审核 P4）。
function likeEscape(s) { return String(s ?? '').replace(/[\\%_]/g, '\\$0'); }
function loadHeadersFromChunks(db, composerId) {
  const rows = db.prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ESCAPE '\\' ORDER BY key`)
    .all(`composerConvHeaders:${likeEscape(composerId)}:%`);
  const headers = [];
  for (const r of rows) {
    const arr = safeParse(r.value, null);
    if (Array.isArray(arr)) headers.push(...arr.filter((x) => x && x.bubbleId));
  }
  return headers.length ? headers : null;
}

function bubbleKey(composerId, bubbleId) { return `bubbleId:${composerId}:${bubbleId}`; }

function loadBubble(db, composerId, bubbleId) {
  const row = db.prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`).get(bubbleKey(composerId, bubbleId));
  return row ? safeParse(row.value, {}) || {} : null;
}

// 从 bubble 提取 (text, toolFormerData)；assistant 主气泡可能为空、正文在 /s:<n> 子气泡
function bubbleText(db, composerId, bubbleId, bubble) {
  let text = String(bubble?.text ?? '');
  const tools = bubble?.toolFormerData ? [bubble.toolFormerData] : [];
  try {
    const rows = db.prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ESCAPE '\\'`)
      .all(`bubbleId:${likeEscape(composerId)}:${likeEscape(bubbleId)}/%`);
    for (const r of rows) {
      const sub = safeParse(r.value, {}) || {};
      if (r.key.includes('/t:')) { if (sub.toolFormerData) tools.push(sub.toolFormerData); continue; }
      if (sub.text && sub.text.trim()) text += (text ? '\n' : '') + sub.text;
    }
  } catch { }
  return { text, tools };
}

function doctor(baseDir) {
  const f = globalDb(baseDir);
  let ok = false, composers = 0;
  try {
    const db = openDb(f);
    if (db) {
      if (tableExists(db, 'composerHeaders')) {
        composers = db.prepare('SELECT count(*) c FROM composerHeaders WHERE isSubagent=0').get()?.c || 0;
      }
      if (!composers) {
        composers = db.prepare(`SELECT count(*) c FROM cursorDiskKV WHERE key LIKE 'composerData:%'`).get()?.c || 0;
      }
      db.close();
    }
  } catch { }
  ok = composers > 0;
  return {
    agent: AGENT, ok, storage: globalDb(baseDir), sessionFiles: composers,
    note: ok ? '实验性读取（社区逆向 schema）；T1 写入需完全退出 Cursor' : '未发现 Cursor 会话（globalStorage/state.vscdb）',
  };
}

function listSessions(baseDir) {
  const cwds = workspaceCwdMap(baseDir);
  const out = [];
  for (const c of loadComposers(baseDir)) {
    const cwd = c.workspaceId ? (cwds.get(String(c.workspaceId)) || null) : null;
    out.push({
      id: c.composerId, agent: AGENT, file: globalDb(baseDir),
      title: truncateStr(c.name || c.composerId.slice(0, 8), 60),
      cwd: cwd || '(cursor)', tsFirst: numToISO(c.createdAt), tsLast: numToISO(c.lastUpdated),
      msgCount: Array.isArray(c.headers) ? c.headers.length : null, toolCalls: null,
      size: 0, archived: c.archived,
    });
  }
  out.sort((a, b) => String(b.tsLast || '').localeCompare(String(a.tsLast || '')));
  return out;
}
function numToISO(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}

async function readSession(sessionId, baseDir) {
  const db = openDb(globalDb(baseDir));
  if (!db) throw new Error('Cursor globalStorage/state.vscdb 不存在或不可读');
  const loss = [];
  let composer = null;
  try {
    for (const c of loadComposers(baseDir)) {
      if (c.composerId === sessionId) { composer = c; break; }
    }
    if (!composer) throw new Error(`Cursor 会话不存在: ${sessionId}`);
    // 头部兜底：composerHeaders.value 缺失 → 分块 composerConvHeaders:*
    let headers = composer.headers;
    if (!Array.isArray(headers) || !headers.length) {
      headers = loadHeadersFromChunks(db, composer.composerId);
      if (headers) loss.push('Cursor: 头部取自 composerConvHeaders 分块（Gen C 格式）');
    }
    if (!Array.isArray(headers) || !headers.length) throw new Error(`Cursor 会话 ${sessionId} 没有可读的消息头（可能是过老/损坏的 composer）`);
    const entries = [];
    let title = composer.name && composer.name !== 'New Chat' ? composer.name : '';
    for (const h of headers) {
      const bid = h.bubbleId;
      const bubble = loadBubble(db, composer.composerId, bid);
      if (!bubble) { loss.push(`Cursor: 气泡 ${String(bid).slice(0, 8)}… 缺失（cloud/未同步会话常见）`); continue; }
      const { text, tools } = bubbleText(db, composer.composerId, bid, bubble);
      const role = bubble.type === 1 ? 'user' : 'assistant';
      if (!title && role === 'user' && text.trim()) title = text.replace(/[\r\n]+/g, ' ').trim();
      if (text.trim() || tools.length) {
        const blocks = [];
        if (text.trim()) blocks.push({ type: 'text', text });
        for (const t of tools) {
          const input = safeParse(t.rawArgs, safeParse(t.params, {})) ?? {};
          blocks.push({ type: 'tool_use', id: t.toolCallId || ('call_' + bid), name: t.name || 'tool', input });
        }
        if (blocks.length) entries.push({ id: String(bid), ts: null, role, kind: 'text', blocks, meta: {} });
        // 工具输出按 ARX 惯例拆独立 tool-result 条目（toolFormerData.result 是 Cursor 原生内联结构）
        for (const t of tools) {
          if (t.result == null) continue;
          entries.push({
            id: String(bid) + '_r', ts: null, role: 'user', kind: 'tool-result',
            blocks: [{ type: 'tool_result', for: t.toolCallId || ('call_' + bid), output: String(t.result), isError: /error|failed/i.test(String(t.status || '')) }],
            meta: {},
          });
        }
      }
    }
    // Gen A 残留：aichat.chatdata（老会话可能只存在于这里）
    if (!entries.length) {
      const wdbs = genAEntries(sessionId, baseDir, loss);
      if (wdbs.length) { entries.push(...wdbs); loss.push('Cursor: 会话取自旧版 aichat.chatdata（2024 格式，工具数据可能不全）'); }
    }
    if (entries.length) loss.push('Cursor: 气泡无逐条时间戳，接力后目标侧将以接力时刻记时');
    const stats = { entries: entries.length, userTurns: 0, assistantEntries: 0, toolCalls: 0, toolResults: 0, thinking: 0, approxTokens: 0, recordedTokens: null };
    for (const e of entries) {
      if (e.role === 'user' && e.kind === 'text') stats.userTurns++;
      if (e.role === 'assistant') stats.assistantEntries++;
      for (const b of e.blocks) {
        if (b.type === 'tool_use') stats.toolCalls++;
        if (b.type === 'tool_result') stats.toolResults++;
        stats.approxTokens += Math.ceil((b.text || '').length / 3.5);
      }
    }
    return {
      arx: 1, id: require('./util').randomUUID(), created_at: nowISO(),
      source: { agent: AGENT, agent_version: null, session_id: composer.composerId, title: title || '(无标题)', file: globalDb(baseDir) },
      project: { cwd: (composer.workspaceId && workspaceCwdMap(baseDir).get(String(composer.workspaceId))) || null },
      env: { model: null, provider: 'anysphere', cli_version: null },
      stats, entries, compactions: [], loss: [...new Set(loss)],
      _fileStat: { size: fs.statSync(globalDb(baseDir)).size, mtimeMs: fs.statSync(globalDb(baseDir)).mtimeMs },
    };
  } finally { try { db.close(); } catch { } }
}

// Gen A：workspaceStorage ItemTable 'workbench.panel.aichat.view.aichat.chatdata'
function genAEntries(sessionId, baseDir, loss) {
  const root = workspaceStorageRoot(baseDir);
  const out = [];
  try {
    for (const h of fs.readdirSync(root)) {
      const f = path.join(root, h, 'state.vscdb');
      if (!fs.existsSync(f)) continue;
      const db = openDb(f);
      if (!db) continue;
      try {
        const row = db.prepare(`SELECT value FROM ItemTable WHERE key='workbench.panel.aichat.view.aichat.chatdata'`).get();
        if (!row) continue;
        const data = safeParse(row.value, {}) || {};
        const chats = Array.isArray(data.chats) ? data.chats : [];
        for (const ch of chats) {
          if (String(ch.sessionId || ch.chatId || '') !== sessionId) continue;
          for (const m of Array.isArray(ch.messages) ? ch.messages : []) {
            const role = m.role === 'user' ? 'user' : 'assistant';
            const txt = String(m.text ?? '');
            if (!txt.trim()) continue;
            out.push({ id: 'genA-' + out.length, ts: null, role, kind: 'text', blocks: [{ type: 'text', text: txt }], meta: {} });
          }
        }
      } finally { try { db.close(); } catch { } }
      if (out.length) break;
    }
  } catch { }
  return out;
}

// ---------- T1 写入 ----------
// 进程内备忘录：transfer 的备份与写入器各调一次，workspaceStorage 可能有几十个目录要扫。
// 只缓存命中值：未命中（null）可能是"用户刚打开过 Cursor"，缓存住会让重试直到重启才生效。
const _hashMemo = new Map();
function hashForCwd(cwd, baseDir) {
  const memoKey = path.resolve(String(baseDir || userDir())) + '|' + normKey(cwd);
  if (_hashMemo.has(memoKey)) return _hashMemo.get(memoKey);
  const root = workspaceStorageRoot(baseDir);
  const key = normKey(cwd);
  let found = null;
  try {
    for (const h of fs.readdirSync(root)) {
      const wj = path.join(root, h, 'workspace.json');
      if (!fs.existsSync(wj)) continue;
      const p = uriToPath(safeParse(fs.readFileSync(wj, 'utf8'), {})?.folder);
      if (p && normKey(p) === key) { found = h; break; }
    }
  } catch { }
  if (found) {
    if (_hashMemo.size > 64) _hashMemo.clear();
    _hashMemo.set(memoKey, found);
  }
  return found;
}

// ARX → Cursor bubbles（Gen B 主体：composerData + bubbleId 行；toolFormerData.result 内联工具输出）
// Cursor 原生 schema 是一个 bubble 至多一个 toolFormerData —— 并行工具调用必须一调用一 bubble，
// 否则同条目第二个 tool_use 会覆盖第一个、连结果一起静默丢失（审核 P1）。
function bubblesFrom(msx, loss) {
  const resultFor = new Map(); // toolCallId → { text, isError }
  for (const e of msx.entries || []) for (const b of e.blocks || []) {
    if (b.type === 'tool_result' && b.for) {
      resultFor.set(b.for, { text: typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? ''), isError: !!b.isError });
    }
  }
  const headers = [];
  const bubbles = [];
  let imageLoss = false, metaSeen = false, errStatus = 0;
  const pushBubble = (type, obj) => {
    const bid = 'b' + crypto.randomBytes(8).toString('hex');
    headers.push({ bubbleId: bid, type });
    bubbles.push([bubbleKey(msx._targetId, bid), JSON.stringify(obj)]);
    return bid;
  };
  for (const e of msx.entries || []) {
    if (e.role === 'meta' || e.role === 'system') {
      const txt = (e.blocks || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
      if (!txt.trim()) continue;
      metaSeen = true;
      pushBubble(1, { type: 1, text: '[meta] ' + txt });
      continue;
    }
    if (e.kind === 'tool-result') continue; // 结果并入 tool_use 的 toolFormerData.result
    const role = e.role === 'user' ? 'user' : 'assistant';
    const type = role === 'user' ? 1 : 2;
    const blocks = e.blocks || [];
    for (const b of blocks) if (b.type === 'image') imageLoss = true;
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('');
    const thinks = blocks.filter((b) => b.type === 'thinking' && b.text);
    const calls = blocks.filter((b) => b.type === 'tool_use');
    // 文本/思考/工具调用分开成 bubble：thinking 附在首个 bubble 上；每个 tool_call 独立 bubble
    const mainObj = { type, text };
    if (thinks.length) mainObj.thinking = { text: thinks.map((t) => t.text).join('\n') };
    if (text.trim() || thinks.length || !calls.length) pushBubble(type, mainObj);
    for (const b of calls) {
      const r = resultFor.get(b.id);
      if (!r || r.isError) errStatus++;
      const callId = b.id || ('call_' + crypto.randomBytes(4).toString('hex'));
      pushBubble(type, {
        type, text: '',
        toolFormerData: {
          name: b.name || 'tool', toolCallId: callId,
          params: JSON.stringify(b.input ?? {}), rawArgs: JSON.stringify(b.input ?? {}),
          result: r ? r.text : '', status: r ? (r.isError ? 'error' : 'success') : 'error',
        },
      });
    }
  }
  if (imageLoss) loss.push('Cursor: 图片块需要原始图像数据，注入时已省略');
  if (metaSeen) loss.push('[meta] 条目转为带 [meta] 前缀的用户消息');
  if (errStatus) loss.push(`Cursor: ${errStatus} 个工具调用以 error 状态写入（源标记为失败或结果缺失）`);
  if ((msx.entries || []).some((e) => (e.blocks || []).some((b) => b.type === 'thinking'))) {
    loss.push('Cursor: thinking 字段名为社区逆向推断（bubble.thinking.text），官方 schema 未公开， resume 后可能不显示思考区');
  }
  return { headers, bubbles };
}

async function writeSession(msx, { cwd, baseDir } = {}) {
  const loss = [];
  const entries = msx.entries || [];
  if (!entries.length) throw new Error('没有可写入的内容条目（过滤条件排除了全部内容）');
  if (!cwd) throw new Error('Cursor T1 注入需要目标项目 cwd');
  const gFile = globalDb(baseDir);
  if (!fs.existsSync(gFile)) throw new Error('Cursor globalStorage/state.vscdb 不存在：请先安装并启动过 Cursor');
  const hash = hashForCwd(cwd, baseDir);
  if (!hash) throw new Error(`Cursor workspaceStorage 中未找到打开过 ${cwd} 的工作区：请先用 Cursor 打开该项目一次，或改用 T2`);
  const newId = crypto.randomUUID();
  msx._targetId = newId;
  const title = (msx.source && msx.source.title) || '(导入会话)';
  const { headers, bubbles } = bubblesFrom(msx, loss);

  const wdb = openDb(gFile, { readOnly: false });
  if (!wdb) throw new Error('Cursor state.vscdb 无法以写模式打开（Cursor 是否正在运行？请完全退出后重试）');
  const now = Date.now();
  const composerValue = JSON.stringify({ name: title.slice(0, 80), isAgentic: true, createdAt: now, lastUpdated: now, fullConversationHeadersOnly: headers });
  try {
    wdb.exec('BEGIN');
    try {
      wdb.prepare(`INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)`).run(`composerData:${newId}`, composerValue);
      const ins = wdb.prepare(`INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)`);
      for (const [k, v] of bubbles) ins.run(k, v);
      // Gen C：composerHeaders 表存在则并行写（History 列表由它驱动）
      if (tableExists(wdb, 'composerHeaders')) {
        try {
          wdb.prepare(`INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, value) VALUES (?, ?, ?, ?, 0, 0, ?, ?)`)
            .run(newId, hash, now, now, now, composerValue);
          loss.push('已写入 composerHeaders 行（Gen C History 列表驱动）');
        } catch (e) { loss.push(`composerHeaders 写入失败（${e.message}），仅 Gen B 路径可见`); }
      }
      wdb.exec('COMMIT');
    } catch (e) { try { wdb.exec('ROLLBACK'); } catch { } throw e; }
  } finally { try { wdb.close(); } catch { } }

  // workspace ItemTable 注册（键存在才追加；结构未知时不从零构造）
  const wFile = path.join(workspaceStorageRoot(baseDir), hash, 'state.vscdb');
  if (fs.existsSync(wFile)) {
    const wdb2 = openDb(wFile, { readOnly: false });
    if (wdb2) {
      try {
        const row = wdb2.prepare(`SELECT value FROM ItemTable WHERE key='composer.composerData'`).get();
        if (row) {
          const v = safeParse(row.value, null);
          let appended = false;
          if (Array.isArray(v) && !v.includes(newId)) { v.push(newId); wdb2.prepare(`UPDATE ItemTable SET value=? WHERE key='composer.composerData'`).run(JSON.stringify(v)); appended = true; }
          else if (v && Array.isArray(v.allComposers) && !v.allComposers.includes(newId)) { v.allComposers.push(newId); wdb2.prepare(`UPDATE ItemTable SET value=? WHERE key='composer.composerData'`).run(JSON.stringify(v)); appended = true; }
          if (appended) loss.push('已注册到 workspaceStorage ItemTable composer.composerData');
        }
      } catch { } finally { try { wdb2.close(); } catch { } }
    }
  }

  loss.push('⚠ 请在写入前完全退出 Cursor（含托盘）；运行中的 Cursor 退出时可能用内存态覆盖外部写入');
  loss.push('Cursor 会话 schema 未公开（社区逆向），版本更新可能使注入失效；出现 Loading/损坏时删除对应 composerData:/bubbleId: 键即可');
  return {
    id: newId, path: gFile, count: bubbles.length, loss,
    resumeCommand: `Cursor（打开 ${cwd}）→ Chat History 选择「${title}」（实验性写入，重启 Cursor 后查看）`,
  };
}

module.exports = { listSessions, readSession, doctor, writeSession, globalDb, hashForCwd, loadComposers };
