# MoveSession 真实验证报告（2026-10-29 凌晨自动验收）

> 所有实验均在本机真实数据上执行；写真实存储前自动备份到 `~/.movesession/backups/`。
> 结论：**四家 agent 读取全部打通，三条写入通道（Claude / Codex / ZCode / WorkBuddy）全部打通，
> 跨源注入的会话被目标 agent 原生 CLI 正确识别并加载。**
> 唯一未能走完的"最后一公里"（模型实际回复）被用户自建 API 代理的余额/可用性挡住，与本工具无关（详见下文证据）。

## 汇总

| 实验 | 路径 | 结果 | 证据 |
|---|---|---|---|
| 1 | ZCode → Codex (T1) | ✅ 注入+注册成功，**codex exec resume 成功识别并重放会话** | codex 输出 `session id: 01a18374-…`、重放历史、发送提示词；最终 403 = 用户代理（cf.hetune.top）**余额不足**（"用户额度不足, 剩余额度: ＄-0.0099"） |
| 2 | Codex → Claude (T1) | ✅ 注入成功，**claude --resume 成功识别会话** | claude 加载会话并按会话内模型发起请求；400 = 用户路由（opencode.ai/zen）对**所有请求**（含全新无注入会话）都返回 "Upstream request failed: Model is unavailable"，证明与注入无关 |
| 3 | Claude → ZCode (T1) | ✅ 真实写入 db.sqlite（自动备份）+ 回读一致 | `sess_3f09f2f7`：11 条消息/9 parts/session_input 齐全；ZCode 桌面端会话列表可见 |
| 4a | Claude → Claude (T0) | ✅ 原生复制 + 回读 | `157673ea`（40 行，100% 保真） |
| 4b | Codex → Codex (T0) | ✅ 原生复制 + threads 注册 | `01a18376` |
| 5 | WorkBuddy → Claude (T1) | ✅ 注入 + 回读 | `33f9892e`：151 条 / 5 轮 / 29 工具调用 / 48 思考块（WorkBuddy 思考为明文，全量保留） |
| 6 | ZCode → T2 逐字转写 | ✅ 696KB 逐字全文 handoff 文件 + 启动指令 | `.movesession/handoff-2026-10-28T17-02-24-*.md` |
| 沙盒 | 四家 reader + 全部 writer + 回读 + 选择器 + 脱敏 | ✅ 全绿 | `node scripts/sandbox-test.js`（含 codex→claude 1911 条消息往返、claude→zcode 副本往返、codex→workbuddy 副本往返） |

## 关键证据原文摘录

**实验1 codex exec resume（注入会话被原生识别）：**
```
OpenAI Codex v0.154.0
model: glm-5.3-flash  provider: custom  session id: 01a18374-f0ee-759c-a600-232947fca3e1
user
请用一句话告诉我你接手前的工作状态，不要做任何操作
warning: This session was recorded with model `deepseek-v4.1-flash` but is resuming with `glm-5.3-flash`.
ERROR: unexpected status 403 Forbidden: 用户额度不足, 剩余额度: ＄-0.009940 （cf.hetune.top）
```
→ 会话被发现、被解析、历史被重放、请求已发到模型 API；被 403 挡住的是**用户第三方代理的余额**。

**实验2 claude --resume（注入会话被原生识别）：**
```
$ claude -p --resume 3038df57-… "…"
[claude-code:unrecognized_model] {"model":"deepseek-v4-flash"}   ← 会话内记录的模型被读取
API Error: 400 Upstream request failed: Model is unavailable.
$ claude -p "只需回复OK"                                          ← 对照组：全新会话同样 400
API Error: 400 Upstream request failed: Model is unavailable.
```
→ 对照组证明路由本身当前不可用；注入会话的加载/解析完全正常。

**处理措施**：T1 合成会话的模型名已改为优先记录用户当前配置（`~/.claude/settings.json` 的 ANTHROPIC_MODEL），
代理恢复后 `claude --resume <id>` 即可直接续接；也可显式 `--model <可用模型>`。

## 留在本机可直接验收的演示产物

