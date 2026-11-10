# Best Abstraction Tool for Multi-Provider Agent Support in Electron

**Date**: 2026-03-24
**Branch**: `dev`
**Based on**: actual source analysis of `TeamProvisioningService.ts` (7,982 LOC), `childProcess.ts`, `TeamMcpConfigBuilder.ts`, `PtyTerminalService.ts`, `agent-teams-controller/`, and prior research in `docs/research/`

---

## Context: What We Have Today

Our Electron app (40.x) manages Claude Code CLI processes via:

| Component | File | Role |
|-----------|------|------|
| `spawnCli()` | `src/main/utils/childProcess.ts` | child_process.spawn wrapper with Windows EINVAL fallback, injects `CLI_ENV_DEFAULTS` |
| `TeamProvisioningService` | `src/main/services/team/TeamProvisioningService.ts` | 7,982 LOC monolith: process lifecycle, stream-json NDJSON parsing, prompt engineering, stall watchdog, tool approval relay |
| `ClaudeBinaryResolver` | `src/main/services/team/ClaudeBinaryResolver.ts` | Resolves `claude` binary across PATH, NVM, platform dirs |
| `TeamMcpConfigBuilder` | `src/main/services/team/TeamMcpConfigBuilder.ts` | Builds `--mcp-config` JSON for every spawned process |
| `PtyTerminalService` | `src/main/services/infrastructure/PtyTerminalService.ts` | node-pty for embedded terminal (used separately, NOT for agent processes) |
| `agent-teams-controller` | `agent-teams-controller/` | Provider-agnostic file CRUD (tasks, kanban, inbox, reviews) |
| `killTeamProcess()` | TeamProvisioningService | Uses SIGKILL to prevent Claude CLI SIGTERM cleanup deleting team files |

**Current protocol**: Claude CLI `--input-format stream-json --output-format stream-json` — proprietary NDJSON with types: `user`, `assistant`, `control_request`, `result`, `system`.

**Current coupling**: 9/10 to Claude Code CLI (see `best-integration-approach.md` for full coupling map).

---

## Two Distinct Needs

### Level 1: CLI Agent Process Management
Spawn external CLI agents (Claude Code, Codex CLI, Gemini CLI, Goose) as child processes, each with its own protocol, binary resolution, health monitoring, and MCP config.

### Level 2: Programmatic LLM API Calls
Call LLM APIs directly for lightweight tasks (code review bot, triage bot, task planning, MCP tool calling). No CLI process — just HTTP to provider APIs.

These are **fundamentally different problems** and should use **different solutions**.

---

## Level 1: CLI Agent Process Management

### The Candidates

#### Option A: Own Adapter Pattern (Overstory-style)
**Reliability: 9/10 | Confidence: 9/10**

Build a thin `AgentCliAdapter` interface with per-CLI implementations.

```typescript
// src/main/services/agent/AgentCliAdapter.ts
export interface AgentCliAdapter {
  readonly providerId: string;  // 'claude' | 'codex' | 'gemini' | 'goose'

  /** Resolve binary path on this machine */
  resolveBinary(): Promise<string | null>;

  /** Build spawn args for creating/launching a team */
  buildSpawnArgs(request: AgentSpawnRequest): string[];

  /** Build env vars for the spawned process */
  buildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

  /** Parse a line of stdout. Returns typed event or null (skip). */
  parseStdoutLine(line: string): AgentOutputEvent | null;

  /** Format a user message for stdin */
  formatUserMessage(text: string): string;

  /** Process exit semantics: what does exit code mean? */
  interpretExitCode(code: number | null): 'success' | 'error' | 'killed';

  /** Kill semantics: SIGTERM vs SIGKILL */
  killProcess(child: ChildProcess): void;

  /** Whether this CLI needs MCP config file */
  needsMcpConfig: boolean;

  /** Build MCP config in the format this CLI expects */
  buildMcpConfig?(servers: Record<string, McpServerConfig>): object;
}
```

Per-provider implementations:

