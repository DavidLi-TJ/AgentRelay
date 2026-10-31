'use strict';
// Claude Code 会话适配器：读取 ~/.claude/projects/<slug>/<uuid>.jsonl 并合成同格式会话
const fs = require('fs');
const path = require('path');
const {
  HOME, ensureDir, readJsonl, writeJsonl, nowISO, randomUUID, msToISO, isoToMs,
  slugifyClaude, claudeDirFor, truncateStr, estimateTokens,
} = require('./util');

const CLAUDE_VERSION = '2.1.289'; // 本机当前版本，写入合成会话时使用
// baseDir = 用户自定义数据目录（等价 CLAUDE_CONFIG_DIR）；null = 默认 ~/.claude
const projectsRoot = (baseDir) => baseDir ? path.join(baseDir, 'projects') : path.join(HOME, '.claude', 'projects');

// 合成会话应记录"当前环境可用"的模型名，否则 resume 时会拿源会话的旧模型去请求当前代理而 400
let _cachedModel;
function currentClaudeModel(baseDir) {
  if (_cachedModel) return _cachedModel;
  try {
    const settingsPath = baseDir ? path.join(baseDir, 'settings.json') : path.join(HOME, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const envModel = settings.env && settings.env.ANTHROPIC_MODEL;
    if (envModel) { _cachedModel = envModel; return _cachedModel; }
    if (settings.model && settings.model !== 'sonnet' && settings.model !== 'opus' && settings.model !== 'haiku') {
      _cachedModel = settings.model; return _cachedModel;
    }
  } catch { }
  try {
    // 兜底：最近一个真实会话用的模型
    const root = projectsRoot();
    const files = [];
    for (const d of fs.readdirSync(root)) {
      const dir = path.join(root, d);
      if (fs.statSync(dir).isDirectory()) for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) files.push(path.join(dir, f));
    }
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const f of files.slice(0, 3)) {
      for (const o of readJsonl(f, { maxLines: 500 })) {
        if (o.type === 'assistant' && o.message && o.message.model && !/synthetic/.test(o.message.model)) {
          _cachedModel = o.message.model; return _cachedModel;
        }
      }
    }
  } catch { }
  _cachedModel = 'imported';
  return _cachedModel;
}

function isMetaNoise(text) {
  if (typeof text !== 'string') return false;
  return text.startsWith('<local-command-caveat>') || text.startsWith('<command-name>') ||
    text.startsWith('<command-message>') || text.startsWith('<local-command-stdout>') ||
    text.startsWith('Caveat:');
}

function contentBlocksToEntry(content) {
  // 返回 {textBlocks, toolResults}
  const textBlocks = [], toolResults = [];
  if (typeof content === 'string') {
    textBlocks.push({ type: 'text', text: content });
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') textBlocks.push({ type: 'text', text: b.text ?? '' });
      else if (b.type === 'image') {
        const src = b.source || {};
        textBlocks.push({ type: 'image', mediaType: src.media_type, data: src.data ? '[base64 data]' : undefined });
      } else if (b.type === 'tool_result') {
        const out = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
        toolResults.push({ type: 'tool_result', for: b.tool_use_id, output: out, isError: !!b.is_error });
      } else if (b.type === 'thinking') {
        // 保留原签名：同厂商 T1 写回时透传，resume 才认
        textBlocks.push({ type: 'thinking', text: b.thinking ?? '', signature: b.signature || '', signed: true });
      } else if (b.type === 'tool_use') {
        textBlocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} });
      }
    }
  }
  return { textBlocks, toolResults };
}

