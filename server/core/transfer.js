'use strict';
// 接力编排：源会话 → 选择性加载 → T0/T1/T2 写入目标 agent（写前自动备份）
const fs = require('fs');
const path = require('path');
const { ensureDir, nowISO, randomUUID, truncateStr, nowMs } = require('./util');
const logger = require('./logger');
const { selectEntries, redactMsx, computeStats, firstUserText, titleFromEntries } = require('./msx');

// 常见错误的"下一步"提示（GUI 结果框展示）
function errorHint(msg) {
  const s = String(msg || '');
  if (/SQLITE_BUSY|database is locked|busy/i.test(s)) return '目标数据库正被占用：请完全退出对应的 agent 应用后重试';
  if (/ENOENT|不存在/i.test(s)) return '存储路径不存在：请确认对应 agent 已安装且目录正确（可在诊断页查看存储路径）';
  if (/额度不足|quota|403/i.test(s)) return '这是 API 代理的余额/权限问题，与会话注入无关（注入的会话已被目标 agent 正常加载）';
  if (/model_provider/i.test(s)) return 'Codex 的 ~/.codex/config.toml 缺少对应 provider 配置';
  if (/没有可写入的内容条目/i.test(s)) return '过滤条件排除了全部内容：放宽勾选/预算/区间后重试';
  if (/EACCES|EPERM|权限/i.test(s)) return '没有写权限：检查目标目录权限，或换一个项目目录';
  return null;
}
const agents = require('./agents');
const claude = require('./claude');
const codex = require('./codex');
const zcode = require('./zcode');
const workbuddy = require('./workbuddy');

function backupTargetsFor(targetAgent, baseDir) {
  const files = [];
  if (targetAgent === 'codex') {
    const home = baseDir || path.join(require('./util').HOME, '.codex');
    files.push(path.join(home, 'state_5.sqlite'));
    files.push(path.join(home, 'session_index.jsonl'));
  } else if (targetAgent === 'zcode') {
    for (const ext of ['', '-wal', '-shm']) files.push(zcode.dbPath(baseDir) + ext);
  } else if (targetAgent === 'workbuddy') {
    for (const ext of ['', '-wal', '-shm']) files.push(workbuddy.dbPath(baseDir) + ext);
  } else if (targetAgent === 'opencode') {
    const oc = require('./opencode');
    for (const ext of ['', '-wal', '-shm']) files.push(oc.dbPath(baseDir) + ext);
  }
  return files.filter((f) => fs.existsSync(f));
}

// 写前备份（受用户开关控制；backup===null 时取全局配置 backupEnabled，默认 true）
function runBackupIfEnabled(targetAgent, baseDir, label, result, backupOpt) {
  const enabled = backupOpt === null || backupOpt === undefined
    ? require('./util').config().backupEnabled !== false
    : !!backupOpt;
  if (!enabled) {
    result.notes = result.notes || [];
    result.notes.push('⚠ 写前备份已关闭（用户设置）——本次写入未创建快照');
    return null;
  }
  const b = backupTargetsFor(targetAgent, baseDir);
  if (b.length) {
    const bk = require('./util').backupFiles(b, label);
    result.backup = bk.dir;
    return bk;
  }
  return null;
}

// 流式写 MSX JSON（大会话防 OOM）
function writeMsxFile(msx, file) {
  ensureDir(path.dirname(file));
  const ws = fs.createWriteStream(file + '.msx-tmp-' + process.pid, { encoding: 'utf8' });
  return new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('finish', () => {
      try { fs.renameSync(file + '.msx-tmp-' + process.pid, file); resolve(); }
      catch (e) { reject(e); }
    });
    ws.write('{');
    let first = true;
    for (const k of Object.keys(msx)) {
      if (k === 'entries' || k === 'compactions' || k === 'loss') continue;
      if (k.startsWith('_') || msx[k] === undefined) continue; // 内部字段（_fileStat/_storeSig 等）与 undefined 不入导出
      if (!first) ws.write(',');
      first = false;
      ws.write(JSON.stringify(k) + ':' + JSON.stringify(msx[k]));
    }
    if (!first) ws.write(',');
    ws.write('"entries":[');
    (msx.entries || []).forEach((e, i) => {
      if (i) ws.write(',');
      ws.write(JSON.stringify(e));
    });
    ws.write('],"compactions":' + JSON.stringify(msx.compactions || []));
    ws.write(',"loss":' + JSON.stringify([...new Set(msx.loss || [])]));
    ws.end('}');
  });
}