```typescript
// src/main/services/agent/adapters/ClaudeCliAdapter.ts
export class ClaudeCliAdapter implements AgentCliAdapter {
  readonly providerId = 'claude';
  readonly needsMcpConfig = true;

  async resolveBinary(): Promise<string | null> {
    return new ClaudeBinaryResolver().resolve();
  }

  buildSpawnArgs(request: AgentSpawnRequest): string[] {
    return [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--setting-sources', 'user,project,local',
      '--mcp-config', request.mcpConfigPath!,
      '--disallowedTools', 'TeamDelete,TodoWrite',
      ...(request.skipPermissions
        ? ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']
        : ['--permission-prompt-tool', 'stdio', '--permission-mode', 'default']),
      ...(request.model ? ['--model', request.model] : []),
    ];
  }

  buildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...base, CLAUDE_HOOK_JUDGE_MODE: 'true' };
  }

  parseStdoutLine(line: string): AgentOutputEvent | null {
    const msg = JSON.parse(line);
    // Existing 60+ branch logic from handleStreamJsonMessage()
    switch (msg.type) {
      case 'assistant': return { kind: 'text', content: extractText(msg) };
      case 'result':    return { kind: 'result', success: msg.subtype !== 'error' };
      case 'control_request': return { kind: 'approval', request: msg };
      // ... etc
    }
  }

  formatUserMessage(text: string): string {
    return JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }) + '\n';
  }

  killProcess(child: ChildProcess): void {
    killProcessTree(child, 'SIGKILL'); // SIGKILL to prevent cleanup
  }
}
```

```typescript
// src/main/services/agent/adapters/CodexCliAdapter.ts
export class CodexCliAdapter implements AgentCliAdapter {
  readonly providerId = 'codex';
  readonly needsMcpConfig = false; // Codex uses MCP differently

  async resolveBinary(): Promise<string | null> {
    // which codex
    return resolveWhich('codex');
  }

  buildSpawnArgs(request: AgentSpawnRequest): string[] {
    return ['app-server']; // JSON-RPC mode
  }

  parseStdoutLine(line: string): AgentOutputEvent | null {
    // JSON-RPC notification parsing
    const msg = JSON.parse(line);
    if (msg.method === 'item/agentMessage/delta') {
      return { kind: 'text_delta', content: msg.params.delta };
    }
    // ...
  }

  formatUserMessage(text: string): string {
    // JSON-RPC request for turn/start
    return JSON.stringify({
      jsonrpc: '2.0', id: nextId(),
      method: 'turn/start',
      params: { message: text },
    }) + '\n';
  }

  killProcess(child: ChildProcess): void {
    killProcessTree(child, 'SIGTERM'); // Codex handles SIGTERM gracefully
  }
}
```

```typescript
// src/main/services/agent/adapters/GeminiCliAdapter.ts
export class GeminiCliAdapter implements AgentCliAdapter {
  readonly providerId = 'gemini';
  readonly needsMcpConfig = false;

  async resolveBinary(): Promise<string | null> {
    return resolveWhich('gemini');
  }

  buildSpawnArgs(request: AgentSpawnRequest): string[] {
    return [
      '--output-format', 'stream-json',
      '-p', request.prompt,
    ];
  }

  parseStdoutLine(line: string): AgentOutputEvent | null {
    // Gemini NDJSON events
    const event = JSON.parse(line);
    // ...
  }

  formatUserMessage(text: string): string {
    // Gemini headless doesn't support multi-turn stdin in stream-json
    // (one-shot with -p flag). For multi-turn, need new process per turn.
    throw new Error('Gemini CLI does not support multi-turn stdin');
  }

  killProcess(child: ChildProcess): void {
    killProcessTree(child, 'SIGTERM');
  }
}
```

**Pros:**
- Zero new dependencies
- Perfectly fits existing `spawnCli()` / `killProcessTree()` infrastructure
- Each adapter is ~100-200 LOC — easy to test in isolation
- Can be extracted incrementally from the existing TeamProvisioningService
- No framework overhead in the Electron main process
- Each CLI's quirks handled explicitly (Claude SIGKILL vs Codex SIGTERM, stream-json vs JSON-RPC)

