'use strict';
// 跨设备接力 bundle（借鉴 MoveZ .cbz / baton 打包思路，落地为单文件 .arxbundle）
// 格式：{"arxBundle":1,"version":1,"created_at","source_app":"AgentRelay/<ver>","sessions":[<ARX>,...]}
// 会话逐个流式写出（大会话防 OOM）；读取端用流式扫描器逐会话解析（同 RAM 有界，StringDecoder 保证跨块多字节不损坏）。
// 路径重映射（MoveZ/Reinstate 验证过的跨机器关键）：导入时把 bundle 里的源机器路径前缀替换为本机路径。
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { ensureDir, exportsDir, nowISO } = require('./util');
const agents = require('./agents');
const { selectEntries, redactMsx, computeStats } = require('./msx');

// 历史 ARX 导出文件里的 agent 别名 → 注册表 id（否则 bundle T0 同源判断会挂）
const AGENT_ALIAS = { 'claude-code': 'claude', 'vscode-copilot': 'vscode' };
function canonicalAgent(a) {
  const c = AGENT_ALIAS[a] || a;
  return agents.META[c] ? c : a;
}

// ---------- 导出 ----------
// items: [{sourceAgent, sourceInstance?, sessionId, options?}]；公共 options 作为兜底
async function exportBundle({ items, options = {}, redact = false, out = null }) {
  if (!Array.isArray(items) || !items.length) throw new Error('bundle 导出至少需要一个 --source 会话');
  const file = out || path.join(exportsDir(), `arx-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.arxbundle`);
  ensureDir(path.dirname(file));
  const tmp = file + '.msx-tmp-' + process.pid;
  const ws = fs.createWriteStream(tmp, { encoding: 'utf8' });
  // rename 只在成功路径做：中途失败绝不能留下一个看起来合法的空/半截 bundle
  const done = new Promise((resolve, reject) => { ws.on('error', reject); ws.on('finish', () => resolve()); });
  ws.write('{"arxBundle":1,"version":1,"created_at":' + JSON.stringify(nowISO()) + ',"source_app":"AgentRelay","sessions":[');
  let n = 0;
  try {
    for (const it of items) {
      // it.msx 直通：调用方已持有 ARX 时跳过注册表读取（沙盒测试/自定义实例不可达时用）
      const src = it.msx || (it.sourceInstance ? await agents.readMsxInstance(it.sourceInstance, it.sessionId) : await agents.readMsx(it.sourceAgent, it.sessionId));
      const loss = [];
      const entries = selectEntries(src.entries, { ...options, ...(it.options || {}) }, loss);
      let msx = {
        arx: 1, id: src.id, created_at: src.created_at, source: src.source,
        project: { cwd: src.project?.cwd || null }, env: src.env,
        stats: computeStats(entries), entries, compactions: src.compactions || [], loss,
      };
      if (redact) msx = redactMsx(msx);
      if (n) ws.write(',');
      ws.write(JSON.stringify(msx));
      n++;
    }
  } catch (e) {
    try { ws.end(); } catch { }
    await done.catch(() => { });
    try { fs.rmSync(tmp, { force: true }); } catch { }
    throw e;
  }
  ws.end(']}');
  try {
    await done;
    fs.renameSync(tmp, file);
  } catch (e) {
    // 落盘阶段失败（如磁盘满）：不留 tmp 残骸
    try { fs.rmSync(tmp, { force: true }); } catch { }
    throw e;
  }
  return { file, count: n };
}

