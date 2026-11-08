'use strict';
// Hermes Agent（Nous Research）适配器 —— 已按真实客户端逆向验证（v0.23.0，schema_version=32）
// 存储：state.db（SQLite/WAL）。定位顺序：HERMES_HOME 环境变量 → %LOCALAPPDATA%\hermes → ~/.hermes（WSL/手动）
// 关键表：sessions（65 列，cwd/title/started_at/parent_session_id…）+ messages（role: user|assistant|tool，
//   tool_calls JSON、reasoning_content、active/compacted 软删标记）+ FTS5 external-content（6 触发器同步）
// 写入铁律：绝不 PRAGMA triggers off / 绝不直写 FTS 影子表（索引会静默损坏）；列集合运行时探测，不硬编码
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { HOME, cacheDir, ensureDir, nowISO, randomUUID, truncateStr } = require('./util');

const AGENT = 'hermes';

function dataHome(baseDir) {
  if (baseDir) return baseDir;
  // 探测链：HERMES_HOME → %LOCALAPPDATA%\hermes（Windows 官方安装器）→ ~/.hermes（WSL/手动）
  // 取第一个真实存在 state.db 的位置；都找不到时回退首个候选（写入时会给出明确报错）
  const candidates = [];
  if (process.env.HERMES_HOME) candidates.push(process.env.HERMES_HOME);
  if (process.platform === 'win32') {
    const lad = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
    candidates.push(path.join(lad, 'hermes'));
  }
  candidates.push(path.join(HOME, '.hermes'));
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, 'state.db'))) return c; } catch { }
  }
  return candidates[0];
}
const dbPath = (baseDir) => {
  const home = dataHome(baseDir);
  if (fs.existsSync(home) && fs.statSync(home).isFile()) return home; // baseDir 直接指向 state.db 也接受
  return path.join(home, 'state.db');
};

// Hermes 运行中可能持 WAL 锁：复制到缓存目录再读（与 workbuddy 同策略）
function getReadDbFile(baseDir) {
  const src = dbPath(baseDir);
  if (!fs.existsSync(src)) throw new Error(`Hermes state.db 不存在: ${src}`);
  ensureDir(cacheDir());
  const dest = path.join(cacheDir(), 'hermes-read-copy.db');
  for (const ext of ['', '-wal', '-shm']) {
    const s = src + ext;
    if (fs.existsSync(s)) fs.copyFileSync(s, dest + ext);
    else if (fs.existsSync(dest + ext)) fs.rmSync(dest + ext);
  }
  return dest;
}

const isoFromSec = (sec) => (sec ? new Date(Math.round(sec * 1000)).toISOString() : null);
const secFromIso = (iso) => (iso ? Math.round(new Date(iso).getTime() / 1000) : null);

function parseContent(content) {
  // Hermes 协议：结构化（多模态）内容以 "\x00json:" + JSON 存储；其余为纯文本
  if (typeof content !== 'string') return { text: '', blocks: [] };
  if (content.startsWith('\x00json:')) {
    try {
      const arr = JSON.parse(content.slice(6));
      const blocks = (Array.isArray(arr) ? arr : []).map((b) => (b && b.type === 'text' ? { type: 'text', text: b.text || '' } : { type: 'text', text: JSON.stringify(b) }));
      return { text: blocks.map((b) => b.text).join('\n'), blocks };
    } catch { /* 落回原文 */ }
  }
  return { text: content, blocks: [{ type: 'text', text: content }] };
}

function listSessions(baseDir) {
  const p = dbPath(baseDir);
  if (!fs.existsSync(p)) return [];
  const db = new DatabaseSync(getReadDbFile(baseDir));
  try {
    const rows = db.prepare('SELECT * FROM sessions WHERE hidden = 0 ORDER BY COALESCE(last_activity_at, started_at) DESC').all();
    return rows.map((r) => ({
      id: r.id, agent: AGENT, file: p,
      title: r.title || r.display_name || '(无标题)',
      cwd: r.cwd || r.git_repo_root || '',
      tsFirst: isoFromSec(r.started_at), tsLast: isoFromSec(r.last_activity_at || r.ended_at),
      msgCount: r.message_count ?? null, toolCalls: r.tool_call_count ?? null,
      tokens: r.input_tokens != null ? (r.input_tokens || 0) + (r.output_tokens || 0) : null,
      size: fs.statSync(p).size, archived: !!r.archived,
    }));
  } finally { db.close(); }
}

