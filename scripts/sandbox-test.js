'use strict';
// 沙盒冒烟测试：全量 reader + 全量 writer（T0/T1/T2 通道、bundle 往返；全部在沙盒/副本上，不动真实存储）
const fs = require('fs');
const path = require('path');
const os = require('os');
const agents = require('../server/core/agents');
const claude = require('../server/core/claude');
const codex = require('../server/core/codex');
const zcode = require('../server/core/zcode');
const workbuddy = require('../server/core/workbuddy');
const { entryPreview } = require('../server/core/msx');

const SANDBOX = path.join(__dirname, '..', 'sandbox');
// cihome/ 是 ci-test.js 的隔离 HOME 夹具（CI 的 mcp-verify 步骤还要复用），清理时保留
if (fs.existsSync(SANDBOX)) {
  for (const e of fs.readdirSync(SANDBOX)) {
    if (e !== 'cihome') fs.rmSync(path.join(SANDBOX, e), { recursive: true, force: true });
  }
}
fs.mkdirSync(SANDBOX, { recursive: true });
const projA = path.join(SANDBOX, 'projA');
fs.mkdirSync(projA, { recursive: true });

// 清理沙盒期间在真实 ~/.claude/projects 产生的测试会话目录
// slug 随仓库实际路径动态计算（规则与 claude.js 一致：非字母数字替换为 -）
function cleanupClaudeSandbox() {
  const claudeRoot = path.join(os.homedir(), '.claude', 'projects', projA.replace(/[^a-zA-Z0-9]/g, '-'));
  try { fs.rmSync(claudeRoot, { recursive: true, force: true }); console.log('(已清理 claude 沙盒目录)'); } catch { }
}

function pick(list, pred, label) {
  const s = list.find(pred);
  if (!s) throw new Error(`找不到测试样本: ${label}`);
  return s;
}

const nowIso = () => new Date().toISOString();

