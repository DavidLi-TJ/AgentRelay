'use strict';
// Gemini CLI 适配器（google-gemini/gemini-cli）—— 🧪 实验性（schema 来自官方源码 chatRecordingService.ts，本机未安装）
// baseDir = 自定义数据目录；null = 默认 ~/.gemini。会话: tmp/<projectHash>/chats/session-*.jsonl（旧版 .json）
// 行 1 = 元数据 {sessionId, projectHash, startTime, lastUpdated, summary?, kind: main|subagent}
// 消息行 MessageRecord {id, timestamp, type: user|gemini|info|error|warning, content, displayContent?, toolCalls?, thoughts?, tokens?, model?}
// 特殊行 {$rewindTo} / {$patch} / {$set} —— 解析时跳过并记 loss
// T1 写入 / T0 复制：resume 直接扫描 chats 目录，外部生成的 jsonl 放对 slug 即被列出（社区已验证）。
// slug 解析：优先扫 tmp/*/.project_root 匹配 cwd，其次 projects.json 映射，兜底 sha256(cwd)。
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

// ---------- T1 写入 / T0 复制 ----------
const crypto = require('crypto');
const { ensureDir, openJsonlWriter } = require('./util');

function normKey(p) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
}

// cwd → project slug：① 已有 slug 目录的 .project_root 与 cwd 匹配则复用；② projects.json 映射；③ sha256(cwd) 兜底
function slugFor(cwd, baseDir) {
  const key = normKey(cwd);
  const root = geminiRoot(baseDir);
  if (fs.existsSync(root)) {
    for (const hash of fs.readdirSync(root)) {
      try {
        const prFile = path.join(root, hash, '.project_root');
        if (fs.existsSync(prFile) && normKey(fs.readFileSync(prFile, 'utf8')) === key) return hash;
      } catch { }
    }
  }
  try {
    const pj = safeParse(fs.readFileSync(path.join(path.dirname(root), 'projects.json'), 'utf8'), null);
    if (pj && typeof pj === 'object') {
      for (const [k, v] of Object.entries(pj)) {
        if (normKey(k) === key) {
          const slug = typeof v === 'string' ? v : (v && v.slug);
          if (slug) return slug;
        }
      }
    }
  } catch { }
  return crypto.createHash('sha256').update(String(path.resolve(cwd))).digest('hex');
}

function outText(output) {
  return typeof output === 'string' ? output : JSON.stringify(output ?? '');
}

