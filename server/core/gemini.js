'use strict';
// Gemini CLI 适配器（google-gemini/gemini-cli）—— 🧪 实验性（schema 来自官方源码 chatRecordingService.ts，本机未安装）
// baseDir = 自定义数据目录；null = 默认 ~/.gemini。会话: tmp/<projectHash>/chats/session-*.jsonl（旧版 .json）
// 行 1 = 元数据 {sessionId, projectHash, startTime, lastUpdated, summary?, kind: main|subagent}
// 消息行 MessageRecord {id, timestamp, type: user|gemini|info|error|warning, content, displayContent?, toolCalls?, thoughts?, tokens?, model?}
// 特殊行 {$rewindTo} / {$patch} / {$set} —— 解析时跳过并记 loss
const fs = require('fs');
const path = require('path');
const { HOME, nowISO, truncateStr, safeParse } = require('./util');

function geminiRoot(baseDir) { return baseDir ? path.join(baseDir, 'tmp') : path.join(HOME, '.gemini', 'tmp'); }

function isMsgRecord(o) { return o && typeof o === 'object' && (o.type === 'user' || o.type === 'gemini' || o.type === 'info' || o.type === 'error' || o.type === 'warning') && (o.id || o.timestamp); }

function parseFile(file) {
  const meta = { sessionId: null, startTime: null, lastUpdated: null, summary: null, kind: 'main' };
  const records = [];
  const loss = [];
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const o = safeParse(t);
    if (!o) continue;
    if (o.sessionId && o.kind !== undefined) {
      Object.assign(meta, { sessionId: o.sessionId, startTime: o.startTime, lastUpdated: o.lastUpdated, summary: o.summary || null, kind: o.kind || 'main' });
      continue;
    }
    if (o.$rewindTo || o.$patch || o.$set) { loss.push('Gemini: 跳过 $rewindTo/$patch/$set 特殊记录（回溯/编辑标记）'); continue; }
    if (isMsgRecord(o)) records.push(o);
  }
  return { meta, records, loss };
}

function contentText(c, display) {
  if (display != null) return String(display);
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && p.text) || '').join('');
  return c == null ? '' : JSON.stringify(c);
}

function listSessions(baseDir) {
  const root = geminiRoot(baseDir);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const hash of fs.readdirSync(root)) {
    const chats = path.join(root, hash, 'chats');
    if (!fs.existsSync(chats)) continue;
    for (const f of fs.readdirSync(chats)) {
      if (!f.endsWith('.jsonl') && !f.endsWith('.json')) continue;
      try {
        const { meta, records } = f.endsWith('.jsonl') ? parseFile(path.join(chats, f)) : legacyParse(path.join(chats, f));
        if (!meta.sessionId && !records.length) continue;
        const firstUser = records.find((r) => r.type === 'user');
        out.push({
          id: meta.sessionId || f.replace(/^session-|\.jsonl?$/g, ''), agent: 'gemini',
          file: path.join(chats, f),
          title: truncateStr((meta.summary || contentText(firstUser && firstUser.content, firstUser && firstUser.displayContent) || '(无标题)').replace(/\s+/g, ' '), 60),
          cwd: '(project ' + hash.slice(0, 10) + ')',
          tsFirst: meta.startTime || null, tsLast: meta.lastUpdated || null,
          msgCount: records.filter((r) => r.type === 'user' || r.type === 'gemini').length,
          toolCalls: records.reduce((n, r) => n + ((r.toolCalls && r.toolCalls.length) || 0), 0),
          size: fs.statSync(path.join(chats, f)).size, kind: meta.kind,
        });
      } catch { }
    }
  }
  out.sort((a, b) => String(b.tsLast || '').localeCompare(String(a.tsLast || '')));
  return out;
}

function legacyParse(file) {
  const o = safeParse(fs.readFileSync(file, 'utf8'), {}) || {};
  const meta = { sessionId: o.sessionId || path.basename(file, '.json'), startTime: o.startTime, lastUpdated: o.lastUpdated, summary: o.summary || null, kind: 'main' };
  const records = Array.isArray(o.messages) ? o.messages : [];
  return { meta, records, loss: [] };
}

