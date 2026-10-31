'use strict';
// OpenClaw 适配器 —— 🧪 实验性（格式与 Pi 同构，来源 cc-switch openclaw.rs；本机未安装）
// baseDir = 自定义目录；null = 默认 ~/.openclaw/agents/<agent>/sessions/*.jsonl
// 会话为顺序 JSONL（无树形分支）；网关会在文本尾注入 "\n[message_id: ...]"，需剥除
const fs = require('fs');
const path = require('path');
const { HOME, nowISO, truncateStr, safeParse } = require('./util');

const AGENTS_DIR = () => path.join(HOME, '.openclaw', 'agents');

function stripMessageIdSuffix(text) {
  return String(text || '').replace(/\n?\[message_id: [^\]]*\]\s*$/, '');
}

function parseJsonl(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const o = safeParse(t);
    if (o) out.push(o);
  }
  return out;
}

function blocksFromContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: stripMessageIdSuffix(content) }];
  const out = [];
  for (const b of content || []) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') out.push({ type: 'text', text: stripMessageIdSuffix(b.text || '') });
    else if (b.type === 'thinking') out.push({ type: 'thinking', text: b.thinking || b.text || '' });
    else if (b.type === 'toolCall') out.push({ type: 'tool_use', id: b.id || b.callID || ('call_' + Math.random().toString(36).slice(2, 10)), name: b.name || 'tool', input: safeParse(b.arguments, b.arguments ?? {}) });
  }
  return out;
}

function listSessions(baseDir) {
  const root = baseDir || AGENTS_DIR();
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const agentDir of fs.readdirSync(root)) {
    const sessDir = path.join(root, agentDir, 'sessions');
    if (!fs.existsSync(sessDir)) continue;
    for (const f of fs.readdirSync(sessDir)) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const records = parseJsonl(path.join(sessDir, f));
        const first = records[0] || {};
        const firstUser = records.find((e) => e.type === 'message' && e.message && e.message.role === 'user');
        out.push({
          id: first.id || path.basename(f, '.jsonl'), agent: 'openclaw', file: path.join(sessDir, f),
          title: truncateStr(((firstUser && blocksFromContent(firstUser.message.content)[0]) || {}).text || '(无标题)', 60),
          cwd: first.cwd || null, tsFirst: first.timestamp || null,
          tsLast: records.length ? (records[records.length - 1].timestamp || null) : null,
          msgCount: records.filter((e) => e.type === 'message').length, toolCalls: null,
          size: fs.statSync(path.join(sessDir, f)).size, agentDir: agentDir,
        });
      } catch { }
    }
  }
  return out;
}

async function readSession(sessionId, baseDir) {
  let target = null;
  for (const s of listSessions(baseDir)) {
    if (s.id === sessionId || path.basename(s.file).includes(sessionId)) { target = s.file; break; }
  }
  if (!target) throw new Error(`OpenClaw 会话不存在: ${sessionId}`);
  const records = parseJsonl(target);
  const entries = [];
  const compactions = [];
  const loss = [];
  for (const e of records) {
    if (e.type !== 'message') { loss.push(`OpenClaw: 跳过 ${e.type} 条目`); continue; }
    const m = e.message || {};
    const ts = e.timestamp || null;
    if (m.role === 'user') {
      const blocks = blocksFromContent(m.content).filter((b) => b.type === 'text');
      if (blocks.length) entries.push({ id: e.id || 'e' + entries.length, ts, role: 'user', kind: 'text', blocks, meta: {} });
    } else if (m.role === 'assistant') {
      const blocks = blocksFromContent(m.content);
      if (blocks.length) entries.push({ id: e.id || 'e' + entries.length, ts, role: 'assistant', kind: 'text', blocks, meta: { model: m.model || null } });
    } else if (m.role === 'toolResult') {
      const c = typeof m.content === 'string' ? m.content : (m.content || []).map((b) => b.text || '').join('');
      entries.push({ id: e.id || 'e' + entries.length, ts, role: 'user', kind: 'tool-result', blocks: [{ type: 'tool_result', for: m.toolCallId || 'call', output: c, isError: !!m.isError }], meta: {} });
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
  return {
    arx: 1, id: require('crypto').randomUUID(), created_at: nowISO(),
    source: { agent: 'openclaw', agent_version: null, session_id: sessionId, title: truncateStr(((entries.find((e) => e.role === 'user' && e.kind === 'text') || { blocks: [{ text: '(无标题)' }] }).blocks[0].text || '').slice(0, 60), 60), file: target },
    project: { cwd: null }, env: { model: null, provider: null, cli_version: null },
    stats, entries, compactions, loss: [...new Set(loss)],
    _fileStat: { size: fs.statSync(target).size, mtimeMs: fs.statSync(target).mtimeMs },
  };
}

function doctor(baseDir) {
  const p = baseDir || AGENTS_DIR();
  const ok = fs.existsSync(p);
  return { agent: 'openclaw', ok, storage: p, sessionFiles: ok ? listSessions(baseDir).length : 0 };
}

module.exports = { listSessions, readSession, doctor, blocksFromContent };
