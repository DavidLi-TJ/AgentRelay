'use strict';
// 分级日志（对齐 cc-switch 惯例）：
// error - 仅严重错误
// warn  - 错误 + 警告信息
// info  - 一般操作信息（默认）
// debug - 详细信息，包含转换细节与请求/响应摘要
// trace - 全部日志，最详细（注意：可能包含会话片段，开启需知情）
const fs = require('fs');
const path = require('path');
const { ensureDir, nowISO, config, saveConfig, dataDir } = require('./util');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
let _level = null;

function level() {
  if (_level) return _level;
  const cfg = config();
  _level = LEVELS[cfg.logLevel] != null ? cfg.logLevel : 'info';
  return _level;
}

function setLevel(name) {
  if (LEVELS[name] == null) throw new Error('未知日志级别: ' + name);
  _level = name;
  try { saveConfig({ logLevel: name }); } catch { /* 配置写失败不阻断日志 */ }
}

function log(levelName, type, data = {}) {
  const lv = LEVELS[levelName] != null ? levelName : 'info';
  if (LEVELS[lv] > LEVELS[level()]) return;
  try {
    ensureDir(dataDir());
    fs.appendFileSync(path.join(dataDir(), 'log.jsonl'),
      JSON.stringify({ ts: nowISO(), level: lv, type, ...data }) + '\n', 'utf8');
  } catch { /* 日志失败不阻断主流程 */ }
}

function clearLog() {
  try {
    ensureDir(dataDir());
    fs.writeFileSync(path.join(dataDir(), 'log.jsonl'), '', 'utf8');
    return true;
  } catch { return false; }
}

module.exports = {
  LEVELS,
  level,
  setLevel,
  log,
  clearLog,
  error: (type, data) => log('error', type, data),
  warn: (type, data) => log('warn', type, data),
  info: (type, data) => log('info', type, data),
  debug: (type, data) => log('debug', type, data),
  trace: (type, data) => log('trace', type, data),
};
