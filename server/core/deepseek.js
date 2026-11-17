'use strict';
// DeepSeek（chat.deepseek.com）对话导入适配器 —— 只读源
// 两条入口：
//   1) 官方数据导出 zip（manifest.json + user.json + chat_sessions/<uuid>.json，流式 zip：本地头 size=0，
//      真实尺寸在中央目录 p+20）—— 零依赖解析（中央目录 + zlib.inflateRawSync）
//   2) 分享链接 https://chat.deepseek.com/share/<id> → GET /api/v0/share/content?share_id=<id>（免鉴权，
//      唯一的用户主动网络请求；直连国内可达，不走代理也不需要）
// 映射：messages 树（parent_id，current_message_id 指向活动叶）→ 活动分支；
//   fragments: REQUEST→用户文本 · THINK→思考块 · RESPONSE→助手文本 · TOOL_SEARCH/TOOL_OPEN/FILE/READ_LINK→
//   单行元信息文本 · TEMPLATE_RESPONSE→文本 · CONTENT_RISK→跳过记损
// 存储：导入的会话以 ARX 落在 <dataDir>/deepseek/<sourceKey>/<sessionId>.json，之后作为普通只读源接力
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { dataDir, cacheDir, ensureDir, nowISO, truncateStr } = require('./util');

const AGENT = 'deepseek';
const SHARE_RE = /^https?:\/\/chat\.deepseek\.com\/share\/([A-Za-z0-9_-]+)/;

function importsRoot() { return path.join(dataDir(), 'deepseek'); }

// ---------- zip 零依赖读取（流式 zip：真实尺寸取中央目录） ----------
function zipIndex(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件（未找到中央目录）');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files.push({ name, method, csize, lho });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return files;
}
function zipRead(buf, f) {
  const nameLen = buf.readUInt16LE(f.lho + 26), extraLen = buf.readUInt16LE(f.lho + 28);
  const raw = buf.subarray(f.lho + 30 + nameLen + extraLen, f.lho + 30 + nameLen + extraLen + f.csize);
  return f.method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
}

// ---------- 导出 zip：解包 chat_sessions 到缓存目录（按 zip mtime 缓存，一次解包多次使用） ----------
function extractZip(zipPath) {
  const st = fs.statSync(zipPath);
  const tag = crypto.createHash('md5').update(zipPath + ':' + st.size + ':' + Math.round(st.mtimeMs)).digest('hex').slice(0, 10);
  const outDir = path.join(cacheDir(), 'deepseek-zip', tag);
  if (fs.existsSync(path.join(outDir, '.done'))) return outDir;
  ensureDir(outDir);
  const buf = fs.readFileSync(zipPath);
  const files = zipIndex(buf);
  let count = 0;
  for (const f of files) {
    if (!f.name.startsWith('chat_sessions/') || !f.name.endsWith('.json')) continue;
    const out = path.join(outDir, path.basename(f.name));
    fs.writeFileSync(out, zipRead(buf, f));
    count++;
  }
  fs.writeFileSync(path.join(outDir, '.done'), String(count));
  if (!count) throw new Error('zip 内没有 chat_sessions/*.json——请确认是 DeepSeek 官方数据导出包');
  return outDir;
}

// ---------- fragments / messages → ARX ----------
function fragToBlocks(m, loss) {
  const blocks = [];
  for (const fr of m.fragments || []) {
    const c = fr.content;
    switch (fr.type) {
      case 'REQUEST':
      case 'RESPONSE':
      case 'TEMPLATE_RESPONSE':
        if (c) blocks.push({ type: 'text', text: String(c) });
        break;
      case 'THINK':
        if (c) blocks.push({ type: 'thinking', text: String(c) });
        break;
      case 'TOOL_SEARCH': {
        // 分享 API 的 queries 在 fragment 顶层；导出 zip 的 queries 在 content JSON 里
        let q = '';
        if (Array.isArray(fr.queries)) q = fr.queries.map((x) => x.query || x).join('；');
        else { try { const j = JSON.parse(c); q = (j.queries || []).map((x) => x.query || x).join('；'); } catch { q = String(c || '').slice(0, 200); } }
        if (q) blocks.push({ type: 'text', text: `〔联网搜索〕${q}` });
        break;
      }
      case 'TOOL_OPEN': {
        // result.snippet 是模型实际读到的页面摘要——接力保真的关键内容，截断保留
        let title = '', url = '', snippet = '';
        if (fr.result && typeof fr.result === 'object') { title = fr.result.title || ''; url = fr.result.url || ''; snippet = String(fr.result.snippet || '').slice(0, 300); }
        else { try { const j = JSON.parse(c); title = j.title || ''; url = j.url || ''; snippet = String(j.snippet || '').slice(0, 300); } catch { snippet = String(c || '').slice(0, 300); } }
        let s = title + (url ? `（${url}）` : '');
        if (s) blocks.push({ type: 'text', text: `〔浏览网页〕${s}` });
        if (snippet) blocks.push({ type: 'text', text: `〔网页摘要〕${snippet}` });
        break;
      }
      case 'FILE': {
        let s = '';
        if (Array.isArray(fr.files)) s = fr.files.map((x) => x.file_name).join('、');
        else { try { const j = JSON.parse(c); s = (j.files || []).map((x) => x.file_name).join('、'); } catch { s = String(c || '').slice(0, 200); } }
        if (s) blocks.push({ type: 'text', text: `〔附件〕${s}` });
        break;
      }
      case 'READ_LINK':
        if (c) blocks.push({ type: 'text', text: `〔读取链接〕${String(c).slice(0, 300)}` });
        break;
      case 'CONTENT_RISK':
        loss.push('DeepSeek: 跳过 CONTENT_RISK 免责声明片段');
        break;
      default:
        if (c != null && String(c).length) blocks.push({ type: 'text', text: `〔${fr.type}〕${String(c).slice(0, 300)}` });
        else loss.push(`DeepSeek: 跳过 ${fr.type} 空片段`);
    }
  }
  return blocks;
}

