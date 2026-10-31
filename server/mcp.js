'use strict';
// AgentRelay MCP server —— 零依赖 stdio JSON-RPC 2.0（Model Context Protocol）
// 启动: node server/mcp.js   （或在 agent 中注册为 mcp server，见 docs/MCP.md）
// 安全: transfer 在 confirm!==true 时一律 dry-run；所有调用记入日志
const readline = require('readline');
const agents = require('./core/agents');
const transferMod = require('./core/transfer');
const { selectEntries, redactMsx, computeStats, entryPreview } = require('./core/msx');
const logger = require('./core/logger');
const VERSION = require('../package.json').version;

function textResult(obj, isError = false) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: 'text', text: body }], isError };
}

const TOOLS = [
  {
    name: 'list_agents',
    description: '列出本机检测到的 AI agent 实例（Claude Code / Codex / ZCode / WorkBuddy 等）及其会话数量、存储路径',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_sessions',
    description: '列出某个 agent 实例的本地会话（id、标题、最后活动、消息数）',
    inputSchema: {
      type: 'object',
      properties: {
        instance: { type: 'string', description: '实例 id（来自 list_agents）；不填则按 agent 类型取第一个实例' },
        agent: { type: 'string', description: 'agent 类型：claude | codex | zcode | workbuddy' },
        q: { type: 'string', description: '按标题/项目路径过滤' },
        limit: { type: 'number', description: '最多返回条数，默认 20' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_session',
    description: '读取一个会话的逐字内容（消息流摘要 + 统计），用于了解接力源内容',
    inputSchema: {
      type: 'object',
      properties: {
        instance: { type: 'string' }, agent: { type: 'string' },
        id: { type: 'string', description: '会话 id（来自 list_sessions）' },
        entries_limit: { type: 'number', description: '最多返回的消息条数，默认 30' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'preview_transfer',
    description: 'Dry-run：计算把一个会话接力到目标 agent 将写入什么（不写任何文件）',
    inputSchema: {
      type: 'object',
      properties: {
        sourceAgent: { type: 'string', description: '源 agent 类型 claude|codex|zcode|workbuddy' },
        sourceInstance: { type: 'string', description: '源实例 id（可选，优先于 sourceAgent）' },
        sessionId: { type: 'string' },
        targetAgent: { type: 'string' },
        targetInstance: { type: 'string' },
        cwd: { type: 'string', description: '目标项目目录（会话将绑定到该项目）' },
        mode: { type: 'string', description: 'T0 同源复制 | T1 跨源原生注入 | T2 逐字转写；默认 T1' },
        options: { type: 'object', description: '选择性加载：{includeThinking,includeToolResults,includeMeta,from,truncateToolOutputKB,budgetTokens,redact}' },
      },
      required: ['sessionId', 'targetAgent', 'cwd'],
      additionalProperties: false,
    },
  },
  {
    name: 'transfer',
    description: '执行会话接力。confirm!==true 时只做 dry-run（安全默认）；confirm:true 才真正写入目标 agent 存储',
    inputSchema: {
      type: 'object',
      properties: {
        sourceAgent: { type: 'string' }, sourceInstance: { type: 'string' },
        sessionId: { type: 'string' },
        targetAgent: { type: 'string' }, targetInstance: { type: 'string' },
        cwd: { type: 'string' }, mode: { type: 'string' },
        options: { type: 'object' },
        confirm: { type: 'boolean', description: '必须显式传 true 才会写入目标存储' },
      },
      required: ['sessionId', 'targetAgent', 'cwd'],
      additionalProperties: false,
    },
  },
  {
    name: 'doctor',
    description: '各 agent 存储诊断（路径、版本、会话数、健康状态）',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function callTool(name, args = {}) {
  switch (name) {
    case 'list_agents':
      return textResult(agents.allInstances().map((a) => ({
        instanceId: a.id, type: a.type, name: a.name, available: a.available,
        sessionCount: a.sessionCount, storage: a.storage,
      })));
    case 'list_sessions': {
      const iid = args.instance || (args.agent ? null : null);
      let list;
      if (iid) {
        const inst = agents.getInstance(iid);
        if (!inst) return textResult({ error: `实例不存在: ${iid}` }, true);
        list = agents.listInstanceSessions(inst);
      } else if (args.agent) {
        list = agents.agentSummary(args.agent, { sessions: true }).sessions || [];
      } else return textResult({ error: '需要 instance 或 agent 参数' }, true);
      let filtered = list;
      if (args.q) {
        const q = String(args.q).toLowerCase();
        filtered = list.filter((s) => (s.title || '').toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q));
      }
      const limit = Number(args.limit) > 0 ? Number(args.limit) : 20;
      return textResult(filtered.slice(0, limit).map((s) => ({
        id: s.id, title: s.title, agent: s.agent, cwd: s.cwd,
        lastActive: s.tsLast, messages: s.msgCount, tokens: s.tokens || null,
      })));
    }
    case 'get_session': {
      if (!args.id) return textResult({ error: '需要 id 参数' }, true);
      const msx = args.instance
        ? await agents.readMsxInstance(args.instance, args.id)
        : await agents.readMsx(args.agent || 'claude', args.id);
      const limit = Number(args.entries_limit) > 0 ? Number(args.entries_limit) : 30;
      const lines = [`标题: ${msx.source.title}`, `来源: ${msx.source.agent} (${msx.source.session_id})`, `项目: ${msx.project.cwd}`,
        `统计: ${JSON.stringify(msx.stats)}`, '', '--- 消息流（截断预览）---'];
      msx.entries.slice(0, limit).forEach((e, i) => {
        lines.push(`[${i}] ${e.role}/${e.kind} ${entryPreview(e, 160)}`);
      });
      if (msx.entries.length > limit) lines.push(`… 共 ${msx.entries.length} 条`);
      return textResult(lines.join('\n'));
    }
    case 'preview_transfer':
    case 'transfer': {
      const confirm = args.confirm === true;
      const isDry = name === 'preview_transfer' ? true : !confirm;
      const r = await transferMod.transferOne({
        sourceAgent: args.sourceAgent, sourceInstance: args.sourceInstance,
        sessionId: args.sessionId, targetAgent: args.targetAgent, targetInstance: args.targetInstance,
        cwd: args.cwd, mode: args.mode || 'T1', options: args.options || {},
        dryRun: isDry,
      });
      const out = { ...r };
      if (name === 'transfer' && !confirm) {
        out.note = '安全默认：本次为 dry-run（未写入任何文件）。确认无误后带 confirm:true 重新调用以执行。';
      }
      logger.info('mcp-' + name, { ok: r.ok, source: args.sourceAgent || args.sourceInstance, target: args.targetAgent || args.targetInstance, dry: isDry });
      return textResult(out, !r.ok);
    }
    case 'doctor':
      return textResult(agents.allInstances().map((a) => ({ instance: a.id, type: a.type, ok: a.available, storage: a.storage, sessions: a.sessionCount })));
    default:
      return textResult({ error: `未知工具: ${name}` }, true);
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  rl.on('line', (line) => {
    const raw = line.trim();
    if (!raw) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { id, method, params } = msg || {};
    if (method === 'initialize') {
      write({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: params && params.protocolVersion ? params.protocolVersion : '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'agentrelay', version: VERSION },
        },
      });
      return;
    }
    if (method === 'notifications/initialized' || (method || '').startsWith('notifications/')) return;
    if (method === 'ping') { write({ jsonrpc: '2.0', id, result: {} }); return; }
    if (method === 'tools/list') { write({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }
    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      callTool(name, args)
        .then((result) => write({ jsonrpc: '2.0', id, result }))
        .catch((e) => write({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true },
        }));
      return;
    }
    if (id !== undefined) write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  });
  logger.info('mcp-start', { version: VERSION });
}

if (require.main === module) main();
module.exports = { TOOLS, callTool };
