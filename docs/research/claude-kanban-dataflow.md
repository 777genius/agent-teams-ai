# Claude Kanban Data Flow: Full Architecture Analysis

## Executive Summary

Claude Code **does NOT use its own built-in Agent Teams tools** (TaskCreate, TaskUpdate, TaskList, etc.) for kanban management. Instead, our app injects a **custom MCP server** (`agent-teams-mcp`) that provides its own set of tools (`task_create`, `task_list`, `task_start`, `task_complete`, `review_request`, etc.). Claude's built-in `TaskCreate` is explicitly demoted to "optional for private planning only" via the provisioning prompt.

The data flow is: **Claude calls MCP tools → agent-teams-controller writes JSON files to disk → fs.watch() detects changes → IPC event → React UI updates**.

---

## 1. How the MCP Server Gets Injected

### TeamMcpConfigBuilder (`src/main/services/team/TeamMcpConfigBuilder.ts`)

When a team is created or launched, `TeamMcpConfigBuilder.writeConfigFile()` generates a temporary JSON file:

```
/tmp/claude-team-mcp/agent-teams-mcp-<uuid>.json
```

Contents:
```json
{
  "mcpServers": {
    "agent-teams": {
      "command": "node",
      "args": ["/path/to/mcp-server/index.js"]
    },
    ...userMcpServers
  }
}
```

This merges the user's `~/.claude.json` MCP servers with the injected `agent-teams` server (our server wins on name collision).

### CLI Launch Args (`TeamProvisioningService.ts`, lines 2986-2989)

```typescript
'--mcp-config', mcpConfigPath,
'--disallowedTools', 'TeamDelete,TodoWrite',
```

- `--mcp-config` points Claude CLI to our generated config
- `TeamDelete` is blocked to prevent team cleanup
- `TodoWrite` is blocked because Opus tends to use it instead of our MCP tools
- Claude's native `TaskCreate`/`TaskUpdate` are NOT blocked — they are left available but deprioritized via prompt engineering

### The Provisioning Prompt (line 724)

```
- TaskCreate is optional for private planning only; do NOT use it for team-board tasks.
```

The prompt then explicitly instructs Claude to use MCP tools:

```
Task board operations — use MCP tools directly:
- Get task details: task_get { teamName: "...", taskId: "<id>" }
- Create task: task_create { teamName: "...", subject: "...", ... }
- Start task: task_start { teamName: "...", taskId: "<id>" }
...
```

---

## 2. What MCP Tools Exist

### MCP Server Structure (`mcp-server/`)

```
mcp-server/
├── src/
│   ├── index.ts          — FastMCP server, stdio transport
│   ├── controller.ts     — wraps agent-teams-controller
│   └── tools/
│       ├── taskTools.ts   — task_create, task_list, task_get, task_set_status, task_start,
│       │                    task_complete, task_set_owner, task_add_comment, task_link, etc.
│       ├── kanbanTools.ts — kanban_get, kanban_set_column, kanban_clear, kanban_add_reviewer
│       ├── reviewTools.ts — review_request, review_start, review_approve, review_request_changes
│       ├── messageTools.ts
│       ├── processTools.ts
│       ├── runtimeTools.ts
│       └── crossTeamTools.ts
```

### Full MCP Tool List

| Domain | Tools |
|--------|-------|
| Task | `task_create`, `task_create_from_message`, `task_get`, `task_get_comment`, `task_list`, `task_set_status`, `task_start`, `task_complete`, `task_set_owner`, `task_add_comment`, `task_attach_file`, `task_attach_comment_file`, `task_set_clarification`, `task_link`, `task_unlink`, `member_briefing`, `task_briefing` |
| Kanban | `kanban_get`, `kanban_set_column`, `kanban_clear`, `kanban_list_reviewers`, `kanban_add_reviewer`, `kanban_remove_reviewer` |
| Review | `review_request`, `review_start`, `review_approve`, `review_request_changes` |
| Message | (message-related tools) |
| Process | (process-related tools) |
| Runtime | (runtime-related tools) |
| Cross-team | `cross_team_send`, `cross_team_list_targets`, `cross_team_get_outbox` |

---

