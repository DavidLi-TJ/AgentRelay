'use strict';
// Codex CLI 会话适配器：rollout jsonl 读写 + state_5.sqlite threads 注册 + session_index.jsonl
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  HOME, ensureDir, readJsonl, streamJsonl, readJsonlPartial, writeJsonl, openJsonlWriter, nowISO, randomUUID, isoToMs, msToISO,
  truncateStr, deepReplaceStrings, safeParse,
} = require('./util');

// baseDir = 用户自定义数据目录（等价 CODEX_HOME）；null = 默认 ~/.codex
const codexHome = (baseDir) => baseDir || path.join(HOME, '.codex');
const sessionsRoot = (baseDir) => path.join(codexHome(baseDir), 'sessions');

function uuidV7Like() {
  // Codex id 风格（uuidv7）：毫秒时间戳前 48bit + 随机
  const ts = Date.now();
  const bytes = crypto.randomBytes(16);
  bytes[0] = (ts / 2 ** 40) & 0xff; bytes[1] = (ts / 2 ** 32) & 0xff; bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff; bytes[4] = (ts / 2 ** 8) & 0xff; bytes[5] = ts & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const ENV_PREFIXES = ['<user_instructions>', '<environment_context>', '<permissions instructions>', '<turn_context>', '<ENVIRONMENT', '<INSTRUCTIONS>', '# AGENTS.md instructions'];
function isEnvText(t) { return typeof t === 'string' && ENV_PREFIXES.some((p) => t.startsWith(p)); }

function listSessions(baseDir) {
  const root = sessionsRoot(baseDir);
  const files = [];
  if (fs.existsSync(root)) {
    walk(root, files);
  }
  const arch = path.join(codexHome(baseDir), 'archived_sessions');
  if (fs.existsSync(arch)) for (const f of fs.readdirSync(arch)) if (f.endsWith('.jsonl')) files.push(path.join(arch, f));
  const out = [];
  for (const f of files) {
    try { out.push(scanFile(f)); } catch { /* skip */ }
  }
  out.sort((a, b) => (b.tsLast || '').localeCompare(a.tsLast || ''));
  return out;
}

function walk(dir, files) {
  if (!fs.existsSync(dir)) return files;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, files);
    else if (e.name.endsWith('.jsonl')) files.push(p);
  }
  return files;
}

const _scanCache = new Map(); // file → { mtimeMs, size, info }
function scanFile(file) {
  const stat = fs.statSync(file);
  const hit = _scanCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.info;
  const big = stat.size > 30 * 1024 * 1024;
  const lines = big ? readJsonlPartial(file) : readJsonl(file, { maxLines: 200000 });
  const info = {
    id: null, file, agent: 'codex', title: '', firstUserText: '', cwd: '', version: null,
    tsFirst: null, tsLast: null, msgCount: 0, toolCalls: 0, size: stat.size, archived: file.includes('archived_sessions'),
  };
  for (const o of lines) {
    if (o.type === 'session_meta' && o.payload) {
      info.id = o.payload.session_id || o.payload.id;
      info.cwd = o.payload.cwd || '';
      info.version = o.payload.cli_version || null;
      if (!info.tsFirst) info.tsFirst = o.payload.timestamp || o.timestamp;
    }
    if (o.timestamp) { if (!info.tsFirst) info.tsFirst = o.timestamp; info.tsLast = o.timestamp; }
    const p = o.payload;
    if (o.type === 'response_item' && p && p.type === 'message') {
      if (p.role === 'user' && !info.firstUserText) {
        for (const c of p.content || []) {
          if (c.type === 'input_text' && c.text && !isEnvText(c.text)) { info.firstUserText = c.text; break; }
        }
      }
      if (p.role === 'user' || p.role === 'assistant') info.msgCount++;
    }
    if (o.type === 'response_item' && p && (p.type === 'function_call' || p.type === 'custom_tool_call')) info.toolCalls++;
  }
  // 从文件名兜底时间戳
  const m = path.basename(file).match(/rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (m && !info.tsFirst) info.tsFirst = `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`;
  info.title = truncateStr((info.firstUserText || '(无标题)').replace(/\s+/g, ' ').trim(), 60);
  _scanCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, info });
  return info;
}