function geminiRecordFromEntries(entries, loss) {
  // 结果配对表：tool_use → {text, isError}（gemini 把结果内联在 toolCalls[].result）
  const resultFor = new Map();
  for (const e of entries) for (const b of e.blocks || []) {
    if (b.type === 'tool_result' && b.for) resultFor.set(b.for, { text: outText(b.output), isError: !!b.isError });
  }
  let imageLoss = false, metaSeen = false, errStatus = 0;
  const records = [];
  for (const e of entries) {
    const ts = e.ts || new Date().toISOString();
    for (const b of e.blocks || []) if (b.type === 'image') imageLoss = true; // 用户/助手/元条目里的图片都记损
    if (e.role === 'user' && e.kind === 'text') {
      const txt = (e.blocks || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
      if (txt.trim()) records.push({ id: e.id, timestamp: ts, type: 'user', content: txt });
      continue;
    }
    if (e.role === 'meta' || e.role === 'system') {
      const txt = (e.blocks || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
      if (txt.trim()) { metaSeen = true; records.push({ id: e.id, timestamp: ts, type: 'info', content: txt }); }
      continue;
    }
    if (e.role !== 'assistant' && e.kind !== 'tool-result') continue;
    if (e.kind === 'tool-result') continue; // 结果已并入 toolCalls[].result
    const content = (e.blocks || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
    const thoughts = (e.blocks || []).filter((b) => b.type === 'thinking').map((b) => ({ subject: '', description: b.text || '', timestamp: ts }));
    const toolCalls = (e.blocks || []).filter((b) => b.type === 'tool_use').map((b) => {
      const r = resultFor.get(b.id);
      if (!r || r.isError) errStatus++; // 结果缺失同样写 error 状态，计数要一致
      return {
        id: (b.name || 'tool') + '__' + String(b.id || Math.random().toString(36).slice(2, 8)),
        name: b.name || 'tool', args: b.input ?? {},
        result: r ? r.text : '',
        status: r ? (r.isError ? 'error' : 'success') : 'error',
        timestamp: ts, displayName: b.name || 'tool', description: '',
      };
    });
    if (!content && !thoughts.length && !toolCalls.length) continue;
    const rec = { id: e.id, timestamp: ts, type: 'gemini', content };
    if (thoughts.length) rec.thoughts = thoughts;
    if (toolCalls.length) rec.toolCalls = toolCalls;
    records.push(rec);
  }
  if (imageLoss) loss.push('Gemini: 图片块需要 inlineData 原始数据，注入时已省略');
  if (metaSeen) loss.push('Gemini: [meta] 条目转为 type:info 记录');
  if (errStatus) loss.push(`Gemini: ${errStatus} 个工具调用以 error 状态写入（源标记为失败或结果缺失）`);
  return records;
}

// T1：把 ARX 会话写成 Gemini 原生 session-*.jsonl（resume 直接可见）
async function writeSession(msx, { cwd, baseDir } = {}) {
  const loss = [...(msx.loss || [])]; // 继承上游（编辑器/读取器）已记录的说明
  const entries = msx.entries || [];
  if (!entries.length) throw new Error('没有可写入的内容条目（过滤条件排除了全部内容）');
  if (!cwd) throw new Error('Gemini T1 注入需要目标项目 cwd');
  const newId = crypto.randomUUID();
  const slug = slugFor(cwd, baseDir);
  const projDir = path.join(geminiRoot(baseDir), slug);
  const prFile = path.join(projDir, '.project_root');
  const slugKnown = fs.existsSync(prFile); // 是否复用了已存在的项目映射
  if (!slugKnown) {
    ensureDir(projDir);
    fs.writeFileSync(prFile, path.resolve(cwd), 'utf8');
  }
  const chats = ensureDir(path.join(projDir, 'chats'));
  const start = new Date();
  const stamp = start.toISOString().slice(0, 16).replace(/[:.]/g, '-') + 'Z'; // YYYY-MM-DDTHH-MM(Z)
  const file = path.join(chats, `session-${stamp}-${newId.slice(0, 8)}.jsonl`);
  const meta = {
    sessionId: newId, projectHash: slug,
    startTime: start.toISOString(), lastUpdated: new Date().toISOString(),
    kind: 'main', summary: (msx.source && msx.source.title) || null,
  };
  const records = geminiRecordFromEntries(entries, loss);
  const w = openJsonlWriter(file);
  w.write(meta);
  for (const r of records) w.write(r);
  await w.close();
  loss.push(`projectHash=${slug.slice(0, 12)}…（${slugKnown ? '复用已有项目映射' : '按 sha256(cwd) 新建'}）；若 /resume 列表看不到，先在目标目录运行一次 gemini 再试`);
  loss.push('Gemini 默认 sessionRetention.maxAge=30d 会自动清理旧会话，注入后请尽快 resume 一次');
  return { id: newId, path: file, count: records.length, loss, resumeCommand: `gemini（在 ${cwd} 启动）→ /resume 选择「${(msx.source && msx.source.title) || newId.slice(0, 8)}」` };
}

// T0：同源原生复制（gemini 会话为纯文件，替换 meta 行 sessionId + 文件名即可）
function rawCopy(sessionId, { baseDir } = {}) {
  const target = findFile(sessionId, baseDir);
  if (!target) throw new Error(`Gemini 会话不存在: ${sessionId}`);
  const { meta, records } = target.endsWith('.jsonl') ? parseFile(target) : legacyParse(target);
  const newId = crypto.randomUUID();
  const text = fs.readFileSync(target, 'utf8');
  const replaced = meta.sessionId ? text.split(meta.sessionId).join(newId) : text;
  const newFile = path.join(path.dirname(target), `session-${new Date().toISOString().slice(0, 16).replace(/[:.]/g, '-')}-${newId.slice(0, 8)}.jsonl`);
  require('./util').writeAtomic(newFile, replaced);
  return { id: newId, path: newFile, count: records.length, loss: ['T0 逐字复制：内容原样保留（仅替换会话 id）'] };
}

function findFile(sessionId, baseDir) {
  const root = geminiRoot(baseDir);
  if (!fs.existsSync(root)) return null;
  for (const hash of fs.readdirSync(root)) {
    const chats = path.join(root, hash, 'chats');
    if (!fs.existsSync(chats)) continue;
    for (const f of fs.readdirSync(chats)) {
      if (!f.endsWith('.jsonl') && !f.endsWith('.json')) continue;
      try {
        const { meta } = f.endsWith('.jsonl') ? parseFile(path.join(chats, f)) : legacyParse(path.join(chats, f));
        if (meta.sessionId === sessionId || f.includes(sessionId)) return path.join(chats, f);
      } catch { }
    }
  }
  return null;
}

module.exports = { listSessions, readSession, doctor, geminiRoot, writeSession, rawCopy, slugFor, findFile };
