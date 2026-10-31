@echo off
chcp 65001 >nul
title AgentRelay
cd /d "%~dp0"
echo ============================================
echo   AgentRelay - 跨 Agent 会话接力
echo   http://127.0.0.1:17777
echo ============================================
rem 先延时 2 秒再开浏览器（等端口就绪），避免白屏/拒绝连接；服务随后启动
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start "" http://127.0.0.1:17777"
node server\index.js
