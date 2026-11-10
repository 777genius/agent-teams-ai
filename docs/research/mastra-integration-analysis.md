# Mastra Integration Analysis

> Technical feasibility study for integrating Mastra (TypeScript agent framework) with Claude Agent Teams UI.
> Date: 2026-03-24

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Mastra Architecture Overview](#mastra-architecture-overview)
3. [Our Codebase Architecture](#our-codebase-architecture)
4. [Integration Points Analysis](#integration-points-analysis)
5. [Concrete Integration Approaches](#concrete-integration-approaches)
6. [Architecture Diagram](#architecture-diagram)
7. [What Stays the Same](#what-stays-the-same)
8. [What Must Change](#what-must-change)
9. [Effort Estimate](#effort-estimate)
10. [Risks and Blockers](#risks-and-blockers)
11. [Recommendations](#recommendations)
12. [Sources](#sources)

---

## Executive Summary

Mastra is a TypeScript-first agent framework (22K+ stars, $13M seed, YC-backed) from the Gatsby team. It provides unified primitives for agents, tools, workflows, RAG, and multi-agent orchestration with 40+ LLM provider support.

**Key finding: Mastra operates at a fundamentally different level than Claude CLI.** Our app is a process manager and UI for Claude Code CLI sessions. Mastra is an SDK for building agents programmatically. Integration is possible but requires a significant architectural shift — specifically, replacing Claude CLI process management with in-process Mastra agent runtime.

**Verdict: 6/10 feasibility, 4/10 reliability of quick integration.** The integration is architecturally sound but represents 6-10 person-weeks of work with significant risk to our core differentiator (Claude Code CLI features: file editing, terminal, git, Agent tool for spawning teammates).

---

## Mastra Architecture Overview

### Core Packages

| Package | Purpose |
|---------|---------|
| `@mastra/core` | Agent, Workflow, Tool, Server, Storage, Vector, DI |
| `@mastra/mcp` | MCPClient (consume) + MCPServer (expose) |
| `@mastra/ai-sdk` | AI SDK v5 compatibility layer |
| `@mastra/client-js` | HTTP client for remote Mastra servers |
| `mastra` | CLI for project scaffolding |

### Agent Definition

```typescript
import { Agent } from '@mastra/core/agent';
import { MCPClient } from '@mastra/mcp';

const agent = new Agent({
  id: 'team-lead',
  name: 'Team Lead',
  instructions: 'You coordinate the team...',
  model: 'anthropic/claude-sonnet-4-20250514',  // any of 40+ providers
  tools: { taskCreate, taskUpdate, sendMessage },
});

// Usage
const result = await agent.generate('Create tasks for the frontend sprint');
const stream = await agent.stream('Review the PR');
```

### Multi-Agent: Supervisor Pattern (recommended as of Feb 2026)

```typescript
const researcher = new Agent({
  id: 'researcher',
  description: 'Researches technical topics',
  model: 'anthropic/claude-sonnet-4-20250514',
  tools: { webSearch, readFile },
});

const developer = new Agent({
  id: 'developer',
  description: 'Implements code changes',
  model: 'anthropic/claude-sonnet-4-20250514',
  tools: { editFile, runTests, bash },
});

const supervisor = new Agent({
  id: 'supervisor',
  name: 'Team Lead',
  instructions: 'Coordinate researcher and developer...',
  model: 'anthropic/claude-sonnet-4-20250514',
  agents: { researcher, developer },  // auto-converted to tools
  memory: new Memory(),
});

const stream = await supervisor.stream('Fix the authentication bug', {
  maxSteps: 20,
});
```

### MCP Integration

```typescript
import { MCPClient } from '@mastra/mcp';

const mcp = new MCPClient({
  servers: {
    'agent-teams': {
      command: 'node',
      args: ['/path/to/mcp-server/dist/index.js'],
    },
  },
});

const agent = new Agent({
  id: 'worker',
  model: 'anthropic/claude-sonnet-4-20250514',
  instructions: '...',
});

// Dynamic tool injection
const response = await agent.stream('Update task #abc to in_progress', {
  toolsets: await mcp.listToolsets(),
});
```

---

## Our Codebase Architecture

### Process Management Layer (Claude-specific)

The core of our backend is `TeamProvisioningService` — an 8000+ line service that manages Claude CLI processes.

**Key file**: `src/main/services/team/TeamProvisioningService.ts`

Core flow:
1. **Resolve Claude binary** via `ClaudeBinaryResolver`
2. **Build provisioning prompt** (~100 lines of structured instructions) via `buildProvisioningPrompt()`
3. **Spawn CLI process** with stream-json protocol:
   ```
   spawnCli(claudePath, [
     '--input-format', 'stream-json',
     '--output-format', 'stream-json',
     '--verbose',
     '--mcp-config', mcpConfigPath,
     '--disallowedTools', 'TeamDelete,TodoWrite',
     '--dangerously-skip-permissions',
   ])
   ```
4. **Parse stdout** as NDJSON (newline-delimited JSON) — types: `user`, `assistant`, `control_request`, `result`, `system`
5. **Send input via stdin** using stream-json protocol: `{"type":"user","message":{"role":"user","content":[...]}}\n`
6. **Monitor filesystem** for team config, tasks, inboxes written by CLI
7. **Relay messages** between lead and teammates via inbox files

**Key file**: `src/main/utils/childProcess.ts` — `spawnCli()` and `execCli()` wrappers with Windows shell fallback and EINVAL handling.

### Prompt/Instruction System

The prompt system is deeply intertwined with Claude Code's native capabilities:

**`buildProvisioningPrompt()`** (line ~860) constructs a multi-section prompt:
- Team identity (name, project, lead)
- Step 1: Call **BUILT-IN TeamCreate tool** (Claude Code native)
- Step 2: Spawn teammates via **Agent tool** (Claude Code native) with `team_name` parameter
- Step 3: Create tasks via **MCP board tools**
- Persistent lead context: communication protocol, board MCP operations, agent block policy

**`buildMemberSpawnPrompt()`** (line ~444) constructs per-teammate instructions:
- Role and workflow injection
- `member_briefing` MCP bootstrap call
- Task lifecycle protocol (comment -> start -> work -> comment -> complete)
- Detailed notification/escalation rules

**Critical Claude-specific constructs in prompts:**
- `Agent` tool with `team_name` parameter — Claude Code's native teammate spawning
- `TeamCreate` built-in tool — Claude Code's team lifecycle management
- `SendMessage` built-in tool — Claude Code's inter-agent messaging
- `--disallowedTools TeamDelete,TodoWrite` — Claude Code CLI flags
- `--permission-mode bypassPermissions` — Claude Code permission system
- stream-json protocol for bidirectional communication
- Post-compact context reinjection for context window management

### MCP Server

**Key files**: `mcp-server/src/` (16 TypeScript files)

Our MCP server (FastMCP-based) exposes domain tools to agents:

| Tool Domain | Tools | File |
|------------|-------|------|
| Tasks | task_create, task_get, task_list, task_start, task_complete, etc. | `taskTools.ts` |
| Kanban | kanban_get, kanban_set_column, kanban_clear | `kanbanTools.ts` |
| Review | review_request, review_approve, review_request_changes | `reviewTools.ts` |
| Messages | send messages between agents | `messageTools.ts` |
| Process | process management | `processTools.ts` |
| Cross-team | cross_team_send, cross_team_list_targets | `crossTeamTools.ts` |
| Runtime | runtime state queries | `runtimeTools.ts` |

All tools delegate to `agent-teams-controller` — a workspace package that manages team state (config.json, tasks/, inboxes/).

### Message Parsing Pipeline

**Key files**:
- `src/main/types/jsonl.ts` — Raw JSONL format types (Claude Code session files)
- `src/main/types/messages.ts` — ParsedMessage with type guards
- `src/main/services/analysis/ChunkBuilder.ts` — Builds timeline chunks from parsed messages

The JSONL parsing is tightly coupled to Claude Code's output format:
- Entry types: `user`, `assistant`, `system`, `summary`, `file-history-snapshot`, `queue-operation`
- Content blocks: `text`, `thinking`, `tool_use`, `tool_result`, `image`
- Usage metadata: `input_tokens`, `output_tokens`, `cache_read_input_tokens`
- Claude-specific fields: `model`, `stop_reason`, `cwd`, `gitBranch`, `agentId`, `isSidechain`

### IPC Layer

**Key file**: `src/main/ipc/teams.ts` — 60+ IPC channels for team operations

The renderer communicates with main process via Electron IPC. The channels include team CRUD, task management, message sending, provisioning control, tool approval, and process lifecycle.

---

## Integration Points Analysis

### 1. Process Spawning — Claude CLI vs Mastra Agent Runtime

| Aspect | Current (Claude CLI) | Mastra Integration |
|--------|---------------------|-------------------|
| **Runtime** | External process (`claude` binary) | In-process Node.js (`Agent.stream()`) |
| **Protocol** | stream-json over stdin/stdout | Programmatic TypeScript API |
| **Agent spawning** | `Agent` tool with `team_name` param | `new Agent({ agents: {...} })` supervisor pattern |
| **Tool execution** | Claude Code built-in + MCP | Mastra tools + `@mastra/mcp` MCPClient |
| **File editing** | Claude Code's built-in file tools | Must provide custom tools (Read, Write, Bash) |
| **Terminal** | Claude Code's built-in terminal | Must provide custom Bash tool |
| **Git** | Claude Code's built-in git support | Must provide custom git tools |
| **Context window** | Claude Code manages (200K) | Mastra manages via provider settings |

**Claude-specificity score: 9/10** — This is the most tightly coupled area.

### 2. Prompt/Instruction System

| Aspect | Current | Mastra Equivalent |
|--------|---------|-------------------|
| System prompt | Injected via stream-json first message | `Agent.instructions` property |
| Dynamic instructions | Post-compact reinjection via stdin | `instructions` as function returning dynamic text |
| Built-in tools refs | `TeamCreate`, `Agent`, `SendMessage` in prompt | Must be replaced with Mastra tool calls |
| MCP tool refs | `task_create { teamName: "..." }` | Same MCP tools via `@mastra/mcp` MCPClient |

**Claude-specificity score: 7/10** — Prompts reference Claude Code native tools extensively.

### 3. MCP Server

| Aspect | Current | Mastra Integration |
|--------|---------|-------------------|
| Server framework | FastMCP (stdio transport) | Same — OR convert to Mastra tools directly |
| Tool definitions | `server.addTool({ name, parameters, execute })` | `createTool({ id, inputSchema, execute })` |
| Transport | stdio (spawned by Claude CLI) | Could use `@mastra/mcp` MCPClient or convert to native Mastra tools |
| Controller | `agent-teams-controller` package | **Unchanged** — pure JS, no Claude dependency |

**Claude-specificity score: 2/10** — MCP is provider-agnostic. Our `agent-teams-controller` is pure business logic.

### 4. Message Parsing / JSONL Pipeline

| Aspect | Current | Mastra Integration |
|--------|---------|-------------------|
| Session storage | `~/.claude/projects/{path}/*.jsonl` | Mastra has its own storage/memory system |
| Format | Claude Code JSONL (specific schema) | Mastra streaming chunks (text-delta, tool-call, etc.) |
| Type guards | `isParsedRealUserMessage`, etc. | New type guards for Mastra output format |
| Chunk building | `ChunkBuilder` from JSONL messages | New adapter from Mastra stream events |
| Subagent detection | `SubagentResolver` from tool_use content | Mastra supervisor tracks sub-agent calls natively |

**Claude-specificity score: 8/10** — The entire analysis pipeline assumes Claude Code JSONL format.

### 5. Team Lifecycle (config, inboxes, tasks)

| Aspect | Current | Mastra Integration |
|--------|---------|-------------------|
| Team config | `~/.claude/teams/{name}/config.json` (Claude CLI creates) | Must be managed by our app directly |
| Task storage | `~/.claude/tasks/{name}/` (agent-teams-controller) | **Unchanged** |
| Inbox messaging | `~/.claude/teams/{name}/inboxes/{member}.json` | Replace with Mastra memory or direct tool calls |
| Cross-team comms | Inbox files with relay | Mastra agents can call each other directly |

**Claude-specificity score: 6/10** — File-based coordination is Claude CLI convention, but our controller is independent.

---

## Concrete Integration Approaches

### Approach A: Mastra as Agent Runtime (Replace Claude CLI)

**Confidence: 5/10 | Reliability: 4/10**

Replace `spawnCli()` with in-process Mastra agents. The lead becomes a `supervisor` Agent, teammates become sub-agents.

```typescript
// src/main/services/team/MastraTeamRuntime.ts (new file)
import { Agent } from '@mastra/core/agent';
import { MCPClient } from '@mastra/mcp';
import { createTool } from '@mastra/core/tools';

// Convert our MCP tools to native Mastra tools
const taskCreateTool = createTool({
  id: 'task_create',
  description: 'Create a team task',
  inputSchema: z.object({
    teamName: z.string(),
    subject: z.string(),
    description: z.string().optional(),
    owner: z.string().optional(),
  }),
  execute: async (input) => {
    const controller = getController(input.teamName);
    return controller.tasks.createTask(input);
  },
});

// File editing tool (replaces Claude Code built-in)
const editFileTool = createTool({
  id: 'edit_file',
  description: 'Edit a file on disk',
  inputSchema: z.object({
    path: z.string(),
    oldText: z.string(),
    newText: z.string(),
  }),
  execute: async (input) => {
    // Must implement file editing logic ourselves
    const content = await fs.promises.readFile(input.path, 'utf8');
    const updated = content.replace(input.oldText, input.newText);
    await fs.promises.writeFile(input.path, updated);
    return { success: true };
  },
});

// Bash tool (replaces Claude Code built-in)
const bashTool = createTool({
  id: 'bash',
  description: 'Execute a bash command',
  inputSchema: z.object({ command: z.string() }),
  execute: async (input) => {
    const { stdout, stderr } = await execAsync(input.command);
    return { stdout, stderr };
  },
});

// Create teammate agents
function createTeammateAgent(member: TeamMember, teamTools: Record<string, Tool>) {
  return new Agent({
    id: `teammate-${member.name}`,
    name: member.name,
    description: member.role || 'Team member',
    instructions: buildMemberInstructions(member),  // adapted from buildMemberSpawnPrompt
    model: 'anthropic/claude-sonnet-4-20250514',
    tools: {
      ...teamTools,
      editFileTool,
      bashTool,
      readFileTool,
      // ... other dev tools
    },
  });
}

// Create supervisor (lead) agent
function createLeadAgent(
  request: TeamCreateRequest,
  teammates: Record<string, Agent>
) {
  return new Agent({
    id: `lead-${request.teamName}`,
    name: 'team-lead',
    instructions: buildLeadInstructions(request),  // adapted from buildPersistentLeadContext
    model: request.model || 'anthropic/claude-sonnet-4-20250514',
    agents: teammates,  // Mastra auto-converts to tools
    tools: {
      ...teamTools,  // task_create, kanban_get, etc.
      editFileTool,
      bashTool,
      readFileTool,
    },
    memory: new Memory(),
  });
}
```

**What breaks:**
- Claude Code's file editing (diff view, permission system) — must reimplement
- Claude Code's terminal integration
- Claude Code's git support
- Claude Code's extended thinking
- Claude Code's session persistence/resume
- The entire JSONL parsing pipeline
- Tool approval flow (our `control_request` handling)
- Post-compact context reinjection

### Approach B: Mastra as Middleware / Orchestration Layer (Keep Claude CLI)

**Confidence: 7/10 | Reliability: 6/10**

Use Mastra as an orchestration layer that manages routing and coordination, while still spawning Claude CLI processes for actual work.

```typescript
// src/main/services/team/MastraOrchestrator.ts (new file)
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';

// Tool that spawns a Claude CLI process for actual work
const claudeCliTool = createTool({
  id: 'claude_cli_execute',
  description: 'Execute a task using Claude Code CLI',
  inputSchema: z.object({
    prompt: z.string(),
    cwd: z.string(),
    model: z.string().optional(),
  }),
  execute: async (input) => {
    // Spawn Claude CLI with -p (one-shot)
    const result = await execCli(claudePath, [
      '-p', input.prompt,
      '--output-format', 'text',
      ...(input.model ? ['--model', input.model] : []),
    ], { cwd: input.cwd });
    return { output: result.stdout };
  },
});

// Mastra agent for high-level orchestration
const orchestrator = new Agent({
  id: 'orchestrator',
  name: 'Task Orchestrator',
  instructions: `You coordinate a development team.
    Use claude_cli_execute for actual coding tasks.
    Use task tools for board management.`,
  model: 'anthropic/claude-sonnet-4-20250514',
  tools: {
    claudeCliTool,
    ...teamBoardTools,
  },
});

// Orchestrator decides what to do, Claude CLI does the coding
const stream = await orchestrator.stream(userMessage);
```

**What this preserves:**
- Claude CLI's file editing, terminal, git, etc.
- Our existing JSONL pipeline (for CLI-executed tasks)
- MCP server tools (used by CLI processes)

**What this adds:**
- Model-agnostic orchestration layer
- Ability to use OpenAI/Gemini/etc. for routing decisions
- Mastra's workflow engine for deterministic task flows

**What breaks / gets complex:**
- Two runtime models (Mastra in-process + Claude CLI processes)
- Doubled complexity for message flow
- Unclear who "owns" the conversation state

### Approach C: Mastra MCP Bridge (Minimal Integration)

**Confidence: 8/10 | Reliability: 7/10**

Use `@mastra/mcp` MCPServer to expose our existing tools to any Mastra-compatible client, and `@mastra/mcp` MCPClient to consume external MCP tools.

```typescript
// mcp-server/src/mastra-bridge.ts (new file)
import { MCPServer } from '@mastra/mcp';
import { Agent } from '@mastra/core/agent';
import { registerTools } from './tools';

// Expose our existing tools as an MCP server that Mastra agents can consume
const mcpServer = new MCPServer({
  name: 'agent-teams-mcp',
  version: '1.0.0',
  tools: {
    // Convert FastMCP tools to Mastra tools, or expose via MCP protocol
    ...convertFastMcpToMastraTools(registerTools),
  },
});

// Any Mastra agent can now use our board tools
const externalAgent = new Agent({
  id: 'external-worker',
  model: 'openai/gpt-4o',
  instructions: 'You manage tasks on the team board.',
  tools: await new MCPClient({
    servers: {
      'agent-teams': {
        command: 'node',
        args: ['path/to/mcp-server/dist/index.js'],
      },
    },
  }).listTools(),
});
```

**What this preserves:**
- Everything — this is additive, not replacement
- Claude CLI remains the primary runtime

**What this adds:**
- Mastra agents can interact with our board
- Path to multi-provider support
- Future extensibility

---

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                     Electron App (Renderer)                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐    │
│  │  Kanban   │  │ Timeline │  │  Inbox   │  │ Code Editor   │    │
│  │  Board    │  │  View    │  │  Chat    │  │ (Diff View)   │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────┬───────┘    │
│       └──────────────┴─────────────┴────────────────┘            │
│                              │ IPC                                │
└──────────────────────────────┼───────────────────────────────────┘
                               │
┌──────────────────────────────┼───────────────────────────────────┐
│                     Electron App (Main)                           │
│                              │                                    │
│  ┌───────────────────────────┴──────────────────────────────┐    │
│  │              IPC Handler Layer (teams.ts)                  │    │
│  └───────────────────────────┬──────────────────────────────┘    │
│                              │                                    │
│  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐   │
│          MASTRA MIDDLEWARE LAYER (Approach B / Future)            │
│  │  ┌─────────────────┐    │    ┌─────────────────────┐    │   │
│     │  Mastra Agent    │    │    │  Mastra Workflow    │         │
│  │  │  (Orchestrator)  │    │    │  (Task Routing)     │    │   │
│     │  model-agnostic  │    │    │  DAG execution      │         │
│  │  └────────┬─────────┘    │    └──────────┬──────────┘    │   │
│              │              │               │                    │
│  └ ─ ─ ─ ─ ─┼─ ─ ─ ─ ─ ─ ─┼─ ─ ─ ─ ─ ─ ─ ┼─ ─ ─ ─ ─ ─ ─ ┘   │
│              │              │               │                    │
│  ┌───────────┴──────────────┴───────────────┴──────────────┐    │
│  │          TeamProvisioningService (existing)              │    │
│  │  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │    │
│  │  │ spawnCli()  │  │ stream-json  │  │ FS monitor    │  │    │
│  │  │ (Claude CLI)│  │ parser       │  │ (tasks/inbox) │  │    │
│  │  └──────┬──────┘  └──────┬───────┘  └───────┬───────┘  │    │
│  └─────────┼────────────────┼───────────────────┼──────────┘    │
│            │                │                   │                │
│  ┌─────────┴────────────────┴───────────────────┴──────────┐    │
│  │              agent-teams-controller (pure JS)            │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │    │
│  │  │ Tasks    │  │ Kanban   │  │ Inbox    │  │ Config │  │    │
│  │  │ CRUD     │  │ State    │  │ Messages │  │ Reader │  │    │
│  │  └──────────┘  └──────────┘  └──────────┘  └────────┘  │    │
│  └──────────────────────────────────────────────────────────┘    │
│                              │                                    │
│  ┌──────────────────────────┼───────────────────────────────┐    │
│  │           MCP Server (agent-teams-mcp)                    │    │
│  │  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────────────┐ │    │
│  │  │ Tasks  │  │ Kanban │  │ Review │  │ Messages       │ │    │
│  │  │ Tools  │  │ Tools  │  │ Tools  │  │ & Cross-team   │ │    │
│  │  └────────┘  └────────┘  └────────┘  └────────────────┘ │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    │  Claude CLI Process  │ ← or Mastra agent.stream()
                    │  (stream-json)       │
                    │  ┌────────────────┐  │
                    │  │ File Edit      │  │
                    │  │ Terminal/Bash  │  │
                    │  │ Git            │  │
                    │  │ Agent (spawn)  │  │
                    │  │ SendMessage    │  │
                    │  │ MCP tools      │  │
                    │  └────────────────┘  │
                    └─────────────────────┘
```

---

## What Stays the Same

These modules are **not Claude-specific** and would survive any integration:

| Module | Path | Why |
|--------|------|-----|
| `agent-teams-controller` | `agent-teams-controller/` | Pure JS business logic for tasks, kanban, review, inbox. Zero Claude dependency. |
| MCP Server tools | `mcp-server/src/tools/*.ts` | Standard MCP protocol. Works with any MCP-compatible agent. |
| UI components | `src/renderer/` | React/Zustand/Tailwind. Communicates via IPC, agnostic to backend. |
| IPC layer interface | `src/preload/constants/ipcChannels.ts` | Channel names are just strings. |
| Shared types | `src/shared/types/team.ts` | TeamTask, InboxMessage, etc. — domain types. |
| Team data services | `TeamDataService`, `TeamConfigReader`, `TeamTaskReader` | File-based, read team state from disk. |
| TeamMcpConfigBuilder | `src/main/services/team/TeamMcpConfigBuilder.ts` | Builds MCP config files. Could serve Mastra MCPClient too. |
| Notification system | `NotificationManager` | UI notifications, not Claude-specific. |

---

## What Must Change

### Tier 1: Core Runtime (Required for any Mastra integration)

| File/Module | Lines | Change Required |
|------------|-------|-----------------|
| `TeamProvisioningService.ts` | ~8000 | Major refactor: abstract `AgentRuntime` interface. spawnCli() becomes one implementation, Mastra becomes another. |
| `childProcess.ts` | 220 | Keep as-is for Claude CLI path. New `MastraRuntime.ts` for in-process agents. |
| `ClaudeBinaryResolver.ts` | ~200 | Keep for Claude CLI path. Not needed for Mastra path. |

### Tier 2: Message Parsing (Required for Approach A)

| File/Module | Lines | Change Required |
|------------|-------|-----------------|
| `src/main/types/jsonl.ts` | 200+ | New parallel types for Mastra streaming events. |
| `src/main/types/messages.ts` | 377 | Extend ParsedMessage or create MastraMessage adapter. |
| `ChunkBuilder.ts` | ~600 | Abstract chunk building from JSONL parsing. Mastra adapter produces same chunk types. |
| `SubagentResolver.ts` | ~400 | Mastra supervisor natively tracks sub-agents. Simpler resolver. |
| `SemanticStepExtractor.ts` | ~300 | Mastra tool calls have different structure. Adapter needed. |

### Tier 3: Prompt System (Required for all approaches)

| File/Module | Lines | Change Required |
|------------|-------|-----------------|
| `buildProvisioningPrompt()` | ~100 | Remove Claude-specific steps (TeamCreate, Agent tool). Replace with Mastra tool references. |
| `buildMemberSpawnPrompt()` | ~80 | Convert to Mastra Agent `instructions`. Remove Agent tool spawn references. |
| `buildPersistentLeadContext()` | ~100 | Remove Agent tool references. Keep MCP tool instructions (they still apply). |
| `buildTeamCtlOpsInstructions()` | ~100 | Keep — these reference MCP tools which are provider-agnostic. |
| `actionModeInstructions.ts` | 50 | Keep — action modes are prompt-level, not provider-specific. |

### Tier 4: Tool Approval (Required for Approach A)

| File/Module | Change Required |
|------------|-----------------|
| Tool approval flow | Mastra has its own `requireApproval: true` on tools + `approveToolCall()`/`declineToolCall()`. Must adapt our UI's approval dialog to use Mastra's API instead of `control_request` stream-json messages. |

---

## Effort Estimate

### Approach A: Full Mastra Runtime (Replace Claude CLI)

| Phase | Effort | Risk |
|-------|--------|------|
| Abstract AgentRuntime interface | 2 weeks | Medium — large refactor of 8K line service |
| Implement Mastra runtime adapter | 2 weeks | High — need to reimplement file/terminal/git tools |
| Adapt message parsing pipeline | 1 week | Medium — new adapter for Mastra events |
| Adapt prompt system | 1 week | Low — mostly string template changes |
| Tool approval integration | 1 week | Medium — different approval API |
| Testing + stabilization | 2 weeks | High — regression risk |
| **Total** | **9-10 weeks** | **High** |

### Approach B: Mastra Middleware (Keep Claude CLI)

| Phase | Effort | Risk |
|-------|--------|------|
| Mastra orchestrator service | 1 week | Medium |
| Claude CLI adapter tool | 1 week | Low |
| Dual runtime state management | 2 weeks | High — complexity |
| Message flow unification | 1 week | Medium |
| Testing | 1 week | Medium |
| **Total** | **6-7 weeks** | **Medium-High** |

### Approach C: MCP Bridge (Minimal)

| Phase | Effort | Risk |
|-------|--------|------|
| @mastra/mcp MCPServer wrapper | 3 days | Low |
| Example Mastra agent consuming our tools | 2 days | Low |
| Documentation + examples | 2 days | Low |
| **Total** | **1-2 weeks** | **Low** |

---

## Risks and Blockers

### Critical Blockers

1. **Claude Code's built-in tools are not replicable via Mastra.**
   Claude Code has deep integration with the filesystem, terminal, git, and its own Agent tool for spawning teammates. Mastra provides no equivalent — you would need to build `editFile`, `bash`, `readFile`, `glob`, `grep`, `git` tools from scratch. These tools must handle permissions, sandboxing, diff generation, and conflict resolution. This is not just wrapping `fs.writeFile()` — it's thousands of lines of battle-tested code.

2. **stream-json protocol is Claude Code proprietary.**
   Our entire real-time UI (live typing, tool progress, subagent tracking) depends on the stream-json wire format. Mastra's streaming format is different (AI SDK compatible). The translation layer is non-trivial.

3. **Team/teammate lifecycle is Claude Code's native feature.**
   `TeamCreate`, `Agent` with `team_name`, `SendMessage` — these are built into Claude Code CLI. Mastra's supervisor pattern is conceptually similar but mechanically different (in-process sub-agents vs. separate CLI processes).

4. **Context window management.**
   Claude Code manages its own context window, compaction, and session persistence. Mastra delegates this to the model provider's API. Our post-compact reinjection system would need complete redesign.

### High Risks

5. **Performance: in-process vs. out-of-process.**
   Claude CLI runs as a separate process with its own Node.js runtime. Mastra agents run in-process within Electron's main process. Long-running agent tasks could block the Electron event loop. Would need worker threads or separate Node processes.

6. **Authentication divergence.**
   Claude Code CLI handles its own auth (OAuth, API key). Mastra uses provider API keys directly. Different auth models for different users.

7. **Losing Claude Code ecosystem.**
   Claude Code has CLAUDE.md, settings.json, .mcp.json, hooks, and growing features. Switching to Mastra means losing access to this ecosystem for Claude users.

### Medium Risks

8. **Mastra version churn.**
   Mastra is pre-1.0 (currently ~1.10.x) and evolving rapidly. The AgentNetwork API was deprecated in favor of supervisor agents in just months. API stability is not guaranteed.

9. **Dual dependency burden.**
   Adding `@mastra/core` (~150KB+ with deps) to an Electron app increases bundle size and potential version conflicts.

---

## Recommendations

### Short Term (Now): Approach C — MCP Bridge

**Confidence: 9/10 | Reliability: 8/10**

- Wrap our MCP server with `@mastra/mcp` MCPServer
- Publish as a standalone MCP endpoint that any Mastra agent can consume
- Zero risk to existing functionality
- Opens the door for external Mastra agents to manage our board
- 1-2 weeks effort

### Medium Term (Q2-Q3 2026): Abstract AgentRuntime Interface

**Confidence: 7/10 | Reliability: 6/10**

- Extract `AgentRuntime` interface from `TeamProvisioningService`
- `ClaudeCliRuntime` implements it (current behavior)
- Prepare the seam for `MastraRuntime` without building it yet
- De-risk the eventual full integration
- 2-3 weeks effort

### Long Term (Q4 2026+): Approach B — Mastra Middleware

**Confidence: 6/10 | Reliability: 5/10**

- Add Mastra as orchestration layer for routing and multi-provider support
- Keep Claude CLI as the "worker" runtime for actual coding
- Use Mastra for decision-making, task routing, and provider switching
- Full multi-model support without losing Claude Code's tooling
- 6-7 weeks effort

### NOT Recommended: Approach A (Full Replacement)

**Confidence: 3/10 | Reliability: 2/10**

Replacing Claude CLI entirely with Mastra-managed agents would lose our core differentiator (deep Claude Code integration: file editing, terminal, git, session persistence, extended thinking, etc.). The effort (~10 weeks) and risk are not justified unless Claude Code CLI is deprecated, which shows no signs of happening.

---

## Sources

- [Mastra GitHub Repository](https://github.com/mastra-ai/mastra)
- [Mastra Official Documentation](https://mastra.ai/docs)
- [Mastra Agent Overview](https://mastra.ai/docs/agents/overview)
- [Mastra MCP Overview](https://mastra.ai/docs/tools-mcp/mcp-overview)
- [Mastra Agent Network Evolution](https://mastra.ai/blog/agent-network)
- [Mastra vNext Agent Network](https://mastra.ai/blog/vnext-agent-network)
- [Mastra Supervisor Pattern (Feb 2026)](https://mastra.ai/blog/announcing-mastra-improved-agent-orchestration-ai-sdk-v5-support)
- [Mastra Agent Streaming Reference](https://mastra.ai/reference/agents/stream)
- [@mastra/core npm](https://www.npmjs.com/package/@mastra/core)
- [@mastra/mcp npm](https://www.npmjs.com/package/@mastra/mcp)
- [Mastra $13M Seed Round](https://technews180.com/funding-news/mastra-raises-13m-seed-for-typescript-ai-framework/)
- [Mastra on Y Combinator](https://www.ycombinator.com/companies/mastra)
