# Unified MCP Architecture: Should Claude Also Use MCP for Kanban?

**Date**: 2026-03-24
**Branch**: `dev`
**Based on**: deep analysis of `mcp-server/`, `agent-teams-controller/`, `TeamProvisioningService.ts`, `TeamMcpConfigBuilder.ts`, and data flow through file watchers

---

## The Question

If Codex/Gemini use MCP for kanban management, should Claude also use MCP instead of its native built-in tools? This would unify the architecture into a single code path.

---

## Current State: What Exists Today

### MCP Server (30+ tools, fully provider-agnostic)

Our `mcp-server/` package exposes these tools via FastMCP over stdio:

| Category | Tools | Count |
|----------|-------|-------|
| Tasks | `task_create`, `task_create_from_message`, `task_get`, `task_get_comment`, `task_list`, `task_set_status`, `task_start`, `task_complete`, `task_set_owner`, `task_add_comment`, `task_attach_file`, `task_attach_comment_file`, `task_set_clarification`, `task_link`, `task_unlink`, `member_briefing`, `task_briefing` | 17 |
| Kanban | `kanban_get`, `kanban_set_column`, `kanban_clear`, `kanban_list_reviewers`, `kanban_add_reviewer`, `kanban_remove_reviewer` | 6 |
| Review | `review_request`, `review_start`, `review_approve`, `review_request_changes` | 4 |
| Messages | `message_send` | 1 |
| Processes | `process_register`, `process_list`, `process_unregister`, `process_stop` | 4 |
| Cross-team | `cross_team_send`, `cross_team_list_targets`, `cross_team_get_outbox` | 3 |
| Runtime | `team_launch`, `team_stop` | 2 |
| **Total** | | **37** |

### Claude's Native Built-in Tools (Claude Code Agent Teams)

These exist ONLY inside Claude Code CLI and cannot be replaced:

| Tool | Purpose | Can MCP replace? |
|------|---------|------------------|
| `TeamCreate` | Creates team config on disk, initializes team state | Partially (MCP can write config, but Claude Code uses this to enter "team mode") |
| `TeamDelete` | Deletes team, cleans up processes | Partially |
| `TaskCreate` (Agent tool with `team_name`) | Spawns a teammate subprocess | **NO** -- this is process spawning, not task creation |
| `SendMessage` | Claude's native inbox message delivery | Partially (MCP `message_send` writes to same files) |
| `TaskGet` | Claude's native task query | Yes, `task_get` MCP does the same |
| `TaskList` | Claude's native task listing | Yes, `task_list` MCP does the same |
| `TaskUpdate` | Claude's native task update | Yes, `task_set_status`/`task_set_owner` MCP do the same |

**Critical insight**: Claude Code's `TaskCreate` with `team_name` parameter is NOT a task-creation tool -- it's a **teammate process spawner**. It tells Claude Code CLI to fork a new subprocess for a teammate. No MCP tool can replace this because it's an internal CLI operation.

### Data Flow: Where Files Live

Both Claude's native tools AND our MCP server write to the **same directories**:

```
~/.claude/
  teams/<teamName>/
    config.json          -- team configuration
    kanban-state.json    -- kanban board state
    processes.json       -- registered processes
    members.meta.json    -- member metadata
    inboxes/
      <member>.json      -- per-member inbox messages
      user.json          -- messages to the user
    task-attachments/
      <taskId>/          -- file attachments
  tasks/<teamName>/
    <taskId>.json        -- individual task files
```

**This is already a shared data layer.** Our MCP server uses `agent-teams-controller` which reads/writes these exact files. Claude Code CLI also reads/writes these files via its built-in Agent Teams feature. The file watchers in `src/main/` detect changes from ANY source.

### How Claude ALREADY Uses MCP

Claude Code agents (both lead and teammates) **already** receive our MCP server via `--mcp-config`:

```
TeamMcpConfigBuilder.writeConfigFile()
  → generates temp JSON config pointing to mcp-server/dist/index.js
  → passed to Claude CLI via --mcp-config <path>
  → Claude Code loads our MCP tools alongside its built-in tools
```

The prompt in `buildTeamCtlOpsInstructions()` teaches Claude to use MCP tools:
```
Internal task board tooling (MCP):
- Use the board-management MCP tools for tasks that must appear on the team board
```