| 产物 | 位置 | 验收方式 |
|---|---|---|
| ZCode→Codex 注入会话 | `codex resume 01a18374-f0ee-759c-a600-232947fca3e1` | Codex 里直接打开（源：ZCode「用CodeGraph了解项目及webui结构」fork） |
| Codex T0 复制 | `codex resume 01a18376-843a-76f8-b31c-153ad4a97ea9` | 同上 |
| Codex→Claude 注入会话 | `claude --resume 470388a4-bc45-4882-87bc-881a70509cf1`（cwd: 本地测试项目） | Claude Code /resume 列表可见 |
| WorkBuddy→Claude 注入会话 | `claude --resume 33f9892e-aa39-45b5-b9c7-6833cd890593`（同上） | 含 48 个思考块的完整逐字迁移 |
| Claude→Claude T0 复制 | `claude --resume 157673ea-9a0e-49b1-ad9e-18525249227b` | 100% 保真 |
| Claude→ZCode 注入会话 | ZCode 桌面端会话列表「hi」（本地项目目录） | 重启 ZCode 后可见 |
| T2 逐字转写包 | `<项目>\.agentrelay\handoff-*.md` | 696KB 全文记录 |

## 已知边界（诚实声明）

1. **思考块跨厂签名**：Claude thinking 的 signature 与 Codex encrypted_content 是厂商私钥签名，跨厂商重放在数学上不可行
   （业内所有转换器相同）。MoveSession 的处理：保留原文并以明文形式带位置迁移（ZCode/WorkBuddy 思考本就是明文，无损失），
   记入 `loss[]`。同源 T0 无任何损失。
2. **resume 的"最后一公里"**依赖用户 API 代理可用性。注入与加载已验证，模型响应取决于代理余额/可用性。
3. WorkBuddy 为只读导出 + T1/T2 写入（jsonl + sessions 表注册，已在副本验证回读）；其桌面端 resume 行为无法自动化验证。
4. Codex 超大 rollout（GB 级）采用流式/部分读取；本机最大 24MB，全量验证覆盖。

---

## 第二轮：审查修复后复测（2026-10-29 凌晨）

两位独立审查员（代码审查 + 对抗性实测）发现 1 个 P0、2 个发布阻塞、若干 P1，全部修复并复测：

| 问题 | 修复 | 复测 |
|---|---|---|
| [P0] codex T0 复制在非规范文件名下可能原地覆盖源文件 | 规范化命名 + 拒绝同路径 + 流式临时文件原子落盘 | ✅ |
| [阻塞] CLI `transfer` 把 `--from/--to` 路由参数误当选择参数 → 静默接力 0 条 | 数值守卫（非 finite 忽略）+ `--sfrom/--sto` 区间参数 | ✅ CLI T2 现在正确接力 151 条 |
| [阻塞] token 预算循环 O(n²)，8k 条挂死服务 18 分钟 | 增量 token 记账 + 批量丢弃 | ✅ 合成基准 6667 条（含 2222 个长工具输出）169ms；API 实测大会话 budget=100 全程 0.54s、budget=300000 结果 186756≤预算（预算真正生效） |
| [P1] ZCode 写库无事务（失败半写） | `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` 包裹（writeSession + copySession），空内容检查前置 | ✅ |
| [P1] 过滤工具结果后遗留孤儿 tool_use → Claude resume 400 | 双向配对清理（孤儿调用与结果同步剥离，记 loss） | ✅ e2e 中自动剥离 22 个孤儿调用 |
| [P1] 同一 Claude 行拆出的两条 entry 共享 uuid（勾选连带误删） | tool-result 条目 id 加 `_res` 后缀，无 uuid 行兜底 `row_N` | ✅ |
| [P1] GB 级文件 OOM（codex readSession/rawCopy、export、T2） | 全部流式化（streamJsonl / openJsonlWriter / 流式 MSX 与 markdown 写出） | ✅ 3595 条 codex 会话往返正常 |
| [P1] 备份三件套拷贝可能撕裂且无限增长 | SQLite `VACUUM INTO` 一致性快照 + 保留 20 份策略 | ✅ |
| ZCode 写库走 WAL 后读缓存误判新鲜 → 回读不到刚写的会话 | 缓存签名纳入 wal/shm 的 mtime+size | ✅ 实验三回读 151 条含 48 思考块 |
| 其他 P2（is_error 透传、turn_context 顺序、walk ENOENT、__proto__ 防护、413、批量选项泄漏、文件名注入、死代码等） | 已修 | ✅ |

