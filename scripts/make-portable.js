'use strict';
// 免安装便携包构建：node.exe（官方运行时）+ 项目源码 + 启动脚本 → 一个 zip。
// 产出 dist/AgentRelay-v<版本>-windows-portable.zip（dist/ 已 gitignore）。
// 用法：node scripts/make-portable.js [--node-url <node.exe 直链>]
//   网络走环境变量 HTTPS_PROXY（本机代理环境下直接可用）。
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

// Node 运行时：固定 v24 LTS（node:sqlite + 内置 zstd 都在）。如官方 latest 变动，--node-url 可覆盖。
const NODE_URL = argOf('--node-url') || 'https://nodejs.org/dist/latest-v24.x/win-x64/node.exe';

const stage = path.join(DIST, `AgentRelay-v${version}-win-portable`);
const zipOut = path.join(DIST, `AgentRelay-v${version}-windows-portable.zip`);

function log(s) { console.log('  ' + s); }

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

(async () => {
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.mkdirSync(DIST, { recursive: true });

  // 1) node.exe（带缓存：重复构建不重复下载）
  const nodeExe = path.join(stage, 'node.exe');
  const cache = path.join(DIST, 'node.exe.cache');
  if (fs.existsSync(cache)) {
    fs.copyFileSync(cache, nodeExe);
    log(`node.exe 复用缓存 (${(fs.statSync(nodeExe).size / 1e6).toFixed(1)} MB)`);
  } else {
    log(`下载 Node 运行时: ${NODE_URL}`);
    const n = await download(NODE_URL, nodeExe);
    fs.copyFileSync(nodeExe, cache);
    log(`node.exe ${ (n / 1e6).toFixed(1)} MB（已缓存到 dist/node.exe.cache）`);
  }

  // 2) 项目文件：服务端 + GUI + CLI + 文档（绝不带 sandbox/dist/数据目录/.git）
  for (const p of ['server', 'docs', 'README.md', 'README.zh-CN.md', 'LICENSE', 'package.json']) {
    const src = path.join(ROOT, p);
    const dst = path.join(stage, p);
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true });
    else fs.copyFileSync(src, dst);
  }
  fs.rmSync(path.join(stage, 'sandbox'), { recursive: true, force: true });

  // 3) 便携启动脚本：优先用包内 node.exe，回退系统 node
  fs.writeFileSync(path.join(stage, 'StartAgentRelay.bat'), [
    '@echo off',
    'chcp 65001 >nul',
    'title AgentRelay',
    'cd /d "%~dp0"',
    'echo ============================================',
    'echo   AgentRelay - 跨 Agent 会话接力（免安装便携版）',
    'echo   http://127.0.0.1:17777',
    'echo ============================================',
    'set "NODE_EXE=%~dp0node.exe"',
    'if not exist "%NODE_EXE%" set "NODE_EXE=node"',
    'start "" /min cmd /c "timeout /t 2 /nobreak >nul & start "" http://127.0.0.1:17777"',
    '"%NODE_EXE%" server\\index.js',
    '',
  ].join('\r\n'));

  // 4) zip（PowerShell Compress-Archive，零依赖）
  if (fs.existsSync(zipOut)) fs.rmSync(zipOut, { force: true });
  log('打包 zip…');
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipOut}' -Force"`, { stdio: 'inherit' });
  const mb = (fs.statSync(zipOut).size / 1e6).toFixed(1);
  log(`完成: ${zipOut} (${mb} MB)`);
  console.log(mb);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
