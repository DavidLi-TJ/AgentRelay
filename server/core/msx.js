'use strict';
// ARX (AgentRelay eXchange) v1（内部模块名沿用 msx） —— 统一中间格式 + 选择性加载引擎
const { estimateTokens, truncateStr } = require('./util');

function blockText(b) {
  switch (b.type) {
    case 'text': return b.text || '';
    case 'thinking': return b.text || '';
    case 'tool_use': return JSON.stringify(b.input ?? {});
    case 'tool_result': return typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? '');
    case 'image': return '[image]';
    default: return JSON.stringify(b);
  }
}

function estimateEntryTokens(e) {
  let n = 0;
  for (const b of e.blocks || []) n += estimateTokens(blockText(b));
  return n;
}

function computeStats(entries) {
  const stats = { entries: entries.length, userTurns: 0, assistantEntries: 0, toolCalls: 0, toolResults: 0, thinking: 0, approxTokens: 0 };
  for (const e of entries) {
    if (e.role === 'user' && e.kind === 'text') stats.userTurns++;
    if (e.role === 'assistant') stats.assistantEntries++;
    stats.approxTokens += estimateEntryTokens(e);
    for (const b of e.blocks || []) {
      if (b.type === 'tool_use') stats.toolCalls++;
      if (b.type === 'tool_result') stats.toolResults++;
      if (b.type === 'thinking') stats.thinking++;
    }
  }
  return stats;
}

function entryPreview(e, n = 120) {
  for (const b of e.blocks || []) {
    if (b.type === 'text' && b.text) return truncateStr(b.text.replace(/\s+/g, ' ').trim(), n);
    if (b.type === 'tool_use') return `[工具调用] ${b.name} ${truncateStr(JSON.stringify(b.input ?? {}), n - 12)}`;
    if (b.type === 'tool_result') return `[工具结果] ${truncateStr(String(typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? '')).replace(/\s+/g, ' '), n)}`;
    if (b.type === 'thinking' && b.text) return `[思考] ${truncateStr(b.text.replace(/\s+/g, ' '), n)}`;
  }
  return `[${e.kind}]`;
}

function firstUserText(entries) {
  for (const e of entries) {
    if (e.role === 'user' && e.kind === 'text') {
      for (const b of e.blocks || []) if (b.type === 'text' && b.text) return b.text;
    }
  }
  return '';
}

function titleFromEntries(entries, fallback = '(无标题会话)') {
  const t = firstUserText(entries).replace(/\s+/g, ' ').trim();
  return t ? truncateStr(t, 60) : fallback;
}

// ---------- 选择性加载 ----------
// 调用/结果配对收敛：孤儿 tool_use 与孤儿 tool_result 双向剥离，保证目标 agent（尤其 Claude API）可 resume
function enforceToolPairing(list, loss) {
  const resultFor = new Set();
  for (const e of list) for (const b of e.blocks) if (b.type === 'tool_result' && b.for) resultFor.add(b.for);
  let strippedCalls = 0;
  for (const e of list) {
    const nb = e.blocks.filter((b) => b.type !== 'tool_use' || !b.id || resultFor.has(b.id));
    strippedCalls += e.blocks.length - nb.length;
    if (nb.length !== e.blocks.length) e.blocks = nb;
  }
  if (strippedCalls) loss.push(`已同步剥离 ${strippedCalls} 个失去结果的工具调用（保持调用/结果配对完整，避免目标 agent resume 报错）`);
  const callIds = new Set();
  for (const e of list) for (const b of e.blocks) if (b.type === 'tool_use' && b.id) callIds.add(b.id);
  let strippedResults = 0;
  list = list.filter((e) => {
    if (e.kind !== 'tool-result') return true;
    const kept = e.blocks.filter((b) => b.type === 'tool_result' && callIds.has(b.for));
    strippedResults += e.blocks.length - kept.length;
    if (!kept.length) return false;
    e.blocks = kept;
    return true;
  });
  if (strippedResults) loss.push(`已同步剥离 ${strippedResults} 个失去调用的工具结果`);
  const before = list.length;
  list = list.filter((e) => !(e.role === 'assistant' && e.blocks.length === 0));
  if (list.length < before) loss.push(`已移除 ${before - list.length} 条清空后的条目`);
  return list;
}