const _scanCache = new Map();
function scanFile(file) {
  const stat = fs.statSync(file);
  const hit = _scanCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.info;
  const lines = readJsonl(file);
  const info = {
    id: path.basename(file, '.jsonl'), file, agent: 'claude',
    title: '', firstUserText: '', cwd: '', gitBranch: null, version: null,
    tsFirst: null, tsLast: null, msgCount: 0, toolCalls: 0, sidechains: 0, size: fs.statSync(file).size,
  };
  let titleFromSummary = '';
  let titleFromAi = '';
  for (const o of lines) {
    const t = o.type;
    if (o.timestamp) { if (!info.tsFirst) info.tsFirst = o.timestamp; info.tsLast = o.timestamp; }
    if (o.sessionId) info.id = o.sessionId;
    if (o.cwd && !info.cwd) info.cwd = o.cwd;
    if (o.gitBranch && !info.gitBranch) info.gitBranch = o.gitBranch;
    if (o.version && !info.version) info.version = o.version;
    if (t === 'summary' && o.summary && !titleFromSummary) titleFromSummary = o.summary;
    if (t === 'ai-title' && o.aiTitle && !titleFromAi) titleFromAi = o.aiTitle;
    if (o.isSidechain) info.sidechains++;
    if (t === 'user' && !o.isSidechain) {
      const c = o.message && o.message.content;
      if (typeof c === 'string') {
        if (!o.isMeta && !isMetaNoise(c) && !info.firstUserText) info.firstUserText = c;
        info.msgCount++;
      } else if (Array.isArray(c)) {
        info.msgCount++;
        for (const b of c) {
          if (b && b.type === 'text' && !o.isMeta && !info.firstUserText && !isMetaNoise(b.text)) info.firstUserText = b.text;
          if (b && b.type === 'tool_result') info.toolCalls++;
        }
      }
    } else if (t === 'assistant' && !o.isSidechain) {
      info.msgCount++;
      const c = o.message && o.message.content;
      if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_use') info.toolCalls++;
    }
  }
  info.title = titleFromSummary || titleFromAi || truncateStr((info.firstUserText || '(无标题)').replace(/\s+/g, ' ').trim(), 60);
  info.tokens = null;
  _scanCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, info });
  return info;
}

function listSessions(baseDir) {
  const root = projectsRoot(baseDir);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const d of fs.readdirSync(root)) {
    const dir = path.join(root, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      try { out.push(scanFile(path.join(dir, f))); } catch { /* 跳过坏文件 */ }
    }
  }
  out.sort((a, b) => (b.tsLast || '').localeCompare(a.tsLast || ''));
  return out;
}

function readSession(sessionIdOrFile, baseDir) {
  let file = sessionIdOrFile;
  if (!fs.existsSync(file)) {
    outer: for (const d of fs.readdirSync(projectsRoot(baseDir))) {
      const dir = path.join(projectsRoot(baseDir), d);
      if (!fs.statSync(dir).isDirectory()) continue;
      const cand = path.join(dir, sessionIdOrFile + '.jsonl');
      if (fs.existsSync(cand)) { file = cand; break outer; }
    }
  }
  if (!fs.existsSync(file)) throw new Error(`Claude 会话不存在: ${sessionIdOrFile}`);
  const lines = readJsonl(file);
  const entries = [];
  const compactions = [];
  const loss = [];
  let sidechainCount = 0;
  let title = '';
  let cwd = '';
  let version = null;
  let model = null;
  let recordedTokens = 0;
  for (const o of lines) {
    const t = o.type;
    if (o.cwd && !cwd) cwd = o.cwd;
    if (o.version && !version) version = o.version;
    if (t === 'summary' && !title) title = o.summary || '';
    if (t === 'ai-title' && !title) title = o.aiTitle || '';
    if (o.isSidechain) { sidechainCount++; continue; }
    if (t === 'user') {
      if (o.isCompactSummary) {
        // /compact 产生的压缩摘要：计入 compactions（摘要文本仍作为普通条目保留）
        const { textBlocks: sumBlocks } = contentBlocksToEntry(o.message && o.message.content);
        compactions.push({
          ts: o.timestamp,
          message: sumBlocks.map((b) => b.text || '').join('\n').slice(0, 400),
        });
      }
      const { textBlocks, toolResults } = contentBlocksToEntry(o.message && o.message.content);
      const base = { id: o.uuid || `row_${entries.length}`, ts: o.timestamp, role: null, kind: 'text', blocks: [], meta: {} };
      if (toolResults.length) {
        entries.push({ ...base, id: (o.uuid || `row_${entries.length}`) + '_res', role: 'user', kind: 'tool-result', blocks: toolResults });
      }
      const isNoise = o.isMeta || textBlocks.every((b) => b.type === 'text' && isMetaNoise(b.text));
      if (textBlocks.length) {
        entries.push({
          ...base, role: isNoise ? 'meta' : 'user', kind: isNoise ? 'note' : 'text',
          blocks: textBlocks, meta: {},
        });
      }
    } else if (t === 'assistant') {
      const msg = o.message || {};
      const { textBlocks } = contentBlocksToEntry(msg.content);
      if (textBlocks.length) {
        entries.push({
          id: o.uuid || `row_${entries.length}`, ts: o.timestamp, role: 'assistant', kind: 'text', blocks: textBlocks,
          meta: { model: msg.model || null },
        });
        if (msg.model) model = msg.model;
        const u = msg.usage || {};
        recordedTokens += (u.input_tokens || 0) + (u.output_tokens || 0);
      }
    } else if (t === 'system') {
      entries.push({
        id: o.uuid || `row_${entries.length}`, ts: o.timestamp, role: 'meta', kind: 'note',
        blocks: [{ type: 'text', text: o.content || '' }], meta: { subtype: o.subtype },
      });
    } else if (t === 'attachment') {
      loss.push(`跳过 1 条 attachment 行（${(o.attachment && o.attachment.type) || '未知'}，hook/插件内部事件）`);
    }
    // mode / permission-mode / last-prompt / file-history-snapshot 等元数据行：不入 entries
  }
  if (sidechainCount) loss.push(`已按主链读取，排除 ${sidechainCount} 条 sidechain（子代理）行`);
  const stats = {
    entries: entries.length,
    userTurns: entries.filter((e) => e.role === 'user' && e.kind === 'text').length,
    assistantEntries: entries.filter((e) => e.role === 'assistant').length,
    toolCalls: 0, toolResults: 0, thinking: 0, approxTokens: 0, recordedTokens,
  };
  for (const e of entries) {
    stats.approxTokens += estimateTokens(JSON.stringify(e.blocks));
    for (const b of e.blocks) {
      if (b.type === 'tool_use') stats.toolCalls++;
      if (b.type === 'tool_result') stats.toolResults++;
      if (b.type === 'thinking') stats.thinking++;
    }
  }
  const st = fs.statSync(file);
  return {
    arx: 1, id: randomUUID(), created_at: nowISO(),
    source: { agent: 'claude-code', agent_version: version, session_id: path.basename(file, '.jsonl'), title: title || truncateStr((entries.find((e) => e.role === 'user' && e.kind === 'text')?.blocks?.[0]?.text) || '(无标题)', 60), file },
    project: { cwd, gitBranch: null },
    env: { model, cli_version: version },
    stats,
    entries,
    compactions,
    loss,
    _fileStat: { size: st.size, mtimeMs: st.mtimeMs },
  };
}

