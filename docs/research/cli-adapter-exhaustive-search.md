# Exhaustive Search: Unified CLI Agent Adapter Libraries

**Date:** 2026-03-24
**Goal:** Find ANY existing library/package that provides a unified interface for spawning and communicating with multiple AI coding CLI agents (Claude Code, Codex, Gemini CLI, Goose, Aider, OpenCode, etc.)
**Verdict:** Multiple viable options now exist. The landscape has changed dramatically since last check.

---

## Executive Summary

The "nothing exists" conclusion from previous research is **no longer accurate**. As of March 2026, there are at least **6 serious contenders** that provide a unified interface for controlling multiple CLI coding agents. The ecosystem exploded in late 2025 / early 2026 driven by the Agent Client Protocol (ACP) standard and the proliferation of CLI coding agents.

However, **none of them are a drop-in library for Electron** in the way we need. Each has tradeoffs. The analysis below is ordered from most to least relevant for our use case.

---

## Tier 1: Directly Relevant — Unified Agent Interface Libraries

### 1. Rivet Sandbox Agent SDK
- **Repo:** https://github.com/rivet-dev/sandbox-agent
- **npm:** `@sandbox-agent/cli` (v0.2.x), `sandbox-agent` (TS SDK)
- **Website:** https://sandboxagent.dev
- **Language:** Rust server + TypeScript SDK
- **Supported agents:** Claude Code, Codex, OpenCode, Cursor, Amp, Pi (6 agents)
- **Last activity:** Active (HN launch Feb 2026)
- **Stars:** High interest (featured on InfoQ, HN front page)
- **TypeScript types:** Yes, full TypeScript SDK with embedded mode
- **Installable via npm:** Yes
- **Can embed in Electron:** Partially. The TS SDK can spawn the Rust binary as a subprocess. However, it's designed for sandboxed environments (Docker, E2B, Daytona), not local Electron apps.
- **How it works:** Rust HTTP server runs inside a sandbox, exposes unified REST + SSE API. TS SDK connects over HTTP or spawns daemon.
- **Universal session schema:** Yes — normalizes all agent events into consistent format (session lifecycle, items, questions, permissions)
- **Reliability:** 8/10 — Backed by Rivet (YC company), clean architecture
- **Confidence this fits our needs:** 5/10 — Sandbox-first design doesn't map well to local Electron. We'd need to run the binary locally without a sandbox. The TS SDK embed mode is promising but untested for our use case.