async function readSession(sessionId, baseDir) {
  const p = dbPath(baseDir);
  if (!fs.existsSync(p)) throw new Error(`Hermes state.db 不存在: ${p}`);
  const db = new DatabaseSync(getReadDbFile(baseDir));
  const entries = [];
  const compactions = [];
  const loss = [];
  const env = { model: null, provider: null, cli_version: null };
  let sess = null;
  try {
    sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!sess) throw new Error(`Hermes 会话不存在: ${sessionId}`);
    if (sess.model) env.model = sess.model;
    const rows = db.prepare("SELECT * FROM messages WHERE session_id = ? AND role NOT IN ('session_meta','system') ORDER BY id").all(sessionId);
    for (const r of rows) {
      const ts = isoFromSec(r.timestamp);
      if (r.compacted) { compactions.push({ ts, message: truncateStr(r.content || '', 400) }); continue; }
      if (r.active === 0) continue; // 软删行
      if (r.role === 'user') {
        const { text, blocks } = parseContent(r.content);
        if (text.trim()) entries.push({ id: 'm' + r.id, ts, role: 'user', kind: 'text', blocks: blocks.length ? blocks : [{ type: 'text', text }], meta: {} });
      } else if (r.role === 'assistant') {
        const blocks = [];
        const reasoning = r.reasoning_content || r.reasoning || '';
        if (reasoning) blocks.push({ type: 'thinking', text: reasoning });
        const { text, blocks: textBlocks } = parseContent(r.content);
        if (text) blocks.push(...(textBlocks.length ? textBlocks : [{ type: 'text', text }]));
        let calls = [];
        if (r.tool_calls) { try { calls = JSON.parse(r.tool_calls) || []; } catch { calls = []; } }
        for (const c of calls) {
          const fn = c.function || {};
          let input = {};
          try { input = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments ?? {}); } catch { input = { raw: fn.arguments }; }
          blocks.push({ type: 'tool_use', id: c.call_id || c.id || 'call_' + randomUUID().slice(0, 8), name: fn.name || 'tool', input });
        }
        if (blocks.length) entries.push({ id: 'm' + r.id, ts, role: 'assistant', kind: 'text', blocks, meta: { model: r.model || sess.model || null } });
      } else if (r.role === 'tool') {
        let out = r.content ?? '';
        let isError = false;
        try {
          const j = JSON.parse(out);
          if (j && typeof j === 'object' && 'output' in j) { out = j.output ?? ''; isError = (j.exit_code != null && j.exit_code !== 0) || !!j.error; }
        } catch { /* 纯文本结果 */ }
        entries.push({ id: 'm' + r.id, ts, role: 'user', kind: 'tool-result', blocks: [{ type: 'tool_result', for: r.tool_call_id || 'call', output: typeof out === 'string' ? out : JSON.stringify(out), isError }], meta: { tool_name: r.tool_name || undefined } });
      }
    }
  } finally { db.close(); }
  const stats = { entries: entries.length, userTurns: 0, assistantEntries: 0, toolCalls: 0, toolResults: 0, thinking: 0, approxTokens: 0, recordedTokens: (sess && sess.input_tokens != null ? (sess.input_tokens || 0) + (sess.output_tokens || 0) : null) };
  for (const e of entries) {
    if (e.role === 'user' && e.kind === 'text') stats.userTurns++;
    if (e.role === 'assistant') stats.assistantEntries++;
    for (const b of e.blocks) {
      if (b.type === 'tool_use') stats.toolCalls++;
      if (b.type === 'tool_result') stats.toolResults++;
      if (b.type === 'thinking') stats.thinking++;
      stats.approxTokens += Math.ceil((b.text || JSON.stringify(b.input ?? b.output ?? '')).length / 3.5);
    }
  }
  const firstUser = entries.find((e) => e.role === 'user' && e.kind === 'text');
  return {
    arx: 1, id: randomUUID(), created_at: nowISO(),
    source: { agent: AGENT, agent_version: null, session_id: sessionId, title: (sess && (sess.title || sess.display_name)) || truncateStr(firstUser ? firstUser.blocks[0].text : '', 60) || '(无标题)', file: p },
    project: { cwd: (sess && (sess.cwd || sess.git_repo_root)) || '' },
    env,
    stats, entries, compactions, loss,
    _fileStat: { size: fs.statSync(p).size, mtimeMs: fs.statSync(p).mtimeMs },
  };
}