And `buildMemberSpawnPrompt()` instructs teammates:
```
First call member_briefing to learn your current assigned tasks...
Use task_start/task_complete/task_add_comment to track progress...
```

**Claude Code agents already use our MCP tools for task/kanban management.** They use native tools only for: team creation, teammate spawning, and direct messaging (though `message_send` MCP also works).

---

## Three Architectures Compared

### Architecture A: Dual-Path (Current Proposal for Multi-Provider)

```
                    +-----------------+
                    |   Kanban UI     |
                    |  (Electron)     |
                    +--------+--------+
                             |
                    +--------+--------+
                    | File Watchers   |
                    | (chokidar)      |
                    +--------+--------+
                             |
              +--------------+--------------+
              |                             |
    +---------+----------+     +------------+-----------+
    | ~/.claude/teams/   |     | ~/.claude/tasks/       |
    | config, kanban,    |     | <taskId>.json files    |
    | inboxes, processes |     |                        |
    +----+----------+----+     +-----+------------+-----+
         |          |                |            |
         |          |                |            |
    +----+----+ +---+--------+  +---+----+ +-----+------+
    | Claude  | | MCP Server |  | Claude | | MCP Server |
    | Native  | | (agent-    |  | Native | | (agent-    |
    | Tools   | | teams-mcp) |  | Tools  | | teams-mcp) |
    +---------+ +-----+------+  +--------+ +-----+------+
         |            |              |            |
    +----+----+  +----+-----+  +----+----+  +----+-----+
    | Claude  |  | Codex/   |  | Claude  |  | Codex/   |
    | Code    |  | Gemini/  |  | Code    |  | Gemini/  |
    | CLI     |  | Any MCP  |  | CLI     |  | Any MCP  |
    +---------+  | Agent    |  +---------+  | Agent    |
                 +----------+               +----------+
```

**Data flow:**
- Claude -> native built-in tools -> writes directly to `~/.claude/teams/` and `~/.claude/tasks/`
- Claude -> MCP tools -> `agent-teams-controller` -> writes to same files
- Codex/Gemini -> MCP tools -> `agent-teams-controller` -> writes to same files
- File watchers detect ALL changes -> UI updates

| Criterion | Score |
|-----------|-------|
| Reliability | **9/10** |
| Confidence | **9/10** |
| Effort | 3-4 weeks |
| Risk | Very Low |
| Code reuse | 100% |

**Pros:**
- Zero risk to existing Claude Code functionality
- Claude uses its battle-tested native tools (TeamCreate, Agent/Task tool for spawning)
- MCP tools handle task/kanban CRUD (Claude already uses these)
- External agents use MCP exclusively
- Both paths write to same files, file watchers don't care who writes
- 30+ MCP tools already exist and are tested

**Cons:**
- Two "entry points" for writes (native tools + MCP tools), though they share the same data layer
- Claude has redundant tools (native TaskGet + MCP task_get), but the prompt steers which to use
- If agent-teams-controller changes, both native and MCP paths need verification

---

### Architecture B: Unified MCP (ALL agents use MCP only)

```
                    +-----------------+
                    |   Kanban UI     |
                    |  (Electron)     |
                    +--------+--------+
                             |
                    +--------+--------+
                    | File Watchers   |
                    | (chokidar)      |
                    +--------+--------+
                             |
              +--------------+--------------+
              |                             |
    +---------+----------+     +------------+-----------+
    | ~/.claude/teams/   |     | ~/.claude/tasks/       |
    +--------+-----------+     +--------+---------------+
             |                          |
             +----------+---------------+
                        |
               +--------+--------+
               |  MCP Server     |
               |  (agent-teams-  |
               |   controller)   |
               +--------+--------+
                        |
          +-------------+-------------+
          |             |             |
     +----+----+  +----+-----+ +-----+----+
     | Claude  |  | Codex/   | | Gemini/  |
     | Code    |  | Gemini   | | Other    |
     | CLI     |  | CLI      | | Agents   |
     +---------+  +----------+ +----------+
```

**Data flow:**
- ALL agents -> MCP tools only -> `agent-teams-controller` -> writes to `~/.claude/tasks/` and `~/.claude/teams/`
- Claude Code's native tools (TeamCreate, TaskCreate, SendMessage) are DISABLED or unused
- File watchers detect changes -> UI updates

| Criterion | Score |
|-----------|-------|
| Reliability | **4/10** |
| Confidence | **3/10** |
| Effort | 8-12 weeks |
| Risk | Very High |
| Code reuse | ~40% |