### 2. Agent Client Protocol (ACP) + TypeScript SDK
- **Repo:** https://github.com/agentclientprotocol/typescript-sdk
- **npm:** `@agentclientprotocol/sdk` (v0.14.1, 245 dependents)
- **Spec:** https://agentclientprotocol.com
- **Language:** TypeScript
- **Supported agents:** 25+ agents (Claude, Codex, Gemini CLI, Copilot, Goose, OpenCode, Pi, Kiro, Junie, Cline, OpenHands, Qoder, Kimi, and many more)
- **Last publish:** 15 days ago (very active)
- **Stars:** Growing rapidly (Zed-backed, GitHub Copilot adopted it)
- **TypeScript types:** Yes, full TypeScript SDK
- **Installable via npm:** Yes
- **Can embed in Electron:** Yes. The SDK provides `ClientSideConnection` that connects to agents via stdio or TCP. You spawn the agent CLI process and pipe stdio — exactly like what we do now with Claude Code.
- **How it works:** Standardized JSON-RPC protocol over stdio/TCP. Each agent implements ACP server. Client spawns process, communicates via NDJSON.
- **Reliability:** 9/10 — Backed by Zed Industries, adopted by GitHub Copilot CLI, Gemini CLI, Goose, and 20+ agents. This is becoming the industry standard.
- **Confidence this fits our needs:** 7/10 — This is the most promising approach. However: not all agents support ACP natively yet (Claude Code's ACP support is via adapter, not native). The protocol covers editor-agent communication, which is close to but not identical to our CLI orchestration needs.
- **Critical note:** ACP is about standardizing the *protocol* between a client and an agent. It does NOT handle process spawning, worktree management, or team coordination — we'd still build that ourselves on top.

### 3. @posthog/code-agent
- **Repo:** https://github.com/PostHog/code (monorepo)
- **npm:** `@posthog/code-agent` (v0.2.0)
- **Language:** TypeScript
- **Supported agents:** Claude Code (Anthropic), OpenAI Codex (2 agents)
- **Last publish:** ~3 months ago
- **Stars:** Part of PostHog's code monorepo
- **TypeScript types:** Yes, full TypeScript
- **Installable via npm:** Yes
- **Can embed in Electron:** Yes — it's a pure TypeScript library
- **How it works:** Wraps Anthropic Claude Agent SDK and OpenAI Codex SDK behind a unified interface. Single API for streaming events, tool calls, diffs, permissions.
- **Features:** Unified permissions (strict/auto/permissive), MCP bridge, diff normalization, streaming events, auth discovery
- **Reliability:** 6/10 — Only 2 providers, no community adoption (0 dependents), published by PostHog for their own products
- **Confidence this fits our needs:** 4/10 — Too limited (only 2 agents). Uses official SDKs (not CLI spawn), which means it talks to APIs, not CLI processes. Different paradigm from what we need.

### 4. one-agent-sdk
- **Repo:** https://github.com/odysa/one-agent-sdk
- **Language:** TypeScript
- **Supported agents:** Claude Code, Codex, Kimi CLI (3 agents)
- **TypeScript types:** Yes
- **Installable via npm:** Appears to be (uses official provider SDKs)
- **Can embed in Electron:** Yes — pure TypeScript
- **How it works:** Wraps official SDKs (@anthropic-ai/claude-agent-sdk, @openai/codex-sdk, @moonshot-ai/kimi-agent-sdk) behind unified interface. Provider-agnostic tools, handoffs, middleware.
- **Reliability:** 4/10 — Very new, minimal community, only 3 providers
- **Confidence this fits our needs:** 3/10 — Same limitation as @posthog/code-agent: uses SDKs not CLI spawn. Only 3 agents. Too narrow.

### 5. Coder AgentAPI
- **Repo:** https://github.com/coder/agentapi
- **Language:** Go (server), OpenAPI 3.0.3 spec available
- **Supported agents:** Claude Code, Goose, Aider, Gemini, Amp, Codex (6 agents)
- **Stars:** ~996
- **Latest version:** v0.11.2
- **TypeScript types:** No official TS SDK, but OpenAPI spec available for generation
- **Installable via npm:** No (Go binary)
- **Can embed in Electron:** Partially. We'd bundle the Go binary and spawn it as subprocess.
- **How it works:** Runs an in-memory terminal emulator. Translates API calls into terminal keystrokes, parses agent outputs into messages. Simple 4-endpoint REST API (POST /message, GET /status, GET /events SSE, GET /messages).
- **Reliability:** 7/10 — Built by Coder (well-funded company), clean design, but terminal emulation approach has inherent limitations
- **Confidence this fits our needs:** 5/10 — Terminal emulation is clever but fragile. We'd need to bundle a Go binary. No native TypeScript SDK. Could generate one from OpenAPI spec.

---

## Tier 2: Standalone Apps with Adapter Architecture (Not Reusable Libraries)

These projects have interesting adapter/plugin architectures but are **standalone applications**, not importable libraries.

### 6. Overstory
- **Repo:** https://github.com/jayminwest/overstory
- **Language:** TypeScript (Bun runtime)
- **Architecture:** Pluggable `AgentRuntime` interface at `src/runtimes/types.ts`
- **Supported runtimes:** 11 (Claude Code, Pi, Gemini CLI, Aider, Goose, Amp, and custom)
- **Stars:** Growing
- **Reusable as library:** No. It's a CLI orchestrator (Bun-only, uses tmux). The `AgentRuntime` interface is embedded in the app, not published as a package.
- **Relevance:** The `AgentRuntime` interface design is good reference material for our own adapter pattern. Worth studying `src/runtimes/types.ts`.

### 7. conductor-oss (by charannyk06)
- **Repo:** https://github.com/charannyk06/conductor-oss
- **npm:** `conductor-oss` (launcher only)
- **Language:** Rust backend + TypeScript frontend (Next.js dashboard)
- **Architecture:** `conductor-executors` crate contains adapters for 10 agents
- **Supported agents:** Claude Code, Codex, Gemini, Qwen Code, Cursor Agent, Amp, OpenCode, Copilot, CCR (10 agents)
- **Reusable as library:** No. The agent adapters are Rust code in a Rust crate. The npm package is just a launcher that starts the Rust server.
- **Relevance:** Good reference for agent adapter patterns. The adapter architecture handles binary detection, launch commands, process monitoring, and prompt delivery.

### 8. Vibe Kanban
- **Repo:** https://github.com/BloopAI/vibe-kanban
- **npm:** `vibe-kanban` (npx wrapper)
- **Stars:** ~23.4k
- **Language:** Rust backend + TypeScript/React frontend
- **Architecture:** "Executor" plugin pattern for each agent
- **Supported agents:** 10+ (Claude Code, Codex, Gemini CLI, GitHub Copilot, Amp, Cursor, OpenCode, Droid, CCR, Qwen Code)
- **Reusable as library:** No. Executors are Rust code. TypeScript types are generated from Rust via ts-rs.
- **Relevance:** Closest competitor to our product. Their agent adapter pattern is in Rust, not reusable by us. But: there is a community TypeScript port `@nogataka/coding-agent-mgr` that claims to be a drop-in replacement — worth investigating.

### 9. Dorothy
- **Repo:** https://github.com/Charlie85270/Dorothy
- **Language:** Electron + React/Next.js
- **Architecture:** Agent Manager using node-pty
- **Supported agents:** Claude Code, Codex, Gemini
- **Reusable as library:** No. Standalone Electron desktop app.
- **Relevance:** Very similar architecture to ours (Electron + node-pty). Good reference for how they handle agent spawning. MCP server integration is interesting.

### 10. Emdash
- **Repo:** https://github.com/generalaction/emdash
- **Backed by:** Y Combinator W26
- **Language:** Electron + TypeScript
- **Supported agents:** 23 CLI providers
- **Reusable as library:** No. Standalone Electron app with SQLite/Drizzle.
- **Relevance:** Most similar to our product architecture-wise (Electron + TypeScript). Supports 23 agents. Worth studying their provider integration code for patterns. Auto-detects installed CLIs.

### 11. ComposioHQ Agent Orchestrator
- **Repo:** https://github.com/ComposioHQ/agent-orchestrator
- **npm:** `@composio/ao` (global CLI)
- **Language:** TypeScript (40,000 LOC)
- **Architecture:** 8 plugin slots (runtime, agent, workspace, tracker, SCM, notifier, terminal, lifecycle)
- **Supported agents:** Claude Code, Codex, Aider (and more via plugins)
- **Reusable as library:** Partially. The plugin interfaces are TypeScript, but the system is designed as a standalone CLI orchestrator.
- **Stars:** Growing (17 plugins, 3,288 tests)
- **Relevance:** The TypeScript plugin interface pattern could be extracted/adapted.

### 12. Parallel Code
- **Repo:** https://github.com/johannesjo/parallel-code
- **Language:** Desktop app (unspecified stack)
- **Supported agents:** Claude Code, Codex CLI, Gemini CLI
- **Reusable as library:** No. Standalone desktop app.

---

## Tier 3: MCP-Based Orchestrators (Different Paradigm)

### 13. all-agents-mcp
- **Repo:** https://github.com/Dokkabei97/all-agents-mcp
- **npm:** `all-agents-mcp` (npx)
- **Language:** TypeScript
- **Supported agents:** Claude Code, Codex, Gemini CLI, Copilot CLI (4 agents)
- **Architecture:** MCP server with agent abstraction layer (`src/agents/types.ts`, `base-agent.ts`, per-agent adapters)
- **Reusable as library:** Partially. The agent abstraction layer (`src/agents/`) could be extracted. But it's designed as an MCP server, not a library.
- **TypeScript types:** Yes
- **Relevance:** The `src/agents/` directory contains a clean TypeScript agent abstraction with `types.ts`, `base-agent.ts`, and per-agent implementations. This is the closest to a reusable adapter pattern in pure TypeScript.

### 14. agents-mcp (d-kimuson)
- **Repo:** https://github.com/d-kimuson/agents-mcp
- **Description:** MCP server for unified AI agents interface
- **Relevance:** Minimal info, likely similar pattern to all-agents-mcp

---

## Tier 4: Protocols / Standards (Not Libraries, But Important Context)

### 15. Agent Client Protocol (ACP)
- **Spec:** https://agentclientprotocol.com
- **Repo:** https://github.com/agentclientprotocol/agent-client-protocol
- **Created by:** Zed Industries
- **Adopted by:** GitHub Copilot CLI, Gemini CLI, Goose, Pi, OpenClaw, OpenCode, Cline, Codex, and 20+ agents
- **TypeScript SDK:** `@agentclientprotocol/sdk` (v0.14.1, 245 dependents, published 15 days ago)
- **This is becoming THE standard.** JSON-RPC over stdio/TCP. Editor spawns agent process, communicates via NDJSON.
- **Key insight:** If most agents converge on ACP, our adapter layer becomes simpler — we just need an ACP client.

### 16. agent-protocol (AI Engineers Foundation)
- **npm:** `agent-protocol` (v1.0.5)
- **Last published:** 2 years ago (dead)
- **Relevance:** Superseded by ACP. Not relevant.

---

## Tier 5: Tangentially Related (Process Management / Terminal Control)

### 17. terminalcp (@mariozechner/terminalcp)
- **Repo:** https://github.com/badlogic/terminalcp
- **npm:** `@mariozechner/terminalcp`
- **What:** "Playwright for the terminal" — MCP server that lets agents spawn and interact with any CLI tool
- **Uses:** node-pty + xterm.js for terminal emulation
- **Relevance:** Not an agent adapter, but the terminal spawn/control pattern (node-pty + xterm.js + Unix socket daemon) is exactly what we'd use if building our own.

### 18. Network-AI
- **Repo:** https://github.com/jovanSAPFIONEER/Network-AI
- **npm:** `network-ai`
- **Language:** TypeScript
- **What:** Multi-agent orchestrator with 14 adapters (LangChain, AutoGen, CrewAI, OpenAI, etc.)
- **Relevance:** The adapters are for AI *frameworks*, not CLI coding agents. Different domain.

### 19. execa
- **npm:** `execa` (millions of weekly downloads)
- **What:** Process execution for humans. Wrapper around child_process.
- **Relevance:** Not agent-specific, but the best foundation for spawning CLI processes in Node.js. We already use this pattern.

---

## Comprehensive Comparison Matrix

| Project | Type | npm pkg? | TS types? | Agents | Electron-safe? | Active? | Our fit |
|---------|------|----------|-----------|--------|-----------------|---------|---------|
| **ACP SDK** | Protocol SDK | Yes | Yes | 25+ | Yes | Very | **Best** |
| **Sandbox Agent SDK** | Unified API | Yes | Yes | 6 | Partial | Active | Good |
| **@posthog/code-agent** | SDK wrapper | Yes | Yes | 2 | Yes | Stale | Poor |
| **one-agent-sdk** | SDK wrapper | Yes | Yes | 3 | Yes | New | Poor |
| **Coder AgentAPI** | HTTP server | No (Go) | OpenAPI | 6 | Partial | Active | OK |
| **all-agents-mcp** | MCP server | Yes | Yes | 4 | Partial | Active | Reference |
| **Overstory** | CLI app | No | Yes | 11 | No (Bun+tmux) | Active | Reference |
| **conductor-oss** | App | Launcher | Rust | 10 | No (Rust) | Active | Reference |
| **Vibe Kanban** | App | Wrapper | Generated | 10+ | No (Rust) | Active | Reference |
| **Dorothy** | Electron app | No | Yes | 3+ | Same arch | Active | Reference |
| **Emdash** | Electron app | No | Yes | 23 | Same arch | Active | Reference |
| **ComposioHQ AO** | CLI app | Global | Yes | 3+ | Partial | Active | Reference |

---

## Recommendation

### Best Option: ACP SDK (`@agentclientprotocol/sdk`)
- **Reliability:** 9/10
- **Confidence:** 7/10

**Why:** ACP is becoming the industry standard. 25+ agents support it. Backed by Zed, adopted by GitHub Copilot. The TypeScript SDK is mature (v0.14.1, 245 dependents). It handles the protocol layer — we handle process spawning and team coordination on top.

**Risk:** Claude Code's ACP support is via adapter (not native stream-json). We'd need to verify Claude Code works with ACP in our specific use case (Agent Teams, stream-json mode). The protocol focuses on editor-agent communication, not CLI orchestration.

### Fallback: Build Our Own Adapter Layer
- **Reliability:** 8/10
- **Confidence:** 9/10

**Why:** Given that:
1. No library perfectly fits our Electron + Agent Teams architecture
2. The adapter layer is relatively thin (spawn process, pipe stdio, parse output)
3. We already have a working Claude Code integration via stream-json
4. ACP can be adopted incrementally as agents converge on it

We should define our own `IAgentRuntime` interface (inspired by Overstory's `AgentRuntime` and ACP's `AgentSideConnection`), implement Claude Code adapter first, then add ACP-based adapters for other agents.

### Reference implementations to study:
1. **ACP TypeScript SDK** — Protocol design, event schema, NDJSON streaming
2. **Overstory `src/runtimes/types.ts`** — AgentRuntime interface design for CLI agents
3. **all-agents-mcp `src/agents/`** — Clean TypeScript agent abstraction with base class
4. **Emdash provider integration** — How they handle 23 agents in Electron
5. **Sandbox Agent SDK event schema** — Universal session schema for normalizing agent events

---

## Sources

### Tier 1 (Libraries/SDKs)
- [Rivet Sandbox Agent SDK](https://github.com/rivet-dev/sandbox-agent) | [Docs](https://sandboxagent.dev/) | [InfoQ](https://www.infoq.com/news/2026/02/rivet-agent-sandbox-sdk/)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) | [npm](https://www.npmjs.com/package/@agentclientprotocol/sdk) | [Spec](https://agentclientprotocol.com)
- [@posthog/code-agent](https://www.npmjs.com/package/@posthog/code-agent) | [PostHog/code](https://github.com/PostHog/code)
- [one-agent-sdk](https://github.com/odysa/one-agent-sdk)
- [Coder AgentAPI](https://github.com/coder/agentapi)

### Tier 2 (Apps with Adapter Architecture)
- [Overstory](https://github.com/jayminwest/overstory)
- [conductor-oss](https://github.com/charannyk06/conductor-oss) | [npm](https://www.npmjs.com/package/conductor-oss)
- [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | [npm](https://www.npmjs.com/package/vibe-kanban)
- [Dorothy](https://github.com/Charlie85270/Dorothy) | [Site](https://dorothyai.app/)
- [Emdash](https://github.com/generalaction/emdash) | [Site](https://www.emdash.sh/)
- [ComposioHQ Agent Orchestrator](https://github.com/ComposioHQ/agent-orchestrator)
- [Parallel Code](https://github.com/johannesjo/parallel-code)

### Tier 3 (MCP Orchestrators)
- [all-agents-mcp](https://github.com/Dokkabei97/all-agents-mcp)

### Tier 4 (Protocols)
- [Agent Client Protocol](https://agentclientprotocol.com) | [GitHub](https://github.com/agentclientprotocol/agent-client-protocol) | [Copilot ACP](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/)
- [AI Code Agents SDK](https://felix-arntz.me/blog/introducing-ai-code-agents-a-typescript-sdk-to-solve-vendor-lock-in-for-coding-agents/) (Vercel AI SDK based, early stage)

### Tier 5 (Process/Terminal)
- [terminalcp](https://github.com/badlogic/terminalcp) | [npm](https://www.npmjs.com/package/@mariozechner/terminalcp)
- [Network-AI](https://github.com/jovanSAPFIONEER/Network-AI)

### Curated Lists
- [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)
- [awesome-cli-coding-agents](https://github.com/bradAGI/awesome-cli-coding-agents)

### HN Discussions
- [Show HN: Sandbox Agent SDK](https://news.ycombinator.com/item?id=46795584)
- [Show HN: OpenSwarm](https://news.ycombinator.com/item?id=47160980)
- [Show HN: Bridge from Copilot SDK to ACP](https://news.ycombinator.com/item?id=47165572)
- [Ask HN: Why CLI coding agents?](https://news.ycombinator.com/item?id=45115303)
