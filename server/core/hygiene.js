'use strict';
// 硬盘卫生：日志轮转 + 导出目录限量（用户需求 #9；随服务启动执行一次）
const fs = require('fs');
const path = require('path');
const { dataDir, exportsDir } = require('./util');
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
    }).filter((x) => x.isFile).sort((a, b) => b.mtime - a.mtime);
    for (const x of files.slice(EXPORTS_KEEP)) {
      try { fs.rmSync(x.p, { force: true }); } catch { }
    }
    if (files.length > EXPORTS_KEEP) logger.info('exports-prune', { removed: files.length - EXPORTS_KEEP });
  } catch { }
}

function runHygiene() {
  rotateLog();
  pruneExports();
}

module.exports = { runHygiene, rotateLog, pruneExports };
