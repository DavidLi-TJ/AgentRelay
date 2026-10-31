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
- **`~/.codex/state_5.sqlite` 表 `threads`**（56 行=56 rollout）：列 `id, rollout_path, created_at(unix秒), updated_at, source:'cli', model_provider, cwd(**'\\?\C:\demopp'** 扩展前缀), title, sandbox_policy(JSON), approval_mode, tokens_used, has_user_event, archived, git_sha/branch/origin_url, cli_version, first_user_message, agent_nickname/role, memory_mode, model, reasoning_effort, agent_path, created_at_ms, updated_at_ms, thread_source, preview, recency_at, recency_at_ms, history_mode, name, is_pinned, thread_section_id, section_position, section_entered_at_ms, project_id, originator, daybreak_enabled`
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
