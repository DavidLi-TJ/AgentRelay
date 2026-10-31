'use strict';
// WorkBuddy（腾讯/CodeBuddy 系）适配器
// 数据: ~/.workbuddy-ai/workbuddy.db（sessions 元数据） + ~/.workbuddy-ai/projects/<slug>/<sessionId>.jsonl（对话）
// 格式: {id,parentId,timestamp(ms),type:'message'|'function_call'|'function_call_result'|'reasoning'|'ai-title'|'session-meta',...}
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const {
  HOME, cacheDir, ensureDir, nowISO, randomUUID, isoToMs, msToISO,
  truncateStr, safeParse, streamJsonl, writeJsonl,
} = require('./util');

// baseDir = 用户自定义数据目录（.workbuddy-ai 目录）；null = 默认 ~/.workbuddy-ai
const dataHome = (baseDir) => baseDir || path.join(HOME, '.workbuddy-ai');
const dbPath = (baseDir) => path.join(dataHome(baseDir), 'workbuddy.db');
const projectsRoot = (baseDir) => path.join(dataHome(baseDir), 'projects');

const ENV_PREFIXES = ['<system-reminder', '<user_info>', '<identity_context', '<environment_context', '<turn_context'];
function isEnvText(t) { return typeof t === 'string' && ENV_PREFIXES.some((p) => t.startsWith(p)); }

// workbuddy.db 很小（<1MB），复制后读取避免锁
function openDb(dbFile) {
  const src = dbFile || dbPath();
  if (dbFile) return new DatabaseSync(dbFile);
  ensureDir(cacheDir());
  const dest = path.join(cacheDir(), 'workbuddy-read-copy.db');
  for (const ext of ['', '-wal', '-shm']) {
    const s = src + ext;
    if (fs.existsSync(s)) fs.copyFileSync(s, dest + ext);
    else if (fs.existsSync(dest + ext)) fs.rmSync(dest + ext);
  }
  return new DatabaseSync(dest);
}

