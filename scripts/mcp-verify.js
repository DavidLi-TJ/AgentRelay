'use strict';
// MCP 端到端验证：按 mcp.js 的 schema 逐个调用全部工具（只读/默认 dry-run），断言结果
const { spawn } = require('child_process');
const path = require('path');

const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'mcp.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
let nextId = 1;
const out = [];

child.stdout.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { }
  }
});
child.stderr.on('data', () => { });

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout: ' + method)); } }, 60000);
  });
}

function textOf(res) {
  const c = res.result && res.result.content;
  if (!Array.isArray(c)) return res;
  const t = c.find((x) => x.type === 'text');
  try { return JSON.parse(t.text); } catch { return t.text; }
}
const ok = (v) => (v.startsWith('OK') ? '✓' : v.startsWith('WARN') ? '~' : '✗');

(async () => {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '0' } });
  out.push(['initialize', init.result && init.result.serverInfo && init.result.serverInfo.name === 'agentrelay' ? 'OK serverInfo=agentrelay' : 'FAIL']);

  const tools = await rpc('tools/list', {});
  const names = tools.result.tools.map((t) => t.name);
  const expect = ['list_agents', 'list_sessions', 'get_session', 'preview_transfer', 'transfer', 'doctor'];
  out.push(['tools/list', expect.every((n) => names.includes(n)) ? 'OK 6 tools' : 'FAIL ' + names.join(',')]);

  const agents = textOf(await rpc('tools/call', { name: 'list_agents', arguments: {} }));
  const on = Array.isArray(agents) ? agents.filter((a) => a.available) : [];
  out.push(['list_agents', on.length ? `OK ${on.length} available` : 'FAIL']);

  const sess = textOf(await rpc('tools/call', { name: 'list_sessions', arguments: { agent: 'claude', limit: 3 } }));
  const list = Array.isArray(sess) ? sess : (sess.sessions || []);
  out.push(['list_sessions', list.length ? `OK ${list.length} sessions` : 'FAIL empty']);
  if (!list.length) throw new Error('no claude sessions');
  const sid = list[0].id;

  const got = textOf(await rpc('tools/call', { name: 'get_session', arguments: { agent: 'claude', id: sid } }));
  out.push(['get_session (id)', typeof got === 'string' && got.includes('标题:') ? 'OK' : 'FAIL ' + String(got).slice(0, 80)]);
  const got2 = textOf(await rpc('tools/call', { name: 'get_session', arguments: { agent: 'claude', sessionId: sid } }));
  out.push(['get_session (sessionId 别名)', typeof got2 === 'string' && got2.includes('标题:') ? 'OK' : 'FAIL']);

  const pv = textOf(await rpc('tools/call', { name: 'preview_transfer', arguments: { sourceAgent: 'claude', sessionId: sid, targetAgent: 'codex', cwd: process.cwd(), options: { includeMeta: false } } }));
  out.push(['preview_transfer', pv && pv.stats ? `OK ~${pv.stats.approxTokens} tok, loss ${pv.loss.length}` : 'FAIL ' + JSON.stringify(pv).slice(0, 120)]);

  const tr = textOf(await rpc('tools/call', { name: 'transfer', arguments: { sourceAgent: 'claude', sessionId: sid, targetAgent: 'codex', cwd: process.cwd() } }));
  // mcp 的 transfer 返回单个 result 对象（transferOne 的返回），不是 results 数组
  const trOk = tr && typeof tr === 'object' && 'dryRun' in tr ? tr : (tr && tr.results && tr.results[0]);
  out.push(['transfer (no confirm)', trOk && trOk.dryRun === true && trOk.ok && !trOk.path ? 'OK dry-run enforced, no write' : 'FAIL ' + JSON.stringify(tr).slice(0, 200)]);
  out.push(['transfer dry-run 无 resumeCommand', trOk && !trOk.resumeCommand ? 'OK（dry-run 不产生写入路径）' : 'WARN']);

  const tr2 = textOf(await rpc('tools/call', { name: 'transfer', arguments: { sourceAgent: 'claude', sessionId: sid, targetAgent: 'codex', cwd: process.cwd(), confirm: false } }));
  const tr2Ok = tr2 && typeof tr2 === 'object' && 'dryRun' in tr2 ? tr2 : (tr2 && tr2.results && tr2.results[0]);
  out.push(['transfer (confirm:false)', tr2Ok && tr2Ok.dryRun === true ? 'OK dry-run enforced' : 'FAIL']);

  const doc = textOf(await rpc('tools/call', { name: 'doctor', arguments: {} }));
  out.push(['doctor', Array.isArray(doc) && doc.length ? `OK ${doc.length} instances` : 'FAIL']);

  const bad = await rpc('no/such/method', {});
  out.push(['unknown method', bad.error ? 'OK error ' + bad.error.code : 'FAIL']);

  // 畸形 JSON 行不应让 server 崩溃
  child.stdin.write('this is not json\n');
  await new Promise((r) => setTimeout(r, 500));
  const alive = await rpc('ping', {});
  out.push(['畸形输入后仍存活', alive.result ? 'OK' : 'FAIL']);

  child.kill();
  console.log('\n=== MCP 端到端验证 ===');
  let fail = 0;
  for (const [k, v] of out) { if (v.startsWith('FAIL')) fail++; console.log(`${ok(v)} ${k}: ${v}`); }
  console.log(fail ? `\n${fail} FAILED` : '\n全部通过');
  process.exit(fail ? 1 : 0);
})().catch((e) => { child.kill(); console.error('MCP VERIFY FATAL:', e.message); process.exit(1); });
