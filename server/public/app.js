'use strict';
/* AgentRelay GUI v3 —— 实例化 agent · 惰性加载 · 接力向导 · 活动时间线 · 主题/双语 */

const AGENT_COLORS = { claude: '#d97757', codex: '#10a37f', zcode: '#4f7cff', workbuddy: '#3c8cff', opencode: '#e8a33d', gemini: '#4796e3', pi: '#c9a227', openclaw: '#e05e3d', dsh: '#2aa8c9' };
const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex CLI', zcode: 'ZCode', workbuddy: 'WorkBuddy', opencode: 'OpenCode', gemini: 'Gemini CLI', pi: 'Pi', openclaw: 'OpenClaw', dsh: 'DeepSeek Harness' };

const state = {
  instances: [],
  sessionsByInstance: {},
  instStatus: {},
  sessionsLoaded: false,
  currentAgent: 'all',
  sessions: [],
  current: null,          // { instance, agent, id, title, msx, total, hasMore, previewTruncated }
  excluded: new Set(),
  options: {
    includeThinking: true, includeToolResults: true, includeMeta: false,
    from: 0, truncateToolOutputKB: 32, budgetTokens: 0, redact: false,
  },
  searchActive: false,
  searchTimer: null,
  targets: [],
  config: {},
  relay: null,
  relayPreset: null,
  relayPresetOptions: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const typeColor = (t) => AGENT_COLORS[t] || '#9b9ba3';
const typeName = (t) => AGENT_NAMES[t] || t;
const backupDefault = () => state.config.backupEnabled !== false;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(ts) { return ts ? String(ts).slice(0, 16).replace('T', ' ') : '?'; }
function fmtRelTime(ts) {
  if (!ts) return '';
  const ms = Date.now() - (Date.parse(ts) || NaN);
  if (!Number.isFinite(ms) || ms < 0) return fmtTime(ts);
  if (ms < 60000) return t('刚刚');
  if (ms < 3600000) return Math.floor(ms / 60000) + ' ' + t('分钟前');
  if (ms < 86400000) return Math.floor(ms / 3600000) + ' ' + t('小时前');
  if (ms < 86400000 * 30) return Math.floor(ms / 86400000) + ' ' + t('天前');
  return fmtTime(ts);
}
function fmtSize(n) {
  if (n == null) return '';
  if (n > 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + 'GB';
  if (n > 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + 'MB';
  if (n > 1024) return (n / 1024).toFixed(0) + 'KB';
  return n + 'B';
}
function fmtTokens(n) {
  if (n == null) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'K';
  return String(Math.round(n));
}
async function api(path, opts) {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toast-box').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}
function copyText(txt) {
  navigator.clipboard.writeText(txt).then(() => toast(t('已复制'))).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = txt; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove(); toast(t('已复制'));
  });
}
function shortPath(p) {
  if (!p) return '';
  // Windows C:\Users\xxx → ~ ；POSIX /home/xxx → ~
  return String(p).replace(/^C:\\Users\\[^\\]+/i, '~').replace(/^\/home\/[^/]+/i, '~').replace(/\\/g, '/');
}

/* ---------------- 主题 / 语言 ---------------- */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('ms-theme', theme);
  const btn = $('#btn-theme');
  if (btn) btn.innerHTML = icon(theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'monitor');
  const sel = $('#set-theme'); if (sel) sel.value = theme;
  const wiz = $('#wiz-theme'); if (wiz) wiz.value = theme;
}
$('#btn-theme').addEventListener('click', () => {
  const cur = localStorage.getItem('ms-theme') || 'dark';
  applyTheme(cur === 'dark' ? 'light' : cur === 'light' ? 'system' : 'dark');
});
$('#btn-lang').addEventListener('click', () => {
  window.setLang(window.MS_LANG === 'zh-CN' ? 'en-US' : 'zh-CN');
  renderAll();
});

function renderAll() {
  renderRail(); renderSessions(); renderRelay(); loadActivity().catch(() => { });
  renderQuickStart();
  // 语言切换时正在显示的视图也要重渲染（表格头/详情等 JS 渲染文案）
  if (document.querySelector('#view-settings.active')) loadSettings().catch(() => { });
  if (state.current) { renderDetail(); refreshPreview(); }
}

/* ---------------- 导航 ---------------- */
$$('.tab').forEach((b) => b.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  $$('.view').forEach((v) => v.classList.remove('active'));
  $('#view-' + b.dataset.view).classList.add('active');
  if (b.dataset.view === 'activity') loadActivity().catch(() => { });
  if (b.dataset.view === 'diagnostics') loadDiagnostics().catch(() => { });
  if (b.dataset.view === 'relay') renderRelay();
  if (b.dataset.view === 'settings') loadSettings().catch(() => { });
}));
$('#btn-refresh').addEventListener('click', () => { state.searchActive = false; loadAgents(true); toast(t('已刷新')); });
$('#search').addEventListener('input', () => {
  if (state.searchActive) { state.searchActive = false; renderSessions(); }
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => renderSessions(), 200);
});
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { state.searchActive = false; $('#search').value = ''; renderSessions(); return; }
  if (e.key !== 'Enter') return;
  const q = $('#search').value.trim();
  if (q.length < 2) return;
  fullTextSearch(q);
});

/* ---------------- 实例与会话（惰性） ---------------- */
async function loadAgents(refresh = false) {
  state.instances = await api('/api/agents');
  if (refresh) { state.sessionsByInstance = {}; state.sessionsLoaded = false; }
  renderRail();
  renderSessions();
  if (!state.sessionsLoaded) ensureSessions();
}

async function ensureSessions() {
  state.sessionsLoaded = true;
  for (const inst of state.instances) {
    if (state.sessionsByInstance[inst.id] || state.instStatus[inst.id] === 'loading') continue;
    state.instStatus[inst.id] = 'loading';
    renderRail();
    try {
      state.sessionsByInstance[inst.id] = await api(`/api/sessions?instance=${encodeURIComponent(inst.id)}`);
      state.instStatus[inst.id] = 'ok';
    } catch {
      state.instStatus[inst.id] = 'error';
      state.sessionsByInstance[inst.id] = [];
    }
    renderRail();
    if (!state.searchActive) renderSessions();
    if (state.relay) renderRelaySrcList();
  }
}
function instStatusOf(inst) {
  if (state.sessionsByInstance[inst.id]) return 'ok';
  return state.instStatus[inst.id] || '';
}

function renderRail() {
  const rail = $('#agent-rail');
  const total = state.instances.reduce((s, a) => s + a.sessionCount, 0);
  let html = `<div class="agent-card ${state.currentAgent === 'all' ? 'selected' : ''}" data-agent="all"><div class="agent-inner">
    <div class="agent-head"><span class="agent-dot" style="background:var(--accent)"></span>
    <span class="agent-name">${esc(t('全部'))}</span><span class="agent-count">${total}</span></div></div></div>`;
  for (const a of state.instances) {
    const st = instStatusOf(a);
    const statusHtml = st === 'loading'
      ? `<div class="agent-status"><span class="spinner"></span> ${esc(t('扫描中…'))}</div>`
      : st === 'error' ? `<div class="agent-status err">${esc(t('加载失败'))}</div>` : '';
    html += `<div class="agent-card ${state.currentAgent === a.id ? 'selected' : ''} ${a.available ? '' : 'off'}" data-agent="${esc(a.id)}" title="${esc(a.storage || '')}">
      <div class="agent-inner">
      <div class="agent-head">
        <span class="agent-dot" style="background:${typeColor(a.type)}"></span>
        <span class="agent-name">${esc(a.name)}</span>
        <span class="agent-count">${a.sessionCount}</span>
      </div>
      <div class="agent-store">${a.available ? esc(shortPath(a.storage)) : esc(t('未检测到存储'))}</div>
      ${statusHtml}</div></div>`;
  }
  rail.innerHTML = html;
  $$('#agent-rail .agent-card').forEach((c) => c.addEventListener('click', () => {
    state.currentAgent = c.dataset.agent;
    renderRail(); renderSessions();
  }));
}

function allSessionsLoaded() {
  return state.instances.flatMap((i) => (state.sessionsByInstance[i.id] || []).map((s) => ({ ...s, instance: i.id, agent: i.type })));
}

