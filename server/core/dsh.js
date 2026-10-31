'use strict';
// DeepSeek Harness (dsh) 适配器 —— ✅ 本机真实数据验证（116 会话，zstd 多帧）
// baseDir = 自定义目录；null = 默认 ~/.dsh/sessions
// 布局: <root>/--<编码cwd>--/<sessionId>/session[.vN].jsonl[.zstd]
// .zstd = 多帧拼接（首帧=头），Node 单帧解压 → 需按魔数分帧
// 真实事件: user/message, assistant/message(content: reasoning|text|tool-call), tool/call, tool/result, session/title, compaction/summary
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { HOME, nowISO, truncateStr, safeParse } = require('./util');

const SESSIONS_ROOT = () => path.join(HOME, '.dsh', 'sessions');

function zstdDecompressAll(buf) {
  if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('需要 Node ≥ 23.8 / 24 的内置 zstd 支持');
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const frames = [];
  let start = buf.indexOf(magic);
  while (start !== -1) {
    const next = buf.indexOf(magic, start + 4);
    frames.push(buf.subarray(start, next === -1 ? buf.length : next));
    start = next;
  }
  return frames.map((f) => { try { return zlib.zstdDecompressSync(f); } catch { return Buffer.alloc(0); } })
    .map((b) => b.toString('utf8')).join('');
}

function decode(file) {
  const buf = fs.readFileSync(file);
  return file.endsWith('.zstd') ? zstdDecompressAll(buf) : buf.toString('utf8');
}

function findSessionFiles(baseDir) {
  const root = baseDir || SESSIONS_ROOT();
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const proj of fs.readdirSync(root)) {
    const pdir = path.join(root, proj);
    if (!fs.statSync(pdir).isDirectory()) continue;
    for (const sid of fs.readdirSync(pdir)) {
      const sdir = path.join(pdir, sid);
      if (!fs.statSync(sdir).isDirectory()) continue;
      const versions = fs.readdirSync(sdir).filter((f) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(f)).sort();
      if (versions.length) out.push({ id: sid, dir: sdir, file: path.join(sdir, versions[versions.length - 1]), proj });
    }
  }
  return out;
}

function parseDsh(text) {
  const header = { type: 'session', id: null, cwd: null, createdAt: null, version: 0, title: null };
  const events = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const o = safeParse(t);
    if (!o) continue;
    if (o.type === 'session') { Object.assign(header, { id: o.id, cwd: o.cwd, createdAt: o.createdAt, version: o.version }); continue; }
    if (o.type === 'session/title' && o.data && o.data.title) { header.title = o.data.title; continue; }
    events.push(o);
  }
  events.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  return { header, events };
}

function nestedText(content) {
  // tool/result 的 content: [{type:'tool-result', toolCallId, content:[{type:'text',text}]}]
  return (content || []).map((b) => {
    if (b.type === 'tool-result') return (b.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('');
    if (b.type === 'text') return b.text || '';
    return '';
  }).join('');
}

function listSessions(baseDir) {
  const out = [];
  for (const s of findSessionFiles(baseDir)) {
    try {
      const { header, events } = parseDsh(decode(s.file));
      const firstUser = events.find((e) => e.type === 'user/message');
      const titles = [header.title, ((firstUser && firstUser.data && firstUser.data.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('')];
      out.push({
        id: header.id || s.id, agent: 'dsh', file: s.file,
        title: truncateStr((titles.find(Boolean) || '(无标题)').replace(/\s+/g, ' ').trim(), 60),
        cwd: header.cwd || null,
        tsFirst: header.createdAt ? new Date(header.createdAt).toISOString() : null,
        tsLast: events.length ? new Date(events[events.length - 1].time || header.createdAt || Date.now()).toISOString() : null,
        msgCount: events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message').length,
        toolCalls: events.filter((e) => e.type === 'tool/call').length,
        size: fs.statSync(s.file).size, compressed: s.file.endsWith('.zstd'),
      });
    } catch { }
  }
  out.sort((a, b) => String(b.tsLast || '').localeCompare(String(a.tsLast || '')));
  return out;
}

async function readSession(sessionId, baseDir) {
  let target = null;
  for (const s of findSessionFiles(baseDir)) {
    if (s.id === sessionId || path.basename(s.dir) === sessionId) { target = s.file; break; }
  }
  if (!target) throw new Error(`DeepSeek Harness 会话不存在: ${sessionId}`);
  const { header, events } = parseDsh(decode(target));
  const entries = [];
  const loss = [];
  const compactions = [];
  for (const ev of events) {
    const ts = ev.time ? new Date(ev.time).toISOString() : null;
    const d = ev.data || {};
    if (ev.type === 'user/message') {
      const texts = (d.content || []).filter((b) => b.type === 'text').map((b) => ({ type: 'text', text: b.text || '' }));
      if (texts.length) entries.push({ id: d.id || 'u' + ev.seq, ts, role: 'user', kind: 'text', blocks: texts, meta: {} });
    } else if (ev.type === 'assistant/message') {
      const m = d.message || {};
      const blocks = [];
      for (const b of m.content || []) {
        if (b.type === 'text' && b.text) blocks.push({ type: 'text', text: b.text });
        else if (b.type === 'reasoning' && b.text) blocks.push({ type: 'thinking', text: b.text });
        // tool-call 块跳过：独立的 tool/call 事件承载调用与结果，避免重复
      }
      if (blocks.length) {
        const meta = { model: (m.source && m.source.model) || null };
        if (d.usage) meta.usage = d.usage;
        entries.push({ id: m.id || 'a' + ev.seq, ts, role: 'assistant', kind: 'text', blocks, meta });
      }
    } else if (ev.type === 'tool/call') {
      entries.push({ id: ev.data.callId || ('call_' + ev.seq), ts, role: 'assistant', kind: 'text', blocks: [{ type: 'tool_use', id: ev.data.callId, name: ev.data.name || 'tool', input: safeParse(ev.data.arguments, { raw: ev.data.arguments }) }], meta: {} });
    } else if (ev.type === 'tool/result') {
      const m = d.message || {};
      entries.push({ id: 'r' + ev.seq, ts, role: 'user', kind: 'tool-result', blocks: [{ type: 'tool_result', for: (m.source && m.source.callId) || (m.toolCallId || 'call'), output: nestedText(m.content), isError: !!m.isError }], meta: {} });
    } else if (ev.type === 'compaction/summary') {
      compactions.push({ ts, message: nestedText(d.summary) });
    }
    // assistant/chunk、reasoning-chunks、tool-call-chunks、text-chunks、turn/*、step/*、llm/* 等流式/边界事件跳过
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
    arx: 1, id: require('crypto').randomUUID(), created_at: nowISO(),
    source: { agent: 'dsh', agent_version: String(header.version || 0), session_id: header.id || sessionId, title: header.title || truncateStr(((firstUser || { blocks: [{ text: '(无标题)' }] }).blocks[0].text || '').slice(0, 60), 60), file: target },
    project: { cwd: header.cwd || null }, env: { model: null, provider: 'deepseek', cli_version: null },
    stats, entries, compactions, loss: [...new Set(loss)],
    _fileStat: { size: fs.statSync(target).size, mtimeMs: fs.statSync(target).mtimeMs },
  };
}

function doctor(baseDir) {
  const p = baseDir || SESSIONS_ROOT();
  const ok = fs.existsSync(p);
  return { agent: 'dsh', ok, storage: p, sessionFiles: ok ? findSessionFiles(baseDir).length : 0 };
}

module.exports = { listSessions, readSession, doctor, parseDsh, decode, zstdDecompressAll, nestedText };
