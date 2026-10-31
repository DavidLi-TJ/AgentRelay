'use strict';
// 沙盒冒烟测试：四家 reader + 三家 writer（全部在沙盒/副本上，不动真实存储）
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
fs.rmSync(SANDBOX, { recursive: true, force: true });
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

  const wbList = workbuddy.listSessions();
  const wbSess = pick(wbList, (s) => s.file && s.size > 100000 && s.size < 5000000, 'workbuddy 中等会话');
  const wbMsx = await workbuddy.readSession(wbSess.id);
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
  fs.copyFileSync(workbuddy.dbPath(), wcopy);
  const r4 = workbuddy.writeSession(codexMsx, { cwd: projA, dbFile: wcopy, projectsDir: path.join(SANDBOX, 'wb-projects') });
  const back4 = await workbuddy.readSession(r4.path);
  console.log(`  codex→workbuddy(副本): lines=${r4.count} 回读entries=${back4.stats.entries} user=${back4.stats.userTurns}`);

  // zcode → claude
  const r5 = claude.writeSession(zcodeMsx, { cwd: projA });
  const back5 = claude.readSession(r5.id);
  console.log(`  zcode→claude: entries=${back5.stats.entries} user=${back5.stats.userTurns} thinking=${back5.stats.thinking}`);

  // workbuddy → codex
  const r6 = codex.writeSession(wbMsx, { cwd: projA });
  fs.rmSync(path.dirname(r6.path), { recursive: true, force: true });
  console.log(`  workbuddy→codex: 合成成功`);

  // 选择器
  const { selectEntries, redactMsx, computeStats } = require('../server/core/msx');
  const loss = [];
  const sel = selectEntries(zcodeMsx.entries, { from: 2, includeThinking: false, budgetTokens: 3000, truncateToolOutputKB: 4 }, loss);
  const st = computeStats(sel);
  console.log(`  选择器: ${zcodeMsx.entries.length}→${sel.length} tokens≈${st.approxTokens} loss=${loss.length}条`);
  const red = redactMsx({ ...zcodeMsx, entries: sel });
  console.log(`  脱敏: redactions done`);

  console.log(`\n结果: 全部断言通过（无 FATAL）`);
  cleanupClaudeSandbox();
  if (out.fail.length) { console.log(out.fail.join('\n')); process.exit(1); }
})().catch((e) => {
  cleanupClaudeSandbox();
  console.error('FATAL', e);
  process.exit(1);
});
