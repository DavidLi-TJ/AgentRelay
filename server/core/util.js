'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
// 引导配置固定在 ~/.agentrelay/config.json；数据目录（备份/导出/缓存/日志）可由用户在向导/设置中迁移
const CONFIG_FILE = path.join(HOME, '.agentrelay', 'config.json');
let _cfg = null;

// 老版本数据目录 ~/.movesession 整体迁移到 ~/.agentrelay（含 config/备份/导出/缓存/日志）。
// 迁移失败（如被占用）则不阻塞：新目录按全新安装初始化，旧目录原样保留。
(function migrateLegacyHomeDir() {
  const legacy = path.join(HOME, '.movesession');
  const fresh = path.join(HOME, '.agentrelay');
  try {
    if (fs.existsSync(legacy) && !fs.existsSync(fresh)) fs.renameSync(legacy, fresh);
  } catch { /* 保留旧目录 */ }
})();

function config() {
  if (_cfg) return _cfg;
  try { _cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch {
    // 读失败（文件被占用/短暂不可读）不缓存空对象：缓存会把"配置消失"传播到
    // 后续 saveConfig，把用户真实配置持久化抹掉。每次重读，直到恢复正常。
    return {};
  }
  return _cfg;
}
function saveConfig(patch) {
  // 文件存在但读不出来时拒绝保存，防止用空配置覆盖用户数据
  if (fs.existsSync(CONFIG_FILE) && Object.keys(config()).length === 0 && !Object.keys(patch).length) {
    throw new Error('配置文件不可读，已取消保存以避免覆盖用户配置');
  }
  _cfg = { ...config(), ...patch };
  ensureDir(path.dirname(CONFIG_FILE));
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(_cfg, null, 2), 'utf8');
  return _cfg;
}
function configFilePath() { return CONFIG_FILE; }
function dataDir() { return config().dataDir || path.join(HOME, '.agentrelay'); }
function backupDir() { return path.join(dataDir(), 'backups'); }
function cacheDir() { return path.join(dataDir(), 'cache'); }
function exportsDir() { return path.join(dataDir(), 'exports'); }

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
function randomUUID() { return crypto.randomUUID(); }
function rand10() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}
function nowISO() { return new Date().toISOString(); }
function msToISO(ms) { return new Date(ms).toISOString(); }
function isoToMs(iso) { const t = Date.parse(iso); return Number.isFinite(t) ? t : Date.now(); }
function nowMs() { return Date.now(); }

// 粗略 token 估算：CJK 字符 ≈0.7 token/字，其他 ≈4 字符/token
function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0, other = 0;
  for (const ch of String(text)) {
    if (ch.codePointAt(0) > 0x2e80) cjk++; else other++;
  }
  return Math.ceil(cjk * 0.7 + other / 4);
}

const slugifyClaude = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
const slugifyZcode = (cwd) => String(cwd).toLowerCase().replace(/[^a-z0-9_]/g, '-');
// baseDir 为用户自定义的 agent 数据目录（如 CLAUDE_CONFIG_DIR 指向的目录）；null = 默认路径
const claudeDirFor = (baseDir, cwd) => baseDir
  ? path.join(baseDir, 'projects', slugifyClaude(cwd))
  : path.join(HOME, '.claude', 'projects', slugifyClaude(cwd));

function readJsonl(file, { maxLines = 200000 } = {}) {
  // 同步全量读取（小文件）；大文件请用 streamJsonl
  const out = [];
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length && out.length < maxLines; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
  }
  return out;
}

