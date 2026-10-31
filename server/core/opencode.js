'use strict';
// OpenCode 适配器（sst/opencode，开源）—— message/part SQLite 架构（与 ZCode 同源）
// baseDir = 用户自定义数据目录（opencode data 目录）；null = 默认 ~/.local/share/opencode
// 成熟度: ✅ 本机真实数据验证（38 会话，V1 schema）
// 注: opencode 2.x 迁移到 session_v2/session_message 表（V2）；本机 db 为 V1。V2 检测为后续工作（读取前应检测表存在性）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  HOME, cacheDir, ensureDir, nowISO, randomUUID, rand10, isoToMs, msToISO,
  truncateStr, slugifyZcode, safeParse,
} = require('./util');

const dbPath = (baseDir) => baseDir
  ? path.join(baseDir, 'opencode.db')
  : path.join(HOME, '.local', 'share', 'opencode', 'opencode.db');

let _readCache = {};
function getReadDbFile(baseDir) {
  const src = dbPath(baseDir);
  const sigParts = [];
  for (const ext of ['', '-wal', '-shm']) {
    const p = src + ext;
    try { const st = fs.statSync(p); sigParts.push(`${ext}:${st.mtimeMs}:${st.size}`); } catch { sigParts.push(`${ext}:none`); }
  }
  const sig = sigParts.join('|');
  const hit = _readCache[src];
  if (hit && hit.sig === sig && fs.existsSync(hit.file)) return hit.file;
  ensureDir(cacheDir());
  const dest = path.join(cacheDir(), 'opencode-read-' + crypto.createHash('md5').update(src).digest('hex').slice(0, 8) + '.sqlite');
  try { fs.rmSync(dest, { force: true }); fs.rmSync(dest + '-wal', { force: true }); fs.rmSync(dest + '-shm', { force: true }); } catch { }
  let ok = false;
  try {
    const db = new DatabaseSync(src, { readOnly: true });
    try { db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); ok = true; } finally { db.close(); }
  } catch { }
  if (!ok) {
    for (const ext of ['', '-wal', '-shm']) {
      const s = src + ext;
      if (fs.existsSync(s)) fs.copyFileSync(s, dest + ext);
    }
  }
  _readCache[src] = { sig, file: dest };
  return dest;
}

function listSessions(baseDir) {
  if (!fs.existsSync(dbPath(baseDir))) return [];
  const db = new DatabaseSync(getReadDbFile(baseDir));
  try {
    const rows = db.prepare(`
      SELECT s.id, s.directory, s.title, s.version, s.parent_id, s.time_created, s.time_updated, s.time_archived,
        (SELECT count(*) FROM message m WHERE m.session_id = s.id) AS msg_count
      FROM session s ORDER BY s.time_updated DESC`).all();
    return rows.map((r) => ({
      id: r.id, agent: 'opencode', file: dbPath(baseDir),
      title: r.title || '(无标题)', cwd: r.directory || '', version: r.version,
      tsFirst: r.time_created ? msToISO(r.time_created) : null,
      tsLast: r.time_updated ? msToISO(r.time_updated) : null,
      msgCount: r.msg_count, toolCalls: null, size: null,
      archived: !!r.time_archived, forkOf: r.parent_id || null,
    }));
  } finally { db.close(); }
}

function coerceNotNull(row, info, tpl) {
  for (const c of info) {
    if (!c.notnull || c.pk) continue;
    if (row[c.name] !== null && row[c.name] !== undefined) continue;
    if (tpl && tpl[c.name] !== null && tpl[c.name] !== undefined) { row[c.name] = tpl[c.name]; continue; }
    if (c.dflt_value != null && c.dflt_value !== 'NULL') {
      const d = String(c.dflt_value);
      row[c.name] = d.startsWith("'") ? d.slice(1, -1) : (Number.isFinite(Number(d)) ? Number(d) : d);
      continue;
    }
    row[c.name] = '';
  }
}

