# 四家 Agent 会话存储格式逆向笔记（本机实测 2026-10-29）

> 本文件是开发期间的"格式真源"，所有适配器以此为准。实测环境：Windows 11，用户目录以 ~ 指代。

## 环境
- Node v24.14.0（**自带 node:sqlite DatabaseSync**，零 npm 依赖方案可行）
- Python 3.10.8（sqlite3 3.37.2，兜底）
- Claude Code 2.1.289 / Codex CLI 0.154.0 / ZCode 3.16.3（db 内 version 字段 0.16.5）/ WorkBuddy 桌面端已装无数据

## 1. Claude Code — `~/.claude/projects/<slug>/<session-uuid>.jsonl`
- slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')。例：`C:\demo\App` → `C--demo-App`（slug 不含盘符冒号等非字母数字字符）
- 本机实测：projects 下按此规则生成 slug 目录（每个目录一组会话 jsonl）
- **无 sessions-index.json、无 subagents 目录**（本机实测 glob 为空）→ 写入新文件即被识别；`claude --resume <id>` 会搜索所有项目；也支持 `claude --resume <path.jsonl>`
- 行类型实测：`mode`、`permission-mode`、`file-history-snapshot`、`user`、`attachment`、`assistant`、`system`、`last-prompt`（histogram 8+8+20 user/assistant）
- user 行：`{parentUuid, isSidechain, promptId?, type:'user', message:{role:'user', content: string|[blocks]}, isMeta?, uuid, timestamp(ISO), userType:'external', entrypoint:'cli', cwd, sessionId, version, gitBranch?}`
  - content 数组 block：`{type:'tool_result', tool_use_id, content: string|blocks}`（工具结果在 user 行内！）
- assistant 行：`{parentUuid, isSidechain, type:'assistant', uuid, timestamp, message:{id:'resp_<hex>', type:'message', role:'assistant', content:[blocks], model, stop_reason, usage:{input_tokens,cache_read_input_tokens,output_tokens,...}}, cwd, sessionId, version}`
  - block：`{type:'text',text}` / `{type:'thinking',thinking,signature}` / `{type:'tool_use',id,name,input}`
- system 行（本地命令回显）：`{type:'system', subtype:'local_command', content, level:'info', uuid, timestamp,...}`；user 行 isMeta:true 是命令 caveat（跳过类）
- attachment 行：hook 输出等（SessionStart:startup 的 additionalContext 就记录在这）
- last-prompt：`{type:'last-prompt', lastPrompt, leafUuid, sessionId}`
- 链：消息行靠 parentUuid 成链（首行 null）；isSidechain:true 为子代理分支
- **写入器策略（已验证可行性的社区先例 web-to-cc）**：user/assistant 行 + parentUuid 链 + 末尾 `{"type":"summary","summary":标题,"leafUuid":末行uuid}` + `{type:'last-prompt',...}`；version 写当前 2.1.289

## 2. Codex CLI — `~/.codex/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDThh-mm-ss>-<uuid>.jsonl`
- 本机 56 个 rollout；config.toml 顶层 `model_provider = "custom"`，`[model_providers.custom]` 存在
- 行信封：`{timestamp(ISO UTC ms), ordinal(递增整数), type, payload}`
- `session_meta` payload 实测：`{session_id, id, timestamp, cwd, originator:'codex-tui', cli_version:'0.130.0'(旧), source:'cli', thread_source:'user', model_provider:'custom', base_instructions:{text:"You are Codex..."}}`
- `turn_context` payload：`{turn_id, cwd, current_date, timezone:'Asia/Shanghai', approval_policy:'on-request', sandbox_policy:{type:'workspace-write',network_access:false,...}, permission_profile:{...}}`
- `response_item` payload 类型实测 histogram：message(6547)/reasoning(6975)/function_call(4129)/function_call_output(4129)/custom_tool_call(3733)/custom_tool_call_output(3733)/web_search_call(232)/tool_search_call(4)/agent_message(8)
  - message：`{type:'message', role:'user'|'assistant'|'developer', content:[{type:'input_text'|'output_text', text}]}`
  - reasoning：`{summary:[{type:'summary_text',text}] 或 [], content:null, encrypted_content:'gAAAA...'}`（加密思考不可迁移→只转 summary_text，无则记占位）
  - function_call：`{name, arguments: JSON字符串, call_id, status?}`；function_call_output：`{call_id, output: string}`
  - custom_tool_call：`{call_id, name:'apply_patch', input: 原始字符串, status}`；_output：`{call_id, output: string(JSON结果)}`
  - web_search_call：`{status, action:{type:'search', query, queries[]}}`