(async () => {
  const out = { pass: [], fail: [] };
  const t = (name, fn) => fn().then((r) => { out.pass.push(name); console.log(`✔ ${name}`, r || ''); })
    .catch((e) => { out.fail.push(name + ': ' + e.message); console.log(`✘ ${name}:`, e.message); });

  // ---------- readers ----------
  const claudeList = claude.listSessions();
  const claudeSess = pick(claudeList, (s) => s.msgCount > 5, 'claude 有内容的会话');
  const claudeMsx = await claude.readSession(claudeSess.id);
  console.log(`  claude: ${claudeSess.title} → entries=${claudeMsx.stats.entries} user=${claudeMsx.stats.userTurns} tools=${claudeMsx.stats.toolCalls} thinking=${claudeMsx.stats.thinking}`);

  const codexList = codex.listSessions();
  const codexSess = pick(codexList, (s) => s.msgCount >= 8 && !s.archived, 'codex 中等会话');
  const codexMsx = await codex.readSession(codexSess.id);
  console.log(`  codex: ${codexSess.title} → entries=${codexMsx.stats.entries} user=${codexMsx.stats.userTurns} tools=${codexMsx.stats.toolCalls}`);

  const zcodeList = zcode.listSessions();
  const zcodeSess = pick(zcodeList, (s) => (s.msgCount || 0) > 10 && !s.id.startsWith('sess_subagent'), 'zcode 主会话');
  const zcodeMsx = await zcode.readSession(zcodeSess.id);
  console.log(`  zcode: ${zcodeSess.title} → entries=${zcodeMsx.stats.entries} user=${zcodeMsx.stats.userTurns} tools=${zcodeMsx.stats.toolCalls} thinking=${zcodeMsx.stats.thinking}`);

  // WorkBuddy 双版本：优先本机实际存在的那一版（国内 ~/.workbuddy / 国际 ~/.workbuddy-ai）
  const wbDomestic = path.join(os.homedir(), '.workbuddy');
  const wbIntl = path.join(os.homedir(), '.workbuddy-ai');
  const wbBase = fs.existsSync(path.join(wbDomestic, 'workbuddy.db')) ? wbDomestic
    : (fs.existsSync(path.join(wbIntl, 'workbuddy.db')) ? wbIntl : null);
  const wbList = workbuddy.listSessions(wbBase);
  const wbSess = pick(wbList, (s) => s.file && s.size > 100000 && s.size < 5000000, 'workbuddy 中等会话');
  const wbMsx = await workbuddy.readSession(wbSess.id, wbBase);
  console.log(`  workbuddy: ${wbSess.title} → entries=${wbMsx.stats.entries} user=${wbMsx.stats.userTurns} tools=${wbMsx.stats.toolCalls} thinking=${wbMsx.stats.thinking}`);

  // ---------- writers（沙盒） ----------
  // codex → claude（合成 jsonl 到沙盒项目）
  const r1 = claude.writeSession(codexMsx, { cwd: projA });
  const lines = fs.readFileSync(r1.path, 'utf8').trim().split('\n');
  const parsed = lines.map((l) => JSON.parse(l));
  const okChain = parsed.every((o, i) => i === 0 || o.type === 'summary' || o.type === 'last-prompt' || o.parentUuid === parsed[i - 1].uuid || !o.uuid);
  if (!okChain) throw new Error('claude 合成链断裂');
  console.log(`  codex→claude: ${parsed.length} 行, ${r1.count} 消息行, 链完整`);
  // 回读验证
  const back1 = claude.readSession(r1.id);
  console.log(`  codex→claude 回读: entries=${back1.stats.entries} user=${back1.stats.userTurns}`);
  if (back1.stats.userTurns === 0) throw new Error('回读无用户消息');

  // claude → codex（合成 rollout 到沙盒 sessions 目录? writeSession 写真实目录 —— 用 rawCopy 逻辑不行，改为仅验证构建不落盘）
  // 为不污染真实 ~/.codex/sessions，用环境变量欺骗: 临时改 HOME 不可靠；改为直接调用并立即删除
  const r2 = codex.writeSession(claudeMsx, { cwd: projA });
  const codexLines = fs.readFileSync(r2.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const meta = codexLines.find((l) => l.type === 'session_meta');
  if (!meta || !meta.payload.id || meta.payload.cwd !== projA) throw new Error('codex 合成 session_meta 异常');
  const hasTurnContext = codexLines.some((l) => l.type === 'turn_context');
  if (!hasTurnContext) throw new Error('codex 合成缺 turn_context');
  console.log(`  claude→codex: ${codexLines.length} 行, provider=${meta.payload.model_provider}`);
  fs.rmSync(path.dirname(r2.path), { recursive: true, force: true }); // 清理沙盒 rollout
  console.log('  (已清理沙盒 rollout 文件)');

  // claude → zcode（db 副本）
  const zcopy = path.join(SANDBOX, 'zcode-copy.sqlite');
  for (const ext of ['', '-wal', '-shm']) {
    const s = zcode.dbPath() + ext;
    if (fs.existsSync(s)) fs.copyFileSync(s, zcopy + ext);
  }
  const r3 = zcode.writeSession(claudeMsx, { cwd: projA, dbFile: zcopy });
  const back3 = zcode.readSession(r3.id, { dbFile: zcopy });
  console.log(`  claude→zcode(副本): messages=${back3.stats.entries} user=${back3.stats.userTurns} tools=${back3.stats.toolCalls}`);
  if (back3.stats.userTurns === 0) throw new Error('zcode 回读无用户消息');

  // codex → workbuddy（db 副本 + projects 沙盒）
  const wcopy = path.join(SANDBOX, 'workbuddy-copy.db');
  fs.copyFileSync(workbuddy.dbPath(wbBase), wcopy);
  const r4 = workbuddy.writeSession(codexMsx, { cwd: projA, dbFile: wcopy, projectsDir: path.join(SANDBOX, 'wb-projects') });
  const back4 = await workbuddy.readSession(r4.path);
  console.log(`  codex→workbuddy(副本): lines=${r4.count} 回读entries=${back4.stats.entries} user=${back4.stats.userTurns}`);

  // workbuddy T0 同源复制（db 副本 + 沙盒 projectsDir；新 id 文件 + sessions 行克隆 + sessionId 字段重写）
  const wbT0 = workbuddy.copySession(r4.id, { dbFile: wcopy, projectsDir: path.join(SANDBOX, 'wb-projects') });
  const wbT0Lines = JSON.parse(require('fs').readFileSync(wbT0.path, 'utf8').trim().split('\n')[0]);
  const wbT0Db = new (require('node:sqlite').DatabaseSync)(wcopy);
  const wbT0Rows = wbT0Db.prepare('SELECT count(*) c FROM sessions WHERE id = ?').get(wbT0.id).c;
  const wbT0Dup = wbT0Db.prepare('SELECT count(*) c FROM sessions WHERE id = ?').get(r4.id).c;
  wbT0Db.close();
  if (wbT0Rows !== 1 || wbT0Dup !== 1 || wbT0Lines.sessionId !== wbT0.id) throw new Error('workbuddy T0 克隆异常');
  console.log(`  workbuddy T0: 新id=${wbT0.id.slice(0, 8)} lines=${wbT0.count} sessions行=1 源保留=1`);
  // 用副本文件直接读回验证内容一致
  const wbT0Read = await workbuddy.readSession(wbT0.path);
  if (wbT0Read.entries.length !== back4.stats.entries) throw new Error('workbuddy T0 回读条数不一致');

  // zcode → claude
  const r5 = claude.writeSession(zcodeMsx, { cwd: projA });
  const back5 = claude.readSession(r5.id);
  console.log(`  zcode→claude: entries=${back5.stats.entries} user=${back5.stats.userTurns} thinking=${back5.stats.thinking}`);

  // workbuddy → codex
  const r6 = codex.writeSession(wbMsx, { cwd: projA });
  fs.rmSync(path.dirname(r6.path), { recursive: true, force: true });
  console.log(`  workbuddy→codex: 合成成功`);

  // vscode（VS Code Copilot 只读适配器）：合成 transcript → doctor/list/read
  const vsc = require('../server/core/vscode');
  const vscRoot = path.join(SANDBOX, 'vscode-storage');
  const vscHash = path.join(vscRoot, 'demohash');
  fs.mkdirSync(path.join(vscHash, 'GitHub.copilot-chat', 'transcripts'), { recursive: true });
  fs.writeFileSync(path.join(vscHash, 'workspace.json'), JSON.stringify({ folder: 'file:///c%3A/demo/shop-frontend' }));
  const ev = [];
  let vts = Date.now() - 60000;
  const vline = (type, data) => ev.push(JSON.stringify({ id: 'v' + ev.length, timestamp: new Date((vts += 3000)).toISOString(), parentId: null, type, data }));
  vline('session.start', { sessionId: 'demo-vscode-1', copilotVersion: '0.44.0', vscodeVersion: '1.116.0', startTime: new Date(vts).toISOString() });
  vline('user.message', { content: '帮我看看这个函数为什么超时', attachments: [] });
  vline('assistant.message', { content: '先读一下实现。' });
  vline('tool.execution_start', { toolCallId: 'call_demo_v1', toolName: 'read_file', arguments: { filePath: 'c:\\demo\\x.ts' } });
  vline('tool.execution_complete', { toolCallId: 'call_demo_v1', success: true });
  vline('assistant.message', { content: '找到问题了：循环里每次都重新建连接。' });
  fs.writeFileSync(path.join(vscHash, 'GitHub.copilot-chat', 'transcripts', 'demo-vscode-1.jsonl'), ev.join('\n') + '\n');
  const vDoc = vsc.doctor(vscRoot);
  const vList = vsc.listSessions(vscRoot);
  if (!vDoc.ok || vList.length !== 1) throw new Error('vscode doctor/list 异常');
  const vMsx = await vsc.readSession('demo-vscode-1', vscRoot);
  if (vMsx.project.cwd !== 'c:/demo/shop-frontend' || vMsx.stats.entries < 5) throw new Error('vscode readSession 异常');
  if (!vMsx.entries.some((e) => (e.blocks || []).some((b) => b.type === 'tool_use'))) throw new Error('vscode tool_use 缺失');
  console.log(`  vscode: ${vList.length} 会话, read=${vMsx.stats.entries}条 cwd=${vMsx.project.cwd}`);

  // opencode T0（真实库副本上克隆：session 行 + 子表行数一致 + 回读非空）
  const opencode = require('../server/core/opencode');
  const ocopy = path.join(SANDBOX, 'opencode-copy.db');
  for (const ext of ['', '-wal', '-shm']) {
    const s = opencode.dbPath(null) + ext;
    if (fs.existsSync(s)) fs.copyFileSync(s, ocopy + ext);
  }
  const oSrc = opencode.listSessions()[0];
  const oT0 = opencode.copySession(oSrc.id, { dbFile: ocopy });
  const odb = new (require('node:sqlite').DatabaseSync)(ocopy);
  const oSrcParts = odb.prepare('SELECT count(*) c FROM part WHERE session_id = ?').get(oSrc.id).c;
  const oNewParts = odb.prepare('SELECT count(*) c FROM part WHERE session_id = ?').get(oT0.id).c;
  const oNewSess = odb.prepare('SELECT count(*) c FROM session WHERE id = ?').get(oT0.id).c;
  odb.close();
  if (!oNewSess || !oSrcParts || oNewParts !== oSrcParts) throw new Error('opencode T0 子表克隆行数不一致');
  const oBack = await opencode.readSession(oT0.id, { dbFile: ocopy });
  if (!oBack.entries.length) throw new Error('opencode T0 回读为空');
  console.log(`  opencode T0: parts=${oNewParts}/${oSrcParts} 回读=${oBack.stats.entries}条`);

  // ---------- 新增 T1/T0 写入器（全部沙盒目录，回读验证） ----------
  const gemini = require('../server/core/gemini');
  const pi = require('../server/core/pi');
  const openclaw = require('../server/core/openclaw');
  const dsh = require('../server/core/dsh');
  const sbGemini = path.join(SANDBOX, 'gemini-home');
  const sbPi = path.join(SANDBOX, 'pi-home');
  const sbClaw = path.join(SANDBOX, 'openclaw-home');
  const sbDsh = path.join(SANDBOX, 'dsh-home');

  // claude → gemini（slug 解析 + 往返）
  const rGem = await gemini.writeSession(claudeMsx, { cwd: projA, baseDir: sbGemini });
  const gemLines = fs.readFileSync(rGem.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  if (gemLines[0].sessionId !== rGem.id || gemLines[0].kind !== 'main') throw new Error('gemini meta 行异常');
  const gemBack = await gemini.readSession(rGem.id, sbGemini);
  if (gemBack.stats.userTurns === 0) throw new Error('gemini 回读无用户消息');
  if (!gemBack.entries.some((e) => (e.blocks || []).some((b) => b.type === 'tool_use'))) throw new Error('gemini 回读缺 tool_use');
  const slug2 = gemini.slugFor(projA, sbGemini);
  const writtenSlug = path.basename(path.dirname(path.dirname(rGem.path)));
  if (slug2 !== writtenSlug) throw new Error('gemini slug 与落盘目录不一致');
  if (fs.readFileSync(path.join(gemini.geminiRoot(sbGemini), writtenSlug, '.project_root'), 'utf8') !== path.resolve(projA)) throw new Error('gemini .project_root 未写入 cwd');
  console.log(`  claude→gemini: ${gemLines.length} 行, 回读=${gemBack.stats.entries}条, slug=${slug2.slice(0, 10)}…`);

  // claude → pi（parentId 链 + toolResult role 往返）
  const rPi = await pi.writeSession(claudeMsx, { cwd: projA, baseDir: sbPi });
  const piBack = await pi.readSession(rPi.id, sbPi);
  if (piBack.stats.userTurns === 0 || piBack.stats.toolCalls === 0) throw new Error('pi 回读缺用户消息/工具调用');
  console.log(`  claude→pi: 回读=${piBack.stats.entries}条 tools=${piBack.stats.toolCalls}`);

  // codex → openclaw
  const rClaw = await openclaw.writeSession(codexMsx, { cwd: projA, baseDir: sbClaw });
  const clawBack = await openclaw.readSession(rClaw.id, sbClaw);
  if (clawBack.stats.userTurns === 0) throw new Error('openclaw 回读无用户消息');
  console.log(`  codex→openclaw: 回读=${clawBack.stats.entries}条 dir=${path.dirname(rClaw.path)}`);

  // claude → dsh（zstd 压缩往返）
  const rDsh = await dsh.writeSession(claudeMsx, { cwd: projA, baseDir: sbDsh });
  if (!rDsh.path.endsWith('.zstd')) throw new Error('dsh 应写 zstd 文件');
  const dshBack = await dsh.readSession(rDsh.id, sbDsh);
  if (dshBack.stats.userTurns === 0 || dshBack.stats.toolCalls === 0) throw new Error('dsh 回读缺内容');
  console.log(`  claude→dsh: 回读=${dshBack.stats.entries}条 tools=${dshBack.stats.toolCalls} (zstd)`);

  // T0 原生复制（gemini/pi/openclaw/dsh 沙盒内 + 源不可变断言）
  const dshSrcBefore = fs.statSync(rDsh.path).mtimeMs;
  const t0Gem = gemini.rawCopy(rGem.id, { baseDir: sbGemini });
  if (!fs.existsSync(t0Gem.path) || t0Gem.id === rGem.id) throw new Error('gemini T0 异常');
  const t0Pi = pi.rawCopy(rPi.id, { baseDir: sbPi });
  const t0Claw = openclaw.rawCopy(rClaw.id, { baseDir: sbClaw });
  const t0Dsh = dsh.rawCopy(rDsh.id, { baseDir: sbDsh });
  if (fs.statSync(rDsh.path).mtimeMs !== dshSrcBefore) throw new Error('T0 修改了源会话（违反不可变约定）');
  const dshT0Back = await dsh.readSession(t0Dsh.id, sbDsh);
  if (dshT0Back.stats.userTurns === 0) throw new Error('dsh T0 副本回读失败');
  console.log(`  T0: gemini/pi/openclaw/dsh 复制成功，源 mtime 未变`);

  // vscode T1（复用上面的合成 workspace fixture）
  const rVsc = await vsc.writeSession(codexMsx, { cwd: 'c:/demo/shop-frontend', baseDir: vscRoot });
  const vscList2 = vsc.listSessions(vscRoot);
  if (!vscList2.find((s) => s.id === rVsc.id)) throw new Error('vscode T1 写入后未出现在列表');
  const vscBack = await vsc.readSession(rVsc.id, vscRoot);
  if (vscBack.stats.entries === 0) throw new Error('vscode T1 回读为空');
  const vscSrcBefore = fs.statSync(path.join(vscHash, 'GitHub.copilot-chat', 'transcripts', 'demo-vscode-1.jsonl')).mtimeMs;
  const t0Vsc = vsc.rawCopy('demo-vscode-1', { baseDir: vscRoot });
  if (fs.statSync(path.join(vscHash, 'GitHub.copilot-chat', 'transcripts', 'demo-vscode-1.jsonl')).mtimeMs !== vscSrcBefore) throw new Error('vscode T0 修改了源');
  console.log(`  codex→vscode T1: 回读=${vscBack.stats.entries}条; T0 副本=${t0Vsc.id.slice(0, 8)}…`);

  // cursor（合成 fixture：Gen B composerData/bubbleId + Gen C composerHeaders 表 + workspace 映射）
  const cur = require('../server/core/cursor');
  const { DatabaseSync } = require('node:sqlite');
  const curGlobal = path.join(SANDBOX, 'cursor', 'User', 'globalStorage');
  fs.mkdirSync(curGlobal, { recursive: true });
  const curWsRoot = path.join(SANDBOX, 'cursor', 'User', 'workspaceStorage');
  const curHash = path.join(curWsRoot, 'wshash');
  fs.mkdirSync(curHash, { recursive: true });
  fs.writeFileSync(path.join(curHash, 'workspace.json'), JSON.stringify({ folder: 'file:///c%3A/demo/shop-frontend' }));
  const cdbFile = path.join(curGlobal, 'state.vscdb');
  const cdb = new DatabaseSync(cdbFile);
  cdb.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
  cdb.exec('CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, value TEXT)');
  const insKV = cdb.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
  const cid1 = 'cid-demo-1';
  insKV.run(`composerData:${cid1}`, JSON.stringify({ name: '暗色主题改造', isAgentic: true, fullConversationHeadersOnly: [{ bubbleId: 'b1', type: 1 }, { bubbleId: 'b2', type: 2 }, { bubbleId: 'b3', type: 2 }] }));
  insKV.run(`bubbleId:${cid1}:b1`, JSON.stringify({ type: 1, text: '帮我把首页改成暗色' }));
  insKV.run(`bubbleId:${cid1}:b2`, JSON.stringify({ type: 2, text: '', toolFormerData: { name: 'read_file', rawArgs: JSON.stringify({ path: 'src/a.ts' }), result: 'const x = 1;', status: 'success', toolCallId: 'call-1' } }));
  insKV.run(`bubbleId:${cid1}:b3`, JSON.stringify({ type: 2, text: '已定位主题变量，开始改造。' }));
  cdb.prepare('INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, value) VALUES (?, ?, ?, ?, 0, 0, ?, ?)').run(cid1, 'wshash', Date.now(), Date.now(), Date.now(), JSON.stringify({ name: '暗色主题改造', fullConversationHeadersOnly: [{ bubbleId: 'b1', type: 1 }, { bubbleId: 'b2', type: 2 }, { bubbleId: 'b3', type: 2 }] }));
  cdb.close();
  const curDoc = cur.doctor(curGlobal);
  if (!curDoc.ok) throw new Error('cursor doctor 异常');
  const curMsx = await cur.readSession(cid1, curGlobal);
  if (curMsx.project.cwd !== 'c:/demo/shop-frontend') throw new Error('cursor cwd 反解失败: ' + curMsx.project.cwd);
  if (curMsx.stats.userTurns === 0 || curMsx.stats.toolCalls === 0 || curMsx.stats.toolResults === 0) throw new Error('cursor 回读缺 user/tool 内容');
  // T1 写入（composerData + bubbles + composerHeaders 行）
  const rCur = await cur.writeSession(claudeMsx, { cwd: 'c:/demo/shop-frontend', baseDir: curGlobal });
  const curBack = await cur.readSession(rCur.id, curGlobal);
  if (curBack.stats.userTurns === 0) throw new Error('cursor T1 回读无用户消息');
  const cdb2 = new DatabaseSync(cdbFile, { readOnly: true });
  const hdr = cdb2.prepare('SELECT count(*) c FROM composerHeaders WHERE composerId = ?').get(rCur.id);
  const cdata = JSON.parse(cdb2.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${rCur.id}`).value);
  cdb2.close();
  if (hdr.c !== 1 || !Array.isArray(cdata.fullConversationHeadersOnly) || cdata.fullConversationHeadersOnly.length === 0) throw new Error('cursor T1 注册不完整');
  console.log(`  claude→cursor T1: 回读=${curBack.stats.entries}条, composerHeaders=1, bubbles=${cdata.fullConversationHeadersOnly.length}`);

  // 选择器
  const { selectEntries, redactMsx, computeStats } = require('../server/core/msx');
  const loss = [];
  const sel = selectEntries(zcodeMsx.entries, { from: 2, includeThinking: false, budgetTokens: 3000, truncateToolOutputKB: 4 }, loss);
  const st = computeStats(sel);
  console.log(`  选择器: ${zcodeMsx.entries.length}→${sel.length} tokens≈${st.approxTokens} loss=${loss.length}条`);
  const red = redactMsx({ ...zcodeMsx, entries: sel });
  console.log(`  脱敏: redactions done`);

  // ---------- bundle：导出 → 清单 → 重映射 → 导入 dry-run（不落盘） ----------
  const bundle = require('../server/core/bundle');
  const bundleFile = path.join(SANDBOX, 'test.arxbundle');
  const exp = await bundle.exportBundle({
    items: [
      { sourceAgent: 'claude', sessionId: claudeSess.id },
      { sourceAgent: 'codex', sessionId: codexSess.id },
    ],
    options: {}, out: bundleFile,
  });
  if (exp.count !== 2) throw new Error('bundle 导出条数异常');
  const insp = await bundle.inspectBundle(bundleFile);
  if (insp.sessions.length !== 2 || !insp.sessions.every((s) => s.cwd && s.title)) throw new Error('bundle 清单异常: ' + JSON.stringify(insp.sessions));
  const rc = bundle.remapCwd('D:/work/app', [{ from: 'D:/work', to: '/Users/x/work' }]);
  const rc2 = bundle.remapCwd('D:/worker', [{ from: 'D:/work', to: '/Users/x/work' }]);
  if (rc !== '/Users/x/work/app' || rc2 !== 'D:/worker') throw new Error(`remapCwd 异常: ${rc} / ${rc2}`);
  const importResults = await bundle.importBundle({
    file: bundleFile,
    remap: insp.sessions.map((s) => ({ from: s.cwd, to: projA })),
    targets: [{ agent: 'gemini', cwd: projA }],
    dryRun: true,
  });
  if (!importResults.length || !importResults.every((r) => r.ok && r.fidelity)) throw new Error('bundle 导入 dry-run 异常');
  console.log(`  bundle: 导出2→清单2→remap ok→dry-run 导入 ${importResults.length} 条 (fidelity tier=${importResults[0].fidelity.tier})`);

  // bundle 实导入（非 dry-run）：gemini 沙盒会话 → 导出 → 导入回另一个 gemini 沙盒目录 → 回读
  // （本机未安装 gemini，注册表读不到 → 用 it.msx 直通）
  const sbGemini2 = path.join(SANDBOX, 'gemini-home-2');
  const gemSrc = await gemini.readSession(rGem.id, sbGemini);
  const exp2 = await bundle.exportBundle({ items: [{ msx: gemSrc }], options: {}, out: path.join(SANDBOX, 't2.arxbundle') });
  const imp2 = await bundle.importBundle({
    file: exp2.file, remap: [], targets: [{ agent: 'gemini', cwd: projA, baseDir: sbGemini2 }],
    dryRun: false, backup: false,
  });
  if (!imp2.length || !imp2.every((r) => r.ok) || !fs.existsSync(imp2[0].path)) throw new Error('bundle 实导入失败');
  const imp2Back = await gemini.readSession(imp2[0].id, sbGemini2);
  if (imp2Back.stats.userTurns === 0) throw new Error('bundle 实导入回读为空');
  console.log(`  bundle 实导入: ${imp2.length} 条 ok, 回读=${imp2Back.stats.entries}条`);

  // only 过滤：只导第 2 个会话 → 结果只有 1 条
  const impOnly = await bundle.importBundle({
    file: bundleFile, remap: insp.sessions.map((s) => ({ from: s.cwd, to: projA })),
    targets: [{ agent: 'gemini', cwd: projA }], dryRun: true, only: [1],
  });
  if (impOnly.length !== 1) throw new Error('bundle only 过滤失效: ' + impOnly.length);
  console.log(`  bundle only:[1] → ${impOnly.length} 条 ✓`);

  // 多字节跨块：3MB CJK 文本会话导出→清单→文本逐字比对（StringDecoder 修复回归）
  const cjk = '中'.repeat(400000) + 'a🎉b' + '文'.repeat(400000);
  const bigBundle = path.join(SANDBOX, 'big.arxbundle');
  const fakeBig = {
    arx: 1, id: 'big1', created_at: nowIso(), source: { agent: 'gemini', session_id: 'big1', title: 'big' },
    project: { cwd: projA }, env: {},
    stats: { entries: 1, userTurns: 1, assistantEntries: 0, toolCalls: 0, toolResults: 0, thinking: 0, approxTokens: 0 },
    entries: [{ id: 'e1', ts: null, role: 'user', kind: 'text', blocks: [{ type: 'text', text: cjk }], meta: {} }],
    compactions: [], loss: [],
  };
  fs.writeFileSync(bigBundle, '{"arxBundle":1,"version":1,"created_at":"2026-11-04T00:00:00.000Z","source_app":"AgentRelay","sessions":[' + JSON.stringify(fakeBig) + ']}');
  let bigText = null;
  await bundle.scanBundleRaw(bigBundle, { onSession: async (m) => { bigText = m.entries[0].blocks[0].text; } });
  if (bigText !== cjk) {
    let diff = 0; while (diff < cjk.length && bigText[diff] === cjk[diff]) diff++;
    throw new Error(`多字节跨块损坏: 首个差异在 ${diff}, got ${JSON.stringify((bigText || '')[diff])}`);
  }
  const bigInspect = await bundle.inspectBundle(bigBundle);
  if (bigInspect.sessions[0].entries !== 1) throw new Error('大 bundle 清单异常');
  console.log(`  bundle 多字节跨块: ${(cjk.length / 1e6).toFixed(1)}M chars 逐字一致 ✓`);

  // 导出失败不留半截文件
  const badOut = path.join(SANDBOX, 'never.arxbundle');
  let exportThrew = false;
  try { await bundle.exportBundle({ items: [{ sourceAgent: 'claude', sessionId: 'nonexistent-id-xyz' }], out: badOut }); } catch { exportThrew = true; }
  if (!exportThrew || fs.existsSync(badOut)) throw new Error('导出失败应抛错且不残留文件');
  console.log(`  bundle 导出失败路径: 抛错且无残留 ✓`);

  // agent id 别名（老导出文件 claude-code / vscode-copilot）：T0 同源判断不被别名破坏
  const aliasMsx = (agent) => ({
    arx: 1, id: 'a1', created_at: nowIso(), source: { agent, session_id: 's1', title: 't' },
    project: { cwd: projA }, env: {},
    stats: { entries: 1, userTurns: 1, assistantEntries: 0, toolCalls: 0, toolResults: 0, thinking: 0, approxTokens: 0 },
    entries: [{ id: 'e1', ts: null, role: 'user', kind: 'text', blocks: [{ type: 'text', text: 'hi' }], meta: {} }],
    compactions: [], loss: [],
  });
  for (const [alias, target] of [['claude-code', 'claude'], ['vscode-copilot', 'vscode']]) {
    const f = path.join(SANDBOX, `alias-${target}.arxbundle`);
    fs.writeFileSync(f, '{"arxBundle":1,"version":1,"sessions":[' + JSON.stringify(aliasMsx(alias)) + ']}');
    // 显式 T0：别名不归一时 targetAgent !== sourceAgent 会直接报"仅支持同源"——这才是回归点
    const r = await bundle.importBundle({ file: f, targets: [{ agent: target, cwd: projA, mode: 'T0' }], dryRun: true });
    if (!r.length || !r.every((x) => x.ok)) throw new Error(`别名 ${alias} T0 dry-run 失败: ${JSON.stringify(r.map((x) => x.error))}`);
    if (!r[0].notes || !r[0].notes.some((n) => n.includes('T1 原生注入等价'))) throw new Error('bundle T0 强制降级未说明');
  }
  console.log(`  别名归一 + T0 强制降级: claude-code→claude / vscode-copilot→vscode ✓`);

  // Cursor 并行工具调用：一 assistant 条目 2 个 tool_use → 2 个独立 bubble → 回读 toolCalls=2
  const paraMsx = {
    arx: 1, id: 'p1', created_at: nowIso(), source: { agent: 'claude', session_id: 'p1', title: 'para' },
    project: { cwd: 'c:/demo/shop-frontend' }, env: {},
    stats: { entries: 3, userTurns: 1, assistantEntries: 1, toolCalls: 2, toolResults: 2, thinking: 0, approxTokens: 0 },
    entries: [
      { id: 'e1', ts: null, role: 'user', kind: 'text', blocks: [{ type: 'text', text: '并行读两个文件' }], meta: {} },
      { id: 'e2', ts: null, role: 'assistant', kind: 'text', blocks: [
        { type: 'tool_use', id: 'callA', name: 'read_file', input: { p: 'a.ts' } },
        { type: 'tool_use', id: 'callB', name: 'grep', input: { q: 'x' } },
      ], meta: {} },
      { id: 'r1', ts: null, role: 'user', kind: 'tool-result', blocks: [{ type: 'tool_result', for: 'callA', output: 'AAA', isError: false }], meta: {} },
      { id: 'r2', ts: null, role: 'user', kind: 'tool-result', blocks: [{ type: 'tool_result', for: 'callB', output: 'BBB', isError: true }], meta: {} },
    ],
    compactions: [], loss: [],
  };
  const rPara = await cur.writeSession(paraMsx, { cwd: 'c:/demo/shop-frontend', baseDir: curGlobal });
  const paraBack = await cur.readSession(rPara.id, curGlobal);
  const paraToolCalls = paraBack.entries.filter((e) => e.role === 'assistant').flatMap((e) => e.blocks).filter((b) => b.type === 'tool_use');
  if (paraToolCalls.length !== 2) throw new Error(`cursor 并行工具调用丢失: 只回读 ${paraToolCalls.length}`);
  const paraResults = paraBack.entries.filter((e) => e.kind === 'tool-result').flatMap((e) => e.blocks);
  if (!paraResults.find((b) => b.output === 'AAA') || !paraResults.find((b) => b.output === 'BBB')) throw new Error('cursor 并行工具结果丢失');
  console.log(`  cursor 并行 tool_use: 2 调用 + 2 结果（含 error 标记）回读 ✓`);

  // transferOne 通用派发：dry-run 验证新目标 agent 的 T1 报告与 fidelity
  const t1 = await require('../server/core/transfer').transferOne({
    sourceAgent: 'claude', sessionId: claudeSess.id, targetAgent: 'dsh', cwd: projA, mode: 'T1', dryRun: true,
  });
  if (!t1.ok || !t1.notes[0].includes('dsh')) throw new Error('transferOne dsh dry-run 异常');
  const t1bad = await require('../server/core/transfer').transferOne({
    sourceAgent: 'claude', sessionId: claudeSess.id, targetAgent: 'nonexistent', cwd: projA, mode: 'T1', dryRun: true,
  });
  if (t1bad.ok || !/未知目标/.test(t1bad.error)) throw new Error('未知目标 agent 未报错');
  console.log(`  transfer 派发: dsh dry-run ok, 未知 agent 正确报错`);

  // ---------- 会话上下文编辑器：applySessionEdits + claude/zcode 就地保存 ----------
  const { applySessionEdits } = require('../server/core/msx');
  const eSrc = { arx: 1, id: 'e1', entries: claudeMsx.entries, source: claudeMsx.source, project: claudeMsx.project, stats: claudeMsx.stats, loss: [], compactions: [] };
  const delTarget = eSrc.entries[1];
  const pairCall = eSrc.entries.find((e) => (e.blocks || []).some((b) => b.type === 'tool_use'));
  const callId = pairCall && pairCall.blocks.find((b) => b.type === 'tool_use').id;
  const eEdited = applySessionEdits(eSrc, {
    removals: [delTarget.id, 'nonexistent-id'],
    edits: [{ id: eSrc.entries[0].id, text: '【编辑测试】改写后的首条' }],
    inserts: [
      { afterId: eSrc.entries[0].id, entry: { role: 'user', blocks: [{ type: 'text', text: '【插入测试】用户补充' }] } },
      { afterId: eSrc.entries[0].id, entry: { role: 'meta', blocks: [{ type: 'text', text: 'meta 会被归一化为用户' }] } },
      ...(callId ? [{ afterId: pairCall.id, entry: { role: 'assistant', blocks: [{ type: 'tool_use', id: 'ins_call_1', name: 'read_file', input: { p: 1 } }] } },
        { afterId: pairCall.id, entry: { role: 'user', kind: 'tool-result', blocks: [{ type: 'tool_result', for: 'ins_call_1', output: 'OK', isError: false }] } }] : []),
    ],
  });
  const es = eEdited._editSummary;
  if (es.removed !== 1 || es.edited !== 1 || es.inserted !== (callId ? 4 : 2)) throw new Error('applySessionEdits 计数异常: ' + JSON.stringify(es));
  if (eEdited.entries.some((e) => e.id === delTarget.id)) throw new Error('删除未生效');
  if (!eEdited.entries[0].blocks[0].text.includes('【编辑测试】')) throw new Error('编辑未生效');
  if (eEdited.entries.some((e) => e.role === 'meta')) throw new Error('插入的 meta 未归一化为 user');
  if (callId) {
    const ci = eEdited.entries.findIndex((e) => (e.blocks || []).some((b) => b.type === 'tool_use' && b.id === 'ins_call_1'));
    const ri = eEdited.entries.findIndex((e) => (e.blocks || []).some((b) => b.type === 'tool_result' && b.for === 'ins_call_1'));
    if (ci === -1 || ri === -1 || ri !== ci + 1) throw new Error(`工具对插入顺序异常: call=${ci} result=${ri}`);
  }
  const backEdit = claude.writeSession(eEdited, { cwd: projA });
  const backEditRead = claude.readSession(backEdit.id);
  // 写读条数允许有差（writer 会跳过 meta/system 条目并记 loss），关键是编辑/插入的内容在回读中原样存在
  const rHasEdit = backEditRead.entries.some((e) => (e.blocks || []).some((b) => (b.text || '').includes('【编辑测试】')));
  const rHasIns = backEditRead.entries.some((e) => (e.blocks || []).some((b) => (b.text || '').includes('【插入测试】用户补充')));
  const rDelGone = !backEditRead.entries.some((e) => e.id === delTarget.id) && !backEditRead.entries.some((e) => (e.blocks || []).some((b) => JSON.stringify(b).includes('【删除标记验证】')));
  if (!rHasEdit || !rHasIns) throw new Error('claude 编辑/插入未生效');
  if (!rDelGone) throw new Error('claude 删除未生效');
  console.log(`  编辑器: applySessionEdits 删/改/插/归一化 ✓, claude 写读 ${backEditRead.stats.entries} 条（含 loss 跳过） ✓`);

  // zcode 就地保存（副本库 + 真实会话）
  const zEdCopy = path.join(SANDBOX, 'editor-z', 'cli', 'db', 'db.sqlite');
  fs.mkdirSync(path.dirname(zEdCopy), { recursive: true });
  for (const ext of ['', '-wal', '-shm']) {
    const s = zcode.dbPath() + ext;
    if (fs.existsSync(s)) fs.copyFileSync(s, zEdCopy + ext);
  }
  const zCand = (() => {
    const p = new DatabaseSync(zEdCopy, { readOnly: true });
    const row = p.prepare("SELECT s.id FROM session s WHERE EXISTS(SELECT 1 FROM message m WHERE m.session_id = s.id) ORDER BY s.time_updated DESC LIMIT 1").get();
    p.close();
    return row;
  })();
  if (zCand) {
    const zMsx = await zcode.readSession(zCand.id, { dbFile: zEdCopy });
    const zEdited = applySessionEdits(zMsx, {
      edits: zMsx.entries[1] ? [{ id: zMsx.entries[1].id, text: '【zcode 就地编辑测试】' }] : [],
      inserts: [{ afterId: null, entry: { role: 'user', blocks: [{ type: 'text', text: '【zcode 插入测试】' }] } }],
    });
    const zr = zcode.saveSessionInPlace(zCand.id, zEdited, { baseDir: path.join(SANDBOX, 'editor-z') });
    if (!zr.backup) throw new Error('zcode 就地保存未备份');
    const zBack = await zcode.readSession(zCand.id, { dbFile: zEdCopy });
    const zEditOk = zBack.entries.some((e) => (e.blocks || []).some((b) => (b.text || '').includes('【zcode 就地编辑测试】')));
    const zInsOk = zBack.entries.some((e) => (e.blocks || []).some((b) => (b.text || '').includes('【zcode 插入测试】')));
    if (!zEditOk || !zInsOk) throw new Error('zcode 就地编辑未生效');
    const tmpLeft = (() => {
      const p = new DatabaseSync(zEdCopy, { readOnly: true });
      const c = p.prepare("SELECT count(*) c FROM session WHERE id LIKE 'sess_relaytmp%'").get().c;
      p.close();
      return c;
    })();
    if (tmpLeft) throw new Error('zcode 交换残留临时行');
    console.log(`  zcode 就地编辑: 删/改/插生效, 无残留 ✓`);
  }

  // claude 就地保存（slug 错位场景：原文件在非标准 slug 目录也能写回原位，不产生双副本）
  const claudeHome = path.join(SANDBOX, 'claude-home');
  const placed2 = claude.writeSession(codexMsx, { cwd: projA, baseDir: claudeHome });
  const misplacedDir = path.join(claudeHome, 'projects', 'weird-slug-dir');
  fs.mkdirSync(misplacedDir, { recursive: true });
  fs.renameSync(placed2.path, path.join(misplacedDir, placed2.id + '.jsonl'));
  const cEdited = applySessionEdits(claudeMsx, { edits: [{ id: claudeMsx.entries[0].id, text: '【claude 就地编辑测试】' }] });
  const cSaved = claude.saveSessionInPlace(placed2.id, cEdited, { baseDir: claudeHome });
  if (path.dirname(cSaved.path) !== misplacedDir) throw new Error('claude 就地保存 slug 错位未写回原位: ' + cSaved.path);
  const cFileText = fs.readFileSync(cSaved.path, 'utf8');
  if (!cFileText.includes('【claude 就地编辑测试】')) throw new Error('claude 就地编辑未生效');
  const strayCopies = fs.readdirSync(path.join(claudeHome, 'projects', projA.replace(/[^a-zA-Z0-9]/g, '-'))).filter((f) => f === placed2.id + '.jsonl');
  if (strayCopies.length) throw new Error('claude 就地保存产生了同 id 双副本');
  console.log(`  claude 就地编辑: slug 错位写回原位, 无双副本 ✓`);

  // claude passthrough 保真：sidechain/attachment/元数据行在写入后原样保留（锚定与顺延两种路径都验）
  const ptSource = {
    arx: 1, id: 'pt-test', created_at: nowIso(),
    source: { agent: 'claude-code', agent_version: null, session_id: 'pt-src', title: 'passthrough 测试' },
    project: { cwd: projA }, env: { model: null },
    stats: require('../server/core/msx').computeStats([]), entries: [
      { id: '11111111-1111-4111-8111-111111111111', ts: nowIso(), role: 'user', kind: 'text', blocks: [{ type: 'text', text: '主链第一条' }], meta: {} },
      { id: '22222222-2222-4222-8222-222222222222', ts: nowIso(), role: 'user', kind: 'text', blocks: [{ type: 'text', text: '主链第二条' }], meta: {} },
    ], compactions: [], loss: [],
    _passthrough: [
      { after: '11111111-1111-4111-8111-111111111111', line: { type: 'user', isSidechain: true, uuid: 'aaaa1111-0000-4000-8000-000000000001', parentUuid: null, timestamp: nowIso(), message: { role: 'user', content: '子代理行' }, sessionId: 'old' } },
      { after: '11111111-1111-4111-8111-111111111111', line: { type: 'file-history-snapshot', timestamp: nowIso(), messageId: 'm1' } },
      { after: '__END__', line: { type: 'attachment', timestamp: nowIso(), attachment: { type: 'path' }, sessionId: 'old' } },
    ],
  };
  const ptPath = claude.writeSession(ptSource, { cwd: projA, newId: 'pt-dst-test' });
  const ptLines = fs.readFileSync(ptPath.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ptSide = ptLines.filter((o) => o.isSidechain);
  const ptSnap = ptLines.filter((o) => o.type === 'file-history-snapshot');
  const ptAtt = ptLines.filter((o) => o.type === 'attachment');
  const ptMainIdx = ptLines.findIndex((o) => o.uuid === '22222222-2222-4222-8222-222222222222');
  const ptSideIdx = ptLines.findIndex((o) => o.isSidechain);
  if (ptSide.length !== 1 || ptSnap.length !== 1 || ptAtt.length !== 1) throw new Error('passthrough 行数不符');
  if (ptLines.find((o) => o.isSidechain).sessionId !== 'pt-dst-test') throw new Error('passthrough sessionId 未重写');
  if (!(ptSideIdx > -1 && ptSideIdx < ptMainIdx)) throw new Error('锚定位置错误（sidechain 应在第二条主链之前）');
  if (ptLines.findIndex((o) => o.type === 'attachment') < ptMainIdx) throw new Error('尾部锚点位置错误');
  const ptBack = claude.readSession(ptPath.path);
  if (!ptBack._passthrough || ptBack._passthrough.length !== 3) throw new Error('passthrough 读回不完整: ' + (ptBack._passthrough || []).length);
  fs.rmSync(ptPath.path, { force: true });
  console.log(`  claude passthrough: sidechain/元数据/attachment 原样保留, 锚点与尾部顺延正确, 读回=3 ✓`);

  // 跨厂商思考块：转为【思考】文本保留（内容不丢）
  const thinkMsx = { ...codexMsx, entries: [{ id: 't1', ts: nowIso(), role: 'assistant', kind: 'text', blocks: [{ type: 'thinking', text: '内部推理过程' }, { type: 'text', text: '结论' }], meta: {} }] };
  const thinkR = claude.writeSession(thinkMsx, { cwd: projA });
  const thinkText = fs.readFileSync(thinkR.path, 'utf8');
  if (!thinkText.includes('【思考】内部推理过程') || !thinkText.includes('结论')) throw new Error('跨厂商思考块未保留');
  fs.rmSync(thinkR.path, { force: true });
  console.log(`  claude 跨厂商思考块: 转为【思考】文本保留 ✓`);

  console.log(`\n结果: 全部断言通过（无 FATAL）`);
  cleanupClaudeSandbox();
  if (out.fail.length) { console.log(out.fail.join('\n')); process.exit(1); }
})().catch((e) => {
  cleanupClaudeSandbox();
  console.error('FATAL', e);
  process.exit(1);
});