// 活动分支：优先 current_message_id 回溯；否则取最深叶子（按 inserted_at 最新）
// 消息 id 字段归一：导出 zip 用 id，分享 API 用 message_id
function activeBranch(messages, currentId) {
  const mid = (m) => (m.message_id != null ? m.message_id : m.id);
  const byId = new Map(messages.map((m) => [mid(m), m]));
  const curId = currentId != null && byId.has(currentId) ? currentId : null;
  if (curId != null) {
    const chain = [];
    let cur = byId.get(curId);
    const guard = new Set();
    while (cur && !guard.has(mid(cur))) { guard.add(mid(cur)); chain.push(cur); cur = cur.parent_id != null ? byId.get(cur.parent_id) : null; }
    return chain.reverse();
  }
  const referenced = new Set(messages.map((m) => m.parent_id).filter((v) => v != null));
  const leaves = messages.filter((m) => !referenced.has(mid(m)));
  const leaf = leaves.length ? leaves.reduce((a, b) => String(b.inserted_at || '') >= String(a.inserted_at || '') ? b : a) : null;
  const chain = [];
  let cur = leaf;
  const guard = new Set();
  while (cur && !guard.has(mid(cur))) { guard.add(mid(cur)); chain.push(cur); cur = cur.parent_id != null ? byId.get(cur.parent_id) : null; }
  return chain.reverse();
}

function messagesToArx(messages, currentId, loss) {
  const branch = activeBranch(messages, currentId);
  const entries = [];
  for (const m of branch) {
    const ts = m.inserted_at ? new Date(m.inserted_at).toISOString() : null;
    const blocks = fragToBlocks(m, loss);
    if (m.status && m.status !== 'FINISHED') loss.push(`DeepSeek: 1 条 ${m.role} 消息状态为 ${m.status}（内容可能不完整）`);
    const mid = m.message_id != null ? m.message_id : m.id;
    if (m.role === 'USER' && blocks.length) {
      entries.push({ id: 'm' + mid, ts, role: 'user', kind: 'text', blocks, meta: {} });
    } else if (m.role === 'ASSISTANT' && blocks.length) {
      entries.push({ id: 'm' + mid, ts, role: 'assistant', kind: 'text', blocks, meta: { model: m.model || null } });
    }
  }
  const stats = { entries: entries.length, userTurns: 0, assistantEntries: 0, toolCalls: 0, toolResults: 0, thinking: 0, approxTokens: 0, recordedTokens: null };
  for (const e of entries) {
    if (e.role === 'user' && e.kind === 'text') stats.userTurns++;
    if (e.role === 'assistant') stats.assistantEntries++;
    for (const b of e.blocks) {
      if (b.type === 'thinking') stats.thinking++;
      stats.approxTokens += Math.ceil((b.text || '').length / 3.5);
    }
  }
  return { stats, entries };
}

function arxFromSession(src, sessionId, fileRef) {
  const loss = [];
  const { stats, entries } = messagesToArx(src.messages || [], src.current_message_id, loss);
  const firstUser = entries.find((e) => e.role === 'user' && e.kind === 'text');
  return {
    arx: 1, id: crypto.randomUUID(), created_at: nowISO(),
    source: { agent: AGENT, agent_version: src.export_format_version || null, session_id: sessionId, title: truncateStr(src.title || '', 60) || '(无标题)', file: fileRef },
    project: { cwd: '' },
    env: { model: 'deepseek', provider: 'DeepSeek', cli_version: null },
    stats, entries, compactions: [], loss: [...new Set(loss)],
  };
}