- `event_msg` payload：task_started / task_complete{last_agent_message} / item_completed / token_count{info,rate_limits} / turn_aborted / thread_settings_applied{thread_settings:{model, model_provider_id,...}}
- `compacted`：`{message: "Another language model started to solve... 摘要文本"}`（78 个）
- 其他：world_state、inter_agent_communication_metadata、token_usage_record（都是环境/统计，跳过）

### Codex 注册机制（resume 可见性，关键！）
- **`~/.codex/state_5.sqlite` 表 `threads`**（56 行=56 rollout）：列 `id, rollout_path, created_at(unix秒), updated_at, source:'cli', model_provider, cwd(**'\\?\C:\demo\app'** 扩展前缀), title, sandbox_policy(JSON), approval_mode, tokens_used, has_user_event, archived, git_sha/branch/origin_url, cli_version, first_user_message, agent_nickname/role, memory_mode, model, reasoning_effort, agent_path, created_at_ms, updated_at_ms, thread_source, preview, recency_at, recency_at_ms, history_mode, name, is_pinned, thread_section_id, section_position, section_entered_at_ms, project_id, originator, daybreak_enabled`
- `thread_history_1.sqlite`：thread_turns/thread_items（rollout 的投影缓存，有 backfill_state 机制 state_5.backfill_state status='complete'）→ 写入 threads 后投影可由 backfill 重建；v1 先只写 threads + rollout + session_index，E2E 验证 resume
- `~/.codex/session_index.jsonl`：`{"id","thread_name","updated_at"}` 18 行（命名线程索引）
- `~/.codex/external_agent_session_imports.json`：官方 Claude→Codex 导入账本 `{records:[{source_path, content_sha256, imported_thread_id, imported_at, source_modified_at}]}`；被导入的那个线程后来被归档到 `archived_sessions/`（rollout-...-019f3d42-1c1d-7cb2-bdb3-c8a4ecf2ee28.jsonl 与账本 imported_thread_id 一致）
- **写入器策略**：写 rollout 文件 + INSERT state_5.threads（模板取最新真实行）+ 追加 session_index.jsonl + 追加官方账本（source 为 claude 时）

## 3. ZCode — `~/.zcode/cli/db/db.sqlite`（165MB，WAL；本机 63 会话/9807 消息）
- 表：session, message, part, session_input, session_entry, session_target, session_task_link, turn_usage, model_usage, tool_usage, todo, permission, input_history, local_setting, dwf_*, workflow_*, schema_migration, zcode_database_identity
- **无 projects 表**；session.project_id 是推导值：`proj_` + cwd.toLowerCase().replace(/[^a-z0-9_]/g,'-') → 'C:\demo\my_app' → `proj_c-demo-my_app`（实测）
- session 列：id('sess_<uuid4>'), project_id, workspace_id(NULL), parent_id(fork 时指向源), slug(=id 或 '...-fork-xxx'), directory, path, title, version('0.16.5'), share_url, summary_*, revert, permission('{"mode":"build"}'), time_created(ms), time_updated(ms), time_compacting, time_archived, task_type, title_source, title_message_id, time_title_updated, trace_id, time_deleted, last_outcome
- message：id('msg_<rand10>_<uuid4>'), session_id, time_created(ms), time_updated(ms), data(JSON), sequence(0..n 会话内递增)
  - data.assistant：`{role:'assistant', time:{created,completed}, parentID:<上一条msg id>, modelID:'GLM-5.3-Flash', providerId, mode:'yolo', agent:'zcode-agent', path:{cwd,root}, cost:0, tokens:{...}, finish:'stop', semantics}`
  - data.user：`{role:'user', time:{created}, agent:'zcode-agent', model:{providerID,modelID,variant:'max'}, contextSnapshot:{envInfo:{cwd,platform,shell,...}}, semantics, anchor, tools, metadata, modelSelection}`
  - 链：user 首条 parentID=None；assistant parentID=前一条 message id