// opts: {from,to,includeThinking,includeToolUse,includeToolResults,includeMeta,
//        truncateToolOutputKB,budgetTokens,redact,toolNameFilter,excludeIds}
function selectEntries(entries, opts = {}, loss = []) {
  const from = Number.isFinite(Number(opts.from)) && Number(opts.from) >= 0 ? Number(opts.from) : 0;
  const toRaw = Number(opts.to);
  const to = Number.isFinite(toRaw) && toRaw > 0 ? Math.min(toRaw, entries.length) : entries.length;
  const {
    includeThinking = true, includeToolUse = true, includeToolResults = true,
    includeMeta = true, truncateToolOutputKB = 0, budgetTokens = 0, toolNameFilter = null,
    excludeIds = null,
  } = opts;
  let list = entries.slice(from, to).map((e) => ({ ...e, blocks: [...(e.blocks || [])] }));

  if (excludeIds && excludeIds.length) {
    const s = new Set(Array.isArray(excludeIds) ? excludeIds : [String(excludeIds)]);
    const before = list.length;
    list = list.filter((e) => !s.has(e.id));
    if (list.length < before) loss.push(`已手动排除 ${before - list.length} 条（GUI 逐条勾选）`);
  }

  if (!includeMeta) {
    const before = list.length;
    list = list.filter((e) => !(e.role === 'meta' || e.role === 'system'));
    if (list.length < before) loss.push(`已排除 ${before - list.length} 条 meta/system 条目`);
  }
  if (!includeToolResults) {
    const before = list.length;
    list = list.filter((e) => e.kind !== 'tool-result');
    if (list.length < before) loss.push(`已排除 ${before - list.length} 条工具结果`);
  }
  if (Array.isArray(toolNameFilter) && toolNameFilter.length) {
    const allow = new Set(toolNameFilter);
    const before = list.length;
    list = list.filter((e) => {
      if (e.kind === 'tool-result') return true; // 与工具调用一起在下一步过滤
      if (e.role === 'assistant') return true;
      return true;
    });
    // 移除不在白名单里的 tool_use 块
    for (const e of list) {
      e.blocks = e.blocks.filter((b) => b.type !== 'tool_use' || allow.has(b.name));
    }
    loss.push(`应用工具白名单: ${toolNameFilter.join(', ')}`);
  }
  if (!includeToolUse) {
    for (const e of list) {
      const nb = e.blocks.filter((b) => b.type !== 'tool_use');
      if (nb.length !== e.blocks.length) loss.push('已排除部分工具调用块');
      e.blocks = nb;
    }
    // 没有工具调用块的 assistant 条目若无文本/思考也去掉
    const before = list.length;
    list = list.filter((e) => !(e.role === 'assistant' && e.blocks.length === 0));
    if (list.length < before) loss.push(`已移除 ${before - list.length} 条空工具调用条目`);
  }
  if (!includeThinking) {
    for (const e of list) {
      const nb = e.blocks.filter((b) => b.type !== 'thinking');
      if (nb.length !== e.blocks.length) loss.push('已按选项剥离思考(thinking/reasoning)内容');
      e.blocks = nb;
    }
  }
  // 双向配对清理：Claude API 要求 tool_use 后必须紧跟 tool_result，孤儿的"结果"和"调用"都要剥离
  list = enforceToolPairing(list, loss);
  // 孤儿工具结果清理（其对应的 tool_use 已被过滤）
  const usedCallIds = new Set();
  for (const e of list) for (const b of e.blocks) if (b.type === 'tool_use' && b.id) usedCallIds.add(b.id);
  const beforeOrphan = list.length;
  list = list.filter((e) => {
    if (e.kind !== 'tool-result') return true;
    const kept = e.blocks.filter((b) => b.type === 'tool_result' && usedCallIds.has(b.for));
    if (kept.length === 0) return false;
    e.blocks = kept;
    return true;
  });
  if (list.length < beforeOrphan) loss.push(`已移除 ${beforeOrphan - list.length} 条失去对应调用的工具结果`);

  if (truncateToolOutputKB > 0) {
    const limit = truncateToolOutputKB * 1024;
    for (const e of list) {
      for (const b of e.blocks) {
        if (b.type === 'tool_result') {
          const out = typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? '');
          if (out.length > limit) {
            b.output = out.slice(0, limit) + `\n…[AgentRelay 截断：原始 ${out.length} 字符]`;
            b.truncated = true;
          }
        }
      }
    }
  }

  // token 预算：增量计算（严禁每次全量重算——大会话会挂死单线程服务）
  if (budgetTokens > 0) {
    const est = new Map();
    let total = 0;
    for (const e of list) { const v = estimateEntryTokens(e); est.set(e, v); total += v; }
    const budgetLoss = { thinking: 0, trunc: 0, dropped: 0 };
    let guard = 0;
    while (total > budgetTokens && list.length && guard++ < 500000) {
      // 1) 一轮剥掉全部思考块
      if (list.some((e) => e.blocks.some((b) => b.type === 'thinking'))) {
        for (const e of list) {
          const removed = e.blocks.filter((b) => b.type === 'thinking').length;
          if (!removed) continue;
          e.blocks = e.blocks.filter((b) => b.type !== 'thinking');
          const v = estimateEntryTokens(e);
          total -= est.get(e) - v; est.set(e, v);
          budgetLoss.thinking += removed;
        }
        continue;
      }
      // 2) 截大工具输出（已截断的跳过；截断后必须 < 400 阈值，防止同一块被反复"截断"造成活锁）
      //    一轮内批量截断所有超限块，避免每次只截一个再从头重扫的 O(n²)
      let truncatedAny = false;
      for (const e of list) {
        for (const b of e.blocks) {
          if (b.type === 'tool_result' && !b.truncated) {
            const out = typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? '');
            if (out.length > 400) {
              b.output = out.slice(0, 380) + '…[预算截断]'; b.truncated = true;
              const v = estimateEntryTokens(e);
              total -= est.get(e) - v; est.set(e, v);
              budgetLoss.trunc++; truncatedAny = true;
            }
          }
        }
      }
      if (truncatedAny) continue;
      // 3) 按累计量批量丢弃最旧的非用户条目（避免逐条 O(n²)）
      const excess = total - budgetTokens;
      const dropIdxs = [];
      let acc = 0;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e.role === 'user' && e.kind === 'text') continue;
        dropIdxs.push(i); acc += est.get(e) || 0;
        if (acc >= excess) break;
      }
      let forcedUserDrop = false;
      if (!dropIdxs.length) {
        if (list.length > 2) { dropIdxs.push(1); forcedUserDrop = true; }
        else break;
      }
      for (let k = dropIdxs.length - 1; k >= 0; k--) {
        total -= est.get(list[dropIdxs[k]]) || 0;
        est.delete(list[dropIdxs[k]]);
        list.splice(dropIdxs[k], 1);
      }
      budgetLoss.dropped += dropIdxs.length;
      if (forcedUserDrop) loss.push('预算极限：非用户条目已耗尽，不得已丢弃了用户消息以凑预算');
    }
    if (budgetLoss.thinking) loss.push(`token 预算：剥离了 ${budgetLoss.thinking} 个思考块`);
    if (budgetLoss.trunc) loss.push(`token 预算：截断了 ${budgetLoss.trunc} 个工具输出`);
    if (budgetLoss.dropped) loss.push(`token 预算：丢弃了 ${budgetLoss.dropped} 条最旧条目`);
    // 预算丢弃可能拆散调用/结果配对，再收敛一次
    list = enforceToolPairing(list, loss);
  }
  return list;
}