async function readSession(sessionIdOrFile, baseDir) {
  let file = sessionIdOrFile;
  if (!fs.existsSync(file)) file = findFile(sessionIdOrFile, baseDir);
  const entries = [];
  const compactions = [];
  const loss = [];
  let meta = null, envModel = null, provider = null, cliVersion = null, cwd = '', recordedTokens = 0;
  let encryptedReasoningNote = false;
  let customToolNote = false;
  await streamJsonl(file, (o) => {
    const ts = o.timestamp;
    const p = o.payload || {};
    if (o.type === 'session_meta') {
      meta = p; cwd = p.cwd || cwd; provider = p.model_provider || provider; cliVersion = p.cli_version || cliVersion;
      return;
    }
    if (o.type === 'turn_context') return;
    if (o.type === 'event_msg') {
      if (p.type === 'thread_settings_applied' && p.thread_settings) envModel = p.thread_settings.model || envModel;
      if (p.type === 'token_count' && p.info && p.info.total_token_usage) {
        recordedTokens = (p.info.total_token_usage.input_tokens || 0) + (p.info.total_token_usage.output_tokens || 0);
      }
      return;
    }
    if (o.type === 'compacted') {
      compactions.push({ ts, message: p.message || '' });
      entries.push({ id: 'comp_' + o.ordinal, ts, role: 'meta', kind: 'compaction', blocks: [{ type: 'text', text: p.message || '' }], meta: {} });
      return;
    }
    if (o.type === 'token_usage_record' && p.usage) {
      recordedTokens = (p.usage.input_tokens || 0) + (p.usage.output_tokens || 0);
      return;
    }
    if (o.type !== 'response_item') return; // world_state / inter_agent_* 等环境行跳过
    if (p.type === 'message') {
      const texts = [];
      for (const c of p.content || []) {
        if (c.type === 'input_text' || c.type === 'output_text') texts.push(c.text || '');
      }
      if (!texts.length) return;
      if (p.role === 'user') {
        const envMsg = texts.every(isEnvText);
        entries.push({ id: 'e' + o.ordinal, ts, role: envMsg ? 'meta' : 'user', kind: envMsg ? 'note' : 'text', blocks: texts.map((t) => ({ type: 'text', text: t })), meta: {} });
      } else if (p.role === 'assistant') {
        entries.push({ id: 'e' + o.ordinal, ts, role: 'assistant', kind: 'text', blocks: texts.map((t) => ({ type: 'text', text: t })), meta: {} });
      } else if (p.role === 'developer') {
        entries.push({ id: 'e' + o.ordinal, ts, role: 'meta', kind: 'note', blocks: [{ type: 'text', text: texts.join('\n') }], meta: { subtype: 'developer' } });
      }
    } else if (p.type === 'reasoning') {
      const sum = (p.summary || []).map((s) => s.text || '').filter(Boolean).join('\n');
      const text = sum || '[加密思考内容（OpenAI encrypted_content，跨厂商不可迁移）]';
      if (!sum && !encryptedReasoningNote) { loss.push('Codex encrypted_content 思考不可跨厂商迁移，已以占位文本保留位置'); encryptedReasoningNote = true; }
      entries.push({ id: 'e' + o.ordinal, ts, role: 'assistant', kind: 'text', blocks: [{ type: 'thinking', text, signed: true }], meta: {} });
    } else if (p.type === 'function_call') {
      entries.push({ id: 'e' + o.ordinal, ts, role: 'assistant', kind: 'text', blocks: [{ type: 'tool_use', id: p.call_id, name: p.name, input: safeParse(p.arguments, { raw: p.arguments }) }], meta: {} });
    } else if (p.type === 'function_call_output') {
      entries.push({ id: 'e' + o.ordinal, ts, role: 'user', kind: 'tool-result', blocks: [{ type: 'tool_result', for: p.call_id, output: typeof p.output === 'string' ? p.output : JSON.stringify(p.output) }], meta: {} });
    } else if (p.type === 'custom_tool_call') {
      if (!customToolNote) { loss.push('Codex custom_tool_call（如 apply_patch）以通用工具调用形式迁移，原生类型标记不保留'); customToolNote = true; }
      entries.push({ id: 'e' + o.ordinal, ts, role: 'assistant', kind: 'text', blocks: [{ type: 'tool_use', id: p.call_id, name: p.name || 'custom_tool', input: { input: p.input } }], meta: {} });
    } else if (p.type === 'custom_tool_call_output') {
      entries.push({ id: 'e' + o.ordinal, ts, role: 'user', kind: 'tool-result', blocks: [{ type: 'tool_result', for: p.call_id, output: typeof p.output === 'string' ? p.output : JSON.stringify(p.output) }], meta: {} });
    } else if (p.type === 'web_search_call') {
      entries.push({ id: 'e' + o.ordinal, ts, role: 'assistant', kind: 'text', blocks: [{ type: 'tool_use', id: p.call_id || ('call_' + o.ordinal), name: 'web_search', input: p.action || {} }], meta: {} });
    } else if (p.type === 'tool_search_call') {
      entries.push({ id: 'e' + o.ordinal, ts, role: 'assistant', kind: 'text', blocks: [{ type: 'tool_use', id: p.call_id, name: 'tool_search', input: p.arguments || {} }], meta: {} });
    } else if (p.type === 'tool_search_output') {
      entries.push({ id: 'e' + o.ordinal, ts, role: 'user', kind: 'tool-result', blocks: [{ type: 'tool_result', for: p.call_id, output: JSON.stringify(p.tools || []) }], meta: {} });
    } else if (p.type === 'agent_message') {
      entries.push({ id: 'e' + o.ordinal, ts, role: 'meta', kind: 'note', blocks: [{ type: 'text', text: (p.content || []).map((c) => c.text || '').join('\n') }], meta: { subtype: `agent_message ${p.author || ''}→${p.recipient || ''}` } });
    }
  });
  const stats = { entries: entries.length, userTurns: 0, assistantEntries: 0, toolCalls: 0, toolResults: 0, thinking: 0, approxTokens: 0, recordedTokens };
  for (const e of entries) {
    if (e.role === 'user' && e.kind === 'text') stats.userTurns++;
    if (e.role === 'assistant') stats.assistantEntries++;
    stats.approxTokens += estimateTokensOf(e);
    for (const b of e.blocks) {
      if (b.type === 'tool_use') stats.toolCalls++;
      if (b.type === 'tool_result') stats.toolResults++;
      if (b.type === 'thinking') stats.thinking++;
    }
  }
  const firstUser = entries.find((e) => e.role === 'user' && e.kind === 'text');
  const title = truncateStr(((firstUser && firstUser.blocks[0] && firstUser.blocks[0].text) || '(无标题)').replace(/\s+/g, ' '), 60);
  return {
    arx: 1, id: randomUUID(), created_at: nowISO(),
    source: { agent: 'codex', agent_version: cliVersion, session_id: (meta && (meta.session_id || meta.id)) || path.basename(file, '.jsonl'), title, file },
    project: { cwd },
    env: { model: envModel, provider, cli_version: cliVersion, instructions: meta && meta.base_instructions ? (meta.base_instructions.text || '').slice(0, 65536) : null },
    stats, entries, compactions, loss,
    _fileStat: { size: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs },
  };
}

