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

// 多帧 zstd 拼接解码。压缩字节里可能出现伪魔数导致按 4 字节魔数切错帧——解压失败时记入 sink（loss），
// 不再静默吞掉（审核 P3：不可见内容丢失）。
function zstdDecompressAll(buf, sink) {
  if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('需要 Node ≥ 23.8 / 24 的内置 zstd 支持');
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const frames = [];
  let start = buf.indexOf(magic);
  while (start !== -1) {
    const next = buf.indexOf(magic, start + 4);
    frames.push(buf.subarray(start, next === -1 ? buf.length : next));
    start = next;
  }
  let failed = 0;
  const out = frames.map((f) => {
    try { return zlib.zstdDecompressSync(f); } catch { failed++; return Buffer.alloc(0); }
  }).map((b) => b.toString('utf8')).join('');
  if (failed && Array.isArray(sink)) sink.push(`zstd: ${failed}/${frames.length} 帧解压失败（伪魔数或文件损坏），对应内容缺失`);
  return out;
}

function decode(file, sink) {
  const buf = fs.readFileSync(file);
  return file.endsWith('.zstd') ? zstdDecompressAll(buf, sink) : buf.toString('utf8');
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
  // 归一化：字符串型 content（summary/用户消息变体）按单条文本处理
  const arr = Array.isArray(content) ? content : (content == null ? [] : [{ type: 'text', text: String(content) }]);
  return arr.map((b) => {
    if (b.type === 'tool-result') return (Array.isArray(b.content) ? b.content : (b.content == null ? [] : [{ type: 'text', text: String(b.content) }])).filter((x) => x.type === 'text').map((x) => x.text).join('');
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
  const loss = [];
  const { header, events } = parseDsh(decode(target, loss));
  const entries = [];
  const compactions = [];
  for (const ev of events) {
    const ts = ev.time ? new Date(ev.time).toISOString() : null;
    const d = ev.data || {};
    if (ev.type === 'user/message') {
      const ucontent = Array.isArray(d.content) ? d.content : (d.content == null ? [] : [{ type: 'text', text: String(d.content) }]);
      const texts = ucontent.filter((b) => b.type === 'text').map((b) => ({ type: 'text', text: b.text || '' }));
      if (texts.length) entries.push({ id: d.id || 'u' + ev.seq, ts, role: 'user', kind: 'text', blocks: texts, meta: {} });
    } else if (ev.type === 'assistant/message') {
      const m = d.message || {};
      const blocks = [];
      const acontent = Array.isArray(m.content) ? m.content : (m.content == null ? [] : [{ type: 'text', text: String(m.content) }]);
      for (const b of acontent) {
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

// ---------- T1 写入 / T0 复制 ----------
const crypto = require('crypto');
const { ensureDir, writeAtomic } = require('./util');

function zstdCompress(text) {
  if (typeof zlib.zstdCompressSync !== 'function') throw new Error('需要 Node ≥ 23.8 / 24 的内置 zstd 支持（node:zlib.zstdCompressSync）');
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

// ARX 条目 → DSH 事件序列（seq 递增；与读取端 parseDsh 的类型一一对应）
function dshEventsFrom(entries, loss) {
  const events = [];
  let seq = 1;
  let imageLoss = false, metaSeen = false;
  const at = (ts) => ts || new Date().toISOString();
  for (const e of entries) {
    for (const b of e.blocks || []) if (b.type === 'image') imageLoss = true; // 用户/助手/元条目里的图片都记损
    if (e.role === 'user' && e.kind === 'text') {
      const content = (e.blocks || []).filter((b) => b.type === 'text').map((b) => ({ type: 'text', text: b.text || '' }));
      if (content.length) events.push({ seq: seq++, time: at(e.ts), type: 'user/message', data: { id: e.id, content } });
      continue;
    }
    if (e.role === 'meta' || e.role === 'system') {
      const txt = (e.blocks || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
      if (txt) { metaSeen = true; events.push({ seq: seq++, time: at(e.ts), type: 'user/message', data: { id: e.id, content: [{ type: 'text', text: '[meta] ' + txt }] } }); }
      continue;
    }
    if (e.kind === 'tool-result') {
      const b = (e.blocks || []).find((x) => x.type === 'tool_result');
      if (!b) continue;
      const outText = typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? '');
      events.push({
        seq: seq++, time: at(e.ts), type: 'tool/result',
        data: { message: { source: { callId: b.for || 'call' }, toolCallId: b.for || 'call', content: [{ type: 'tool-result', toolCallId: b.for || 'call', content: [{ type: 'text', text: outText }] }], isError: !!b.isError } },
      });
      continue;
    }
    if (e.role !== 'assistant') continue;
    const content = [];
    for (const b of e.blocks || []) {
      if (b.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
      else if (b.type === 'thinking' && b.text) content.push({ type: 'reasoning', text: b.text });
      else if (b.type === 'tool_use') events.push({ seq: seq++, time: at(e.ts), type: 'tool/call', data: { callId: b.id || 'call_' + seq, name: b.name || 'tool', arguments: JSON.stringify(b.input ?? {}) } });
      else if (b.type === 'image') imageLoss = true;
    }
    if (content.length) {
      const data = { id: e.id, message: { id: e.id, content, source: { model: (e.meta && e.meta.model) || undefined } } };
      if (e.meta && e.meta.usage) data.usage = e.meta.usage;
      events.push({ seq: seq++, time: at(e.ts), type: 'assistant/message', data });
    }
  }
  if (imageLoss) loss.push('DSH: 图片块需要原始图像数据，注入时已省略');
  if (metaSeen) loss.push('DSH: [meta] 条目转为用户消息');
  return events;
}

// T1：写 <root>/--<cwd编码>--/<sessionId>/session.jsonl.zstd（多帧拼接格式，这里单帧即可——解析端按魔数分帧）
async function writeSession(msx, { cwd, baseDir } = {}) {
  const loss = [...(msx.loss || [])]; // 继承上游（编辑器/读取器）已记录的说明
  const entries = msx.entries || [];
  if (!entries.length) throw new Error('没有可写入的内容条目（过滤条件排除了全部内容）');
  const projCwd = path.resolve(cwd || msx.project?.cwd || '.');
  const newId = crypto.randomUUID();
  const sdir = ensureDir(path.join(baseDir || SESSIONS_ROOT(), '--' + slugifyCwd(projCwd) + '--', newId));
  const file = path.join(sdir, 'session.jsonl.zstd');
  const createdAt = new Date().toISOString();
  const events = dshEventsFrom(entries, loss);
  const lines = [
    JSON.stringify({ type: 'session', id: newId, cwd: projCwd, createdAt, version: 1 }),
    JSON.stringify({ seq: 0, time: createdAt, type: 'session/title', data: { title: (msx.source && msx.source.title) || '(导入会话)' } }),
    ...events.map((e) => JSON.stringify(e)),
  ];
  writeAtomic(file, zstdCompress(lines.join('\n') + '\n'));
  return {
    id: newId, path: file, count: events.length, loss,
    resumeCommand: `dsh（在 ${projCwd} 启动）会话列表选择「${(msx.source && msx.source.title) || newId.slice(0, 8)}」`,
  };
}

function slugifyCwd(cwd) {
  return String(cwd || 'unknown').replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

// T0：同源原生复制（解压 → 替换会话 id → 重压缩为单帧；zstd 帧解压失败的内容无法保留，如实记 loss）
function rawCopy(sessionId, { baseDir } = {}) {
  for (const s of findSessionFiles(baseDir)) {
    if (s.id !== sessionId && path.basename(s.dir) !== sessionId) continue;
    const loss = [];
    const { header, events } = parseDsh(decode(s.file, loss));
    const newId = crypto.randomUUID();
    const text = fs.readFileSync(s.file);
    const isZ = s.file.endsWith('.zstd');
    const plain = isZ ? zstdDecompressAll(text, loss) : text.toString('utf8');
    const oldId = header.id || s.id;
    const replaced = oldId ? plain.split(oldId).join(newId) : plain;
    const sdir = ensureDir(path.join(path.dirname(path.dirname(s.file)), newId));
    const newFile = path.join(sdir, 'session.jsonl' + (isZ ? '.zstd' : ''));
    writeAtomic(newFile, isZ ? zstdCompress(replaced) : replaced);
    return { id: newId, path: newFile, count: events.length, loss: [...loss, 'T0 原生复制：内容原样保留（仅替换会话 id；zstd 多帧重压缩为单帧）'] };
  }
  throw new Error(`DeepSeek Harness 会话不存在: ${sessionId}`);
}

module.exports = { listSessions, readSession, doctor, parseDsh, decode, zstdDecompressAll, nestedText, writeSession, rawCopy, slugifyCwd };