// 流式写 T2 逐字转写 markdown
function writeBundleStream(msx, file) {
  ensureDir(path.dirname(file));
  const ws = fs.createWriteStream(file + '.msx-tmp-' + process.pid, { encoding: 'utf8' });
  return new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('finish', () => {
      try { fs.renameSync(file + '.msx-tmp-' + process.pid, file); resolve(); }
      catch (e) { reject(e); }
    });
    const src = msx.source || {};
    ws.write(`# 会话接力包（逐字转写，非摘要）\n\n`);
    ws.write(`- 来源: ${src.agent} 会话 ${src.session_id}\n`);
    ws.write(`- 标题: ${src.title || '(无标题)'}\n`);
    ws.write(`- 项目: ${msx.project && msx.project.cwd}\n`);
    ws.write(`- 导出: ${msx.created_at} by AgentRelay\n`);
    ws.write(`- 规模: ${msx.stats.entries} 条 / 约 ${msx.stats.approxTokens} tokens\n`);
    if (msx.loss && msx.loss.length) ws.write(`- 转换说明: ${[...new Set(msx.loss)].join('；')}\n`);
    ws.write(`\n> 指令：以下是你（同一个你）在上一会话中的完整逐字记录。请将其视为你自己的记忆，直接继续未完成的工作，不要重新开始，不要重新提问已经回答过的问题。\n\n`);
    for (const e of msx.entries) {
      const who = e.role === 'user' ? (e.kind === 'tool-result' ? '工具结果' : '用户') : e.role === 'assistant' ? '助手' : e.role;
      const ts = e.ts ? `（${e.ts.slice(0, 19).replace('T', ' ')}）` : '';
      ws.write(`---\n### [${who}]${ts}\n`);
      for (const b of e.blocks || []) {
        if (b.type === 'text') ws.write((b.text || '') + '\n');
        else if (b.type === 'thinking') ws.write(`<thinking>\n${b.text || ''}\n</thinking>\n`);
        else if (b.type === 'tool_use') ws.write(`<tool_call name="${b.name}" id="${b.id || ''}">\n${JSON.stringify(b.input ?? {}, null, 2)}\n</tool_call>\n`);
        else if (b.type === 'tool_result') ws.write(`<tool_result for="${b.for || ''}">\n${typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? '')}\n</tool_result>\n`);
        else if (b.type === 'image') ws.write(`[图片 ${b.mediaType || ''}]\n`);
      }
      ws.write('\n');
    }
    ws.write(`---\n（记录结束。当前接续时间点：${nowISO()}，请从这里继续。）\n`);
    ws.end();
  });
}