## 3. Data Flow: Claude MCP Tool Call → Disk

### The Shared Library: `agent-teams-controller`

Both the MCP server and the Electron main process use the same `agent-teams-controller` package (workspace dependency). This is a plain JS library that provides:

```javascript
// agent-teams-controller/src/controller.js
function createController(options) {
  const context = createControllerContext(options); // { teamName, paths }
  return {
    tasks: bindModule(context, tasks),
    kanban: bindModule(context, kanban),
    review: bindModule(context, review),
    messages: bindModule(context, messages),
    ...
  };
}
```

### Path Resolution

```javascript
// agent-teams-controller/src/internal/runtimeHelpers.js
function getPaths(flags, teamName) {
  const claudeDir = getClaudeDir(flags); // ~/.claude
  return {
    teamDir:  path.join(claudeDir, 'teams', teamName),
    tasksDir: path.join(claudeDir, 'tasks', teamName),
    kanbanPath: path.join(claudeDir, 'teams', teamName, 'kanban-state.json'),
    ...
  };
}
```

So tasks live in `~/.claude/tasks/<teamName>/<taskId>.json` and kanban state lives in `~/.claude/teams/<teamName>/kanban-state.json`.

### Task Creation Flow (MCP → Disk)

1. Claude calls MCP tool: `task_create { teamName: "my-team", subject: "Fix bug" }`
2. `mcp-server/src/tools/taskTools.ts` → `getController(teamName).tasks.createTask(...)`
3. `agent-teams-controller/src/internal/tasks.js` → `taskStore.createTask(context, params)`
4. `agent-teams-controller/src/internal/taskStore.js`:
   ```javascript
   function writeJson(filePath, value) {
     ensureDir(path.dirname(filePath));
     const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
     fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
     fs.renameSync(tempPath, filePath);  // atomic write
   }
   ```
5. Result: `~/.claude/tasks/my-team/<taskId>.json` is created

### Kanban State Flow

The kanban state is a separate JSON file (`kanban-state.json`) in the teams directory. When Claude calls `review_request` or `kanban_set_column`, the controller writes to `~/.claude/teams/<teamName>/kanban-state.json`.

---

## 4. Data Flow: Disk → UI

### FileWatcher (`src/main/services/infrastructure/FileWatcher.ts`)

There are **two separate fs.watch()** watchers:

1. **Teams watcher** — watches `~/.claude/teams/` (recursive)
   - Detects: `config.json`, `kanban-state.json`, `inboxes/*.json`, `sentMessages.json`, `processes.json`

2. **Tasks watcher** — watches `~/.claude/tasks/` (recursive)
   - Detects: `<teamName>/<taskId>.json` changes

When a file changes:

```typescript
// FileWatcher.ts, line 404
this.tasksWatcher = fs.watch(this.tasksPath, { recursive: true }, (eventType, filename) => {
  this.handleTasksChange(eventType, filename);
});
```

`processTasksChange()` (line 1028) parses the filename to extract `teamName` and `detail` (e.g., "12.json"), then emits:

```typescript
const event: TeamChangeEvent = { type: 'task', teamName, detail: relative };
this.emit('team-change', event);
```

### Event Propagation (`src/main/index.ts`, line 500-608)

`wireFileWatcherEvents()` listens for `team-change` events:

```typescript
context.fileWatcher.on('team-change', teamChangeHandler);
```

For task events (`row.type === 'task'`):

1. **Sends IPC to renderer**: `mainWindow.webContents.send(TEAM_CHANGE, event)` (line 502)
2. **Broadcasts to HTTP SSE**: `httpServer?.broadcast('team-change', event)` (line 504)
3. **Reconciles artifacts**: `teamDataService.reconcileTeamArtifacts(teamName)` (line 583)
4. **Notifies lead**: `teamDataService.notifyLeadOnTeammateTaskStart(teamName, taskId)` (line 590)
5. **Backs up task**: `teamBackupService.scheduleTaskBackup(teamName, detail)` (line 606)

### UI Data Reading

The renderer (React) receives `TEAM_CHANGE` events and re-fetches task data via IPC:

- `team:getTasks` → calls `TeamTaskReader.getTasks(teamName)` which reads all `~/.claude/tasks/<teamName>/*.json` files
- `team:updateKanban` → calls `TeamKanbanManager.updateTask()` which reads/writes `kanban-state.json`

The Electron `TeamTaskReader` (`src/main/services/team/TeamTaskReader.ts`) re-reads all task JSON files from disk, parses them, filters out `_internal` tasks, normalizes fields, and returns `TeamTask[]` to the renderer.

---

## 5. Claude's Built-in Tools vs Our MCP Tools

### Claude's Native Built-in Tools (Agent Teams Protocol)

| Native Tool | Purpose | Blocked? |
|-------------|---------|----------|
| `TeamCreate` | Create team structure (config.json, state) | No — used during provisioning |
| `TaskCreate` | Create a task via CLI internal mechanism | No — but deprioritized by prompt ("optional for private planning only") |
| `TaskUpdate` | Update task via CLI internal mechanism | No — but never instructed to use |
| `TaskList` | List tasks via CLI | No — but never instructed to use |
| `TaskGet` | Get task via CLI | No — but never instructed to use |
| `SendMessage` | Send message between agents | No — actively used for inter-agent chat |
| `TeamDelete` | Delete team | **YES — blocked via --disallowedTools** |
| `TodoWrite` | Write todo items | **YES — blocked via --disallowedTools** |
| `Agent` | Spawn subagent/teammate | No — actively used to spawn teammates |

### Our MCP Tools (agent-teams-mcp)

| MCP Tool | Purpose | Claude instructed to use? |
|----------|---------|-------------------------|
| `task_create` | Create task on board | **YES** — primary task creation |
| `task_start` | Move task to in_progress | **YES** |
| `task_complete` | Move task to completed | **YES** |
| `task_add_comment` | Add comment to task | **YES** |
| `task_get` | Read task details | **YES** |
| `task_list` | List all tasks | **YES** |
| `review_request` | Move to review column | **YES** |
| `review_approve` | Approve review | **YES** |
| `kanban_set_column` | Move task on kanban | **YES** |

### Why This Split?

Claude's native `TaskCreate` writes tasks to `~/.claude/tasks/<teamName>/<taskId>.json` too — the same location. But:

1. **Our MCP tools add richer fields** (displayId, workIntervals, historyEvents, comments, attachments, reviewState, sourceMessage, etc.)
2. **Our MCP tools enforce board discipline** (via agent-teams-controller logic)
3. **Our kanban state is a separate file** (`kanban-state.json`) that Claude's native tools don't manage
4. **Review workflow** (review_request → review_start → review_approve / review_request_changes) is entirely our MCP layer

Claude's native TaskCreate creates simpler task JSON files. The CLI's internal Zod schema requires `description`, `blocks`, `blockedBy` fields — our `TeamTaskWriter.createTask()` (line 68-71) ensures CLI compatibility:
```typescript
const cliCompatibleTask = {
  ...task,
  description: task.description ?? '',
  blocks: task.blocks ?? [],
  blockedBy: task.blockedBy ?? [],
};
```

---

## 6. The Two-Writer Problem

Both writers hit the same filesystem:

| Writer | Writes to | When |
|--------|-----------|------|
| MCP server (agent-teams-controller) | `~/.claude/tasks/<teamName>/<taskId>.json` | Claude calls `task_create`, `task_set_status`, etc. |
| Electron main (TeamTaskWriter) | `~/.claude/tasks/<teamName>/<taskId>.json` | UI creates/updates tasks (user clicks "Create Task", drag-drop, etc.) |
| Claude CLI built-in | `~/.claude/tasks/<teamName>/<taskId>.json` | If Claude uses native TaskCreate (deprioritized) |

All three write to the same files. Concurrent writes are handled by:
- MCP: `taskStore.writeJson()` uses atomic temp+rename
- Electron: `TeamTaskWriter` uses per-file locks + `atomicWriteAsync()`
- CLI: Its own write mechanism

There is NO cross-process lock between MCP and Electron — they rely on atomic writes and eventual consistency (file watcher detects changes within ~100ms debounce).

---