async function readSession(sessionId, { dbFile, baseDir } = {}) {
  const db = new DatabaseSync(dbFile || getReadDbFile(baseDir));
  try {
    const sess = db.prepare('SELECT * FROM session WHERE id = ?').get(sessionId);
    if (!sess) throw new Error(`OpenCode 会话不存在: ${sessionId}`);
    const msgs = db.prepare('SELECT * FROM message WHERE session_id = ? ORDER BY time_created ASC, rowid ASC').all(sessionId);
    const parts = db.prepare('SELECT * FROM part WHERE session_id = ? ORDER BY rowid ASC').all(sessionId);
    const byMsg = new Map();
    for (const p of parts) {
      if (!byMsg.has(p.message_id)) byMsg.set(p.message_id, []);
      byMsg.get(p.message_id).push({ ...safeParse(p.data, {}) || {}, _time: p.time_created });
    }
    const entries = [];
    const compactions = [];
    const loss = [];
    let model = null, provider = null;
    for (const m of msgs) {
      const data = safeParse(m.data, {}) || {};
      const ps = (byMsg.get(m.id) || []).sort((a, b) => (a._time || 0) - (b._time || 0));
      const ts = msToISO(m.time_created || Date.now());
      if (data.role === 'user') {
        const blocks = [];
        for (const p of ps) {
          if (p.type === 'text' && p.text != null) blocks.push({ type: 'text', text: p.text });
        }
        if (blocks.length) entries.push({ id: m.id, ts, role: 'user', kind: 'text', blocks, meta: {} });
      } else if (data.role === 'assistant') {
        if (data.modelID) model = data.modelID;
        if (data.providerID) provider = data.providerID;
        const blocks = [];
        const results = [];
        for (const p of ps) {
          if (p.type === 'text' && p.text != null) blocks.push({ type: 'text', text: p.text });
          else if (p.type === 'reasoning' && p.text != null) blocks.push({ type: 'thinking', text: p.text });
          else if (p.type === 'tool') {
            const st = p.state || {};
            blocks.push({ type: 'tool_use', id: p.callID, name: p.tool || 'tool', input: st.input ?? {} });
            if (st.output != null) {
              results.push({ type: 'tool_result', for: p.callID, output: typeof st.output === 'string' ? st.output : JSON.stringify(st.output ?? ''), isError: st.status === 'error' });
            }
          } else if (p.type === 'patch') {
            blocks.push({ type: 'tool_use', id: p.id || ('patch_' + entries.length), name: 'patch', input: { data: JSON.stringify(p).slice(0, 2000) } });
          } else if (p.type === 'compaction') {
            compactions.push({ ts, message: typeof p.text === 'string' ? p.text : JSON.stringify(p) });
          }
          // step-start / step-finish: 界面事件，跳过
        }
        if (blocks.length) entries.push({ id: m.id, ts, role: 'assistant', kind: 'text', blocks, meta: { model: data.modelID || null } });
        if (results.length) entries.push({ id: m.id + '_res', ts, role: 'user', kind: 'tool-result', blocks: results, meta: {} });
      }
    }
    const stats = { entries: entries.length, userTurns: 0, assistantEntries: 0, toolCalls: 0, toolResults: 0, thinking: 0, approxTokens: 0, recordedTokens: 0 };
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
    try {
      const t = db.prepare('SELECT coalesce(sum(tokens_input),0) i, coalesce(sum(tokens_output),0) o FROM session WHERE id = ?').get(sessionId);
      if (t) stats.recordedTokens = (t.i || 0) + (t.o || 0);
    } catch { }
    return {
      arx: 1, id: randomUUID(), created_at: nowISO(),
      source: { agent: 'opencode', agent_version: sess.version, session_id: sess.id, title: sess.title || '(无标题)', file: dbFile || dbPath(baseDir) },
      project: { cwd: sess.directory || '' },
      env: { model, provider, cli_version: sess.version },
      stats, entries, compactions, loss,
      _fileStat: { size: null, mtimeMs: fs.statSync(dbFile || dbPath(baseDir)).mtimeMs },
    };
  } finally { db.close(); }
}