// ---------- 导出 zip 导入 ----------
function importZip(zipPath) {
  if (!fs.existsSync(zipPath)) throw new Error(`文件不存在: ${zipPath}`);
  const outDir = extractZip(zipPath);
  const storeDir = ensureDir(path.join(importsRoot(), 'zip'));
  const imported = [];
  for (const f of fs.readdirSync(outDir)) {
    if (!f.endsWith('.json')) continue;
    const src = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
    if (!src.messages || !src.messages.length) continue;
    const sid = String(src.id || path.basename(f, '.json'));
    const arx = arxFromSession(src, sid, zipPath);
    if (!arx.entries.length) continue;
    fs.writeFileSync(path.join(storeDir, `zip-${sid}.json`), JSON.stringify(arx));
    imported.push({ id: sid, title: arx.source.title, entries: arx.stats.entries });
  }
  return { imported: imported.length, sessions: imported };
}

// ---------- 分享链接导入 ----------
function shareIdFrom(url) {
  const m = SHARE_RE.exec(String(url || '').trim());
  if (!m) throw new Error('不是有效的 DeepSeek 分享链接（应为 https://chat.deepseek.com/share/<id>）');
  return m[1];
}

async function fetchShare(shareId) {
  const r = await fetch(`https://chat.deepseek.com/api/v0/share/content?share_id=${encodeURIComponent(shareId)}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126' },
  });
  if (!r.ok) throw new Error(`分享内容请求失败: HTTP ${r.status}`);
  const j = JSON.parse(await r.text());
  const biz = j && j.data && j.data.biz_data;
  if (!biz || !Array.isArray(biz.messages)) throw new Error('分享内容响应格式异常（可能链接已失效）');
  return biz;
}

async function importShare(url) {
  const shareId = shareIdFrom(url);
  const biz = await fetchShare(shareId);
  const storeDir = ensureDir(path.join(importsRoot(), 'share'));
  const arx = arxFromSession({ title: biz.title || '(分享会话)', messages: biz.messages }, shareId, url);
  if (!arx.entries.length) throw new Error('分享会话没有可导入的内容');
  fs.writeFileSync(path.join(storeDir, `share-${shareId}.json`), JSON.stringify(arx));
  return { id: shareId, title: arx.source.title, entries: arx.stats.entries, file: path.join(storeDir, `share-${shareId}.json`) };
}

// ---------- 只读源：列表 / 详情 ----------
function listSessions(baseDir) {
  const root = baseDir || importsRoot();
  const out = [];
  const scan = (sub) => {
    const d = sub ? path.join(root, sub) : root;
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.json')) continue;
      try {
        const arx = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
        out.push({
          id: arx.source.session_id, agent: AGENT, file: path.join(d, f),
          title: arx.source.title, cwd: arx.project.cwd || '',
          tsFirst: arx.entries.length ? arx.entries[0].ts : null,
          tsLast: arx.entries.length ? arx.entries[arx.entries.length - 1].ts : null,
          msgCount: arx.stats.entries, toolCalls: arx.stats.toolCalls, size: fs.statSync(path.join(d, f)).size,
        });
      } catch { }
    }
  };
  try { if (fs.existsSync(root)) for (const sub of fs.readdirSync(root)) if (fs.statSync(path.join(root, sub)).isDirectory()) scan(sub); } catch { }
  scan(null);
  out.sort((a, b) => String(b.tsLast || '').localeCompare(String(a.tsLast || '')));
  return out;
}

async function readSession(sessionId, baseDir) {
  for (const f of listSessions(baseDir)) {
    if (f.id === sessionId || f.id.endsWith(sessionId)) {
      const arx = JSON.parse(fs.readFileSync(f.file, 'utf8'));
      arx.id = arx.id || crypto.randomUUID();
      arx.lastCompactionIndex = -1;
      return arx;
    }
  }
  throw new Error(`DeepSeek 导入会话不存在: ${sessionId}`);
}

function doctor(baseDir) {
  const root = baseDir || importsRoot();
  let sessions = 0;
  try { sessions = listSessions(baseDir).length; } catch { }
  return {
    agent: AGENT, ok: sessions > 0, storage: root, sessionFiles: sessions,
    note: sessions > 0 ? null : '还没有导入的 DeepSeek 会话（接力页支持官方导出 zip / 分享链接导入）',
  };
}

module.exports = { importZip, importShare, readSession, listSessions, doctor, shareIdFrom, fetchShare, importsRoot, zipIndex, zipRead, messagesToArx };
