'use strict';
// 跨实例全文搜索：SQLite 型 agent 走 LIKE 聚合查询，文件型逐会话流式扫描（745MB 级大文件防事件循环冻结）。
// /api/search 与 MCP search_sessions 共用此唯一实现——勿在调用方复制逻辑。
const fs = require('fs');
const agents = require('./agents');
const logger = require('./logger');
const { safeParse, truncateStr } = require('./util');

async function searchAll({ q, instanceId = null, limit = 60, perInstanceCap = 20, deadlineMs = 6000 } = {}) {
  q = String(q || '').trim();
  if (q.length < 2) return [];
  const results = [];
  const deadline = Date.now() + deadlineMs;
  let insts = agents.allInstances().filter((i) => i.available);
  if (instanceId) insts = insts.filter((i) => i.id === instanceId);
  for (const inst of insts) {
    if (Date.now() > deadline) break;
    const type = inst.type;
    // trae：单一 SQLCipher 库（解密成本高）；doubao：正文在 IndexedDB/云端 —— 均不参与正文搜索
    if (type === 'trae' || type === 'doubao') continue;
    try {
      const baseDir = inst.baseDir;
      if (type === 'zcode' || type === 'opencode') {
        const { DatabaseSync } = require('node:sqlite');
        const mod = require(type === 'zcode' ? './zcode' : './opencode');
        const dbp = mod.dbPath(baseDir);
        if (!fs.existsSync(dbp)) continue;
        const db = new DatabaseSync(mod.getReadDbFile(baseDir));
        try {
          const like = '%' + q.replace(/[%_]/g, '') + '%';
          const rows = db.prepare("SELECT p.session_id, count(*) hits, substr(p.data, 1, 200) sample FROM part p WHERE p.data LIKE ? GROUP BY p.session_id ORDER BY hits DESC LIMIT ?").all(like, perInstanceCap);
          for (const r of rows) {
            const sess = db.prepare('SELECT title, directory FROM session WHERE id = ?').get(r.session_id);
            results.push({ agent: type, instance: inst.id, sessionId: r.session_id, title: (sess && sess.title) || r.session_id, cwd: (sess && sess.directory) || '', hits: r.hits, sample: r.sample });
          }
        } finally { db.close(); }
      } else if (type === 'hermes') {
        const hm = require('./hermes');
        const dbp = hm.dbPath(baseDir);
        if (!fs.existsSync(dbp)) continue;
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(hm.getReadDbFile(baseDir));
        try {
          const like = '%' + q.replace(/[%_]/g, '') + '%';
          const rows = db.prepare("SELECT m.session_id, count(*) hits, substr(m.content, 1, 200) sample FROM messages m WHERE m.content LIKE ? AND m.active = 1 GROUP BY m.session_id ORDER BY hits DESC LIMIT ?").all(like, perInstanceCap);
          for (const r of rows) {
            const sess = db.prepare('SELECT title, cwd FROM sessions WHERE id = ?').get(r.session_id);
            results.push({ agent: type, instance: inst.id, sessionId: r.session_id, title: (sess && sess.title) || r.session_id, cwd: (sess && sess.cwd) || '', hits: r.hits, sample: r.sample });
          }
        } finally { db.close(); }
      } else {
        const list = agents.listInstanceSessions(inst);
        for (const sess of list) {
          if (Date.now() > deadline) break;
          const file = sess.file;
          if (!file || !fs.existsSync(file)) continue;
          try {
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
              if (results.length >= limit) break;
            }
          } catch { }
        }
      }
    } catch (e) { logger.warn('search-instance', { instance: inst.id, error: e.message }); }
  }
  results.sort((a, b) => b.hits - a.hits);
  return results.slice(0, limit);
}

module.exports = { searchAll };