async function readSession(sessionId, baseDir) {
  // 定位文件
  let target = null;
  const root = geminiRoot(baseDir);
  if (fs.existsSync(root)) {
    for (const hash of fs.readdirSync(root)) {
      const chats = path.join(root, hash, 'chats');
      if (!fs.existsSync(chats)) continue;
      for (const f of fs.readdirSync(chats)) {
        if (!f.endsWith('.jsonl') && !f.endsWith('.json')) continue;
        try {
          const { meta } = f.endsWith('.jsonl') ? parseFile(path.join(chats, f)) : legacyParse(path.join(chats, f));
          if (meta.sessionId === sessionId || f.includes(sessionId)) { target = path.join(chats, f); break; }
        } catch { }
      }
      if (target) break;
    }
  }
  if (!target) throw new Error(`Gemini 会话不存在: ${sessionId}`);
  const { meta, records, loss } = target.endsWith('.jsonl') ? parseFile(target) : legacyParse(target);
  const entries = [];
  const compactions = [];
  for (const r of records) {
    const ts = r.timestamp || null;
    if (r.type === 'user' || r.type === 'gemini') {
      const blocks = [];
      const txt = contentText(r.content, r.displayContent);
      if (txt) blocks.push({ type: 'text', text: txt });
      for (const th of r.thoughts || []) {
        blocks.push({ type: 'thinking', text: (th.subject ? th.subject + '\n' : '') + (th.description || '') });
      }
      if (blocks.length) entries.push({ id: r.id || 'r' + entries.length, ts, role: r.type === 'user' ? 'user' : 'assistant', kind: 'text', blocks, meta: { model: r.model || null } });
      for (const tc of r.toolCalls || []) {
        entries.push({ id: (r.id || 'r') + '_tc_' + tc.id, ts, role: 'assistant', kind: 'text', blocks: [{ type: 'tool_use', id: tc.id, name: tc.name || 'tool', input: tc.args ?? {} }], meta: {} });
        entries.push({ id: (r.id || 'r') + '_tr_' + tc.id, ts, role: 'user', kind: 'tool-result', blocks: [{ type: 'tool_result', for: tc.id, output: typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result ?? ''), isError: tc.status === 'error' }], meta: {} });
      }
    } else if (r.type === 'info' || r.type === 'error' || r.type === 'warning') {
      entries.push({ id: r.id || 'r' + entries.length, ts, role: 'meta', kind: 'note', blocks: [{ type: 'text', text: `[${r.type}] ${contentText(r.content)}` }], meta: {} });
    }
  }
  const stats = { entries: entries.length, userTurns: 0, assistantEntries: 0, toolCalls: 0, toolResults: 0, thinking: 0, approxTokens: 0, recordedTokens: null };
  for (const e of entries) {
    if (e.role === 'user' && e.kind === 'text') stats.userTurns++;
    if (e.role === 'assistant') stats.assistantEntries++;
    for (const b of e.blocks) {
      if (b.type === 'tool_use') stats.toolCalls++;
      if (b.type === 'tool_result') stats.toolResults++;
      if (b.type === 'thinking') stats.thinking++;
      stats.approxTokens += Math.ceil((b.text || '').length / 3.5);
    }
  }
  const firstUser = entries.find((e) => e.role === 'user' && e.kind === 'text');
  return {
    arx: 1, id: randomUUIDSafe(), created_at: nowISO(),
    source: { agent: 'gemini', agent_version: null, session_id: meta.sessionId || sessionId, title: meta.summary || (firstUser ? truncateStr(firstUser.blocks[0].text, 60) : '(无标题)'), file: target },
    project: { cwd: null },
    env: { model: null, provider: 'google', cli_version: null },
    stats, entries, compactions, loss: [...new Set(loss)],
    _fileStat: { size: fs.statSync(target).size, mtimeMs: fs.statSync(target).mtimeMs },
  };
}
function randomUUIDSafe() { return require('crypto').randomUUID(); }

function doctor(baseDir) {
  const p = geminiRoot(baseDir);
  const ok = fs.existsSync(p);
  return { agent: 'gemini', ok, storage: p, sessionFiles: ok ? listSessions(baseDir).length : 0 };
}

module.exports = { listSessions, readSession, doctor, geminiRoot };
