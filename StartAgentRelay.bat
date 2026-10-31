@echo off
chcp 65001 >nul
title AgentRelay
cd /d "%~dp0"
echo ============================================
echo   AgentRelay - 跨 Agent 会话接力
echo   http://127.0.0.1:17777
echo ============================================
start "" "http://127.0.0.1:17777"
node server\index.js
