'use strict';
// 豆包工作（字节跳动）适配器 —— 仅 T2 目标。
// 逆向结论（2026-11，客户端 15:32 安装 + 2 个真实工作任务实测）：
// - 对话/任务正文存于应用内 Chromium IndexedDB（User Data/Default/IndexedDB/chrome_doubao-chat_0.*，
//   LevelDB+V8 序列化）并与云端同步，无本地原生会话库 → 读不了、也没东西可写（T0/T1 均不可行）
// - 任务执行走 sandbox_envs_dir 沙盒 + DoubaoLinkRouter 管道，task_outputs 只留退出码日志
// - 可行形态：T2 逐字转写写进豆包工作"项目"绑定的本地目录，工作任务里按启动提示词让它读取
// - 项目/技能体系：~/Doubao/skills/（当前为空，格式未知，暂不接入）
const fs = require('fs');
const path = require('path');
const { HOME } = require('./util');

function userDataDir() {
  return process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Doubao', 'User Data')
    : path.join(HOME, 'AppData', 'Local', 'Doubao', 'User Data');
}

function doctor() {
  const root = userDataDir();
  const ok = fs.existsSync(root);
  return { agent: 'doubao', ok, storage: root, sessionFiles: 0, note: ok ? null : '未检测到豆包（Doubao）桌面端' };
}

module.exports = { doctor, userDataDir };