function renderSessions() {
  if (state.searchActive) return;
  const q = $('#search').value.trim().toLowerCase();
  let list = allSessionsLoaded();
  if (state.currentAgent !== 'all') list = list.filter((s) => s.instance === state.currentAgent);
  if (q) list = list.filter((s) => (s.title || '').toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q));
  list.sort((a, b) => String(b.tsLast || '').localeCompare(String(a.tsLast || '')));
  state.sessions = list;
  const pending = state.instances.filter((i) => instStatusOf(i) === 'loading').length;
  $('#list-count').textContent = `${list.length} ${t('个会话')}` + (pending ? ` · ${t('正在加载')} ${pending}…` : '');
  const box = $('#session-list');
  const MAX = 400;
  const shown = list.slice(0, MAX);
  box.innerHTML = shown.map((s) => `
    <div class="sess-item ${state.current && state.current.id === s.id && state.current.instance === s.instance ? 'selected' : ''}" data-instance="${esc(s.instance)}" data-id="${esc(s.id)}">
      <span class="sess-dot" style="background:${typeColor(s.agent)}"></span>
      <div class="sess-body">
        <div class="sess-title">${esc(s.title || t('（无标题）'))}</div>
        <div class="sess-meta">
          <span title="${esc(fmtTime(s.tsLast))}">${fmtRelTime(s.tsLast)}</span>
          ${s.cwd ? `<span title="${esc(s.cwd)}">${esc(shortPath(s.cwd))}</span>` : ''}
          ${s.msgCount != null ? `<span>${s.msgCount}${t('条')}</span>` : ''}
          ${s.tokens ? `<span>${fmtTokens(s.tokens)} tok</span>` : ''}
        </div>
      </div>
    </div>`).join('')
    + (list.length > MAX ? `<div class="muted" style="padding:12px">${t('仅显示最近 400 条，请用搜索缩小范围')}</div>` : '');
  $$('#session-list .sess-item').forEach((el) => el.addEventListener('click', () => openDetail(el.dataset.instance, el.dataset.id)));
}

/* ---------------- 详情（分页 + 逐条勾选） ---------------- */
function showDetailLoading() {
  $('#empty-detail').classList.add('hidden');
  const d = $('#detail');
  d.classList.remove('hidden');
  const lines = Array.from({ length: 8 }, (_, i) =>
    `<div class="entry"><div class="skeleton" style="width:44px;height:14px"></div><div class="skeleton" style="width:${52 + (i % 3) * 16}%"></div></div>`).join('');
  d.innerHTML = `
    <div class="detail-head">
      <div class="detail-loading-head"><span class="spinner"></span> ${esc(t('正在加载会话'))}</div>
      <div class="skeleton" style="width:42%;height:20px;margin-top:10px"></div>
      <div class="skeleton" style="width:66%;margin-top:8px"></div>
    </div>
    <div class="sel-bar"><div class="skeleton" style="width:88%"></div></div>
    <div class="entries">${lines}</div>`;
}

async function openDetail(instance, id) {
  const timer = setTimeout(() => toast(t('正在加载会话')), 600);
  showDetailLoading();
  try {
    const msx = await api(`/api/session?instance=${encodeURIComponent(instance)}&id=${encodeURIComponent(id)}&limit=200`);
    const inst = state.instances.find((i) => i.id === instance);
    state.current = {
      instance, agent: inst ? inst.type : 'claude', id, title: msx.source.title, msx,
      total: msx.total || msx.entries.length, hasMore: !!msx.hasMore, previewTruncated: !!msx.previewTruncated,
    };
    state.excluded = new Set();
    state.options.from = 0;
    clearTimeout(timer);
    renderDetail();
    renderSessions();
  } catch (e) {
    clearTimeout(timer);
    // 加载失败回到空态，不留骨架屏
    const d = $('#detail');
    d.classList.add('hidden');
    d.innerHTML = '';
    $('#empty-detail').classList.remove('hidden');
    toast(t('加载失败: ') + e.message, 'err');
  }
}

function renderBlock(b) {
  if (b.type === 'text') {
    const tx = b.text || '';
    return `<div class="t">${esc(tx.length > 2048 ? tx.slice(0, 2048) + '…' : tx)}</div>`;
  }
  if (b.type === 'thinking') return `<div class="entry-body thinking"><span class="ic-inline">${icon('brain')}</span>${esc((b.text || '').slice(0, 300))}${(b.text || '').length > 300 ? '…' : ''}</div>`;
  if (b.type === 'tool_use') return `<div class="entry-body"><span class="tool-tag">${icon('wrench')} ${esc(b.name)}</span> <span class="muted">${esc(JSON.stringify(b.input ?? {}).slice(0, 200))}</span></div>`;
  if (b.type === 'tool_result') {
    const out = typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? '');
    return `<div class="entry-body"><span class="tool-tag">↳</span> <span class="muted">${esc(out.slice(0, 260))}${out.length > 260 ? `…[${out.length}]` : ''}</span></div>`;
  }
  if (b.type === 'image') return `<div class="entry-body muted">${icon('image')} image</div>`;
  return '';
}

function renderDetail() {
  $('#empty-detail').classList.add('hidden');
  const d = $('#detail');
  d.classList.remove('hidden');
  const { msx, agent } = state.current;
  const o = state.options;
  const lastTs = msx.entries.length ? msx.entries[msx.entries.length - 1].ts : '';
  const lastCompact = Number.isInteger(msx.lastCompactionIndex) ? msx.lastCompactionIndex : -1;
  d.innerHTML = `
    <div class="detail-head">
      <div class="detail-title">${esc(msx.source.title)}</div>
      <div class="detail-sub">
        <span class="badge" style="border-color:${typeColor(agent)}">${esc(typeName(agent))}</span>
        ${esc(msx.project.cwd || '')} · ${msx.stats.entries} ${t('条')} · ${msx.stats.userTurns} ${t('轮')} · ${msx.stats.toolCalls} ${t('工具调用')} · ~${fmtTokens(msx.stats.approxTokens)} tokens
        <span title="${esc(fmtTime(lastTs))}"> · ${t('最后活动')} ${fmtRelTime(lastTs)}</span>
      </div>
    </div>
    <div class="sel-bar">
      <label><input type="checkbox" id="opt-thinking" ${o.includeThinking ? 'checked' : ''}> ${esc(t('思考'))}</label>
      <label><input type="checkbox" id="opt-toolres" ${o.includeToolResults ? 'checked' : ''}> ${esc(t('工具结果'))}</label>
      <label><input type="checkbox" id="opt-meta" ${o.includeMeta ? 'checked' : ''}> ${esc(t('系统注入'))}</label>
      <label><input type="checkbox" id="opt-redact" ${o.redact ? 'checked' : ''}> ${esc(t('脱敏'))}</label>
      <span class="divider"></span>
      <label>${esc(t('从第'))} <input type="number" id="opt-from" min="0" value="${o.from}" style="width:64px"> ${esc(t('条起'))}</label>
      <label title="${esc(t('单条工具输出超过该大小就截断，防止超大输出占满上下文；0 = 不截断'))}">${esc(t('截断工具输出'))} <input type="number" id="opt-trunc" min="0" value="${o.truncateToolOutputKB}" style="width:64px"> KB</label>
      <label>${esc(t('预算'))} <input type="number" id="opt-budget" min="0" step="1000" value="${o.budgetTokens}" style="width:84px"> tok</label>
      <select id="opt-budget-preset" title="${esc(t('快捷预算'))}">
        <option value="">${esc(t('自定义'))}</option>
        <option value="1000000">1M</option>
        <option value="512000">512K</option>
        <option value="200000">200K</option>
      </select>
      <button class="btn small ghost" id="sel-reset">${esc(t('重置排除'))}</button>
      <button class="btn small ghost" id="sel-last10">${esc(t('仅最近10轮'))}</button>
      <button class="btn small ghost" id="sel-compact" ${lastCompact < 0 ? 'disabled' : ''} title="${lastCompact < 0 ? esc(t('该会话没有 compact 记录')) : esc(t('从最近一次压缩边界之后开始接力（含压缩摘要），等价于源 agent 当前的活上下文'))}">${esc(t('从最近 compact 起'))}</button>
    </div>
    ${state.current.previewTruncated ? `<div class="muted" style="padding:12px 24px 0">${esc(t('预览截断说明'))}</div>` : ''}
    <div class="entries" id="entries"></div>
    <div class="detail-foot">
      <span class="est" id="preview-est">${esc(t('统计中…'))}</span>
      <span style="flex:1"></span>
      <button class="btn primary" id="btn-gorelay">${esc(t('去接力'))}</button>
      <button class="btn" id="btn-export">${esc(t('导出 ARX'))}</button>
    </div>`;
  renderEntries();
  bindDetailControls();
  refreshPreview();
}