// ---------- 流式扫描读取 ----------
// 逐字符状态机：i（扫描游标）与 depth 等状态跨 chunk 持久；每轮外层迭代末尾裁掉 s 中已消费的前缀，
// 且裁剪时同步平移 i —— 否则新 chunk 到来会从头重扫、depth 被重复累加（会提前/永不闭合）。
// 字节→字符串用 StringDecoder 跨块续解码：1MB 块边界切在多字节字符中间时不会产生 U+FFFD 静默损坏。
async function scanBundleRaw(file, { onManifest, onSession } = {}) {
  if (!fs.existsSync(file)) throw new Error(`bundle 文件不存在: ${file}`);
  const CHUNK = 1024 * 1024;
  const decoder = new StringDecoder('utf8');
  // 严格模式旁路解码器：StringDecoder 遇无效字节会替换成 U+FFFD（JSON 仍可解析 → 内容静默损坏）。
  // 用 fatal TextDecoder 消费同一字节流，任何无效 UTF-8 直接报错（审核 P3）。
  let strict;
  try { strict = new TextDecoder('utf-8', { fatal: true }); } catch { strict = null; }
  let pos = 0;
  let s = '';
  let i = 0;               // s 内扫描游标（跨 chunk 持久）
  let depth = 0;           // 当前会话对象括号深度
  let inStr = false, esc = false;
  let phase = 'head';      // head → array → session → tail
  let head = '';
  let manifestSent = false;
  let sessionStart = -1;   // 当前会话对象的起始下标（-1 = 不在会话中）
  const manifest = {};
  const fd = fs.openSync(file, 'r'); // open 放进 try 保护：fstat 竞态抛错时 finally 仍能关掉 fd
  let size = 0;
  try {
    size = fs.fstatSync(fd).size;
    while (pos < size || (s.length && i < s.length)) {
      if (pos < size) {
        const len = Math.min(CHUNK, size - pos);
        const b = Buffer.alloc(len);
        const bytesRead = fs.readSync(fd, b, 0, len, pos);
        if (bytesRead !== len) throw new Error('bundle 读取不完整（文件被并发修改？）');
        pos += bytesRead;
        if (strict) {
          try { strict.decode(b, { stream: true }); }
          catch { throw new Error('bundle 不是有效的 UTF-8 文件（检测到无效字节序列，拒绝静默损坏内容）'); }
        }
        s += decoder.write(b);
      }
      while (i < s.length) {
        const ch = s[i];
        if (phase === 'head') {
          head += ch;
          const idx = head.indexOf('"sessions":[');
          if (idx !== -1) {
            const metaRaw = head.slice(0, idx);
            try {
              const m = JSON.parse(metaRaw.replace(/,\s*$/, '') + '}');
              // 逐键拷贝：Object.assign 会触发 __proto__ 的 Set 语义（JSON.parse 产生的自有 __proto__ 键
              // 借此可以改写 manifest 的原型——原型投毒加固）
              for (const k of Object.keys(m)) {
                if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
                manifest[k] = m[k];
              }
            } catch {
              // 头部不含嵌套对象，宽松解析 created_at/version
              const v = /"version":\s*(\d+)/.exec(head); if (v) manifest.version = Number(v[1]);
              const c = /"created_at":\s*"([^"]+)"/.exec(head); if (c) manifest.created_at = c[1];
            }
            manifest.sessions = undefined;
            if (onManifest && !manifestSent) { onManifest(manifest); manifestSent = true; }
            phase = 'array';
            s = s.slice(idx + '"sessions":['.length);
            i = 0;
            continue;
          }
          if (head.length > 256 * 1024) throw new Error('不是有效的 .arxbundle（找不到 "sessions":[ 头）');
          i++;
          continue;
        }
        if (phase === 'tail') { i++; continue; }
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          i++;
          continue;
        }
        if (ch === '"') { inStr = true; i++; continue; }
        if (phase === 'array') {
          if (ch === '{') { phase = 'session'; sessionStart = i; depth = 1; i++; continue; }
          if (ch === ']') { phase = 'tail'; i++; continue; }
          i++; // 逗号/空白
          continue;
        }
        // phase === 'session'
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            const raw = s.slice(sessionStart, i + 1);
            let msx = null;
            try { msx = JSON.parse(raw); } catch (e) { throw new Error('bundle 内会话 JSON 解析失败: ' + e.message); }
            if (onSession) await onSession(msx);
            phase = 'array';
            s = s.slice(i + 1);
            i = 0;
            sessionStart = -1;
            continue;
          }
        }
        i++;
      }
      // 外层迭代末尾：裁掉已消费前缀（同步平移游标），防止缓冲无限增长
      if (phase === 'session') {
        if (sessionStart > 0) { s = s.slice(sessionStart); i -= sessionStart; sessionStart = 0; }
      } else if (phase !== 'head' && i > 0) {
        s = s.slice(i); i = 0;
      }
    }
    s += decoder.end(); // 冲掉解码器残留（正常应为空）
    if (strict) {
      // EOF 冲洗：文件末尾若悬着半截多字节序列，严格解码器在这里才会发现
      try { strict.decode(); }
      catch { throw new Error('bundle 不是有效的 UTF-8 文件（末尾多字节序列不完整）'); }
    }
  } finally { fs.closeSync(fd); }
  if (phase === 'head') throw new Error('不是有效的 .arxbundle（空文件或截断）');
  if (phase === 'session') throw new Error('bundle 文件不完整（末尾会话对象未闭合，传输被截断？）');
  return manifest;
}

