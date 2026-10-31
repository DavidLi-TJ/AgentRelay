# AgentRelay MCP 接口

让 agent（Claude Code / Codex / ZCode / Gemini CLI 等）**在自己的会话里直接调用 AgentRelay** 完成接力——
你只需要对 agent 说："把我在 ZCode 里的那个因子回测会话接力给 Codex"。

## 工具一览

| 工具 | 说明 | 写入风险 |
|---|---|---|
| `list_agents` | 列出本机检测到的 agent 实例与存储路径 | 无 |
| `list_sessions` | 列出会话（可按关键词过滤） | 无 |
| `get_session` | 读取会话逐字内容（预览） | 无 |
| `preview_transfer` | **Dry-run**：预演接力将写入什么 | 无 |
| `transfer` | 执行接力；**`confirm:true` 才真正写入**，否则自动降级为 dry-run | 有（需显式确认） |
| `doctor` | 存储诊断 | 无 |

安全设计：写入必须显式 `confirm: true`；所有 MCP 调用写入操作日志（info 级）。

## 注册到各 agent

**Claude Code**（任选其一）：
```bash
claude mcp add agentrelay -- node C:\path\to\AgentRelay\server\mcp.js
```
或项目 `.mcp.json`：
```json
{ "mcpServers": { "agentrelay": { "command": "node", "args": ["C:\\path\\to\\AgentRelay\\server\\mcp.js"] } } }
```

**Codex CLI**（`~/.codex/config.toml`）：
```toml
[mcp_servers.agentrelay]
command = "node"
args = ["C:\\path\\to\\AgentRelay\\server\\mcp.js"]
```

**ZCode**（`~/.zcode/cli/config.json` → `mcpServers`）：
```json
{ "mcpServers": { "agentrelay": { "command": "node", "args": ["C:\\path\\to\\AgentRelay\\server\\mcp.js"] } } }
```

**Gemini CLI**（`~/.gemini/settings.json` → `mcpServers`）：
```json
{ "mcpServers": { "agentrelay": { "command": "node", "args": ["C:\\path\\to\\AgentRelay\\server\\mcp.js"] } } }
```

## 使用示例（agent 内对话）

> "用 agentrelay 列出我的 zcode 会话"
> "把这个会话接力给 codex，项目目录 C:\path\to\my-project，先 dry-run"
> "确认执行（confirm=true）"

## 手动测试

```bash
echo {"jsonrpc":"2.0","id":1,"method":"tools/list"} | node server/mcp.js
node cli.js mcp   # 同效
```