**Pros:**
- Single code path for all agents
- Single set of tools to maintain
- Architecturally "clean"

**Cons -- and this is where the analysis gets critical:**

1. **Cannot disable Claude's `TaskCreate` (Agent tool with team_name)**
   - This is how Claude Code spawns teammate subprocesses
   - There is no MCP equivalent -- MCP tools return JSON responses, they cannot fork processes
   - `--disallowedTools TaskCreate` would break teammate spawning entirely
   - Our `team_launch` MCP tool talks to the desktop runtime HTTP API -- it's a different mechanism (launches the whole team, not individual teammates)

2. **Cannot fully replace `TeamCreate`**
   - `TeamCreate` puts Claude Code CLI into "team mode" -- it enables Agent Teams features, stdin relay, inbox monitoring
   - Writing `config.json` via MCP creates the files but doesn't activate the CLI-side features
   - The CLI needs to be told about the team through its own internal protocol

3. **Cannot fully replace `SendMessage`**
   - Our MCP `message_send` writes to inbox files, which works for teammates (they read inbox files directly)
   - But the lead reads messages via stdin relay (`relayLeadInboxMessages()`). MCP `message_send` to lead would require the relay to detect the file write and relay it -- this works but is a longer path with more latency
   - Risk of message delivery race conditions during high-frequency messaging

4. **Prompt rewrite is massive and risky**
   - `buildProvisioningPrompt()` (95 LOC) teaches Claude to use `TeamCreate` + `Agent` tool -- would need complete rewrite
   - `buildPersistentLeadContext()` (100+ LOC) references built-in tools throughout
   - `buildMemberSpawnPrompt()` references `member_briefing` MCP tool (this part is already MCP-based)
   - Total: ~300 LOC of prompt engineering that took months to tune for delegation-first behavior, task board discipline, review workflow
   - Any prompt change risks breaking the finely-tuned agent behavior

