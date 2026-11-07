'use strict';
// ARX → Markdown 逐字导出：只做渲染，不改写内容。
// 正文原样输出；工具输入/输出、思考块放进围栏代码块（围栏长度按内容内最长的反引号串自适应，
// 保证含 ``` 的输出不会被截断）。选择（裁剪/脱敏）在调用方完成后传入，这里不做任何过滤。

const ROLE_LABEL = {
  user: '用户',
  assistant: '助手',
  meta: '系统',
  system: '系统',
};

function fenceOf(text) {
  const runs = String(text ?? '').match(/`+/g) || [];
  const n = Math.max(3, ...runs.map((r) => r.length + 1), 3);
  return '`'.repeat(n);
}

function codeBlock(text, lang) {
  const f = fenceOf(text);
  return f + (lang || '') + '\n' + String(text ?? '') + (String(text ?? '').endsWith('\n') ? '' : '\n') + f;
}

function kindLabel(e) {
  if (e.kind === 'tool-result') return '工具结果';
  return ROLE_LABEL[e.role] || e.role || '未知';
}

function entryToMarkdown(e, idx) {
  const ts = e.ts ? ' · ' + String(e.ts).slice(0, 19).replace('T', ' ') : '';
  const out = [`## ${idx + 1}. ${kindLabel(e)}${ts}`, ''];
  for (const b of e.blocks || []) {
    if (b.type === 'text') {
      out.push(String(b.text ?? ''), '');
    } else if (b.type === 'thinking') {
      out.push('<details>', '<summary>💭 思考过程</summary>', '', codeBlock(b.text, ''), '', '</details>', '');
    } else if (b.type === 'tool_use') {
      out.push(`**🔧 工具调用 \`${b.name || 'tool'}\`**`, '', codeBlock(JSON.stringify(b.input ?? {}, null, 2), 'json'), '');
    } else if (b.type === 'tool_result') {
      const err = b.isError ? '（错误）' : '';
      out.push(`**↩️ 工具结果**${err}`, '', codeBlock(typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? '', null, 2), ''), '');
    }
  }
  return out.join('\n');
}

function msxToMarkdown(msx) {
  const s = msx.source || {};
  const p = msx.project || {};
  const st = msx.stats || {};
  const head = [
    `# ${s.title || '(无标题)'}`,
    '',
    `> **来源**: ${s.agent || '?'} \`${s.session_id || '?'}\`  `,
    `> **项目**: \`${p.cwd || '?'}\`  `,
    `> **导出**: ${new Date().toISOString().slice(0, 19).replace('T', ' ')} · ${st.entries ?? (msx.entries || []).length} 条 · ~${st.approxTokens ?? 0} tokens  `,
    '> **由 AgentRelay 逐字导出**',
    '',
    '---',
    '',
  ].join('\n');
  const body = (msx.entries || []).map((e, i) => entryToMarkdown(e, i)).join('\n---\n\n');
  return head + body + '\n';
}

module.exports = { msxToMarkdown };