修复后回归：`scripts/sandbox-test.js` 全绿（四家读写往返 + 选择器 + 脱敏）；`scripts/e2e.js` 重跑全部通过
（codex threads 注册 ✔、codex exec resume 识别注入会话 ✔【模型调用仍被用户代理 403 余额挡住】、
claude --resume 识别注入会话 ✔【路由对全新会话同样 400，与注入无关】、ZCode 真实写库+回读 ✔、
T0×2 ✔、WorkBuddy→Claude ✔、T2 ✔）。

---

## 第三轮：复审确认 + 最后一项阻塞修复（2026-10-29 凌晨）

复审确认：第二轮 3 个 P1（/api/export 回归、预算 livelock、预算丢弃复活孤儿）**全部验证修复且质量良好**；
预算首次真正生效（8889→2484 条，total 19916≤20000）；确定性孤儿复现用例扫 51 个预算档 0 孤儿；
zcode VACUUM 读副本在最严格条件（连接不关、写只落 WAL）下立即可见新会话。

复审发现的最后一项阻塞：413 处理自身引入崩溃（`readBody` 缺 `res` 参数 → >64MB 请求体即杀进程；
外层 catch 在 headersSent 后二次写头）。已修复并实测：**70MB 请求 → 客户端收到 HTTP 413，服务存活
（后续请求 200）**；同时 preview 对不存在会话返回语义化 404；P3 清理（sha256File 死代码、
VACUUM 前清理残留 -wal/-shm）完成。

三轮审查累计：1×P0、2×发布阻塞、8×P1、20+×P2/P3 全部修复或明确记录为延后项（claude 侧流式化——
本机存储 3.3MB，复审同意延后）。最终 `sandbox-test.js` 全绿，服务健康（四家 agent 检出
Claude 10 / Codex 56 / ZCode 69 / WorkBuddy 21 个会话）。


---

## 第四轮：P1/P1.5/P2 批次交付记录（2026-10-29 夜）

| 批次 | 交付 | 验证 |
|---|---|---|
| P0 | 选中框切换修复、K/M token、相对时间、五级日志（error/warn/info/debug/trace）、异常兜底+错误提示+诊断包 | sandbox 全绿 + API/浏览器逐项实测 |
| P1 | 配置中心与动态数据目录、适配器 baseDir 线程化（去写死路径）、实例注册表（内置+自定义实例、启停）、惰性加载（计数廉价化+30s 缓存+骨架屏）、中英双语、三态主题、首次运行向导、接力页流式改版、快速上手卡片、级别自动推荐 | sandbox 全绿 + 浏览器逐项实测（向导/双语/主题/设置页/dry-run） |
| P1.5 | design skills 美化（排版/材质/骨架屏/动效/reduced-motion）、关于区（版本/作者/star/赞助/更新检测，默认关）、双语 README + LICENSE + 截图 | 浏览器实测（亮色文字色/关于按钮/主题切换） |
| P2 | MCP 接口（6 工具，transfer 默认 dry-run，实测握手+调用）、OpenCode 适配器（✅ 本机真实数据：读 504 条/写 267 条回读） | MCP 握手测试 + 真实数据往返 |
| 新适配器结论 | OpenCode ✅（与 ZCode 同源 message/part 架构）；Trae（IndexedDB leveldb，待样本 🧪）；Pi（本机无会话数据 🔌） | 本机实测 + 源码/社区调研 |

---

## 第五轮：审核建议执行 + 最终复验（2026-10-30）

全方位审核（12 条建议）执行记录：