**Cons:**
- We write the adapter code ourselves (~500 LOC total for 4 adapters)
- No built-in CLI discovery / health check framework

**Effort**: ~800 LOC (interface + 4 adapters + factory), 3-5 days

---

#### Option B: node-pty Based Approach
**Reliability: 5/10 | Confidence: 4/10**

Use pseudo-terminal for all CLI agents (captures raw terminal output).

```typescript
import * as pty from 'node-pty';

const proc = pty.spawn('claude', ['--verbose'], {
  name: 'xterm-256color',
  cols: 120, rows: 40,
  cwd: projectPath,
  env: process.env,
});

proc.onData((data) => {
  // Problem: raw terminal output with ANSI codes, cursor movement, etc.
  // We'd need to strip all that to parse structured JSON
});
```

**Pros:**
- Already have `node-pty` in dependencies (for embedded terminal)
- Works with any CLI that has a TUI mode

**Cons:**
- node-pty is a native addon requiring electron-rebuild (fragile across platforms)
- All CLIs output ANSI escape codes in TTY mode — parsing structured data from raw terminal output is extremely unreliable
- We ALREADY use stream-json/JSON-RPC specifically to AVOID the TTY problem
- Memory overhead of full PTY per agent process
- Claude Code, Codex, and Gemini all have headless/programmatic modes — PTY is the WRONG abstraction

**Verdict: REJECT.** PTY is for interactive terminals, not programmatic agent management. We already learned this — `PtyTerminalService` is used only for the embedded terminal, not for agent processes.

---

#### Option C: MCO / Third-Party Orchestrator Library
**Reliability: 3/10 | Confidence: 3/10**

No mature, production-ready TypeScript library exists for "spawn and manage multiple AI CLI agents as child processes." The closest is `pi-builder` from the `awesome-cli-coding-agents` ecosystem, but it's a young project (~100 stars) with no stability guarantees.

**Verdict: REJECT.** The problem is too niche and CLI-specific for a generic library. Each CLI has its own protocol (Claude stream-json, Codex JSON-RPC, Gemini NDJSON, Goose recipes). A generic library would either be too thin to be useful or too opinionated to handle the differences.

---

#### Level 1 Recommendation: Option A (Own Adapter Pattern)

| Criteria | Score |
|----------|-------|
| Fit with existing code patterns | 10/10 — mirrors how `spawnCli()` and `ClaudeBinaryResolver` already work |
| Lines of code to integrate | ~800 LOC (interface + 4 adapters + factory) |
| Heavy dependencies added | 0 |
| Runs in Electron main process | Yes (pure Node.js) |
| License compatibility | N/A (our own code, AGPL-3.0) |
| Active maintenance | By us — full control |

**Migration path**: Extract current Claude-specific logic from `TeamProvisioningService` into `ClaudeCliAdapter`, then add adapters for other CLIs one by one. The monster 7,982 LOC monolith gets decomposed as a side effect.

---

## Level 2: Programmatic LLM API Calls

### The Candidates

#### Option A: Vercel AI SDK (`ai` + `@ai-sdk/*`)
**Reliability: 9/10 | Confidence: 9/10** (Recommended)

The leading TypeScript LLM abstraction. 20M+ monthly npm downloads, backed by Vercel, 30K+ GitHub stars.

