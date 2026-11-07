'use strict';
// OpenClaw 适配器 —— 已在真实客户端上验证（格式与 Pi v3 同构：OpenClaw 本身基于 pi）
// baseDir = 自定义目录；null = 默认 ~/.openclaw/agents/<agent>/sessions/*.jsonl（伴随 *.trajectory.jsonl 轨迹文件，非会话）
// 网关会在文本尾注入 "\n[message_id: ...]"，需剥除
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
      if (!f.endsWith('.jsonl') || f.endsWith('.trajectory.jsonl')) continue;
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
  // 项目路径：session header 行携带（Pi v3 同构），补进 ARX —— 否则 bundle 导出没有 cwd、跨设备重映射无从谈起
  const firstCwd = records[0] && records[0].cwd ? String(records[0].cwd) : null;
  const entries = [];
  const compactions = [];
  const loss = [];
  const env = { model: null, provider: null, cli_version: null };
  let recordedTokens = 0;
  for (const e of records) {
    if (e.type !== 'message') {
      if (e.type === 'session') { /* 元数据行：cwd/ts 已在上方提取，静默吸收 */ }
      else if (e.type === 'model_change') { if (!env.model && (e.modelId || e.model)) { env.model = e.modelId || e.model; env.provider = e.provider || null; } }
      else if (e.type === 'thinking_level_change') { /* 格式内部状态行，无需呈现 */ }
      else loss.push(`OpenClaw: 跳过 ${e.type} 条目`);
      continue;
    }
    const m = e.message || {};
    const ts = e.timestamp || null;
    if (m.role === 'user') {
      const blocks = blocksFromContent(m.content).filter((b) => b.type === 'text');
      if (blocks.length) entries.push({ id: e.id || 'e' + entries.length, ts, role: 'user', kind: 'text', blocks, meta: {} });
    } else if (m.role === 'assistant') {
      const blocks = blocksFromContent(m.content);
      if (blocks.length) entries.push({ id: e.id || 'e' + entries.length, ts, role: 'assistant', kind: 'text', blocks, meta: { model: m.model || null } });
      if (!env.model && m.model) env.model = m.model;
      if (m.usage && typeof m.usage === 'object') recordedTokens += (m.usage.input || 0) + (m.usage.output || 0) || (m.usage.totalTokens || 0);
    } else if (m.role === 'toolResult') {
      const c = typeof m.content === 'string' ? m.content : (m.content || []).map((b) => b.text || '').join('');
      entries.push({ id: e.id || 'e' + entries.length, ts, role: 'user', kind: 'tool-result', blocks: [{ type: 'tool_result', for: m.toolCallId || 'call', output: c, isError: !!m.isError }], meta: {} });
    }
  }
  const stats = { entries: entries.length, userTurns: 0, assistantEntries: 0, toolCalls: 0, toolResults: 0, thinking: 0, approxTokens: 0, recordedTokens };
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
    project: { cwd: firstCwd }, env,
    stats, entries, compactions, loss: [...new Set(loss)],
    _fileStat: { size: fs.statSync(target).size, mtimeMs: fs.statSync(target).mtimeMs },
  };
}

function doctor(baseDir) {
  const p = baseDir || AGENTS_DIR();
  const ok = fs.existsSync(p);
  return { agent: 'openclaw', ok, storage: p, sessionFiles: ok ? listSessions(baseDir).length : 0 };
}

// ---------- T1 写入 / T0 复制 ----------
const crypto = require('crypto');
const { ensureDir, openJsonlWriter, writeAtomic } = require('./util');

// 目标 agent 子目录：显式指定 > 最近活跃的既有 agent 目录 > 'main'
function pickAgentDir(baseDir) {
  const root = baseDir || AGENTS_DIR();
  let best = null, bestM = -1;
  try {
    for (const d of fs.readdirSync(root)) {
      const sdir = path.join(root, d, 'sessions');
      if (!fs.existsSync(sdir)) continue;
      const m = fs.statSync(sdir).mtimeMs;
      if (m > bestM) { bestM = m; best = d; }
    }
  } catch { }
  return best || 'main';
}