// ---------- 清单预览（不展开内容） ----------
async function inspectBundle(file) {
  const list = [];
  await scanBundleRaw(file, {
    onManifest: (m) => { list.manifest = m; },
    onSession: async (msx) => {
      list.push({
        index: list.length,
        agent: canonicalAgent(msx.source?.agent || '?'), sessionId: msx.source?.session_id || msx.id,
        title: msx.source?.title || '(无标题)', cwd: msx.project?.cwd || null,
        entries: msx.stats?.entries ?? (msx.entries?.length || 0),
        approxTokens: msx.stats?.approxTokens || 0,
      });
    },
  });
  return { manifest: list.manifest || { version: 1 }, file, sessions: list };
}

// ---------- 路径重映射 ----------
// rules: [{from, to}]；前缀替换（路径段感知：D:/work → /Users/x/work 匹配 D:/work 与 D:/work/sub，不匹配 D:/worker）
function remapCwd(cwd, rules) {
  if (!cwd) return cwd;
  let out = String(cwd).replace(/\\/g, '/');
  for (const r of rules || []) {
    const from = String(r.from || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!from) continue;
    const to = String(r.to || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const low = out.toLowerCase(), lowFrom = from.toLowerCase();
    if (low === lowFrom) { out = to || '/'; break; }
    if (low.startsWith(lowFrom + '/')) { out = to + out.slice(lowFrom.length); break; }
  }
  return out;
}

// ---------- 导入接力 ----------
// targets: [{agent, instance?, cwd?, mode?}]；每个 bundle 会话 × 每个目标 = 一次接力。
// only: 会话下标白名单（GUI 复选框），缺省全部。
// cwd 优先级：目标显式 cwd > 重映射后的 bundle cwd。
async function importBundle({ file, remap, targets, options = {}, dryRun = false, backup = null, only = null }) {
  if (!Array.isArray(targets) || !targets.length) throw new Error('bundle 导入需要至少一个目标 agent');
  const transfer = require('./transfer');
  const onlySet = Array.isArray(only) && only.length ? new Set(only.map(Number)) : null;
  const results = [];
  let idx = -1;
  await scanBundleRaw(file, {
    onSession: async (msx) => {
      idx++;
      if (onlySet && !onlySet.has(idx)) return;
      const srcCwd = msx.project?.cwd || null;
      const remapped = remapCwd(srcCwd, remap);
      // 别名归一：老导出文件里 claude 写作 'claude-code'、vscode 写作 'vscode-copilot'，
      // 不归一会让 T0 同源判断和 META 查找失败
      const srcAgent = canonicalAgent(msx.source?.agent) || 'claude';
      for (const t of targets) {
        // T0 在 bundle 导入中不可用：rawCopy 依赖源文件在本机，而 bundle 会话来自别的机器。
        // 同源时按 T1 原生注入执行（同一写入器、逐字经 ARX，保真等价），并在结果里说明（审核 P2）。
        let mode = t.mode || 'T1';
        let coerced = false;
        if (mode === 'T0') { mode = 'T1'; coerced = true; }
        const r = await transfer.transferOne({
          sourceAgent: srcAgent, sessionId: msx.source?.session_id || msx.id,
          targetAgent: t.agent, cwd: t.cwd || remapped || null, mode,
          options, dryRun, msxOverride: msx, sourceInstance: t.sourceInstance || null,
          targetInstance: t.instance || null, targetBaseDir: t.baseDir || null, backup,
        });
        if (coerced && r.ok) {
          r.notes = r.notes || [];
          r.notes.push('bundle 导入不走 T0 文件级复制（源文件不在本机），已按 T1 原生注入等价执行：同一写入器，内容逐字经 ARX');
        }
        results.push(r);
      }
    },
  });
  return results;
}

module.exports = { exportBundle, inspectBundle, importBundle, remapCwd, scanBundleRaw, canonicalAgent, AGENT_ALIAS };