## 7. Full Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ Claude Code CLI (stream-json process)                           │
│                                                                 │
│  ┌─────────────────┐    ┌──────────────────────┐               │
│  │ Built-in Tools   │    │ MCP Tools             │               │
│  │ • SendMessage     │    │ (agent-teams-mcp)     │               │
│  │ • Agent           │    │ • task_create          │               │
│  │ • TaskCreate(*)   │    │ • task_start           │               │
│  │ • Read/Write/Bash │    │ • task_complete         │               │
│  └────────┬──────────┘    │ • task_add_comment      │               │
│           │               │ • review_request         │               │
│           │               │ • kanban_set_column      │               │
│           │               └───────────┬──────────────┘               │
│           │                           │                             │
│  stdout (stream-json)    agent-teams-controller                    │
│           │                           │                             │
└───────────┼───────────────────────────┼─────────────────────────────┘
            │                           │
            │                    ┌──────▼──────────────────┐
            │                    │ File System (disk)       │
            │                    │                          │
            │                    │ ~/.claude/tasks/<team>/  │
            │                    │   ├── 1.json             │
            │                    │   ├── 2.json             │
            │                    │   └── ...                │
            │                    │                          │
            │                    │ ~/.claude/teams/<team>/  │
            │                    │   ├── config.json        │
            │                    │   ├── kanban-state.json  │
            │                    │   └── inboxes/           │
            │                    └──────┬──────────────────┘
            │                           │
            │                    fs.watch() (recursive)
            │                           │
┌───────────┼───────────────────────────┼─────────────────────────────┐
│ Electron Main Process                 │                             │
│           │                           │                             │
│  ┌────────▼──────────┐    ┌───────────▼───────────┐                │
│  │ TeamProvisioning   │    │ FileWatcher            │                │
│  │ Service             │    │ • tasksWatcher         │                │
│  │ (parses stdout)     │    │ • teamsWatcher         │                │
│  │                     │    └───────────┬───────────┘                │
│  │ • captureSendMsg    │                │                            │
│  │ • captureSpawnEvt   │    TeamChangeEvent { type: 'task' }        │
│  │ • detectSessionId   │                │                            │
│  └─────────────────────┘    ┌───────────▼───────────┐                │
│                             │ wireFileWatcherEvents  │                │
│                             │ (src/main/index.ts)    │                │
│  ┌──────────────────────┐   └───────────┬───────────┘                │
│  │ TeamTaskReader        │              │                            │
│  │ (re-reads all .json)  │◄─────────────┤                            │
│  │                       │              │                            │
│  │ TeamKanbanManager     │    IPC: TEAM_CHANGE                      │
│  │ (reads kanban-state)  │              │                            │
│  └──────────────────────┘              │                            │
│                                        │                            │
│  ┌──────────────────────┐              │                            │
│  │ TeamTaskWriter        │              │                            │
│  │ (UI-initiated writes) │              │                            │
│  └──────────────────────┘              │                            │
└────────────────────────────────────────┼────────────────────────────┘
                                         │
                                    IPC (webContents.send)
                                         │
┌────────────────────────────────────────┼────────────────────────────┐
│ Renderer (React + Zustand)             │                            │
│                                        │                            │
│  team-change event → refetch tasks via IPC → update Zustand store  │
│  → re-render KanbanBoard                                           │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

(*) TaskCreate — Claude's native tool, deprioritized by prompt.
    Writes to same location but lacks our rich metadata.
