# Unified CLI Agent Interface — Research (March 2026)

Research on tools/libraries providing a unified interface for calling multiple AI coding CLI agents abstractly (Claude Code, Codex CLI, Gemini CLI, Goose, OpenCode, Aider, etc.).

## Summary & Recommendation

**No single battle-tested npm library exists** that abstracts CLI agent spawning behind a clean TypeScript interface suitable for embedding in an Electron app. The ecosystem is fragmented across ~10 projects, each with tradeoffs. The most relevant options for our use case are:

| Project | Lang | Approach | Library Use | Agents | Our Fit |
|---------|------|----------|-------------|--------|---------|
| **Coder AgentAPI** | Go | HTTP API over terminal emulation | Via HTTP (language-agnostic) | 11 | 8/10 |
| **all-agents-mcp** | TS | MCP server, child process spawn | npm import or MCP | 4 | 7/10 |
| **Overstory** | TS | AgentRuntime interface + tmux | CLI only (Bun) | 11 | 6/10 |
| **Composio Agent Orchestrator** | TS | Plugin architecture, worktrees | Build from source | 4+ | 5/10 |
| **MCO** | Python | CLI adapter hooks | CLI/MCP only | 5+ | 4/10 |
| **Network-AI** | TS | Blackboard coordination | npm library | 17 adapters* | 3/10 |
| **AWS CAO** | Python | tmux + MCP server | REST API | 7 | 4/10 |

\* Network-AI adapters are for AI frameworks (LangChain, CrewAI, etc.), not CLI coding agents directly.

**Recommended approach**: Extract the adapter pattern from Coder AgentAPI or all-agents-mcp, build our own thin `AgentAdapter` interface in TypeScript.

---

## Tier 1 — Most Relevant for Our Use Case

### 1. Coder AgentAPI

**The most mature unified interface for controlling CLI coding agents programmatically.**

- **URL**: https://github.com/coder/agentapi
- **Stars**: ~1,300
- **Language**: Go (82%), TypeScript (15% — web UI)
- **License**: MIT
- **npm package**: None (Go binary, HTTP API)

#### How it works
Runs an in-memory terminal emulator (Go). Translates API calls into terminal keystrokes, parses agent output into structured messages. Each agent type has a message formatter in `lib/msgfmt/`.

#### Supported agents (11)
Claude Code, Goose, Aider, Gemini CLI, GitHub Copilot, AmazonQ, OpenCode, Sourcegraph Amp, Codex, Auggie, Cursor CLI.

#### API surface
```
GET  /messages   — conversation history
POST /message    — send message (type: "user" | "raw")
GET  /status     — "stable" | "running"
GET  /events     — SSE stream (real-time)
GET  /openapi.json — full OpenAPI schema
```

#### Integration with Electron
- Spawn `agentapi server --type=claude -- claude` as child process
- Communicate via HTTP (localhost:3284)
- SSE events for real-time status updates
- Can generate TS client from OpenAPI spec using `@hey-api/openapi-ts`
- **Con**: Requires Go binary distribution alongside Electron app
- **Con**: Terminal emulation approach is fragile — keystrokes, not stdin/stdout protocol

#### Reliability: 7/10
#### Confidence: 8/10 — well-maintained by Coder (enterprise company), actively updated