5. **Token overhead from MCP tool descriptions**
   - 37 MCP tools * ~50-100 tokens each = 1,850-3,700 additional tokens per turn
   - Claude's native tools don't consume context (they're built into the CLI)
   - For long sessions this accumulates significantly

6. **MCP tool discovery overhead**
   - Each MCP tool call has stdio round-trip overhead vs native tool calls which are in-process
   - For high-frequency operations (agent spawning many tasks) this adds latency

7. **Loss of Claude Code optimizations**
   - Claude Code's built-in tools are optimized for its internal state machine
   - `TeamCreate` triggers internal event routing, session persistence, teammate monitoring
   - Replacing with MCP tools means these side effects would need to be triggered differently

---

### Architecture C: Hybrid Unified (RECOMMENDED)

```
                    +-----------------+
                    |   Kanban UI     |
                    |  (Electron)     |
                    +--------+--------+
                             |
                    +--------+--------+
                    | File Watchers   |
                    | (chokidar)      |
                    +--------+--------+
                             |
              +--------------+--------------+
              |                             |
    +---------+----------+     +------------+-----------+
    | ~/.claude/teams/   |     | ~/.claude/tasks/       |
    | config, kanban,    |     | <taskId>.json files    |
    | inboxes, processes |     |                        |
    +--+---------+---+---+     +---+---------+---+------+
       |         |   |             |         |   |
       |    +----+---+----+        |    +----+---+-----+
       |    | agent-teams- |       |    | agent-teams-  |
       |    | controller   +-------+    | controller    |
       |    | (shared      |            | (shared       |
       |    |  data layer) |            |  data layer)  |
       |    +----+---------+            +-----+---------+
       |         |                            |
       |    +----+---------+            +-----+---------+
       |    |  MCP Server  |            |  MCP Server   |
       |    |  (agent-     |            |  (agent-      |
       |    |   teams-mcp) |            |   teams-mcp)  |
       |    +----+---------+            +-----+---------+
       |         |                            |
  +----+----+    |    +----------+      +-----+----+
  | Claude  |    +----+ Codex/   |      | Gemini/  |
  | Native  |         | Any MCP  |      | Other    |
  | Tools:  |         | Agent    |      | Agents   |
  | Team    |         +----------+      +----------+
  | Create, |
  | Agent   |    Claude ALSO uses MCP for:
  | Spawn,  |    task_create, task_get, task_list,
  | Send    |    task_set_status, kanban_get,
  | Message |    kanban_set_column, review_request,
  +---------+    review_approve, message_send, etc.
```

**Data flow:**
- Claude -> native tools for LIFECYCLE operations (TeamCreate, Agent/Task spawning, SendMessage to lead)
- Claude -> MCP tools for CRUD operations (task management, kanban, review, comments) -- **already happens today**
- Codex/Gemini -> MCP tools for ALL operations
- ALL writes go to the same `~/.claude/` directories via `agent-teams-controller`
- File watchers detect ALL changes regardless of source

| Criterion | Score |
|-----------|-------|
| Reliability | **9/10** |
| Confidence | **9/10** |
| Effort | 3-4 weeks (same as Architecture A) |
| Risk | Very Low |
| Code reuse | 100% |

**Pros:**
- Claude keeps its native tools for things MCP cannot do (process spawning, entering team mode)
- Claude uses MCP for task/kanban CRUD -- THIS IS ALREADY THE CASE TODAY
- External agents use MCP exclusively -- works today with our 37 tools
- Single data layer (`agent-teams-controller`) for all writes
- File watchers are source-agnostic
- Zero prompt rewriting for Claude
- Zero risk to existing functionality

**Cons:**
- Claude has both native + MCP tools available (mild complexity)
- Need to ensure no conflicts when Claude's native tools and MCP tools modify the same task

---

## Critical Finding: Architecture C IS Architecture A

After thorough analysis, Architectures A and C are **functionally identical** because:

1. **Claude already uses our MCP tools for kanban/task management** -- the prompt explicitly instructs this via `buildTeamCtlOpsInstructions()`
2. **Claude only uses native tools for what MCP cannot do** -- TeamCreate (entering team mode), Agent tool (spawning subprocesses), SendMessage (lead stdin relay)
3. **Both paths already write to the same files** -- `agent-teams-controller` is the shared data layer

The "dual-path" concern is a misconception. There aren't two competing paths -- there's one path for **lifecycle operations** (Claude Code native) and one path for **data operations** (MCP), and they already coexist.

---

## Does Our MCP Server Write to the Same Files as Claude's Native Tools?

**YES, unequivocally.**

Evidence from source code:

1. `agent-teams-controller/src/internal/runtimeHelpers.js` line 117-124:
```javascript
function getPaths(flags, teamName) {
  const claudeDir = getClaudeDir(flags);    // defaults to ~/.claude
  const teamDir = path.join(claudeDir, 'teams', safeTeam);
  const tasksDir = path.join(claudeDir, 'tasks', safeTeam);
  const kanbanPath = path.join(teamDir, 'kanban-state.json');
  const processesPath = path.join(teamDir, 'processes.json');
  return { claudeDir, teamDir, tasksDir, kanbanPath, processesPath };
}
```

2. `mcp-server/src/controller.ts` uses `createController({ teamName })` which calls `getPaths()` above
3. Claude Code's native Agent Teams also writes to `~/.claude/teams/<name>/` and `~/.claude/tasks/<name>/`
4. Both use the same JSON file format with atomic write (temp file + rename)

**Conflict risk**: Very low. File writes use atomic rename (`writeJson` creates a temp file then `fs.renameSync`). The `fileLock.js` module provides advisory locking for concurrent writes. Task files are per-task (one JSON per task), so different agents working on different tasks don't collide.

---

## Architecture Decision

### Architecture B (Unified MCP-only) is NOT viable

The fundamental blocker: **Claude Code's Agent Teams is a CLI feature, not a data feature.** The built-in tools (TeamCreate, Agent tool for spawning) trigger internal CLI state changes that cannot be replicated via MCP. Disabling them would break:

- Team mode activation
- Teammate process spawning
- Lead inbox relay
- Tool approval flow
- Post-compact context recovery
- Auth retry logic

These are 7,982 LOC of battle-tested code in `TeamProvisioningService.ts` that would need to be rebuilt from scratch with worse ergonomics.

### Architecture A/C (Hybrid) is already the architecture we have

The "should Claude use MCP?" question has already been answered: **Claude already uses MCP for kanban/task operations.** The prompt instructs it. The `--mcp-config` flag delivers our MCP server to every Claude Code agent (lead and teammates).

The only remaining question is: what do we need to add to support Codex/Gemini?

---

## What's Actually Needed for Multi-Provider Support

### Already complete (0 additional work)

- MCP server with 37 tools
- `agent-teams-controller` as provider-agnostic data layer
- File watchers that detect changes from any source
- Atomic file writes to prevent corruption
- HTTP control API for launch/stop

### Needed: New MCP tools for external agent lifecycle

```
team_join            -- register as external team member (provider, model metadata)
team_leave           -- unregister from team
team_list_teams      -- discover available teams
team_get_config      -- get team configuration and member list
member_heartbeat     -- keepalive signal for external agents
task_poll_assigned   -- poll for tasks assigned to this agent
task_claim           -- claim an unassigned pending task
```

**Files to add:**
- `mcp-server/src/tools/memberTools.ts` (new)
- `mcp-server/src/tools/teamDiscoveryTools.ts` (new)
- `agent-teams-controller/src/internal/memberLifecycle.js` (new)

**Files to modify:**
- `mcp-server/src/tools/index.ts` -- register new tool modules
- `agent-teams-controller/src/internal/runtimeHelpers.js` -- member metadata helpers
- `src/shared/types/team.ts` -- add `provider?: string`, `model?: string` fields

**Files unchanged (0 modifications):**
- `TeamProvisioningService.ts` -- untouched
- `TeamDataService.ts` -- reads data generically, will pick up new fields
- `TeamMcpConfigBuilder.ts` -- untouched (Claude-specific)
- All prompt engineering -- untouched

### Needed: UI enhancements

- Provider badge/icon on member cards
- "External agent" indicator on kanban task cards
- Different color/treatment for externally-managed agents

---

## Comparison Matrix

| Criterion | A: Dual-Path | B: Unified MCP | C: Hybrid (=A) |
|-----------|:---:|:---:|:---:|
| Reliability | 9/10 | 4/10 | **9/10** |
| Confidence | 9/10 | 3/10 | **9/10** |
| Effort (weeks) | 3-4 | 8-12 | **3-4** |
| Risk level | Very Low | Very High | **Very Low** |
| Existing code reuse | 100% | ~40% | **100%** |
| Breaks Claude flow? | No | Yes | **No** |
| Breaks prompts? | No | Yes (300+ LOC rewrite) | **No** |
| Single data layer? | Yes | Yes | **Yes** |
| Claude keeps optimizations? | Yes | No | **Yes** |
| Supports Codex/Gemini? | Yes, via MCP | Yes, via MCP | **Yes, via MCP** |
| Token overhead | None extra | +1.8-3.7K tokens/turn | **None extra** |
| MCP standard compliance | Yes | Yes | **Yes** |
| Incremental delivery? | Yes | No | **Yes** |
| Time to first external agent | 2-3 weeks | 8+ weeks | **2-3 weeks** |

---

## Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|------|:-----------:|:------:|------------|
| MCP tool conflicts with native tools | Low | Medium | Tools operate on different task IDs; atomic writes; file-level locking in `fileLock.js` |
| External agent writes corrupt state | Low | High | `agent-teams-controller` validates all inputs; atomic write-rename pattern; per-task file isolation |
| External agent doesn't follow workflow | Medium | Low | `member_briefing` provides onboarding; tool descriptions guide behavior; `task_set_clarification` for issues |
| Performance under many agents | Low | Medium | File I/O is the bottleneck (same as now); no additional overhead |
| Claude Code updates break file format | Low | High | `agent-teams-controller` is our adapter layer -- update it when format changes |
| MCP protocol evolution | Very Low | Low | FastMCP library handles protocol; MCP spec is stable (v1.0+) |

---

## Conclusion

**Architecture C (Hybrid) is the answer, and it's essentially what we already have.**

The realization that resolves the question: Claude Code already uses our MCP tools for task/kanban management. The "should Claude use MCP too?" question is already answered with "yes, and it does." Claude keeps its native tools for the things that ONLY Claude Code can do (process spawning, team mode activation), and uses MCP for everything that's shared (tasks, kanban, review, messages, comments).

For Codex/Gemini, we add ~7 new MCP tools for agent lifecycle management. That's it. No architectural changes, no prompt rewrites, no refactoring. The data layer is already shared, the file watchers are already source-agnostic, and the MCP server already exposes the full API.

The **single most important insight** from this analysis: the architecture is NOT "dual-path." It's a single shared data layer (`agent-teams-controller`) with two access methods -- native tools for Claude Code internal operations, MCP tools for everything else. Both access methods are complementary, not competing.
