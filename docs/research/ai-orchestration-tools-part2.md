# AI Agent Orchestrators & Dispatchers — Part 2

> Research date: 2026-03-24
> Focus: Provider-agnostic agent abstraction layers, dispatch systems, and multi-agent coding orchestrators
> Scope: NEW tools not covered in Part 1

---

## Tier 1: Desktop Apps & ADEs (Agentic Development Environments)

These are the most relevant to our product — desktop applications that provide a UI layer for managing multiple coding agents.

### 1. Emdash (YC W26)

- **GitHub:** https://github.com/generalaction/emdash
- **Stars:** ~2,700+
- **License:** Open source (exact license TBD)
- **Language:** Electron-based desktop app
- **Unique:** First YC-backed "Agentic Development Environment" (ADE). Run multiple coding agents in parallel, each isolated in its own git worktree, either locally or over SSH.

**Agent providers:** 22 CLI agents supported — Claude Code, Qwen Code, Amp, Codex, Gemini CLI, and more.

**Architecture:**
- Each agent runs in its own git worktree with full isolation
- Built-in ticket integrations: Linear, GitHub, Jira — pass tickets directly to agents
- Remote development via SSH/SFTP with secure keychain credential storage
- Built-in diff review, PR creation, CI/CD checks, and merge
- Privacy-first: Emdash itself sends no code/chat data to any servers

**Integration potential:** DIRECT COMPETITOR. Very similar concept to our app. Key differences: Emdash is more a "parallel agent launcher" while we focus on team orchestration with inter-agent communication and kanban management.

**Maturity:** Active development, YC-backed, growing fast (966 -> 2700 stars in weeks). Available for macOS (Apple Silicon + Intel) and Linux.