function estimateTokensOf(e) {
  let n = 0;
  for (const b of e.blocks) {
    const t = b.type === 'text' || b.type === 'thinking' ? (b.text || '') : JSON.stringify(b.input ?? b.output ?? '');
    n += Math.ceil(t.length / 3.5);
  }
  return n;
}

function findFile(sessionIdOrFile, baseDir) {
  if (!sessionIdOrFile) throw new Error('Codex 会话 id 不能为空');
  // 1) threads 表直查（快，免扫描）
  try {
    const db = new DatabaseSync(path.join(codexHome(baseDir), 'state_5.sqlite'));
    try {
      const r = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(sessionIdOrFile);
      if (r && r.rollout_path && fs.existsSync(r.rollout_path)) return r.rollout_path;
    } finally { db.close(); }
  } catch { }
  // 2) 文件名匹配
  const files = [];
  walk(sessionsRoot(baseDir), files);
  const arch = path.join(codexHome(baseDir), 'archived_sessions');
  if (fs.existsSync(arch)) for (const f of fs.readdirSync(arch)) if (f.endsWith('.jsonl')) files.push(path.join(arch, f));
  for (const f of files) if (path.basename(f).includes(sessionIdOrFile)) return f;
  // 3) 扫头部 session_meta（部分读取，大文件安全）
  for (const f of files) {
    try {
      const head = readJsonlPartial(f, 1024 * 1024);
      for (const o of head) if (o.type === 'session_meta' && (o.payload.session_id === sessionIdOrFile || o.payload.id === sessionIdOrFile)) return f;
    } catch { }
  }
  throw new Error(`Codex 会话不存在: ${sessionIdOrFile}`);
}

