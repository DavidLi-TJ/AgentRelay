<div align="center">

<img src="docs/assets/logo.svg" width="56" alt="AgentRelay">

# AgentRelay

**Move a half-finished coding session from one AI agent to another — the whole session, not a summary of it.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE) [![Node](https://img.shields.io/badge/node-%E2%89%A522.5-brightgreen.svg?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org) [![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg?style=flat-square)](#quick-start) [![npm dependencies](https://img.shields.io/badge/npm%20dependencies-0-success.svg?style=flat-square)](#quick-start)

English ｜ [简体中文](README.zh-CN.md) · [Quick start](#quick-start) · [Support matrix](#support-matrix) · [Relay tiers](#three-ways-to-relay) · [FAQ](#faq)

<img src="docs/assets/gui-overview.png" alt="AgentRelay main view" width="860">

</div>

## The problem

You spend three hours in Claude Code. The task is half done and the agent finally knows every quirk of the codebase. Then you hit a usage cap, or you just want Codex to take over. What happens to the session? A copy-pasted summary loses the tool calls, the error output, and the exact state of the work. Starting over throws away the whole afternoon.

AgentRelay moves the session itself. Every message, tool call, tool result, and thinking block is read from the source agent's local storage and written into the target agent's native store, so its own resume command picks the session up as if it had always been there.

Nothing is summarized, nothing is uploaded, and there is nothing to install — the app is a handful of JavaScript files run by the Node.js you already have.

One more thing worth saying plainly: everything above happens in a browser page. The other tools in this space — ccusage, claude-code-history-viewer, the various handoff scripts — are terminal commands you run, with flags to memorize and JSON to squint at. AgentRelay gives the same job a real interface: agents as cards, sessions as a list you can search, the conversation laid out with checkboxes. If you can use a web app, you can relay a session. The CLI and MCP interfaces exist, but they are optional doors, not the front door.

## What it does

- **One page for every session.** Nine agents (Claude Code, Codex CLI, ZCode, WorkBuddy, OpenCode, DeepSeek Harness, Gemini CLI, Pi, OpenClaw), browsable, filterable, and full-text searchable, with verbatim preview on the right.
- **Carry only what you want.** Check entries one by one, or set the stage with toggles for thinking blocks, tool results, and system injections, a from-entry offset, a token cap, and regex-based secret redaction.
- **Write into the target, not at it.** Relay synthesizes the target agent's own session format and registers it, so `claude --resume` / `codex resume` / the desktop session list just works.
- **Back up first, always.** A consistent SQLite snapshot (`VACUUM INTO`) is taken before any write. Twenty are kept, and the Diagnostics page restores any of them.
- **Relay from inside an agent.** A stdio MCP server exposes six tools, so Claude or Codex can hand a session to another agent while you talk to it.

<div align="center">
<img src="docs/assets/detail-preview.png" alt="Verbatim preview with per-entry checkboxes" width="720">
</div>

## Quick start

Windows 10/11, Node.js 22.5 or newer (for the built-in `node:sqlite` module). No `npm install` — there are no dependencies to install.

**Double-click `StartAgentRelay.bat`.** That is the whole setup. A browser window opens at `http://127.0.0.1:17777`.

The first-run wizard detects which agents you have and shows a live session count for each. From here everything is point-and-click:

1. **Sessions page** — pick an agent on the left rail, type in the search box, click a session. The right pane shows the full conversation verbatim: text, tool calls with their inputs and outputs, thinking blocks.
2. **Choose what to carry** — the bar above the preview holds the switches: thinking, tool results, system injections, redaction, a start offset, tool-output truncation, and a token cap. The cap takes presets: **1M / 512K / 200K**, or any number. If the session has been compacted, **From last compact** starts the relay at the newest compaction boundary — what you get on the other side matches what the source agent still has in its head.
3. **Relay page** — pick the source sessions, click a target agent card, pick the relay tier (a badge marks the recommended one and explains why), set the target project folder with the folder browser, then click **Dry-run**.
4. **Dry-run** walks the entire pipeline without writing anything and reports the path it would write, the entry count, the token estimate, and every conversion note. Read it, then click **Start relay**. A confirmation appears, the backup runs, and the result panel hands you the resume command.

That is the whole workflow. The CLI (`node cli.js ...`) and the MCP server exist for scripting and for agents, but nothing in the daily loop requires a terminal.

<div align="center">
<img src="docs/assets/relay-view.png" alt="Relay wizard with tier recommendation" width="720">
</div>

## Three ways to relay

| Tier | What it does | Fidelity |
|---|---|---|
| **T0 · same-agent copy** | Native copy inside one agent with a new session id, rebuilt message chain, rewritten cwd. For Claude→Claude, Codex→Codex, ZCode→ZCode. | 100%, `resume` continues directly |
| **T1 · native injection** | Synthesizes the target agent's own session format, writes it into the target's storage, and registers it. | Structurally equivalent, verbatim |
| **T2 · verbatim transcript** | Writes the full session as a structured transcript into the target project plus a kickoff prompt for a new session. | Content 100% verbatim |

Which tier for which target? The app marks it on the relay page, and the short version is:

- Same agent → **T0**. There is no reason to use anything else.
- Claude Code, Codex CLI, ZCode, WorkBuddy, or OpenCode as target → **T1**, the default. Native injection; resume or the session list picks it up.
- DeepSeek Harness, Gemini CLI, Pi, or OpenClaw as target → **T2**. There is no native writer for these yet, so the transcript is the only channel.

Cross-agent relays cannot replay thinking-block signatures (that requires the vendor's private key), so signatures are kept as plain text and noted in the `loss[]` manifest. T0 has no loss.

## Support matrix

| Agent | Local storage | As source | As target | Resume |
|---|---|---|---|---|
| Claude Code | `~/.claude/projects/` | ✓ | T0 / T1 / T2 | `claude --resume` |
| Codex CLI | `~/.codex/sessions/` + `state_5.sqlite` | ✓ | T0 / T1 / T2 | `codex resume` |
| ZCode | `~/.zcode/cli/db/db.sqlite` | ✓ | T0 / T1 / T2 | Desktop session list |
| WorkBuddy | `~/.workbuddy-ai/workbuddy.db` | ✓ | T1 / T2 | Desktop session list |
| OpenCode | `~/.local/share/opencode/opencode.db` | ✓ | T1 / T2 | Session list |
| DeepSeek Harness | `~/.dsh/sessions/` (multi-frame zstd) | ✓ | T2 | Kickoff prompt |
| Gemini CLI (experimental) | `~/.gemini/tmp/*/chats/` | ✓ | T2 | Kickoff prompt |
| Pi / OpenClaw (experimental) | JSONL | ✓ | T2 | Kickoff prompt |

Experimental adapters are implemented from the official source schemas and pass synthetic-sample tests; Trae is on hold because its session database is SQLCipher-encrypted. Several instances of the same agent (say, two Claude config directories) can be added in Settings.

## Selective loading, compaction, and big sessions

Selection runs on a unified intermediate format (ARX) that keeps every entry verbatim, so filtering never rewrites content. Tool calls stay paired with their results even after aggressive filtering, which is what keeps the target agent's resume from choking.

Large sessions open instantly because the preview pages through (200 entries first, more on demand) while stats are computed server-side. A token cap degrades oldest-first until the payload fits, so a 2M-token monster becomes a 1M-token payload with one click.

## MCP

Register once, then relay conversationally:

```bash
claude mcp add agentrelay -- node C:\path\to\agentrelay\cli.js mcp
```

Six tools: `list_agents`, `list_sessions`, `get_session`, `preview_transfer`, `transfer`, `doctor`. `transfer` is dry-run unless you pass `confirm: true`. Details in [docs/MCP.md](docs/MCP.md).

## Safety

Any write that could overwrite existing data is preceded by a backup: a consistent SQLite snapshot via `VACUUM INTO` (file stores are copied as-is), the last 20 kept under the backup root shown on the Diagnostics page, one click to restore. T0 and T1 into a database target and every OpenCode/WorkBuddy/Codex/ZCode write get this snapshot; relays that only create brand-new files (T2 transcripts, first-time writes into an empty Claude project folder) don't need one. Database writes run in transactions and roll back on failure; file writes land through temp-file-plus-rename and never touch the source session. The MCP channel stays dry-run without an explicit `confirm: true`. The local server checks the Host header, accepts only JSON POSTs, and caps request bodies at 64 MB. There is no telemetry and no network call of any kind unless you turn on the update check.

## Where your data lives

The app keeps its own files in `~/.agentrelay` — config, backups, exports, cache, logs. Change the folder in Settings if you prefer somewhere else. The sessions themselves always stay in each agent's own storage; AgentRelay reads them and writes to them, but never moves or owns them.

## FAQ

<details>
<summary>Does my session data leave my machine?</summary>
No. Reads and writes stay on your disk. The only optional network request is the update check you enable in Settings.
</details>

<details>
<summary>Can a relay corrupt my existing sessions?</summary>
The backup runs first, writes are transactional or atomic, and the Diagnostics page restores any of the last 20 backups.
</details>

<details>
<summary>Will the target agent actually accept the session?</summary>
T0 is a native copy, so resume just works. T1 is written into the target's native store and registered. T2 hands the target a verbatim transcript plus a kickoff prompt. All three were verified against real agent storage on Windows (real sessions, real resume).
</details>

<details>
<summary>Original text or a summary?</summary>
Original text. ARX keeps every message, tool call, and result verbatim; your selections decide what to carry, never what to rewrite.
</details>

<details>
<summary>How is this different from ccusage or claude-code-history-viewer?</summary>
Those answer "what happened in my sessions". AgentRelay answers "continue this session somewhere else".
</details>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=DavidLi-TJ/AgentRelay&type=Date)](https://star-history.com/#DavidLi-TJ/AgentRelay&Date)

## Development

```text
server/core/    storage adapters, ARX format, selector, relay orchestration
server/public/  web GUI (vanilla JS, no build step)
scripts/        sandbox-test.js · e2e.js
docs/           format-notes.md · MCP.md
```

```bash
node scripts/sandbox-test.js
```

## License

[MIT](LICENSE)

Issues and pull requests are welcome — bug reports with a diagnostic bundle (Diagnostics page → Export) are the fastest way to get something fixed.