// ---------- 写入（合成 Claude 原生会话） ----------
function claudeBlocksFrom(blocks) {
  const out = [];
  for (const b of blocks || []) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text || '' });
    else if (b.type === 'thinking') out.push({ type: 'thinking', thinking: b.text || '', signature: b.signature || '' });
    else if (b.type === 'tool_use') out.push({ type: 'tool_use', id: b.id || ('toolu_' + randomUUID()), name: b.name, input: b.input ?? {} });
    else if (b.type === 'image') { /* 跨厂商图片 v1 跳过 */ }
  }
  return out;
}

function writeSession(msx, { cwd, newId, baseDir } = {}) {
  cwd = cwd || msx.project?.cwd;
  if (!cwd) throw new Error('缺少目标项目 cwd');
  const id = newId || randomUUID();
  const dir = claudeDirFor(baseDir, cwd);
  ensureDir(dir);
  const file = path.join(dir, id + '.jsonl');
  const loss = [...(msx.loss || [])];
  // 跨厂商思考块签名不可重放（需要源厂商私钥），带空签名写入可能让 resume 报 400——直接剥离
  let entries = msx.entries || [];
  if ((msx.source?.agent || '') !== 'claude-code' && entries.some((e) => (e.blocks || []).some((b) => b.type === 'thinking'))) {
    entries = entries
      .map((e) => ({ ...e, blocks: (e.blocks || []).filter((b) => b.type !== 'thinking') }))
      .filter((e) => (e.blocks || []).length > 0);
    loss.push('Claude 目标：跨厂商思考块签名无法重放，已剥离全部 thinking 块');
  }
  const lines = [];
  let prevUuid = null;
  let firstUserText = '';
  let count = 0;
  for (const e of entries) {
    const ts = e.ts || nowISO();
    if (e.kind === 'compaction') { loss.push('Claude 目标：跳过 1 条 compaction 标记'); continue; }
    if (e.role === 'meta' || e.role === 'system') {
      loss.push(`Claude 目标：跳过 1 条 ${e.role} 条目（${(e.blocks?.[0]?.text || '').slice(0, 40)}…）`);
      continue;
    }
    const uuid = randomUUID();
    const common = {
      parentUuid: prevUuid, isSidechain: false, type: null, uuid, timestamp: ts,
      userType: 'external', entrypoint: 'cli', cwd, sessionId: id, version: CLAUDE_VERSION,
    };
    if (e.role === 'user' && e.kind === 'text') {
      const textParts = (e.blocks || []).filter((b) => b.type === 'text');
      if (!textParts.length) continue;
      const content = textParts.length === 1 ? textParts[0].text : claudeBlocksFrom(textParts);
      if (!firstUserText) firstUserText = textParts[0].text || '';
      lines.push({ ...common, type: 'user', promptId: uuid, message: { role: 'user', content } });
      prevUuid = uuid; count++;
    } else if (e.kind === 'tool-result') {
      const blocks = (e.blocks || []).map((b) => ({
        type: 'tool_result', tool_use_id: b.for, content: typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? ''),
        ...(b.isError ? { is_error: true } : {}),
      }));
      if (!blocks.length) continue;
      lines.push({ ...common, type: 'user', message: { role: 'user', content: blocks } });
      prevUuid = uuid; count++;
    } else if (e.role === 'assistant') {
      const blocks = claudeBlocksFrom(e.blocks);
      if (!blocks.length) continue;
      const hasToolUse = blocks.some((b) => b.type === 'tool_use');
      lines.push({
        ...common, type: 'assistant',
        message: {
          id: 'resp_' + randomUUID().replace(/-/g, ''), type: 'message', role: 'assistant',
          content: blocks, model: currentClaudeModel(baseDir) || (e.meta && e.meta.model) || 'imported',
          stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      prevUuid = uuid; count++;
    }
  }
  if (!count) throw new Error('没有可写入的内容条目（全部被过滤）');
  // 标题行 + last-prompt（让 /resume 列表显示标题，社区验证的做法）
  const title = (msx.source && msx.source.title) || truncateStr(firstUserText, 60) || '导入的会话';
  lines.push({ type: 'summary', summary: title, leafUuid: prevUuid });
  lines.push({ type: 'last-prompt', lastPrompt: truncateStr(firstUserText, 200), leafUuid: prevUuid, sessionId: id });
  writeJsonl(file, lines);
  return { id, path: file, loss, count };
}

// T0：同源原生复制（100% 保真），仅重写 sessionId
function rawCopy(sessionIdOrFile, { newId, baseDir } = {}) {
  const src = findFile(sessionIdOrFile, baseDir);
  const lines = readJsonl(src);
  const oldId = path.basename(src, '.jsonl');
  const id = newId || randomUUID();
  const out = lines.map((o) => {
    const c = { ...o };
    if (c.sessionId === oldId) c.sessionId = id;
    if (c.session_id === oldId) c.session_id = id;
    return c;
  });
  const dest = path.join(path.dirname(src), id + '.jsonl');
  writeJsonl(dest, out);
  return { id, path: dest, count: out.length };
}

function findFile(sessionIdOrFile, baseDir) {
  let file = sessionIdOrFile;
  if (!fs.existsSync(file)) {
    for (const d of fs.readdirSync(projectsRoot(baseDir))) {
      const dir = path.join(projectsRoot(baseDir), d);
      if (!fs.statSync(dir).isDirectory()) continue;
      const cand = path.join(dir, sessionIdOrFile + '.jsonl');
      if (fs.existsSync(cand)) return cand;
    }
    throw new Error(`Claude 会话不存在: ${sessionIdOrFile}`);
  }
  return file;
}

function doctor(baseDir) {
  const root = projectsRoot(baseDir);
  const ok = fs.existsSync(root);
  let files = 0;
  if (ok) {
    for (const d of fs.readdirSync(root)) {
      const dir = path.join(root, d);
      if (fs.statSync(dir).isDirectory()) files += fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length;
    }
  }
  return { agent: 'claude-code', ok, storage: root, sessionFiles: files };
}

module.exports = { listSessions, readSession, writeSession, rawCopy, doctor, CLAUDE_VERSION, claudeDirFor };