const ROLE_LABEL = () => ({ user: t('用户'), assistant: t('助手'), meta: t('系统'), system: t('系统') });

function renderEntries() {
  const { msx } = state.current;
  const entries = msx.entries.slice(0, 400);
  const roles = ROLE_LABEL();
  $('#entries').innerHTML = entries.map((e) => {
    const excluded = state.excluded.has(e.id);
    const isTool = e.kind === 'tool-result';
    return `<div class="entry ${excluded ? 'excluded' : ''}" data-id="${esc(e.id)}">
      <div><input type="checkbox" ${excluded ? '' : 'checked'} data-check="${esc(e.id)}"></div>
      <div class="entry-role" style="color:${e.role === 'user' ? 'var(--accent2)' : e.role === 'assistant' ? 'var(--ok)' : 'var(--muted)'}">
        ${roles[e.role] || e.role}${isTool ? '<br>↳' : ''}<span class="entry-time">${e.ts ? fmtRelTime(e.ts) : ''}</span>
      </div>
      <div class="entry-body ${e.blocks && e.blocks[0] && e.blocks[0].type === 'thinking' ? 'thinking' : ''}">
        ${(e.blocks || []).map(renderBlock).join('')}
      </div>
    </div>`;
  }).join('')
    + (state.current.hasMore
      ? `<button class="btn small" id="load-more" style="margin:12px auto; display:block">${t('加载更多')}（${t('已加载')} ${msx.entries.length}/${state.current.total}）</button>`
      : '');
  $$('#entries .entry input[type=checkbox]').forEach((cb) => cb.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const id = cb.dataset.check;
    if (cb.checked) state.excluded.delete(id); else state.excluded.add(id);
    cb.closest('.entry').classList.toggle('excluded', !cb.checked);
    refreshPreview();
  }));
  $$('#entries .entry').forEach((el) => el.addEventListener('click', (ev) => {
    if (ev.target.tagName === 'INPUT') return;
    const cb = el.querySelector('input[type=checkbox]');
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event('click'));
  }));
  const lm = $('#load-more');
  if (lm) lm.addEventListener('click', () => loadMoreEntries());
}

async function loadMoreEntries() {
  const c = state.current;
  if (!c || !c.hasMore || c.loading) return;
  c.loading = true;
  const base = c.msx.entries.length; // 在途期间防重复拼接
  try {
    const next = await api(`/api/session?instance=${encodeURIComponent(c.instance)}&id=${encodeURIComponent(c.id)}&offset=${base}&limit=400&preview=0`);
    if (c.msx.entries.length === base) c.msx.entries = c.msx.entries.concat(next.entries);
    c.hasMore = !!next.hasMore;
    renderEntries();
  } catch (e) { toast(t('加载失败: ') + e.message, 'err'); }
  finally { c.loading = false; }
}

function bindDetailControls() {
  const bind = (id, key, type) => {
    const el = $(id);
    el.addEventListener('change', () => {
      state.options[key] = type === 'num' ? Number(el.value || 0) : el.checked;
      refreshPreview();
    });
  };
  bind('#opt-thinking', 'includeThinking', 'bool');
  bind('#opt-toolres', 'includeToolResults', 'bool');
  bind('#opt-meta', 'includeMeta', 'bool');
  bind('#opt-redact', 'redact', 'bool');
  bind('#opt-from', 'from', 'num');
  bind('#opt-trunc', 'truncateToolOutputKB', 'num');
  bind('#opt-budget', 'budgetTokens', 'num');
  $('#opt-budget-preset').addEventListener('change', () => {
    const v = $('#opt-budget-preset').value;
    const n = v === '' ? 0 : Number(v);
    $('#opt-budget').value = n;
    state.options.budgetTokens = n;
    refreshPreview();
  });
  $('#sel-reset').addEventListener('click', () => { state.excluded.clear(); renderEntries(); refreshPreview(); });
  $('#sel-last10').addEventListener('click', () => {
    const { msx } = state.current;
    const idx = [];
    msx.entries.forEach((e, i) => { if (e.role === 'user' && e.kind === 'text') idx.push(i); });
    const start = idx.length > 10 ? idx[idx.length - 10] : 0;
    state.options.from = start;
    $('#opt-from').value = start;
    state.excluded.clear();
    refreshPreview();
  });
  $('#sel-compact').addEventListener('click', () => {
    const c = state.current;
    const idx = Number.isInteger(c.msx.lastCompactionIndex) ? c.msx.lastCompactionIndex : -1;
    if (idx < 0) { toast(t('该会话没有 compact 记录'), 'warn'); return; }
    state.options.from = idx;
    $('#opt-from').value = idx;
    state.excluded.clear();
    refreshPreview();
  });
  $('#btn-gorelay').addEventListener('click', () => {
    const c = state.current;
    state.relayPreset = [{ instance: c.instance, agent: c.agent, id: c.id, title: c.title }];
    state.relayPresetOptions = currentOptions();
    $$('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelector('.tab[data-view="relay"]').classList.add('active');
    $$('.view').forEach((v) => v.classList.remove('active'));
    $('#view-relay').classList.add('active');
    initRelayState();
    state.relay.selected.set(c.instance, new Set([c.id]));
    renderRelay();
  });
  $('#btn-export').addEventListener('click', exportMsx);
}

let previewTimer = null, previewSeq = 0;
function refreshPreview() {
  clearTimeout(previewTimer);
  const seq = ++previewSeq;
  previewTimer = setTimeout(async () => {
    if (!state.current) return;
    const { instance, agent, id } = state.current;
    try {
      const r = await api('/api/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceInstance: instance, sourceAgent: agent, sessionId: id, options: currentOptions() }),
      });
      if (seq !== previewSeq) return; // 旧响应后到，丢弃
      $('#preview-est').textContent =
        `${t('将接力')} ${r.stats.entries} ${t('条')} · ${r.stats.userTurns} ${t('轮')} · ${r.stats.toolCalls} ${t('工具调用')} · ~${fmtTokens(r.stats.approxTokens)} tokens` +
        (r.loss.length ? ` · ${r.loss.length} ${t('转换说明')}` : '');
      $('#preview-est').title = r.loss.join('\n') || '';
    } catch (e) {
      if (seq !== previewSeq) return;
      $('#preview-est').textContent = t('加载失败: ') + e.message;
    }
  }, 250);
}

function currentOptions() {
  return { ...state.options, excludeIds: [...state.excluded] };
}
function batchOptions() {
  return { ...state.options, from: 0, excludeIds: [] };
}

async function exportMsx() {
  const { instance, agent, id } = state.current;
  try {
    const r = await api('/api/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceInstance: instance, sourceAgent: agent, sessionId: id, options: currentOptions() }),
    });
    toast(`${t('已导出')} ${r.entries} ${t('条')} — ${r.file}`);
    copyText(r.file);
  } catch (e) { toast(t('导出失败: ') + e.message, 'err'); }
}

/* ---------------- 全文搜索 ---------------- */
async function fullTextSearch(q) {
  state.searchActive = true;
  const box = $('#session-list');
  box.innerHTML = `<div class="muted" style="padding:16px"><span class="spinner"></span> ${esc(t('全文搜索'))}…</div>`;
  try {
    const r = await api('/api/search?q=' + encodeURIComponent(q));
    $('#list-count').textContent = `${t('全文搜索')}: ${r.results.length} ${t('个会话')}`;
    box.innerHTML = r.results.map((s) => `
      <div class="sess-item" data-instance="${esc(s.instance)}" data-id="${esc(s.sessionId)}">
        <span class="sess-dot" style="background:${typeColor(s.agent)}"></span>
        <div class="sess-body">
          <div class="sess-title">${esc(s.title || '(untitled)')}</div>
          <div class="sess-meta"><span>${s.hits} ${t('处命中')}</span>${s.cwd ? `<span>${esc(shortPath(s.cwd))}</span>` : ''}</div>
          <div class="muted" style="margin-top:4px; word-break:break-all">${esc((s.sample || '').slice(0, 180))}</div>
        </div>
      </div>`).join('') || `<div class="muted" style="padding:16px">${t('暂无结果')}</div>`;
    $$('#session-list .sess-item').forEach((el) => el.addEventListener('click', () => openDetail(el.dataset.instance, el.dataset.id)));
  } catch (e) { state.searchActive = false; toast(t('加载失败: ') + e.message, 'err'); renderSessions(); }
}