Source: [github.com/coder/agentapi](https://github.com/coder/agentapi)

---

### 2. all-agents-mcp

**TypeScript MCP server that orchestrates agents via unified stdio interface.**

- **URL**: https://github.com/Dokkabei97/all-agents-mcp
- **npm**: `all-agents-mcp`
- **Language**: TypeScript (100%)
- **License**: MIT (assumed)

#### How it works
Invokes each agent's CLI binary as a child process. Each agent implementation extends `BaseAgent` abstract class which handles process spawning, stdin/stdout capture. No API bypass — pure process orchestration.

#### Key TypeScript interface
```
src/agents/
  IAgent interface         — identity, availability, execution, health
  BaseAgent abstract class — spawn logic, stdin/stdout
  claude-agent.ts
  codex-agent.ts
  gemini-agent.ts
  copilot-agent.ts
```

#### Supported agents (4)
Claude Code, Codex CLI, Gemini CLI, GitHub Copilot CLI.

#### API surface (MCP tools)
- `ask_agent` — single agent query
- `ask_all` — parallel multi-agent comparison
- `delegate_task` — complexity-based routing
- `cross_verify` — same agent, multiple models
- Plus specialized: code review, debug, explain, test gen, refactor

#### Integration with Electron
- **Pure TypeScript** — best language fit
- Can import as library or run as MCP server
- Child process spawning maps well to our existing architecture
- `IAgent` interface is close to what we need
- **Con**: Only 4 agents (vs 11 in AgentAPI)
- **Con**: Young project, may lack edge case handling
- **Con**: MCP-first design, not raw process management

#### Reliability: 5/10
#### Confidence: 6/10 — concept is solid, but limited agent coverage

Source: [github.com/Dokkabei97/all-agents-mcp](https://github.com/Dokkabei97/all-agents-mcp)

---

### 3. Overstory

**Multi-agent orchestration with pluggable AgentRuntime interface — most agents supported.**

- **URL**: https://github.com/jayminwest/overstory
- **npm**: `@os-eco/overstory-cli`
- **Language**: TypeScript (Bun runtime)
- **License**: MIT

#### AgentRuntime interface (`src/runtimes/types.ts`)
Defines the contract each adapter must implement:
- Spawning
- Config deployment
- Guard enforcement
- Readiness detection
- Transcript parsing

#### Supported runtimes (11)
Claude Code, Pi, Copilot, Cursor, Codex, Gemini CLI, Aider, Goose, Amp, OpenCode, Sapling.

#### Architecture
- Agents run in isolated **git worktrees via tmux**
- Inter-agent messaging via **SQLite** (`.overstory/mail.db`, WAL mode)
- Tiered conflict resolution for merge
- Watchdog daemon for health monitoring
- Hierarchy: Orchestrator → Coordinator → Supervisor → Workers

#### Integration with Electron
- TypeScript — good language fit
- `AgentRuntime` interface is the cleanest abstraction found
- **Con**: Requires Bun (not Node.js)
- **Con**: Hard dependency on tmux (not available on Windows, awkward in Electron)
- **Con**: Designed as CLI orchestrator, not embeddable library
- **Con**: Heavy — mail system, worktrees, watchdog are overhead we don't need

#### What we can extract
The `AgentRuntime` interface pattern is the most instructive. We could model our own adapter interface after it, implementing only spawn/communicate/status methods.

#### Reliability: 6/10
#### Confidence: 5/10 — great architecture design but tmux/Bun deps make it impractical for Electron

Source: [github.com/jayminwest/overstory](https://github.com/jayminwest/overstory)

---

## Tier 2 — Useful Reference, Not Direct Import

### 4. ComposioHQ Agent Orchestrator

**Enterprise-grade TypeScript orchestrator with plugin architecture.**

- **URL**: https://github.com/ComposioHQ/agent-orchestrator
- **Language**: TypeScript (91.5%), pnpm monorepo
- **npm**: Not published (build from source, `npm link -g packages/cli`)
- **License**: Not specified
- **Stars**: Growing, backed by Composio (well-funded company)

#### Plugin architecture (8 slots)
| Slot | Default | Alternatives |
|------|---------|-------------|
| Runtime | tmux | docker, k8s, process |
| Agent | claude-code | codex, aider, opencode |
| Workspace | worktree | clone |
| Tracker | github | linear |
| Notifier | desktop | slack, composio, webhook |
| Terminal | iterm2 | web |

All interfaces in `packages/core/src/types.ts`. Plugins implement one interface and export a `PluginModule`.

#### Key stats
40,000 lines of TypeScript, 17 plugins, 3,288 tests.

#### Integration with Electron
- TypeScript monorepo — compatible
- Plugin interface is clean and extensible
- **Con**: Not published as npm package
- **Con**: Heavy — includes dashboard, CI integration, PR management
- **Con**: tmux as default runtime
- **Con**: Designed for autonomous operation, not interactive control

#### Reliability: 6/10
#### Confidence: 5/10 — impressive codebase but too heavy for embedding

Source: [github.com/ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator)

---

### 5. MCO (Multi-CLI Orchestrator)

**Python-based neutral orchestration layer for CLI coding agents.**

- **URL**: https://github.com/mco-org/mco
- **npm**: `@tt-a1i/mco` (Node.js wrapper around Python)
- **Language**: Python (core), Node.js (wrapper)
- **Requires**: Python 3.10+

#### Adapter architecture
Adding a new agent CLI requires implementing three hooks:
1. Auth check
2. Command builder
3. Output normalizer

Supports two transport modes: Shim (stdout parsing) and ACP (JSON-RPC).

#### Supported agents (5+)
Claude Code, Codex CLI, Gemini CLI, OpenCode, Qwen Code. Custom agents via `.mco/agents.yaml`.

#### Features
- Parallel dispatch + consensus engine (`agreement_ratio`, `consensus_score`)
- JSON/SARIF/Markdown output
- Debate mode, divide mode (files/dimensions)
- MCP server mode for programmatic access

#### Integration with Electron
- **Con**: Python dependency — very problematic for Electron distribution
- **Con**: Not a library, primarily CLI
- MCP server mode could work but adds complexity
- The 3-hook adapter pattern is a useful design reference

#### Reliability: 5/10
#### Confidence: 4/10 — Python dependency is a dealbreaker for Electron

Source: [github.com/mco-org/mco](https://github.com/mco-org/mco)

---

### 6. AWS CLI Agent Orchestrator (CAO)

**AWS-backed orchestrator with supervisor-worker pattern via tmux + MCP.**

- **URL**: https://github.com/awslabs/cli-agent-orchestrator
- **Language**: Python 3.10+
- **Install**: `uv tool install` (not on PyPI)
- **License**: Apache 2.0

#### Supported providers (7)
Kiro CLI, Claude Code, Codex CLI, Gemini CLI, Kimi CLI, GitHub Copilot CLI, Q CLI.

#### Orchestration patterns
1. **Handoff** — synchronous task transfer with wait-for-completion
2. **Assign** — asynchronous spawning for parallel execution
3. **Send Message** — direct communication with existing agents

#### REST API
Server on `localhost:9889` — session management, terminal control, messaging.

#### Integration with Electron
- **Con**: Python — not suitable for Electron
- **Con**: tmux dependency
- REST API approach could be adapted
- Agent profile system is well-designed (provider key in frontmatter)

#### Reliability: 7/10
#### Confidence: 4/10 — solid engineering (AWS) but Python/tmux deps block Electron use

Source: [github.com/awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator), [AWS Blog](https://aws.amazon.com/blogs/opensource/introducing-cli-agent-orchestrator-transforming-developer-cli-tools-into-a-multi-agent-powerhouse/)

---

### 7. Network-AI

**TypeScript multi-agent coordination with atomic shared state.**

- **URL**: https://github.com/jovanSAPFIONEER/Network-AI
- **npm**: `network-ai`
- **Language**: TypeScript
- **License**: MIT

#### Key concept
Solves the "last-write-wins" problem with atomic `propose -> validate -> commit` semantics using filesystem-based mutual exclusion.

#### 17 adapters
LangChain, AutoGen, CrewAI, OpenAI Assistants, LlamaIndex, Semantic Kernel, Haystack, DSPy, Agno, MCP, Custom, OpenClaw, A2A, Codex, MiniMax, NemoClaw, APS.

**Important caveat**: These are adapters for AI *frameworks* (LangChain, CrewAI), not CLI coding agents (Claude Code, Aider). The Codex adapter is for OpenAI API, not Codex CLI.

#### Library usage
```typescript
import { LockedBlackboard, CustomAdapter, createSwarmOrchestrator } from 'network-ai';
```

#### Integration with Electron
- TypeScript + npm — good language fit
- Importable as library
- **Con**: Solves a different problem (framework coordination, not CLI agent spawning)
- **Con**: No adapters for CLI coding agents specifically
- Blackboard pattern could be useful for inter-agent state

#### Reliability: 5/10
#### Confidence: 3/10 — wrong abstraction level for our needs

Source: [github.com/jovanSAPFIONEER/Network-AI](https://github.com/jovanSAPFIONEER/Network-AI)

---

## Tier 3 — Ecosystem Context

### 8. Pi (pi-mono)

**TypeScript monorepo — coding agent toolkit with unified LLM API.**

- **URL**: https://github.com/badlogic/pi-mono
- **npm**: `@mariozechner/pi-coding-agent`
- **Language**: TypeScript (Bun)
- **Stars**: 25,400+

Not a multi-agent orchestrator — it's a coding agent itself (like Claude Code but open source). Relevant because its modular package design (`pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`) shows how to abstract agent internals. Supports 15+ LLM providers.

Source: [github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono)

---

### 9. AI Code Agents SDK (Felix Arntz)

**TypeScript SDK for vendor-lock-in-free coding agents.**

- **Blog**: https://felix-arntz.me/blog/introducing-ai-code-agents-a-typescript-sdk-to-solve-vendor-lock-in-for-coding-agents/
- **Language**: TypeScript
- **Built on**: Vercel AI SDK
- **Status**: Very early stage (announced November 2025)

Abstracts **Environment** (sandboxed execution contexts) and **Tools** (file system, commands) behind interfaces. Model-agnostic via Vercel AI SDK.

**Not a CLI agent spawner** — it's an SDK for *building* coding agents, not orchestrating existing ones. No GitHub repository found (may be private or unreleased).

#### Reliability: 2/10 (not yet available)
#### Confidence: 3/10

---

### 10. Claude Code Bridge (ccb)

**Terminal-based multi-AI collaboration via split panes.**

- **URL**: https://github.com/bfly123/claude_code_bridge
- **Stars**: 1,759
- **Language**: **Python** (not TypeScript)

Orchestrates Claude, Codex, Gemini, OpenCode, Droid through terminal multiplexer (WezTerm/tmux) split panes. 50-200 tokens per call via persistent sessions.

**Not suitable**: Python, tmux-based, designed for human-visible terminal interaction.

Source: [github.com/bfly123/claude_code_bridge](https://github.com/bfly123/claude_code_bridge)

---

## Related Infrastructure

### node-pty + xterm.js (Terminal Emulation in Electron)

The foundational building blocks if we build our own solution:

- **node-pty**: `npm install node-pty` — fork pseudoterminals in Node.js. Used by VS Code, Hyper, and many Electron terminal apps. Supports Linux, macOS, Windows (conpty). [github.com/microsoft/node-pty](https://github.com/microsoft/node-pty)
- **xterm.js**: Terminal emulator for the browser/Electron renderer. [github.com/xtermjs/xterm.js](https://github.com/xtermjs/xterm.js)
- **@loopmode/xpty**: React component + helpers for building terminals in Electron with xterm.js + node-pty. [github.com/loopmode/xpty](https://github.com/loopmode/xpty)

This is essentially what Coder AgentAPI does in Go. We could replicate the approach in TypeScript using node-pty directly.

**Important**: node-pty is **not thread-safe** and requires native compilation. Already used by many Electron apps successfully.

---

### Anthropic Claude Agent SDK (Official)

- **npm**: `@anthropic-ai/claude-agent-sdk`
- **URL**: https://github.com/anthropics/claude-agent-sdk-typescript
- **Docs**: https://platform.claude.com/docs/en/agent-sdk/typescript

Official SDK for spawning Claude Code programmatically. Includes `spawnClaudeCodeProcess` option, `AgentDefinition` for subagents. Only works with Claude Code.

---

### Awesome CLI Coding Agents (Curated List)

Comprehensive directory of 80+ CLI coding agents + orchestrators:
- **URL**: https://github.com/bradAGI/awesome-cli-coding-agents

Notable orchestrators from the list:
- **Superset** (7.4k stars) — terminal for coding agents, parallel sessions
- **Claude Squad** (6.4k stars) — tmux multi-session Claude Code
- **Crystal** (3.0k stars) — parallel agents in git worktrees
- **Toad** (2.7k stars) — agent orchestrator for parallel CLI sessions
- **Emdash** (2.7k stars) — concurrent coding agents

---

## Key Findings

### 1. No universal npm library exists
There is no `npm install universal-agent` that gives you a clean TypeScript interface to spawn and communicate with arbitrary CLI coding agents. The ecosystem is solving this problem in different ways (MCP servers, HTTP APIs, tmux wrappers, CLI tools) but none are designed as embeddable libraries for Electron.

### 2. Two architectural approaches dominate

**Terminal emulation** (AgentAPI approach):
- Spawn a PTY, type into it, parse output
- Works with ANY CLI agent without modification
- Fragile — depends on terminal output format
- Message boundaries are hard to detect

**stdin/stdout protocol** (our current Claude Code approach):
- `--input-format stream-json --output-format stream-json`
- Clean structured communication
- Only works if CLI supports it
- Each agent has its own protocol (or none)

### 3. Agent protocol fragmentation
Each CLI agent has a different communication protocol:
- **Claude Code**: stream-json stdin/stdout
- **Codex CLI**: `--json` flag, structured output
- **Gemini CLI**: No programmatic API documented
- **Goose**: Custom protocol
- **Aider**: Text-based, `--message` flag
- **OpenCode**: No public programmatic API

This fragmentation is why projects like AgentAPI resort to terminal emulation — it's the only truly universal approach.

### 4. MCP as potential unifier
MCP (Model Context Protocol) is emerging as a common integration point. All major coding agents now support MCP for tools, and projects like MCO and all-agents-mcp use MCP as the orchestration transport. However, MCP doesn't solve the agent *spawning* and *lifecycle management* problem.

### 5. The ACP (Agent Client Protocol) is emerging
The Agent Client Protocol (mentioned in MCO's ACP mode and the Cursor ACP adapter) may become a standard for agent-to-agent communication, but it's too early and not widely adopted.

---

## Proposed Architecture for Our Project

Based on this research, the recommended approach is to build our own thin abstraction layer:

```typescript
// AgentAdapter interface (inspired by Overstory's AgentRuntime + all-agents-mcp's IAgent)
interface AgentAdapter {
  // Identity
  readonly id: string;           // "claude-code" | "codex" | "gemini" | etc.
  readonly displayName: string;

  // Detection
  isInstalled(): Promise<boolean>;
  getVersion(): Promise<string | null>;

  // Lifecycle
  spawn(config: AgentSpawnConfig): Promise<AgentProcess>;

  // Capabilities
  supportsMcp(): boolean;
  supportsStreamJson(): boolean;
  supportsTeams(): boolean;
}

interface AgentProcess {
  // Communication
  sendMessage(text: string): Promise<void>;
  onMessage(handler: (msg: AgentMessage) => void): void;
  onStatus(handler: (status: AgentStatus) => void): void;

  // Lifecycle
  isAlive(): boolean;
  kill(): Promise<void>;

  // Process
  readonly pid: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
}

interface AgentSpawnConfig {
  workingDir: string;
  mcpConfig?: string;           // path to MCP config file
  model?: string;
  maxTokens?: number;
  disallowedTools?: string[];
  env?: Record<string, string>;
  systemPrompt?: string;
}
```

### Implementation approaches (ranked)

**Option A: Direct child_process spawn with per-agent formatters (Recommended)**
- Use Node.js `child_process.spawn()` for each agent
- Each adapter knows the correct CLI flags and I/O format
- Similar to all-agents-mcp's `BaseAgent` approach
- Reliability: 8/10, Confidence: 9/10

**Option B: node-pty terminal emulation (AgentAPI approach in TS)**
- Use `node-pty` to spawn PTY for each agent
- Parse terminal output, inject keystrokes
- Works with any agent but fragile
- Reliability: 6/10, Confidence: 7/10

**Option C: Wrap Coder AgentAPI as subprocess**
- Spawn `agentapi server` as a sidecar process
- Communicate via HTTP API
- Leverage their 11 agent support
- Reliability: 7/10, Confidence: 6/10 (Go binary distribution complexity)

**Option D: Fork all-agents-mcp's TypeScript code**
- Take the IAgent/BaseAgent pattern
- Extend with more agents
- Reliability: 6/10, Confidence: 7/10

---

## Sources

- [Coder AgentAPI](https://github.com/coder/agentapi) — HTTP API for 11 coding agents (Go)
- [all-agents-mcp](https://github.com/Dokkabei97/all-agents-mcp) — TypeScript MCP server for 4 agents
- [Overstory](https://github.com/jayminwest/overstory) — AgentRuntime interface with 11 runtimes (TS/Bun)
- [ComposioHQ Agent Orchestrator](https://github.com/ComposioHQ/agent-orchestrator) — TS monorepo, plugin architecture
- [MCO](https://github.com/mco-org/mco) — Python multi-CLI orchestrator with adapter hooks
- [AWS CLI Agent Orchestrator](https://github.com/awslabs/cli-agent-orchestrator) — Python, supervisor-worker pattern
- [Network-AI](https://github.com/jovanSAPFIONEER/Network-AI) — TS, 17 framework adapters, npm library
- [Pi (pi-mono)](https://github.com/badlogic/pi-mono) — TS coding agent toolkit
- [Claude Code Bridge](https://github.com/bfly123/claude_code_bridge) — Python multi-AI collaboration
- [Awesome CLI Coding Agents](https://github.com/bradAGI/awesome-cli-coding-agents) — curated directory of 80+ agents
- [node-pty](https://github.com/microsoft/node-pty) — PTY for Node.js (Microsoft)
- [Anthropic Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) — Official TS SDK
- [Felix Arntz blog — AI Code Agents SDK](https://felix-arntz.me/blog/introducing-ai-code-agents-a-typescript-sdk-to-solve-vendor-lock-in-for-coding-agents/) — Vendor lock-in abstraction concept
- [AWS Blog — CLI Agent Orchestrator](https://aws.amazon.com/blogs/opensource/introducing-cli-agent-orchestrator-transforming-developer-cli-tools-into-a-multi-agent-powerhouse/)
