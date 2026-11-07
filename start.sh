#!/usr/bin/env bash
# AgentRelay 启动脚本（Linux / macOS）
# 用法：./start.sh  （或 AGENTRELAY_PORT=18000 ./start.sh 换端口）
set -e
cd "$(dirname "$0")"
PORT="${AGENTRELAY_PORT:-${MOVESESSION_PORT:-17777}}"
echo "============================================"
echo "  AgentRelay - 跨 Agent 会话接力"
echo "  http://127.0.0.1:${PORT}"
echo "============================================"
exec node server/index.js