// ---------- 模板（取最新真实 rollout 的环境载荷，保证 resume 兼容） ----------
const _templateCache = new Map(); // codexHome → template
function getTemplate(baseDir) {
  const key = codexHome(baseDir);
  if (_templateCache.has(key)) return _templateCache.get(key);
  const files = [];
  walk(sessionsRoot(baseDir), files);
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const tpl = { meta: null, turnContext: null, settings: null, model: null, provider: null, sourceFile: null };
  for (const f of files) {
    try {
      for (const o of readJsonl(f, { maxLines: 40 })) {
        if (o.type === 'session_meta' && !tpl.meta) tpl.meta = o.payload;
        if (o.type === 'turn_context' && !tpl.turnContext) tpl.turnContext = o.payload;
        if (o.type === 'event_msg' && o.payload && o.payload.type === 'thread_settings_applied' && !tpl.settings) tpl.settings = o.payload;
      }
      if (tpl.meta) { tpl.sourceFile = f; break; }
    } catch { }
  }
  _templateCache.set(key, tpl);
  return tpl;
}

function readModelProviderFromConfig(baseDir) {
  try {
    const cfg = fs.readFileSync(path.join(codexHome(baseDir), 'config.toml'), 'utf8');
    const m = cfg.match(/^\s*model_provider\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch { return null; }
}

// ---------- 写入 ----------
function writeSession(msx, { cwd, newId, baseDir } = {}) {
  cwd = cwd || msx.project?.cwd;
  if (!cwd) throw new Error('缺少目标项目 cwd');
  const tpl = getTemplate(baseDir);
  if (!tpl.meta) throw new Error('找不到任何真实 Codex rollout 作为模板（sessions 目录为空?）');
  const id = newId || uuidV7Like();
  const now = Date.now();
  const startTs = (msx.entries && msx.entries[0] && msx.entries[0].ts) || nowISO();
  const startMs = isoToMs(startTs);
  const d = new Date(startMs);
  const dir = path.join(sessionsRoot(baseDir), String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  ensureDir(dir);
  const fnameTs = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}-${String(d.getSeconds()).padStart(2, '0')}`;
  const file = path.join(dir, `rollout-${fnameTs}-${id}.jsonl`);
  const provider = readModelProviderFromConfig(baseDir) || tpl.meta.model_provider || 'openai';

  const loss = [...(msx.loss || [])];
  const lines = [];
  let ordinal = 0;
  const push = (type, payload, ts) => {
    lines.push({ timestamp: ts || nowISO(), ordinal: ordinal++, type, payload });
  };
  push('session_meta', {
    ...tpl.meta,
    session_id: id, id, timestamp: new Date(startMs).toISOString(), cwd,
    originator: tpl.meta.originator || 'codex-tui', cli_version: tpl.meta.cli_version, source: 'cli',
    thread_source: 'user', model_provider: provider,
  }, new Date(startMs).toISOString());
  if (tpl.settings) {
    push('event_msg', { type: 'thread_settings_applied', thread_settings: { ...tpl.settings.thread_settings, model_provider_id: provider } });
  }
  let turnNo = 0;
  for (const e of msx.entries || []) {
    const ts = e.ts ? new Date(isoToMs(e.ts)).toISOString() : nowISO();
    if (e.kind === 'compaction') { loss.push('Codex 目标：跳过 compaction 标记'); continue; }
    if (e.role === 'meta' || e.role === 'system') { loss.push(`Codex 目标：跳过 1 条 ${e.role} 条目`); continue; }
    if (e.role === 'user' && e.kind === 'text') {
      const content = (e.blocks || []).filter((b) => b.type === 'text').map((b) => ({ type: 'input_text', text: b.text || '' }));
      if (!content.length) continue;
      turnNo++;
      push('turn_context', { ...tpl.turnContext, turn_id: uuidV7Like(), cwd, current_date: ts.slice(0, 10) }, ts);
      push('response_item', { type: 'message', role: 'user', content }, ts);
    } else if (e.kind === 'tool-result') {
      for (const b of e.blocks || []) {
        if (b.type !== 'tool_result') continue;
        push('response_item', { type: 'function_call_output', call_id: b.for, output: typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? '') }, ts);
      }
    } else if (e.role === 'assistant') {
      for (const b of e.blocks || []) {
        if (b.type === 'text') push('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: b.text || '' }] }, ts);
        else if (b.type === 'thinking') push('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: b.text || '' }], content: null }, ts);
        else if (b.type === 'tool_use') push('response_item', { type: 'function_call', name: b.name, arguments: JSON.stringify(b.input ?? {}), call_id: b.id || ('call_' + randomUUID().replace(/-/g, '').slice(0, 24)) }, ts);
        else if (b.type === 'image') loss.push('Codex 目标：跳过图片块');
      }
    }
  }
  if (lines.length <= 1) throw new Error('没有可写入的内容条目');
  writeJsonl(file, lines);
  return { id, path: file, loss, count: lines.length };
}

// ---------- 注册（threads 表 + session_index.jsonl） ----------
function registerThread({ id, rolloutPath, title, cwd, createdMs, modelProvider, cliVersion, firstUserMessage, preview, baseDir }) {
  const dbPath = path.join(codexHome(baseDir), 'state_5.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout=4000');
    const cols = db.prepare("PRAGMA table_info(threads)").all().map((c) => c.name);
    const tplRow = db.prepare("SELECT * FROM threads ORDER BY updated_at DESC LIMIT 1").get() || null;
    if (!cols.length) throw new Error('state_5.sqlite 缺少 threads 表');
    const row = {};
    for (const c of cols) row[c] = tplRow ? tplRow[c] : null;
    const nowSec = Math.floor(Date.now() / 1000);
    const set = (k, v) => { if (cols.includes(k)) row[k] = v; };
    set('id', id);
    set('rollout_path', rolloutPath);
    set('created_at', Math.floor((createdMs || Date.now()) / 1000));
    set('updated_at', nowSec);
    set('recency_at', nowSec);
    set('created_at_ms', createdMs || Date.now());
    set('updated_at_ms', Date.now());
    set('recency_at_ms', Date.now());
    set('source', 'cli');
    set('cwd', '\\\\?\\' + cwd);
    set('title', title || '');
    set('first_user_message', firstUserMessage || '');
    set('preview', (preview || firstUserMessage || '').slice(0, 200));
    set('tokens_used', 0);
    set('has_user_event', 1);
    set('archived', 0);
    set('archived_at', null);
    set('thread_source', 'user');
    set('model_provider', modelProvider || (tplRow && tplRow.model_provider) || 'openai');
    set('cli_version', cliVersion || (tplRow && tplRow.cli_version) || null);
    set('name', null);
    set('is_pinned', 0);
    set('time_deleted', null);
    if (cols.includes('project_id')) {
      let projId = null;
      try {
        const hasProjects = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get();
        if (hasProjects && tplRow && tplRow.project_id) {
          const pcols = db.prepare("PRAGMA table_info(projects)").all().map((c) => c.name);
          const tplProj = db.prepare('SELECT * FROM projects WHERE id = ?').get(tplRow.project_id);
          const cwdCol = pcols.find((c) => ['cwd', 'path', 'directory', 'root'].includes(c));
          const exist = cwdCol ? db.prepare(`SELECT id FROM projects WHERE ${cwdCol} = ?`).get('\\\\?\\' + cwd) || db.prepare(`SELECT id FROM projects WHERE ${cwdCol} = ?`).get(cwd) : null;
          if (exist) projId = exist.id;
          else if (tplProj) {
            const newRow = { ...tplProj };
            newRow.id = uuidV7Like();
            if (cwdCol) newRow[cwdCol] = '\\\\?\\' + cwd;
            const names = Object.keys(newRow).filter((k) => pcols.includes(k));
            db.prepare(`INSERT INTO projects (${names.map((n) => '"' + n + '"').join(',')}) VALUES (${names.map(() => '?').join(',')})`)
              .run(...names.map((n) => newRow[n]));
            projId = newRow.id;
          }
        }
      } catch { projId = null; }
      row.project_id = projId;
    }
    const names = Object.keys(row);
    db.prepare(`INSERT INTO threads (${names.map((n) => '"' + n + '"').join(',')}) VALUES (${names.map(() => '?').join(',')})`)
      .run(...names.map((n) => row[n]));
  } finally {
    db.close();
  }
  // session_index.jsonl 追加
  try {
    const idxPath = path.join(codexHome(baseDir), 'session_index.jsonl');
    fs.appendFileSync(idxPath, JSON.stringify({ id, thread_name: title || '', updated_at: new Date().toISOString() }) + '\n', 'utf8');
  } catch { /* 非致命 */ }
  return true;
}

function isThreadRegistered(id, baseDir) {
  try {
    const db = new DatabaseSync(path.join(codexHome(baseDir), 'state_5.sqlite'));
    try {
      const r = db.prepare('SELECT id, rollout_path, title FROM threads WHERE id = ?').get(id);
      return r || null;
    } finally { db.close(); }
  } catch { return null; }
}

// T0 原生复制：仅重写会话 id（流式逐行，绝不原地覆盖源文件）
async function rawCopy(sessionIdOrFile, { newId, baseDir } = {}) {
  const src = findFile(sessionIdOrFile, baseDir);
  const id = newId || uuidV7Like();
  // 规范化目标文件名：沿用源文件的时间戳部分；与源不同名，杜绝覆盖
  const base = path.basename(src);
  const m = base.match(/rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
  const ts = m ? m[1] : new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(path.dirname(src), `rollout-${ts}-${id}.jsonl`);
  if (path.resolve(dest) === path.resolve(src)) throw new Error('目标文件与源相同，拒绝写入');
  // 取旧 id（头部即可）
  const head = readJsonlPartial(src, 1024 * 1024);
  const metaLine = head.find((o) => o.type === 'session_meta');
  const oldId = (metaLine && metaLine.payload && (metaLine.payload.session_id || metaLine.payload.id)) ||
    (base.match(/([0-9a-f-]{36})\.jsonl$/i) || [])[1];
  const readline = require('readline');
  const rl = readline.createInterface({ input: fs.createReadStream(src, { encoding: 'utf8', highWaterMark: 4 * 1024 * 1024 }), crlfDelay: Infinity });
  const w = openJsonlWriter(dest);
  let count = 0;
  await new Promise((resolve, reject) => {
    rl.on('line', (line) => {
      const t = line.trim();
      if (!t) return;
      count++;
      w.writeRaw(oldId ? t.split(oldId).join(id) : t);
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
  await w.close();
  // 注册：优先复制源线程的注册行
  let registered = false;
  try {
    const db = new DatabaseSync(path.join(codexHome(baseDir), 'state_5.sqlite'));
    try {
      db.exec('PRAGMA busy_timeout=4000');
      const cols = db.prepare("PRAGMA table_info(threads)").all().map((c) => c.name);
      const old = oldId ? db.prepare('SELECT * FROM threads WHERE id = ?').get(oldId) : null;
      const tpl = old || db.prepare('SELECT * FROM threads ORDER BY updated_at DESC LIMIT 1').get();
      if (tpl) {
        const row = {};
        for (const c of cols) row[c] = tpl[c];
        const nowSec = Math.floor(Date.now() / 1000);
        const set = (k, v) => { if (cols.includes(k)) row[k] = v; };
        set('id', id); set('rollout_path', dest);
        set('created_at', nowSec); set('updated_at', nowSec); set('recency_at', nowSec);
        set('created_at_ms', Date.now()); set('updated_at_ms', Date.now()); set('recency_at_ms', Date.now());
        set('archived', 0); set('archived_at', null); set('tokens_used', 0);
        const names = Object.keys(row);
        db.prepare(`INSERT INTO threads (${names.map((n) => '"' + n + '"').join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((n) => row[n]));
        registered = true;
      }
    } finally { db.close(); }
  } catch { }
  try {
    const firstUser = head.find((o) => o.type === 'response_item' && o.payload && o.payload.type === 'message' && o.payload.role === 'user');
    const text = firstUser ? (firstUser.payload.content || []).map((c) => c.text || '').join('') : '';
    if (!registered) {
      registerThread({ id, rolloutPath: dest, title: truncateStr(text, 60), cwd: (metaLine && metaLine.payload && metaLine.payload.cwd) || '', createdMs: isoToMs((metaLine && metaLine.timestamp) || nowISO()), modelProvider: metaLine && metaLine.payload && metaLine.payload.model_provider, cliVersion: getTemplate(baseDir).meta && getTemplate(baseDir).meta.cli_version, firstUserMessage: text, preview: text, baseDir });
    }
    const idxPath = path.join(codexHome(baseDir), 'session_index.jsonl');
    fs.appendFileSync(idxPath, JSON.stringify({ id, thread_name: truncateStr(text, 60), updated_at: new Date().toISOString() }) + '\n', 'utf8');
  } catch { }
  return { id, path: dest, count };
}

function doctor(baseDir) {
  const root = sessionsRoot(baseDir);
  let fileArr = [];
  if (fs.existsSync(root)) { walk(root, fileArr); }
  const arch = path.join(codexHome(baseDir), 'archived_sessions');
  if (fs.existsSync(arch)) for (const f of fs.readdirSync(arch)) if (f.endsWith('.jsonl')) fileArr.push(path.join(arch, f));
  const files = fileArr.length;
  let threads = 0;
  try {
    const db = new DatabaseSync(path.join(codexHome(baseDir), 'state_5.sqlite'));
    try { threads = db.prepare('SELECT count(*) c FROM threads').get().c; } finally { db.close(); }
  } catch { }
  return { agent: 'codex', ok: fs.existsSync(root), storage: root, sessionFiles: files, registeredThreads: threads, modelProvider: readModelProviderFromConfig(baseDir) };
}

module.exports = { listSessions, readSession, writeSession, rawCopy, registerThread, isThreadRegistered, doctor, uuidV7Like, readModelProviderFromConfig, findFile };