```typescript
// src/main/services/llm/LlmService.ts
import { generateText, streamText, tool } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import { z } from 'zod';

// Simple code review — runs in Electron main process
export async function reviewCode(diff: string, model = 'anthropic/claude-sonnet-4-20250514') {
  const { text } = await generateText({
    model: anthropic('claude-sonnet-4-20250514'),
    system: 'You are a code reviewer. Be concise.',
    prompt: `Review this diff:\n\n${diff}`,
  });
  return text;
}

// Streaming task planning with tool calling — relayed to renderer via IPC
export async function planTasks(
  description: string,
  onChunk: (text: string) => void,
) {
  const result = streamText({
    model: openai('gpt-4o'),
    system: 'You are a project planner.',
    prompt: description,
    tools: {
      createTask: tool({
        description: 'Create a new task on the kanban board',
        parameters: z.object({
          title: z.string(),
          assignee: z.string().optional(),
          column: z.enum(['backlog', 'todo', 'in_progress']),
        }),
        execute: async ({ title, assignee, column }) => {
          // Call our agent-teams-controller to create task
          return controller.createTask({ title, assignee, column });
        },
      }),
    },
    maxSteps: 10, // Allow multi-step tool calling loops
  });

  for await (const chunk of result.textStream) {
    onChunk(chunk);
  }
}

// Triage incoming issue — pick best team member
export async function triageTask(taskDescription: string) {
  const { object } = await generateObject({
    model: google('gemini-2.5-flash'),
    schema: z.object({
      assignee: z.string(),
      priority: z.enum(['low', 'medium', 'high', 'critical']),
      reasoning: z.string(),
    }),
    prompt: `Triage this task: ${taskDescription}\nAvailable members: alice (frontend), bob (backend), carol (devops)`,
  });
  return object; // Typed: { assignee: string; priority: string; reasoning: string }
}
```

**What we install:**
```bash
pnpm add ai @ai-sdk/anthropic @ai-sdk/openai @ai-sdk/google zod
# ai: 67.5 kB gzipped (core)
# @ai-sdk/anthropic: ~15 kB gzipped
# @ai-sdk/openai: ~19.5 kB gzipped
# @ai-sdk/google: ~15 kB gzipped
# Total: ~117 kB gzipped — very reasonable for Electron
```

**Pros:**
- Unified `generateText()` / `streamText()` / `generateObject()` API across ALL providers
- Swap provider with one line change: `anthropic('claude-sonnet-4-20250514')` → `openai('gpt-4o')`
- First-class tool calling with Zod schema validation
- Streaming works perfectly in Node.js (Electron main process)
- Sentry already has `vercelAIIntegration` for Electron — we already use `@sentry/electron`
- TypeScript-first: full type inference for tool parameters and structured outputs
- AI SDK 6 `Agent` class for reusable agent patterns
- 20M+ monthly downloads, extremely active maintenance, battle-tested
- Apache-2.0 license — compatible with our AGPL-3.0

**Cons:**
- Adds ~4 new deps (ai, 3 providers) — but they're lightweight
- Learning curve for Zod schemas (though Zod is industry standard)
- AI SDK 5→6 had some breaking changes — minor version churn risk

**Electron main process integration:**
```typescript
// src/main/ipc/llm.ts — IPC handlers for renderer
import { wrapHandler } from './utils';
import { streamText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

export function registerLlmHandlers() {
  // One-shot generation
  ipcMain.handle('llm:generate', wrapHandler(async (_event, params) => {
    const { text } = await generateText({
      model: resolveModel(params.model),  // 'anthropic/claude-sonnet-4-20250514' → anthropic('claude-sonnet-4-20250514')
      system: params.system,
      prompt: params.prompt,
    });
    return { text };
  }));

  // Streaming — emit chunks via webContents.send()
  ipcMain.handle('llm:stream', wrapHandler(async (event, params) => {
    const result = streamText({
      model: resolveModel(params.model),
      system: params.system,
      prompt: params.prompt,
    });

    const sender = event.sender;
    for await (const chunk of result.textStream) {
      sender.send('llm:chunk', { requestId: params.requestId, chunk });
    }
    sender.send('llm:done', { requestId: params.requestId });
    return { started: true };
  }));
}
```

---

#### Option B: Mastra (LLM layer only)
**Reliability: 6/10 | Confidence: 5/10**

Mastra is a full agent framework (workflows, RAG, memory, server). Using "just the LLM layer" means using Mastra's `Agent` class which internally uses AI SDK anyway.

