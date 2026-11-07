# AgentRelay User Guide

A walkthrough of every screen and every action, in the order you'll actually use them. For the architecture and format details, see [format-notes.md](format-notes.md); for the MCP tools, see [MCP.md](MCP.md).

简体中文：[USER-GUIDE.zh-CN.md](USER-GUIDE.zh-CN.md)

---

## 1. Install and launch

You need **Windows 10/11** (macOS/Linux should work, not yet fully tested) and **Node.js 22.5+** (for the built-in `node:sqlite`). There is nothing to install — no `npm install`, no dependencies, no build step.

Three ways to start:

```bash
npx github:DavidLi-TJ/AgentRelay serve        # one-off, no clone needed
# or, after cloning:
node server/index.js                          # or double-click StartAgentRelay.bat
```

A browser window opens at `http://127.0.0.1:17777`. The server listens on localhost only. If the port is taken, set `AGENTRELAY_PORT=17778` (or any free port) and start again.

The top bar holds: the server status dot, the 中/EN language toggle, the theme toggle, a **refresh** button (clears the session-list cache and rescans every agent), and the **power** button (shuts the server down cleanly).

## 2. First run

A small wizard asks for three things: language, theme, and the **data directory** — `~/.agentrelay` by default. That folder holds AgentRelay's own files (config, backups, exports, cache, logs). Your sessions never live there; they always stay in each agent's own storage.

After the wizard, AgentRelay detects which agents exist on the machine and shows a live session count for each. Agents that are disabled in Settings are never scanned at all.

## 3. Sessions view

This is the home screen: **agent rail on the left, session list in the middle, verbatim preview on the right.**

- **Agent rail** — one card per agent with its session count. Click a card to browse that agent. Drag the thin handle between the list and the preview to resize the columns.
- **Search box** — filters titles and project paths as you type; press **Enter** for a full-text search across the session bodies.
- **查重 / Duplicates** — groups sessions with the same title, size, and project across *all* agents (migration testing tends to leave copies behind). One click jumps to each copy.
- **Preview** — the full conversation, verbatim: user and assistant text, tool calls with their inputs and results, thinking blocks, system injections. Big sessions page through ~400 entries at a time — use **previous / next 400** to walk the whole thing; nothing is loaded into the page until you ask.

In the preview you can:

- **Search inside** — the search field above the preview highlights matches and shows how many hits the current page has.
- **Check entries** — tick the checkbox on any entry (or use select-all / select-none in the selection bar). Whatever is checked is exactly what the relay will carry.
- **Export** — **Export MD** renders the session as a verbatim Markdown transcript (your selection and redaction apply; tool calls and thinking render as fenced/collapsible blocks); **Export ARX** writes the structured JSON intermediate for backup or re-loading later.
- **Tune the selection** — the bar above the preview holds the switches: include thinking / tool results / system injections, secret redaction, a from-entry offset, tool-output truncation (KB), a token cap with **1M / 512K / 200K** presets, and **From last compact** — start the relay at the newest compaction boundary, so the target receives what the source agent still has in its head.
- **Browse sub-agent sessions** — sessions that spawned subagents (currently ZCode) show them collapsed under the parent header; expand to read them, the box scrolls if there are many.

**Fast startup, on your terms.** Settings → *"Auto-load session lists on startup"*. On: every agent is scanned when the page opens. Off: the page opens instantly, and each agent is scanned the first time you click it. Either way, the last known list is cached locally (24 h) and shown immediately, then quietly refreshed in the background. The **refresh** button in the top bar throws the cache away and does a full rescan.

## 4. Editing context

Sessions drift: an agent loops on "let me do it", a tool result pollutes everything after it, one wrong turn poisons the rest. Open a session and click **Edit mode** in the preview header.

What you can do:

- **Filter entries** by keyword to find the junk fast.
- **Delete** entries; **rewrite** any entry's text in place.
- **Insert** new entries: a user message, an assistant message, a complete tool-call pair (kept adjacent — see caveat below), or **paste an exported ARX fragment** from another agent to batch-merge whole stretches of context.
- **Copy** any entry verbatim (for pasting into docs, tickets, or another agent).
- Batch-select, then delete or act on everything selected at once.

Saving offers two modes:

| Mode | Who | What happens |
|---|---|---|
| **Save as new session** | every agent | Writes a brand-new session in that agent's storage. The original is untouched. |
| **Save in place** | Claude Code and ZCode | Overwrites the session in its own storage. A backup is taken first (Diagnostics page can restore it). Takes effect the next time that agent opens the session. |

Honest caveats, so nothing surprises you:

- The editor reaches the **first 400 loaded entries**; click *next 400* to bring further ones into reach before editing them.
- A `tool_result` far away from its `tool_use` can make `claude --resume` fail. The editor keeps pasted tool pairs adjacent for exactly this reason — don't delete one half of a pair.
- An in-place Claude save re-synthesizes the transcript, so sidechain/system-injection lines the format cannot round-trip are dropped. The automatic backup is the recovery path.
- Editing always happens because **you** clicked it. Relays never modify a source session.

## 5. Relay view — the main event

Three steps: **source → target → execute.**

1. **Source.** The sessions you checked on the Sessions page are already staged here. Adjust the checklist if needed.
2. **Target.** Click a target agent card. A badge marks the **recommended relay tier** and explains why. Then pick the **target project folder** with the folder browser — the relayed session will be bound to that project, which is what makes it resumable there.
3. **Execute.** Click **Dry-run** first. It walks the entire pipeline without writing anything and reports: the exact path it would write, the entry count, the token estimate, and every conversion note. Read it, then click **Start relay**. AgentRelay confirms, takes the backup, writes, and hands you the resume command for the target agent.

The three tiers, briefly:

| Tier | Used when | Meaning |
|---|---|---|
| **T0** | same agent → itself | Native copy with a new session id, rebuilt chain, rewritten cwd. 100% lossless. |
| **T1** | any supported target (default) | Synthesizes the target agent's *own* session format into its own storage and registers it. Resume or the session list just picks it up. |
| **T2** | fallback | Writes the full session as a verbatim transcript into the target project plus a kickoff prompt. Universal, but not a native session. |

Every relay result carries a **fidelity manifest** — tier, kept entries/tools/thinking counts, and every omission — so you always know what moved and what didn't.

## 6. Cross-device relay (.arxbundle)

Sessions live on one machine; work moves. At the bottom of the Relay page:

1. **Export** — with sources selected, click the bundle export button. Optionally enable redaction first so keys/credentials are stripped before packing. A single `.arxbundle` file lands in the exports folder of your data directory.
2. **Move it** — USB stick, network drive, whatever. The file is plain local JSON; nothing is uploaded anywhere.
3. **Import** — on the other machine: *Read manifest* shows the sessions inside, the target agent card from step 2 above applies, and AgentRelay lists every project path found in the bundle with a field for the local path (**path remapping** — this is what makes a T1 session resumable on new hardware). Click **Import & relay**. A dry-run is available here too.

CLI equivalent:

```bash
node cli.js bundle out.arxbundle --from claude:<id> --from codex:<id> --redact
node cli.js import-bundle out.arxbundle --to codex --remap "D:/work=/Users/x/work" --dry-run
```

## 7. Activity view

Every relay, backup, and settings change is logged here, newest first, filterable by level (`error` / `warn` / `info` / `debug` / `trace`). When something behaved oddly, this is the trail to bring along. The log file itself self-trims: past 5 MB it keeps only the newest 2 MB.

## 8. Diagnostics

- **Storage health** — one panel per agent: is its storage reachable, how big, how many sessions.
- **Backup management** — every automatic pre-write snapshot, newest 20 kept. Restoring backs up the *current* state first, so a restore is itself reversible.
- **Diagnostic bundle** — exports storage statistics and recent logs **without session content**; attach it to a GitHub issue and you'll get help much faster.

## 9. Settings

- **Agent instances** — built-in agents can be enabled/disabled individually. WorkBuddy ships as two built-in cards — **domestic** (`~/.workbuddy`) and **international** (`~/.workbuddy-ai`) — each locked to its own directory and never mixed. *Add instance* registers an extra storage location for the same agent type (say, two Claude config directories) with a name and a data directory; *Detect* checks the path before you add it.
- **General** — language, theme (dark / light / follow system), font size, log level.
- **Background image** — paste a local image path or an https URL; it applies immediately and persists across restarts. The *glass strength* slider controls how frosted the panels are over it. Clear the field for the plain background.
- **Data directory** — where backups, exports, cache, and logs go. New files go to the new location; existing ones stay put.
- **Write-backup toggle** — the pre-write automatic backup (leave it on).
- **Auto-load session lists** — see §3.
- **Update check** — off by default; when on, makes exactly one GitHub API request at startup.

