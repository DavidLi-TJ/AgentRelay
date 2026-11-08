'use strict';
// Trae（字节 IDE，VS Code 系）只读适配器 —— SQLCipher 4 页面级解密，零 npm 依赖
// 方法来源（均 MIT，独立验证）：Oh-My-Trae/trae-db-decrypt、ZedeX/trae-chat-decrypt
// 密钥不在磁盘：由 ai-agent.dll 运行时生成，仅存于进程内存 → PowerShell P/Invoke 扫描
// （页 1 HMAC-SHA512 校验防误报，Node 侧二次校验），因此 **读取时 Trae 必须正在运行**
// 解密参数（SQLCipher 4）：AES-256-CBC、页 4096、salt=页 1 前 16 字节、reserve=80（IV16+HMAC64）
// 读：chat_session（会话）+ history_v2（完整聊天 JSON raw_messages）
// 写：decrypt-modify-reencrypt 公开世界无先例、WAL/原子性风险高 → 目标侧维持 T2 转写
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HOME, cacheDir, ensureDir, nowISO, truncateStr } = require('./util');

const AGENT = 'trae';
const PAGE_SZ = 4096, SALT_SZ = 16, RESERVE_SZ = 80, HMAC_SZ = 64;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dataRoots() {
  const appdata = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  return ['Trae CN', 'Trae', 'Trae SOLO CN'].map((n) => path.join(appdata, n, 'ModularData', 'ai-agent'));
}
// 全部候选库（CN/国际版/SOLO 各自独立加密）
function findDbs() {
  return dataRoots().map((d) => path.join(d, 'database.db')).filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
}
const dbPath = (baseDir) => {
  if (baseDir) {
    if (fs.statSync(baseDir).isFile?.()) return baseDir;
    return path.join(baseDir, 'database.db');
  }
  const all = findDbs();
  return all.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || dataRoots()[0] + '\\database.db';
};