/* ---------------- 接力向导 ---------------- */
function recommendMode(srcInstance, tgtInstance) {
  const src = state.instances.find((i) => i.id === srcInstance);
  const tgt = state.instances.find((i) => i.id === tgtInstance);
  if (src && tgt && src.type === tgt.type) return 'T0';
  if (tgt && tgt.type === 'workbuddy') return 'T2';
  return 'T1';
}

/* 每个目标推荐的级别与理由（T1 通道：claude/codex/zcode/workbuddy/opencode） */
function targetAdvice(srcIid, tgtInst) {
  const src = state.instances.find((i) => i.id === srcIid);
  if (src && tgtInst && src.type === tgtInst.type) return { mode: 'T0', why: t('同源复制，100% 保真，原生 resume 直接续') };
  if (tgtInst && ['claude', 'codex', 'zcode', 'workbuddy', 'opencode'].includes(tgtInst.type)) return { mode: 'T1', why: t('原生注入并注册，resume 或会话列表直接出现') };
  return { mode: 'T2', why: t('该 agent 无原生写入适配器，逐字转写是唯一通道') };
}

function initRelayState() {
  if (state.relay) return;
  state.relay = {
    srcAgent: 'all',
    selected: new Map(),
    targets: new Set(),
    mode: 'T1',
    cwd: '',
    backup: backupDefault(),
    running: false,
    q: '',
    results: null,
  };
}

function renderRelay() {
  initRelayState();
  const m = state.relay;
  // 预设（从详情页「去接力」进入时带入选中与选项）
  if (state.relayPreset) {
    for (const s of state.relayPreset) {
      if (!m.selected.has(s.instance)) m.selected.set(s.instance, new Set());
      m.selected.get(s.instance).add(s.id);
    }
    state.relayPreset = null;
    m.mode = 'T1';
  }
  const chips = [`<button class="chip ${m.srcAgent === 'all' ? 'active' : ''}" data-src="all"><span class="dot" style="background:var(--accent)"></span>${esc(t('全部'))}</button>`];
  for (const a of state.instances) {
    chips.push(`<button class="chip ${m.srcAgent === a.id ? 'active' : ''}" data-src="${esc(a.id)}"><span class="dot" style="background:${typeColor(a.type)}"></span>${esc(a.name)} · ${a.sessionCount}</button>`);
  }
  $('#relay-src-agents').innerHTML = chips.join('');
  $$('#relay-src-agents .chip').forEach((c) => c.addEventListener('click', () => {
    m.srcAgent = c.dataset.src;
    renderRelaySrcList();
    renderRelayChips();
  }));
  function renderRelayChips() {
    $$('#relay-src-agents .chip').forEach((c) => c.classList.toggle('active', m.srcAgent === c.dataset.src));
  }
  renderRelaySrcList();
  const selCount = [...m.selected.values()].reduce((n, set) => n + set.size, 0);
  $('#relay-tgt-cards').innerHTML = state.instances.map((a) => {
    const sel = m.targets.has(a.id);
    return `<div class="tgt-card ${sel ? 'selected' : ''} ${a.available ? '' : 'disabled'}" data-tgt="${esc(a.id)}">
      <span class="agent-dot" style="background:${typeColor(a.type)}"></span>
      <div><b>${esc(a.name)}</b><div class="muted">${a.available ? a.sessionCount + ' ' + t('个会话') : t('未检测到存储')}</div></div>
    </div>`;
  }).join('');
  $$('#relay-tgt-cards .tgt-card').forEach((c) => c.addEventListener('click', () => {
    const id = c.dataset.tgt;
    const ag = state.instances.find((a) => a.id === id);
    if (ag && !ag.available) { toast(ag.name + ': ' + t('未检测到存储'), 'warn'); return; }
    if (m.targets.has(id)) m.targets.delete(id); else m.targets.add(id);
    const srcIids = [...m.selected.keys()];
    if (m.targets.size === 1) m.mode = srcIids.length === 1 && srcIids[0] === [...m.targets][0] ? 'T0' : recommendMode(srcIids[0], [...m.targets][0]);
    renderRelay();
  }));
  const srcIids0 = [...m.selected.keys()];
  const recMode = (m.targets.size === 1 && srcIids0.length)
    ? targetAdvice(srcIids0[0], state.instances.find((i) => i.id === [...m.targets][0])).mode : null;
  $('#relay-mode-cards').innerHTML = [
    ['T0', t('T0 同源复制'), t('同一 agent 内 100% 保真复制，原生 resume 直接续')],
    ['T1', t('T1 原生注入'), t('写进目标 agent 的原生存储并注册，resume 列表直接出现')],
    ['T2', t('T2 逐字转写'), t('逐字全文转写文件 + 启动指令，通用兜底')],
  ].map(([id, label, desc]) => `<div class="mode-card ${m.mode === id ? 'selected' : ''}" data-mode="${id}" title="${esc(desc)}">${recMode === id ? `<span class="rec-badge">${esc(t('推荐'))}</span>` : ''}<b>${esc(label)}</b><span>${esc(desc)}</span></div>`).join('');
  $$('#relay-mode-cards .mode-card').forEach((c) => c.addEventListener('click', () => { m.mode = c.dataset.mode; renderRelay(); }));
  const adviceBox = $('#relay-mode-advice');
  if (adviceBox) {
    if (m.targets.size && srcIids0.length) {
      const parts = [];
      let why = '';
      for (const tid of m.targets) {
        const ti = state.instances.find((i) => i.id === tid);
        if (!ti) continue;
        const a = targetAdvice(srcIids0[0], ti);
        parts.push(`${esc(ti.name)} → <b>${a.mode}</b>`);
        why = a.why;
      }
      adviceBox.innerHTML = `${esc(t('推荐'))}：${parts.join(' · ')}${m.targets.size > 1 ? ` — ${esc(t('混合目标时取公共级别；不支持原生的目标可单独再跑一次 T2'))}` : ` — ${esc(why)}`}`;
    } else {
      adviceBox.textContent = t('同源接力选 T0；跨 agent 选 T1 原生注入；目标不支持原生写入（DeepSeek Harness / Gemini CLI / Pi / OpenClaw）时选 T2 逐字转写。');
    }
  }
  // 接力参数编辑器：与详情页共享 state.options，这里可直接改
  const edBox = $('#relay-opt-editor');
  if (edBox) {
    const o = state.options;
    edBox.innerHTML = `
      <span class="opt-edit-label">${esc(t('接力参数'))}</span>
      <label class="opt-check"><input type="checkbox" id="ropt-thinking" ${o.includeThinking ? 'checked' : ''}><span>${esc(t('思考'))}</span></label>
      <label class="opt-check"><input type="checkbox" id="ropt-toolres" ${o.includeToolResults ? 'checked' : ''}><span>${esc(t('工具结果'))}</span></label>
      <label class="opt-check"><input type="checkbox" id="ropt-meta" ${o.includeMeta ? 'checked' : ''}><span>${esc(t('系统注入'))}</span></label>
      <label class="opt-check" title="${esc(t('按正则脱敏疑似秘钥/凭据后再写入'))}"><input type="checkbox" id="ropt-redact" ${o.redact ? 'checked' : ''}><span>${esc(t('脱敏'))}</span></label>
      <span class="divider"></span>
      <label class="opt-num" title="${esc(t('从第 N 条开始接力，0 = 从头'))}">${esc(t('起点'))} <input type="number" id="ropt-from" min="0" value="${o.from}"></label>
      <label class="opt-num" title="${esc(t('超过此 token 上限时从最旧的条目开始丢弃，0 = 不限'))}">${esc(t('上限'))} <input type="number" id="ropt-budget" min="0" step="1000" value="${o.budgetTokens}"> tok</label>
      <label class="opt-num" title="${esc(t('单条工具输出超过该大小就截断，防止超大输出占满上下文；0 = 不截断'))}">${esc(t('截断'))} <input type="number" id="ropt-trunc" min="0" value="${o.truncateToolOutputKB}"> KB</label>
      ${state.excluded.size ? `<span class="muted">${esc(t('逐条排除'))} ${state.excluded.size} ${esc(t('条（在会话详情页调整）'))}</span>` : ''}`;
    const bindOpt = (id, key, type) => {
      const el = $(id);
      if (!el) return;
      const apply = () => {
        state.options[key] = type === 'num' ? Math.max(0, Number(el.value) || 0) : el.checked;
      };
      el.addEventListener('change', apply);
      el.addEventListener('input', apply);
    };
    bindOpt('#ropt-thinking', 'includeThinking', 'bool');
    bindOpt('#ropt-toolres', 'includeToolResults', 'bool');
    bindOpt('#ropt-meta', 'includeMeta', 'bool');
    bindOpt('#ropt-redact', 'redact', 'bool');
    bindOpt('#ropt-from', 'from', 'num');
    bindOpt('#ropt-budget', 'budgetTokens', 'num');
    bindOpt('#ropt-trunc', 'truncateToolOutputKB', 'num');
  }
  $('#relay-cwd').value = m.cwd;
  // 手输目录实时写入状态（此前未绑定，手输路径点 Dry-run 会被判为空目录）
  $('#relay-cwd').oninput = (e) => { m.cwd = e.target.value.trim(); };
  $('#relay-backup').checked = m.backup;
  const srcCount = selCount;
  $('#relay-run').disabled = srcCount === 0;
  $('#relay-dryrun').disabled = srcCount === 0;
  if (m.results) $('#relay-results').innerHTML = m.results;
}