// 部分读取（列表扫描大文件时用）：只读头部；加大到 4MB 覆盖超长首行
function readJsonlPartial(file, limitBytes = 4 * 1024 * 1024) {
  const out = [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const chunk = Buffer.alloc(Math.min(limitBytes, size));
    fs.readSync(fd, chunk, 0, chunk.length, 0);
    for (const line of chunk.toString('utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch { }
    }
  } catch { } finally { if (fd) fs.closeSync(fd); }
  return out;
}

// 流式读取大 JSONL（WorkBuddy 有 745MB 的会话文件）
function streamJsonl(file, onLine, { maxLines = 2000000 } = {}) {
  const fsLocal = require('fs');
  const rl = require('readline').createInterface({
    input: fsLocal.createReadStream(file, { encoding: 'utf8', highWaterMark: 4 * 1024 * 1024 }),
    crlfDelay: Infinity,
  });
  return new Promise((resolve, reject) => {
    let n = 0;
    rl.on('line', (line) => {
      if (n >= maxLines) { rl.close(); return; }
      line = line.trim();
      if (!line) return;
      n++;
      try { onLine(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    });
    rl.on('close', () => resolve(n));
    rl.on('error', reject);
  });
}

function writeJsonl(file, objs) {
  ensureDir(path.dirname(file));
  const body = objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
  writeAtomic(file, body);
  return file;
}

// 原子落盘：先写临时文件再 rename，避免中断截断原文件
function writeAtomic(file, content) {
  const tmp = file + '.msx-tmp-' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { }
    throw e;
  }
}

// 流式逐行写（大文件安全）：writer 返回 {write, writeRaw, close}
function openJsonlWriter(file) {
  ensureDir(path.dirname(file));
  const tmp = file + '.msx-tmp-' + process.pid;
  const stream = fs.createWriteStream(tmp, { encoding: 'utf8' });
  return {
    write(obj) { stream.write(JSON.stringify(obj) + '\n'); },
    writeRaw(text) { stream.write(text + '\n'); },
    async close() {
      return new Promise((resolve, reject) => {
        stream.end(() => {
          try { fs.renameSync(tmp, file); resolve(); }
          catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { } reject(e); }
        });
        stream.on('error', reject);
      });
    },
  };
}

function truncateStr(s, n) {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, n) + '…';
}

function backupFiles(files, label = 'op') {
  const safeLabel = String(label || 'op').replace(/[^\w-]/g, '') || 'op';
  const dir = path.join(backupDir(), `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeLabel}`);
  ensureDir(dir);
  const copied = [];
  const origins = {};
  for (const f of files) {
    if (f && fs.existsSync(f)) {
      const dest = path.join(dir, path.basename(f));
      origins[path.basename(f)] = f; // 还原时按原始路径写回（支持自定义实例目录）
      // SQLite 活跃库：优先用 VACUUM INTO 做一致性快照（db/-wal/-shm 三件套逐个拷贝可能撕裂）
      if (/\.sqlite$/.test(f)) {
        try {
          const { DatabaseSync } = require('node:sqlite');
          const db = new DatabaseSync(f);
          try { db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); }
          finally { db.close(); }
          copied.push(dest);
          continue;
        } catch { /* 回退到普通复制 */ }
      }
      fs.copyFileSync(f, dest);
      copied.push(dest);
    }
  }
  try { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ files: origins }, null, 2), 'utf8'); } catch { }
  pruneBackups(20);
  try { require('./logger').info('backup', { dir, files: copied.length }); } catch { }
  return { dir, copied };
}

// 备份保留策略：最多保留 keep 个备份目录
function pruneBackups(keep = 20) {
  try {
    const root = backupDir();
    if (!fs.existsSync(root)) return;
    const dirs = fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory()).sort();
    while (dirs.length > keep) {
      const oldest = dirs.shift();
      fs.rmSync(path.join(root, oldest), { recursive: true, force: true });
    }
  } catch { }
}

function appendLog(entry) {
  try {
    const logger = require('./logger'); // 延迟加载避免循环依赖
    logger.info(entry.type || 'event', entry);
  } catch { /* 日志失败不阻断主流程 */ }
}

function readLogTail(n = 200) {
  try {
    const file = path.join(dataDir(), 'log.jsonl');
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }).reverse();
  } catch { return []; }
}

// 深拷贝字符串值替换（用于会话 id 重写），对象结构不变；跳过 __proto__ 键
function deepReplaceStrings(obj, fn) {
  if (typeof obj === 'string') return fn(obj);
  if (Array.isArray(obj)) return obj.map((v) => deepReplaceStrings(v, fn));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = deepReplaceStrings(obj[k], fn);
    }
    return out;
  }
  return obj;
}

function safeParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

module.exports = {
  HOME, CONFIG_FILE,
  config, saveConfig, configFilePath, dataDir, backupDir, cacheDir, exportsDir,
  ensureDir, randomUUID, rand10, nowISO, msToISO, isoToMs, nowMs,
  estimateTokens, slugifyClaude, slugifyZcode, claudeDirFor,
  readJsonl, streamJsonl, readJsonlPartial, writeJsonl, writeAtomic, openJsonlWriter,
  truncateStr, backupFiles, pruneBackups, appendLog, readLogTail,
  deepReplaceStrings, safeParse,
};