function doctor(baseDir) {
  const p = dbPath(baseDir);
  let sessions = 0;
  try { sessions = listSessions(baseDir).length; } catch { }
  return { agent: AGENT, ok: fs.existsSync(p), storage: p, sessionFiles: sessions };
}

// ---------- 写入（T0 同源复制 / T1 原生注入） ----------
// 列集合运行时探测（schema_version 会迁移），触发器保持开启（message_uid/display_order/FTS 自动补齐）
function colNames(db, table) {
  return db.prepare('PRAGMA table_info(' + '"' + table.replace(/"/g, '""') + '"' + ')').all().map((c) => c.name);
}
const insertRow = (db, table, cols, row) => {
  const names = cols.filter((n) => row[n] !== undefined);
  db.prepare(`INSERT INTO ${'"' + table.replace(/"/g, '""') + '"'} (${names.map((n) => '"' + n + '"').join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((n) => row[n]));
};

// T0：同库事务内克隆 sessions 行 + 全部 messages 行（行 id 重新自增，时间/cwd/计数原样）
function copySession(sessionId, { baseDir, dbFile } = {}) {
  const target = dbFile || dbPath(baseDir);
  if (!fs.existsSync(target)) throw new Error('Hermes T0：目标库不存在: ' + target);
  const db = new DatabaseSync(target);
  try {
    db.exec('PRAGMA busy_timeout=4000');
    const src = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!src) throw new Error('Hermes T0：源会话不存在: ' + sessionId);
    const id = 'local-' + crypto.randomBytes(32).toString('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      const sCols = colNames(db, 'sessions');
      insertRow(db, 'sessions', sCols, { ...src, id });
      const mCols = colNames(db, 'messages').filter((n) => n !== 'id'); // id 自增
      const rows = db.prepare(`SELECT ${mCols.map((n) => '"' + n + '"').join(',')} FROM messages WHERE session_id = ? ORDER BY id`).all(sessionId);
      let count = 0;
      for (const row of rows) { insertRow(db, 'messages', mCols, { ...row, session_id: id }); count++; }
      if (colNames(db, 'session_model_usage').includes('session_id')) {
        const uCols = colNames(db, 'session_model_usage').filter((n) => n !== 'id' && n !== 'rowid');
        const uRows = db.prepare(`SELECT * FROM session_model_usage WHERE session_id = ?`).all(sessionId);
        for (const u of uRows) insertRow(db, 'session_model_usage', uCols, { ...u, session_id: id });
      }
      db.exec('COMMIT');
      return { id, path: target, count, resumeCommand: `hermes sessions list 选择「${src.title || id.slice(0, 16)}」` };
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { }
      throw e;
    }
  } finally { db.close(); }
}

// T1：原生注入（sessions 行 + messages 行；message_uid/display_order/FTS 交给触发器）
function writeSession(msx, { cwd, baseDir } = {}) {
  cwd = cwd || msx.project?.cwd;
  const target = dbPath(baseDir);
  if (!fs.existsSync(target)) throw new Error(`Hermes state.db 不存在（请先安装并运行一次 Hermes Agent，或在设置中把数据目录指到其所在文件夹）: ${target}`);
  const db = new DatabaseSync(target);
  const loss = [...(msx.loss || [])];
  try {
    db.exec('PRAGMA busy_timeout=4000');
    const sCols = colNames(db, 'sessions');
    const mCols = colNames(db, 'messages');
    const entries = msx.entries || [];
    if (!entries.length) throw new Error('没有可写入的内容条目（过滤条件排除了全部内容）');
    const id = 'local-' + crypto.randomBytes(32).toString('hex');
    const now = Math.round(Date.now() / 1000);
    const firstSec = entries[0] && entries[0].ts ? secFromIso(entries[0].ts) : now;
    const lastSec = entries.length && entries[entries.length - 1].ts ? secFromIso(entries[entries.length - 1].ts) : now;
    const title = (msx.source && msx.source.title) || '导入的会话';
    db.exec('BEGIN IMMEDIATE');
    try {
      insertRow(db, 'sessions', sCols, {
        id, source: 'oneshot', created_source: 'agentrelay',
        model: (msx.env && msx.env.model) || null, started_at: firstSec || now, ended_at: null,
        cwd: cwd || null, profile_name: 'default', title, title_source: 'agentrelay',
      });
      // 工具名索引：assistant.tool_calls 里的 call_id → name（tool 行补 tool_name 用）
      const callNames = new Map();
      const prepared = [];
      let imageLoss = false;
      for (const e of entries) {
        const ts = e.ts ? secFromIso(e.ts) : now;
        for (const b of e.blocks || []) if (b.type === 'image') imageLoss = true;
        if (e.role === 'meta' || e.role === 'system') { loss.push(`Hermes 目标：跳过 1 条 ${e.role} 条目（其读取端会过滤该角色）`); continue; }
        if (e.kind === 'compaction') { loss.push('Hermes 目标：跳过 1 条 compaction 标记'); continue; }
        if (e.role === 'user' && e.kind === 'text') {
          const content = (e.blocks || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
          if (content) prepared.push({ role: 'user', content, timestamp: ts, finish_reason: 'stop' });
          continue;
        }
        if (e.kind === 'tool-result') {
          const b = (e.blocks || []).find((x) => x.type === 'tool_result');
          if (!b) continue;
          const outText = typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? '');
          prepared.push({
            role: 'tool', tool_call_id: b.for || 'call', tool_name: callNames.get(b.for) || 'tool',
            content: JSON.stringify({ output: outText, exit_code: b.isError ? 1 : 0, error: null }),
            timestamp: ts, finish_reason: 'stop',
          });
          continue;
        }
        if (e.role !== 'assistant') continue;
        const reasoning = (e.blocks || []).filter((b) => b.type === 'thinking').map((b) => b.text || '').join('\n');
        const text = (e.blocks || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
        const calls = [];
        for (const b of e.blocks || []) {
          if (b.type !== 'tool_use') continue;
          const cid = b.id || 'call_' + crypto.randomBytes(8).toString('hex');
          callNames.set(cid, b.name || 'tool');
          calls.push({ id: cid, call_id: cid, response_item_id: null, type: 'function', function: { name: b.name || 'tool', arguments: JSON.stringify(b.input ?? {}) } });
        }
        prepared.push({
          role: 'assistant', content: text,
          tool_calls: calls.length ? JSON.stringify(calls) : null,
          reasoning_content: reasoning || null,
          timestamp: ts, finish_reason: calls.length ? 'tool_calls' : 'stop',
        });
      }
      if (imageLoss) loss.push('Hermes: 图片块需要原始图像数据，注入时已省略');
      if (!prepared.length) throw new Error('没有可写入的内容条目（全部被过滤）');
      let lastTs = firstSec || now;
      let msgCount = 0, toolCount = 0;
      for (const p of prepared) {
        insertRow(db, 'messages', mCols, { session_id: id, ...p });
        msgCount++; if (p.role === 'tool') toolCount++;
        if (p.timestamp && p.timestamp > lastTs) lastTs = p.timestamp;
      }
      const set = (k, v) => { if (sCols.includes(k)) db.prepare(`UPDATE sessions SET "${k}" = ? WHERE id = ?`).run(v, id); };
      set('message_count', msgCount); set('tool_call_count', toolCount); set('last_activity_at', lastTs);
      db.exec('COMMIT');
      return {
        id, path: target, count: msgCount, loss,
        resumeCommand: `hermes sessions list 选择「${title}」（新会话 id: ${id.slice(0, 24)}…）`,
      };
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { }
      throw e;
    }
  } finally { db.close(); }
}

module.exports = { listSessions, readSession, doctor, dbPath, getReadDbFile, writeSession, copySession, dataHome };