// ---------- 脱敏 ----------
const REDACT_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED-key]'],
  [/\brk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED-key]'],
  [/\bghp_[A-Za-z0-9]{20,}\b/g, '[REDACTED-github]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED-github]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED-aws]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED-slack]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED-jwt]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED-private-key]'],
  [/\bBearer\s+[A-Za-z0-9._-]{16,}\b/g, 'Bearer [REDACTED]'],
  [/(api[_-]?key|apikey|secret|access[_-]?token|refresh[_-]?token|password|passwd|pwd|authorization)\s*[:=]\s*["']?([A-Za-z0-9_\-./+=]{12,})["']?/gi,
    (m, p1) => `${p1}: [REDACTED]`],
];

function redactString(s, counter) {
  let out = String(s);
  for (const [re, rep] of REDACT_PATTERNS) {
    out = out.replace(re, (...args) => {
      counter.n++;
      return typeof rep === 'function' ? rep(...args) : rep;
    });
  }
  return out;
}

function redactDeep(obj, counter) {
  if (typeof obj === 'string') return redactString(obj, counter);
  if (Array.isArray(obj)) return obj.map((v) => redactDeep(v, counter));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = redactDeep(obj[k], counter);
    }
    return out;
  }
  return obj;
}

function redactMsx(msx) {
  const counter = { n: 0 };
  const entries = redactDeep(msx.entries, counter);
  // title 取自首条用户消息、env.instructions 可能含配置片段——一并脱敏
  const extra = { title: msx.source && msx.source.title, env: msx.env };
  const cleaned = redactDeep(extra, counter);
  const title = cleaned && cleaned.title;
  const env = cleaned && cleaned.env;
  if (counter.n > 0) msx.loss = [...(msx.loss || []), `已脱敏 ${counter.n} 处疑似秘钥/凭据`];
  return { ...msx, entries, source: { ...(msx.source || {}), title }, env };
}

// 最近一次 compact 边界起点的条目下标（无 compact 记录时 -1）。
// 用 >= 边界时间戳：压缩标记/压缩摘要本身也留在活上下文里，属于要接走的"记忆"。
// 时间戳统一 Date.parse 数值比较（不同适配器时区/精度格式不同，字符串比较会错位）。
function lastCompactionIndex(entries, compactions) {
  if (!Array.isArray(compactions) || !compactions.length) return -1;
  const ts = compactions[compactions.length - 1].ts;
  if (!ts || !Array.isArray(entries)) return -1;
  const boundary = Date.parse(ts);
  const useNumeric = Number.isFinite(boundary);
  return entries.findIndex((e) => {
    if (!e.ts) return false;
    if (!useNumeric) return String(e.ts) >= String(ts);
    const t = Date.parse(e.ts);
    return Number.isFinite(t) ? t >= boundary : String(e.ts) >= String(ts);
  });
}

module.exports = {
  estimateEntryTokens, computeStats, entryPreview, firstUserText, titleFromEntries,
  selectEntries, redactMsx, blockText, lastCompactionIndex, enforceToolPairing,
};
