# Best Integration Approach for Multi-Provider Agent Support

**Date**: 2026-03-24
**Branch**: `dev`
**Based on**: deep codebase analysis of actual source files

---

## Executive Summary

After analyzing 21,584 LOC in `src/main/services/team/`, 2,973 LOC in `src/main/ipc/teams.ts`, 1,245 LOC in `mcp-server/src/`, and all prompt engineering in `TeamProvisioningService.ts` (7,982 LOC), the recommendation is:

**Option 7: Hybrid approach** — keep Claude Code native support as-is, enhance the existing MCP server to be the universal integration point for other agents.

This is the only approach that ships incrementally, preserves our working architecture, and provides real multi-provider value within 2-3 weeks.

---

## Architecture Deep Dive

### Coupling Map (actual file references)

#### Layer 1: Process Management (9/10 coupling to Claude)
- `src/main/services/team/ClaudeBinaryResolver.ts` (292 LOC) — resolves `claude` binary across PATH, NVM, platform-specific dirs
- `src/main/services/team/TeamProvisioningService.ts` (7,982 LOC) — the monolith: process spawn, stream-json parsing, prompt engineering, inbox relay, tool approval, stall detection, auth retry
- `src/main/utils/childProcess.ts` — `spawnCli()` injects `CLAUDE_HOOK_JUDGE_MODE` env var
- Claude CLI flags hardcoded: `--input-format stream-json`, `--output-format stream-json`, `--verbose`, `--setting-sources`, `--mcp-config`, `--disallowedTools`, `--dangerously-skip-permissions`, `--permission-prompt-tool`, `--permission-mode`, `--model`, `--effort`, `--worktree`, `--resume`
- Kill semantics: `killTeamProcess()` uses SIGKILL because Claude CLI SIGTERM cleanup **deletes team files**

