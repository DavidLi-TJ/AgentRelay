'use strict';
// ZCode 会话适配器：~/.zcode/cli/db/db.sqlite（node:sqlite 读写；读走副本避免锁）
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const {
  HOME, cacheDir, ensureDir, nowISO, randomUUID, rand10, isoToMs, msToISO,
  truncateStr, slugifyZcode, deepReplaceStrings, safeParse,
} = require('./util');

// baseDir = 用户自定义数据目录（.zcode 目录）；null = 默认 ~/.zcode
const dbPath = (baseDir) => baseDir ? path.join(baseDir, 'cli', 'db', 'db.sqlite') : path.join(HOME, '.zcode', 'cli', 'db', 'db.sqlite');

let _readCache = {}; // baseKey → { sig, file }
function getReadDbFile(baseDir) {
  const src = dbPath(baseDir);
  const baseKey = src;
  // 签名包含主库与 WAL 的 mtime/size：写入通常落在 WAL，主库 mtime 不变
  const sigParts = [];
  for (const ext of ['', '-wal', '-shm']) {
    const p = src + ext;
    try { const st = fs.statSync(p); sigParts.push(`${ext}:${st.mtimeMs}:${st.size}`); } catch { sigParts.push(`${ext}:none`); }
  }
  const sig = sigParts.join('|');
  const hit = _readCache[baseKey];
  if (hit && hit.sig === sig && fs.existsSync(hit.file)) return hit.file;
  ensureDir(cacheDir());
  const dest = path.join(cacheDir(), 'zcode-read-' + require('crypto').createHash('md5').update(baseKey).digest('hex').slice(0, 8) + '.sqlite');
  try { fs.rmSync(dest, { force: true }); fs.rmSync(dest + '-wal', { force: true }); fs.rmSync(dest + '-shm', { force: true }); } catch { }
  // 优先 VACUUM INTO：单文件一致性快照（避免 db/-wal 逐个拷贝的撕裂窗口）
  let ok = false;
  try {
    const db = new DatabaseSync(src, { readOnly: true });
    try { db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); ok = true; }
    finally { db.close(); }
  } catch { }
  if (!ok) {
    for (const ext of ['', '-wal', '-shm']) {
      const s = src + ext;
      if (fs.existsSync(s)) fs.copyFileSync(s, dest + ext);
      else if (fs.existsSync(dest + ext)) fs.rmSync(dest + ext);
    }
  }
  _readCache[baseKey] = { sig, file: dest };
  return dest;
}

function openReadOnly(baseDir) { return new DatabaseSync(getReadDbFile(baseDir), { readOnly: false }); }

function listSessions(baseDir) {
  if (!fs.existsSync(dbPath(baseDir))) return [];
  const db = openReadOnly(baseDir);
  try {
    const rows = db.prepare(`
      SELECT s.id, s.project_id, s.directory, s.title, s.parent_id, s.version, s.time_created, s.time_updated, s.time_archived, s.time_deleted,
        (SELECT count(*) FROM message m WHERE m.session_id = s.id) AS msg_count
      FROM session s ORDER BY s.time_updated DESC`).all();
    return rows.map((r) => ({
      id: r.id, agent: 'zcode', file: dbPath(),
      title: r.title || '(无标题)', cwd: r.directory || '', version: r.version,
      tsFirst: r.time_created ? msToISO(r.time_created) : null,
      tsLast: r.time_updated ? msToISO(r.time_updated) : null,
      msgCount: r.msg_count, toolCalls: null, size: null,
      archived: !!r.time_archived, deleted: !!r.time_deleted, forkOf: r.parent_id || null,
    }));
  } finally { db.close(); }
}

function isRuntimeUser(o) {
  const md = o.metadata || {};
  const sem = o.semantics || {};
  return md.visibility === 'model-only' || sem.origin === 'agent_runtime' || sem.kind === 'system_reminder';
}