function findSessionFile(sessionId, baseDir) {
  const root = projectsRoot(baseDir);
  if (!fs.existsSync(root)) return null;
  for (const d of fs.readdirSync(root)) {
    const dir = path.join(root, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    const cand = path.join(dir, sessionId + '.jsonl');
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

function listSessions(baseDir) {
  if (!fs.existsSync(dbPath(baseDir))) return [];
  const db = openDb();
  try {
    const rows = db.prepare(`
      SELECT s.id, s.cwd, s.title, s.custom_title, s.status, s.created_at, s.updated_at, s.last_activity_at,
             s.source_mode, s.mode, s.is_playground, u.used
      FROM sessions s LEFT JOIN session_usage u ON u.session_id = s.id
      WHERE s.deleted_at IS NULL ORDER BY s.updated_at DESC`).all();
    return rows.map((r) => {
      const file = findSessionFile(r.id, baseDir);
      return {
        id: r.id, agent: 'workbuddy', file,
        title: r.custom_title || r.title || '(无标题)',
        cwd: (r.cwd || '').replace(/\\/g, '/'),
        tsFirst: r.created_at ? msToISO(r.created_at) : null,
        tsLast: r.updated_at ? msToISO(r.updated_at) : null,
        msgCount: null, toolCalls: null, size: file ? fs.statSync(file).size : null,
        tokens: r.used || null, status: r.status, mode: r.mode || r.source_mode,
      };
    });
  } finally { db.close(); }
}

async function readSession(sessionId, baseDir) {
  const file = fs.existsSync(sessionId) ? sessionId : findSessionFile(sessionId, baseDir);
  if (!file) throw new Error(`WorkBuddy 会话文件不存在: ${sessionId}`);
  const entries = [];
  const compactions = [];
  const loss = [];
  let title = '', cwd = '', model = null, recordedTokens = 0;
  await streamJsonl(file, (o) => {
    const ts = o.timestamp ? msToISO(o.timestamp) : null;
    if (o.cwd && !cwd) cwd = o.cwd;
    if (o.type === 'ai-title' && !title) title = o.aiTitle || '';
    if (o.type === 'session-meta' || o.type === 'file-history-snapshot' || o.type === 'resend-fork-notice') return;
    if (o.type === 'message') {
      const texts = [];
      for (const c of o.content || []) {
        if (c.type === 'input_text' || c.type === 'output_text') texts.push(c.text || '');
      }
      if (!texts.length) return;
      if (o.providerData && o.providerData.model) model = o.providerData.model;
      if (o.role === 'user') {
        const envMsg = texts.every(isEnvText);
        entries.push({ id: o.id, ts, role: envMsg ? 'meta' : 'user', kind: envMsg ? 'note' : 'text', blocks: texts.map((t) => ({ type: 'text', text: t })), meta: {} });
      } else if (o.role === 'assistant') {
        entries.push({ id: o.id, ts, role: 'assistant', kind: 'text', blocks: texts.map((t) => ({ type: 'text', text: t })), meta: { model: (o.providerData && o.providerData.model) || null } });
      }
      if (o.message && o.message.usage) recordedTokens += (o.message.usage.input_tokens || 0) + (o.message.usage.output_tokens || 0);
    } else if (o.type === 'reasoning') {
      const text = (o.rawContent || []).filter((r) => r && (r.type === 'reasoning_text' || r.type === 'reasoning')).map((r) => r.text || '').join('\n');
      if (text) entries.push({ id: o.id, ts, role: 'assistant', kind: 'text', blocks: [{ type: 'thinking', text, signed: false }], meta: {} });
    } else if (o.type === 'function_call') {
      if (o.providerData && o.providerData.model) model = o.providerData.model;
      if (o.message && o.message.usage) recordedTokens += (o.message.usage.input_tokens || 0) + (o.message.usage.output_tokens || 0);
      entries.push({ id: o.id, ts, role: 'assistant', kind: 'text', blocks: [{ type: 'tool_use', id: o.callId, name: o.name || 'tool', input: safeParse(o.arguments, { raw: o.arguments }) }], meta: {} });
    } else if (o.type === 'function_call_result') {
      const out = o.output && typeof o.output === 'object' ? (o.output.text != null ? o.output.text : JSON.stringify(o.output)) : String(o.output ?? '');
      entries.push({ id: o.id, ts, role: 'user', kind: 'tool-result', blocks: [{ type: 'tool_result', for: o.callId, output: out, isError: o.status === 'failed' || o.status === 'error' }], meta: {} });
    }
  });
  const stats = { entries: entries.length, userTurns: 0, assistantEntries: 0, toolCalls: 0, toolResults: 0, thinking: 0, approxTokens: 0, recordedTokens };
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
    source: { agent: 'workbuddy', agent_version: null, session_id: sessionId, title: title || (firstUser ? truncateStr(firstUser.blocks[0].text, 60) : '(无标题)'), file },
    project: { cwd },
    env: { model, provider: null, cli_version: null },
    stats, entries, compactions, loss,
    _fileStat: { size: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs },
  };
}

// ---------- 写入（T1：合成 jsonl + sessions 表注册） ----------
function slugifyWorkbuddy(cwd) {
  return String(cwd).toLowerCase().replace(/[^a-z0-9_\u4e00-\u9fff]/g, '-');
}

function writeSession(msx, { cwd, newId, dbFile, projectsDir, baseDir } = {}) {
  cwd = cwd || msx.project?.cwd;
  if (!cwd) throw new Error('缺少目标项目 cwd');
  const root = projectsDir || projectsRoot(baseDir);
  const id = newId || randomUUID();
  const dir = path.join(root, slugifyWorkbuddy(cwd));
  ensureDir(dir);
  const file = path.join(dir, id + '.jsonl');
  const loss = [...(msx.loss || [])];
  const now = Date.now();
  const lines = [];
  let prevId = null;
  const push = (o) => { lines.push(o); prevId = o.id; };
  push({ type: 'session-meta', id: randomUUID(), sessionId: id, timestamp: now, meta: { 'agentrelay.imported': 'true', 'agentrelay.source': msx.source?.agent || '' } });
  let firstUserText = '';
  for (const e of msx.entries || []) {
    const ts = e.ts ? isoToMs(e.ts) : now;
    if (e.kind === 'compaction') { loss.push('WorkBuddy 目标：跳过 compaction 标记'); continue; }
    if (e.role === 'meta' || e.role === 'system') { loss.push(`WorkBuddy 目标：跳过 1 条 ${e.role} 条目`); continue; }
    if (e.role === 'user' && e.kind === 'text') {
      const texts = (e.blocks || []).filter((b) => b.type === 'text').map((b) => b.text || '');
      if (!texts.length) continue;
      if (!firstUserText) firstUserText = texts[0];
      push({ id: randomUUID(), parentId: prevId, timestamp: ts, type: 'message', role: 'user', status: 'completed', content: texts.map((t) => ({ type: 'input_text', text: t })), sessionId: id, cwd });
    } else if (e.kind === 'tool-result') {
      for (const b of e.blocks || []) {
        if (b.type !== 'tool_result') continue;
        push({ id: randomUUID(), parentId: prevId, timestamp: ts, type: 'function_call_result', name: 'tool', callId: b.for, status: b.isError ? 'error' : 'completed', output: { type: 'text', text: typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? '') }, sessionId: id, cwd });
      }
    } else if (e.role === 'assistant') {
      for (const b of e.blocks || []) {
        const lid = randomUUID();
        if (b.type === 'text') push({ id: lid, parentId: prevId, timestamp: ts, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: b.text || '' }], providerData: { model: (e.meta && e.meta.model) || 'imported' }, sessionId: id, cwd });
        else if (b.type === 'thinking') push({ id: lid, parentId: prevId, timestamp: ts, type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: b.text || '' }], sessionId: id, cwd });
        else if (b.type === 'tool_use') push({ id: lid, parentId: prevId, timestamp: ts, type: 'function_call', callId: b.id || ('call_' + randomUUID().replace(/-/g, '').slice(0, 24)), name: b.name, arguments: JSON.stringify(b.input ?? {}), sessionId: id, cwd });
      }
    }
  }
  if (lines.length <= 1) throw new Error('没有可写入的内容条目');
  lines.push({ id: randomUUID(), timestamp: now, type: 'ai-title', aiTitle: (msx.source && msx.source.title) || truncateStr(firstUserText, 60), sessionId: id, cwd });
  writeJsonl(file, lines);

  // 注册 sessions 表；DB 打开/写入失败都补偿删除已落盘的 jsonl，避免孤儿文件
  const targetDb = dbFile || dbPath(baseDir);
  let db;
  try {
    db = new DatabaseSync(targetDb);
    db.exec('PRAGMA busy_timeout=4000');
    const cols = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
    const tpl = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 1').get() || {};
    const row = {};
    for (const c of cols) row[c] = tpl[c] ?? null;
    const set = (k, v) => { if (cols.includes(k)) row[k] = v; };
    set('id', id);
    set('cwd', cwd);
    set('title', (msx.source && msx.source.title) || truncateStr(firstUserText, 60));
    set('custom_title', null);
    set('status', 'completed');
    set('created_at', msx.entries && msx.entries[0] && msx.entries[0].ts ? isoToMs(msx.entries[0].ts) : now);
    set('updated_at', now);
    set('last_activity_at', now);
    set('deleted_at', null);
    set('is_playground', 0);
    set('is_background_automation', 0);
    const names = Object.keys(row);
    db.prepare(`INSERT INTO sessions (${names.map((n) => '"' + n + '"').join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((n) => row[n]));
    // session_usage
    try {
      const ucols = db.prepare("PRAGMA table_info(session_usage)").all().map((c) => c.name);
      const urow = {};
      for (const c of ucols) urow[c] = null;
      if (ucols.includes('session_id')) urow.session_id = id;
      if (ucols.includes('used')) urow.used = msx.stats ? msx.stats.approxTokens : 0;
      if (ucols.includes('size')) urow.size = (tpl && 0) || 1000000;
      if (ucols.includes('updated_at')) urow.updated_at = now;
      const unames = Object.keys(urow).filter((k) => urow[k] != null);
      db.prepare(`INSERT INTO session_usage (${unames.map((n) => '"' + n + '"').join(',')}) VALUES (${unames.map(() => '?').join(',')})`).run(...unames.map((n) => urow[n]));
    } catch { /* 非致命 */ }
  } catch (e) {
    try { fs.rmSync(file, { force: true }); } catch { }
    throw e;
  } finally { if (db) db.close(); }
  return { id, path: file, loss, count: lines.length };
}

function doctor(baseDir) {
  const ok = fs.existsSync(dbPath(baseDir));
  let sessions = 0;
  try { sessions = listSessions(baseDir).length; } catch { }
  return { agent: 'workbuddy', ok, storage: dbPath(baseDir), sessionFiles: sessions, projectsRoot: projectsRoot(baseDir) };
}

module.exports = { listSessions, readSession, writeSession, doctor, dbPath, findSessionFile };