#### Layer 2: Protocol (10/10 coupling to Claude)
- stream-json protocol is entirely Claude-proprietary
- `HANDLED_STREAM_JSON_TYPES` = `user`, `assistant`, `control_request`, `result`, `system`
- Input format: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}\n`
- Output parsing: 60+ branches in `handleStreamJsonMessage()` (lines 4858-5294)
- `control_request` for tool approval — Claude Code-specific flow
- Teammate message format: `<teammate-message teammate_id="..." color="..." summary="...">content</teammate-message>`

#### Layer 3: Prompt Engineering (10/10 coupling to Claude)
- `buildProvisioningPrompt()` (lines 860-953) — tells Claude to use `TeamCreate` built-in tool, then `Task` tool with `team_name` parameter to spawn teammates
- `buildMemberSpawnPrompt()` (lines 444-478) — instructs member to call `member_briefing` MCP tool first, then work with MCP task tools
- `buildPersistentLeadContext()` (lines 664-766) — 100+ line constraint block teaching Claude about kanban, review workflow, delegation-first behavior, agent block policy, cross-team messaging
- `buildTeamCtlOpsInstructions()` (lines 563-662) — exact MCP tool call examples: `task_create`, `task_get`, `kanban_set_column`, `review_approve`, etc.
- `buildActionModeProtocol()` — imports from `agent-teams-controller` via `protocols.buildActionModeProtocolText()`

**Key insight**: The prompt teaches Claude to use two categories of tools:
1. **Claude Code built-in tools**: `TeamCreate`, `TeamDelete`, `TaskCreate` (the CLI's internal Task tool for spawning subagents), `SendMessage` — these exist ONLY in Claude Code
2. **MCP tools**: `task_create`, `task_get`, `task_list`, `kanban_get`, `review_approve`, `message_send`, etc. — these come from our `agent-teams-mcp` server and are **provider-agnostic**

#### Layer 4: Data Layer (5/10 coupling — mostly agnostic)
- `agent-teams-controller` (workspace package) — **provider-agnostic** file-based CRUD for tasks, kanban, reviews, messages, processes
- `TeamDataService.ts` (1,953 LOC) — reads team data, invokes controller. Most logic is generic
- `TeamInboxWriter.ts` — writes JSON inbox files. No Claude-specific code
- `TeamTaskReader.ts`, `TeamTaskWriter.ts` — file-based task CRUD via controller
- `TeamKanbanManager.ts` — kanban state management via controller
- `TeamConfigReader.ts` — reads `config.json` from `~/.claude/teams/<name>/`
- Path dependency: `~/.claude/teams/` and `~/.claude/tasks/` via `pathDecoder.ts`

#### Layer 5: MCP Server (0/10 coupling — fully agnostic)
- `mcp-server/src/` (1,245 LOC) — FastMCP server exposing 30+ tools
- **Already exposed tools**:
  - Tasks: `task_create`, `task_get`, `task_get_comment`, `task_list`, `task_set_status`, `task_start`, `task_complete`, `task_set_owner`, `task_add_comment`, `task_attach_file`, `task_attach_comment_file`, `task_set_clarification`, `task_link`, `task_unlink`, `member_briefing`, `task_briefing`
  - Kanban: `kanban_get`, `kanban_set_column`, `kanban_clear`, `kanban_list_reviewers`, `kanban_add_reviewer`, `kanban_remove_reviewer`
  - Review: `review_request`, `review_start`, `review_approve`, `review_request_changes`
  - Messages: `message_send`
  - Processes: `process_register`, `process_list`, `process_unregister`, `process_stop`
  - Cross-team: `cross_team_send`, `cross_team_list_targets`, `cross_team_get_outbox`
  - Runtime: `team_launch`, `team_stop`
- Uses `agent-teams-controller` directly — no Claude Code dependency in MCP tools
- All tools take `teamName` + `claudeDir` as context parameters

#### Layer 6: HTTP Control API (2/10 coupling)
- `src/main/http/teams.ts` — REST API for `POST /api/teams/:teamName/launch` and `/stop`
- `TeamControlApiState.ts` — publishes control endpoint to `~/.claude/team-control-api.json`
- Thin wrapper over `TeamProvisioningService` — the provisioning itself is Claude-coupled, but the HTTP API shape is generic

---

## Approach Evaluation

### 1. Mastra (TS-native orchestration framework)

**Confidence: 4/10 | Reliability: 5/10**

- **What it is**: Full TS-native agent framework with workflows, tools, memory, RAG
- **Effort**: 8-12 weeks
- **What breaks**: Everything. Mastra has its own agent lifecycle, tool system, and workflow engine. Our entire `TeamProvisioningService` (8K LOC), `TeamDataService` (2K LOC), prompt engineering, stream-json protocol, inbox system, kanban logic would need to be replaced or wrapped
- **What stays**: UI components (renderer), shared types, some utility code
- **Reusable code**: ~20% (UI, types, file watching)
- **Risk**: Very High. Mastra is designed for API-based agents (OpenAI, Anthropic API), not CLI-based agents. Claude Code Agent Teams runs as a CLI process with stream-json — Mastra has no concept of this. Would require either:
  - Abandoning Claude Code CLI in favor of raw Anthropic API calls (losing Agent Teams, built-in tools, session persistence)
  - Building a massive adapter layer to make Claude Code CLI look like a Mastra "agent"
- **Quality**: Medium. Multi-provider support would be good, but we'd lose all Claude Code-specific features that make the product unique
- **Verdict**: Massive rewrite for uncertain benefit. Our product IS Claude Code Agent Teams UI — Mastra would replace the foundation

### 2. MCO (dispatch layer)

**Confidence: 3/10 | Reliability: 4/10**

- **What it is**: Lightweight dispatch layer for routing tasks to different agent providers
- **Effort**: 6-8 weeks
- **What breaks**: Same fundamental problem as Mastra — MCO dispatches to "agents" but doesn't understand Claude Code's CLI protocol, stream-json, Agent Teams, or our inbox system
- **What stays**: Data layer, UI, some services
- **Reusable code**: ~30%
- **Risk**: High. MCO is minimal and would require us to build most of the integration ourselves anyway
- **Quality**: Low-Medium. MCO is too thin to solve the real problems (protocol translation, process management, prompt adaptation)
- **Verdict**: All the work of a custom solution without the benefit of framework support

### 3. Overstory Pattern (AgentRuntime interface + SQLite mail)

**Confidence: 5/10 | Reliability: 6/10**

- **What it is**: Abstract `AgentRuntime` interface with SQLite-backed message queue
- **Effort**: 6-10 weeks
- **What breaks**: Process management, protocol layer, prompt engineering
- **What stays**: UI, kanban logic, data layer structure (would migrate from JSON files to SQLite)
- **Reusable code**: ~35%
- **Risk**: High. Major architectural change (JSON files -> SQLite, inbox files -> SQLite mail queue). All of `TeamProvisioningService` would need rewriting for each provider
- **Quality**: Good long-term architecture, but:
  - We already HAVE a working message system (JSON inbox files + file watchers)
  - SQLite migration would break compatibility with Claude Code CLI's native file format
  - Claude Code reads/writes `~/.claude/teams/<name>/inboxes/<member>.json` directly — switching to SQLite means Claude Code can't participate without a shim
- **Verdict**: Architecturally elegant but fights against Claude Code's native file-based protocol

### 4. mozilla/any-agent (meta-framework)

**Confidence: 3/10 | Reliability: 3/10**

- **What it is**: Python meta-framework to switch agent providers via config
- **Effort**: 10-14 weeks
- **What breaks**: Language barrier — our entire codebase is TypeScript/Electron. any-agent is Python
- **What stays**: UI (renderer)
- **Reusable code**: ~15% (UI only)
- **Risk**: Very High. Would need either:
  - Python backend + IPC bridge to Electron renderer (architectural nightmare)
  - Port any-agent concepts to TypeScript (then it's really option 5)
- **Quality**: Theoretically good multi-provider support, but wrong language ecosystem
- **Verdict**: Non-starter for a TypeScript/Electron project

### 5. Our own AgentRuntime abstraction

**Confidence: 6/10 | Reliability: 7/10**

- **What it is**: Custom `AgentRuntime` interface inspired by the patterns above, implemented in TypeScript
- **Effort**: 8-12 weeks for full implementation, 4-6 weeks for MVP
- **What breaks**: `TeamProvisioningService` would be refactored into multiple provider-specific implementations
- **What stays**: Data layer (`agent-teams-controller`, TeamDataService, MCP server), UI, kanban, review, cross-team
- **Reusable code**: ~55-60%
- **Risk**: Medium-High. The abstraction must account for fundamentally different agent lifecycles:
  - Claude Code: CLI process, stream-json, Agent Teams built-in, teammate spawning via Task tool
  - Codex: subprocess, different CLI protocol, no native team tools
  - Gemini CLI: yet another protocol
  - API-based agents: HTTP calls, no process management at all
- **Quality**: Could be excellent if done right. But the abstraction boundary is extremely hard to get right because Claude Code's Agent Teams is so deeply integrated
- **Key interfaces needed**:

```typescript
interface AgentRuntime {
  name: string;
  spawn(config: AgentSpawnConfig): Promise<AgentProcess>;
  sendMessage(process: AgentProcess, message: string): Promise<void>;
  parseOutput(line: string): ParsedAgentOutput;
  kill(process: AgentProcess): void;
  checkAuth(): Promise<AuthStatus>;
  buildPrompt(context: PromptContext): string;
}