| 优先级 | 建议 | 结果 |
|---|---|---|
| P0-1 | OpenCode T1/T0 静默假成功 → 接线 opencode 写入 + T0/T1 白名单守卫 | ✅ 复验通过（dry-run 实测 notes 正确） |
| P0-2 | 大会话 83MB 响应 → /api/session 分页（默认 200 条/2KB 预览截断）+ 大会话解析缓存（LRU2+TTL5min） | ✅ 复验通过（2596 条会话 limit=50 → 166KB） |
| P0-3 | 接力防重复提交 + 写入前确认（GUI 此前无确认） | ✅ 复验通过（单会话+批量，含 confirm 与按钮禁用） |
| P1-5 | 跨 agent 全文搜索 /api/search（zcode/opencode SQL + JSONL 流式，6s deadline） | ✅ 实测 量化→39 条、codegraph→28 条；搜索结果防覆盖守卫 |
| P1-6 | 备份管理（列表/总占用/还原前安全备份/删除） | ✅ 实测 GET 4 份 343MB；restore/delete 路由（含路径穿越防护） |
| P1-7 | 最近接力面板（接力页聚合日志 + resume 一键复制） | ✅ |
| P1-8 | Host/Content-Type 校验（防 drive-by POST/DNS rebinding） | ✅ 实测 evil host 403、非 JSON 415 |
| P1-9 | 批量弹窗搜索 + 200 条截断提示 | ✅ |
| P1-10 | 仓库清洁（315MB 残留删除/.gitignore/CI/旧截图） | ✅ 复验通过 |
| P1-4 | codex/claude 扫描 per-file 缓存（mtime+size） | ✅ 复验通过 |
| P2-11/12 | preview instance 一致性、伪项目过滤、detect 无副作用、死代码清理、toast 延迟、主题按钮文字化、亮色对比度 | ✅（其中 detect 副作用为验收轮发现，一并修复） |

复验发现的 2 个执行缺陷（restore 引用未导入 HOME、批量 m.running 未置位）已修复并动态验证
（restore 全路径 200、evil host 403、批量 try/finally）。3 条发布前建议（备份路径
path.relative 防护、批量 try/finally、restore 空结果提示）也已执行。

**最终复验结论（第三轮独立复审）：可发布。** sandbox 全绿；支持矩阵：Claude Code ✅ / Codex ✅ /
ZCode ✅ / WorkBuddy ✅ / OpenCode ✅ / DeepSeek Harness ✅（116 会话实测）/
Gemini CLI 🧪 / Pi 🧪 / OpenClaw 🧪（官方 schema + 合成样本）；
Trae（SQLCipher 加密）与 Aider（无会话模型）明确标注暂缓。

---

## 第六轮：UI 全量重构 + 备份开关 + 全文搜索 + 目录浏览器（2026-10-30）

用户反馈前端"还是难看"，要求按 skills 彻底重做。执行了完全重构：

| 变更 | 说明 |
|---|---|
| **前端全量重写** | index.html + style.css + app.js 全部重写。设计系统对齐 landing-page-design skill：Geist 自托管字体、暗色 #000 底 / #181818 面、Tailwind 间距/圆角/字号刻度、平 backgrounds（移除 mesh orbs）、基础曲线 cubic-bezier(0.22,1,0.36,1) 500ms |
| **图标系统** | 新增 icons.js（细线 1.5-stroke SVG），全部 emoji 替换为内联 SVG |
| **接力向导** | 从弹窗改为独立页面，三步布局（来源→目标→执行），选中状态一目了然 |
| **活动时间线** | 操作日志改为人类可读时间线（"接力成功: zcode → codex"），级别过滤 pills |
| **诊断双栏** | 左：agent 健康卡 + 备份管理；右：诊断包 + 原始 JSON |
| **目录浏览器** | 新增 /api/fs/list 端点 + 浮层目录选择器（向导/设置/添加实例均可选目录） |
| **备份开关** | config.backupEnabled 全局开关（设置页）+ 接力页单次覆盖勾选 + CLI --no-backup + MCP args.backup |
| **自适应** | 设置/诊断/接力全宽 fluid（max-width 1500px），窄屏三栏降级为两栏/单栏 |

独立审查 subagent 发现 3 P0 + 6 P1 + 7 P2 → 全部修复：#app 包裹、.sessions-layout 容器、--accent2 变量、qs-step 中文裸键、refresh 图标、data-copy 绑定、instt 表格样式、add-form 样式、EN 81 键补齐、69 死键清理。

最终浏览器 DOM 验证：三栏布局 ✅ · 317 会话 ✅ · 详情分页 200 条 ✅ · 全文搜索 27 命中 ✅ · 接力向导 6 目标卡 ✅ · 备份开关 ✅ · 目录浏览器 ✅ · 活动时间线 96 条 ✅ · 诊断双栏 ✅ · 双语切换 ✅