// ---------- 写入（T1 原生注入） ----------
function msgId() { return `msg_${rand10()}_${randomUUID()}`; }
function partId() { return `prt_${rand10()}_${randomUUID()}`; }

function writeSession(msx, { cwd, newId, dbFile, baseDir } = {}) {
  cwd = cwd || msx.project?.cwd;
  if (!cwd) throw new Error('缺少目标项目 cwd');
  const target = dbFile || dbPath(baseDir);
  const db = new DatabaseSync(target);
  const loss = [...(msx.loss || [])];
  try {
    db.exec('PRAGMA busy_timeout=4000');
    const sessCols = db.prepare("PRAGMA table_info(session)").all();
    const sessColsNames = sessCols.map((c) => c.name);
    const tplSession = db.prepare('SELECT * FROM session ORDER BY time_updated DESC LIMIT 1').get() || {};
    const resultFor = new Map();
    for (const e of msx.entries || []) {
      if (e.kind === 'tool-result') for (const b of e.blocks || []) if (b.type === 'tool_result' && b.for) resultFor.set(b.for, b);
    }
    const hasContent = (msx.entries || []).some((e) => (e.role === 'user' && e.kind === 'text') || e.role === 'assistant' || e.kind === 'tool-result');
    if (!hasContent) throw new Error('没有可写入的内容条目');

    db.exec('BEGIN IMMEDIATE');
    try {
      const id = newId || `ses_${randomUUID()}`;
      const now = Date.now();
      const firstTs = msx.entries && msx.entries[0] && msx.entries[0].ts ? isoToMs(msx.entries[0].ts) : now;
      const lastTs = msx.entries && msx.entries.length ? isoToMs(msx.entries[msx.entries.length - 1].ts || now) : now;
      const sessRow = {
        ...(tplSession || {}),
        id, project_id: (tplSession && tplSession.project_id) || 'global', workspace_id: null, parent_id: null,
        slug: id, directory: cwd, path: cwd.split(/[\\/]/).filter(Boolean).slice(-2).join('/'),
        title: (msx.source && msx.source.title) || '导入的会话',
        version: (tplSession && tplSession.version) || '1.18.15',
        time_created: firstTs, time_updated: Math.max(lastTs, firstTs),
        time_compacting: null, time_archived: null,
      };
      coerceNotNull(sessRow, sessCols, tplSession);
      const sNames = Object.keys(sessRow).filter((k) => sessColsNames.includes(k));
      db.prepare(`INSERT INTO session (${sNames.map((n) => '"' + n + '"').join(',')}) VALUES (${sNames.map(() => '?').join(',')})`)
        .run(...sNames.map((n) => sessRow[n]));

      const msgCols = db.prepare("PRAGMA table_info(message)").all().map((c) => c.name);
      const partCols = db.prepare("PRAGMA table_info(part)").all().map((c) => c.name);
      const tplMsg = db.prepare("SELECT data FROM message WHERE data LIKE '%\"role\":\"assistant\"%' ORDER BY time_created DESC LIMIT 1").get();
      const tplAsst = tplMsg ? safeParse(tplMsg.data, {}) || {} : {};

      const insertMsg = (row) => {
        coerceNotNull(row, db.prepare("PRAGMA table_info(message)").all(), { role: 'assistant' });
        const names = Object.keys(row).filter((k) => msgCols.includes(k));
        db.prepare(`INSERT INTO message (${names.map((n) => '"' + n + '"').join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((n) => row[n]));
      };
      const insertPart = (row) => {
        const names = Object.keys(row).filter((k) => partCols.includes(k));
        db.prepare(`INSERT INTO part (${names.map((n) => '"' + n + '"').join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((n) => row[n]));
      };

      let seq = 0, prevMsgId = null;
      for (const e of msx.entries || []) {
        const ms = e.ts ? isoToMs(e.ts) : now;
        if (e.kind === 'compaction') { loss.push('OpenCode 目标：跳过 compaction 标记'); continue; }
        if (e.role === 'meta' || e.role === 'system') { loss.push(`OpenCode 目标：跳过 1 条 ${e.role} 条目`); continue; }
        const mid = msgId();
        if (e.role === 'user' && e.kind === 'text') {
          const data = {
            role: 'user', time: { created: ms }, agent: 'build',
            model: { providerID: (tplAsst && tplAsst.providerID) || 'opencode', modelID: (tplAsst && tplAsst.modelID) || 'imported', variant: 'max' },
          };
          insertMsg({ id: mid, session_id: id, time_created: ms, time_updated: ms, data: JSON.stringify(data) });
          let pseq = 0;
          for (const b of e.blocks || []) {
            if (b.type !== 'text') continue;
            insertPart({ id: partId(), message_id: mid, session_id: id, time_created: ms, time_updated: ms, data: JSON.stringify({ type: 'text', text: b.text }), sequence: pseq++ });
          }
          prevMsgId = mid; seq++;
        } else if (e.role === 'assistant') {
          const data = {
            parentID: prevMsgId, role: 'assistant', mode: 'build', agent: 'build',
            modelID: (tplAsst && tplAsst.modelID) || 'imported', providerID: (tplAsst && tplAsst.providerID) || 'opencode',
            path: { cwd, root: cwd }, cost: 0, time: { created: ms, completed: ms }, finish: 'stop',
          };
          insertMsg({ id: mid, session_id: id, time_created: ms, time_updated: ms, data: JSON.stringify(data) });
          let pseq = 0;
          for (const b of e.blocks || []) {
            if (b.type === 'text') insertPart({ id: partId(), message_id: mid, session_id: id, time_created: ms, time_updated: ms, data: JSON.stringify({ type: 'text', text: b.text || '' }), sequence: pseq++ });
            else if (b.type === 'thinking') insertPart({ id: partId(), message_id: mid, session_id: id, time_created: ms, time_updated: ms, data: JSON.stringify({ type: 'reasoning', text: b.text || '' }), sequence: pseq++ });
            else if (b.type === 'tool_use') {
              const res = resultFor.get(b.id);
              const state = { status: res ? (res.isError ? 'error' : 'completed') : 'completed', input: b.input ?? {} };
              if (res) state.output = typeof res.output === 'string' ? res.output : JSON.stringify(res.output ?? '');
              insertPart({ id: partId(), message_id: mid, session_id: id, time_created: ms, time_updated: ms, data: JSON.stringify({ type: 'tool', callID: b.id || ('call_' + randomUUID().replace(/-/g, '').slice(0, 24)), tool: b.name, state }), sequence: pseq++ });
            }
          }
          prevMsgId = mid; seq++;
        } else if (e.kind === 'tool-result') {
          for (const b of e.blocks || []) {
            if (b.type !== 'tool_result' || resultFor.get(b.for)) continue;
            if (!prevMsgId) { loss.push('OpenCode 目标：丢弃孤儿工具结果 1 条'); continue; }
            insertPart({ id: partId(), message_id: prevMsgId, session_id: id, time_created: ms, time_updated: ms, data: JSON.stringify({ type: 'tool', callID: b.for, tool: 'tool', state: { status: b.isError ? 'error' : 'completed', input: {}, output: typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? '') } }), sequence: 10000 });
          }
        }
      }
      if (!seq) throw new Error('没有可写入的内容条目');
      db.exec(`UPDATE session SET time_updated = ${Math.max(lastTs, firstTs)} WHERE id = '${id.replace(/'/g, "''")}'`);
      const out = { id, path: target, loss, count: seq };
      db.exec('COMMIT');
      return out;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { }
      throw e;
    }
  } finally { db.close(); }
}

function doctor(baseDir) {
  const p = dbPath(baseDir);
  let sessions = 0;
  try {
    const db = new DatabaseSync(p, { readOnly: true });
    try { sessions = db.prepare('SELECT count(*) c FROM session').get().c; } finally { db.close(); }
  } catch { }
  return { agent: 'opencode', ok: fs.existsSync(p), storage: p, sessionFiles: sessions };
}

module.exports = { listSessions, readSession, writeSession, doctor, dbPath, getReadDbFile };