interface AgentProcess {
  pid: number;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: 'exit', handler: (code: number) => void): void;
}
```

- **The hard part**: `TeamProvisioningService` is 7,982 LOC of deeply intertwined logic. Splitting it into provider-agnostic + provider-specific parts is a multi-week refactoring effort. The `handleStreamJsonMessage()` method alone (lines 4858-5294) handles 15+ message types with side effects throughout
- **Verdict**: Right direction, but expensive and risky as a first step

### 6. MCP-Based Approach (expose kanban as MCP server for external agents)

**Confidence: 8/10 | Reliability: 8/10**

- **What it is**: Enhance our existing MCP server so external agents (Codex, Gemini, any MCP-capable agent) connect TO us and use our kanban, tasks, messages, review system
- **Effort**: 2-3 weeks
- **What breaks**: Nothing. This is additive
- **What stays**: Everything. 100% of existing code remains unchanged
- **Reusable code**: 100%
- **Risk**: Low. We already have a working MCP server with 30+ tools
- **Quality**: Surprisingly good for the effort level. Here's why:
  - **MCP is a cross-vendor standard** — Codex, Gemini CLI, Cursor, and many others already support MCP
  - **Our MCP server already exposes the full API**: tasks, kanban, review, messages, cross-team, processes
  - **External agents don't need our prompts** — they bring their own intelligence. They just need tools to interact with our kanban board
  - **The user experience is**: open our app, see the kanban board, agents from different providers create tasks, update statuses, send messages, request reviews — all visible on the same board

What's missing from the current MCP server for this to work:
1. **Team creation/config via MCP** — currently only `team_launch`/`team_stop` exist as runtime tools; need `team_create_config` MCP tool
2. **Member registration via MCP** — external agents need to register themselves as team members without Claude Code's `TeamCreate` built-in
3. **Agent identification** — MCP tools need a way for agents to identify themselves (which provider, which model)
4. **Task assignment notifications** — when a task is assigned to an external agent, something needs to notify that agent (webhook? polling? SSE?)
5. **Standalone MCP server mode** — currently our MCP server is spawned as a child process by `TeamMcpConfigBuilder`. For external agents, it needs to run standalone (it already can via `agent-teams-mcp` bin)

- **Verdict**: Best bang for the buck. Low risk, high reuse, ships fast, provider-agnostic by design

### 7. Hybrid: Native Claude Code + MCP Server for Others (RECOMMENDED)

**Confidence: 9/10 | Reliability: 9/10**

- **What it is**: Keep Claude Code Agent Teams as the primary (optimized) path. Enhance MCP server as the universal integration point for all other agents. Eventually, even Claude Code agents could use MCP tools (they already do via `--mcp-config`)
- **Effort**: 3-4 weeks for Phase 1, incremental thereafter
- **What breaks**: Nothing
- **What stays**: Everything
- **Reusable code**: 100%
- **Risk**: Very Low

#### Why this is the right answer

1. **We already have 90% of the infrastructure**:
   - `mcp-server/` with 30+ tools covering tasks, kanban, review, messages, cross-team, processes
   - `agent-teams-controller` as provider-agnostic data layer
   - HTTP control API for launch/stop
   - File watcher system that detects changes from ANY source (not just Claude Code)

2. **Claude Code is our strongest path — don't break it**:
   - `TeamProvisioningService` (8K LOC) is battle-tested, handles edge cases (auth retry, stall detection, post-compact context recovery, tool approval)
   - The prompt engineering works. It took months to tune delegation-first behavior, task board discipline, review workflow, cross-team messaging
   - Replacing this with a generic abstraction would lose all these optimizations

3. **MCP is the industry standard for tool interop**:
   - Claude Code already uses our MCP tools via `--mcp-config`
   - OpenAI Codex supports MCP (announced 2025)
   - Google Gemini supports MCP
   - Cursor/Windsurf support MCP
   - Any MCP-capable agent can connect today

4. **The prompt is NOT a blocker for other agents**:
   - Our prompts teach Claude Code agents how to use MCP tools (`task_create`, `kanban_set_column`, etc.)
   - External agents using MCP don't need our prompts — MCP tool descriptions ARE the prompt
   - Each MCP tool already has a `description` field that tells any agent what it does

5. **Incremental delivery**:
   - Phase 1: Publish `agent-teams-mcp` as standalone npm package, add missing tools
   - Phase 2: Add UI support for "external member" type, show provider badge
   - Phase 3: Add notification/polling mechanism for task assignments
   - Phase 4: Optionally abstract `TeamProvisioningService` for a second native provider

---

## Implementation Plan

### Phase 1: MCP Server Enhancement (Week 1-2)

**Goal**: Any MCP-capable agent can join an existing team and work on tasks.

New MCP tools to add to `mcp-server/src/tools/`:

```
team_join            — register external agent as team member
team_leave           — unregister from team
team_list_teams      — discover available teams
team_get_config      — get team configuration
member_register      — register with provider/model metadata
member_heartbeat     — keepalive for external agents
task_poll_assigned   — poll for newly assigned tasks (for agents without push)
task_claim           — claim an unassigned task
```

Files to modify:
- `mcp-server/src/tools/index.ts` — register new tool modules
- `mcp-server/src/tools/memberTools.ts` — NEW: member lifecycle tools
- `mcp-server/src/tools/teamDiscoveryTools.ts` — NEW: team discovery
- `mcp-server/package.json` — prepare for standalone npm publish
- `mcp-server/src/agent-teams-controller.d.ts` — extend controller types if needed

Files unchanged (0 modifications to core):
- `src/main/services/team/TeamProvisioningService.ts` — untouched
- `src/main/services/team/TeamDataService.ts` — untouched
- `src/main/ipc/teams.ts` — untouched
- All prompt engineering — untouched

### Phase 2: UI Support for External Agents (Week 2-3)

**Goal**: External agents appear on the kanban board with provider badges.

- `src/shared/types/team.ts` — add `provider?: string`, `model?: string` to `TeamMember`
- `src/renderer/components/team/` — show provider icon/badge next to member name
- `src/main/services/team/TeamDataService.ts` — recognize external members in data reads
- File watchers already detect changes from any source — no changes needed

### Phase 3: Notification Mechanism (Week 3-4)

**Goal**: External agents get notified of task assignments without polling.

Options (ranked):
1. **SSE endpoint** — `GET /api/teams/:teamName/events` — server-sent events for task changes. Reliability: 8/10, Confidence: 8/10
2. **Webhook** — configure callback URL per member. Reliability: 7/10, Confidence: 7/10
3. **Polling** — `task_poll_assigned` MCP tool (already planned in Phase 1). Reliability: 9/10, Confidence: 9/10

Recommend: Start with polling (simplest), add SSE later.

### Phase 4: Optional Native Provider (Week 6+, if demand exists)

**Goal**: Add a second native CLI provider (e.g., Codex) with process management.

Only NOW would we extract the `AgentRuntime` abstraction from option 5, but scoped:
- Extract binary resolution from `ClaudeBinaryResolver` into `CliProvider` interface
- Extract process spawn from `TeamProvisioningService.createTeam()`/`launchTeam()` into provider-specific implementations
- Keep `TeamProvisioningService` as `ClaudeProvisioningService` (rename)
- Create `CodexProvisioningService` implementing same interface

This is the expensive part (6-8 weeks), but by Phase 4 we'll know if there's actual demand.

---

## Comparison Table

| Criterion | Mastra | MCO | Overstory | any-agent | AgentRuntime | MCP-Only | **Hybrid** |
|---|---|---|---|---|---|---|---|
| Effort (weeks) | 8-12 | 6-8 | 6-10 | 10-14 | 8-12 | 2-3 | **3-4** |
| Code reuse | 20% | 30% | 35% | 15% | 55% | 100% | **100%** |
| Risk | Very High | High | High | Very High | Medium-High | Low | **Very Low** |
| Breaks existing? | Yes | Yes | Yes | Yes | Partially | No | **No** |
| Multi-provider quality | Good | Low-Med | Good | Good | Good | Good | **Good** |
| Incremental? | No | No | No | No | Partially | Yes | **Yes** |
| Ships fast? | No | No | No | No | No | Yes | **Yes** |
| Keeps Claude optimized? | No | No | No | No | Partially | Yes | **Yes** |
| Industry standard? | Custom | Custom | Custom | Python | Custom | MCP | **MCP** |
| Confidence | 4/10 | 3/10 | 5/10 | 3/10 | 6/10 | 8/10 | **9/10** |
| Reliability | 5/10 | 4/10 | 6/10 | 3/10 | 7/10 | 8/10 | **9/10** |

---

## Prompt Engineering Analysis

### What percentage is Claude-specific vs generic?

| Prompt Section | Claude-Specific? | LOC | Purpose |
|---|---|---|---|
| `buildProvisioningPrompt()` | **100% Claude** | ~95 | Uses TeamCreate built-in, Task tool for spawning |
| `buildMemberSpawnPrompt()` | **30% Claude** | ~35 | MCP tool calls are generic; `Task tool` spawn is Claude |
| `buildPersistentLeadContext()` | **20% Claude** | ~100 | Constraints are generic; `TeamCreate`/`TeamDelete` refs are Claude |
| `buildTeamCtlOpsInstructions()` | **0% Claude** | ~100 | Pure MCP tool examples — any agent can use these |
| `buildActionModeProtocol()` | **0% Claude** | ~30 | Generic action mode behavior |
| `buildAgentBlockUsagePolicy()` | **50% Claude** | ~30 | Agent block format is Claude-specific; concept is generic |
| `buildReconnectMemberSpawnPrompt()` | **30% Claude** | ~50 | Similar to spawn prompt |

**Overall**: ~35% of prompt content is Claude-specific (spawning, built-in tools). ~65% is generic task management behavior that any agent needs (use MCP tools, update task status, post comments before completing, notify lead after completion).

**For MCP-based external agents**: The MCP tool `description` fields already serve as the "prompt". External agents don't need our big prompt — they discover tools via MCP protocol and use tool descriptions. The only thing missing is a "bootstrap briefing" MCP tool that gives a new agent its role, workflow instructions, and team context — and we already have `member_briefing` for this.

---

## Risk Analysis for Recommended Approach (Hybrid)

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| MCP adoption stalls | Low | Medium | MCP is already adopted by Claude, Codex, Gemini, Cursor |
| External agents can't follow task workflow | Medium | Low | `member_briefing` provides onboarding; tool descriptions guide behavior |
| Performance with many external agents | Low | Medium | MCP server is lightweight; file I/O is the bottleneck (same as now) |
| Breaking changes in MCP protocol | Very Low | High | MCP spec is stable (v1.0+), FastMCP library handles protocol |
| External agent quality varies | High | Medium | This is a feature, not a bug — user chooses which agents to use |
| Path coupling (`~/.claude/`) | Low | Low | `claudeDir` parameter already supported in all MCP tools |

---

## Final Recommendation

**Go with Option 7: Hybrid (Claude Code native + MCP for others).**

Reasoning:
1. **Zero risk to existing product** — nothing changes for Claude Code users
2. **Fastest time to market** — 3-4 weeks for meaningful multi-provider support
3. **100% code reuse** — no refactoring, no migration, no breaking changes
4. **Industry standard** — MCP is the protocol all major AI tools are converging on
5. **Natural evolution** — Phase 4 (native providers) can happen later if justified by demand
6. **Our MCP server already works** — 30+ tools, battle-tested with Claude Code Agent Teams
7. **Competitive advantage** — no one else has a kanban board + MCP server combination

The key insight is: **we don't need to abstract our process management layer to support multiple providers**. Instead, we expose our **data layer** (tasks, kanban, reviews, messages) via MCP, and let each agent provider bring their own process management. Our app becomes the **collaboration hub** — the kanban board where all agents converge, regardless of provider.

---

## Appendix: Key Source Files Referenced

| File | LOC | Role |
|---|---|---|
| `src/main/services/team/TeamProvisioningService.ts` | 7,982 | Process lifecycle, prompt engineering, stream-json protocol |
| `src/main/services/team/TeamDataService.ts` | 1,953 | Data reads, controller integration |
| `src/main/ipc/teams.ts` | 2,973 | IPC handlers for all team operations |
| `src/main/services/team/ClaudeBinaryResolver.ts` | 292 | Claude binary resolution |
| `src/main/services/team/TeamInboxWriter.ts` | 80+ | File-based inbox writes |
| `src/main/services/team/TeamMcpConfigBuilder.ts` | 228 | MCP config generation for Claude |
| `src/main/services/team/CrossTeamService.ts` | 60+ | Cross-team messaging |
| `src/main/services/team/actionModeInstructions.ts` | 51 | Action mode protocol |
| `src/main/http/teams.ts` | 160+ | HTTP control API |
| `src/main/utils/childProcess.ts` | 182 | CLI spawn/kill utilities |
| `mcp-server/src/index.ts` | 24 | MCP server entry |
| `mcp-server/src/controller.ts` | 19 | Controller factory |
| `mcp-server/src/tools/taskTools.ts` | 501 | Task MCP tools |
| `mcp-server/src/tools/kanbanTools.ts` | 82 | Kanban MCP tools |
| `mcp-server/src/tools/reviewTools.ts` | 104 | Review MCP tools |
| `mcp-server/src/tools/messageTools.ts` | 60 | Message MCP tools |
| `mcp-server/src/tools/processTools.ts` | 89 | Process MCP tools |
| `mcp-server/src/tools/crossTeamTools.ts` | 81 | Cross-team MCP tools |
| `mcp-server/src/tools/runtimeTools.ts` | 78 | Runtime MCP tools |
| `src/types/agent-teams-controller.d.ts` | 101 | Controller type definitions |
| `src/shared/types/team.ts` | 100+ | Shared team types |
