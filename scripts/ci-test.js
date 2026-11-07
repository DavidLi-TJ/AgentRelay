'use strict';
// CI 冒烟测试：不依赖本机装有任何真实 agent。
// 原理：在任何 core 模块加载前把 HOME/USERPROFILE 重定向到 sandbox/cihome（util.js 在 require 时
// 固化 os.homedir()），各 agent 的"真实存储"随之全部落到隔离目录；再用每个 agent 自己的写入器
// 生成夹具，走 读回 → 跨源接力 → bundle 往返 → WorkBuddy 双版本隔离 → 编辑 → Markdown 全链路。
// 本地也可直接运行：node scripts/ci-test.js
const fs = require('fs');
const path = require('path');

const FAKE = path.join(__dirname, '..', 'sandbox', 'cihome');
fs.rmSync(FAKE, { recursive: true, force: true });
fs.mkdirSync(FAKE, { recursive: true });
process.env.HOME = FAKE; // POSIX：os.homedir() 读 $HOME
process.env.USERPROFILE = FAKE; // Windows：os.homedir() 读 USERPROFILE

const zlib = require('zlib');
const agents = require('../server/core/agents');
const claude = require('../server/core/claude');
const codex = require('../server/core/codex');
const gemini = require('../server/core/gemini');
const pi = require('../server/core/pi');
const openclaw = require('../server/core/openclaw');
const dsh = require('../server/core/dsh');
const workbuddy = require('../server/core/workbuddy');
const bundle = require('../server/core/bundle');
const transfer = require('../server/core/transfer');
const msxMod = require('../server/core/msx');
const { msxToMarkdown } = require('../server/core/markdown');
const { randomUUID } = require('../server/core/util');

const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function';
const PROJ = path.join(FAKE, 'proj');
fs.mkdirSync(PROJ, { recursive: true });

const failures = [];
function check(name, cond, extra) {
  if (cond) { console.log(`  ✔ ${name}${extra ? ' ' + extra : ''}`); return true; }
  failures.push(name); console.log(`  ✘ ${name}${extra ? ' ' + extra : ''}`); return false;
}

// 合成会话：用户文本 / 思考+正文 / 工具调用 / 工具结果（输出故意含 ``` 以测围栏自适应）/ 收尾
function synthMsx(agent, sessionId) {
  const entries = [
    { id: 'e1', ts: '2026-01-01T10:00:00Z', role: 'user', kind: 'text', blocks: [{ type: 'text', text: '把 README 的安装命令改成 npx 一键' }], meta: {} },
    { id: 'e2', ts: '2026-01-01T10:00:05Z', role: 'assistant', kind: 'text', blocks: [{ type: 'thinking', text: '用户要改安装命令' }, { type: 'text', text: '好的，我来改。' }], meta: {} },
    { id: 'e3', ts: '2026-01-01T10:00:10Z', role: 'assistant', kind: 'text', blocks: [{ type: 'tool_use', id: 'call_1', name: 'edit_file', input: { path: 'README.md', from: 'npm i', to: 'npx' } }], meta: {} },
    { id: 'e4', ts: '2026-01-01T10:00:12Z', role: 'user', kind: 'tool-result', blocks: [{ type: 'tool_result', for: 'call_1', output: 'written\n```ok```\ndone', isError: false }], meta: {} },
    { id: 'e5', ts: '2026-01-01T10:00:20Z', role: 'assistant', kind: 'text', blocks: [{ type: 'text', text: '完成。' }], meta: {} },
  ];
  return {
    arx: 1, id: randomUUID(), created_at: '2026-01-01T10:00:00Z',
    source: { agent, agent_version: null, session_id: sessionId, title: 'CI 合成会话' },
    project: { cwd: PROJ }, env: { model: 'ci-model', provider: null, cli_version: null },
    stats: msxMod.computeStats(entries), entries, compactions: [], loss: [],
  };
}