// ARX 条目 → OpenClaw message 行（Pi v3 同构：线性 parentId 链；text/thinking/toolCall 块 + toolResult role）
function openclawRecordsFrom(entries, loss) {
  const out = [];
  let prev = null;
  let imageLoss = false, metaSeen = false;
  const pushMsg = (id, ts, message) => {
    out.push({ type: 'message', id, parentId: prev, timestamp: ts, message });
    prev = id;
  };
  for (const e of entries) {
    const ts = e.ts || new Date().toISOString();
    for (const b of e.blocks || []) if (b.type === 'image') imageLoss = true; // 用户/助手/元条目里的图片都记损
    const rid = e.id || ('e' + out.length);
    if (e.role === 'user' && e.kind === 'text') {
      const content = (e.blocks || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
      if (content) pushMsg(rid, ts, { role: 'user', content });
      continue;
    }
    if (e.role === 'meta' || e.role === 'system') {
      const content = (e.blocks || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
      if (content) { metaSeen = true; pushMsg(rid, ts, { role: 'user', content: `[meta] ${content}` }); }
      continue;
    }
    if (e.kind === 'tool-result') {
      const b = (e.blocks || []).find((x) => x.type === 'tool_result');
      if (!b) continue;
      const outText = typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? '');
      pushMsg(rid, ts, { role: 'toolResult', toolCallId: b.for || 'call', content: [{ type: 'text', text: outText }], isError: !!b.isError });
      continue;
    }
    if (e.role !== 'assistant') continue;
    const content = [];
    for (const b of e.blocks || []) {
      if (b.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
      else if (b.type === 'thinking' && b.text) content.push({ type: 'thinking', thinking: b.text });
      else if (b.type === 'tool_use') content.push({ type: 'toolCall', id: b.id || 'call_' + crypto.randomBytes(4).toString('hex'), name: b.name || 'tool', arguments: b.input ?? {} });
      else if (b.type === 'image') imageLoss = true;
    }
    if (content.length) pushMsg(rid, ts, { role: 'assistant', content, model: (e.meta && e.meta.model) || undefined });
  }
  if (imageLoss) loss.push('OpenClaw: 图片块需要原始图像数据，注入时已省略');
  if (metaSeen) loss.push('OpenClaw: [meta] 条目转为带 [meta] 前缀的用户消息');
  return out;
}

// T1：写 <agents>/<agent>/sessions/<id>.jsonl（Pi v3 同构）：首行 session header（id/cwd/version），
// 其后 message 行带 parentId 线性链——真实 OpenClaw 的加载器按此结构解析
async function writeSession(msx, { cwd, baseDir, agentDir } = {}) {
  const loss = [...(msx.loss || [])]; // 继承上游（编辑器/读取器）已记录的说明
  const entries = msx.entries || [];
  if (!entries.length) throw new Error('没有可写入的内容条目（过滤条件排除了全部内容）');
  const newId = crypto.randomUUID();
  const projCwd = path.resolve(cwd || msx.project?.cwd || '.');
  const sdir = ensureDir(path.join(baseDir || AGENTS_DIR(), agentDir || pickAgentDir(baseDir), 'sessions'));
  const file = path.join(sdir, `${newId}.jsonl`);
  const records = openclawRecordsFrom(entries, loss);
  const w = openJsonlWriter(file);
  w.write({ type: 'session', version: 3, id: newId, timestamp: new Date().toISOString(), cwd: projCwd });
  for (const r of records) w.write(r);
  await w.close();
  return {
    id: newId, path: file, count: records.length, loss,
    resumeCommand: `OpenClaw agent「${agentDir || pickAgentDir(baseDir)}」会话列表选择「${(msx.source && msx.source.title) || newId.slice(0, 8)}」`,
  };
}

// T0：同源原生复制（替换首行会话 id + 文件名；其余字节原样）
function rawCopy(sessionId, { baseDir } = {}) {
  for (const s of listSessions(baseDir)) {
    if (s.id !== sessionId && !path.basename(s.file).includes(sessionId)) continue;
    const newId = crypto.randomUUID();
    const text = fs.readFileSync(s.file, 'utf8');
    const replaced = s.id ? text.split(s.id).join(newId) : text;
    const newFile = path.join(path.dirname(s.file), `${newId}.jsonl`);
    writeAtomic(newFile, replaced);
    return { id: newId, path: newFile, count: s.msgCount || 0, loss: ['T0 逐字复制：内容原样保留（仅替换会话 id）'] };
  }
  throw new Error(`OpenClaw 会话不存在: ${sessionId}`);
}

module.exports = { listSessions, readSession, doctor, blocksFromContent, writeSession, rawCopy, pickAgentDir };
