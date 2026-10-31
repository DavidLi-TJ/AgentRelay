'use strict';
// Pi 适配器（earendil-works/pi，开源）—— 🧪 实验性（schema 来自官方 session-format.md，本机无会话数据）
// baseDir = 自定义目录；null = 默认 ~/.pi/agent/sessions/<编码cwd>/<ts>_<id>.jsonl
// JSONL 树形：行1 {type:'session',version,id,timestamp,cwd}；条目 {type:'message'|..., id(8hex), parentId, timestamp}
// message: {message:{role: user|assistant|toolResult|..., content: 串|[blocks], ...}}；块: text/image/thinking/toolCall
const fs = require('fs');
const path = require('path');
const { HOME, nowISO, truncateStr, safeParse } = require('./util');

function sessionsRoot(baseDir) { return baseDir ? path.join(baseDir, 'sessions') : path.join(HOME, '.pi', 'agent', 'sessions'); }

function findSessionFiles(baseDir) {
  const root = sessionsRoot(baseDir);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const d of fs.readdirSync(root)) {
    const dir = path.join(root, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) out.push(path.join(dir, f));
  }
  return out;
}

function parseSessionFile(file) {
  const header = { type: 'session', id: path.basename(file, '.jsonl'), cwd: null, timestamp: null, version: 3 };
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const o = safeParse(t);
    if (!o) continue;
    if (o.type === 'session') { Object.assign(header, o); continue; }
    if (o.id) entries.push(o);
  }
  return { header, entries };
}

// 树形 → 活动分支（从最深叶子回溯到根）
function activeBranch(entries) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const referenced = new Set(entries.map((e) => e.parentId).filter(Boolean));
  const leaves = entries.filter((e) => !entries.some((x) => x.parentId === e.id));
  let leaf = leaves.length ? leaves.reduce((a, b) => (String(b.timestamp || '') > String(a.timestamp || '') ? b : a)) : null;
  const chain = [];
  let cur = leaf;
  const guard = new Set();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return chain.reverse();
}

function blocksFromContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const out = [];
  for (const b of content || []) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') out.push({ type: 'text', text: b.text || '' });
    else if (b.type === 'thinking') out.push({ type: 'thinking', text: b.thinking || b.text || '' });
    else if (b.type === 'toolCall') out.push({ type: 'tool_use', id: b.id || b.callID || ('call_' + Math.random().toString(36).slice(2, 10)), name: b.name || 'tool', input: safeParse(b.arguments, b.arguments ?? {}) });
    else if (b.type === 'image') out.push({ type: 'image', mediaType: b.mimeType });
  }
  return out;
}

function listSessions(baseDir) {
  const files = findSessionFiles(baseDir);
  const out = [];
  for (const f of files) {
    try {
      const { header, entries } = parseSessionFile(f);
      const branch = activeBranch(entries);
      const firstUser = branch.find((e) => e.type === 'message' && e.message && e.message.role === 'user');
      out.push({
        id: header.id || path.basename(f, '.jsonl'), agent: 'pi', file: f,
        title: truncateStr(((firstUser && blocksFromContent(firstUser.message.content)[0]) || {}).text || '(无标题)', 60),
        cwd: header.cwd || '', tsFirst: header.timestamp || null,
        tsLast: branch.length ? (branch[branch.length - 1].timestamp || null) : null,
        msgCount: branch.filter((e) => e.type === 'message').length, toolCalls: null, size: fs.statSync(f).size,
      });
    } catch { }
  }
  out.sort((a, b) => String(b.tsLast || '').localeCompare(String(a.tsLast || '')));
  return out;
}

async function readSession(sessionId, baseDir) {
  let target = null;
  for (const f of findSessionFiles(baseDir)) {
    const { header } = parseSessionFile(f);
    if (header.id === sessionId || path.basename(f).includes(sessionId)) { target = f; break; }
  }
  if (!target) throw new Error(`Pi 会话不存在: ${sessionId}`);
  const { header, entries } = parseSessionFile(target);
  const branch = activeBranch(entries);
  const loss = [];
  const msxEntries = [];
  const compactions = [];
  for (const e of branch) {
    if (e.type !== 'message') {
      if (e.type === 'compaction') compactions.push({ ts: e.timestamp, message: e.summary || '' });
      else if (e.type === 'compactionSummary' || e.type === 'branchSummary') compactions.push({ ts: e.timestamp, message: e.summary || '' });
      else loss.push(`Pi: 跳过 ${e.type} 条目`);
      continue;
    }
    const m = e.message || {};
    const ts = e.timestamp || null;
    if (m.role === 'user') {
      const blocks = blocksFromContent(m.content);
      const textOnly = blocks.filter((b) => b.type === 'text');
      if (textOnly.length) msxEntries.push({ id: e.id, ts, role: 'user', kind: 'text', blocks: textOnly, meta: {} });
    } else if (m.role === 'assistant') {
      const blocks = blocksFromContent(m.content);
      if (blocks.length) msxEntries.push({ id: e.id, ts, role: 'assistant', kind: 'text', blocks, meta: { model: m.model || (m.api ? m.api.model : null) } });
    } else if (m.role === 'toolResult') {
      const c = typeof m.content === 'string' ? m.content : (m.content || []).map((b) => b.text || '').join('');
      msxEntries.push({ id: e.id, ts, role: 'user', kind: 'tool-result', blocks: [{ type: 'tool_result', for: m.toolCallId || ('call_' + e.id), output: c, isError: !!m.isError }], meta: {} });
    } else if (m.role === 'bashExecution') {
      msxEntries.push({ id: e.id, ts, role: 'assistant', kind: 'text', blocks: [{ type: 'tool_use', id: 'bash_' + e.id, name: 'bash', input: { command: m.command || '' } }], meta: {} });
    }
  }
  const stats = { entries: msxEntries.length, userTurns: 0, assistantEntries: 0, toolCalls: 0, toolResults: 0, thinking: 0, approxTokens: 0, recordedTokens: null };
  for (const e of msxEntries) {
    if (e.role === 'user' && e.kind === 'text') stats.userTurns++;
    if (e.role === 'assistant') stats.assistantEntries++;
    for (const b of e.blocks) {
      if (b.type === 'tool_use') stats.toolCalls++;
      if (b.type === 'tool_result') stats.toolResults++;
      if (b.type === 'thinking') stats.thinking++;
      stats.approxTokens += Math.ceil((b.text || '').length / 3.5);
    }
  }
  return {
    arx: 1, id: require('crypto').randomUUID(), created_at: nowISO(),
    source: { agent: 'pi', agent_version: String(header.version || 3), session_id: header.id || sessionId, title: truncateStr(((msxEntries.find((e) => e.role === 'user' && e.kind === 'text') || { blocks: [{ text: '(无标题)' }] }).blocks[0].text || '').slice(0, 60), 60), file: target },
    project: { cwd: header.cwd || null },
    env: { model: null, provider: null, cli_version: null },
    stats, entries: msxEntries, compactions, loss,
    _fileStat: { size: fs.statSync(target).size, mtimeMs: fs.statSync(target).mtimeMs },
  };
}

function doctor(baseDir) {
  const p = sessionsRoot(baseDir);
  const ok = fs.existsSync(p);
  return { agent: 'pi', ok, storage: p, sessionFiles: ok ? findSessionFiles(baseDir).length : 0 };
}

module.exports = { listSessions, readSession, doctor, sessionsRoot, activeBranch, blocksFromContent };