// WorkBuddy 最小 schema（写读所需的全部列）
function wbSchema(base) {
  fs.mkdirSync(base, { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(base, 'workbuddy.db'));
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, cwd TEXT, title TEXT, custom_title TEXT, status TEXT,
    created_at INTEGER, updated_at INTEGER, last_activity_at INTEGER, deleted_at INTEGER,
    source_mode TEXT, mode TEXT, is_playground INTEGER, is_background_automation INTEGER);
    CREATE TABLE session_usage(session_id TEXT, used INTEGER, size INTEGER, updated_at INTEGER)`);
  db.close();
}

(async () => {
  console.log('AgentRelay CI 冒烟测试（隔离 HOME: ' + FAKE + '）');

  // ---------- 0. 夹具：WorkBuddy 双版本 schema + codex 最小模板 ----------
  wbSchema(path.join(FAKE, '.workbuddy'));
  wbSchema(path.join(FAKE, '.workbuddy-ai'));
  // codex 写入器需要一个既有 rollout 作模板（克隆 originator/cli_version 等头部）
  const codexSessDir = path.join(FAKE, '.codex', 'sessions', '2026', '01', '01');
  fs.mkdirSync(codexSessDir, { recursive: true });
  fs.writeFileSync(path.join(codexSessDir, 'rollout-2026-01-01T00-00-00-ci-template.jsonl'), [
    JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'ci-template', cwd: PROJ, originator: 'codex_cli_rs', cli_version: '0.0.0', model_provider: 'ci' } }),
    JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'turn_context', payload: { cwd: PROJ, model: 'ci-model', effort: 'high', summary: 'auto' } }),
    JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z', type: 'event_msg', payload: { type: 'thread_settings_applied', model: 'ci-model', effort: 'high', summary: 'auto' } }),
  ].join('\n') + '\n');
  // 最小 threads 表：T1 的注册路径得以完整演练（缺表时注册只记 note、文件仍写）
  {
    const { DatabaseSync } = require('node:sqlite');
    const cdb = new DatabaseSync(path.join(FAKE, '.codex', 'state_5.sqlite'));
    cdb.exec('CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, recency_at INTEGER, title TEXT, cwd TEXT, model_provider TEXT, cli_version TEXT, first_user_message TEXT, preview TEXT)');
    cdb.close();
  }

  // ---------- 1. 各写入器自产夹具 + 读回 ----------
  const written = {}; // agent → sessionId
  const writers = [
    ['claude', claude], ['codex', codex], ['gemini', gemini], ['pi', pi], ['openclaw', openclaw],
  ];
  if (HAS_ZSTD) writers.push(['dsh', dsh]);
  for (const [name, mod] of writers) {
    try {
      // claude 写入器按 source.agent==='claude-code' 判定同厂商（保留思考块）——夹具需用其规范源 id
      const srcAgent = name === 'claude' ? 'claude-code' : name;
      const sid = 'ci-' + name + '-' + randomUUID().slice(0, 8);
      const r = await mod.writeSession(synthMsx(srcAgent, sid), { cwd: PROJ });
      const list = mod.listSessions();
      const row = list.find((s) => s.id === r.id);
      if (!check(`${name} 写入→列表可见`, !!row)) continue;
      const back = await mod.readSession(r.id);
      check(`${name} 读回`, back.entries.length >= 4 && back.stats.userTurns >= 1 && back.stats.toolCalls >= 1,
        `entries=${back.entries.length}`);
      written[name] = r.id;
    } catch (e) { check(`${name} 写读往返`, false, e.message); }
  }

  // ---------- 2. WorkBuddy 国内/国际双实例：各写一份，互不可见 ----------
  try {
    const insts = agents.listInstances();
    const dom = insts.find((i) => i.instanceId === 'workbuddy');
    const intl = insts.find((i) => i.instanceId === 'workbuddy-intl');
    check('双实例均已注册', !!dom && !!intl, `dom=${!!dom} intl=${!!intl}`);
    if (dom && intl) {
      const r1 = await workbuddy.writeSession(synthMsx('workbuddy', 'wb-dom'), { cwd: PROJ, baseDir: dom.baseDir });
      const r2 = await workbuddy.writeSession(synthMsx('workbuddy', 'wb-intl'), { cwd: PROJ, baseDir: intl.baseDir });
      const domList = agents.listInstanceSessions(dom);
      const intlList = agents.listInstanceSessions(intl);
      check('国内版只见国内会话', domList.some((s) => s.id === r1.id) && !domList.some((s) => s.id === r2.id),
        `n=${domList.length}`);
      check('国际版只见国际会话', intlList.some((s) => s.id === r2.id) && !intlList.some((s) => s.id === r1.id),
        `n=${intlList.length}`);
      check('目录互不混用', r1.path.includes('.workbuddy' + path.sep) && !r1.path.includes('.workbuddy-ai')
        && r2.path.includes('.workbuddy-ai'), '');
    }
  } catch (e) { check('WorkBuddy 双版本', false, e.message); }

  // ---------- 3. 跨源 T1 接力（claude → codex，含注册） ----------
  try {
    if (written.claude) {
      const r = await transfer.transferOne({
        sourceAgent: 'claude', sessionId: written.claude, targetAgent: 'codex', cwd: PROJ, mode: 'T1',
      });
      check('T1 claude→codex', r.ok && r.path && fs.existsSync(r.path), `loss=${r.loss.length}`);
    }
    // T2 兜底（gemini 目标 → 项目内逐字转写）
    if (written.claude) {
      const r = await transfer.transferOne({
        sourceAgent: 'claude', sessionId: written.claude, targetAgent: 'gemini', cwd: PROJ, mode: 'T2',
      });
      check('T2 claude→gemini 转写落盘', r.ok && r.path && fs.existsSync(r.path), '');
    }
  } catch (e) { check('接力链路', false, e.message); }

  // ---------- 4. bundle 导出 → 导入往返 ----------
  try {
    const items = [];
    if (written.claude) items.push({ sourceAgent: 'claude', sessionId: written.claude });
    if (written.pi) items.push({ sourceAgent: 'pi', sessionId: written.pi });
    if (items.length >= 2) {
      const out = path.join(FAKE, 'ci.arxbundle');
      const exp = await bundle.exportBundle({ items, out });
      check('bundle 导出', fs.existsSync(exp.file) && exp.count === 2, `count=${exp.count}`);
      const dry = await bundle.importBundle({ file: exp.file, targets: [{ agent: 'openclaw', cwd: PROJ }], dryRun: true });
      check('bundle dry-run', Array.isArray(dry) ? dry.every((x) => x.ok || x.dryRun) : !!dry.ok, '');
      const imp = await bundle.importBundle({ file: exp.file, targets: [{ agent: 'openclaw', cwd: PROJ }] });
      const okN = (Array.isArray(imp) ? imp : [imp]).filter((x) => x.ok).length;
      check('bundle 实导入 openclaw', okN === 2, `ok=${okN}`);
    }
  } catch (e) { check('bundle 往返', false, e.message); }

  // ---------- 5. 上下文编辑（删/改/插 + 工具对约束） ----------
  try {
    const m = synthMsx('claude', 'edit-smoke');
    const edited = msxMod.applySessionEdits(m, {
      removals: ['e2'],
      edits: [{ id: 'e1', text: '（改写后的指令）' }],
      inserts: [{ afterId: 'e1', entry: { id: 'e1b', ts: '2026-01-01T10:00:02Z', role: 'user', kind: 'text', blocks: [{ type: 'text', text: '补充：还要更新中文 README' }], meta: {} } }],
    });
    const ids = edited.entries.map((e) => e.id);
    check('编辑器 删/改/插', !ids.includes('e2') && ids.includes('e1b')
      && edited.entries.find((e) => e.id === 'e1').blocks[0].text === '（改写后的指令）', `n=${ids.length}`);
  } catch (e) { check('上下文编辑', false, e.message); }

  // ---------- 6. Markdown 逐字导出 ----------
  try {
    if (written.claude) {
      const src = await claude.readSession(written.claude);
      const md = msxToMarkdown(src);
      check('MD 含标题与工具段', md.includes('# CI 合成会话') && md.includes('工具调用'), '');
      check('MD 围栏自适应（``` 内容不截断）', md.includes('```ok```') && /\n````\n/.test(md), '');
      check('MD 思考块折叠', md.includes('<details>') && md.includes('思考过程'), '');
    }
  } catch (e) { check('Markdown 导出', false, e.message); }

  // ---------- 汇总 ----------
  console.log(failures.length ? `\n结果: ${failures.length} 项失败 → ${failures.join(' | ')}` : '\n结果: 全部通过');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
