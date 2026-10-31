'use strict';
// E2E 真实验证：用旧会话做跨 agent 接力（写真实存储，写前自动备份），并输出每一步证据
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { transferOne } = require('../server/core/transfer');
const codex = require('../server/core/codex');
const claude = require('../server/core/claude');
const zcode = require('../server/core/zcode');

const LOG = [];
// 测试项目目录不写死个人路径：默认用本仓库根目录，可用环境变量 AR_E2E_PROJECT 指向任意真实本地项目
const ROOT = path.resolve(__dirname, '..');
const PROJ_A = process.env.AR_E2E_PROJECT || ROOT;
function log(...a) { const s = a.join(' '); LOG.push(s); console.log(s); }
function hr() { log('─'.repeat(78)); }

function run(cmd, opts = {}) {
  try {
    return { ok: true, out: execSync(cmd, { encoding: 'utf8', timeout: 180000, ...opts }) };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || String(e.message)) };
  }
}

(async () => {
  const results = {};

  // ─────────────────────────────────────────────────────────
  log('【实验 1】ZCode 旧会话 → Codex (T1 原生注入) + codex exec resume 真实验证');
  hr();
  const zList = zcode.listSessions();
  // 选一个中等大小的旧会话（用CodeGraph了解项目及webui结构，2026-08-30）
  const zSrc = zList.find((s) => s.title.includes('用CodeGraph')) || zList.find((s) => (s.msgCount || 0) > 20);
  log(`源: [zcode] "${zSrc.title}" (${zSrc.cwd}, ${zSrc.msgCount} messages)`);
  const r1 = await transferOne({
    sourceAgent: 'zcode', sessionId: zSrc.id, targetAgent: 'codex',
    cwd: ROOT, mode: 'T1', options: { includeMeta: false, truncateToolOutputKB: 32 },
  });
  log(`→ ${r1.ok ? '成功' : '失败'}: id=${r1.id} path=${r1.path}`);
  log(`  resume 命令: ${r1.resumeCommand}`);
  if (r1.loss.length) log(`  转换说明: ${[...new Set(r1.loss)].slice(0, 5).join(' | ')}`);
  const reg = codex.isThreadRegistered(r1.id);
  log(`  threads 注册: ${reg ? '✔ ' + JSON.stringify({ title: reg.title, path: reg.rollout_path }) : '✘'}`);
  results.z2c = { ok: r1.ok && !!reg, id: r1.id, cmd: r1.resumeCommand };
  if (r1.ok) {
    log('  尝试 codex exec resume 真实续接（一次小模型调用）…');
    const rr = run(`codex exec resume ${r1.id} --skip-git-repo-check "请用一句话告诉我你接手前的工作状态，不要做任何操作"`, { cwd: ROOT });
    log(`  codex exec resume: ${rr.ok ? '✔' : '✘'}\n  输出前400字: ${rr.out.slice(0, 400).replace(/\n+/g, ' | ')}`);
    results.z2c.resume = rr.ok;
  }
  hr();

  // ─────────────────────────────────────────────────────────
  log('【实验 2】Codex 旧会话 → Claude Code (T1) + claude --resume 真实验证');
  hr();
  const cList = claude.listSessions();
  const cSmall = codex.listSessions().filter((s) => !s.archived && s.msgCount >= 3 && s.msgCount <= 12)
    .sort((a, b) => a.msgCount - b.msgCount)[0];
  log(`源: [codex] "${cSmall.title}" (${cSmall.cwd})`);
  const r2 = await transferOne({
    sourceAgent: 'codex', sessionId: cSmall.id, targetAgent: 'claude',
    cwd: PROJ_A, mode: 'T1', options: { includeMeta: false, truncateToolOutputKB: 32 },
  });
  log(`→ ${r2.ok ? '成功' : '失败'}: id=${r2.id} path=${r2.path}`);
  const back = claude.readSession(r2.id);
  log(`  回读: ${back.stats.entries} 条, ${back.stats.userTurns} 轮, ${back.stats.toolCalls} 工具调用`);
  results.c2c = { ok: r2.ok && back.stats.userTurns > 0, id: r2.id, cmd: r2.resumeCommand };
  if (r2.ok) {
    log('  尝试 claude --resume 真实续接（一次小模型调用）…');
    const rr = run(`claude -p --resume ${r2.id} --dangerously-skip-permissions "请用一句话告诉我你接手前的工作状态，不要执行任何工具"`, { cwd: PROJ_A });
    log(`  claude --resume: ${rr.ok ? '✔' : '✘'}\n  输出前400字: ${rr.out.slice(0, 400).replace(/\n+/g, ' | ')}`);
    results.c2c.resume = rr.ok;
  }
  hr();

  // ─────────────────────────────────────────────────────────
  log('【实验 3】Claude 会话 → ZCode (T1, 写入 db.sqlite，自动备份)');
  hr();
  const cSrc = cList.find((s) => s.msgCount > 5);
  log(`源: [claude] "${cSrc.title}"`);
  const r3 = await transferOne({
    sourceAgent: 'claude', sessionId: cSrc.id, targetAgent: 'zcode',
    cwd: ROOT, mode: 'T1', options: { includeMeta: false, truncateToolOutputKB: 32 },
  });
  log(`→ ${r3.ok ? '成功' : '失败'}: id=${r3.id}`);
  if (r3.backup) log(`  备份: ${r3.backup}`);
  if (r3.ok) {
    const back3 = zcode.readSession(r3.id);
    log(`  回读: ${back3.stats.entries} 条, ${back3.stats.userTurns} 轮, ${back3.stats.toolCalls} 工具调用`);
    log(`  resume 方式: ${r3.resumeCommand}`);
    results.cl2z = { ok: back3.stats.userTurns > 0, id: r3.id };
  } else log(`  错误: ${r3.error}`);
  hr();

  // ─────────────────────────────────────────────────────────
  log('【实验 4】T0 同源原生复制（100% 保真）');
  hr();
  const r4a = claude.rawCopy(cSrc.id);
  log(`claude T0 复制: ${r4a.id} (${r4a.count} 行) → ${path.basename(path.dirname(r4a.path))}`);
  const back4a = claude.readSession(r4a.id);
  log(`  回读: ${back4a.stats.entries} 条 (源: ${(await import('../server/core/claude.js')).readSession ? '' : ''})`);
  results.t0claude = { ok: back4a.stats.entries > 0, id: r4a.id };
  const r4b = codex.rawCopy(cSmall.id);
  log(`codex T0 复制: ${r4b.id} (${r4b.count} 行)`);
  const reg4b = codex.isThreadRegistered(r4b.id);
  log(`  threads 注册: ${reg4b ? '✔' : '✘'}`);
  results.t0codex = { ok: !!reg4b, id: r4b.id };
  hr();

  // ─────────────────────────────────────────────────────────
  log('【实验 5】WorkBuddy → Claude (T1)');
  hr();
  const wb = require('../server/core/workbuddy');
  const wbSess = wb.listSessions().find((s) => s.title.includes('Vivado'));
  log(`源: [workbuddy] "${wbSess.title}" (${fmtSize(wbSess.size)})`);
  const r5 = await transferOne({
    sourceAgent: 'workbuddy', sessionId: wbSess.id, targetAgent: 'claude',
    cwd: PROJ_A, mode: 'T1', options: { includeMeta: false, truncateToolOutputKB: 16 },
  });
  log(`→ ${r5.ok ? '成功' : '失败'}: id=${r5.id}, ${r5.count} 行`);
  const back5 = claude.readSession(r5.id);
  log(`  回读: ${back5.stats.entries} 条, ${back5.stats.userTurns} 轮, ${back5.stats.toolCalls} 工具调用, ${back5.stats.thinking} 思考`);
  results.wb2c = { ok: r5.ok && back5.stats.userTurns > 0, id: r5.id };
  hr();

  // ─────────────────────────────────────────────────────────
  log('【实验 6】T2 逐字转写注入（zcode 当前会话 → 本项目）');
  hr();
  const r6 = await transferOne({
    sourceAgent: 'zcode', sessionId: zcode.listSessions()[0].id, targetAgent: 'zcode',
    cwd: ROOT, mode: 'T2', options: { includeMeta: false },
  });
  log(`→ ${r6.ok ? '成功' : '失败'}: ${r6.path}`);
  if (r6.ok) {
    const md = fs.readFileSync(r6.path, 'utf8');
    log(`  转写文件: ${(md.length / 1024).toFixed(0)}KB, 逐字记录+工具调用全文`);
    log(`  启动指令: ${r6.resumeCommand.slice(0, 120)}…`);
    results.t2 = { ok: md.length > 10000, path: r6.path };
  }
  hr();

  log('\n========== E2E 汇总 ==========');
  log(JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(__dirname, '..', 'VERIFICATION.json'), JSON.stringify(results, null, 2));
  function fmtSize(n) { return n > 1024 * 1024 ? (n / 1024 ** 2).toFixed(1) + 'MB' : (n / 1024).toFixed(0) + 'KB'; }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
