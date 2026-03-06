# @claude-team/mcp-server

**Model Context Protocol (MCP) server for managing Claude Agent Teams kanban board and tasks.**

Exposes 13 tools so AI agents (Claude, Cursor, or any MCP-compatible client) can create tasks, manage the kanban board, conduct code reviews, and send messages — backed by the same `teamctl.js` CLI that powers the Claude Agent Teams UI desktop app.

---

## Table of Contents

- [Overview](#overview)
- [Relationship to Claude Agent Teams UI](#relationship-to-claude-agent-teams-ui)
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Tools Reference](#tools-reference)
- [Data Storage](#data-storage)
- [Development](#development)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Overview

Implements the [Model Context Protocol](https://modelcontextprotocol.io/) over **stdio**. All operations are delegated to `teamctl.js`, which:

- Stores task data as JSON under `~/.claude/tasks/{teamName}/`
- Stores team config under `~/.claude/teams/{teamName}/`
- Is installed automatically when you run Claude Agent Teams UI at least once

### Use cases

| Scenario | Description |
|----------|-------------|
| **Cursor / Claude Desktop** | Add the server to MCP config so AI assistants can create tasks, assign owners, move cards, and send messages without leaving the chat |
| **Automation scripts** | Programmatic interface to the same task board that Claude Code agents use |
| **Multi-agent workflows** | Multiple AI agents sharing one task board, coordinating via comments and messages |

### Architecture

```
┌─────────────────────┐     stdio      ┌──────────────────────┐     spawn      ┌─────────────────┐
│  MCP Client         │ ◄────────────► │  @claude-team/       │ ◄────────────► │  teamctl.js     │
│  (Cursor, Claude,   │                │  mcp-server          │                │  ~/.claude/     │
│   custom scripts)   │                │  (FastMCP + 13 tools) │                │  tools/         │
└─────────────────────┘                └──────────────────────┘                └─────────────────┘
```

---

## Relationship to Claude Agent Teams UI

| Component | Role |
|-----------|------|
| **Claude Agent Teams UI** | Desktop app (Electron). Visualizes sessions, kanban board, code review, team messaging. Installs `teamctl.js` on first run. |
| **teamctl.js** | CLI at `~/.claude/tools/teamctl.js`. Reads/writes task JSON, manages kanban, inboxes, reviews. Used by both the app and agents. |
| **@claude-team/mcp-server** | MCP server wrapping `teamctl.js` so Cursor, Claude Desktop, and other MCP clients can call the same operations as tools. |

Agents in Claude Code use `teamctl.js` via Bash. Agents in Cursor or Claude Desktop use this MCP server. Both operate on the same data.

---

## Quick start

1. Run **Claude Agent Teams UI** at least once (installs `teamctl.js`)
2. Build the MCP server: `cd mcp-server && pnpm install && pnpm build`
3. Add to Cursor MCP config (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "claude-team-tools": {
      "command": "node",
      "args": ["/absolute/path/to/claude_agent_teams_ui/mcp-server/dist/index.js"]
    }
  }
}
```

4. Restart Cursor. The 13 tools will appear for the AI assistant.

---

## Prerequisites

- **Node.js 20+**
- **Claude Agent Teams UI** run at least once (installs `teamctl.js` to `~/.claude/tools/teamctl.js`)

If `teamctl.js` is missing, the server throws at startup:

```
teamctl.js not found at ~/.claude/tools/teamctl.js.
Make sure Claude Agent Teams UI has been run at least once,
or set the TEAMCTL_PATH environment variable.
```

---

## Installation

### From the monorepo (development)

```bash
cd mcp-server
pnpm install
pnpm build
```

### As a dependency

```bash
pnpm add @claude-team/mcp-server
# or
npm install @claude-team/mcp-server
```

---

## Configuration

### Cursor

Add to `~/.cursor/mcp.json` or project `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "claude-team-tools": {
      "command": "node",
      "args": ["/path/to/claude_agent_teams_ui/mcp-server/dist/index.js"]
    }
  }
}
```

With global install (`pnpm link` or `npm link`):

```json
{
  "mcpServers": {
    "claude-team-tools": {
      "command": "team-mcp-server"
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or equivalent:

```json
{
  "mcpServers": {
    "claude-team-tools": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/index.js"]
    }
  }
}
```

### Environment variables

| Variable | Description |
|----------|-------------|
| `TEAMCTL_PATH` | Path to `teamctl.js` if not at `~/.claude/tools/teamctl.js` |

---

## Tools Reference

All tools require a `team` parameter (team name, folder under `~/.claude/teams/`).

### Task CRUD

| Tool | Description |
|------|-------------|
| `task_create` | Create a task. Optional: `owner`, `description`, `blocked_by`, `related`, `status`, `notify`, `from` |
| `task_get` | Get a task by ID. Returns full JSON (status, owner, comments, dependencies, work intervals, history) |
| `task_list` | List all tasks. Returns JSON array (filter internal tasks client-side if needed) |
| `task_set_status` | Set status: `pending` → `in_progress` → `completed` → `deleted`. Records work intervals |
| `task_set_owner` | Assign or unassign owner. Use `owner="clear"` to unassign. Optional: `notify`, `from` |

### Task collaboration

| Tool | Description |
|------|-------------|
| `task_comment` | Add a comment. Sends inbox notification to owner (unless commenter is owner). Optional: `from` |
| `task_link` | Link/unlink dependencies. Types: `blocked-by`, `blocks`, `related`. Bidirectional; circular deps rejected |
| `task_briefing` | Human-readable briefing for a member: their assigned tasks vs full board |
| `task_attach` | Attach a file. Modes: `copy`, `link`. MIME auto-detected (PNG, JPEG, GIF, WebP, PDF, ZIP). Max 20 MB |

### Kanban board

| Tool | Description |
|------|-------------|
| `kanban_move` | Move to `review` or `approved`, or `clear` from board. Moving to column sets status to `completed` |
| `kanban_reviewers` | Manage reviewers: `list` (JSON array), `add`, `remove` |

### Code review

| Tool | Description |
|------|-------------|
| `review_action` | `approve` — mark approved (optional comment, `notify_owner`). `request-changes` — remove from kanban, reset to `in_progress`, notify owner (comment required) |

### Messaging

| Tool | Description |
|------|-------------|
| `message_send` | Send inbox message to a member. Optional: `summary`, `from`. Triggers notifications |

---

## Data Storage

| Location | Contents |
|----------|----------|
| `~/.claude/tasks/{teamName}/` | Task JSON files (`1.json`, `2.json`, …) |
| `~/.claude/teams/{teamName}/` | Team config, kanban reviewers, inboxes |

Task IDs are numeric (highwatermark). Team and member names must be safe path segments (no `.`, `..`, `/`, `\`, null bytes).

---

## Development

### Scripts

| Command | Description |
|---------|-------------|
| `pnpm build` | Build with tsup → `dist/index.js` |
| `pnpm dev` | Run with tsx (no build) |
| `pnpm test` | Run Vitest tests |
| `pnpm test:watch` | Watch mode |
| `pnpm typecheck` | TypeScript check |

### Project structure

```
mcp-server/
├── src/
│   ├── index.ts          # FastMCP server, registers all tools
│   ├── teamctl-runner.ts  # Spawns teamctl.js subprocess
│   ├── output-parser.ts   # Parses JSON / "OK ..." from teamctl stdout
│   ├── schemas.ts         # Zod schemas (team, taskId, member, etc.)
│   └── tools/
│       ├── index.ts       # registerAllTools()
│       ├── task-create.ts
│       ├── task-get.ts
│       ├── ...
│       └── message-send.ts
├── test/
│   ├── tools/             # Per-tool tests
│   ├── teamctl-runner.test.ts
│   ├── output-parser.test.ts
│   └── schemas.test.ts
├── package.json
├── tsup.config.ts
└── vitest.config.ts
```

### Adding a new tool

1. Create `src/tools/your-tool.ts` with `register(server, runner)`
2. Add to `ALL_TOOLS` in `src/tools/index.ts`
3. Add Zod parameters and map to `teamctl` CLI args
4. Use `parseJsonOutput`, `parseOkOutput`, or `parseTextOutput` from `output-parser.ts`
5. Add tests in `test/tools/your-tool.test.ts`

---

## Testing

Tests use a mock `ITeamctlRunner` (no real `teamctl.js` required):

```bash
pnpm test
```

For integration tests with real `teamctl.js`, use the main app: `test/main/services/team/teamctl.test.ts`.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| **teamctl.js not found** | Run Claude Agent Teams UI at least once, or set `TEAMCTL_PATH` |
| **Invalid team/member name** | Names: 1–128 chars, no `.`, `..`, `/`, `\`, null bytes |
| **MCP client not discovering tools** | Check server starts without errors; use absolute path in config; some clients require it |
| **Timeout errors** | Default 10s. Increase via `TeamctlRunnerOptions.timeoutMs` (code change) |

---

## License

Same as the parent project: [AGPL-3.0](../LICENSE).