- part：id('part_<rand10>_<uuid4>'，timeline 类为 'part_<msgid派生>_timeline'), message_id, session_id, time_created, time_updated, data(JSON), sequence(消息内 0..n)
  - data 类型 histogram（实测）：text 3321 / step-start 4434 / reasoning 2906 / tool 4904 / step-finish 4281 / timeline 118 / compaction 20 / file 16
  - text：`{type:'text', text, time:{start,end}}`
  - reasoning：`{type:'reasoning', text, time}`（ZCode 思考是明文！全量迁移无损失）
  - tool：`{type:'tool', callID:'call_<hex>', tool:'Bash', state:{status:'completed', input:{...}, output:'<完整输出>', title:'Bash', metadata:{...}}}` — 调用+结果在一个 part 里
  - compaction：压缩标记；timeline：模型切换等 UI 事件；step-start/step-finish：步骤边界（写时跳过）
- session_input：id('queue_<uuid>'), kind('sendText'355/'compact'/'sendGoalCommand'/'backgroundNotification'), delivery('startNow'), payload(JSON {text, intent:{sourceCommandId,queueItemId,clientId}}), admitted_sequence, promoted_sequence, promoted_message_id, status, time_created/updated
- FK 定义了但默认不强制（PRAGMA foreign_keys=0 per-connection）；写副本验证即可
- **写入器策略**：INSERT session + message + part（+session_input），全部 id 重新生成，parentID 链重连；先在 db 副本上验证，真实写前自动备份三件套（db/-wal/-shm）

## 4. WorkBuddy（腾讯）
- 本机：`~/.workbuddy/`（connectors/device-id/logs）、AppData Roaming 'WorkBuddy AI'（空）、AppData Local workbuddy-ai（空）→ 桌面端已装未产生会话
- 官方无导出；会话存 SQLite（第三方 workbuddy-account-migrate 证实，按 user_id 键控）；工作区 `C:\Users\<u>\workbuddy`
- v1 只做探测 + "0 会话" 展示，适配器 M5

## 5. ARX v1 中间格式（内部沿用 MSX 代码名）（本项目真源）
```
{
  arx: 1, id: <新uuid>, created_at: ISO,
  source: {agent:'claude-code'|'codex'|'zcode'|'workbuddy', agent_version, session_id, title, file},
  project: {cwd, gitBranch?},
  env: {model?, provider?, cli_version?, instructions?},
  stats: {entries, userTurns, toolCalls, approxTokens, recordedTokens?},
  entries: [{ id?, ts?, role:'user'|'assistant'|'system'|'meta',
              kind:'text'|'tool-result'|'compaction'|'note',
              blocks:[{type:'text',text}|{type:'thinking',text,signed?}|{type:'tool_use',id,name,input}|
                      {type:'tool_result',for,output,isError?,truncated?}|{type:'image',mediaType,data?}],
              meta:{model?, usage?} }],
  compactions: [{ts?, message}],
  loss: [string]
}
```
- 映射：claude tool_use(id,name,input) ↔ codex function_call(name,arguments,call_id) ↔ zcode part.tool(callID,tool,state.input)
- claude tool_result(tool_use_id,content) ↔ codex function_call_output(call_id,output) ↔ zcode tool part 的 state.output（拆成独立 tool-result entry）
- zcode reasoning 明文 ↔ claude thinking(签名置空) ↔ codex reasoning.summary_text（encrypted_content 不可迁移→loss）
- turn 边界 = role user & kind text 的 entry；选择器以 entry 为粒度