function renderRelaySrcList() {
  initRelayState();
  const m = state.relay;
  const q = (m.q || '').toLowerCase();
  let list = allSessionsLoaded();
  if (m.srcAgent !== 'all') list = list.filter((s) => s.instance === m.srcAgent);
  if (q) list = list.filter((s) => (s.title || '').toLowerCase().includes(q));
  list.sort((a, b) => String(b.tsLast || '').localeCompare(String(a.tsLast || '')));
  $('#relay-src-list').innerHTML = list.slice(0, 300).map((s) => {
    const checked = m.selected.get(s.instance)?.has(s.id);
    return `<div class="sess-item" data-instance="${esc(s.instance)}" data-id="${esc(s.id)}" title="${esc(t('点击预览，勾选加入接力'))}"><div><input type="checkbox" data-rsel="${esc(s.instance)}|${esc(s.id)}" ${checked ? 'checked' : ''}></div>
      <div class="sess-body"><div class="sess-title">${esc(s.title || t('（无标题）'))}</div>
      <div class="sess-meta"><span title="${esc(fmtTime(s.tsLast))}">${fmtRelTime(s.tsLast)}</span>${s.cwd ? `<span>${esc(shortPath(s.cwd))}</span>` : ''}</div></div></div>`;
  }).join('') + (list.length > 300 ? `<div class="muted" style="padding:12px">${t('仅显示最近 300 条，请用筛选缩小范围')}</div>` : '')
    + (!list.length ? `<div class="muted" style="padding:16px">${t('暂无结果')}</div>` : '');
  $$('#relay-src-list input[data-rsel]').forEach((cb) => cb.addEventListener('change', () => {
    const [iid, sid] = cb.dataset.rsel.split('|');
    if (!m.selected.has(iid)) m.selected.set(iid, new Set());
    if (cb.checked) m.selected.get(iid).add(sid); else m.selected.get(iid).delete(sid);
  }));
  // 点会话行预览（点勾选框仍是选择，不弹预览）
  $$('#relay-src-list .sess-item').forEach((el) => el.addEventListener('click', (ev) => {
    if (ev.target.tagName === 'INPUT') return;
    openSessionPreview(el.dataset.instance, el.dataset.id);
  }));
  $('#relay-src-search').oninput = (e) => { m.q = e.target.value.trim().toLowerCase(); renderRelaySrcList(); };
}

/* 接力页会话预览：只取前几条，确认是不是要接的那场 */
async function openSessionPreview(instance, id) {
  try {
    const msx = await api(`/api/session?instance=${encodeURIComponent(instance)}&id=${encodeURIComponent(id)}&limit=6`);
    const inst = state.instances.find((i) => i.id === instance);
    const agentType = inst ? inst.type : 'claude';
    const s = msx.stats || {};
    const roles = ROLE_LABEL();
    $('#modal-title').textContent = msx.source.title || t('（无标题）');
    const items = msx.entries.map((e) => {
      const parts = (e.blocks || []).map((b) => {
        if (b.type === 'text') return b.text || '';
        if (b.type === 'tool_use') return `[${b.name}]`;
        if (b.type === 'tool_result') return '↳ ' + (typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? '')).slice(0, 160);
        if (b.type === 'thinking') return `(${t('思考')}) ${(b.text || '').slice(0, 140)}`;
        return '';
      }).filter(Boolean).join('\n').slice(0, 420);
      if (!parts) return '';
      return `<div class="pv-entry" data-role="${esc(e.role)}"><span class="pv-role">${esc(roles[e.role] || e.role)}</span><div class="pv-text">${esc(parts)}${parts.length >= 420 ? '…' : ''}</div></div>`;
    }).filter(Boolean).join('');
    $('#modal-body').innerHTML = `
      <div class="pv-meta"><span class="badge" style="border-color:${typeColor(agentType)}">${esc(typeName(agentType))}</span>
        <span>${esc(shortPath(msx.project.cwd || '') || '—')}</span>
        <span>· ${msx.total} ${t('条')} · ${s.userTurns ?? 0} ${t('轮')} · ~${fmtTokens(s.approxTokens)} tokens</span></div>
      <div class="pv-list">${items || `<div class="muted" style="padding:12px">${t('暂无结果')}</div>`}</div>
      <div class="muted pv-more">${esc(t('预览只显示前几条；接力时按勾选逐字写入全部内容。'))}</div>`;
    $('#modal').classList.remove('hidden');
  } catch (e) { toast(t('加载失败: ') + e.message, 'err');
  }
}

async function runRelay(dryRun) {
  const m = state.relay;
  if (m.running) return;
  const sources = [];
  for (const [iid, set] of m.selected) {
    for (const sid of set) {
      const inst = state.instances.find((x) => x.id === iid);
      sources.push({ instance: iid, agent: inst ? inst.type : 'claude', sessionId: sid });
    }
  }
  if (!sources.length) return toast(t('请先在来源中选择会话'), 'warn');
  if (!m.targets.size) return toast(t('请选择至少一个目标 Agent'), 'warn');
  if (!m.cwd) return toast(t('请选择或输入目标项目目录'), 'warn');
  if (!dryRun && !window.confirm(t('将写入目标 agent 的真实存储（写前已自动备份）。确认执行？'))) return;
  m.running = true;
  const d = $('#relay-dryrun'), r = $('#relay-run');
  if (d) d.disabled = true; if (r) r.disabled = true;
  $('#relay-progress').textContent = dryRun ? t('预览中…') : `0/${sources.length * m.targets.size}`;
  const all = [];
  let done = 0;
  const total = sources.length * m.targets.size;
  for (const s of sources) {
    for (const iid of m.targets) {
      const inst = state.instances.find((x) => x.id === iid);
      try {
        // 单源时仅当与详情页当前会话一致才带上逐条排除（排除项跨会话会撞车）
        let opts;
        if (sources.length === 1 && state.current && state.current.instance === s.instance && state.current.id === s.sessionId) opts = currentOptions();
        else opts = batchOptions();
        const res = await api('/api/transfer', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceInstance: s.instance, sourceAgent: s.agent, sessionId: s.sessionId,
            targets: [{ agent: inst.type, instance: iid, cwd: m.cwd, mode: m.mode }],
            options: opts,
            dryRun, backup: m.backup,
          }),
        });
        all.push(...res.results);
      } catch (e) {
        all.push({ ok: false, error: e.message, sourceAgent: s.agent, targetAgent: inst.type });
      }
      done++;
      $('#relay-progress').textContent = `${done}/${total}`;
    }
  }
  const resultsHtml = all.map(resultBoxHtml).join('');
  $('#relay-results').innerHTML = resultsHtml;
  m.results = resultsHtml; // 持久化：切换选项重渲染后仍可回看上次报告
  if (all.length) $('#relay-results').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (!dryRun) {
    toast(`${t('接力完成')}: ${all.filter((x) => x.ok).length}/${total}`, all.every((x) => x.ok) ? '' : 'warn');
    loadAgents(true);
  }
  m.running = false;
  if (d) d.disabled = false; if (r) r.disabled = false;
  renderRelaySrcList();
}