// ---------- 密钥：进程内存扫描（PowerShell P/Invoke，HMAC 校验） ----------
const KEYSCAN_PS = `
param([string]$SaltHex, [string]$Page1Hex)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class ArMemScan {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern void CloseProcess(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MBI mbi, IntPtr len);
  [StructLayout(LayoutKind.Sequential)]
  public struct MBI { public long BaseAddress; public long AllocationBase; public uint AllocationProtect; public uint Pad1; public long RegionSize; public uint State; public uint Protect; public uint Type; public uint Pad2; }
}
"@
$salt = New-Object byte[] 16
for ($i = 0; $i -lt 16; $i++) { $salt[$i] = [Convert]::ToByte($SaltHex.Substring($i * 2, 2), 16) }
$page1 = New-Object byte[] 4096
for ($i = 0; $i -lt 4096; $i++) { $page1[$i] = [Convert]::ToByte($Page1Hex.Substring($i * 2, 2), 16) }
$macSalt = New-Object byte[] 16
for ($i = 0; $i -lt 16; $i++) { $macSalt[$i] = $salt[$i] -bxor 0x3a }
$hmacData = New-Object byte[] 4016
[Array]::Copy($page1, 16, $hmacData, 0, 4016)
$storedHmac = New-Object byte[] 64
[Array]::Copy($page1, 4032, $storedHmac, 0, 64)
$tail = [BitConverter]::GetBytes([uint32]1)
$hmacMsg = New-Object byte[] (4016 + 4)
[Array]::Copy($hmacData, 0, $hmacMsg, 0, 4016)
[Array]::Copy($tail, 0, $hmacMsg, 4016, 4)

# 密钥持有者 = 带 --vscode-crash-reporter-process-type=ai(-server) 标记的 Trae 后端进程
# 精确 =ai 的进程（真正的 agent 宿主）排最前，=ai-server 兜底
$cands = Get-CimInstance Win32_Process -Filter "Name LIKE 'Trae%'" |
  Where-Object { $_.CommandLine -match 'crash-reporter-process-type=ai' }
$exact = @($cands | Where-Object { $_.CommandLine -match 'crash-reporter-process-type=ai( |")' })
$server = @($cands | Where-Object { $_.CommandLine -notmatch 'crash-reporter-process-type=ai( |")' })
$procs = foreach ($c in (@($exact) + @($server))) { Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue }
$logFile = Join-Path $env:TEMP 'trae-scan.log'
$Log = { param($m) [System.IO.File]::AppendAllText($logFile, ((Get-Date -Format 'HH:mm:ss') + ' ' + $m + [Environment]::NewLine)) }
& $Log ("开始: exact=" + @($exact).Count + " server=" + @($server).Count)
$verified = New-Object System.Collections.Generic.List[string]
$rx = [System.Text.RegularExpressions.Regex]::new('[0-9a-fA-F]{64,}', [System.Text.RegularExpressions.RegexOptions]::Compiled)
foreach ($p in $procs) {
  & $Log ("扫进程 pid=" + $p.Id + " WS=" + [int]($p.WorkingSet64/1MB) + "MB")
  $h = [ArMemScan]::OpenProcess(0x0410, $false, $p.Id)
  if ($h -eq [IntPtr]::Zero) { continue }
  $addr = [long]0
  $scanned = [long]0
  while ($addr -lt 0x7FFFFFFFFFFF) {
    $mbi = New-Object ArMemScan+MBI
    $r = [ArMemScan]::VirtualQueryEx($h, [IntPtr]$addr, [ref]$mbi, [IntPtr]::new(48))
    if ($r -eq [IntPtr]::Zero) { break }
    $committed = ($mbi.State -eq 0x1000)
    $readable = (2, 4, 8, 0x20, 0x40, 0x80) -contains $mbi.Protect
    if ($committed -and $readable -and $mbi.RegionSize -gt 0 -and $mbi.RegionSize -lt 500MB) {
      $buf = New-Object byte[] $mbi.RegionSize
      $read = [IntPtr]::Zero
      if ([ArMemScan]::ReadProcessMemory($h, [IntPtr]$mbi.BaseAddress, $buf, [IntPtr]$mbi.RegionSize, [ref]$read)) {
        $scanned = $scanned + [int64]$read
        if (($scanned % 256MB) -lt $mbi.RegionSize) { & $Log ("  累计 " + [int]($scanned/1MB) + "MB 候选=" + $verified.Count) }
        $text = [Text.Encoding]::GetEncoding(28591).GetString($buf, 0, [int64]$read)
        foreach ($m in $rx.Matches($text)) {
          $hx = $m.Value
          $cand = $null
          if ($hx.Length -eq 64) { $cand = $hx }
          elseif ($hx.Length -eq 96 -and $hx.Substring(64).ToLower() -eq $SaltHex) { $cand = $hx.Substring(0, 64) }
          elseif ($hx.Length -gt 96 -and ($hx.Length % 2 -eq 0) -and $hx.Substring($hx.Length - 32).ToLower() -eq $SaltHex) { $cand = $hx.Substring(0, 64) }
          if (-not $cand) { continue }
          $keyBytes = New-Object byte[] 32
          for ($i = 0; $i -lt 32; $i++) { $keyBytes[$i] = [Convert]::ToByte($cand.Substring($i * 2, 2), 16) }
          try {
            $kdf = New-Object System.Security.Cryptography.Rfc2898DeriveBytes($keyBytes, $macSalt, 2, [System.Security.Cryptography.HashAlgorithmName]::SHA512)
            $macKey = $kdf.GetBytes(32)
            $hmac = New-Object System.Security.Cryptography.HMACSHA512(,$macKey)
            $calc = $hmac.ComputeHash($hmacMsg)
            $ok = $true
            for ($i = 0; $i -lt 64; $i++) { if ($calc[$i] -ne $storedHmac[$i]) { $ok = $false; break } }
            if ($ok -and -not $verified.Contains($cand.ToLower())) { $verified.Add($cand.ToLower()) }
          } catch { }
        }
      }
    }
    $next = $mbi.BaseAddress + $mbi.RegionSize
    if ($next -le $mbi.BaseAddress) { break }
    $addr = $next
    if ($verified.Count -ge 3) { break }
  }
  & $Log ("进程结束 pid=" + $p.Id + " 已验证=" + $verified.Count)
  [ArMemScan]::CloseProcess($h)
  if ($verified.Count -ge 1) { break }
}
[Console]::Out.Write(($verified | ConvertTo-Json -Compress))
`;

let keyCache = new Map(); // saltHex → encKey buffer

function verifyKey(encKey, page1) {
  const salt = page1.subarray(0, SALT_SZ);
  const macSalt = Buffer.from(salt).map((b) => b ^ 0x3a);
  const macKey = crypto.pbkdf2Sync(encKey, macSalt, 2, 32, 'sha512');
  const hmacData = page1.subarray(SALT_SZ, PAGE_SZ - RESERVE_SZ + 16);
  const stored = page1.subarray(PAGE_SZ - HMAC_SZ);
  const h = crypto.createHmac('sha512', macKey).update(hmacData).update(Buffer.from([1, 0, 0, 0])).digest();
  return crypto.timingSafeEqual(h, stored);
}

