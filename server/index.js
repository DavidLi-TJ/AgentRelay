'use strict';
// AgentRelay 本地服务：静态 GUI + JSON API（零 npm 依赖）
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const agents = require('./core/agents');
const transfer = require('./core/transfer');
const logger = require('./core/logger');
const { readLogTail, appendLog, nowISO, HOME } = require('./core/util');

const VERSION = require('../package.json').version;
const PORT = Number(process.env.AGENTRELAY_PORT || process.env.MOVESESSION_PORT || 17777);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function send(res, code, data, mime = 'application/json; charset=utf-8') {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, res) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let rejected = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) {
        if (rejected) return;
        rejected = true;
        // 先让 413 冲出 socket，再丢弃剩余 body
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '请求体超过 64MB 限制' }), () => {
          req.resume();
          req.on('end', () => req.destroy());
          setTimeout(() => req.destroy(), 3000).unref();
        });
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (rejected) return;
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { e.badRequest = true; reject(e); }
    });
    req.on('error', () => { /* 客户端中断等，已处理 */ });
  });
}

async function route(req, res, u) {
  const p = u.pathname;
  if (req.method === 'GET') {
    if (p === '/api/agents') return send(res, 200, agents.listInstances());
    if (p === '/api/bgimage') {
      // 自定义背景图：浏览器禁止 http 页面加载 file:// 资源，本地图片经此端点同源提供
      const file = u.searchParams.get('path') || '';
      if (!file) return send(res, 400, { error: 'path 必填' });
      const fp = path.resolve(file);
      const MIME_IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif' };
      const ext = path.extname(fp).toLowerCase();
      if (!MIME_IMG[ext]) return send(res, 415, { error: '仅支持图片文件（png/jpg/gif/webp/bmp/svg/avif）' });
      let st;
      try { st = fs.statSync(fp); } catch { return send(res, 404, { error: '文件不存在: ' + fp }); }
      if (!st.isFile()) return send(res, 400, { error: '不是文件: ' + fp });
      if (st.size > 30 * 1024 * 1024) return send(res, 413, { error: '图片超过 30MB' });
      res.writeHead(200, { 'Content-Type': MIME_IMG[ext], 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(fp));
    }
    if (p === '/api/agents-full') return send(res, 200, agents.listAgents({ sessions: true }));
    if (p === '/api/targets') return send(res, 200, agents.listTargets());
    if (p === '/api/log') {
      const limit = Math.min(Number(u.searchParams.get('limit')) || 300, 2000);
      return send(res, 200, readLogTail(limit));
    }
    if (p === '/api/instances') {
      // GET：仅读取（含已停用的内置实例，供设置页渲染真实开关状态）；变更一律走 POST
      return send(res, 200, agents.instancesForSettings());
    }
    if (p === '/api/config') {
      const { config: cfgAll } = require('./core/util');
      return send(res, 200, { ...cfgAll(), logLevel: logger.level(), levels: Object.keys(logger.LEVELS), version: VERSION });
    }
    if (p === '/api/fs/list') {
      // 本地目录浏览（供数据目录选择器使用；仅列子目录，Host 校验已生效）
      let dir = u.searchParams.get('path') || '';
      if (!dir) {
        // 根列表按平台：Windows 枚举盘符，POSIX 从 / 开始
        const roots = [];
        if (process.platform === 'win32') {
          for (const d of ['C:', 'D:', 'E:', 'F:']) { const p2 = d + path.sep; try { if (fs.existsSync(p2)) roots.push(p2); } catch { } }
        } else {
          roots.push('/');
        }
        return send(res, 200, { path: '', parent: null, dirs: roots.map((n) => ({ name: n, path: n })) });
      }
      try {
        dir = path.resolve(dir);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('目录不存在');
        const parent = path.dirname(dir);
        const dirs = [];
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          try { if (fs.readdirSync(path.join(dir, e.name)) !== null) dirs.push({ name: e.name, path: path.join(dir, e.name) }); } catch { }
          if (dirs.length > 200) break;
        }
        dirs.sort((a, b) => a.name.localeCompare(b.name));
        return send(res, 200, { path: dir, parent: parent !== dir ? parent : null, dirs });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/search') {
      const q = (u.searchParams.get('q') || '').trim();
      const instanceId = u.searchParams.get('instance');
      if (q.length < 2) return send(res, 200, { results: [] });
      const results = [];
      const deadline = Date.now() + 6000;
      let insts = agents.allInstances().filter((i) => i.available);
      if (instanceId) insts = insts.filter((i) => i.id === instanceId);
      for (const inst of insts) {
        if (Date.now() > deadline) break;
        try {
          const type = inst.type;
          const baseDir = inst.baseDir;
          if (type === 'zcode' || type === 'opencode') {
            const { DatabaseSync } = require('node:sqlite');
            const dbp = type === 'zcode' ? require('./core/zcode').dbPath(baseDir) : require('./core/opencode').dbPath(baseDir);
            if (!fs.existsSync(dbp)) continue;
            const copyFn = type === 'zcode' ? require('./core/zcode').getReadDbFile : require('./core/opencode').getReadDbFile;
            const db = new DatabaseSync(copyFn(baseDir));
            try {
              const like = '%' + q.replace(/[%_]/g, '') + '%';
              const rows = db.prepare("SELECT p.session_id, count(*) hits, substr(p.data, 1, 200) sample FROM part p WHERE p.data LIKE ? GROUP BY p.session_id ORDER BY hits DESC LIMIT 20").all(like);
              for (const r of rows) {
                const sess = db.prepare('SELECT title, directory FROM session WHERE id = ?').get(r.session_id);
                results.push({ agent: type, instance: inst.id, sessionId: r.session_id, title: (sess && sess.title) || r.session_id, cwd: (sess && sess.directory) || '', hits: r.hits, sample: r.sample });
              }
            } finally { db.close(); }
          } else {
            const list = agents.listInstanceSessions(inst);
            for (const sess of list) {
              if (Date.now() > deadline) break;
              const file = sess.file;
              if (!file || !fs.existsSync(file)) continue;
              try {
                // 流式逐行搜索：WorkBuddy 有 745MB 的会话文件，整读会冻结事件循环
                let hits = 0, sample = '';
                await new Promise((resolve) => {
                  const rl = require('readline').createInterface({
                    input: fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1024 * 1024 }),
                    crlfDelay: Infinity,
                  });
                  const needle = q.toLowerCase();
                  rl.on('line', (line) => {
                    const low = line.toLowerCase();
                    if (low.includes(needle)) {
                      hits++;
                      if (!sample) {
                        const parsed = safeParse(line, {}) || {};
                        sample = truncateStr(JSON.stringify(parsed).slice(0, 260), 240);
                      }
                    }
                    if (Date.now() > deadline) rl.close();
                  });
                  rl.on('close', resolve);
                  rl.on('error', () => resolve());
                });
                if (hits) {
                  results.push({ agent: type, instance: inst.id, sessionId: sess.id, title: sess.title, cwd: sess.cwd, hits, sample });
                  if (results.length > 60) break;
                }
              } catch { }
            }
          }
        } catch (e) { logger.warn('search-instance', { instance: inst.id, error: e.message }); }
      }
      return send(res, 200, { results: results.slice(0, 60) });
    }
    if (p === '/api/backups') {
      const { backupDir } = require('./core/util');
      const root = backupDir();
      const out = [];
      let total = 0;
      if (fs.existsSync(root)) {
        for (const d of fs.readdirSync(root)) {
          const dir = path.join(root, d);
          if (!fs.statSync(dir).isDirectory()) continue;
          let size = 0;
          for (const f of fs.readdirSync(dir)) size += fs.statSync(path.join(dir, f)).size;
          total += size;
          out.push({ dir: d, label: d.replace(/^\d{4}-\d\d-\d\dT[\d-]+Z?-/, ''), size });
        }
      }
      out.sort((a, b) => b.dir.localeCompare(a.dir));
      return send(res, 200, { backups: out, total, root });
    }
    if (p === '/api/diagbundle') {
      const os = require('os');
      const { exportsDir, ensureDir } = require('./core/util');
      const bundle = {
        generated_at: nowISO(),
        agentrelay_version: VERSION,
        node: process.version,
        platform: `${os.type()} ${os.release()} ${os.arch()}`,
        config: { logLevel: logger.level() },
        doctor: agents.allInstances().map((inst) => ({ instance: inst.instanceId, type: inst.type, name: inst.name, ok: inst.available, storage: inst.storage, sessions: inst.sessionCount })),
        session_counts: agents.allInstances().map((a) => ({ agent: a.instanceId, type: a.type, available: a.available, sessions: a.sessionCount })),
        recent_log: readLogTail(500),
        note: '本诊断包不含会话内容，仅含存储统计与操作日志；公开发送前请自行检查',
      };
      const dir = ensureDir(exportsDir());
      const file = path.join(dir, `diag-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(file, JSON.stringify(bundle, null, 2), 'utf8');
      logger.info('diagbundle', { file });
      return send(res, 200, { file });
    }
    if (p === '/api/doctor') {
      const out = [];
      for (const inst of agents.loadInstances()) {
        try { out.push({ instance: inst.instanceId, type: inst.type, name: inst.name, ...agents.ADAPTERS[inst.type].doctor(inst.baseDir) }); }
        catch (e) { out.push({ instance: inst.instanceId, type: inst.type, name: inst.name, ok: false, error: e.message }); }
      }
      return send(res, 200, { instances: out });
    }
    if (p === '/api/sessions') {
      const instanceId = u.searchParams.get('instance');
      const type = u.searchParams.get('agent');
      const q = (u.searchParams.get('q') || '').toLowerCase();
      const refresh = u.searchParams.get('refresh') === '1';
      let list;
      if (instanceId) {
        const inst = agents.getInstance(instanceId);
        if (!inst) return send(res, 404, { error: '实例不存在: ' + instanceId });
        list = agents.listInstanceSessions(inst, { refresh });
      } else if (type) {
        list = agents.agentSummary(type).sessions || [];
      } else return send(res, 400, { error: 'instance 或 agent 必填' });
      const filtered = q ? list.filter((s) => (s.title || '').toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q)) : list;
      return send(res, 200, filtered);
    }
    if (p === '/api/session') {
      const agent = u.searchParams.get('agent');
      const instanceId = u.searchParams.get('instance');
      const id = u.searchParams.get('id');
      if ((!agent && !instanceId) || !id) return send(res, 400, { error: 'agent/instance 与 id 必填' });
      const offset = Math.max(0, Number(u.searchParams.get('offset')) || 0);
      const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 200, 1), 1000);
      try {
        const { get: cacheGet, put: cachePut } = require('./core/sessionCache');
        let msx = null;
        const cacheKey = instanceId ? `${instanceId}:${id}` : null;
        if (cacheKey) {
          const cached = cacheGet(cacheKey);
          // 源存储在 TTL 内可能被追加：按存储签名（文件 + wal/shm 的 mtime+size）判脏
          if (cached) {
            let stale = false;
            try {
              const f = cached.source && cached.source.file;
              if (f && cached._storeSig) {
                const sig = [f, f + '-wal', f + '-shm'].map((p) => {
                  try { const st = fs.statSync(p); return st.mtimeMs + ':' + st.size; } catch { return '0:0'; }
                }).join('|');
                stale = sig !== cached._storeSig;
              } else if (f && cached._fileStat && cached._fileStat.mtimeMs) {
                stale = fs.statSync(f).mtimeMs !== cached._fileStat.mtimeMs;
              }
            } catch { stale = true; }
            if (!stale) msx = cached;
          }
        }
        if (!msx) {
          msx = instanceId ? await agents.readMsxInstance(instanceId, id) : await agents.readMsx(agent, id);
          if (cacheKey) cachePut(cacheKey, msx);
        }
        // 详情页瘦身：instructions 只保留前 2KB
        if (msx.env && msx.env.instructions && msx.env.instructions.length > 2048) {
          msx.env.instructions = msx.env.instructions.slice(0, 2048) + '…[已截断]';
        }
        const total = msx.entries.length;
        let entries = msx.entries.slice(offset, offset + limit);
        const previewTruncated = entries.some((e) => (e.blocks || []).some((b) => (b.text || '').length > 2048));
        if (previewTruncated) {
          entries = entries.map((e) => ({
            ...e,
            blocks: (e.blocks || []).map((b) => (b.text && b.text.length > 2048
              ? { ...b, text: b.text.slice(0, 2048) + '…[预览截断，接力/导出仍为逐字全文]' } : b)),
          }));
        }
        return send(res, 200, { ...msx, entries, total, offset, hasMore: offset + limit < total, previewTruncated });
      } catch (e) { return send(res, 404, { error: e.message }); }
    }
  }
  if (req.method === 'POST') {
    if (p === '/api/log/clear') {
      const ok = logger.clearLog();
      if (!ok) return send(res, 500, { error: '日志清空失败' });
      logger.info('log-clear', {});
      return send(res, 200, { ok: true });
    }
    if (p === '/api/shutdown') {
      // 界面上的「关闭服务」：先应答再退出，让前端能提示用户
      logger.info('server-stop', { via: 'gui' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }), () => setTimeout(() => process.exit(0), 150));
      return;
    }
    if (p === '/api/backups') {
      const body = await readBody(req, res);
      const { backupDir, backupFiles } = require('./core/util');
      const root = path.resolve(backupDir());
      const dir = path.resolve(root, String(body.dir || ''));
      const rel = path.relative(root, dir);
      // 空串（dir===root）与绝对路径（Windows 跨盘符时 path.relative 返回绝对路径）都必须拒绝
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(dir)) return send(res, 404, { error: '备份目录不存在' });
      if (body.action === 'delete') {
        fs.rmSync(dir, { recursive: true, force: true });
        logger.info('backup-delete', { dir });
        return send(res, 200, { ok: true });
      }
      if (body.action === 'restore') {
        const KNOWN = () => ({
          'db.sqlite': require('./core/zcode').dbPath(),
          'opencode.db': require('./core/opencode').dbPath(),
          'state_5.sqlite': path.join(HOME, '.codex', 'state_5.sqlite'),
          'workbuddy.db': require('./core/workbuddy').dbPath(),
        });
        // 优先按备份时的原始路径还原（meta.json，支持自定义实例目录）；老备份回落默认路径。
        // meta.json 是备份目录内的普通文件（可能被伪造）：目标文件名必须命中已知存储文件白名单，
        // 否则一次"还原"就能把任意内容写到任意路径（如启动目录）。
        const ALLOWED = new Set(['db.sqlite', 'opencode.db', 'state_5.sqlite', 'workbuddy.db', 'session_index.jsonl']);
        let targets = null;
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
          if (meta && meta.files) {
            targets = {};
            for (const [name, dest] of Object.entries(meta.files)) {
              if (ALLOWED.has(name) && dest && ALLOWED.has(path.basename(String(dest)))) targets[name] = String(dest);
            }
          }
        } catch { }
        if (!targets || !Object.keys(targets).length) targets = { ...KNOWN(), 'session_index.jsonl': path.join(HOME, '.codex', 'session_index.jsonl') };
        const current = Object.values(targets).filter((f) => f && fs.existsSync(f) && fs.readdirSync(dir).includes(path.basename(f)));
        let safety = null;
        if (current.length) safety = backupFiles(current, 'pre-restore');
        const restored = [];
        for (const f of fs.readdirSync(dir)) {
          const dest = targets[f];
          if (dest) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(path.join(dir, f), dest);
            if (/\.(sqlite|db)$/.test(f)) {
              for (const ext of ['-wal', '-shm']) { try { fs.rmSync(dest + ext, { force: true }); } catch { } }
            }
            restored.push(dest);
          }
        }
        logger.warn('backup-restore', { dir, restored: restored.length, safety: safety && safety.dir });
        return send(res, 200, { ok: true, restored, safety: safety && safety.dir, note: restored.length ? '还原完成；如目标应用正在运行请重启后再查看会话' : '备份目录内没有可识别的存储文件，未做任何还原' });
      }
      return send(res, 400, { error: 'action 必须是 delete 或 restore' });
    }
    if (p === '/api/instances') {
      const body = await readBody(req, res);
      try {
        if (body.action === 'remove') return send(res, 200, agents.removeCustomInstance(body.instanceId));
        if (body.action === 'setEnabled') return send(res, 200, agents.setTypeEnabled(body.type, body.enabled));
        if (body.action === 'detect') {
          // 仅探测不保存（验收 #16 修复：detect 不得有副作用）
          if (!agents.ADAPTERS[body.type]) throw new Error('未知 agent 类型: ' + body.type);
          if (!body.dataDir || !require('fs').existsSync(body.dataDir)) throw new Error('目录不存在: ' + body.dataDir);
          const probe = agents.ADAPTERS[body.type].doctor(body.dataDir);
          return send(res, 200, { detected: probe.ok, storage: probe.storage, sessions: probe.sessionFiles || 0 });
        }
        const inst = agents.addCustomInstance({ type: body.type, name: body.name, dataDir: body.dataDir });
        logger.info('instance-add', { type: body.type, dataDir: body.dataDir });
        return send(res, 200, inst);
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/config') {
      const body = await readBody(req, res);
      try {
        const patch = {};
        if (body.logLevel) { logger.setLevel(body.logLevel); patch.logLevel = body.logLevel; }
        if (body.dataDir !== undefined && String(body.dataDir).trim()) {
          patch.dataDir = path.resolve(String(body.dataDir).trim());
          require('./core/util').ensureDir(patch.dataDir);
        }
        for (const k of ['wizardDone', 'language', 'theme', 'githubRepo', 'authorName', 'sponsorUrl', 'buyCoffeeUrl', 'checkUpdates', 'fontScale', 'bgImage', 'bgGlass']) {
          if (body[k] !== undefined) patch[k] = body[k];
        }
        const saved = require('./core/util').saveConfig(patch);
        logger.info('config', patch);
        return send(res, 200, { ok: true, config: { ...saved, logLevel: logger.level() }, dataDir: require('./core/util').dataDir() });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/export') {
      const body = await readBody(req, res);
      const { sourceAgent, sourceInstance, sessionId, options = {} } = body;
      if ((!sourceAgent && !sourceInstance) || !sessionId) return send(res, 400, { error: 'sourceAgent/sourceInstance 与 sessionId 必填' });
      const src = sourceInstance ? await agents.readMsxInstance(sourceInstance, sessionId) : await agents.readMsx(sourceAgent, sessionId);
      const loss = [];
      const { selectEntries, redactMsx, computeStats } = require('./core/msx');
      const entries = selectEntries(src.entries, options, loss);
      let msx = { ...src, entries, loss: [...src.loss, ...loss] };
      if (options.redact) msx = redactMsx(msx);
      msx.stats = computeStats(msx.entries);
      const { exportsDir, ensureDir } = require('./core/util');
      const dir = ensureDir(exportsDir());
      const name = `${sourceAgent}-${String(msx.source.session_id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8)}-${Date.now()}.arx.json`;
      const file = path.join(dir, name);
      const { writeMsxFile } = require('./core/transfer');
      await writeMsxFile(msx, file);
      return send(res, 200, { file, entries: msx.entries.length, tokens: msx.stats.approxTokens });
    }
    if (p === '/api/preview' || p === '/api/transfer') {
      const body = await readBody(req, res);
      try {
        const { sourceAgent, sourceInstance, sessionId, options = {}, targets = [], dryRun = false, backup = null } = body;
        if ((!sourceAgent && !sourceInstance) || !sessionId) return send(res, 400, { error: 'sourceAgent/sourceInstance 与 sessionId 必填' });
        if (p === '/api/preview') {
          let src;
          try { src = sourceInstance ? await agents.readMsxInstance(sourceInstance, sessionId) : await agents.readMsx(sourceAgent, sessionId); }
          catch (e) { return send(res, 404, { error: e.message }); }
          const loss = [];
          const { selectEntries, redactMsx, computeStats } = require('./core/msx');
          const entries = selectEntries(src.entries, options, loss);
          // 适配器级损失（sidechain 跳过等）与选择损失合并，预览与真实接力口径一致
          let msx = { ...src, entries, loss: [...(src.loss || []), ...loss] };
          if (options.redact) msx = redactMsx(msx);
          return send(res, 200, { stats: computeStats(msx.entries), loss: [...new Set(msx.loss || [])], entries: msx.entries.map(summarizeEntry) });
        }
        if (!targets || !targets.length) return send(res, 400, { error: 'targets 不能为空' });
        const results = await transfer.transfer({ sourceAgent, sessionId, targets, options, dryRun, sourceInstance, backup });
        return send(res, 200, { results });
      } catch (e) {
        logger.error('api-error', { path: p, error: e.message });
        return send(res, 500, { error: e.message });
      }
    }
  }
  return null;
}

function summarizeEntry(e) {
  const { entryPreview } = require('./core/msx');
  return { id: e.id, ts: e.ts, role: e.role, kind: e.kind, preview: entryPreview(e, 160), blocks: (e.blocks || []).map((b) => ({ type: b.type, name: b.name, for: b.for })) };
}

function serveStatic(req, res, u) {
  let p = u.pathname === '/' ? '/index.html' : u.pathname;
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, p);
  if (path.relative(PUBLIC_DIR, file).startsWith('..')) { res.writeHead(403); return res.end('forbidden'); }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // SPA 回退
    const index = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(index)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end(fs.readFileSync(index));
    }
    res.writeHead(404); return res.end('not found');
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
}

const server = http.createServer(async (req, res) => {
  // 本地服务请求来源校验（防 drive-by POST / DNS rebinding）
  const host = String(req.headers.host || '').toLowerCase();
  if (!host.startsWith('127.0.0.1:') && !host.startsWith('localhost:')) {
    return send(res, 403, { error: 'forbidden host' });
  }
  if (req.method === 'POST' && !String(req.headers['content-type'] || '').includes('application/json')) {
    return send(res, 415, { error: 'expected application/json' });
  }
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (u.pathname.startsWith('/api/')) {
      const r = await route(req, res, u);
      if (r !== null) return;
      return send(res, 404, { error: 'not found' });
    }
    return serveStatic(req, res, u);
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch { } return; }
    if (e && e.badRequest) return send(res, 400, { error: 'invalid JSON body' });
    return send(res, 500, { error: e.message });
  }
});

if (require.main === module) {
  // 进程级兜底：本地工具以"不挂死"为先，错误记入日志（error 级别）继续服务
  process.on('uncaughtException', (e) => {
    try { logger.error('uncaught-exception', { message: String(e && e.message).slice(0, 300), stack: String((e && e.stack) || '').slice(0, 1500) }); } catch { }
    console.error('[AgentRelay] 未捕获异常已兜底:', e && e.message);
  });
  process.on('unhandledRejection', (e) => {
    const msg = e && e.message ? e.message : String(e);
    try { logger.error('unhandled-rejection', { message: String(msg).slice(0, 300) }); } catch { }
    console.error('[AgentRelay] 未处理的 Promise 拒绝已兜底:', msg);
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`AgentRelay GUI 已启动: http://127.0.0.1:${PORT} (v${VERSION})`);
    logger.info('server-start', { port: PORT, version: VERSION });
  });
  server.on('error', (e) => {
    console.error('端口占用或启动失败:', e.message);
    process.exit(1);
  });
}

module.exports = { server, PORT };
