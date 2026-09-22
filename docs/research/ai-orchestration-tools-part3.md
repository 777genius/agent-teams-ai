# AI Orchestration Tools Research — Part 3

**Date:** 2026-03-24
**Focus:** Emerging/niche agent orchestrators, infrastructure-level tools, protocol-first frameworks, TypeScript/Node-based solutions, fleet managers

---

## Table of Contents

1. [TypeScript-First Agent Frameworks](#1-typescript-first-agent-frameworks)
2. [Infrastructure & Gateway Layer](#2-infrastructure--gateway-layer)
3. [Durable Execution & Workflow Engines](#3-durable-execution--workflow-engines)
4. [Visual & Low-Code Agent Builders](#4-visual--low-code-agent-builders)
5. [Protocol Standards & Ecosystem](#5-protocol-standards--ecosystem)
6. [Coding Agent Fleet Managers](#6-coding-agent-fleet-managers)
7. [Python-First Frameworks (with TS relevance)](#7-python-first-frameworks-with-ts-relevance)
8. [Summary Matrix](#8-summary-matrix)
9. [Recommendations for Claude Agent Teams UI](#9-recommendations-for-claude-agent-teams-ui)

---

## 1. TypeScript-First Agent Frameworks

### 1.1 Mastra AI

- **URL:** https://github.com/mastra-ai/mastra
- **Stars:** ~22.3k (March 2026)
- **npm downloads:** 300k+/week
- **License:** Apache 2.0
- **Funding:** $13M seed (YC W25, Paul Graham, Gradient Ventures)
- **Source:** [Mastra GitHub](https://github.com/mastra-ai/mastra), [Mastra Docs](https://mastra.ai/docs), [The New Stack](https://thenewstack.io/mastra-empowers-web-devs-to-build-ai-agents-in-typescript/)

**What it is:** From the team behind Gatsby — a full-featured TypeScript framework for AI agents, workflows, RAG, and memory. Model routing to 40+ providers through one interface (OpenAI, Anthropic, Gemini, etc.).

**Architecture highlights:**
- **Agents** — autonomous entities with LLM + tools + system instructions
- **Workflows** — graph-based state machines with discrete steps, inputs/outputs
- **Memory** — short-term and long-term memory across threads and sessions
- **Mastra Studio** — local developer playground for visualization/debugging
- **Production tools** — built-in evals, observability, tracing

**Enterprise adoption:** Replit (Agent 3), SoftBank, Marsh McLennan (75k employees), PayPal, Adobe, Docker.

**Relevance for Electron integration:**
- Pure TypeScript, runs on Node.js natively
- Can deploy as standalone server or embed in existing Node apps
- Most mature TS agent framework by adoption metrics
- Workflow engine could serve as orchestration backend
- **Confidence: 9/10, Reliability: 9/10**

---

### 1.2 Inngest AgentKit

- **URL:** https://github.com/inngest/agent-kit
- **Stars:** ~793
- **npm:** `@inngest/agent-kit`
- **License:** Apache 2.0 (core), proprietary cloud
- **Source:** [AgentKit Docs](https://agentkit.inngest.com/overview), [Inngest Blog](https://www.inngest.com/blog/ai-orchestration-with-agentkit-step-ai)

**What it is:** TypeScript library for building multi-agent networks with deterministic routing, MCP tooling, and durable execution through Inngest's workflow engine.

**Architecture highlights:**
- **Agents** — LLM calls with prompts, tools, and MCP
- **Networks** — agents collaborate with shared State and handoff
- **Routers** — from code-based to LLM-based (ReAct) orchestration
- **State** — typed state machine combined with conversation history
- **Tracing** — built-in debug/optimize locally and in cloud
- **React hooks** — `@inngest/use-agent` for frontend integration
- Supports OpenAI, Anthropic, Gemini, and OpenAI-compatible models

**Key differentiator:** Backed by Inngest's durable execution engine — agents survive crashes, can pause/resume, and handle long-running tasks with automatic retries. This is critical for production reliability.

**Relevance for Electron integration:**
- Pure TypeScript, lightweight
- Good abstraction for multi-agent networks with routing
- Durable execution is exactly what production agent teams need
- React hooks for UI integration
- **Confidence: 7/10, Reliability: 7/10**

---

### 1.3 VoltAgent

- **URL:** https://github.com/VoltAgent/voltagent
- **Stars:** ~5.1k (March 2026)
- **License:** MIT
- **Source:** [VoltAgent site](https://voltagent.dev/), [GitHub](https://github.com/VoltAgent/voltagent), [MarkTechPost](https://www.marktechpost.com/2025/04/22/meet-voltagent-a-typescript-ai-framework-for-building-and-orchestrating-scalable-ai-agents/)

**What it is:** Observability-first TypeScript AI agent framework with Memory, RAG, Guardrails, Tools, MCP, Voice, Workflow support.

**Architecture highlights:**
- **VoltOps Console** — like n8n but for debugging AI agents (cloud & self-hosted)
- Multi-agent workflows via Chain API — compose, branch, orchestrate
- Workflow steps typed with Zod schemas (compile-time safety + runtime validation)
- Human-in-the-loop with pause/resume
- MCP support, bring-your-own LLMs

**Key differentiator:** Observability as a first-class concern. The VoltOps console provides real-time monitoring, debugging, and workflow visualization — useful for our kanban-style task monitoring.

**Relevance for Electron integration:**
- MIT license, TypeScript-first, Node.js native
- Observability features could complement our session analysis
- Zod-based typing aligns with our codebase patterns
- **Confidence: 7/10, Reliability: 6/10**

---

### 1.4 HazelJS

- **URL:** https://github.com/hazel-js/hazeljs
- **Stars:** Small (early alpha)
- **npm:** `@hazeljs/core`, `@hazeljs/agent`, `@hazeljs/ai`, etc. (38+ packages)
- **License:** Apache 2.0
- **Source:** [HazelJS site](https://hazeljs.ai/), [DEV.to](https://dev.to/arslan_mecom/from-beta-to-alpha-the-hazeljs-journey-in-38-packages-3nad)

**What it is:** AI-native backend framework with production-grade Agent Runtime, Agentic RAG, and persistent memory. NestJS-style decorator-based API.

**Architecture highlights:**
- Modular: 40+ installable npm packages (core, ai, agent, rag, memory, flow, auth, cache...)
- **AgentGraph** + **SupervisorAgent** for multi-agent orchestration
- **@hazeljs/flow** — durable workflow engine with wait/resume, idempotency, retries
- **@hazeljs/memory** — pluggable user memory (in-memory, Postgres, Redis, Prisma, vector)
- Decorator-based: `@Agent`, `@Tool`, `@Controller`, `@SemanticSearch`
- Supports OpenAI, Anthropic, Ollama

**Key differentiator:** Full backend framework approach (not just agents), NestJS-inspired architecture. Combines web framework + agent runtime + durable workflows in one stack.

**Relevance for Electron integration:**
- TypeScript-first, modular npm packages
- Durable flow engine could be useful
- Very early (alpha) — risky for production
- **Confidence: 5/10, Reliability: 4/10**

---

### 1.5 Agentica

- **URL:** https://github.com/wrtnlabs/agentica
- **npm:** `@agentica/core`, `@agentica/rpc`
- **License:** MIT
- **Source:** [Agentica Docs](https://wrtnlabs.io/agentica/), [GitHub](https://github.com/wrtnlabs/agentica)

**What it is:** TypeScript framework specialized in LLM Function Calling, enhanced by the TypeScript compiler. By Wrtn Technologies.

**Architecture highlights:**
- **Compiler-driven development** — constructs function calling schemas automatically from TypeScript types via `typia`
- Auto-converts Swagger/OpenAPI/MCP documents into function calling schemas
- **Validation feedback** — detects and corrects AI mistakes in argument composition
- **Selector agent** — filters candidate functions to minimize context/tokens
- Supports embedded controllers: Google Calendar, GitHub, Reddit, Slack, etc.

**Key differentiator:** Instead of complex agent graphs/workflows, you just list TypeScript class types or OpenAPI docs, and Agentica handles function calling automatically. The compiler does the heavy lifting.

**Relevance for Electron integration:**
- MIT license, TypeScript-native
- Interesting approach for auto-generating tool interfaces
- Could be useful for generating agent tool schemas from existing code
- **Confidence: 6/10, Reliability: 5/10**

---

### 1.6 Strands Agents (AWS)

- **URL:** https://github.com/strands-agents
- **Downloads:** 14M+ total (since May 2025)
- **License:** Open source (Apache 2.0)
- **Source:** [Strands site](https://strandsagents.com/), [AWS Blog](https://aws.amazon.com/blogs/opensource/introducing-strands-agents-an-open-source-ai-agents-sdk/)

**What it is:** Open source SDK from AWS for building AI agents in Python and TypeScript. Model-driven approach — works with Bedrock, Anthropic, OpenAI, and more.

**Architecture highlights:**
- TypeScript SDK (preview, December 2025) with full type safety, async/await
- Native tools for AWS service interactions
- Edge device support (sub-100ms latency, ARM/x86, offline with llama.cpp)
- **Steering** — modular prompt mechanism to guide agents mid-execution
- **Evaluations** — validate agent behavior
- Multi-agent patterns: Agent-as-Tool, Swarm

**Key differentiator:** AWS backing, production-tested at enterprise scale. TypeScript support enables browser/server/Lambda deployment. Edge device support is unique.

**Relevance for Electron integration:**
- TypeScript SDK available
- AWS-heavy ecosystem may add unwanted dependencies
- Good multi-agent patterns (Agent-as-Tool, Swarm)
- **Confidence: 7/10, Reliability: 7/10**

---

### 1.7 OpenAI Agents SDK (TypeScript)

- **URL:** https://github.com/openai/openai-agents-js
- **Stars:** ~2.1k
- **npm downloads:** ~128k/week
- **License:** MIT
- **Source:** [OpenAI Agents SDK TS](https://openai.github.io/openai-agents-js/)

**What it is:** Official OpenAI framework for multi-agent workflows and voice agents in TypeScript.

**Architecture highlights:**
- Agents as tools / Handoffs for cross-agent delegation
- Guardrails for input validation, run in parallel with agent execution
- Function tools with Zod-powered validation and automatic schema generation
- Built-in MCP server tool integration
- TypeScript-first: orchestrate agents using native language features

**Key differentiator:** Official OpenAI support, lightweight but powerful. Handoff mechanism is well-designed for multi-agent coordination.

**Relevance for Electron integration:**
- MIT license, pure TypeScript
- Strong typing with Zod
- Model-locked to OpenAI (primary limitation)
- **Confidence: 8/10, Reliability: 7/10**

---

### 1.8 Google ADK for TypeScript

- **URL:** https://developers.googleblog.com/introducing-agent-development-kit-for-typescript-build-ai-agents-with-the-power-of-a-code-first-approach/
- **Stars:** ~581 (December 2025 launch)
- **npm downloads:** ~5k/week
- **License:** Apache 2.0
- **Source:** [Google Developers Blog](https://developers.googleblog.com/introducing-agent-development-kit-for-typescript-build-ai-agents-with-the-power-of-a-code-first-approach/)

**What it is:** Google's open-source TypeScript framework for building AI agents and multi-agent systems. Code-first approach.

**Architecture highlights:**
- First-class MCP and A2A protocol support
- Multi-agent coordination
- Code-first TypeScript development

**Key differentiator:** Google backing, first-class A2A support. Strong protocol-first approach.

**Relevance for Electron integration:**
- Pure TypeScript, Apache 2.0
- Still young (December 2025 launch)
- A2A support could be important for future interop
- **Confidence: 6/10, Reliability: 5/10**

---

## 2. Infrastructure & Gateway Layer

### 2.1 AgentGateway

- **URL:** https://github.com/agentgateway/agentgateway
- **Stars:** ~2k+ (hit 1M image pulls, 115 contributors)
- **License:** Open source (Linux Foundation)
- **Language:** Rust
- **Source:** [AgentGateway site](https://agentgateway.dev/), [GitHub](https://github.com/agentgateway/agentgateway), [Solo.io Blog](https://www.solo.io/blog/updated-a2a-and-mcp-gateway)

**What it is:** Next-generation agentic proxy for AI agents and MCP servers. A production-ready gateway for the agentic era, written in Rust.

**Architecture highlights:**
- **MCP + A2A protocol support** — deep protocol awareness
- **RBAC** — robust role-based access control for MCP/A2A
- **Multi-tenancy** — each tenant with own resources and users
- **Dynamic config via xDS** — no downtime updates
- **Kubernetes-native** — built-in Kubernetes controller via Gateway API
- **LLM routing** — can route traffic to OpenAI, Anthropic, Gemini, Bedrock
- **Legacy API translation** — transforms OpenAPI specs into MCP tools automatically
- **v1.0 released** — production-ready milestone

**Key differentiator:** The infrastructure layer between agents and their tools/peers. Not an agent framework itself, but the network fabric that makes multi-agent systems work in production. Backed by Solo.io (Envoy/Istio experts), donated to Linux Foundation.

**Relevance for Electron integration:**
- Written in Rust — not directly embeddable in Node.js
- Could be used as a sidecar/proxy process alongside Electron
- OpenAPI-to-MCP translation is very useful for tool integration
- **Confidence: 6/10, Reliability: 8/10**

---

### 2.2 MCP Gateway & Registry

- **URL:** https://github.com/agentic-community/mcp-gateway-registry
- **License:** Open source
- **Source:** [GitHub](https://github.com/agentic-community/mcp-gateway-registry)

**What it is:** Enterprise-ready MCP Gateway & Registry that centralizes AI development tools with OAuth authentication, dynamic tool discovery, and unified access for AI agents and coding assistants.

**Architecture highlights:**
- Unified MCP Server Gateway — single access point
- MCP Servers Registry — dynamic tool discovery
- Agent Registry & A2A Communication Hub
- Dual authentication: human user + machine-to-machine agent auth
- Keycloak/Entra integration for enterprise SSO

**Key differentiator:** Governance layer for MCP servers — transforms "scattered MCP server chaos into governed, auditable tool access." This is the missing middleware between agents and tools.

**Relevance for Electron integration:**
- Could solve MCP server management for team agents
- OAuth/auth layer would be useful for enterprise deployments
- **Confidence: 5/10, Reliability: 5/10**

---

### 2.3 Invariant Gateway

- **URL:** https://github.com/invariantlabs-ai/invariant-gateway
- **License:** Open source
- **Source:** [GitHub](https://github.com/invariantlabs-ai/invariant-gateway)

**What it is:** LLM proxy to observe and debug what AI agents are doing. Supports MCP (stdio, SSE, Streamable HTTP) tool calling. Integrates with LiteLLM.

**Key differentiator:** Focused on observability and debugging of agent tool calls — complementary to our session analysis features.

---

## 3. Durable Execution & Workflow Engines

### 3.1 Temporal

- **URL:** https://github.com/temporalio/temporal
- **Stars:** 13k+
- **Valuation:** $5B (Series D, February 2026, led by a16z)
- **License:** MIT
- **Source:** [Temporal Blog](https://temporal.io/blog/of-course-you-can-build-dynamic-ai-agents-with-temporal), [Temporal A16Z Funding](https://temporal.io/blog/temporal-raises-usd300m-series-d-at-a-usd5b-valuation)

**What it is:** The foundational durable execution platform. Separates Workflows (orchestration) from Activities (actual work like LLM calls). Agents survive crashes and resume exactly where they left off.

**Architecture highlights:**
- **Workflow/Activity separation** — deterministic orchestration + non-deterministic LLM calls
- **Event History** — full record of past decisions for crash recovery
- **OpenAI Agents SDK integration** (public preview) — durable agents out of the box
- **PydanticAI integration** — durable Python agents
- **Handles 150k+ actions/second** — battle-tested at scale

**Enterprise adoption:** OpenAI (Codex runs on Temporal), Replit, Lovable, ADP, Abridge, Washington Post, Block.

**Key differentiator:** The gold standard for durable execution. If AI agents need to run for hours/days, survive crashes, and handle human-in-the-loop — Temporal is the infrastructure layer that makes it work.

**Relevance for Electron integration:**
- TypeScript SDK available
- Requires a server component (can self-host or use cloud)
- Adds significant operational complexity
- Best for server-side orchestration, not embedded in Electron
- **Confidence: 9/10, Reliability: 10/10**

---

### 3.2 Trigger.dev

- **URL:** https://github.com/triggerdotdev/trigger.dev
- **Stars:** ~13.9k
- **License:** Apache 2.0
- **Source:** [Trigger.dev site](https://trigger.dev/), [AI Agents docs](https://trigger.dev/product/ai-agents), [GitHub](https://github.com/triggerdotdev/trigger.dev)

**What it is:** Platform for building and deploying fully-managed AI agents and workflows. Durable execution with checkpoint-resume (CRIU).

**Architecture highlights:**
- **Orchestrator pattern** — breaks jobs into smaller tasks, assigns to specialists
- **Realtime streaming** — live status updates, LLM response streaming to frontend
- **Vercel AI SDK integration** — `ai.tool` creates tools from tasks
- **MCP Server** — interact with projects from Claude Code, Cursor, etc.
- **batch.triggerByTaskAndWait** — efficient parallel coordination
- **Elastic infrastructure** — auto-scaling, concurrency control

**Key differentiator:** Durable execution + realtime streaming + MCP server. The MCP server integration means agents in our app could trigger/monitor Trigger.dev tasks.

**Relevance for Electron integration:**
- TypeScript-native
- Server-side platform (not embeddable in Electron directly)
- Good as external orchestration backend
- MCP integration is a natural bridge
- **Confidence: 7/10, Reliability: 8/10**

---

### 3.3 Hatchet

- **URL:** https://github.com/hatchet-dev/hatchet
- **Stars:** ~4.5k+
- **License:** MIT
- **SDKs:** Python, TypeScript, Golang
- **Source:** [Hatchet site](https://hatchet.run/), [Docs](https://docs.hatchet.run/v1), [GitHub](https://github.com/hatchet-dev/hatchet)

**What it is:** Open-source platform for AI agent orchestration, background tasks, and mission-critical workflows. YC W24.

**Architecture highlights:**
- General-purpose: queue + DAG orchestrator + durable execution engine
- **AI agent primitives** — retries, parallel tool calls, state management, guardrails
- **Fairness** — distributes requests fairly, prevents busy-user overwhelm
- **Concurrency control** — FIFO, LIFO, Round Robin, Priority Queues
- **Human-in-the-loop** — eventing for signaling and streaming
- Built on PostgreSQL — simple self-hosting
- Web UI for monitoring

**Key differentiator:** Lower operational overhead than Temporal (just PostgreSQL), while providing similar durable execution guarantees. The fairness and concurrency controls are specifically designed for AI agent workloads.

**Relevance for Electron integration:**
- TypeScript SDK available
- Simpler to self-host than Temporal
- Could be bundled with Electron app (just needs PostgreSQL)
- **Confidence: 7/10, Reliability: 7/10**

---

### 3.4 Windmill

- **URL:** https://github.com/windmill-labs/windmill
- **Stars:** ~13k+
- **License:** AGPLv3
- **Source:** [Windmill site](https://www.windmill.dev/), [AI Agents Blog](https://www.windmill.dev/blog/ai-agents)

**What it is:** Open-source developer platform for building internal tools, workflows, and automations. Supports 20+ languages including TypeScript (Bun runtime).

**Architecture highlights:**
- **AI Agent Steps** — any Windmill script becomes a tool the AI agent can invoke
- **Automatic tool definitions** — JSON schema from scripts becomes agent tool definitions
- **Multi-language tools** — Python, TypeScript, Go, Rust, PHP, Bash, SQL, etc.
- **MCP integration** — agents connect to external MCP servers
- **Visual DAG editor** + workflows-as-code (Python/TypeScript)
- **~50ms added latency** — very performant

**Key differentiator:** Any script in any language automatically becomes an agent tool. The "scripts as tools" approach is uniquely pragmatic — no separate tool registration needed.

**Relevance for Electron integration:**
- AGPLv3 license (restrictive for embedding)
- Docker-based deployment
- Better as external orchestration service
- **Confidence: 6/10, Reliability: 7/10**

---

## 4. Visual & Low-Code Agent Builders

### 4.1 Dify

- **URL:** https://github.com/langgenius/dify
- **Stars:** ~129.8k (most-starred agent framework on GitHub)
- **License:** Apache 2.0 (core)
- **Source:** [Dify site](https://dify.ai/), [GitHub](https://github.com/langgenius/dify), [Medium](https://medium.com/@gptproto.official/dify-the-open-source-standard-for-ai-orchestration-777a7bae3bb4)

**What it is:** Open-source LLM app development platform with visual workflow builder, RAG pipeline, agent capabilities, and model management.

**Architecture highlights:**
- **Visual canvas** for building AI workflows
- **Hundreds of LLM integrations** — any OpenAI-compatible model
- **50+ built-in tools** for agents
- **MCP integration** — supports HTTP-based MCP services (protocol 2025-03-26)
- Can turn Dify workflows/agents into MCP servers
- **Backend-as-a-Service** — all features via REST API
- 180k+ developers, 59k+ end users

**Key differentiator:** The most popular open-source agent platform by stars. Strong visual workflow editor. Can expose workflows as MCP servers — meaning our app could consume Dify workflows as tools.

**Relevance for Electron integration:**
- Python/Docker backend — not embeddable in Electron
- REST API could be consumed from our Electron app
- MCP server mode is very interesting for integration
- **Confidence: 7/10, Reliability: 8/10**

---

### 4.2 n8n

- **URL:** https://github.com/n8n-io/n8n
- **Stars:** ~180.7k
- **License:** Fair-code (Sustainable Use License)
- **Source:** [n8n site](https://n8n.io/), [AI Agents](https://n8n.io/ai-agents/), [GitHub](https://github.com/n8n-io/n8n)

**What it is:** Fair-code workflow automation platform with native AI capabilities. 400+ integrations, visual builder + code.

**Architecture highlights:**
- **AI Agent node** — connects to LLMs, integrates with tools
- **MCP Server** — call n8n workflows from other AI systems
- **Human-in-the-loop** — approval at any workflow point
- **Multi-agent & RAG support**
- Full observability: inspect prompts, responses, execution flow

**Limitations:** Lacks persistent memory, autonomous planning, and dynamic decision-making. Better for structured tasks than truly autonomous agents.

**Relevance for Electron integration:**
- TypeScript-based (Node.js)
- Could theoretically be embedded, but it's a full platform
- Fair-code license may be restrictive
- Better as external orchestration service consumed via MCP
- **Confidence: 6/10, Reliability: 7/10**

---

### 4.3 Rivet

- **URL:** https://github.com/Ironclad/rivet
- **Stars:** ~3.9k
- **License:** Open source
- **Source:** [Rivet site](https://rivet.ironcladapp.com/), [GitHub](https://github.com/Ironclad/rivet)

**What it is:** Visual AI programming environment for building AI agents with LLMs. By Ironclad. Desktop app + TypeScript runtime library.

**Architecture highlights:**
- **Node-based visual editor** — drag-and-drop AI chains
- **Real-time debugging** — watch graph execute step-by-step, remote debugging
- **Graph nesting** — modular, reusable components
- **Graphs as YAML** — version control, code review
- **TypeScript runtime library** (`rivet-core`) — run graphs programmatically
- **`rivet serve`** — expose any graph as HTTP endpoint
- **Plugin ecosystem** — Anthropic, HuggingFace, MongoDB plugins

**Key differentiator:** Desktop Electron app with visual AI chain builder + TypeScript runtime. The "graphs as YAML + TypeScript execution" approach is very relevant — could potentially embed Rivet's runtime in our app.

**Relevance for Electron integration:**
- TypeScript runtime library for programmatic execution
- Already built as an Electron app — proven pattern
- YAML-based graph definitions could be stored/versioned
- Plugin architecture for extensibility
- **Confidence: 7/10, Reliability: 6/10**

---

## 5. Protocol Standards & Ecosystem

### 5.1 Protocol Landscape (2026)

The AI agent ecosystem has converged on a layered protocol stack:

| Protocol | Owner | Focus | Spec |
|----------|-------|-------|------|
| **MCP** (Model Context Protocol) | Anthropic / AAIF | Agent-to-Tool | Tool access, context |
| **A2A** (Agent-to-Agent) | Google / AAIF | Agent-to-Agent | Task delegation |
| **ACP** (Agent Communication Protocol) | IBM BeeAI / LF | Agent Communication | REST-based, merged into A2A Aug 2025 |
| **AG-UI** (Agent-to-User) | Community | Agent-to-User | Real-time interactivity |
| **AGNTCY** | Cisco / LF | Agent Infrastructure | Discovery, identity, security |

**Sources:** [DEV.to MCP vs A2A](https://dev.to/pockit_tools/mcp-vs-a2a-the-complete-guide-to-ai-agent-protocols-in-2026-30li), [Agentic AI Foundation](https://intuitionlabs.ai/articles/agentic-ai-foundation-open-standards), [Pento MCP Review](https://www.pento.ai/blog/a-year-of-mcp-2025-review)

**Key facts (March 2026):**
- MCP: 97M+ monthly SDK downloads (Python + TypeScript combined)
- AAIF (Agentic AI Foundation): Co-founded by OpenAI, Anthropic, Google, Microsoft, AWS, Block — hosts both MCP and A2A
- TypeScript MCP SDK: v1.27.1 (March 2026)
- A2A Agent Cards: `/.well-known/agent.json` for discovery
- Consensus architecture: MCP for tools, A2A for agents, AG-UI for humans

**Key insight for our product:** "If your agents are all within the same organization, running in the same infrastructure — you don't need A2A. Use simpler orchestration. A2A's overhead isn't justified for single-org setups." ([Source](https://dev.to/pockit_tools/mcp-vs-a2a-the-complete-guide-to-ai-agent-protocols-in-2026-30li))

---

### 5.2 Semantic Router (Aurelio AI)

- **URL:** https://github.com/aurelio-labs/semantic-router
- **License:** MIT
- **Language:** Python
- **Source:** [Aurelio AI](https://www.aurelio.ai/semantic-router), [GitHub](https://github.com/aurelio-labs/semantic-router)

**What it is:** Superfast decision-making layer for LLMs and agents. Routes requests using semantic vector space instead of slow LLM calls.

**Key capability:** Tool selection, guardrails, intent routing — all without LLM calls. Scales to thousands of tools.

### 5.3 vLLM Semantic Router

- **URL:** https://github.com/vllm-project/semantic-router
- **License:** Open source
- **Language:** Rust
- **Source:** [vLLM Blog](https://blog.vllm.ai/2026/01/05/vllm-sr-iris.html), [Red Hat](https://developers.redhat.com/articles/2025/09/11/vllm-semantic-router-improving-efficiency-ai-reasoning)

**What it is:** System-level intelligent router for Mixture-of-Models. Routes queries to the best model based on complexity analysis.

**v0.1 "Iris" release (January 2026):** Production-ready, 600+ PRs merged, 300+ issues, 50+ engineers. Supports OpenAI Responses API with conversation state for intelligent routing in multi-turn agent apps.

**Key stats:** +10.2% accuracy on complex tasks, -47.1% latency, -48.5% token usage.

---

## 6. Coding Agent Fleet Managers

### 6.1 Angy

- **URL:** Product Hunt (recent launch, ~1 week ago)
- **License:** Open source
- **Source:** [Product Hunt](https://www.producthunt.com/products/angy)

**What it is:** Open-source fleet manager and IDE for Claude Code. Orchestrates a deterministic multi-phase pipeline (Plan -> Build -> Test) with adversarial verification.

**Architecture:**
- **Adversarial Counterpart agent** that strictly verifies code
- **Git worktree isolation** for parallel agent execution
- **Scheduler** for running epics overnight
- **Multi-phase pipeline:** Architect -> Counterpart -> Build -> Test
- Self-bootstrapped after one day of initial work

---

### 6.2 GitHub Agent HQ

- **URL:** https://github.blog/news-insights/company-news/welcome-home-agents/
- **Source:** [GitHub Blog](https://github.blog/news-insights/company-news/welcome-home-agents/), [Eficode](https://www.eficode.com/blog/why-github-agent-hq-matters-for-engineering-teams-in-2026)

**What it is:** GitHub's platform for orchestrating AI agent fleets. Multi-agent support with Claude Code, Codex, and custom agents.

**Architecture:**
- **Mission Control** — unified command center across GitHub, VS Code, mobile, CLI
- **Fleet of specialized agents** — security, testing, refactoring specialists
- **Multi-vendor:** Anthropic, OpenAI, Google, Cognition, xAI
- **Governance controls** — branch controls, identity, agent access policies
- **Squad** — coordinated AI teams inside repositories

---

### 6.3 Hephaestus

- **URL:** https://github.com/Ido-Levi/Hephaestus
- **License:** Open source (alpha)
- **Source:** [GitHub](https://github.com/Ido-Levi/Hephaestus), [HN](https://news.ycombinator.com/item?id=45796897)

**What it is:** Semi-structured agentic framework where workflows build themselves as agents discover what needs to be done.

**Architecture:**
- Define phase types (Analyze -> Implement -> Test), agents dynamically create tasks
- **Ticket-based coordination** — tickets flow through workflow carrying context
- **Guardian system** — LLM-powered coherence scoring for alignment checking
- **Parallel agents** in isolated Claude Code sessions
- Real-time observability

**Key differentiator:** Emergent workflows — agents discover tasks rather than following predefined plans. Interesting alternative to rigid kanban task assignment.

---

### 6.4 KAOS (Kubernetes Agent Orchestration System)

- **URL:** https://github.com/axsaucedo/kaos
- **License:** Open source
- **Source:** [GitHub](https://github.com/axsaucedo/kaos), [HN](https://news.ycombinator.com/item?id=46688521)

**What it is:** Kubernetes-native framework for deploying and orchestrating AI agents at scale.

**Architecture:**
- **Golang control plane** — manages Agentic CRDs (Custom Resource Definitions)
- **Python data plane** — implements A2A, memory, tool/model management
- **React UI** — CRUD + debugging
- **PAIS** — enterprise wrapper for Pydantic AI with OpenAI-compatible HTTP API
- **A2A discovery** built in
- **OpenTelemetry** instrumentation

**Key differentiator:** Kubernetes-native multi-agent system for hundreds/thousands of services. Production infrastructure approach.

---

## 7. Python-First Frameworks (with TS relevance)

### 7.1 BeeAI Framework (IBM)

- **URL:** https://github.com/i-am-bee/beeai-framework
- **Stars:** 3k+
- **License:** Open source (Linux Foundation governance)
- **Source:** [IBM Think](https://www.ibm.com/think/news/beeai-open-source-multiagent), [BeeAI Docs](https://framework.beeai.dev/)

**What it is:** IBM's open-source framework for production-grade multi-agent systems. **Dual language: Python AND TypeScript with complete feature parity.**

**Architecture:**
- 10+ LLM providers including Ollama, OpenAI, Watsonx.ai
- **MCP tool integration**
- **A2A protocol support** (ACP merged into A2A)
- **Agent Stack** — framework-agnostic deployment (BeeAI, LangGraph, CrewAI, custom)
- Built-in constraint enforcement and rule-based governance
- Each agent runs in its own container with resource limits
- OpenTelemetry observability

**Key differentiator:** TypeScript with feature parity is rare among IBM projects. Linux Foundation governance ensures long-term stability. The Agent Stack deploy layer is uniquely framework-agnostic.

**Relevance for Electron integration:**
- TypeScript SDK with full feature parity
- Framework-agnostic Agent Stack could deploy any agent
- MCP + A2A support aligns with protocol trends
- **Confidence: 7/10, Reliability: 7/10**

---

### 7.2 Letta (formerly MemGPT)

- **URL:** https://github.com/letta-ai/letta
- **Stars:** 16.2k+
- **License:** Open source
- **Source:** [Letta site](https://www.letta.com/), [GitHub](https://github.com/letta-ai/letta)

**What it is:** Platform for stateful agents with advanced memory that learn and self-improve over time.

**Architecture:**
- **Self-editing memory** — agents manage their own memory blocks
- **Sleep-time compute** — agents "think" during downtime, rewrite memory
- **Skill learning** — agents learn new skills from experience
- **Letta Code** — #1 model-agnostic open source agent on Terminal-Bench
- **REST API + TypeScript SDK**
- Model-agnostic: OpenAI, Anthropic, local models

**Key differentiator:** Memory-first architecture is unique. Sleep-time compute and skill learning are research-frontier features. TypeScript SDK available.

**Relevance for Electron integration:**
- TypeScript SDK for client-side integration
- REST API for server-side
- Memory architecture could inform our agent context management
- **Confidence: 7/10, Reliability: 6/10**

---

### 7.3 CAMEL-AI

- **URL:** https://github.com/camel-ai/camel
- **Stars:** Growing (active research community)
- **License:** Apache 2.0 (code), CC BY NC 4.0 (datasets)
- **Source:** [CAMEL-AI site](https://www.camel-ai.org/), [GitHub](https://github.com/camel-ai/camel)

**What it is:** The first open-source multi-agent framework, focused on dialog-driven collaboration and scaling laws of agents.

**Architecture:**
- **Role-based agents** — structured conversations between assigned roles
- **OWL** — Optimized Workforce Learning, #1 on GAIA benchmark (69.09%)
- **OASIS** — simulations with 1M agents
- **MCPify** — project for MCP integration
- Accepted at NeurIPS 2025

**Key differentiator:** Research-first approach focused on scaling laws of multi-agent systems. OWL's GAIA benchmark performance is state-of-the-art. Python only.

---

### 7.4 Julep AI

- **URL:** https://github.com/julep-ai/julep
- **License:** Open source
- **Source:** [Julep site](https://julep.ai/), [GitHub](https://github.com/julep-ai/julep), [Temporal Blog](https://temporal.io/blog/julep-ai-future-ai-workflows)

**What it is:** "Firebase for AI agents" — serverless platform for multi-step AI workflows. Persistent memory, modular workflows (YAML or code), built-in retries.

**Status:** Hosted backend shut down December 31, 2025. Open-source self-hosting available. Team pivoted to **memory.store**.

**Note:** Python and Node.js SDKs available, but future unclear given the pivot.

---

### 7.5 ChatDev 2.0

- **URL:** https://github.com/OpenBMB/ChatDev
- **License:** Apache 2.0
- **Source:** [GitHub](https://github.com/OpenBMB/ChatDev), [IBM](https://www.ibm.com/think/topics/chatdev)

**What it is:** Zero-code multi-agent orchestration platform simulating a virtual software company. ChatDev 2.0 (January 2026) transforms rigid structures into flexible workflow systems.

**Architecture:**
- **Visual canvas (Workflow)** — drag-and-drop multi-agent system design
- **Python SDK** (PyPI: chatdev) — run YAML workflows in Python
- **MacNet** — multi-agent collaboration networks for complex topologies
- **Puppeteer** — dynamic orchestration with RL-optimized agent sequencing
- FastAPI backend + Vue 3 frontend

**Key differentiator:** NeurIPS 2025 accepted research, zero-code visual approach, software company simulation metaphor. Python + Vue only.

---

### 7.6 Haystack (deepset)

- **URL:** https://github.com/deepset-ai/haystack
- **Stars:** High (enterprise adoption: Airbus, NVIDIA, Comcast)
- **License:** Apache 2.0
- **Source:** [Haystack site](https://haystack.deepset.ai/), [Haystack Docs](https://docs.haystack.deepset.ai/docs/agents)

**What it is:** Open-source AI orchestration framework for production-ready LLM applications. Modular pipelines + agent workflows.

**Architecture:**
- **Context engineering** — explicit control over retrieval, ranking, filtering, routing
- **Universal Agent** component with Chat Generator + tools
- **ComponentTool** — wrap any Haystack component as a callable tool
- **@tool decorator** — create tools from Python functions
- **Hayhooks** — expose pipelines/agents via HTTP or MCP
- **AgentSnapshot** — stepwise debugging with breakpoints
- Model-agnostic: OpenAI, Anthropic, Cohere, HuggingFace, Azure, Bedrock
- Latest: v2.25 (March 2026)

**Key differentiator:** Enterprise-grade, context-engineering focused. The MCP exposure via Hayhooks means our app could consume Haystack agents as tools.

---

### 7.7 ControlFlow (Prefect) -> Marvin

- **URL:** https://github.com/PrefectHQ/ControlFlow (archived)
- **License:** Apache 2.0
- **Source:** [Prefect Blog](https://www.prefect.io/blog/controlflow-intro)

**What it is:** Task-centric AI workflow framework built on Prefect 3.0. **Archived** — merged into Marvin framework.

**Key ideas (preserved in Marvin):**
- Tasks, Agents, Flows as core abstractions
- "AI agents are most effective when applied to small, well-defined tasks"
- Multi-agent collaboration strategies: Round-robin, Random, Moderated
- Every flow is a Prefect flow — full orchestration + observability

---

## 8. Summary Matrix

| Tool | Language | Stars | License | MCP | A2A | Multi-Agent | Electron-Ready | Maturity |
|------|----------|-------|---------|-----|-----|-------------|----------------|----------|
| **Mastra** | TypeScript | 22.3k | Apache 2.0 | Yes | -- | Yes | **Native** | Production |
| **Inngest AgentKit** | TypeScript | 793 | Apache 2.0 | Yes | -- | Yes (Networks) | **Native** | Beta |
| **VoltAgent** | TypeScript | 5.1k | MIT | Yes | -- | Yes (Chain API) | **Native** | Early |
| **HazelJS** | TypeScript | Small | Apache 2.0 | -- | -- | Yes (AgentGraph) | **Native** | Alpha |
| **Agentica** | TypeScript | Small | MIT | Yes | -- | No | **Native** | Beta |
| **Strands (AWS)** | Python+TS | 14M DL | Apache 2.0 | Yes | -- | Yes (Swarm) | TS SDK | Preview |
| **OpenAI Agents SDK** | TypeScript | 2.1k | MIT | Yes | -- | Yes (Handoffs) | **Native** | GA |
| **Google ADK TS** | TypeScript | 581 | Apache 2.0 | Yes | Yes | Yes | **Native** | Early |
| **BeeAI** | Python+TS | 3k | Open (LF) | Yes | Yes | Yes | TS SDK | Production |
| **AgentGateway** | Rust | 2k | Open (LF) | Yes | Yes | -- (infra) | Sidecar | v1.0 |
| **Temporal** | Multi | 13k | MIT | -- | -- | -- (infra) | TS SDK | Production |
| **Trigger.dev** | TypeScript | 13.9k | Apache 2.0 | Yes | -- | Yes | Server-side | v4 |
| **Hatchet** | Multi | 4.5k | MIT | -- | -- | -- (infra) | TS SDK | Production |
| **Dify** | Python | 129.8k | Apache 2.0 | Yes | -- | Yes | REST API | Production |
| **n8n** | TypeScript | 180.7k | Fair-code | Yes | -- | Yes (basic) | Heavy | Production |
| **Rivet** | TypeScript | 3.9k | Open | -- | -- | -- | **Electron app** | v4.1 |
| **Letta** | Python+TS | 16.2k | Open | -- | -- | -- | TS SDK | Production |
| **CAMEL-AI** | Python | Growing | Apache 2.0 | -- | -- | Yes | -- | Research |
| **ChatDev 2.0** | Python | Growing | Apache 2.0 | -- | -- | Yes | -- | v2.0 |
| **Haystack** | Python | High | Apache 2.0 | Yes | -- | Yes | REST/MCP | v2.25 |

---

## 9. Recommendations for Claude Agent Teams UI

### Tier 1: Most Relevant for Integration (TypeScript-native, embeddable)

1. **Mastra** — The most mature TS agent framework. Could serve as orchestration backend for agent workflows, multi-model routing, and memory management. Proven at scale (Replit, PayPal).

2. **Inngest AgentKit** — Lightweight multi-agent networks with durable execution. The Agent -> Network -> Router -> State model maps well to our team/agent/task architecture.

3. **OpenAI Agents SDK (TS)** — If we want to support OpenAI models natively. Handoff mechanism is clean for agent-to-agent delegation.

4. **VoltAgent** — Observability-first approach complements our session analysis. Chain API for multi-agent workflows is well-designed.

### Tier 2: Protocol & Infrastructure Integration

5. **AgentGateway** — Could be bundled as a sidecar process. Handles MCP/A2A protocol routing, OpenAPI-to-MCP translation, multi-tenancy.

6. **MCP Gateway Registry** — Solves MCP server governance for enterprise deployments.

7. **Rivet** — TypeScript runtime library for visual AI chain execution. Already an Electron app.

### Tier 3: External Services (consume via API/MCP)

8. **Dify** — Expose visual workflows as MCP servers that our app consumes.
9. **Trigger.dev** — Durable execution backend via MCP server integration.
10. **Hatchet** — Lightweight durable execution (just PostgreSQL).

### Key Architectural Insight

The emerging pattern for 2026 is a **layered architecture**:
- **Protocol layer:** MCP (tools) + A2A (agents) + AG-UI (humans)
- **Execution layer:** Durable workflows (Temporal/Hatchet/Inngest)
- **Agent layer:** Framework-specific (Mastra/AgentKit/custom)
- **Orchestration layer:** Fleet management (our kanban board / Agent HQ / Hephaestus)
- **Gateway layer:** AgentGateway for routing, security, observability

Our product (Claude Agent Teams UI) sits at the **orchestration layer** — the kanban-based fleet management interface. The key opportunity is to become framework-agnostic by integrating with the protocol layer (MCP/A2A) and supporting multiple agent frameworks underneath.

### Unique Competitive Advantages We Have

Based on this research, no tool combines ALL of:
1. Kanban-based task management (visual orchestration)
2. Multi-agent team coordination with real-time communication
3. Code review (diff view) per task
4. Deep session analysis (bash commands, reasoning, tokens)
5. Desktop-native (Electron) with zero-setup

The closest competitors are GitHub Agent HQ (platform-level, not desktop) and Angy (fleet manager, but IDE-focused not kanban). Our kanban + code review + session analysis combination remains unique.