function resultBoxHtml(r) {
  const head = `<b>${r.ok ? '✓' : '✕'}</b> ${esc(typeName(r.sourceAgent) || r.sourceAgent)} → ${esc(typeName(r.targetAgent) || r.targetAgent || '?')} [${esc(r.mode)}]`;
  if (!r.ok) {
    const hint = r.hint ? `<div class="hint">${icon('info')} ${esc(r.hint)}</div>` : '';
    return `<div class="result-box err">${head}<div class="muted">${esc(r.error || '')}</div>${hint}</div>`;
  }
  const bits = [];
  if (!r.dryRun && r.path) bits.push(`<div class="muted">${esc(r.path)}</div>`);
  if (r.resumeCommand) bits.push(`<div class="copy-line"><span>${esc(r.resumeCommand)}</span><button class="btn small" data-copy="${esc(r.resumeCommand)}">${esc(t('复制 resume'))}</button></div>`);
  if (r.backup) bits.push(`<div class="muted">backup: ${esc(r.backup)}</div>`);
  if (r.loss && r.loss.length) bits.push(`<details><summary class="muted">${t('转换说明')} (${r.loss.length})</summary><div class="muted">${[...new Set(r.loss)].slice(0, 8).map(esc).join('<br>')}</div></details>`);
  if (r.notes && r.notes.length) bits.push(`<div class="muted">${r.notes.map(esc).join('<br>')}</div>`);
  if (r.stats) bits.push(`<div class="muted">${r.stats.entries} ${t('条')} · ~${fmtTokens(r.stats.approxTokens)} tokens</div>`);
  return `<div class="result-box ok">${head}${bits.join('')}</div>`;
}

/* ---------------- 活动时间线 ---------------- */
let actLevel = 'all';
function humanizeLog(l) {
  switch (l.type) {
    case 'transfer':
      return {
        title: l.ok ? `${t('接力成功')}` : `${t('接力失败')}`,
        sub: [l.source, '→', l.target, l.mode, l.cwd, l.error].filter(Boolean).join(' · '),
      };
    case 'backup': return { title: t('创建备份快照'), sub: l.dir || '' };
    case 'backup-restore': return { title: t('从备份还原'), sub: l.dir || '' };
    case 'backup-delete': return { title: t('删除备份'), sub: l.dir || '' };
    case 'config': return { title: t('设置已更新'), sub: ['logLevel', 'language', 'theme', 'dataDir', 'githubRepo'].filter((k) => l[k] !== undefined).map((k) => k + '=' + l[k]).join(' · ') };
    case 'server-start': return { title: t('服务启动'), sub: 'v' + (l.version || '') };
    case 'mcp-start': return { title: t('MCP 服务启动'), sub: 'v' + (l.version || '') };
    case 'mcp-transfer': case 'mcp-preview_transfer': return { title: (l.type === 'mcp-transfer' ? t('MCP 接力调用') : t('MCP 接力预览')) + (l.dry ? '（dry-run）' : ''), sub: (l.source || '') + ' → ' + (l.target || '') };
    case 'instance-add': return { title: t('添加 agent 实例'), sub: (l.data && l.data.dataDir) || '' };
    case 'api-error': return { title: t('接口错误'), sub: (l.path || '') + ' ' + (l.error || '') };
    case 'uncaught-exception': return { title: t('未捕获异常（已兜底）'), sub: l.message || l.error || '' };
    case 'unhandled-rejection': return { title: t('Promise 拒绝（已兜底）'), sub: l.message || l.error || '' };
    case 'diagbundle': return { title: t('导出诊断包'), sub: l.file || '' };
    case 'search-instance': return { title: t('搜索异常（已跳过该 agent）'), sub: (l.instance || '') + ' ' + (l.error || '') };
    default: return { title: l.type || 'event', sub: JSON.stringify(l).slice(0, 120) };
  }
}
async function loadActivity() {
  const logs = await api('/api/log?limit=300');
  const feed = $('#activity-feed');
  const lvOf = (l) => l.level || 'info';
  const filtered = actLevel === 'all' ? logs : logs.filter((l) => lvOf(l) === actLevel);
  let emptyHtml = '';
  if (!filtered.length) {
    const lv = (state.config && state.config.logLevel) || 'info';
    emptyHtml = logs.length
      ? `<div class="muted" style="padding:24px">${esc(t('该级别下暂无记录。'))}</div>`
      : `<div class="muted" style="padding:24px; line-height:22px">${esc(t('活动记录是空的。当前日志级别为'))} <b>${esc(lv)}</b>${esc(lv === 'error' ? '，只记录严重错误；接力、备份等一般活动需要到设置页把日志级别调到 info 或以上才会记录。' : '。执行一次接力或备份后，这里会出现对应记录。')}</div>`;
  }
  feed.innerHTML = filtered.map((l) => {
    const h = humanizeLog(l);
    return `<div class="act-item lv-${lvOf(l)}">
      <span class="lv ${lvOf(l)}">${lvOf(l)}</span>
      <div class="act-main"><div class="act-title">${esc(h.title)}</div>
      ${h.sub ? `<div class="act-sub">${esc(h.sub)}</div>` : ''}</div>
      <span class="act-time">${esc((l.ts || '').slice(0, 19).replace('T', ' '))}</span>
    </div>`;
  }).join('') || emptyHtml || `<div class="muted" style="padding:24px">${t('暂无结果')}</div>`;
}

/* ---------------- 诊断 ---------------- */
async function loadDiagnostics() {
  const d = await api('/api/doctor');
  const agBox = $('#diag-agents');
  agBox.innerHTML = (d.instances || []).map((i) => `
    <div class="diag-agent">
      <span class="agent-dot" style="background:${typeColor(i.type)}"></span>
      <div style="flex:1; min-width:0">
        <div class="agent-name">${esc(i.name)} ${i.ok ? '' : '— ' + esc(t('未检测到存储'))}</div>
        <div class="muted">${esc(shortPath(i.storage || ''))}</div>
      </div>
      <span class="agent-count">${i.sessionFiles ?? 0}</span>
    </div>`).join('');
  $('#diag-raw').textContent = JSON.stringify(d, null, 2);
  await renderBackups();
}
async function renderBackups() {
  const data = await api('/api/backups');
  const box = $('#diag-backups');
  box.innerHTML = (data.backups.length
    ? `<div class="muted" style="margin-bottom:8px">${data.backups.length} ${t('份')} · ${t('总占用')} ${fmtSize(data.total)}</div>
      <div class="muted" style="margin-bottom:8px; word-break:break-all">${esc(t('备份根目录'))}: <span class="mono">${esc(data.root || '')}</span></div>`
      + data.backups.map((b) => `
        <div class="backup-row">
          <div class="mono" style="flex:1; min-width:0">${esc(b.dir.slice(0, 19).replace('T', ' '))}<div class="muted">${esc(b.label)}</div></div>
          <span class="count">${fmtSize(b.size)}</span>
          <button class="btn small" data-restore="${esc(b.dir)}">${t('还原')}</button>
          <button class="btn small ghost" data-del="${esc(b.dir)}">${t('移除')}</button>
        </div>`).join('')
    : `<div class="muted">${t('暂无结果')}</div>`);
  $$('#diag-backups [data-restore]').forEach((b) => b.addEventListener('click', async () => {
    if (!window.confirm(t('将写入目标 agent 的真实存储（写前已自动备份）。确认执行？'))) return;
    try {
      const r = await api('/api/backups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'restore', dir: b.dataset.restore }) });
      toast(r.note || t('已保存'), r.restored && r.restored.length ? '' : 'warn');
      renderBackups();
    } catch (e) { toast(e.message, 'err'); }
  }));
  $$('#diag-backups [data-del]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api('/api/backups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', dir: b.dataset.del }) });
      renderBackups();
    } catch (e) { toast(e.message, 'err'); }
  }));
}