## 10. MCP — relay from inside an agent

Register once:

```bash
claude mcp add agentrelay -- node C:\path\to\agentrelay\cli.js mcp
```

Then ask your agent to do relays conversationally. Six tools: `list_agents`, `list_sessions`, `get_session`, `preview_transfer`, `transfer`, `doctor`. `transfer` stays dry-run unless you pass `confirm: true`. Full reference: [MCP.md](MCP.md).

## 11. CLI reference

| Command | What it does |
|---|---|
| `node cli.js agents` | List detected agents and session counts |
| `node cli.js list <agent> [--q keyword]` | List sessions (add `--json`, `--verbose`) |
| `node cli.js show <agent> <sessionId>` | Print a session's first entries (`--limit`) |
| `node cli.js export <agent> <sessionId>` | Export as ARX JSON or Markdown (`--out`, `--format md`, `--from/--to`, `--no-thinking`, `--truncate`, `--budget`, `--redact`) |
| `node cli.js load <file.arx.json> --into <agent> --cwd <path>` | Load a previously exported ARX file (`--mode`, `--dry-run`) |
| `node cli.js transfer --from <agent>:<id> --to <agent>` | One-shot relay (`--cwd`, `--mode T0/T1/T2`, `--dry-run`) |
| `node cli.js bundle <out> --from <agent>:<id> [...]` | Pack sessions for cross-device transfer (`--redact`) |
| `node cli.js import-bundle <file> --to <agent>[@<cwd>]` | Import a bundle (`--remap old=new`, `--mode`, `--dry-run`) |
| `node cli.js doctor` | Storage health JSON |
| `node cli.js serve` | Start the web GUI |
| `node cli.js mcp` | Start the stdio MCP server |

## 12. Performance, resources, and disk

AgentRelay is a handful of Node built-in modules and a static page — the server sits idle unless you click something. Things already done so it stays that way: big previews page instead of rendering everything, the session list is cached locally so startups don't rescan, the activity log self-trims, and the exports folder keeps only the newest 50 files. If you want the absolute lightest startup, turn auto-load off (§3) and scan agents on demand.

## 13. Troubleshooting

<details>
<summary>The port is already in use</summary>
Set <code>AGENTRELAY_PORT</code> to a free port and start again.
</details>

<details>
<summary>The relayed session doesn't show up in the target agent</summary>
Check the dry-run output: the path it reports must be inside the target agent's real storage. Close and reopen the target agent (its session list may be cached in memory), or use the resume command from the result panel. Cursor: the Cursor app must be <strong>fully closed</strong> while a relay writes into it — its in-memory state can overwrite external edits on exit.
</details>

<details>
<summary>DeepSeek Harness as target does nothing</summary>
Native (T0/T1) writes into DSH need the zstd support built into Node ≥ 23.8. On older Nodes the UI automatically offers T2 instead.
</details>

<details>
<summary>What about Trae / Doubao Work?</summary>
Trae encrypts its agent database with SQLCipher and the key lives inside Trae's own backend, so there is no safe native write. Doubao Work keeps its transcripts inside the app's IndexedDB/cloud with no local session store. For both, a T2 relay (verbatim transcript + kickoff prompt written into the target project folder) still works — paste the prompt into a new session there.
</details>

<details>
<summary>Something went wrong — can I undo?</summary>
Every write to existing storage is preceded by a backup (SQLite <code>VACUUM INTO</code> snapshot or file copy), the last 20 are listed on the Diagnostics page, and one click restores.
</details>

<details>
<summary>Does anything leave my machine?</summary>
No. Reads and writes stay on your disk; there is no telemetry and no network call unless you enable the update check, which is a single GitHub API request.
</details>

## 14. Where your data lives

| Path | Contents |
|---|---|
| `~/.agentrelay/` (or your data dir) | config, backups, exports, session-list cache, logs |
| `~/.claude/projects/`, `~/.codex/`, `~/.zcode/cli/db/`, … | the sessions themselves — always in each agent's own storage |

AgentRelay reads those stores and writes into the target's store on your explicit command. It never moves, owns, or silently modifies a session.