// mode: 'T0' 同源原生复制 | 'T1' 跨源原生注入 | 'T2' 逐字转写注入（通用兜底）
async function transferOne({ sourceAgent, sessionId, targetAgent, cwd, mode = 'T1', options = {}, dryRun = false, dbFileOverride = null, msxOverride = null, sourceInstance = null, targetInstance = null, backup = null }) {
  const t0 = Date.now();
  const result = {
    ok: false, sourceAgent, sessionId, targetAgent, mode, cwd: cwd || null, dryRun: !!dryRun,
    id: null, path: null, resumeCommand: null, loss: [], notes: [], ms: 0,
  };
  try {
    if (!agents.META[targetAgent]) throw new Error('未知目标 agent: ' + targetAgent);
    const srcInst = sourceInstance ? agents.getInstance(sourceInstance) : null;
    const src = msxOverride || (srcInst
      ? await agents.readMsxInstance(sourceInstance, sessionId)
      : await agents.readMsx(sourceAgent, sessionId));
    const loss = [...(src.loss || [])];
    let entries = src.entries;
    const selLoss = [];
    entries = selectEntries(entries, options, selLoss);
    loss.push(...selLoss);
    let msx = {
      arx: 1, id: randomUUID(), created_at: nowISO(),
      source: src.source, project: { cwd: cwd || src.project.cwd }, env: src.env,
      stats: computeStats(entries), entries, compactions: src.compactions || [], loss,
    };
    if (options.redact) msx = redactMsx(msx);
    result.stats = msx.stats;
    result.title = msx.source.title;
    logger.debug('select', {
      source: sourceAgent + ':' + sessionId, target: targetAgent, mode,
      entries: msx.stats.entries, approxTokens: msx.stats.approxTokens,
      loss: [...new Set(msx.loss || [])].slice(0, 8),
    });

    const tgtInst = targetInstance ? agents.getInstance(targetInstance) : null;
    // 显式指定了目标实例但解析不到（已删除/停用/拼写错）：报错而不是静默写进默认存储
    if (targetInstance && !tgtInst) throw new Error('目标实例不存在: ' + targetInstance);
    const tgtBase = tgtInst ? tgtInst.baseDir : null;
    if (mode === 'T2') {
      if (!cwd) throw new Error('T2 注入需要目标项目 cwd');
      if (!dryRun) {
        const dir = ensureDir(path.join(cwd, '.agentrelay'));
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const sidPart = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'session';
        const name = `handoff-${stamp}-${sourceAgent}-${sidPart}.md`;
        const file = path.join(dir, name);
        await writeBundleStream(msx, file);
        result.path = file;
        result.id = name;
        result.resumeCommand = t2Command(targetAgent, name);
        result.notes.push('T2 = 逐字转写注入：在目标 agent 新会话开头粘贴启动指令，模型将完整阅读原会话记录后继续工作');
      } else {
        result.notes.push(`[dry-run] 将写入 ${path.join(cwd, '.agentrelay', 'handoff-*.md')}（约 ${msx.stats.approxTokens} tokens）`);
      }
      result.ok = true;
    } else if (mode === 'T0') {
      if (targetAgent !== sourceAgent) throw new Error('T0 仅支持同源（相同 agent）接力；跨 agent 请用 T1/T2');
      if (!['claude', 'codex', 'zcode'].includes(targetAgent)) throw new Error(targetAgent + ' 暂不支持 T0 原生复制；请用 T1（原生注入）或 T2（逐字转写）');
      if (dryRun) { result.ok = true; result.notes.push('[dry-run] T0 原生复制'); return finish(); }
      if (targetAgent === 'claude') {
        const r = await claude.rawCopy(sessionId, { baseDir: tgtBase });
        result.id = r.id; result.path = r.path; result.count = r.count;
        result.resumeCommand = `claude --resume ${r.id}`;
      } else if (targetAgent === 'codex') {
        runBackupIfEnabled('codex', tgtBase, 'codex-t0', result, backup);
        const r = await codex.rawCopy(sessionId, { baseDir: tgtBase });
        result.id = r.id; result.path = r.path; result.count = r.count;
        result.resumeCommand = `codex resume ${r.id}`;
      } else if (targetAgent === 'zcode') {
        if (!dbFileOverride) runBackupIfEnabled('zcode', tgtBase, 'zcode-t0', result, backup);
        const r = zcode.copySession(sessionId, { dbFile: dbFileOverride, baseDir: tgtBase });
        result.id = r.id; result.path = r.path; result.count = r.count;
        result.resumeCommand = `在 ZCode 桌面端会话列表打开「${result.title}」（新会话 id: ${r.id}）`;
      }
      result.ok = true;
    } else if (mode === 'T1') {
      if (dryRun) {
        result.ok = true;
        result.notes.push(`[dry-run] 将以 ${targetAgent} 原生格式写入 ${describeTarget(targetAgent, cwd, tgtBase)}（${msx.stats.entries} 条 / ~${msx.stats.approxTokens} tokens）`);
        return finish();
      }
      if (targetAgent === 'claude') {
        const r = claude.writeSession(msx, { cwd, baseDir: tgtBase });
        result.id = r.id; result.path = r.path; result.loss = r.loss; result.count = r.count;
        result.resumeCommand = `claude --resume ${r.id}`;
      } else if (targetAgent === 'codex') {
        runBackupIfEnabled('codex', tgtBase, 'codex-t1', result, backup);
        const r = codex.writeSession(msx, { cwd, baseDir: tgtBase });
        result.loss = r.loss; result.count = r.count;
        const firstUser = firstUserText(msx.entries);
        try {
          codex.registerThread({
            id: r.id, rolloutPath: r.path, title: msx.source.title, cwd,
            createdMs: Date.now(), modelProvider: codex.readModelProviderFromConfig(tgtBase),
            cliVersion: msx.env?.cli_version || null, firstUserMessage: firstUser, preview: firstUser, baseDir: tgtBase,
          });
          result.notes.push('已注册到 state_5.sqlite threads + session_index.jsonl');
        } catch (regErr) {
          // 注册失败不回滚文件：resume 仍可按文件发现；提示用户重试
          result.notes.push(`threads 注册失败（${regErr.message}），rollout 文件已写入，可重试接力以重新注册`);
        }
        result.id = r.id; result.path = r.path;
        result.resumeCommand = `codex resume ${r.id}`;
      } else if (targetAgent === 'zcode') {
        if (!dbFileOverride) runBackupIfEnabled('zcode', tgtBase, 'zcode-t1', result, backup);
        const r = zcode.writeSession(msx, { cwd, dbFile: dbFileOverride, baseDir: tgtBase });
        result.id = r.id; result.path = r.path; result.loss = r.loss; result.count = r.count;
        result.resumeCommand = `在 ZCode 桌面端会话列表打开「${msx.source.title}」（新会话 id: ${r.id}）`;
      } else if (targetAgent === 'workbuddy') {
        runBackupIfEnabled('workbuddy', tgtBase, 'workbuddy-t1', result, backup);
        const r = await workbuddy.writeSession(msx, { cwd, baseDir: tgtBase });
        result.id = r.id; result.path = r.path; result.loss = r.loss; result.count = r.count;
        result.resumeCommand = `在 WorkBuddy 桌面端打开项目「${cwd}」的会话列表查看「${msx.source.title}」（新会话 id: ${r.id}）`;
        result.notes.push('WorkBuddy 无 CLI resume，已写入其原生 jsonl + sessions 表注册；桌面端可见后即可继续');
      } else if (targetAgent === 'opencode') {
        const oc = require('./opencode');
        runBackupIfEnabled('opencode', tgtBase, 'opencode-t1', result, backup);
        const r = oc.writeSession(msx, { cwd, baseDir: tgtBase });
        result.id = r.id; result.path = r.path; result.loss = r.loss; result.count = r.count;
        result.resumeCommand = `opencode（在项目 ${cwd} 打开）→ 会话列表选择「${msx.source.title}」（新会话 id: ${r.id}）`;
        result.notes.push('OpenCode 无公开 CLI resume 语法，已写入其原生 opencode.db（session/message/part 表），桌面端/CLI 会话列表可见');
      } else {
        throw new Error(targetAgent + ' 暂不支持 T1 原生写入；请用 T2 逐字转写注入');
      }
      result.ok = true;
    } else {
      throw new Error('未知 mode: ' + mode);
    }
    return finish();
  } catch (err) {
    result.ok = false;
    result.error = err.message;
    return finish();
  }

  function finish() {
    result.ms = Date.now() - t0;
    if (result.ok && !dryRun) { try { agents.bustListCache(); } catch { } }
    const entry = {
      type: 'transfer', ok: result.ok, source: result.sourceAgent + ':' + result.sessionId,
      target: result.targetAgent, mode: result.mode, cwd: result.cwd, id: result.id,
      ms: result.ms, error: result.error || null,
    };
    (result.ok ? logger.info : logger.error)('transfer', entry);
    if (!result.ok) result.hint = errorHint(result.error);
    // loss 去重 + 上限：大会话（数万条标记）可能累积出 MB 级清单，MCP/HTTP 响应都要带它
    if (Array.isArray(result.loss)) {
      const uniq = [...new Set(result.loss)];
      result.loss = uniq.length > 200 ? uniq.slice(0, 200).concat([`…另有 ${uniq.length - 200} 条同类说明`]) : uniq;
    }
    return result;
  }
}