/* ---------------- 设置 ---------------- */
async function loadSettings() {
  try { state.config = await api('/api/config'); } catch { state.config = {}; }
  // 设置页表格用 /api/instances：包含已停用的内置实例，开关反映真实状态
  try { renderInstancesTable(await api('/api/instances')); }
  catch { renderInstancesTable(state.instances.map((x) => ({ ...x, enabled: x.enabled !== false }))); }
  renderAbout();
  $('#set-lang').value = window.MS_LANG;
  $('#set-theme').value = localStorage.getItem('ms-theme') || 'dark';
  $('#set-loglevel').value = state.config.logLevel || 'info';
  $('#set-backup').checked = state.config.backupEnabled !== false;
  $('#set-fontscale').value = state.config.fontScale || 'normal';
  $('#set-bgimage').value = state.config.bgImage || '';
  applyGlass(state.config.bgGlass != null ? state.config.bgGlass : 40);
  $('#set-checkup').checked = !!state.config.checkUpdates;
  $('#set-datadir').value = state.config.dataDir || '';
  checkUpdateOnce();
}

function renderInstancesTable(list) {
  const rows = list.map((a) => `
    <tr class="${a.enabled === false ? 'inst-off' : ''}">
      <td><span class="inst-name"><span class="agent-dot" style="background:${typeColor(a.type)}"></span>${esc(a.name)}${a.builtin ? '' : ' <span class="badge">custom</span>'}</span></td>
      <td class="muted inst-path">${esc(shortPath(a.storage) || '—')}</td>
      <td class="inst-status ${a.available ? 'ok' : ''}">${a.enabled === false ? esc(t('已停用')) : (a.available ? `✓ ${a.sessionCount}` : '✕')}</td>
      <td>${a.builtin
        ? `<label class="switch" title="${esc(t('启用/停用该 agent 的内置实例'))}"><input type="checkbox" data-enable="${esc(a.type)}" ${a.enabled ? 'checked' : ''}><span class="slider"></span></label>`
        : `<button class="btn small ghost" data-remove="${esc(a.instanceId)}">${t('移除')}</button>`}</td>
    </tr>`).join('');
  $('#instances-table').innerHTML = `<table class="instt">
    <tr><th>${t('实例')}</th><th>${t('数据目录')}</th><th>${t('状态')}</th><th>${t('操作')}</th></tr>${rows}</table>`;
  $$('#instances-table input[data-enable]').forEach((sw) => sw.addEventListener('change', async () => {
    try {
      await api('/api/instances', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'setEnabled', type: sw.dataset.enable, enabled: sw.checked }) });
      toast(t('已保存'));
      // 用真实状态重绘开关，并刷新主界面实例列表
      try { renderInstancesTable(await api('/api/instances')); } catch { }
      loadAgents(true);
    } catch (e) { toast(e.message, 'err'); sw.checked = !sw.checked; }
  }));
  $$('#instances-table [data-remove]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api('/api/instances', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'remove', instanceId: b.dataset.remove }) });
      toast(t('已保存'));
      loadAgents(true);
    } catch (e) { toast(e.message, 'err'); }
  }));
}

function applyFontScale(scale) {
  document.documentElement.dataset.fontScale = scale;
  localStorage.setItem('ms-fontscale', scale);
  const sel = $('#set-fontscale'); if (sel) sel.value = scale;
}
/* 毛玻璃强度：0（近乎不透明）→ 100（背景清晰透出） */
function applyGlass(v) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  const t = pct / 100;
  document.documentElement.style.setProperty('--glass-alpha', (0.9 - 0.65 * t).toFixed(3));
  document.documentElement.style.setProperty('--glass-blur', (4 + 22 * t).toFixed(1) + 'px');
  const sl = $('#set-glass');
  if (sl) { sl.value = pct; sl.style.setProperty('--fill', pct + '%'); }
  const gv = $('#glass-val');
  if (gv) gv.textContent = pct + '%';
  localStorage.setItem('ms-glass', String(pct));
}
function applyBgImage(path) {
  const el = $('#bg-image');
  if (!el) return;
  if (path) {
    // http(s) 直接用；本地路径经同源端点提供（浏览器禁止 http 页面加载 file:// 资源）
    const url = /^https?:/i.test(path) ? path : '/api/bgimage?path=' + encodeURIComponent(path);
    el.style.backgroundImage = `url("${url}")`;
    document.documentElement.dataset.bgImage = '1';
    const probe = new Image();
    probe.onerror = () => toast(t('背景图片加载失败，请检查路径或 URL'), 'warn');
    probe.src = url;
  } else {
    el.style.backgroundImage = '';
    delete document.documentElement.dataset.bgImage;
  }
  localStorage.setItem('ms-bgimage', path || '');
  const inp = $('#set-bgimage');
  if (inp && inp.value !== (path || '')) inp.value = path || '';
}

const SELF_REPO = 'DavidLi-TJ/AgentRelay'; // 本项目自己的仓库：关于卡片与更新检查的默认值
const SELF_SPONSOR = 'https://github.com/' + SELF_REPO + '/blob/main/docs/sponsor.md';

function renderAbout() {
  const box = $('#about-box');
  if (!box) return;
  const c = state.config || {};
  const repo = c.githubRepo || SELF_REPO;
  const safeHref = (u) => (/^https?:\/\//i.test(String(u)) ? String(u) : '#');
  const by = c.authorName ? ` <span class="about-ver">by ${esc(c.authorName)}</span>` : '';
  box.innerHTML = `
    <div class="about-appname">AgentRelay <span class="about-ver">v${esc(c.version || '?')}</span>${by}</div>
    <div class="about-desc">${esc(t('把你的 agent 会话原封不动地接力给下一个 agent。全部本地运行。'))}</div>
    <div class="about-links">
      <a class="btn small" href="https://github.com/${esc(repo)}" target="_blank">${icon('star')} GitHub</a>
      <a class="btn small" href="https://github.com/${esc(repo)}/issues" target="_blank">${icon('info')} ${esc(t('问题反馈'))}</a>
      <a class="btn small" href="${esc(safeHref(c.sponsorUrl || SELF_SPONSOR))}" target="_blank" rel="noopener noreferrer">${icon('heart')} ${esc(t('赞助'))}</a>
    </div>`;
}

async function checkUpdateOnce(force = false) {
  const c = state.config || {};
  if (!c.checkUpdates) return;
  const repo = c.githubRepo || SELF_REPO;
  if (!force) {
    const last = Number(localStorage.getItem('ms-update-checked') || 0);
    if (Date.now() - last < 3600 * 1000) return;
  }
  localStorage.setItem('ms-update-checked', String(Date.now()));
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(`https://api.github.com/repos/${c.githubRepo}/releases/latest`, { signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) return;
    const d = await r.json();
    const latest = String(d.tag_name || '').replace(/^v/, '');
    const cur = String(c.version || '0.0.0').replace(/^v/, '');
    const cmp = (a, b) => a.split('.').map(Number).reduce((acc, x, i) => acc || (x - (Number(b.split('.')[i]) || 0)), 0);
    if (latest && cmp(latest, cur) > 0) showUpdateBanner(latest, d.html_url);
  } catch { }
}
function showUpdateBanner(version, url) {
  if (document.getElementById('update-banner')) return;
  const el = document.createElement('div');
  el.id = 'update-banner';
  el.className = 'update-banner';
  el.innerHTML = `<span>${icon('up')} ${esc(t('新版本可用'))}: v${esc(version)}</span>
    <a href="${esc(url)}" target="_blank" class="btn small primary">${esc(t('前往下载'))}</a>
    <button class="iconbtn" id="ub-close">✕</button>`;
  $('#app').prepend(el);
  el.querySelector('#ub-close').addEventListener('click', () => el.remove());
}

/* ---------------- 目录浏览器 ---------------- */
function openDirBrowser(cb) {
  $('#modal-title').textContent = t('选择目录');
  $('#modal-body').innerHTML = `
    <div class="dir-row"><input type="text" id="db-path" placeholder="C:\\"><button class="btn" id="db-go">${t('打开')}</button></div>
    <div class="crumb" id="db-crumb"></div>
    <div class="dir-list" id="db-list"></div>
    <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:16px">
      <button class="btn primary" id="db-pick">${t('使用此目录')}</button>
    </div>`;
  $('#modal').classList.remove('hidden');
  const nav = (p) => {
    api('/api/fs/list?path=' + encodeURIComponent(p || '')).then((d) => {
      state.dirPath = d.path;
      $('#db-path').value = d.path;
      // 分隔符按后端返回的实际路径推断（Windows \ ，POSIX /）
      const sep = d.path.includes('\\') ? '\\' : '/';
      const isWin = /^[A-Za-z]:/.test(d.path);
      const parts = d.path.split(/[\\/]+/).filter(Boolean);
      $('#db-crumb').innerHTML = d.path
        ? parts.map((seg, i) => {
            // Windows 头段是盘符（C: → C:\），POSIX 从根开始逐级拼
            const target = isWin ? (i === 0 ? seg + '\\' : parts.slice(0, i + 1).join('\\')) : '/' + parts.slice(0, i + 1).join('/');
            return `<button data-nav="${esc(target)}">${esc(seg)}</button>`;
          }).join('<span>/</span>')
        : `<span>${t('此电脑')}</span>`;
      $$('#db-crumb [data-nav]').forEach((b) => b.addEventListener('click', () => nav(b.dataset.nav)));
      $('#db-list').innerHTML = d.dirs.map((x) => `<div class="dir-item" data-p="${esc(x.path)}">${esc(x.name)}</div>`).join('')
        || `<div class="muted" style="padding:12px">—</div>`;
      $$('#db-list .dir-item').forEach((el) => el.addEventListener('click', () => nav(el.dataset.p)));
      $('#db-pick').onclick = () => { $('#modal').classList.add('hidden'); cb(d.path); };
    }).catch((e) => toast(e.message, 'err'));
  };
  $('#db-go').onclick = () => nav($('#db-path').value.trim());
  nav(state.dirPath || '');
}
$('#modal-close').addEventListener('click', () => $('#modal').classList.add('hidden'));
// 点弹窗外部空白关闭
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) $('#modal').classList.add('hidden');
});