function readSession(sessionId, { dbFile, baseDir } = {}) {
  const db = new DatabaseSync(dbFile || getReadDbFile(baseDir));
  try {
    const sess = db.prepare('SELECT * FROM session WHERE id = ?').get(sessionId);
    if (!sess) throw new Error(`ZCode 会话不存在: ${sessionId}`);
    const msgs = db.prepare('SELECT * FROM message WHERE session_id = ? ORDER BY sequence ASC').all(sessionId);
    const parts = db.prepare('SELECT * FROM part WHERE session_id = ? ORDER BY sequence ASC').all(sessionId);
    const byMsg = new Map();
    for (const p of parts) {
      if (!byMsg.has(p.message_id)) byMsg.set(p.message_id, []);
      byMsg.get(p.message_id).push(p);
    }
    const entries = [];
    const compactions = [];
    const loss = [];
    let model = null, provider = null;
    for (const m of msgs) {
      const data = safeParse(m.data, {}) || {};
      const ps = (byMsg.get(m.id) || []).map((p) => ({ ...safeParse(p.data, {}) || {}, _seq: p.sequence }));
      ps.sort((a, b) => (a._seq || 0) - (b._seq || 0));
      const ts = msToISO(m.time_created || Date.now());
      if (data.role === 'user') {
        if (isRuntimeUser(data)) {
          const text = ps.filter((p) => p.type === 'text').map((p) => p.text || '').join('\n');
          if (text) entries.push({ id: 'm' + m.sequence, ts, role: 'meta', kind: 'note', blocks: [{ type: 'text', text }], meta: { subtype: 'runtime 注入' } });
          continue;
        }
        const blocks = [];
        for (const p of ps) {
          if (p.type === 'text' && p.text != null) blocks.push({ type: 'text', text: p.text });
          else if (p.type === 'file') blocks.push({ type: 'text', text: '[文件附件] ' + JSON.stringify(p).slice(0, 300) });
        }
        if (blocks.length) entries.push({ id: 'm' + m.sequence, ts, role: 'user', kind: 'text', blocks, meta: {} });
      } else if (data.role === 'assistant') {
        if (data.modelID) model = data.modelID;
        if (data.providerId) provider = data.providerId;
        const blocks = [];
        const results = [];
        for (const p of ps) {
          if (p.type === 'text' && p.text != null) blocks.push({ type: 'text', text: p.text });
          else if (p.type === 'reasoning' && p.text != null) blocks.push({ type: 'thinking', text: p.text });
          else if (p.type === 'tool') {
            const st = p.state || {};
            blocks.push({ type: 'tool_use', id: p.callID, name: p.tool || 'tool', input: st.input ?? {} });
            if (st.output != null || st.status === 'completed') {
              results.push({ type: 'tool_result', for: p.callID, output: typeof st.output === 'string' ? st.output : JSON.stringify(st.output ?? ''), isError: st.status === 'error' });
            }
          } else if (p.type === 'compaction') {
            compactions.push({ ts, message: typeof p.text === 'string' ? p.text : JSON.stringify(p) });
          }
          // step-start / step-finish / timeline: UI 步骤事件，跳过
        }
        if (blocks.length) entries.push({ id: 'm' + m.sequence, ts, role: 'assistant', kind: 'text', blocks, meta: { model: data.modelID || null } });
        if (results.length) entries.push({ id: 'm' + m.sequence + '_res', ts, role: 'user', kind: 'tool-result', blocks: results, meta: {} });
      }
    }
    if (stepLike(parts)) loss.push('已跳过 step-start/step-finish/timeline 等界面事件 part');
    const stats = { entries: entries.length, userTurns: 0, assistantEntries: 0, toolCalls: 0, toolResults: 0, thinking: 0, approxTokens: 0, recordedTokens: 0 };
    for (const e of entries) {
      if (e.role === 'user' && e.kind === 'text') stats.userTurns++;
      if (e.role === 'assistant') stats.assistantEntries++;
      for (const b of e.blocks) {
        if (b.type === 'tool_use') stats.toolCalls++;
        if (b.type === 'tool_result') stats.toolResults++;
        if (b.type === 'thinking') stats.thinking++;
        stats.approxTokens += Math.ceil(((b.text || JSON.stringify(b.input ?? b.output ?? '')).length) / 3.5);
      }
    }
    try {
      const tu = db.prepare('SELECT sum(input_tokens) i, sum(output_tokens) o FROM turn_usage WHERE session_id = ?').get(sessionId);
      if (tu) stats.recordedTokens = (tu.i || 0) + (tu.o || 0);
    } catch { }
    return {
      arx: 1, id: randomUUID(), created_at: nowISO(),
      source: { agent: 'zcode', agent_version: sess.version, session_id: sess.id, title: sess.title || '(无标题)', file: dbFile || dbPath(baseDir) },
      project: { cwd: sess.directory || '' },
      env: { model, provider, cli_version: sess.version },
      stats, entries, compactions, loss,
      _fileStat: { size: null, mtimeMs: fs.statSync(dbFile || dbPath(baseDir)).mtimeMs },
    };
  } finally { db.close(); }
}