## 6. 其他本机事实
- Codex threads.cwd 用扩展路径前缀 `\\?\`；ZCode time 全是毫秒；Claude/Codex 时间 ISO UTC
- ~/.claude/sessions/ses_*.jsonl 是另一种文件（非 projects 会话，忽略）
- Codex `~/.claude/history.jsonl`、`~/.codex/history.jsonl` 存在（prompt 历史，v1 不用）
- ZCode db 里 `model_usage`/`turn_usage` 有真实 token 统计可用于展示

## 7. VS Code Copilot（内置 Chat/Agent，只读源）

- 位置：`%APPDATA%/Code/User/workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/<uuid>.jsonl`（macOS ~/Library/Application Support/Code、Linux ~/.config/Code）
- workspace 真实路径：同级 `workspace.json` 的 `folder`/`workspace` 字段，file:/// URI（如 file:///c%3A/demo/app → c:/demo/app）
- 行结构：`{id, timestamp(ISO), parentId, type, data}`
  - `session.start`：data.{sessionId, producer:'copilot-agent', copilotVersion, vscodeVersion, startTime}
  - `user.message`：data.{content(字符串), attachments[]}——正文即 content
  - `assistant.message`：data.{messageId, content(markdown)}
  - `tool.execution_start`：data.{toolCallId, toolName, arguments}
  - `tool.execution_complete`：data.{toolCallId, success}——**没有工具输出**，只存成功/失败标志
  - `assistant.turn_start/turn_end`：轮次标记，无内容
- 注意：
  - 老格式 `session_start`（下划线）出现在 debug-logs/ 下，是遥测 span（{v,ts,dur,sid,attrs}），不是会话内容
  - 会话 id = session.start.data.sessionId（与文件名 uuid 一致）
  - Workspace 移动/改名会换 hash 目录，旧历史仍在旧 hash 下（VS Code 已知行为）
- 适配器：server/core/vscode.js（只读源；T2 可作为目标）

## 8. 2026-11-04 新增原生写入器（T1/T0 全覆盖）

所有写入器逐字段镜像各自读取端；只新建文件/行，绝不修改源存储（sandbox-test 断言源 mtime 不变）。

### Gemini CLI 写入 — server/core/gemini.js
- 落盘 `~/.gemini/tmp/<slug>/chats/session-<YYYY-MM-DDTHH-MM>-<id8>.jsonl`
- 行1 meta `{sessionId, projectHash, startTime, lastUpdated, kind:'main', summary}`；消息 MessageRecord
- toolCalls 内联在 gemini 记录上：`{id:'<name>__<callid>', name, args, result, status, timestamp, displayName}`
- thinking → `thoughts:[{subject:'', description, timestamp}]`；meta 条目 → `type:'info'`
- slug 解析：扫 `tmp/*/.project_root` 匹配 cwd → projects.json 映射 → 兜底 sha256(cwd)；新建 slug 目录时写 .project_root
- 风险：`general.sessionRetention` 默认 30d 自动清理；projectHash 推断错误时会话不出现在 /resume

### Pi 写入 — server/core/pi.js
- `~/.pi/agent/sessions/<编码cwd>/<Date.now()>_<id8>.jsonl`
- 行1 `{type:'session', version:3, id, timestamp, cwd}`；message 行 `{type:'message', id(8hex), parentId(线性链), timestamp, message:{role, content, model?}}`
- 块映射：text/{type:'text',text}；thinking/{type:'thinking',thinking}；toolCall/{type:'toolCall',id,name,arguments(对象)}；结果独立 role:'toolResult' 行 {toolCallId, content:[{type:'text',text}], isError}

### OpenClaw 写入 — server/core/openclaw.js
- `~/.openclaw/agents/<agent>/sessions/<uuid>.jsonl`（agent 子目录：显式 > 最近活跃 > 'main'）
- 首行 message 携带 id/cwd/timestamp（读取端以首行 id 为会话 id）；仅当首条为用户消息时复用，否则插入导入标记行（保持逐字顺序）

### DSH 写入 — server/core/dsh.js
- `~/.dsh/sessions/--<cwd编码>--/<uuid>/session.jsonl.zstd`（Node≥24 `zlib.zstdCompressSync`；单帧即可，读取端按魔数分帧）
- 行1 `{type:'session', id, cwd, createdAt, version}` + `{seq:0, type:'session/title'}`；事件 `{seq, time, type:'user/message'|'assistant/message'|'tool/call'|'tool/result', data}`

### VS Code Copilot 写入 — server/core/vscode.js
- `<hash>/GitHub.copilot-chat/transcripts/<uuid>.jsonl`；hash 必须已存在（扫 workspace.json 匹配 cwd，不造 hash）
- 行事件链 session.start → user.message/assistant.message/tool.execution_start/complete
- 工具输出写非标字段 `tool.execution_complete.data.output`（官方不读，仅备未来/人工追溯）；thinking/image 无对应事件类型 → loss

### Cursor 适配器（新）— server/core/cursor.js（实验性）
- 读：globalStorage `state.vscdb` 的 `cursorDiskKV` 表
  - Gen B：`composerData:<cid>`（fullConversationHeadersOnly）+ `bubbleId:<cid>:<bid>`（type 1=user 2=assistant；toolFormerData{name,params,rawArgs,result,status,toolCallId}，**工具输出持久化**）
  - Gen C：`composerHeaders` 表（History 驱动）+ `composerConvHeaders:<cid>:<NNNNNN>` 分块头
  - Gen A 残留：workspaceStorage ItemTable `workbench.panel.aichat.view.aichat.chatdata`
  - cwd：composerHeaders.workspaceId → workspaceStorage/<hash>/workspace.json file:/// URI
- 写（T1）：INSERT composerData:* + bubbleId:*（toolFormerData.result 内联）+ composerHeaders 行（表存在时）+ workspace ItemTable `composer.composerData` 追加（仅键已存在时）
- 风险：schema 未公开、版本漂移；**Cursor 必须完全退出**（内存态退出回写可覆盖外部写入）；全局库可能数 GB → 只 VACUUM 快照工作区小库（全局库写入是纯 INSERT 新键）

### 能力单一事实源
- agents.js META `cap: {t0, t1}` → instanceSummary 携带 → /api/agents → GUI targetAdvice/recommendMode（已删 workbuddy 写死 T2 的 bug）
- transfer.js T0/T1 通用派发：adapter.rawCopy / adapter.writeSession 存在即支持

### 跨设备 bundle — server/core/bundle.js
- `.arxbundle` = `{"arxBundle":1,"version":1,"created_at","source_app","sessions":[<ARX>...]}`，流式写、流式扫读（逐字符状态机：i/depth 跨 chunk 持久 + 每轮裁剪已消费前缀）
- API：POST /api/bundle/export|inspect|import；CLI：`bundle` / `import-bundle --remap 旧=新`
- remapCwd：路径段感知前缀替换（D:/work → /Users/x/work，不误伤 D:/worker）

### 8.1 审核修复（2026-11-04 第 1 轮 subagent 审核：0 P0 / 4 P1 / 8 P2 / 若干 P3，全部修复）
- bundle 扫描器：1MB 块边界切多字节字符会产生 U+FFFD 静默损坏 → StringDecoder 跨块续解码（沙盒测试：0.8M CJK 逐字比对）
- Cursor 写入：一 assistant 条目多个 tool_use 只留最后一个 → 一调用一 bubble（并行调用不再丢失）
- bundle 导入：历史导出的 agent 别名 `claude-code`/`vscode-copilot` 归一（canonicalAgent），否则 T0 同源判断失败
- exportBundle 失败路径：rename 移到成功路径、失败清理 tmp 并 await done（不再残留半截合法文件）
- GUI 导入复选框接通：importBundle 增 `only:[下标]`；导入改逐会话循环（实时进度 + 结果增量渲染）
- relay T0 预选走 targetAdvice（cap 感知）：cursor/workbuddy 自接力不再误选 T0
- cli.js 可重复 flag（--from/--to/--remap）累积数组；import-bundle 加 --mode
- 用户/元条目里的图片块丢失记入 loss（5 个写入器）；gemini/cursor 工具失败状态不再扁平化为 success
- openclaw readSession 补 cwd（首行携带）；DSH 无 zstd 时 cap 降级为 T2-only（agents.js 注册时探测）
- dry-run 新增声明性损失（DECLARED_LOSS）：写入器级已知损失在预览时提前告知
- transfer 目标支持 baseDir 覆盖（t.baseDir → targetBaseDir，实例优先）——沙盒导入不落真实目录
- 其它：T0 loss 合并不覆盖、hashForCwd 备忘录、cursor LIKE 通配符转义、cursor 无时间戳 loss 声明、
  readSync 短读守卫、/api/instances 与 mcp list_agents 携带 cap、dsh 伪魔数帧失败记 loss、
  fidelity.omitted → lossNotes（语义：去重说明条数）、README 备份措辞收窄、VERIFICATION.json 清理

### 8.2 第 2/3 轮审核（收敛确认）
- 第 2 轮（验证 15 项修复 + 回归猎捕）：15/15 修复确认、无回归；另发现 1 P2 + 6 P3 + 6 P4，全部修复：
  bundle 导入 T0 强制降级 T1（rawCopy 依赖源文件在本机，跨设备必然失败，同源时 T1 写入器等价）；
  scanBundleRaw 严格 UTF-8 校验（无效字节报错而非静默 U+FFFD）+ EOF 冲洗；导出 async 落盘失败清理 tmp；
  manifest 逐键拷贝防 __proto__ 投毒；cursor LIKE 参数绑定 + memo 只缓存命中 + errStatus 计缺失；
  openclaw meta 说明；dsh rawCopy sink + 文案；instancesForSettings 自定义行带 cap；backupFiles 支持 .vscdb；
  README 中英 DSH zstd 前提 + 备份措辞对齐；cli --mode；sandbox 别名测试补 mode:'T0'。
- 第 3 轮（收敛确认）：0 P0/P1/P2/P3，5 P4（3 个顺手修：EOF 冲洗、fd 泄漏保护、死变量；2 个记录在案：
  pi.js Object.assign 头部解析为既有局部对象赋值、dsh rawCopy 双重解压纯性能）。
- 最终判定：**CONVERGED**。三轮累计修复 4 P1 / 9 P2 / 14 P3 / 若干 P4；沙盒测试/mcp-verify/e2e 全绿。

### 8.3 Trae 逆向侦察（2026-11-04，判定：暂不可行）
- 存储定位：`%APPDATA%/Trae{,/ CN}/ModularData/ai-agent/database.db`（+wal；CN 版 628MB）＝ AI 会话正文。
  本机装了国际版与 CN 版（workspaceStorage 的 state.vscdb 是明文 ItemTable，但只有 draft:session:<sid>:code
  草稿、会话 id 索引（all_session_badges_<oid>，Mongo ObjectId 形态）、模式/模型映射，无正文）。
- 加密：SQLCipher 确认——ai_agent.dll 内嵌 codec（PRAGMA cipher_* 全族，sqlcipher ×9）；Rust 日志
  `ai_agent::infrastructure::dal::connection`: "[DB] not encrypted, encrypting..." → "Database is already encrypted"。
- 密钥：首跑在 Rust 侧生成/派生；全盘排查无明文（无 DPAPI/注册表/Electron JS 传递；DLL 内 passphrase 字符串
  均为捆绑的 OpenSSL TLS 样板）。提取需逆向 281MB Rust 二进制；即使解出还需 SQLCipher 兼容写 + 未知 schema。
- 结论：保持 README "on hold: SQLCipher-encrypted" 且现在有了实证细节；Trae 作为目标可用 T2（通用通道）。

### 8.4 unslop UI 润色（按 C:\InstallPack\unslop skill，polish 模式）
- 审计（signs.md 全组过一遍）：字重全部 ≤600 ✓、无 emoji/感叹号 ✓、负字距仅展示级标题 ✓、
  无渐变文字/光晕/色块 ✓、Geist 字体是有意选择的品牌资产 ✓ → 判定轻度，只修审计所见。
- 修复：① 顶栏状态点移除无限 pulse 循环动画（静态点保留含义，符合"无理由循环动画移除"）；
  ② 全局 font-variant-numeric: tabular-nums（计数/百分比/表格数字统一等宽对齐）；
  ③ 侧栏 agent 卡与设置页实例表的存储路径改单行省略号（卡高统一；完整路径在 title/侧栏卡片 title 里）。
- 加载 spinner / 骨架 shimmer 属于"解释状态"的必要动效，保留。

### 8.5 第二批功能（2026-11-04 上午，用户晨会需求）
1. 角色标签：tool_result 条目在详情/预览显示"工具结果"而非"用户"（claude/codex 把工具结果记在 user 名下）。
2. 重复迁移清理：以 ~/.agentrelay/log.jsonl 的 transfer 记录为准（只删目标侧、源侧全保护），文件移入
   ~/.agentrelay/backups/cleanup-*，SQLite 先 VACUUM 快照；content-identical 指纹兜底无日志的旧副本。
3. zcode 子会话：session.parent_id → listSessions 发 parentId/sub 字段；/api/sessions?parent= 过滤；
   详情页懒加载"子会话"折叠区。
4. 会话上下文编辑器：msx.applySessionEdits（删/改/插 + enforceToolPairing 收敛 + kind/role 归一化——
   tool-result/note 改写后一律变用户文本，否则写入器丢内容）；claude.saveSessionInPlace（writeSession 同 id
   原子重写）；zcode.saveSessionInPlace（临时会话 + FK-OFF 换名交换 + 行数自校验）；/api/session/save
   （mode: new=全部 agent / inplace=claude,zcode）；生效时机按 agent 在响应 note 里如实说明。
5. 插入支持：用户/助手/工具对（名+参数JSON+---+结果）/ 粘贴 ARX 片段批量跨 agent 合并。
6. 自动加载开关：config.autoLoadSessions（默认开），关→启动不扫描、点 agent 按需扫；停用 agent 本就不扫。
7. 查重：/api/session/dups 按 标题+msgCount+cwd 跨实例分组（子会话/fork 不参与），GUI 弹窗跳转。
- 事故记录：调试时误对真实库的一个运行中子会话就地编辑（测试脚本漏传 baseDir）——该会话当时未落库任何
  消息（快照证实 0 条），无内容损失；运行后已清理残留临时行。教训：沙盒测试必须显式传 baseDir。

### 8.6 第 4 轮审核修复（编辑器批次：1 P1 + 2 P2 + 8 P3 + 5 P4 全部修复）
- P1 claude 就地保存 slug 错位：writeSession 按 cwd 重算目录，两代 slug 并存时写错位置 → 产物搬回原位 + 清误建文件（沙盒含错位用例）
- P2 工具对插入拆散 → 调用/结果同锚点逆序插入保持相邻（claude resume 要求相邻）；zcode 自检移到 COMMIT 前（失败即回滚，不再谎称已回滚）
- P3：插入条目 meta/system 归一化 + id 去重；save 响应透出 writer loss 并在 toast 显示；孤儿锚点/失效 id 记 loss；
  zcode 交换连接 busy_timeout + 崩溃残留 sess_relaytmp 清扫 + slug/time_updated 保留；接力页 chip 按需加载；
  沙盒测试补编辑器全链路；清理脚本 mtime 命中加首条用户消息核验 + 指纹不再剥离时间戳
- P4：ctx-search 160ms 防抖；.dup-group/.dup-row 样式；渲染上限改为已加载全量；插入 id 去重；README 编辑器三条如实说明

### 8.7 第二批晨会反馈（9 条）+ 第 5-8 轮审核收尾（2026-11-05）
- 新功能：接力来源批量全选/全不选（batch-bar 吸顶）；bundle 锚点按钮；会话列表子代理树形折叠（fork 平铺+徽标，
  sess_subagent_* 折叠——fork 语义教训：parent_id 是 fork 来源不是层级）；列表/详情拖拽调宽（delta 数学+持久化）；
  预览内搜索行（放大镜+高亮+计数+全选/全不选）；自动加载开关+持久缓存快启动+后台静默刷新；toast 移顶部；
  编辑模式状态可见化（按钮文案+主色+边框+momentum 门控）；hygiene.js（log 5MB 字节级截尾/exports 50 限量）；
  背景壁纸即时持久化；搜索放大镜 ×3；详情工具区压缩。
- 重大修复：主会话 3294 条全量渲染 OOM → 窗口式渲染（400 条/屏 + 前/后翻页，DOM 恒定）；
  claude 就地保存 slug 错位双副本；zcode FK 交换顺序；resizer delta 数学（原实现拖 100px 反而缩到 300）；
  rotateLog 字节级截尾；缓存快路径后台静默刷新。
- 第 5-8 轮审核累计：0 P0 / 5 P1 / 13 P2 / 30+ P3 / 若干 P4 全部修复；最终判定 SHIP + CONVERGED。
