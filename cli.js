#!/usr/bin/env node
'use strict';
// AgentRelay CLI —— list / show / export / load / transfer / doctor / serve
const fs = require('fs');
const path = require('path');
const agents = require('./server/core/agents');
const transferMod = require('./server/core/transfer');
const msxMod = require('./server/core/msx');
const { readJsonl } = require('./server/core/util');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let key = a.slice(2);
      const eq = key.indexOf('=');
      if (eq !== -1) { args[key.slice(0, eq)] = key.slice(eq + 1); continue; } // 支持 --flag=value
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

function selectionFromArgs(args) {
  const opts = {};
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  // sfrom/sto 供 transfer 使用（transfer 的 --from/--to 是路由参数）
  const from = num(args.sfrom ?? args.from); if (from != null) opts.from = from;
  const to = num(args.sto ?? args.to); if (to != null && to > 0) opts.to = to;
  if (args['no-thinking']) opts.includeThinking = false;
  if (args['no-tool-results']) opts.includeToolResults = false;
  if (args['no-tool-use']) opts.includeToolUse = false;
  if (args['no-meta']) opts.includeMeta = false;
  if (args.truncate != null) { const n = num(args.truncate); if (n != null && n >= 0) opts.truncateToolOutputKB = n; }
  if (args.budget != null) { const n = num(args.budget); if (n != null && n > 0) opts.budgetTokens = n; }
  if (args.redact) opts.redact = true;
  return opts;
}

function fmtTime(t) { return t ? String(t).slice(0, 16).replace('T', ' ') : '?'; }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  try {
    await route(cmd, args);
  } catch (e) {
    console.error('错误: ' + e.message);
    process.exit(1);
  }
}

async function route(cmd, args) {

  if (cmd === 'agents') {
    for (const a of agents.listAgents()) {
      console.log(`${a.available ? '✔' : '✘'} ${a.name.padEnd(12)} 会话 ${String(a.sessionCount).padEnd(4)} ${a.storage || ''} ${a.note || ''}`);
    }
  } else if (cmd === 'list') {
    const agent = args.agent || args._[1] || 'claude';
    let list = agents.agentSummary(agent, { sessions: true }).sessions || [];
    if (args.q) {
      const q = String(args.q).toLowerCase();
      list = list.filter((s) => (s.title || '').toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q));
    }
    if (args.json) return console.log(JSON.stringify(list, null, 2));
    for (const s of list) {
      console.log(`${s.id.slice(0, 8)}  ${fmtTime(s.tsLast)}  ${String(s.msgCount ?? '?').padStart(5)}条  ${s.title}`);
      if (args.verbose) console.log(`          id=${s.id} cwd=${s.cwd}`);
    }
    console.log(`共 ${list.length} 个会话`);
  } else if (cmd === 'show') {
    const [agent, id] = [args._[1], args._[2]];
    const msx = await agents.readMsx(agent, id);
    console.log(`标题: ${msx.source.title}\n来源: ${msx.source.agent} ${msx.source.session_id}\n项目: ${msx.project.cwd}\n规模: ${JSON.stringify(msx.stats)}`);
    const limit = Number(args.limit || 30);
    msx.entries.slice(0, limit).forEach((e, i) => {
      console.log(`${String(i).padStart(3)} [${e.role}/${e.kind}] ${msxMod.entryPreview(e, 150)}`);
    });
    if (msx.entries.length > limit) console.log(`... 还有 ${msx.entries.length - limit} 条（--limit 调整）`);
  } else if (cmd === 'export') {
    const [agent, id] = [args._[1], args._[2]];
    const src = await agents.readMsx(agent, id);
    const loss = [];
    const entries = msxMod.selectEntries(src.entries, selectionFromArgs(args), loss);
    let msx = { ...src, entries, loss: [...src.loss, ...loss] };
    if (args.redact) msx = msxMod.redactMsx(msx);
    msx.stats = msxMod.computeStats(msx.entries);
    const out = args.out || `${agent}-${String(msx.source.session_id).slice(0, 8)}.arx.json`;
    fs.writeFileSync(out, JSON.stringify(msx, null, 2), 'utf8');
    console.log(`已导出 ${msx.entries.length} 条 → ${path.resolve(out)} (~${msx.stats.approxTokens} tokens)`);
    if (msx.loss.length) console.log(`转换说明:\n  - ${[...new Set(msx.loss)].join('\n  - ')}`);
  } else if (cmd === 'load') {
    const file = args._[1];
    const target = args.into;
    const msx = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!msx.source || !msx.source.agent) throw new Error('ARX 文件缺少 source.agent');
    const r = await transferMod.transferOne({
      sourceAgent: msx.source.agent, sessionId: msx.source.session_id,
      targetAgent: target, cwd: args.cwd, mode: args.mode || 'T1',
      options: selectionFromArgs(args), dbFileOverride: args['db-file'] || null,
      dryRun: !!args['dry-run'],
      // 文件里带 entries 时直接使用（保留用户对导出文件的修改，如脱敏/裁剪）
      msxOverride: Array.isArray(msx.entries) && msx.entries.length ? msx : null,
    });
    console.log(JSON.stringify(r, null, 2));
  } else if (cmd === 'transfer') {
    // transfer --from claude:<id> --to codex [--cwd path] [--mode T1] [--dry-run]
    const [srcAgent, srcId] = String(args.from || '').split(':');
    const results = await transferMod.transferOne({
      sourceAgent: srcAgent, sessionId: srcId, targetAgent: args.to,
      cwd: args.cwd, mode: args.mode || 'T1', options: selectionFromArgs(args),
      dbFileOverride: args['db-file'] || null, dryRun: !!args['dry-run'],
    });
    console.log(JSON.stringify(results, null, 2));
  } else if (cmd === 'doctor') {
    console.log(JSON.stringify({
      claude: require('./server/core/claude').doctor(),
      codex: require('./server/core/codex').doctor(),
      zcode: require('./server/core/zcode').doctor(),
      workbuddy: agents.detectWorkbuddy(),
    }, null, 2));
  } else if (cmd === 'serve') {
    require('./server/index.js');
  } else if (cmd === 'mcp') {
    require('./server/mcp.js');
  } else {
    console.log(`AgentRelay —— 跨 Agent 会话接力

用法:
  node cli.js agents                          列出检测到的 agent
  node cli.js list <agent> [--q 关键词]        列出会话 (agent: claude|codex|zcode)
  node cli.js show <agent> <sessionId>        查看会话内容
  node cli.js export <agent> <sessionId> [--out 文件] [--from N --to N] [--no-thinking]
                                              [--truncate KB] [--budget tokens] [--redact]
  node cli.js load <file.arx.json>（兼容读取旧 .msx.json） --into claude|codex|zcode --cwd <项目路径> [--mode T1|T2] [--dry-run]
  node cli.js transfer --from <agent>:<sessionId> --to <agent> --cwd <路径> [--mode T0|T1|T2] [--dry-run]
  node cli.js doctor                          检查各 agent 存储
  node cli.js serve                           启动 GUI (http://127.0.0.1:17777)
  node cli.js mcp                             启动 MCP server（供 Claude Code/Codex/ZCode 等 agent 调用）
`);
  }
}

main();
