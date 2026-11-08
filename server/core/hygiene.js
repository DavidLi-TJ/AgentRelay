'use strict';
// 硬盘卫生：日志轮转 + 导出目录限量（用户需求 #9；随服务启动执行一次）
const fs = require('fs');
const path = require('path');
const { dataDir, exportsDir, cacheDir } = require('./util');
const logger = require('./logger');

const LOG_MAX = 5 * 1024 * 1024;   // log.jsonl 上限 5MB，超了保留尾部 2MB
const LOG_KEEP = 2 * 1024 * 1024;
const EXPORTS_KEEP = 50;           // exports 最多 50 个文件

function rotateLog() {
  const f = path.join(dataDir(), 'log.jsonl');
  try {
    if (!fs.existsSync(f)) return;
    const st = fs.statSync(f);
    if (st.size <= LOG_MAX) return;
    // 字节级截尾：保留末尾 ~2MB，从截断点后第一个换行起算（整行对齐）。
    // 比按行数估算精确——长日志行（内嵌会话片段）不会让文件永远缩不下来（审核 P2）
    const start = Math.max(0, st.size - LOG_KEEP);
    const fd = fs.openSync(f, 'r');
    let buf;
    try {
      buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally { fs.closeSync(fd); }
    let cut = 0;
    while (cut < buf.length && buf[cut] !== 0x0a) cut++;
    const kept = buf.subarray(Math.min(cut + 1, buf.length));
    fs.writeFileSync(f, kept);
    logger.info('log-rotate', { before: st.size, after: kept.length });
  } catch { }
}

function pruneExports() {
  const dir = exportsDir();
  try {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).map((f) => {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      return { p, mtime: st.mtimeMs, isFile: st.isFile() };
    }).filter((x) => x.isFile)
      // mtime 相同（批量导出）时按名称稳定排序，避免目录序误删最新文件
      .sort((a, b) => (b.mtime - a.mtime) || b.p.localeCompare(a.p));
    for (const x of files.slice(EXPORTS_KEEP)) {
      try { fs.rmSync(x.p, { force: true }); } catch { }
    }
    if (files.length > EXPORTS_KEEP) logger.info('exports-prune', { removed: files.length - EXPORTS_KEEP });
  } catch { }
}

// trae 解密缓存清理：每份可达数百 MB（明文副本），每库只保留最新 2 份
function pruneTraeCache() {
  const dir = cacheDir();
  try {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('trae-dec-') && f.endsWith('.db')).map((f) => {
      const p = path.join(dir, f);
      const st2 = fs.statSync(p);
      return { p, m: st2.mtimeMs, isFile: st2.isFile() };
    }).filter((x) => x.isFile)
      .sort((a, b) => (b.m - a.m) || b.p.localeCompare(a.p));
    for (const x of files.slice(2)) {
      try { fs.rmSync(x.p, { force: true }); } catch { }
    }
    // 孤儿 -wal/-shm 一并清理：对应主库已不存在（或已删）的边车文件
    const alive = new Set(files.slice(0, 2).map((x) => x.p));
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('trae-dec-') || (!f.endsWith('.db-wal') && !f.endsWith('.db-shm'))) continue;
      const main = path.join(dir, f.slice(0, -4));
      if (!alive.has(main) && !fs.existsSync(main)) {
        try { fs.rmSync(path.join(dir, f), { force: true }); } catch { }
      }
    }
  } catch { }
}

function runHygiene() {
  rotateLog();
  pruneExports();
  pruneTraeCache();
}

module.exports = { runHygiene, rotateLog, pruneExports };