**Source:** [GitHub](https://github.com/generalaction/emdash) | [emdash.sh](https://www.emdash.sh/) | [YC profile](https://www.ycombinator.com/companies/emdash)

---

### 2. Constellagent

- **GitHub:** https://github.com/owengretzinger/constellagent
- **Stars:** TBD (listed in awesome-agent-orchestrators)
- **License:** Open source
- **Language:** macOS desktop app
- **Unique:** Each agent gets its own terminal, editor, and git worktree — all in one window. macOS-native UI.

**Agent providers:** Any CLI-based coding agent (Claude Code, Codex, Gemini CLI, etc.)

**Architecture:**
- Side-by-side agent sessions with isolated git worktrees
- Built-in terminal + code editor per agent
- macOS-native (not Electron)

**Integration potential:** Simpler than our app but validates the "multi-agent desktop UI" market. macOS-only limits audience.

**Source:** [GitHub](https://github.com/owengretzinger/constellagent)

---

## Tier 2: CLI Orchestrators with Provider Abstraction

### 3. ORCH

- **GitHub:** https://www.orch.one/ (listed in awesome-agent-orchestrators)
- **Stars:** TBD
- **License:** MIT
- **Language:** TypeScript
- **Unique:** CLI runtime with formal STATE MACHINE for task lifecycle (`todo -> in_progress -> review -> done`). Agents talk to each other, share context, and run 24/7 as a daemon.

**Agent providers:** 5 built-in adapters — Claude (Anthropic), OpenCode (multi-provider via OpenRouter), Codex (OpenAI), Cursor, and a universal Shell adapter (anything that takes a prompt).

**Architecture:**
- Each AI tool wrapped in adapter implementing common interface (`src/infrastructure/adapters/`)
- Event bus with wildcard subscriptions for TUI activity feed
- Git worktree isolation per agent
- Inter-agent messaging + shared context
- All state stored locally in `.orchestry/` — no telemetry
- "Set goal at 10pm, wake up to pull requests"

**Integration potential:** Very interesting adapter pattern. The common interface + event bus architecture is close to what we'd need for a provider abstraction layer. Could study their adapter implementations.

**Source:** [orch.one](https://www.orch.one/) | [DEV article](https://dev.to/oxgeneral/orchestrating-a-team-of-ai-agents-from-a-single-cli-4h6)

---

### 4. Agent Swarm (Desplega AI)

- **GitHub:** https://github.com/desplega-ai/agent-swarm
- **Stars:** Notable stargazers (Andrew Ng, Chip Huyen). Exact count TBD.
- **License:** MIT
- **Language:** TypeScript
- **Unique:** Full lead/worker coordination with Docker isolation, compounding memory, persistent agent identity (SOUL.md, IDENTITY.md), and DAG-based workflow engine.

**Agent providers:** Claude Code (primary), pi-mono. Provider adapter pattern via `HARNESS_PROVIDER=claude|pi`. Codex, Gemini CLI support planned.

**Architecture:**
- Lead agent decomposes tasks, delegates to worker agents in Docker containers
- MCP API server backed by SQLite for communication and state
- Persistent searchable filesystem shared across swarm (agent-fs)
- Compounding memory: agents learn from every session via summaries + OpenAI embeddings
- Persistent identity: agents have evolving SOUL.md/IDENTITY.md files
- DAG-based workflow engine with triggers, conditions, checkpoint durability
- Integrations: Slack, GitHub, GitLab, Email, Linear
- Dashboard UI with real-time monitoring + debug dashboard with SQL query interface

**Integration potential:** Most feature-rich orchestrator found. The persistent identity and compounding memory concepts are innovative. Dashboard UI could inspire features.

**Source:** [GitHub](https://github.com/desplega-ai/agent-swarm) | [Docs](https://docs.agent-swarm.dev) | [Dashboard](https://agent-swarm.desplega.sh/)

---

### 5. Kodo

- **GitHub:** Listed in awesome-agent-orchestrators
- **Stars:** ~37
- **License:** Open source
- **Unique:** SWE-bench verified. Autonomous multi-agent orchestrator with independent architect and tester verification stages in work cycles.

**Agent providers:** Claude Code, Codex, Gemini CLI

**Architecture:**
- Directs agents through work cycles
- Independent architect verification
- Independent tester verification
- SWE-bench validated results

**Integration potential:** Small project but interesting verification-centric workflow approach.

**Source:** [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)

---

### 6. AgentFactory (Supaku)

- **GitHub:** https://github.com/supaku/agentfactory
- **Stars:** TBD
- **License:** Open source
- **Language:** TypeScript
- **Unique:** "Software factory" with assembly-line pipeline (dev -> QA -> acceptance). Distributed worker pool via Redis. Exposes fleet as MCP server. Implements A2A protocol v0.3.0.

**Agent providers:** Claude, Codex, Spring AI (via `AgentProvider` interface)

**Architecture:**
- `AgentProvider` interface for pluggable agent backends
- Pipeline: development -> QA -> acceptance (like CI/CD for agents)
- Distributed worker pool: webhook server + Redis queue + multiple worker nodes
- MCP server exposure: any MCP-aware client can interact with fleet
- A2A protocol support (v0.3.0) — operates as both client and server
- Spring AI Bench integration for benchmarking
- Scaffolding: `@supaku/create-agentfactory-app`
- One-click deploy to Vercel/Railway
- Linear integration for issue tracking

**Integration potential:** The A2A + MCP server approach is very forward-looking. Enterprise Java teams can use Spring AI agents alongside Claude/Codex.

**Source:** [GitHub](https://github.com/supaku/agentfactory)

---

## Tier 3: Framework-Level Abstraction Layers

### 7. Mozilla any-agent

- **GitHub:** https://github.com/mozilla-ai/any-agent
- **Stars:** ~1,100+
- **License:** Open source (Mozilla)
- **Language:** Python
- **Unique:** META-FRAMEWORK. Build agent once, switch frameworks by changing `AgentFramework` config parameter. Normalized logging via open-inference. Trace-first evaluation with LLM-as-judge.

**Agent frameworks supported:** Abstraction over multiple agent frameworks (not providers) — lets you swap between different frameworks without rewriting agent code.

**Architecture:**
- Single interface to different agent frameworks
- Normalized logging regardless of framework
- Trace-first evaluation approach
- Multi-agent via "Agents-As-Tools" pattern
- Companion projects: `any-llm` (LLM provider abstraction), `any-guardrail`, `Agent Factory` (natural language to agents), `mcpd` ("requirements.txt for agentic systems")

**Integration potential:** Different abstraction level than what we need. Useful if we want to abstract over agent frameworks rather than coding agent CLIs. The `mcpd` tool for MCP server management is interesting.

**Source:** [GitHub](https://github.com/mozilla-ai/any-agent) | [Blog](https://blog.mozilla.ai/introducing-any-agent-an-abstraction-layer-between-your-code-and-the-many-agentic-frameworks/) | [Docs](https://mozilla-ai.github.io/any-agent/)

---

### 8. VoltAgent

- **GitHub:** https://github.com/VoltAgent/voltagent
- **Stars:** TBD (active GitHub org with multiple repos)
- **License:** MIT
- **Language:** TypeScript
- **Unique:** "Refine.dev for AI agents" — TypeScript-first with n8n-style visual debugging console. Multi-agent orchestration with resumable streaming and voice support.

**Agent providers:** OpenAI, Anthropic, Google, and others — swap by changing config, not code.

**Architecture:**
- LLM-agnostic: provider swap via config
- Memory adapters (durable, cross-run)
- Resumable streaming: clients reconnect to in-flight streams after refresh
- RAG + Knowledge Base: managed document ingestion, chunking, embeddings, search
- Guardrails: runtime input/output validation
- Evals: built-in eval suites
- Voice: TTS/STT with OpenAI, ElevenLabs, custom providers
- VoltOps Console: observability, automation, deployment, evals (cloud & self-hosted)
- MCP docs server for AI coding assistants

**Integration potential:** Great TypeScript framework if we want to build our own agent abstraction. The resumable streaming pattern is relevant for Electron apps.

**Source:** [GitHub](https://github.com/VoltAgent/voltagent) | [voltagent.dev](https://voltagent.dev/)

---

### 9. Mastra

- **GitHub:** https://github.com/mastra-ai/mastra
- **Stars:** 7,500+ (as of early reports, likely higher now)
- **License:** Open source (EE features source-available under enterprise license)
- **Language:** TypeScript
- **Created by:** Team behind Gatsby (YC-backed)
- **Unique:** "Batteries-included TypeScript AI framework." Used by Replit Agent 3 (improved task success 80% -> 96%). Supports 81 LLM providers and 2,436+ models via Vercel AI SDK.

**Agent providers:** 40+ providers via Vercel AI SDK (OpenAI, Anthropic, Gemini, etc.)

**Architecture:**
- Model routing: 40+ providers through one interface
- Human-in-the-loop: suspend/resume with stored execution state
- Context management: conversation history, data retrieval, working + semantic memory
- MCP servers: expose agents/tools/resources via MCP
- Integration with React, Next.js, Node.js
- Serverless deployment: Vercel, Cloudflare, Netlify, or Mastra hosting
- `npm create mastra@latest` for quick start

**Integration potential:** Very mature TypeScript SDK. Could be used as an underlying agent framework in our Electron app. The human-in-the-loop suspend/resume is exactly what we need for kanban workflows.

**Source:** [GitHub](https://github.com/mastra-ai/mastra) | [mastra.ai](https://mastra.ai/) | [YC profile](https://www.ycombinator.com/companies/mastra)

---

## Tier 4: Coding Agent Platforms (Individual Agents with Multi-Provider Support)

### 10. Goose (Block)

- **GitHub:** https://github.com/block/goose
- **Stars:** 27,000+
- **License:** Apache 2.0
- **Language:** Rust
- **Unique:** By Block (Square, Cash App). 25+ LLM providers, 3,000+ MCP servers. Contributed to Linux Foundation's Agentic AI Foundation alongside Anthropic's MCP and OpenAI's AGENTS.md.

**Agent providers:** 25+ LLM providers (OpenAI, Anthropic, Google, DeepSeek, local via Ollama). Can even use Claude Code as a model provider inside Goose.

**Architecture:**
- Multi-provider with multi-model configuration (use different models for different tasks in same session)
- Subagents for parallel task execution with isolated workspaces
- MCP-native (among first agents to support MCP)
- CLI + Desktop app (not IDE-locked)
- Recipes system for reusable workflows
- Completely free + open source; you only pay LLM API costs

**Integration potential:** Goose itself is a coding agent, not an orchestrator. But its multi-provider architecture and MCP integration patterns are worth studying. Could be one of the agents our UI orchestrates.

**Source:** [GitHub](https://github.com/block/goose) | [block.github.io/goose](https://block.github.io/goose/) | [AI Tool Analysis Review](https://aitoolanalysis.com/goose-ai-review/)

---

### 11. OpenCode

- **GitHub:** https://github.com/opencode-ai/opencode
- **Stars:** 95K-120K+ (massive growth, surpassed Claude Code in stars)
- **License:** Open source
- **Language:** Go (Bubble Tea TUI)
- **Created by:** Team behind SST (Serverless Stack) and terminal.shop
- **Unique:** Go-based terminal agent with 75+ LLM providers. Built-in TUI with Vim-like editor. 5M+ monthly developers.

**Agent providers:** 75+ providers — OpenAI, Anthropic, Google Gemini, AWS Bedrock, Groq, Azure OpenAI, OpenRouter, and more.

**Architecture:**
- Interactive TUI built with Bubble Tea
- Session management with persistent SQLite storage
- Multiple agent types: plan agent (analysis), general-purpose agent (full tool access)
- Parallel work units
- MCP integration for external tools
- LSP integration for code intelligence
- Provider-agnostic philosophy: "as models evolve, being provider-agnostic is important"

**Integration potential:** OpenCode is a single-agent tool, not an orchestrator. However, it's the most popular open-source alternative to Claude Code. Worth considering as a supported runtime for our orchestrator.

**Source:** [GitHub](https://github.com/opencode-ai/opencode) | [opencode.ai](https://opencode.ai/) | [OpenCode Docs - Agents](https://opencode.ai/docs/agents/) | [OpenCode Docs - Providers](https://opencode.ai/docs/providers/)

---

### 12. OpenHands (formerly OpenDevin)

- **GitHub:** https://github.com/OpenHands/OpenHands
- **Stars:** 68,600+
- **License:** MIT
- **Language:** Python
- **Unique:** Cloud coding agent platform with $18.8M Series A. Solves 87% of bug tickets same day. Event stream architecture with typed events.

**Agent providers:** 100+ providers via LiteLLM (OpenAI, Anthropic, Google, etc.). Git providers: GitHub, GitLab, Bitbucket, Azure DevOps, Forgejo.

**Architecture:**
- Event stream architecture: all agent-environment interactions as typed events through central hub
- Agent -> Runtime -> EventStream -> LLM pipeline
- Hierarchical agent coordination via delegation tool
- Sub-agents as independent conversations inheriting parent config
- Distributed deployment: WebSocket for agent/runtime communication
- Isolated Docker/Kubernetes environments
- V1 SDK transition: moving from mandatory Docker to optional sandboxing
- Software Agent SDK for building custom agents

**Integration potential:** Enterprise-grade platform. The event stream architecture and typed events pattern could inspire our agent communication protocol.

**Source:** [GitHub](https://github.com/OpenHands/OpenHands) | [openhands.dev](https://openhands.dev/) | [Software Agent SDK paper](https://arxiv.org/html/2511.03690v1)

---

## Tier 5: Specialized Multi-Agent Coding Systems

### 13. Liza (Disciplined Multi Coding Agent System)

- **GitHub:** https://github.com/liza-mas/liza
- **Stars:** TBD
- **License:** Open source
- **Unique:** "Lisa Simpson vs Ralph Wiggum" philosophy. 55+ LLM failure modes mapped to countermeasures. Behavioral contracts, blackboard coordination, and explicit state machine. MOST disciplined approach to multi-agent coding.

**Architecture:**
- Behavioral contract with Tier 0 invariants (never violated)
- Blackboard coordination: shared file tracks goals, tasks, assignments, history
- Stateless agents with external specs for context handoff
- Approval Request mechanism forces reasoning before acting
- Deterministic pre/post hooks at role transitions
- Orchestrator-routed model selection
- Agent roles: Coder, Security Auditor, Security Audit Reviewer
- Sprint-based workflow: autonomous within sprints, human reviews between sprints
- CLI: `liza setup`, `liza init`, `liza agent coder`, `liza validate`, `liza watch`, `liza sprint-checkpoint`

**Integration potential:** The behavioral contract and blackboard coordination concepts are academically interesting and could improve agent reliability.

**Source:** [GitHub](https://github.com/liza-mas/liza)

---

### 14. Multi-Agent Coding System (Danau5tin)

- **GitHub:** https://github.com/Danau5tin/multi-agent-coding-system
- **Stars:** TBD
- **License:** Open source
- **Unique:** Reached #13 on Stanford's TerminalBench (slightly above Claude Code). Novel "Context Store" for multi-agent knowledge sharing. RL-trained 14B Orca-Agent model.

**Architecture:**
- Orchestrator + Explorer + Coder agents with knowledge artifacts
- Context Store: persistent knowledge layer with selective injection
- Trust Calibration Strategy: adaptive delegation based on task complexity
- Orchestrator cannot read/modify code directly — operates at architectural level only
- Companion project: Orca-Agent-RL (14B model, trained on 32x H100s)

**Integration potential:** The Context Store pattern for multi-agent knowledge sharing is a novel approach worth studying.

**Source:** [GitHub](https://github.com/Danau5tin/multi-agent-coding-system) | [Hacker News](https://news.ycombinator.com/item?id=45113348)

---

### 15. Open SWE (LangChain)

- **GitHub:** https://github.com/langchain-ai/open-swe
- **Stars:** 7,700+
- **License:** MIT
- **Language:** Python
- **Unique:** Built on LangGraph Deep Agents framework. Multi-agent architecture (Manager, Planner, Programmer, Reviewer). Captures patterns used by Stripe, Ramp, Coinbase for internal coding agents.

**Agent providers:** Any LLM via LangGraph. Multiple sandbox providers: Modal, Daytona, Runloop, LangSmith.

**Architecture:**
- Manager -> Planner -> Programmer -> Reviewer pipeline
- Isolated Daytona sandboxes per task
- Subagent orchestration via Deep Agents task tool
- Middleware hooks: deterministic middleware around agent loop
- AGENTS.md support: read from sandbox, injected into system prompt
- Async & cloud-native: multiple tasks in parallel, "double texting" support
- Integrations: Linear, Slack, GitHub

**Integration potential:** Enterprise-grade coding agent framework. The middleware hook pattern and AGENTS.md support are interesting patterns.

**Source:** [GitHub](https://github.com/langchain-ai/open-swe) | [LangChain Blog](https://blog.langchain.com/introducing-open-swe-an-open-source-asynchronous-coding-agent/)

---

### 16. DeerFlow 2.0 (ByteDance)

- **GitHub:** https://github.com/bytedance/deer-flow
- **Stars:** 37,000+
- **License:** MIT
- **Language:** Python
- **Unique:** ByteDance's "SuperAgent harness." Ground-up rewrite of v1. Multi-service architecture with Nginx reverse proxy. Skills system for extensibility. #1 GitHub Trending within 24h of launch.

**Agent providers:** Model-agnostic — any OpenAI-compatible API (GPT-4, Claude, Gemini, DeepSeek, local models via Ollama).

**Architecture:**
- Harness (core): agent orchestration, tools, sandbox, models, MCP, skills, config
- App layer: FastAPI Gateway API + IM channel integrations (Feishu, Slack, Telegram)
- Lead agent decomposes tasks, spawns sub-agents with scoped contexts
- Docker-sandboxed execution per sub-agent (own filesystem, bash terminal)
- Skills system: Markdown-based workflow definitions with best practices
- Persistent JSON memory system (user context, history, facts with confidence scores)
- Three sandbox modes (configurable via config.yaml)
- MCP servers with OAuth token flows

**Integration potential:** Impressive scale and ByteDance backing. Skills system is interesting — Markdown-based workflow definitions could be adapted for our agent team recipes.

**Source:** [GitHub](https://github.com/bytedance/deer-flow) | [deerflow.tech](https://deerflow.tech/) | [DeepWiki analysis](https://deepwiki.com/bytedance/deer-flow)

---

## Tier 6: Infrastructure & Runtime Frameworks

### 17. Dapr Agents (CNCF)

- **GitHub:** https://github.com/dapr/dapr-agents
- **Stars:** Part of Dapr ecosystem (34K+ stars for main Dapr project)
- **License:** Open source (CNCF)
- **Language:** Python (only)
- **Unique:** v1.0 GA announced at KubeCon Europe 2026. DurableAgent class: every LLM call and tool execution is a checkpoint. Kill process mid-workflow, resume from last saved point.

**Agent providers:** LLM provider decoupling via Dapr Conversation API — swap LLMs without code changes (OpenAI, Anthropic, AWS Bedrock, etc.)

**Architecture:**
- Kubernetes-native: distribute thousands of agents across pods/nodes
- DurableAgent with checkpoint/resume
- Multi-agent via Dapr pub/sub messaging
- Coordination models: LLM-based, random, round-robin
- SPIFFE identity for agent-to-agent authorization
- Distributed tracing via OTEL + Prometheus metrics
- mTLS encrypted communication
- Enterprise adoption: ZEISS, EU logistics companies

**Integration potential:** Overkill for desktop app, but the DurableAgent checkpoint/resume pattern could inspire our agent crash recovery. Python-only is a limitation.

**Source:** [GitHub](https://github.com/dapr/dapr-agents) | [Diagrid Blog](https://www.diagrid.io/blog/dapr-agents-1-0-durable-cloud-native-production-ready) | [KubeCon announcement](https://jangwook.net/en/blog/en/dapr-agents-v1-cncf-production-ai-framework/)

---

### 18. Sandcastle

- **GitHub:** https://github.com/gizmax/Sandcastle
- **Stars:** TBD
- **License:** Open source
- **Language:** Python
- **Unique:** EU AI Act compliance built-in. 63 integrations. YAML-defined workflows. Smart model routing (quality/cost/latency constraints per step). 118 built-in + 118 community workflow templates.

**Agent providers:** OpenAI, Anthropic, plus many more via multi-provider routing. Budget pressure detection forces cheaper models.

**Architecture:**
- YAML workflow definitions with DAG dependencies and parallel branches
- 4 sandbox backends: E2B cloud microVMs, Docker, Cloudflare Workers edge, local subprocess
- Smart model routing with historical performance data
- 5 browser automation modes (Playwright, Computer Use, DOM Extract, LightPanda, Browserbase)
- Real-time SSE dashboard (runs, costs, schedules, approvals, experiments)
- A/B testing models and prompts per step with auto-deployment
- Replay & checkpoints: re-run from any step
- PII redaction and tamper-evident audit trail
- Agent runtime with circuit breaker and pool management

**Integration potential:** Enterprise-grade workflow orchestrator. The smart model routing and A/B testing capabilities could be interesting for our team management feature.

**Source:** [GitHub](https://github.com/gizmax/Sandcastle) | [gizmax.cz/sandcastle](https://gizmax.cz/sandcastle/)

---

### 19. AgentScope + Runtime (Alibaba/Tongyi Lab)

- **GitHub:** https://github.com/agentscope-ai/agentscope (~18,900+ stars) + https://github.com/agentscope-ai/agentscope-runtime
- **License:** Open source
- **Language:** Python (+ Java implementation)
- **Unique:** Production-ready agent platform with SEPARATE runtime framework. Framework-agnostic runtime (not tied to AgentScope itself). "Agent as API" approach. Java SDK available.

**Agent providers:** OpenAI, DashScope, Gemini, Anthropic, self-hosted open-source models. Provider-agnostic via formatter system.

**Architecture:**
- AgentScope: agent development framework with multi-agent collaboration
- AgentScope Runtime: separate deployment infrastructure (sandboxing, state management, memory)
- Runtime is framework-agnostic — works with other agent frameworks too
- Agent-as-API: white-box development experience
- Multi-layer hook system for observability (OpenTelemetry integration)
- Serverless deployment support (Alibaba Cloud FC)
- Java implementation (Spring AI Alibaba, Langchain4j)
- ReAct agent built implementation-agnostic

**Integration potential:** The separation of agent framework from runtime is architecturally clean. The framework-agnostic runtime concept aligns with our need for a provider-neutral orchestration layer.

**Source:** [GitHub (main)](https://github.com/agentscope-ai/agentscope) | [GitHub (runtime)](https://github.com/agentscope-ai/agentscope-runtime)

---

### 20. OpenAgentsControl (OAC)

- **GitHub:** https://github.com/darrenhinde/OpenAgentsControl
- **Stars:** ~2,900
- **License:** Open source
- **Language:** Built on OpenCode
- **Unique:** Plan-first, approval-based execution. "Minimal Viable Information" (MVI) principle = 80% token reduction. Editable agents via Markdown files.

**Agent providers:** Model-agnostic — Claude, GPT, Gemini, local models (Ollama, LM Studio). Built on OpenCode.

**Architecture:**
- Propose -> Approve -> Execute model
- MVI principle: load only relevant patterns per task (80% token savings)
- Editable agents: modify behavior by editing Markdown files
- Custom Agent System Builder wizard
- Coding patterns committed to repos (team consistency)
- Multi-language: TypeScript, Python, Go, Rust

**Integration potential:** The MVI token reduction technique and editable Markdown agents are useful ideas. Plan-first approach aligns with structured team workflows.

**Source:** [GitHub](https://github.com/darrenhinde/OpenAgentsControl) | [BrightCoding review](https://www.blog.brightcoding.dev/2026/02/19/openagentscontrol-the-revolutionary-ai-agent-framework)

---

### 21. NeuroLink (Juspay)

- **GitHub:** https://github.com/juspay/neurolink
- **Stars:** ~119
- **License:** MIT
- **Language:** TypeScript
- **Unique:** Enterprise-grade unified API for 12 major AI providers and 100+ models. Extracted from production systems at Juspay. Multi-provider failover and automatic cost optimization.

**Agent providers:** 12 providers unified: OpenAI, Google, Anthropic, AWS, Azure, Groq, Together AI, Mistral, Cohere, Fireworks, Cloudflare, Ollama. 300+ models via OpenRouter integration.

**Architecture:**
- Single API for 12+ providers (switch with one parameter change)
- 64+ built-in tools and MCP servers
- Multi-step agentic loops with per-step tool execution control
- Persistent memory (Redis/S3/SQLite)
- HITL workflows
- Structured output with Zod schemas
- Auto cost optimization and multi-provider failover
- LiteLLM integration for 100+ models
- TypeScript SDK + professional CLI

**Integration potential:** Good TypeScript SDK for unified LLM access. If we need to add direct LLM provider abstraction (beyond just spawning CLI agents), NeuroLink's approach is solid.

**Source:** [GitHub](https://github.com/juspay/neurolink)

---

### 22. Pi-mono (badlogic)

- **GitHub:** https://github.com/badlogic/pi-mono
- **Stars:** TBD
- **License:** Open source
- **Language:** TypeScript (npm packages)
- **Unique:** Minimal terminal coding harness with 4 modes: interactive, print/JSON, RPC, and SDK for embedding. Extensible via TypeScript Extensions, Skills, Prompt Templates, and Themes.

**Agent providers:** Multi-provider via `Api` type union. Providers added by extending the API identifier system.

**Architecture:**
- Monorepo with multiple packages (`packages/coding-agent`, etc.)
- 4 modes: interactive, print/JSON, RPC (process integration), SDK (embedding)
- OpenClaw SDK integration for real-world use
- Extension system: TypeScript Extensions, Skills, Prompt Templates, Themes
- Packaged as npm packages for sharing
- Used as a provider in Agent Swarm (`HARNESS_PROVIDER=pi`)

**Integration potential:** The RPC and SDK modes are interesting for embedding a coding agent into our Electron app. Minimal footprint philosophy is appealing.

**Source:** [GitHub](https://github.com/badlogic/pi-mono)

---

### 23. Agentic Fleet (Qredence)

- **GitHub:** https://github.com/Qredence/agentic-fleet
- **Stars:** TBD
- **License:** Open source
- **Language:** Python (backend) + React 19 + TypeScript (frontend)
- **Unique:** Built on Microsoft Agent Framework's Magentic Fleet pattern. Five-phase pipeline: analysis -> routing -> execution -> progress -> quality.

**Architecture:**
- Backend: Python 3.12/3.13, FastAPI, Typer CLI, DSPy, Microsoft Agent Framework
- Frontend: React 19, TypeScript, Vite, Tailwind CSS, Radix UI, Shadcn UI
- ToolRegistry adapters (Tavily search, browser automation, code execution, MCP)
- Real-time SSE/WebSocket streaming
- Five-phase task pipeline

**Integration potential:** Good example of combining Microsoft Agent Framework with a React frontend. The ToolRegistry adapter pattern is relevant.

**Source:** [GitHub](https://github.com/Qredence/agentic-fleet)

---

### 24. Plandex

- **GitHub:** https://github.com/plandex-ai/plandex
- **Stars:** 15,086
- **License:** MIT
- **Language:** Go
- **Unique:** Terminal-based AI coding with 2M token context, full version control for AI plans (branches, diff review), and cumulative diff review sandbox.

**Agent providers:** Combine models from Anthropic, OpenAI, Google, and open source providers.

**Architecture:**
- 2M token context handling (~100k per file)
- Tree-sitter project maps for 20M+ token directories
- Version control for plans (branches, compare models)
- Cumulative diff review sandbox (changes separate until approved)
- Full autonomy capable but highly configurable step-by-step review
- Git integration with auto-commit

**Integration potential:** Single agent, not an orchestrator. But the plan version control and diff sandbox concepts are relevant to our code review feature.

**Source:** [GitHub](https://github.com/plandex-ai/plandex) | [plandex.ai](https://plandex.ai/)

---

## Tier 7: Evolving / Archived (Notable Mentions)

### 25. ControlFlow -> Marvin 3.0 (PrefectHQ)

- **GitHub:** https://github.com/PrefectHQ/ControlFlow (archived) -> https://github.com/PrefectHQ/marvin
- **Unique:** Task-centric architecture with Prefect 3.0 observability. Evolved into Marvin 3.0 using Pydantic AI for LLM interactions (full range of providers).
- **Note:** ControlFlow is archived, Marvin 3.0 is the successor with broader provider support.

**Source:** [GitHub (ControlFlow)](https://github.com/PrefectHQ/ControlFlow) | [GitHub (Marvin)](https://github.com/PrefectHQ/marvin)

---

## Summary Comparison Table

| Tool | Type | Stars | Language | Agent Providers | Desktop App | Key Differentiator |
|------|------|-------|----------|----------------|-------------|-------------------|
| **Emdash** | ADE | 2,700+ | Electron | 22 CLI agents | Yes | YC W26, tickets integration |
| **Constellagent** | ADE | TBD | macOS native | Any CLI agent | Yes (macOS only) | Terminal+editor+worktree per agent |
| **ORCH** | CLI | TBD | TypeScript | 5 adapters | TUI | State machine, inter-agent messaging |
| **Agent Swarm** | CLI+Dashboard | TBD | TypeScript | Claude, Pi | Dashboard UI | Compounding memory, persistent identity |
| **AgentFactory** | CLI+Web | TBD | TypeScript | Claude, Codex, Spring AI | Dashboard | A2A protocol, MCP server, Redis pool |
| **Goose** | Agent | 27K+ | Rust | 25+ LLM providers | Desktop+CLI | Linux Foundation, MCP-native |
| **OpenCode** | Agent | 95K+ | Go | 75+ providers | TUI | Fastest-growing, Bubble Tea UI |
| **OpenHands** | Platform | 68K+ | Python | 100+ via LiteLLM | Web UI | $18.8M Series A, event stream arch |
| **DeerFlow** | Harness | 37K+ | Python | Any OpenAI-compatible | Web UI | ByteDance, skills system |
| **Open SWE** | Framework | 7,700+ | Python | Any via LangGraph | No | LangChain, enterprise patterns |
| **Mastra** | Framework | 7,500+ | TypeScript | 40+ providers | No | By Gatsby team, used by Replit |
| **Mozilla any-agent** | Meta-framework | 1,100+ | Python | Framework abstraction | No | Switch frameworks, not providers |
| **VoltAgent** | Framework | TBD | TypeScript | OpenAI, Anthropic, Google | Console UI | Resumable streaming, voice |
| **Dapr Agents** | Runtime | Part of 34K+ | Python | Via Conversation API | No | CNCF, Kubernetes-native, durable agents |
| **Liza** | System | TBD | CLI | Any LLM | No | Behavioral contracts, 55+ failure modes |
| **Sandcastle** | Orchestrator | TBD | Python | Multi-provider routing | Dashboard | EU AI Act, YAML workflows, 118 templates |

---

## Key Architectural Patterns Observed

### 1. Agent Runtime Interface Pattern
**Used by:** ORCH, Overstory, Agent Swarm, AgentFactory
- Define a common interface (spawn, configure, detect readiness, parse transcript)
- Each agent provider gets an adapter implementing this interface
- Swap providers without changing orchestration logic

### 2. Git Worktree Isolation Pattern
**Used by:** Emdash, Constellagent, ORCH, Agent Swarm, ComposioHQ
- Standard approach for multi-agent parallel work
- Each agent gets its own worktree + branch
- Merge back via PR/conflict resolution

### 3. Event Stream / Pub-Sub Architecture
**Used by:** OpenHands, ORCH, Dapr Agents
- All agent interactions as typed events through central hub
- Enables observability, replay, and debugging

### 4. Checkpoint/Resume (Durable Execution)
**Used by:** Dapr Agents, Sandcastle, Mastra
- Every step saves a checkpoint
- Kill process mid-workflow -> resume from last saved point
- Critical for production reliability

### 5. Lead-Worker Decomposition
**Used by:** Agent Swarm, DeerFlow, Open SWE, Claude Agent Teams (ours)
- Lead agent decomposes tasks
- Workers execute in isolation
- Results stitched back together

---

## Integration Relevance for Claude Agent Teams UI

### Direct Competitors (UI level)
1. **Emdash** — Most direct competitor. YC-backed. 22 agents. But lacks kanban, inter-agent communication, and team orchestration.
2. **Constellagent** — macOS-only. Simpler scope.

### Architectural Inspiration
1. **ORCH** — Adapter interface pattern for agent providers + state machine for task lifecycle
2. **Agent Swarm** — Compounding memory + persistent identity + dashboard UI
3. **AgentFactory** — A2A protocol + MCP server exposure + pipeline stages
4. **VoltAgent** — TypeScript-first framework with resumable streaming (relevant for Electron)
5. **Mastra** — Human-in-the-loop suspend/resume via stored state

### Worth Studying
1. **Liza** — Behavioral contracts for agent reliability
2. **Mozilla any-agent** — Meta-framework approach
3. **OpenHands** — Event stream architecture at scale
4. **DeerFlow** — Skills system (Markdown-based workflow definitions)

### Key Competitive Advantages We Have
- **Kanban board** — NO ONE else has this for agent orchestration
- **Inter-agent communication** — Most tools only have lead-worker, not peer-to-peer
- **Code review workflow** — Diff view per task with approve/reject
- **Claude Code Agent Teams native support** — Built specifically for Claude's team protocol
- **Context monitoring** — Token usage tracking by category (unique)
- **Zero-setup onboarding** — Built-in Claude Code installation