/* ---------------- 设置绑定 ---------------- */
function bindSettings() {
  $('#btn-add-instance').addEventListener('click', async () => {
    try {
      await api('/api/instances', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: $('#add-type').value, name: $('#add-name').value.trim(), dataDir: $('#add-dir').value.trim() }) });
      toast(t('已保存'));
      $('#add-result').textContent = '';
      loadAgents(true);
    } catch (e) { $('#add-result').textContent = '✕ ' + e.message; }
  });
  $('#btn-add-detect').addEventListener('click', async () => {
    try {
      const r = await api('/api/instances', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'detect', type: $('#add-type').value, dataDir: $('#add-dir').value.trim() }) });
      $('#add-result').textContent = `✓ ${t('检测到')} ${r.sessions} ${t('个会话')}`;
    } catch (e) { $('#add-result').textContent = '✕ ' + e.message; }
  });
  $('#btn-save-settings').addEventListener('click', async () => {
    try {
      const body = {
        logLevel: $('#set-loglevel').value,
        theme: $('#set-theme').value,
        language: $('#set-lang').value,
        dataDir: $('#set-datadir').value.trim(),
        backupEnabled: $('#set-backup').checked,
        fontScale: $('#set-fontscale').value,
        bgImage: $('#set-bgimage').value.trim(),
        bgGlass: Number($('#set-glass').value) || 0,
        checkUpdates: $('#set-checkup').checked,
      };
      const r = await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      state.config = r.config || state.config;
      applyTheme($('#set-theme').value);
      applyFontScale($('#set-fontscale').value);
      applyBgImage($('#set-bgimage').value.trim());
      if ($('#set-lang').value !== window.MS_LANG) { window.setLang($('#set-lang').value); renderAll(); }
      toast(t('已保存'));
      loadAgents(true);
      renderAbout();
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#set-dir-browse').addEventListener('click', () => openDirBrowser((p) => { $('#set-datadir').value = p; }));
  $('#relay-browse').addEventListener('click', () => openDirBrowser((p) => {
    $('#relay-cwd').value = p;
    if (state.relay) state.relay.cwd = p;
  }));
  $('#relay-backup').addEventListener('change', (e) => { if (state.relay) state.relay.backup = e.target.checked; });
  // 执行按钮（此前从未绑定，点击无任何反应）
  $('#relay-dryrun').addEventListener('click', () => runRelay(true));
  $('#relay-run').addEventListener('click', () => runRelay(false));
  $('#btn-clear-bg').addEventListener('click', () => { $('#set-bgimage').value = ''; applyBgImage(''); });
  // 背景图输入即时预览（防抖），无需先点保存
  let bgTimer = null;
  $('#set-bgimage').addEventListener('input', () => {
    clearTimeout(bgTimer);
    bgTimer = setTimeout(() => applyBgImage($('#set-bgimage').value.trim()), 400);
  });
  $('#set-glass').addEventListener('input', () => applyGlass($('#set-glass').value));
  $('#btn-clear-log').addEventListener('click', async () => {
    if (!window.confirm(t('确认清空全部活动记录？此操作不可恢复。'))) return;
    try {
      await api('/api/log/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      toast(t('已清空活动记录'));
      loadActivity();
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#add-browse').addEventListener('click', () => openDirBrowser((p) => { $('#add-dir').value = p; }));
  $('#btn-diag').addEventListener('click', async () => {
    try {
      const r = await api('/api/diagbundle');
      toast(t('已导出诊断包') + ': ' + r.file);
      copyText(r.file);
    } catch (e) { toast(t('导出失败: ') + e.message, 'err'); }
  });
  $$('#act-filter .pill').forEach((p) => p.addEventListener('click', () => {
    actLevel = p.dataset.lv;
    $$('#act-filter .pill').forEach((x) => x.classList.remove('active'));
    p.classList.add('active');
    loadActivity().catch(() => { });
  }));
}

/* ---------------- 首次向导 ---------------- */
async function maybeShowWizard() {
  try {
    const cfg = await api('/api/config').catch(() => ({}));
    state.config = cfg;
    // 启动即应用持久化的外观设置（不依赖 localStorage）
    if (cfg.fontScale) applyFontScale(cfg.fontScale);
    if (cfg.bgImage) applyBgImage(cfg.bgImage);
    applyGlass(cfg.bgGlass != null ? cfg.bgGlass : 40);
    if (cfg.wizardDone) return;
    $('#wiz-datadir').value = cfg.dataDir || '';
    $('#wizard').classList.remove('hidden');
  } catch { }
}
function bindWizard() {
  $('#wiz-lang').addEventListener('change', (e) => { window.setLang(e.target.value); renderAll(); });
  $('#wiz-theme').addEventListener('change', (e) => applyTheme(e.target.value));
  $('#wiz-browse').addEventListener('click', () => openDirBrowser((p) => { $('#wiz-datadir').value = p; }));
  // 向导的字体/背景在 wiz-done 里统一保存
  const finish = async () => {
    const body = { wizardDone: true, language: $('#wiz-lang').value, theme: $('#wiz-theme').value };
    const dd = $('#wiz-datadir').value.trim();
    if (dd && dd !== state.config.dataDir) body.dataDir = dd;
    try { await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch { }
    applyTheme($('#wiz-theme').value);
    if ($('#wiz-lang').value !== window.MS_LANG) window.setLang($('#wiz-lang').value);
    $('#wizard').classList.add('hidden');
    loadAgents(true);
  };
  $('#wiz-done').addEventListener('click', finish);
  $('#wiz-skip').addEventListener('click', finish);
}

/* ---------------- 快速上手 ---------------- */
function renderQuickStart() {
  const box = $('#quickstart');
  if (!box) return;
  if (localStorage.getItem('ms-qs-dismissed')) { box.innerHTML = ''; box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const steps = [
    t('在左侧选一个会话，右侧逐字预览，每条可勾选。'),
    t('到接力页选目标 agent 和项目目录，Dry-run 预览后执行。'),
    t('接力成功后给出 resume 命令，在目标 agent 里直接续接。'),
  ];
  box.innerHTML = `
    <button class="iconbtn qs-close" id="qs-close">${t('不再显示')}</button>
    <div class="qs-head">${t('快速上手')}</div>
    <div class="qs-steps">
      ${steps.map((s, i) => `<div class="qs-step"><span class="stepnum">${i + 1}</span><span>${esc(s)}</span></div>`).join('')}
    </div>`;
  $('#qs-close').addEventListener('click', () => { localStorage.setItem('ms-qs-dismissed', '1'); renderQuickStart(); });
}

/* ---------------- 启动 ---------------- */
applyTheme(localStorage.getItem('ms-theme') || 'dark');
window.applyI18n();
function refreshDataIcons() {
  $$('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
}
refreshDataIcons();
bindSettings();
bindWizard();
renderQuickStart();
maybeShowWizard();
loadAgents().catch((e) => {
  $('#server-status').style.background = 'var(--err)';
  toast(t('初始化失败: ') + e.message, 'err');
});