function scanKeyViaPowerShell(dbPath, page1) {
  ensureDir(cacheDir());
  const ps1 = path.join(cacheDir(), 'trae-keyscan.ps1');
  fs.writeFileSync(ps1, KEYSCAN_PS, 'utf8'); // 每次覆写，避免旧版本脚本缓存
  const { execFileSync } = require('child_process');
  const ps = 'powershell.exe';
  const out = execFileSync(ps, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
    '-SaltHex', page1.subarray(0, SALT_SZ).toString('hex'),
    '-Page1Hex', page1.toString('hex'),
  ], { timeout: 900000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
  const trimmed = String(out || '').trim();
  // PS 单候选时 ConvertTo-Json 输出裸字符串而非数组——宽松解析 + 64hex 兜底提取（Node 侧会逐个复验，多收无害）
  let arr = [];
  try { const j = JSON.parse(trimmed); arr = Array.isArray(j) ? j : [j]; } catch { }
  if (!arr.length) { const m = trimmed.match(/[0-9a-fA-F]{64}/g); if (m) arr = m; }
  const keys = [...new Set(arr)].filter((k) => typeof k === 'string' && k.length === 64);
  for (const hex of keys) {
    const kb = Buffer.from(hex, 'hex');
    if (kb.length === 32 && verifyKey(kb, page1)) return kb;
  }
  return null;
}

// 解密缓存：按源库 mtime+size 命名，Trae 未写盘时复用
function plainCachePath(dbPath, st) {
  return path.join(cacheDir(), `trae-dec-${path.basename(path.dirname(path.dirname(dbPath)))}-${st.size}-${Math.round(st.mtimeMs)}.db`);
}

function getPlainDb(dbPath) {
  const st = fs.statSync(dbPath);
  const page1 = Buffer.alloc(PAGE_SZ);
  const fd = fs.openSync(dbPath, 'r');
  fs.readSync(fd, page1, 0, PAGE_SZ, 0);
  fs.closeSync(fd);
  if (page1.subarray(0, 16).toString('latin1') === 'SQLite format 3\x00') return { dbFile: dbPath, decrypted: false };
  const cache = plainCachePath(dbPath, st);
  if (fs.existsSync(cache)) return { dbFile: cache, decrypted: true };
  const saltHex = page1.subarray(0, SALT_SZ).toString('hex');
  let encKey = keyCache.get(saltHex) || null;
  if (!encKey) {
    encKey = scanKeyViaPowerShell(dbPath, page1);
    if (!encKey) throw new Error('未能从运行中的 Trae 进程内存提取密钥——请确认 Trae 已启动并打开过 AI 对话（密钥仅存在于 ai-agent 进程内存）');
    keyCache.set(saltHex, encKey);
  }
  ensureDir(cacheDir());
  // 原子写：先写临时文件，全部页解密成功后 rename——中途失败不留下半成品缓存（曾被空壳缓存命中过）
  const tmp = cache + '.tmp-' + process.pid;
  const out = fs.openSync(tmp, 'w');
  const total = Math.ceil(st.size / PAGE_SZ);
  const encBuf = Buffer.alloc(PAGE_SZ);
  const fdIn = fs.openSync(dbPath, 'r');
  try {
    for (let pgno = 1; pgno <= total; pgno++) {
      const expect = pgno === total ? st.size - (total - 1) * PAGE_SZ : PAGE_SZ;
      const got = fs.readSync(fdIn, encBuf, 0, expect, (pgno - 1) * PAGE_SZ);
      const page = got < PAGE_SZ ? Buffer.concat([encBuf.subarray(0, got), Buffer.alloc(PAGE_SZ - got)]) : encBuf;
      const iv = page.subarray(PAGE_SZ - RESERVE_SZ, PAGE_SZ - RESERVE_SZ + 16);
      const start = pgno === 1 ? SALT_SZ : 0;
      const enc = page.subarray(start, PAGE_SZ - RESERVE_SZ);
      const decipher = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
      decipher.setAutoPadding(false); // SQLCipher 为无填充 CBC（数据区恰为 16 的倍数），必须关闭 PKCS#7 校验
      const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
      const outPage = pgno === 1
        ? Buffer.concat([Buffer.from('SQLite format 3\x00', 'latin1'), dec, Buffer.alloc(RESERVE_SZ)])
        : Buffer.concat([dec, Buffer.alloc(RESERVE_SZ)]);
      fs.writeSync(out, outPage, 0, PAGE_SZ);
    }
    fs.closeSync(fdIn);
    fs.closeSync(out);
    fs.renameSync(tmp, cache);
  } catch (e) {
    try { fs.closeSync(fdIn); } catch { }
    try { fs.closeSync(out); } catch { }
    try { fs.rmSync(tmp, { force: true }); } catch { }
    throw e;
  }
  return { dbFile: cache, decrypted: true };
}

// ---------- 只读：列表 / 详情 ----------
function listSessions(baseDir) {
  const dbp = dbPath(baseDir);
  if (!fs.existsSync(dbp)) return [];
  const { dbFile } = getPlainDb(dbp);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const hasH = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='history_v2'").get();
    const rows = db.prepare(`
      SELECT s.session_id, s.session_title, s.session_type, s.created_at, s.updated_at,
             (SELECT count(*) FROM history_v2 h WHERE h.session_id = s.session_id) msg,
             (SELECT max(h.created_at) FROM history_v2 h WHERE h.session_id = s.session_id) last
      FROM chat_session s ORDER BY COALESCE(s.updated_at, s.created_at) DESC`).all();
    let projects = new Map();
    try {
      const pcols = db.prepare('PRAGMA table_info("project")').all().map((c) => c.name);
      const nameCol = pcols.includes('absolute_path') ? 'absolute_path' : (pcols.includes('path') ? 'path' : (pcols.includes('project_path') ? 'project_path' : (pcols.includes('name') ? 'name' : null)));
      const idCol = pcols.includes('project_id') ? 'project_id' : 'id';
      if (nameCol) for (const p of db.prepare(`SELECT ${JSON.stringify(idCol).replace(/"/g, '')} AS pid, ${JSON.stringify(nameCol).replace(/"/g, '')} AS pname FROM project`).all()) projects.set(String(p.pid), String(p.pname || ''));
    } catch { }
    let sessProj = new Map();
    try {
      for (const r of db.prepare('SELECT session_id, project_id FROM session_project').all()) sessProj.set(r.session_id, r.project_id);
    } catch { }
    return rows.map((r) => ({
      id: r.session_id, agent: AGENT, file: dbp,
      title: truncateStr(r.session_title || '(无标题)', 60),
      cwd: projects.get(String(sessProj.get(r.session_id))) || '',
      tsFirst: r.created_at ? new Date(r.created_at * 1000).toISOString() : null,
      tsLast: new Date((r.last || r.updated_at || r.created_at || 0) * 1000).toISOString(),
      msgCount: r.msg ?? null, toolCalls: null, size: fs.statSync(dbp).size, archived: false,
      session_type: r.session_type,
    }));
  } finally { db.close(); }
}