function stepLike(parts) {
  return parts.some((p) => { const d = safeParse(p.data, {}) || {}; return d.type === 'step-start' || d.type === 'step-finish' || d.type === 'timeline'; });
}

// ---------- 写入 ----------
function templates(db) {
  const t = {};
  try { t.user = safeParse(db.prepare("SELECT data FROM message WHERE data LIKE '%\"role\":\"user\"%' ORDER BY time_created DESC LIMIT 1").get()?.data, null); } catch { }
  try { t.asst = safeParse(db.prepare("SELECT data FROM message WHERE data LIKE '%\"role\":\"assistant\"%' ORDER BY time_created DESC LIMIT 1").get()?.data, null); } catch { }
  try { t.input = db.prepare("SELECT * FROM session_input WHERE kind='sendText' ORDER BY time_created DESC LIMIT 1").get() || null; } catch { }
  try { t.session = db.prepare('SELECT * FROM session ORDER BY time_created DESC LIMIT 1').get() || null; } catch { }
  return t;
}

function msgId() { return `msg_${rand10()}_${randomUUID()}`; }
function partId() { return `part_${rand10()}_${randomUUID()}`; }

function writeSession(msx, { cwd, newId, dbFile, baseDir } = {}) {
  cwd = cwd || msx.project?.cwd;
  if (!cwd) throw new Error('缺少目标项目 cwd');
  const target = dbFile || dbPath(baseDir);
  const db = new DatabaseSync(target);
  const loss = [...(msx.loss || [])];
  try {
    db.exec('PRAGMA busy_timeout=4000');
    const tpl = templates(db);
    const sessCols = db.prepare("PRAGMA table_info(session)").all().map((c) => c.name);
    const id = newId || `sess_${randomUUID()}`;
    const now = Date.now();
    const firstTs = msx.entries && msx.entries[0] && msx.entries[0].ts ? isoToMs(msx.entries[0].ts) : now;
    const lastTs = msx.entries && msx.entries.length ? isoToMs(msx.entries[msx.entries.length - 1].ts || now) : now;
    const title = (msx.source && msx.source.title) || '导入的会话';

    // 预收集工具结果：tool part 的 state.output 要合并进同一个 part
    const resultFor = new Map();
    for (const e of msx.entries || []) {
      if (e.kind === 'tool-result') for (const b of e.blocks || []) if (b.type === 'tool_result' && b.for) resultFor.set(b.for, b);
    }
    // 空内容检查前置：绝不先插 session 行再失败
    const hasContent = (msx.entries || []).some((e) =>
      (e.role === 'user' && e.kind === 'text') || e.role === 'assistant' || e.kind === 'tool-result');
    if (!hasContent) throw new Error('没有可写入的内容条目（全部被过滤）');

    db.exec('BEGIN IMMEDIATE');
    try {
      const msgCols = db.prepare("PRAGMA table_info(message)").all().map((c) => c.name);
      const partCols = db.prepare("PRAGMA table_info(part)").all().map((c) => c.name);

    const sessRow = {
      ...(tpl.session || {}),
      id, project_id: 'proj_' + slugifyZcode(cwd), workspace_id: null, parent_id: null, slug: id,
      directory: cwd, path: cwd, title, version: '0.16.5', share_url: null,
      summary_additions: null, summary_deletions: null, summary_files: null, summary_diffs: null,
      revert: null, permission: '{"mode":"build"}', time_created: firstTs, time_updated: Math.max(lastTs, firstTs),
      time_compacting: null, time_archived: null, title_source: 'generated',
      title_message_id: null, time_title_updated: null, time_deleted: null,
    };
    const sNames = Object.keys(sessRow).filter((k) => sessCols.includes(k));
    {
      const info = db.prepare("PRAGMA table_info(session)").all();
      coerceNotNull(sessRow, info, tpl.session);
    }
    db.prepare(`INSERT INTO session (${sNames.map((n) => '"' + n + '"').join(',')}) VALUES (${sNames.map(() => '?').join(',')})`)
      .run(...sNames.map((n) => sessRow[n]));

    const userModel = (tpl.user && (tpl.user.modelSelection || tpl.user.model)) || { providerID: 'builtin:bigmodel-start-plan', modelID: 'GLM-5.3-Flash', variant: 'max' };
    const asstModelID = (tpl.asst && tpl.asst.modelID) || 'GLM-5.3-Flash';
    const asstProvider = (tpl.asst && tpl.asst.providerId) || 'account:bigmodel-start-plan';

    let seq = 0, prevMsgId = null, firstMsgId = null, firstUserText = '';
    let orphanSeq = 10000;
    for (const e of msx.entries || []) {
      const ms = e.ts ? isoToMs(e.ts) : now;
      if (e.kind === 'compaction') { loss.push('ZCode 目标：跳过 compaction 标记（可稍后在 ZCode 内手动压缩）'); continue; }
      if (e.role === 'meta' || e.role === 'system') { loss.push(`ZCode 目标：跳过 1 条 ${e.role} 条目`); continue; }
      const mid = msgId();
      if (e.role === 'user' && e.kind === 'text') {
        const data = {
          role: 'user', time: { created: ms }, agent: 'zcode-agent',
          model: userModel.modelSelection || userModel.model || userModel,
          contextSnapshot: { envInfo: { cwd, platform: 'win32', shell: 'Git Bash' } },
          semantics: { origin: 'user' },
        };
        insertMsg(db, msgCols, { id: mid, session_id: id, time_created: ms, time_updated: ms, data: JSON.stringify(data), sequence: seq });
        if (!firstMsgId) firstMsgId = mid;
        if (!firstUserText) firstUserText = (e.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        let pseq = 0;
        for (const b of e.blocks || []) {
          if (b.type !== 'text') continue;
          insertPart(db, partCols, { id: partId(), message_id: mid, session_id: id, time_created: ms, time_updated: ms, data: JSON.stringify({ type: 'text', text: b.text, time: { start: ms, end: ms } }), sequence: pseq++ });
        }
        prevMsgId = mid; seq++;
      } else if (e.role === 'assistant') {
        const data = {
          role: 'assistant', time: { created: ms, completed: ms }, parentID: prevMsgId,
          modelID: asstModelID, providerId: asstProvider, mode: 'yolo', agent: 'zcode-agent',
          path: { cwd, root: cwd }, cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: 'stop',
        };
        insertMsg(db, msgCols, { id: mid, session_id: id, time_created: ms, time_updated: ms, data: JSON.stringify(data), sequence: seq });
        let pseq = 0;
        for (const b of e.blocks || []) {
          if (b.type === 'text') insertPart(db, partCols, { id: partId(), message_id: mid, session_id: id, time_created: ms, time_updated: ms, data: JSON.stringify({ type: 'text', text: b.text || '', time: { start: ms, end: ms } }), sequence: pseq++ });
          else if (b.type === 'thinking') insertPart(db, partCols, { id: partId(), message_id: mid, session_id: id, time_created: ms, time_updated: ms, data: JSON.stringify({ type: 'reasoning', text: b.text || '', time: { start: ms, end: ms } }), sequence: pseq++ });
          else if (b.type === 'tool_use') {
            const res = resultFor.get(b.id);
            const state = { status: res ? (res.isError ? 'error' : 'completed') : 'completed', input: b.input ?? {} };
            if (res) state.output = typeof res.output === 'string' ? res.output : JSON.stringify(res.output ?? '');
            insertPart(db, partCols, { id: partId(), message_id: mid, session_id: id, time_created: ms, time_updated: ms, data: JSON.stringify({ type: 'tool', callID: b.id || ('call_' + randomUUID().replace(/-/g, '').slice(0, 24)), tool: b.name, state }), sequence: pseq++ });
          }
        }
        prevMsgId = mid; seq++;
      } else if (e.kind === 'tool-result') {
        // 已合并进上面的 tool part；孤儿结果（无对应调用）补一个 tool part 到上一条 assistant
        for (const b of e.blocks || []) {
          if (b.type !== 'tool_result' || resultFor.get(b.for)) continue;
          if (!prevMsgId) { loss.push('ZCode 目标：丢弃孤儿工具结果 1 条'); continue; }
          insertPart(db, partCols, { id: partId(), message_id: prevMsgId, session_id: id, time_created: ms, time_updated: ms, data: JSON.stringify({ type: 'tool', callID: b.for, tool: 'tool', state: { status: b.isError ? 'error' : 'completed', input: {}, output: typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? '') } }), sequence: orphanSeq++ });
        }
      }
    }
    if (!firstMsgId) throw new Error('没有可写入的内容条目');
    // session_input（用户输入队列）
    if (sessCols.length && firstUserText) {
      try {
        const inCols = db.prepare("PRAGMA table_info(session_input)").all().map((c) => c.name);
        const t = tpl.input || {};
        const row = {
          id: 'queue_' + randomUUID(), session_id: id, kind: 'sendText', delivery: 'startNow',
          payload: JSON.stringify({ text: firstUserText, intent: { sourceCommandId: id, queueItemId: 'queue_' + randomUUID(), clientId: 'agentrelay' } }),
          admitted_sequence: 0, promoted_sequence: 1, promoted_message_id: firstMsgId,
          status: t.status != null ? t.status : 'done', status_reason: t.status_reason ?? null,
          time_created: firstTs, time_updated: firstTs,
        };
        const names = Object.keys(row).filter((k) => inCols.includes(k));
        db.prepare(`INSERT INTO session_input (${names.map((n) => '"' + n + '"').join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((n) => row[n]));
      } catch (err) { loss.push('session_input 写入失败（不影响消息体）: ' + err.message); }
    }
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

function insertMsg(db, cols, row, tpl) {
  const info = db.prepare("PRAGMA table_info(message)").all();
  coerceNotNull(row, info, tpl);
  const names = Object.keys(row).filter((k) => cols.includes(k));
  db.prepare(`INSERT INTO message (${names.map((n) => '"' + n + '"').join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((n) => row[n]));
}
function insertPart(db, cols, row, tpl) {
  const info = db.prepare("PRAGMA table_info(part)").all();
  coerceNotNull(row, info, tpl);
  const names = Object.keys(row).filter((k) => cols.includes(k));
  db.prepare(`INSERT INTO part (${names.map((n) => '"' + n + '"').join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((n) => row[n]));
}

// NOT NULL 列兜底：模板值 → 声明默认值 → ''/0
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

// T0：同一库内复制（复用 ZCode 原生 fork 语义，事务包裹防半写）
function copySession(sessionId, { dbFile, baseDir, newParent = true } = {}) {
  const target = dbFile || dbPath(baseDir);
  const db = new DatabaseSync(target);
  try {
    db.exec('PRAGMA busy_timeout=4000');
    const sess = db.prepare('SELECT * FROM session WHERE id = ?').get(sessionId);
    if (!sess) throw new Error(`ZCode 会话不存在: ${sessionId}`);
    db.exec('BEGIN IMMEDIATE');
    try {
    const newId = `sess_${randomUUID()}`;
    const sessCols = db.prepare("PRAGMA table_info(session)").all().map((c) => c.name);
    const row = { ...sess };
    row.id = newId; row.slug = newId; row.parent_id = newParent ? sessionId : null;
    row.title = (sess.title || '会话') ; row.time_created = Date.now(); row.time_updated = Date.now();
    row.time_archived = null; row.time_deleted = null; row.share_url = null;
    const sNames = Object.keys(row).filter((k) => sessCols.includes(k));
    db.prepare(`INSERT INTO session (${sNames.map((n) => '"' + n + '"').join(',')}) VALUES (${sNames.map(() => '?').join(',')})`).run(...sNames.map((n) => row[n]));
    const msgCols = db.prepare("PRAGMA table_info(message)").all().map((c) => c.name);
    const partCols = db.prepare("PRAGMA table_info(part)").all().map((c) => c.name);
    const msgs = db.prepare('SELECT * FROM message WHERE session_id = ? ORDER BY sequence').all(sessionId);
    const idMap = new Map();
    for (const m of msgs) idMap.set(m.id, `msg_${rand10()}_${randomUUID()}`);
    for (const m of msgs) {
      const nmid = idMap.get(m.id);
      const data = safeParse(m.data, {}) || {};
      if (data.parentID && idMap.has(data.parentID)) data.parentID = idMap.get(data.parentID);
      insertMsg(db, msgCols, { id: nmid, session_id: newId, time_created: m.time_created, time_updated: m.time_updated, data: JSON.stringify(data), sequence: m.sequence });
      const parts = db.prepare('SELECT * FROM part WHERE message_id = ? ORDER BY sequence').all(m.id);
      for (const p of parts) {
        insertPart(db, partCols, { id: partId(), message_id: nmid, session_id: newId, time_created: p.time_created, time_updated: p.time_updated, data: p.data, sequence: p.sequence });
      }
    }
    const inputs = db.prepare('SELECT * FROM session_input WHERE session_id = ?').all(sessionId);
    const inCols = db.prepare("PRAGMA table_info(session_input)").all().map((c) => c.name);
    for (const inp of inputs) {
      const r = deepReplaceStrings(inp, (s) => s);
      r.id = 'queue_' + randomUUID(); r.session_id = newId;
      if (r.promoted_message_id && idMap.has(r.promoted_message_id)) r.promoted_message_id = idMap.get(r.promoted_message_id);
      const names = Object.keys(r).filter((k) => inCols.includes(k));
      db.prepare(`INSERT INTO session_input (${names.map((n) => '"' + n + '"').join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((n) => r[n]));
    }
    db.exec('COMMIT');
    return { id: newId, path: target, count: msgs.length };
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { }
      throw e;
    }
  } finally { db.close(); }
}

function doctor(baseDir) {
  const p = dbPath(baseDir);
  let sessions = 0, messages = 0;
  try {
    const db = openReadOnly(baseDir);
    try {
      sessions = db.prepare('SELECT count(*) c FROM session').get().c;
      messages = db.prepare('SELECT count(*) c FROM message').get().c;
    } finally { db.close(); }
  } catch { }
  return { agent: 'zcode', ok: fs.existsSync(p), storage: p, sessionFiles: sessions, messages, appDir: path.join(HOME, '.zcode') };
}

module.exports = { listSessions, readSession, writeSession, copySession, doctor, dbPath, getReadDbFile };