```

---

## 8. Key Questions Answered

### Does Claude currently use MCP for kanban management?

**YES.** Claude uses our `agent-teams-mcp` MCP server for ALL task board operations. The server is injected via `--mcp-config` when spawning the CLI process. Claude's native `TaskCreate` is not blocked but is explicitly deprioritized ("optional for private planning only") via the system prompt.

### How does task data flow?

1. **Claude calls MCP tool** (e.g., `task_create`) via the stdio MCP transport
2. **agent-teams-controller** writes a JSON file to `~/.claude/tasks/<teamName>/<id>.json` (atomic write via temp+rename)
3. **fs.watch()** in FileWatcher detects the change (100ms debounce)
4. **TeamChangeEvent** `{ type: 'task', teamName, detail: '<id>.json' }` emitted
5. **wireFileWatcherEvents()** forwards to renderer via IPC (`webContents.send('team:change', event)`)
6. **Renderer** re-fetches full task list via IPC → `TeamTaskReader.getTasks()` re-reads all JSON files
7. **Zustand store** updates → React components re-render

### Could we replace Claude's built-in tools with MCP tools?

**We already did, effectively.** Claude's built-in `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet` are NOT blocked, but the prompt instructs Claude to use our MCP tools exclusively. The built-in `SendMessage` and `Agent` tools are still used (they handle inter-agent communication and teammate spawning — responsibilities our MCP server doesn't cover).

What we CANNOT replace via MCP:
- `SendMessage` — this is Claude's native inter-agent messaging protocol
- `Agent` — this is the tool that spawns teammate subprocesses
- `TeamCreate` — this bootstraps the team structure

### If Claude also used MCP (like Codex/Gemini would), would that unify the architecture?

**Partially, but with important nuances:**

**What's already unified:**
- The `agent-teams-controller` package is the single source of truth for task/kanban/review operations. Both the MCP server and the Electron main process import it.
- Any AI agent (Claude, Codex, Gemini) that connects to our MCP server gets the same tools and writes to the same files.

**What would still differ per agent:**
- **Team spawning** — Claude uses `Agent(team_name=...)` which is proprietary. Other agents would need their own subprocess spawning mechanism.
- **Inter-agent messaging** — Claude uses `SendMessage` (part of its Agent Teams protocol). Other agents would need a different approach (perhaps MCP-based `send_message` tool).
- **Process lifecycle** — Claude's `--input-format stream-json` / `--output-format stream-json` keeps the CLI alive. Other agents would need different process management.
- **Prompt injection** — Our provisioning prompt is Claude-specific. Other agents would need their own system prompts.

**To truly unify for multi-agent support:**
1. The MCP server already provides all task/kanban operations — any agent with MCP support can use them
2. We'd need to add MCP tools for messaging (`send_message`, `read_inbox`) to replace Claude-specific `SendMessage`
3. We'd need a generic agent spawning mechanism (not Claude's `Agent` tool)
4. The stdout parsing in `TeamProvisioningService` is Claude-specific — other agents would need different adapters

---

## 9. File Index

| File | Role |
|------|------|
| `src/main/services/team/TeamProvisioningService.ts` | Spawns Claude CLI, attaches stdout parser, handles stream-json, manages team lifecycle |
| `src/main/services/team/TeamMcpConfigBuilder.ts` | Generates `--mcp-config` JSON file that injects our MCP server |
| `mcp-server/src/index.ts` | FastMCP server entry point (stdio transport) |
| `mcp-server/src/controller.ts` | Wraps `agent-teams-controller` for MCP tools |
| `mcp-server/src/tools/taskTools.ts` | Task CRUD MCP tools (17 tools) |
| `mcp-server/src/tools/kanbanTools.ts` | Kanban state MCP tools (6 tools) |
| `mcp-server/src/tools/reviewTools.ts` | Review workflow MCP tools |
| `agent-teams-controller/src/controller.js` | Shared controller factory — creates context + binds all domain modules |
| `agent-teams-controller/src/internal/taskStore.js` | Low-level task JSON file read/write operations |
| `agent-teams-controller/src/internal/tasks.js` | Task business logic (create, start, complete, comment, etc.) |
| `agent-teams-controller/src/internal/runtimeHelpers.js` | Path resolution (`~/.claude/tasks/`, `~/.claude/teams/`) |
| `src/main/services/infrastructure/FileWatcher.ts` | Watches `~/.claude/tasks/` and `~/.claude/teams/` with fs.watch() |
| `src/main/index.ts` (lines 425-620) | `wireFileWatcherEvents()` — forwards file changes to renderer via IPC |
| `src/main/services/team/TeamTaskReader.ts` | Reads all task JSON files, normalizes, returns `TeamTask[]` |
| `src/main/services/team/TeamTaskWriter.ts` | UI-side writes (create, update status, add comment, etc.) |
| `src/main/services/team/TeamKanbanManager.ts` | Reads/writes `kanban-state.json` for UI kanban overlay |