async function readSession(sessionId, baseDir) {
  const dbp = dbPath(baseDir);
  if (!fs.existsSync(dbp)) throw new Error(`Trae database.db 不存在: ${dbp}`);
  const { dbFile } = getPlainDb(dbp);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const entries = [];
  const loss = [];
  let sess = null;
  let cwd = '';
  const env = { model: null, provider: null, cli_version: null };
  try {
    sess = db.prepare('SELECT * FROM chat_session WHERE session_id = ?').get(sessionId);
    const rows = db.prepare('SELECT * FROM history_v2 WHERE session_id = ? ORDER BY id').all(sessionId);
    const seen = new Set();
    let recordedTokens = 0;
    for (const r of rows) {
      if (r.token_usage) recordedTokens += Number(r.token_usage) || 0;
      if (!r.messages) continue;
      let j;
      try { j = JSON.parse(r.messages); } catch { continue; }
      const raws = j.raw_messages || j.messages || [];
      for (const m of raws) {
        if (!m || !m.role) continue;
        const ts = r.created_at ? new Date(r.created_at * 1000).toISOString() : null;
        const content = Array.isArray(m.content) ? m.content : (m.content != null ? [{ type: 'text', text: String(m.content) }] : []);
        const blocks = [];
        for (const b of content) {
          if (b.type === 'text' && b.text) blocks.push({ type: 'text', text: b.text });
          else if ((b.type === 'thinking' || b.type === 'think') && (b.text || b.thinking)) blocks.push({ type: 'thinking', text: b.text || b.thinking || '' });
          else if (b.type === 'tool_use' || b.type === 'tool_call') blocks.push({ type: 'tool_use', id: b.id || b.tool_call_id || 'call_' + randomId(), name: b.name || b.tool_name || 'tool', input: safe(b.arguments ?? b.input ?? {}) });
          else if (b.type === 'tool_result' || b.type === 'tool_output') blocks.push({ type: 'tool_result', for: b.tool_call_id || b.id || 'call', output: typeof (b.output ?? b.content) === 'string' ? (b.output ?? b.content) : JSON.stringify(b.output ?? b.content ?? ''), isError: !!b.is_error });
        }
        // history_v2 可能为同一条消息保留多行快照：按 role+内容指纹去重
        const fp = m.role + '|' + JSON.stringify(blocks);
        if (seen.has(fp)) continue;
        seen.add(fp);
        if (m.role === 'user' && blocks.some((b) => b.type === 'text')) {
          entries.push({ id: 'h' + entries.length, ts, role: 'user', kind: 'text', blocks, meta: {} });
        } else if (m.role === 'assistant' && blocks.length) {
          entries.push({ id: 'h' + entries.length, ts, role: 'assistant', kind: 'text', blocks, meta: { model: m.model || null } });
          if (m.model && !env.model) env.model = m.model;
        }
      }
    }
    if (sess) {
      cwd = '';
      try {
        const pj = db.prepare('SELECT project_id FROM session_project WHERE session_id = ?').get(sessionId);
        if (pj) {
          const pcols = db.prepare('PRAGMA table_info("project")').all().map((c) => c.name);
          const nameCol = pcols.includes('absolute_path') ? 'absolute_path' : (pcols.includes('path') ? 'path' : (pcols.includes('project_path') ? 'project_path' : (pcols.includes('name') ? 'name' : null)));
          const idCol = pcols.includes('project_id') ? 'project_id' : 'id';
          if (nameCol && pj.project_id != null) {
            const p = db.prepare(`SELECT ${JSON.stringify(nameCol).replace(/"/g, '')} AS pname FROM project WHERE ${JSON.stringify(idCol).replace(/"/g, '')} = ?`).get(String(pj.project_id));
            if (p) cwd = String(p.pname || '');
          }
        }
      } catch { }
    }
    const stats = { entries: entries.length, userTurns: 0, assistantEntries: 0, toolCalls: 0, toolResults: 0, thinking: 0, approxTokens: 0, recordedTokens };
    for (const e of entries) {
      if (e.role === 'user' && e.kind === 'text') stats.userTurns++;
      if (e.role === 'assistant') stats.assistantEntries++;
      for (const b of e.blocks) {
        if (b.type === 'tool_use') stats.toolCalls++;
        if (b.type === 'tool_result') stats.toolResults++;
        if (b.type === 'thinking') stats.thinking++;
        stats.approxTokens += Math.ceil((b.text || JSON.stringify(b.input ?? '')).length / 3.5);
      }
    }
    const firstUser = entries.find((e) => e.role === 'user' && e.kind === 'text');
    return {
      arx: 1, id: crypto.randomUUID(), created_at: nowISO(),
      source: { agent: AGENT, agent_version: null, session_id: sessionId, title: (sess && sess.session_title) || truncateStr(firstUser ? firstUser.blocks[0].text : '', 60) || '(无标题)', file: dbp },
      project: { cwd },
      env,
      stats, entries, compactions: [], loss: [...new Set(loss)],
      _fileStat: { size: fs.statSync(dbp).size, mtimeMs: fs.statSync(dbp).mtimeMs },
    };
  } finally { db.close(); }
}

function randomId() { return crypto.randomBytes(4).toString('hex'); }
function safe(v) { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? {}); } catch { return { raw: v }; } }

function doctor(baseDir) {
  const p = dbPath(baseDir);
  const exists = fs.existsSync(p);
  let sessions = 0;
  try { sessions = listSessions(baseDir).length; } catch { }
  return {
    agent: AGENT, ok: exists && sessions > 0, storage: p, sessionFiles: sessions,
    note: exists ? null : '未发现 Trae 数据库（%APPDATA%\\Trae CN\\ModularData\\ai-agent\\database.db）',
  };
}

module.exports = { listSessions, readSession, doctor, dbPath, findDbs };