```typescript
import { Agent } from '@mastra/core/agent';

const reviewer = new Agent({
  id: 'code-reviewer',
  instructions: 'You are a code reviewer.',
  model: 'anthropic/claude-sonnet-4-20250514',
});

const result = await reviewer.generate('Review this diff...');
```

**Pros:**
- Nice `Agent` abstraction with built-in memory and workflow support
- Uses AI SDK internally — same providers
- TypeScript-native

**Cons:**
- `@mastra/core` pulls in significant dependencies (server framework, storage adapters, DI container)
- Overkill for our use case — we need `generateText()`, not the full agent runtime
- Our agent runtime IS the CLI process management layer, not Mastra's in-process loop
- Less mature than AI SDK (smaller community, fewer downloads)
- Adds unnecessary abstraction layer on top of AI SDK
- YC-backed startup — could pivot or die; AI SDK is backed by Vercel ($3.2B company)

**See also:** `docs/research/mastra-integration-analysis.md` (full analysis, verdict 6/10 feasibility)

---

#### Option C: LangChain.js
**Reliability: 4/10 | Confidence: 3/10**

```typescript
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';

const chat = new ChatAnthropic({ model: 'claude-sonnet-4-20250514' });
const result = await chat.invoke('Review this diff...');
```

**Pros:**
- Largest ecosystem (chains, agents, RAG, memory)
- Many tutorials and examples

**Cons:**
- **101 kB gzipped** — 3x the size of OpenAI SDK, 1.5x AI SDK
- Heavy dependency tree (infamous for bloat)
- Frequent breaking changes between versions
- Overcomplicated abstractions for simple LLM calls
- Edge runtime incompatible (uses Node `fs`)
- Community frustration well-documented: "LangChain adds unnecessary complexity"
- For our use case (simple API calls with tool calling), it's a 10-ton truck for a bicycle ride

---

#### Option D: LiteLLM (via proxy)
**Reliability: 5/10 | Confidence: 4/10**

Run a Python proxy process, point OpenAI SDK at it.

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:4000', // LiteLLM proxy
  apiKey: 'sk-anything',
});

const result = await client.chat.completions.create({
  model: 'anthropic/claude-sonnet-4-20250514',
  messages: [{ role: 'user', content: 'Review this diff...' }],
});
```

**Pros:**
- 100+ providers through OpenAI-compatible API
- Rate limiting, fallbacks, cost tracking built-in
- Established in production at many companies

**Cons:**
- **Requires Python runtime** — catastrophic for an Electron desktop app
- Another long-lived process to manage (proxy lifecycle)
- Performance degrades under concurrency (Python GIL)
- Extra latency hop: Electron → proxy → provider → proxy → Electron
- Enterprise features (SSO, RBAC) behind paid license
- Electron users expect a self-contained app, not "also install Python 3.11"

---

#### Option E: Direct Provider SDKs with Thin Wrapper
**Reliability: 7/10 | Confidence: 7/10**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

async function callLlm(provider: string, prompt: string) {
  switch (provider) {
    case 'anthropic': {
      const client = new Anthropic();
      const msg = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });
      return msg.content[0].type === 'text' ? msg.content[0].text : '';
    }
    case 'openai': {
      const client = new OpenAI();
      const result = await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
      });
      return result.choices[0]?.message?.content ?? '';
    }
    // ...each provider has different API shape
  }
}
```

**Pros:**
- Each SDK is lightweight and well-maintained
- No abstraction overhead — direct control

**Cons:**
- Must implement unified tool calling ourselves (Anthropic tools format ≠ OpenAI function calling ≠ Google tool format)
- Must implement streaming ourselves for each provider
- Must implement structured output extraction per-provider
- Maintenance burden grows linearly with each new provider
- This is literally what AI SDK already does, but worse

---

### Level 2 Recommendation: Option A (Vercel AI SDK)