function describeTarget(agent, cwd, baseDir) {
  if (agent === 'claude') return (baseDir ? baseDir + '/projects/' : '~/.claude/projects/') + require('./util').slugifyClaude(cwd) + '/';
  if (agent === 'codex') return '~/.codex/sessions/ + state_5.sqlite';
  if (agent === 'zcode') return '~/.zcode/cli/db/db.sqlite';
  if (agent === 'workbuddy') return '~/.workbuddy-ai/projects/ + workbuddy.db';
  if (agent === 'opencode') return (baseDir ? baseDir : '~/.local/share/opencode') + '/opencode.db';
  return String(cwd);
}

function t2Command(targetAgent, fileName) {
  const rel = `.agentrelay/${fileName}`;
  if (targetAgent === 'claude') {
    return `claude（在该项目目录启动后发送）: 请完整逐字阅读 ${rel}——这是上一个会话的原封不动记录（含全部工具调用与结果），把它当作你自己的记忆继续工作，先总结你接手时的状态，再继续完成最后一个未完成任务。`;
  }
  if (targetAgent === 'codex') {
    return `codex（在该项目目录启动后发送）: 请完整逐字阅读 ${rel}——这是上一个会话的原封不动记录（含全部工具调用与结果），把它当作你自己的记忆继续工作，先总结你接手时的状态，再继续完成最后一个未完成任务。`;
  }
  if (targetAgent === 'zcode') {
    return `ZCode（在该项目目录启动后发送）: 请完整逐字阅读 ${rel}——这是上一个会话的原封不动记录（含全部工具调用与结果），把它当作你自己的记忆继续工作，先总结你接手时的状态，再继续完成最后一个未完成任务。`;
  }
  return `在目标 agent 新会话中发送: 请完整逐字阅读 ${rel} 并继续之前的工作。`;
}

// 批量：把一个源会话接力给多个目标
async function transfer({ sourceAgent, sessionId, targets, options = {}, dryRun = false, sourceInstance = null, backup = null }) {
  const results = [];
  for (const t of targets || []) {
    results.push(await transferOne({ sourceAgent, sessionId, sourceInstance: t.sourceInstance || sourceInstance || null, targetAgent: t.agent, cwd: t.cwd, mode: t.mode || 'T1', options, dryRun, dbFileOverride: t.dbFileOverride || null, targetInstance: t.instance || null, backup }));
  }
  return results;
}

module.exports = { transferOne, transfer, writeMsxFile, writeBundleStream, backupTargetsFor, runBackupIfEnabled };