| Criteria | Score |
|----------|-------|
| Fit with existing code patterns | 9/10 — pure TypeScript, Node.js-compatible, modular |
| Lines of code to integrate | ~200 LOC (LlmService + IPC handlers) |
| Heavy dependencies added | No — ~117 kB gzipped total for core + 3 providers |
| Runs in Electron main process | Yes — confirmed by Sentry Electron integration docs |
| License compatibility | Apache-2.0 → compatible with our AGPL-3.0 |
| Active maintenance | 10/10 — 20M+ monthly downloads, Vercel-backed |

---

## Combined Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Electron Main Process                 │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │          Level 1: CLI Process Management          │   │
│  │                                                    │   │
│  │  AgentCliAdapter (interface)                       │   │
│  │    ├─ ClaudeCliAdapter  (stream-json NDJSON)      │   │
│  │    ├─ CodexCliAdapter   (app-server JSON-RPC)     │   │
│  │    ├─ GeminiCliAdapter  (stream-json NDJSON)      │   │
│  │    └─ GooseCliAdapter   (stdin recipes)           │   │
│  │                                                    │   │
│  │  spawnCli() + killProcessTree() (unchanged)       │   │
│  │  TeamMcpConfigBuilder (unchanged)                 │   │
│  │  TeamProvisioningService (refactored to use       │   │
│  │    adapter.parseStdoutLine() etc.)                │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │        Level 2: Programmatic LLM API Calls        │   │
│  │                                                    │   │
│  │  Vercel AI SDK (ai + @ai-sdk/*)                   │   │
│  │    ├─ generateText()  → code review, triage       │   │
│  │    ├─ streamText()    → task planning, chat       │   │
│  │    ├─ generateObject()→ structured extraction     │   │
│  │    └─ tool()          → MCP tool bridges          │   │
│  │                                                    │   │
│  │  LlmService.ts (~200 LOC)                         │   │
│  │  IPC handlers → renderer                          │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │          Shared: agent-teams-controller            │   │
│  │  (provider-agnostic task/kanban/inbox CRUD)       │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## Comparison Matrix

### Level 1: CLI Process Management

| Criterion | Own Adapter | node-pty | MCO/Third-Party |
|-----------|-------------|----------|-----------------|
| Reliability | 9/10 | 5/10 | 3/10 |
| Confidence | 9/10 | 4/10 | 3/10 |
| Fit with codebase | 10/10 | 4/10 | 3/10 |
| New dependencies | 0 | 0 (already have) | Unknown |
| LOC to integrate | ~800 | ~600 | ~1000+ |
| Electron compatible | Yes | Yes (fragile) | Unknown |
| Handles protocol diffs | Explicit | No (raw PTY) | Generic/lossy |

### Level 2: Programmatic LLM API Calls

| Criterion | AI SDK | Mastra | LangChain | LiteLLM | Direct SDKs |
|-----------|--------|--------|-----------|---------|-------------|
| Reliability | 9/10 | 6/10 | 4/10 | 5/10 | 7/10 |
| Confidence | 9/10 | 5/10 | 3/10 | 4/10 | 7/10 |
| Fit with codebase | 9/10 | 5/10 | 3/10 | 2/10 | 7/10 |
| Bundle size | 117 kB | ~400+ kB | 101 kB + deps | N/A (Python) | ~80 kB |
| Tool calling | Unified | Unified (via AI SDK) | Unified | OpenAI-compat | Per-provider |
| Streaming | Async iterator | Async iterator | Chains | SSE proxy | Per-provider |
| Providers | 20+ | 94 (via AI SDK) | 20+ | 100+ | Each separate |
| Electron main proc | Confirmed | Untested | Problematic | Requires Python | Yes |
| License | Apache-2.0 | Elastic-2.0 / AGPL-3.0 | MIT | MIT | Varies |
| Maintenance | Vercel (huge team) | Startup (small) | Community | Community | Per-vendor |

---

## Final Recommendation

### Level 1: Own Adapter Pattern
- **0 new dependencies**, ~800 LOC
- Extract Claude-specific logic from the 7,982 LOC monolith into `ClaudeCliAdapter`
- Add `CodexCliAdapter`, `GeminiCliAdapter`, `GooseCliAdapter` incrementally
- Each adapter handles that CLI's unique protocol, binary resolution, spawn args, kill semantics
- Decomposes the monolith as a beneficial side effect

### Level 2: Vercel AI SDK (`ai` + `@ai-sdk/*`)
- **4 lightweight deps** (~117 kB gzipped total), ~200 LOC integration
- `generateText()` for one-shot tasks, `streamText()` for interactive, `generateObject()` for structured extraction
- Unified tool calling with Zod schemas
- Swap any provider with one line change
- Apache-2.0 compatible with our AGPL-3.0
- Already used by 20M+ monthly projects, confirmed Electron compatibility

### Implementation Order

1. **Week 1**: Create `AgentCliAdapter` interface, extract `ClaudeCliAdapter` from `TeamProvisioningService`
2. **Week 1**: Install AI SDK, create `LlmService.ts` with `generateText()` wrapper, add IPC handlers
3. **Week 2**: Add `CodexCliAdapter` (app-server JSON-RPC mode)
4. **Week 2**: Build code review bot using AI SDK + MCP tools
5. **Week 3**: Add `GeminiCliAdapter`, `GooseCliAdapter`
6. **Week 3**: Build triage bot, task planning with `streamText()` + tool calling

**Total effort**: ~3 weeks for full multi-provider support at both levels.

---

## Sources

### AI SDK (Vercel)
- [AI SDK Introduction](https://ai-sdk.dev/docs/introduction)
- [AI SDK 6 Announcement](https://vercel.com/blog/ai-sdk-6)
- [Node.js Getting Started](https://ai-sdk.dev/docs/getting-started/nodejs)
- [Providers and Models](https://ai-sdk.dev/docs/foundations/providers-and-models)
- [Sentry Electron + Vercel AI Integration](https://docs.sentry.io/platforms/javascript/guides/electron/configuration/integrations/vercelai/)
- [Generating Text](https://ai-sdk.dev/docs/ai-sdk-core/generating-text)
- [npm: ai](https://www.npmjs.com/package/ai)
- [GitHub: vercel/ai](https://github.com/vercel/ai)

### Codex CLI
- [Codex SDK](https://developers.openai.com/codex/sdk)
- [Codex App Server](https://developers.openai.com/codex/app-server)
- [npm: @openai/codex-sdk](https://www.npmjs.com/package/@openai/codex-sdk)
- [CLI Reference](https://developers.openai.com/codex/cli/reference)

### Gemini CLI
- [Headless Mode Reference](https://geminicli.com/docs/cli/headless/)
- [GitHub: google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)

### Goose
- [GitHub: block/goose](https://github.com/block/goose)
- [CLI Commands](https://block.github.io/goose/docs/guides/goose-cli-commands/)

### Mastra
- [GitHub: mastra-ai/mastra](https://github.com/mastra-ai/mastra)
- [Mastra Docs: Models](https://mastra.ai/models)

### LangChain.js
- [LangChain vs Vercel AI SDK vs OpenAI SDK: 2026 Guide](https://strapi.io/blog/langchain-vs-vercel-ai-sdk-vs-openai-sdk-comparison-guide)
- [Bundle Size Issue #809](https://github.com/langchain-ai/langchainjs/issues/809)
- [LangChain Criticism](https://community.latenode.com/t/why-im-avoiding-langchain-in-2025/39046)

### LiteLLM
- [LiteLLM Proxy Docs](https://docs.litellm.ai/docs/simple_proxy)
- [Best LiteLLM Alternatives 2026](https://www.getmaxim.ai/articles/best-litellm-alternatives-in-2026/)

### License Compatibility
- [Apache License and GPL Compatibility](https://www.apache.org/licenses/GPL-compatibility.html)
- [Apache 2.0 Compatible Licenses Guide](https://licensecheck.io/guides/apache-compatible)

### Ecosystem
- [CLI Coding Agents Comparison 2026](https://www.tembo.io/blog/coding-cli-tools-comparison)
- [awesome-cli-coding-agents](https://github.com/bradAGI/awesome-cli-coding-agents)
