# AI Agent Orchestration Landscape: Protocols, Routing & Desktop Tools

**Date:** March 24, 2026
**Status:** Research snapshot (rapidly evolving landscape)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Protocol-Level Standards](#1-protocol-level-standards)
   - [MCP (Model Context Protocol)](#11-mcp--model-context-protocol)
   - [A2A (Agent2Agent Protocol)](#12-a2a--agent2agent-protocol)
   - [ACP (Agent Communication Protocol)](#13-acp--agent-communication-protocol)
   - [AGENTS.md](#14-agentsmd)
   - [Protocol Layer Summary](#15-protocol-layer-summary)
3. [Governance: Agentic AI Foundation (AAIF)](#2-governance-agentic-ai-foundation-aaif)
4. [Multi-Model Routing & Proxy Tools](#3-multi-model-routing--proxy-tools)
   - [LiteLLM](#31-litellm)
   - [OpenRouter](#32-openrouter)
5. [Agent Orchestration Frameworks](#4-agent-orchestration-frameworks)
   - [LangGraph](#41-langgraph)
   - [CrewAI](#42-crewai)
   - [AutoGen / Microsoft Agent Framework](#43-autogen--microsoft-agent-framework)
   - [OpenAI Agents SDK](#44-openai-agents-sdk)
   - [Google Agent Development Kit (ADK)](#45-google-agent-development-kit-adk)
   - [AWS Strands Agents](#46-aws-strands-agents)
   - [OpenAgents](#47-openagents)
   - [GitAgent](#48-gitagent)
   - [Goose (Block)](#49-goose-block)
   - [Framework Comparison Table](#410-framework-comparison-table)
6. [Desktop/Local Orchestration Tools](#5-desktoplocal-orchestration-tools)
   - [VS Code Multi-Agent Hub](#51-vs-code-multi-agent-hub)
   - [Augment Code Intent](#52-augment-code-intent)
   - [OpenAI Codex Desktop App](#53-openai-codex-desktop-app)
7. [Relevance for Claude Agent Teams UI](#6-relevance-for-claude-agent-teams-ui)
8. [Sources](#sources)

---

## Executive Summary

As of March 2026, the AI agent ecosystem has consolidated around three complementary protocol layers:

| Layer | Protocol | Purpose | Governance |
|-------|----------|---------|------------|
| **Agent-to-Tool** | MCP | Connect agents to tools/data | AAIF (Linux Foundation) |
| **Agent-to-Agent** | A2A | Agents discover/communicate with each other | Linux Foundation |
| **Agent Config** | AGENTS.md | Project-level agent instructions | AAIF (Linux Foundation) |

All three are open-source, vendor-neutral, and governed by the Linux Foundation. The Agentic AI Foundation (AAIF), co-founded by Anthropic, OpenAI, and Block in December 2025, is the umbrella organization.

Key numbers:
- **MCP:** 97M monthly SDK downloads, 10,000+ servers, 300+ clients
- **A2A:** 22.7K GitHub stars, 150+ supporting organizations, v0.3 released
- **AGENTS.md:** Adopted by 60,000+ open-source projects, supported by all major coding agents except Claude Code

The framework landscape is fragmenting into three tiers:
1. **Cloud-vendor SDKs** (OpenAI Agents SDK, Google ADK, AWS Strands, Microsoft Agent Framework) -- production-grade, tied to ecosystems
2. **Independent frameworks** (LangGraph, CrewAI, OpenAgents) -- model-agnostic, community-driven
3. **Portability layers** (GitAgent, MCP, A2A) -- cross-framework interop

Desktop orchestration is emerging as a new category, with VS Code, Augment Intent, and OpenAI Codex App leading the charge.

---

## 1. Protocol-Level Standards

### 1.1 MCP -- Model Context Protocol

| Field | Value |
|-------|-------|
| **URL** | [modelcontextprotocol.io](https://modelcontextprotocol.io/) |
| **GitHub** | [modelcontextprotocol](https://github.com/modelcontextprotocol) |
| **Created by** | Anthropic (November 2024) |
| **Governance** | AAIF / Linux Foundation (donated December 2025) |
| **License** | Apache 2.0 |
| **Maturity** | Production -- spec version 2025-11-25 |
| **Adoption** | 97M monthly SDK downloads, 10,000+ servers, 300+ clients |
| **Reliability** | 9/10 |
| **Confidence** | 9/10 |

**What it enables:** Standardized agent-to-tool communication. Any AI model can connect to any data source or tool through a universal interface (tools, resources, prompts). Often compared to "USB-C for AI."

**Key facts:**
- Adopted by every major AI platform: Claude, ChatGPT, Cursor, Gemini, Microsoft Copilot, VS Code
- OpenAI adopted MCP across its products in March 2025
- 2026 roadmap focuses on: transport scalability (remote servers), agent communication upgrades (chunked messages, multipart streams), enterprise readiness (audit trails, SSO)
- Security concerns: prompt injection, tool poisoning, cross-server shadowing identified in April 2025 analysis

**Relation to A2A:** MCP handles agent-to-tool connections. A2A handles agent-to-agent. Complementary, not competing. A common production pattern: MCP for tool connections + A2A for agent coordination.

> Source: [A Year of MCP (Pento)](https://www.pento.ai/blog/a-year-of-mcp-2025-review), [The 2026 MCP Roadmap](http://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/), [MCP Wikipedia](https://en.wikipedia.org/wiki/Model_Context_Protocol), [MCP Specification](https://modelcontextprotocol.io/specification/2025-11-25), [The New Stack - MCP 2026 Roadmap](https://thenewstack.io/model-context-protocol-roadmap-2026/)

---

### 1.2 A2A -- Agent2Agent Protocol

| Field | Value |
|-------|-------|
| **URL** | [github.com/a2aproject/A2A](https://github.com/a2aproject/A2A) |
| **Created by** | Google (April 9, 2025, Cloud Next) |
| **Governance** | Linux Foundation (June 2025) |
| **License** | Apache 2.0 |
| **Version** | 0.3 (July 2025) -- added gRPC, signed security cards |
| **GitHub Stars** | 22.7K (main repo) |
| **Supporting Orgs** | 150+ (Atlassian, Salesforce, SAP, PayPal, etc.) |
| **Reliability** | 8/10 |
| **Confidence** | 8/10 |

**What it enables:** Standardized agent-to-agent communication. Agents discover each other via "Agent Cards" (JSON at `/.well-known/agent.json`), negotiate capabilities, and exchange tasks over HTTP/SSE/JSON-RPC.

**Key features:**
- **Capability discovery** via Agent Cards (name, endpoint, skills, auth flows)
- **Flexible modalities**: text, audio, video streaming
- **Enterprise auth**: parity with OpenAPI authentication schemes
- **Supports async**: tasks from quick responses to multi-day research
- Protocol: JSON-RPC 2.0 over HTTP(S), SSE for streaming, push notifications

**ACP merger (August 2025):** IBM's Agent Communication Protocol (ACP) officially merged into A2A under the Linux Foundation. BeeAI platform now uses A2A.

**Ecosystem:** Native support in Google ADK, AWS Strands, Microsoft Agent Framework, LiteLLM, OpenAgents. CrewAI added A2A support. LangGraph and AutoGen have not yet adopted natively.

> Source: [Google Developers Blog - A2A](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/), [Google Cloud Blog - A2A Upgrade](https://cloud.google.com/blog/products/ai-machine-learning/agent2agent-protocol-is-getting-an-upgrade), [Linux Foundation - A2A Project](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents), [IBM - A2A](https://www.ibm.com/think/topics/agent2agent-protocol), [ACP Joins A2A](https://lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a-under-the-linux-foundations-lf-ai-data/)

---

### 1.3 ACP -- Agent Communication Protocol

| Field | Value |
|-------|-------|
| **URL** | [github.com/i-am-bee/acp](https://github.com/i-am-bee/acp) |
| **Created by** | IBM BeeAI (March 2025) |
| **Status** | **Merged into A2A** (August 2025) |
| **License** | Apache 2.0 |
| **Reliability** | 7/10 (merged, not standalone) |
| **Confidence** | 8/10 |

**What it was:** A lightweight REST-based protocol for agent-to-agent messaging. No SDK required -- curl/Postman compatible. Key differentiators were offline agent discovery and peer-to-peer interaction.

**Current status:** ACP merged into A2A. The BeeAI platform now runs on A2A. IBM stated: "By bringing the assets and expertise behind ACP into A2A, we can build a single, more powerful standard." Migration guides are available.

**Legacy significance:** ACP influenced A2A's design toward simpler REST-based patterns and offline discovery capabilities.

> Source: [IBM Research - ACP](https://research.ibm.com/blog/agent-communication-protocol-ai), [IBM - What is ACP](https://www.ibm.com/think/topics/agent-communication-protocol), [ACP Joins A2A](https://lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a-under-the-linux-foundations-lf-ai-data/)

---

### 1.4 AGENTS.md

| Field | Value |
|-------|-------|
| **URL** | [agents.md](https://agents.md/) |
| **Created by** | OpenAI (August 2025) |
| **Governance** | AAIF / Linux Foundation |
| **License** | Open standard (Markdown convention) |
| **Adoption** | 60,000+ repositories |
| **Reliability** | 8/10 |
| **Confidence** | 9/10 |

**What it enables:** A standardized Markdown file that gives AI coding agents project-specific instructions (build commands, coding conventions, testing requirements, boundaries). Like `.gitignore` but for agents.

**Adoption:** Supported by GitHub Copilot, Cursor, Windsurf, Zed, Warp, VS Code, JetBrains Junie, OpenAI Codex CLI, Google Jules, Gemini CLI, Amp, Devin, Aider, goose, RooCode, Augment Code.

**Notable exception:** Claude Code uses its own `CLAUDE.md` format. Open issue with 3,000+ upvotes requesting AGENTS.md support, but Anthropic has not committed to it.

**For monorepos:** Nested AGENTS.md files work (agents parse nearest file in directory tree). OpenAI's main repo has 88 AGENTS.md files.

> Source: [InfoQ - AGENTS.md](https://www.infoq.com/news/2025/08/agents-md/), [agents.md official site](https://agents.md/), [OpenAI AAIF announcement](https://openai.com/index/agentic-ai-foundation/)

---

### 1.5 Protocol Layer Summary

```
+--------------------------------------------------+
|  AGENTS.md / CLAUDE.md                           |  <- Agent config/instructions
+--------------------------------------------------+
|  A2A (Agent-to-Agent Protocol)                   |  <- Agent discovery & communication
|  (includes former ACP)                           |
+--------------------------------------------------+
|  MCP (Model Context Protocol)                    |  <- Agent-to-tool connections
+--------------------------------------------------+
|  HTTP / SSE / JSON-RPC / gRPC                    |  <- Transport layer
+--------------------------------------------------+
```

All three major layers are:
- Open source (Apache 2.0)
- Governed by the Linux Foundation (via AAIF or directly)
- Backed by every major AI company
- Production-ready or approaching it

---

## 2. Governance: Agentic AI Foundation (AAIF)

| Field | Value |
|-------|-------|
| **URL** | [aaif.io](https://aaif.io/) |
| **Parent** | Linux Foundation |
| **Founded** | December 9, 2025 |
| **Co-founders** | Anthropic, Block, OpenAI |
| **Platinum Members** | AWS, Anthropic, Block, Bloomberg, Cloudflare, Google, Microsoft, OpenAI |
| **Total Members** | 97+ |
| **Board Chair** | David Nalley (AWS) |
| **Reliability** | 9/10 |
| **Confidence** | 9/10 |

**What it does:** Neutral governance body for agentic AI open standards. Hosts MCP, goose, and AGENTS.md as founding projects. A2A is governed separately under the Linux Foundation but aligned.

**Key principles:**
- Open governance: contributors from all backgrounds shape direction
- Project autonomy: individual projects maintain full technical independence
- Sustainability: neutral infrastructure and funding (not vendor-controlled)
- Focused scope: agentic AI only (not all of AI/ML/data science)

**Funding model:** "Directed fund" -- companies contribute through membership dues. Roadmaps set by technical steering committees, not sponsors.

**Government alignment:** NIST launched the "AI Agent Standards Initiative" in February 2026 to foster industry-led technical standards for AI agents.

**Upcoming event:** MCP Dev Summit North America, April 2-3, 2026, New York City.

> Source: [Linux Foundation - AAIF](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation), [OpenAI - AAIF](https://openai.com/index/agentic-ai-foundation/), [Anthropic - AAIF](https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation), [NIST AI Agent Standards Initiative](https://www.nist.gov/news-events/news/2026/02/announcing-ai-agent-standards-initiative-interoperable-and-secure)

---

## 3. Multi-Model Routing & Proxy Tools

### 3.1 LiteLLM

| Field | Value |
|-------|-------|
| **URL** | [litellm.ai](https://docs.litellm.ai/) |
| **GitHub** | [BerriAI/litellm](https://github.com/BerriAI/litellm) |
| **Type** | LLM Gateway / Proxy (self-hosted) |
| **License** | MIT (Enterprise features paid) |
| **LLM Support** | 100+ models |
| **Agent Support** | A2A agents (LangGraph, Vertex AI, Azure, Bedrock, Pydantic AI) |
| **MCP Support** | Yes (central endpoint with per-key ACL) |
| **Reliability** | 7/10 |
| **Confidence** | 8/10 |

**What it enables:**
- Unified OpenAI-compatible gateway for 100+ LLMs from all providers
- A2A agent routing through the same gateway
- MCP tool access with per-key access control
- Load balancing: simple-shuffle, least-busy, usage-based, latency-based
- Retry/fallback across deployments
- Cost tracking per key/team/user
- Content filtering, PII masking, guardrails

**Performance:** 8ms P95 latency at 1K RPS.

**Known issues (2025-2026):**
- Python GIL limits concurrency under high load
- DB logging degrades after 1M+ logs (GitHub issue #12067)
- Enterprise features (SSO, RBAC, budgets) locked behind paid license
- 800+ open GitHub issues; September 2025 release caused OOM on Kubernetes
- Bifrost (Go-based competitor) claims 50x faster performance

**Agent routing capability:** LiteLLM supports adding A2A agents as first-class endpoints, meaning you can route to both LLMs and agents through the same gateway. This makes it a potential universal backend for agent orchestration.

**Relevance for desktop agent UI:** High. Could serve as a unified backend that routes requests to different LLM providers and A2A agents through a single API. The self-hosted nature and OpenAI-compatible API make it easy to integrate.

> Source: [LiteLLM Docs](https://docs.litellm.ai/docs/), [LiteLLM GitHub](https://github.com/BerriAI/litellm), [Top 5 LiteLLM Alternatives 2026](https://www.getmaxim.ai/articles/top-5-litellm-alternatives-in-2026/)

---

### 3.2 OpenRouter

| Field | Value |
|-------|-------|
| **URL** | [openrouter.ai](https://openrouter.ai/) |
| **Type** | Cloud-hosted LLM routing service |
| **Models** | 500+ from 60+ providers |
| **Scale** | 250K+ apps, 4.2M+ users |
| **API** | OpenAI SDK compatible |
| **License** | Proprietary (cloud service) |
| **Reliability** | 8/10 |
| **Confidence** | 8/10 |

**What it enables:**
- Single API for 500+ models (OpenAI, Anthropic, Google, Meta, Mistral, etc.)
- Auto-routing: cheap models for simple queries, premium for complex
- Automatic provider fallback for reliability
- Low latency: ~15ms overhead (edge infrastructure)
- 29 free models available (no credit card)

**Agent support:** Supports building agentic workflows through the API, but no native A2A/MCP protocol support. It is an LLM routing layer, not an agent orchestration layer.

**Multi-model strategy for agents:** The recommended approach is to use different models for different tasks (e.g., Devstral for coding, MiniMax for agents, DeepSeek for general). OpenRouter's auto-routing facilitates this.

**Relevance for desktop agent UI:** Medium. Excellent for LLM routing (choosing models per task), but lacks native agent orchestration. Would need to be paired with an agent framework. Not self-hostable.

> Source: [OpenRouter](https://openrouter.ai/), [OpenRouter Review 2026](https://aiagentslist.com/agents/openrouter), [Building Agentic AI with OpenRouter](https://dev.to/allanninal/building-your-first-agentic-ai-workflow-with-openrouter-api-1fo6)

---

## 4. Agent Orchestration Frameworks

### 4.1 LangGraph

| Field | Value |
|-------|-------|
| **GitHub** | [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) |
| **Architecture** | Graph-based workflows (nodes + edges) |
| **Languages** | Python, JavaScript/TypeScript |
| **License** | MIT |
| **Best for** | Production-grade stateful systems |
| **MCP/A2A** | No native support yet |
| **Reliability** | 8/10 |
| **Confidence** | 8/10 |

**Key strengths:**
- Most control over execution flow (conditional logic, branching, parallel)
- Best debugging/observability via LangSmith companion tooling
- Production-proven with enterprise deployments
- Model-agnostic: assign different models to different agent nodes
- Mature checkpointing and state persistence

**Key weaknesses:**
- Steepest learning curve (requires graph theory knowledge)
- No native MCP/A2A support yet
- Higher initial development time vs. CrewAI

> Source: [DataCamp - Framework Comparison](https://www.datacamp.com/tutorial/crewai-vs-langgraph-vs-autogen), [DEV - Agent Showdown 2026](https://dev.to/topuzas/the-great-ai-agent-showdown-of-2026-openai-autogen-crewai-or-langgraph-1ea8)

---

### 4.2 CrewAI

| Field | Value |
|-------|-------|
| **URL** | [crewai.com](https://crewai.com/) |
| **Architecture** | Role-based teams (roles, goals, backstories) |
| **Languages** | Python |
| **License** | MIT |
| **Best for** | Quick prototyping, team-based workflows |
| **A2A** | Added A2A support |
| **MCP** | Not natively |
| **Reliability** | 7/10 |
| **Confidence** | 8/10 |

**Key strengths:**
- Most beginner-friendly (40% faster time-to-production vs. LangGraph)
- Role-based metaphor mirrors real organizations
- YAML config keeps agent definitions readable
- Active development (unlike AutoGen)
- Added A2A support for interoperability

**Key weaknesses:**
- Less mature monitoring/observability tooling
- Python-only
- Less granular control than LangGraph for complex workflows

> Source: [CrewAI](https://crewai.com/), [OpenAgents Blog - Frameworks Compared](https://openagents.org/blog/posts/2026-02-23-open-source-ai-agent-frameworks-compared)

---

### 4.3 AutoGen / Microsoft Agent Framework

| Field | Value |
|-------|-------|
| **URL** | [github.com/microsoft/agent-framework](https://github.com/microsoft/agent-framework) |
| **Previous** | AutoGen + Semantic Kernel (merged October 2025) |
| **Languages** | Python, .NET |
| **License** | MIT |
| **Status** | Release Candidate (February 2026), GA target end of Q1 2026 |
| **MCP/A2A** | Both supported natively |
| **Reliability** | 8/10 |
| **Confidence** | 8/10 |

**What happened:**
- Microsoft merged AutoGen and Semantic Kernel into a unified "Microsoft Agent Framework" in October 2025
- AutoGen is now in maintenance mode (bug fixes/security only)
- Semantic Kernel features are being absorbed
- GA 1.0 targeted for end of Q1 2026

**Key features:**
- Unified programming model: Python and .NET
- Graph-based workflows: sequential, concurrent, handoff, group chat patterns
- Multi-provider: Azure OpenAI, OpenAI, Anthropic, AWS Bedrock, Ollama, etc.
- Native interoperability: A2A, AG-UI, MCP, OpenAPI
- Enterprise: session-based state management, middleware, telemetry

**Key concern:** Community disruption from the merge. AutoGen users forced to migrate. Strategic shift raises questions about long-term stability of Microsoft's agent strategy.

> Source: [Visual Studio Magazine - Agent Framework](https://visualstudiomagazine.com/articles/2025/10/01/semantic-kernel-autogen--open-source-microsoft-agent-framework.aspx), [Microsoft Learn - Agent Framework](https://learn.microsoft.com/en-us/agent-framework/overview/), [Microsoft Azure Blog](https://azure.microsoft.com/en-us/blog/introducing-microsoft-agent-framework/)

---

### 4.4 OpenAI Agents SDK

| Field | Value |
|-------|-------|
| **URL** | [openai.github.io/openai-agents-python](https://openai.github.io/openai-agents-python/) |
| **GitHub** | [openai/openai-agents-python](https://github.com/openai/openai-agents-python) |
| **Languages** | Python, TypeScript/JavaScript |
| **License** | MIT |
| **Version** | 0.13.0 (March 2026) |
| **Maturity** | Production-ready |
| **Reliability** | 8/10 |
| **Confidence** | 8/10 |

**Core primitives:** Agents, Handoffs, Tools (functions + MCP + hosted), Guardrails, Human-in-the-loop, Sessions, Tracing, Realtime Agents (voice).

**Provider-agnostic:** Supports OpenAI Responses/Chat APIs and 100+ other LLMs despite being OpenAI-branded.

**Orchestration patterns:** Agents-as-tools (bounded subtask) and handoffs (specialist takes over).

**MCP support:** Native. Agents can use MCP servers as tool providers.

> Source: [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/), [Agents SDK Review (mem0)](https://mem0.ai/blog/openai-agents-sdk-review), [OpenAI Developers 2025](https://developers.openai.com/blog/openai-for-developers-2025/)

---

### 4.5 Google Agent Development Kit (ADK)

| Field | Value |
|-------|-------|
| **URL** | [google.github.io/adk-docs](https://google.github.io/adk-docs/) |
| **GitHub** | [google/adk-python](https://github.com/google/adk-python) (17.8K stars) |
| **Languages** | Python, Go |
| **License** | Apache 2.0 |
| **A2A** | Native integration |
| **MCP** | Native support |
| **Reliability** | 8/10 |
| **Confidence** | 8/10 |

**Key strengths:**
- Same framework powering Google's Agentspace and Customer Engagement Suite
- Native A2A + MCP: first-party protocol support
- Rich tool ecosystem: built-in tools, MCP servers, LangChain/LlamaIndex integration, agents as tools
- LiteLLM integration for multi-provider model access (Anthropic, Meta, Mistral, etc.)
- Deploy anywhere: Cloud Run, Vertex AI Agent Engine, GKE
- 3.3M monthly downloads

**Key weakness:** Optimized for Gemini/Google ecosystem. Model-agnostic in theory, but best experience with Google Cloud.

> Source: [Google Developers Blog - ADK](https://developers.googleblog.com/en/agent-development-kit-easy-to-build-multi-agent-applications/), [ADK Docs](https://google.github.io/adk-docs/), [ADK + A2A](https://google.github.io/adk-docs/a2a/)

---

### 4.6 AWS Strands Agents

| Field | Value |
|-------|-------|
| **URL** | [strandsagents.com](https://strandsagents.com/) |
| **GitHub** | [strands-agents](https://github.com/strands-agents) (2,000+ stars) |
| **Languages** | Python, TypeScript |
| **License** | Apache 2.0 |
| **Version** | 1.0 (production-ready) |
| **A2A** | Native support |
| **MCP** | First-class support |
| **Downloads** | 150K+ on PyPI |
| **Reliability** | 7/10 |
| **Confidence** | 7/10 |

**Key features:**
- Model-driven approach: model reasons about when to use sub-agents
- Multi-agent patterns: Graph, Swarm, Workflow
- Native A2A: expose agents as A2A servers, communicate with other A2A agents
- First-class MCP: thousands of tools accessible
- Model-agnostic: Bedrock, Anthropic, Gemini, LiteLLM, Ollama, OpenAI, and more
- Deploy: Lambda, Fargate, EKS, Bedrock AgentCore, Docker, Kubernetes
- OpenTelemetry observability built-in

**Key concern:** Newer entrant (May 2025), smaller community than LangGraph/CrewAI. AWS ecosystem-optimized.

> Source: [AWS Blog - Strands Agents](https://aws.amazon.com/blogs/opensource/introducing-strands-agents-an-open-source-ai-agents-sdk/), [Strands 1.0](https://aws.amazon.com/blogs/opensource/introducing-strands-agents-1-0-production-ready-multi-agent-orchestration-made-simple/), [AWS - A2A on Strands](https://aws.amazon.com/blogs/opensource/open-protocols-for-agent-interoperability-part-4-inter-agent-communication-on-a2a/)

---

### 4.7 OpenAgents

| Field | Value |
|-------|-------|
| **URL** | [openagents.org](https://openagents.org/) |
| **GitHub** | [openagents-org/openagents](https://github.com/openagents-org/openagents) |
| **Languages** | Python |
| **License** | Open source |
| **A2A** | Native support |
| **MCP** | Native support |
| **Reliability** | 6/10 |
| **Confidence** | 7/10 |

**Unique positioning:** Only framework with native first-class support for BOTH MCP and A2A protocols. Purpose-built for interoperable agent networks.

**Key features:**
- Persistent agent communities (not one-shot pipelines)
- LLM-agnostic (any model provider)
- Agent discovery: agents find each other in workspaces
- @mention delegation between agents
- Manages Claude, Codex, Aider, and more from a single CLI
- Self-hosted agent networks via SDK

**Key concern:** Smaller community and less production-hardened than LangGraph/CrewAI. Newer project.

> Source: [OpenAgents Blog - Comparison](https://openagents.org/blog/posts/2026-02-23-open-source-ai-agent-frameworks-compared), [OpenAgents GitHub](https://github.com/openagents-org/openagents)

---

### 4.8 GitAgent

| Field | Value |
|-------|-------|
| **URL** | [github.com/open-gitagent/gitagent](https://github.com/open-gitagent/gitagent) |
| **Created** | March 2026 (very new) |
| **Type** | Framework-agnostic agent definition format |
| **License** | Open source |
| **Reliability** | 5/10 |
| **Confidence** | 6/10 |

**What it does:** "Docker for AI Agents" -- a universal format to define an agent once and export it to any framework.

**Export targets:** `gitagent export -f [framework]` supports OpenAI, Claude Code, LangChain/LangGraph, CrewAI, AutoGen.

**Key innovation:**
- Agent identity in SOUL.md + skills/ directories
- Git-native state management (Markdown files, not vector DBs)
- Human-in-the-loop via standard PRs (not custom dashboards)
- Enterprise compliance (FINRA, SEC) built-in

**What ports:** Prompts, persona, constraints, tool schemas, role policies, model preferences.
**What stays:** Runtime orchestration, state machines, live tool execution, memory I/O.

**Key concern:** Brand new (March 2026). No production track record. Early-stage community.

> Source: [MarkTechPost - GitAgent](https://www.marktechpost.com/2026/03/22/meet-gitagent-the-docker-for-ai-agents-that-is-finally-solving-the-fragmentation-between-langchain-autogen-and-claude-code/), [GitAgent GitHub](https://github.com/open-gitagent/gitagent)

---

### 4.9 Goose (Block)

| Field | Value |
|-------|-------|
| **URL** | [block.github.io/goose](https://block.github.io/goose/) |
| **GitHub** | [block/goose](https://github.com/block/goose) (30,000+ stars, 350+ contributors) |
| **Created by** | Block (January 2025) |
| **Governance** | AAIF / Linux Foundation |
| **License** | Apache 2.0 |
| **Type** | Local-first AI agent (CLI + Desktop) |
| **MCP** | Core architecture built on MCP |
| **LLM Support** | 25+ providers (commercial + local models) |
| **Reliability** | 8/10 |
| **Confidence** | 8/10 |

**What it does:** An extensible, local-first AI agent. Goes beyond code suggestions -- runs shell commands, edits files, executes code, orchestrates multi-step workflows. Reference implementation for MCP.

**Key facts:**
- 110+ releases since January 2025
- 3,000+ MCP servers available in the ecosystem
- Founding project of AAIF alongside MCP and AGENTS.md
- Works with any LLM (multi-model config for cost optimization)
- Modular via MCP extensions

> Source: [Block - Introducing Goose](https://block.xyz/inside/block-open-source-introduces-codename-goose), [Goose GitHub](https://github.com/block/goose), [Linux Foundation - AAIF](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)

---

### 4.10 Framework Comparison Table

| Framework | MCP | A2A | Multi-Provider | Languages | Architecture | Maturity | GitHub Stars |
|-----------|-----|-----|----------------|-----------|-------------|----------|-------------|
| **LangGraph** | No | No | Yes | Py, JS/TS | Graph-based | High | ~40K |
| **CrewAI** | No | Yes | Yes | Py | Role-based | Medium-High | ~30K |
| **MS Agent Framework** | Yes | Yes | Yes | Py, .NET | Graph + Conversational | Medium (RC) | ~40K (combined) |
| **OpenAI Agents SDK** | Yes | No | Yes (100+ LLMs) | Py, TS/JS | Handoff-based | High | N/A |
| **Google ADK** | Yes | Yes | Yes (via LiteLLM) | Py, Go | Hierarchical | Medium-High | ~18K |
| **AWS Strands** | Yes | Yes | Yes | Py, TS | Model-driven | Medium | ~2K |
| **OpenAgents** | Yes | Yes | Yes | Py | Network-based | Low | ~1K |
| **Goose** | Yes (core) | No | Yes (25+) | Rust/TS | MCP-based | Medium-High | ~30K |
| **GitAgent** | No | No | Yes (portability) | Universal | Format/spec | Very Low | New |

---

## 5. Desktop/Local Orchestration Tools

### 5.1 VS Code Multi-Agent Hub

| Field | Value |
|-------|-------|
| **URL** | [code.visualstudio.com](https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development) |
| **Release** | January 2026 (v1.109) |
| **Agents** | GitHub Copilot + Claude + Codex |
| **Subagents** | Parallel execution |
| **MCP** | Full MCP Apps support |
| **Reliability** | 9/10 |
| **Confidence** | 9/10 |

**What it is:** VS Code as a multi-agent command center. Run Claude, Codex, and Copilot side by side from a single interface.

**Key features (v1.109+):**
- **Agent Sessions view**: orchestrate multiple AI assistants, delegate tasks, compare outputs
- **Parallel subagents**: fire off multiple independent tasks simultaneously
- **Agent types**: local (interactive), background (CLI/worktrees), cloud (GitHub PRs), third-party
- **Custom agents**: specialized roles (research, implementation, security) with defined tools, instructions, and models
- **MCP Apps**: tool calls return interactive UI components (dashboards, forms, visualizations)
- **Copilot Memory**: context retention across interactions

**Agent HQ (GitHub):** Announced at GitHub Universe 2025, launched February 2026. Assign issues to Copilot, Claude, Codex, or all three to compare results.

**Agent strengths differentiation:**
- Copilot: fast autocomplete, repo-specific patterns, inline experience
- Claude: thorough, trade-off analysis, multi-file changes
- Codex: fast generation, algorithmic tasks, concise output

> Source: [VS Code Blog - Multi-Agent](https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development), [The New Stack - VS Code Multi-Agent](https://thenewstack.io/vs-code-becomes-multi-agent-command-center-for-developers/), [GitHub Blog - Agent HQ](https://github.blog/news-insights/company-news/pick-your-agent-use-claude-and-codex-on-agent-hq/)

---

### 5.2 Augment Code Intent

| Field | Value |
|-------|-------|
| **URL** | [augmentcode.com](https://www.augmentcode.com/blog/intent-a-workspace-for-agent-orchestration) |
| **Platform** | macOS (public beta, February 2026); Windows waitlist |
| **Type** | Standalone desktop app |
| **Architecture** | Living Spec + three-tier agents (Coordinator, Specialists, Verifier) |
| **BYOA** | Yes (Claude Code, Codex, OpenCode) |
| **Reliability** | 6/10 |
| **Confidence** | 7/10 |

**Unique concept: Living Spec.** A shared document that acts as the canonical source of truth. Reduces prompt drift, stale assumptions, and conflicting parallel work. Coordinator breaks requirements into tasks, specialists execute in isolated git worktrees, verifier checks results against spec.

**BYOA (Bring Your Own Agent):** Use Claude Code, Codex, or OpenCode inside Intent's workspace. Free tier for BYOA; Context Engine requires subscription.

**Context Engine:** Processes 400,000+ files through semantic dependency analysis. Agents gain understanding of service boundaries, API contracts, dependency relationships.

**Benchmark claims:** SWE-bench Pro: Auggie 51.80% vs Claude Code 49.75% vs Cursor 50.21%.

**Relevance to Claude Agent Teams UI:** Intent is the closest conceptual competitor. Both aim to be a desktop UI for multi-agent coding orchestration. Key differences:
- Intent uses living specs; our app uses kanban boards
- Intent is macOS-only; our app is cross-platform (Electron)
- Intent is commercial (freemium); ours is 100% free/open-source
- Intent requires BYOA agents; ours is Claude Code-native with potential for multi-provider

> Source: [Augment Code - Intent](https://www.augmentcode.com/blog/intent-a-workspace-for-agent-orchestration), [Intent vs Claude Code](https://www.augmentcode.com/tools/intent-vs-claude-code), [Best AI Coding Desktop Apps 2026](https://www.augmentcode.com/tools/best-ai-coding-agent-desktop-apps)

---

### 5.3 OpenAI Codex Desktop App

| Field | Value |
|-------|-------|
| **Created** | February 2, 2026 |
| **Platform** | macOS only (Windows late 2026) |
| **Type** | Standalone desktop app |
| **Architecture** | "Command center for agents" |
| **Reliability** | 7/10 |
| **Confidence** | 7/10 |

**What it does:** Centralizes multiple AI coding agents in a single interface. Manage parallel AI workflows, review automated changes, run long-running background tasks.

**Key gap vs. our app:** Codex Desktop is OpenAI-only. No multi-provider agent support. No kanban board. No team collaboration features.

> Source: [IntuitionLabs - Codex App](https://intuitionlabs.ai/articles/openai-codex-app-ai-coding-agents), [Augment Code - Desktop Apps Comparison](https://www.augmentcode.com/tools/best-ai-coding-agent-desktop-apps)

---

## 6. Relevance for Claude Agent Teams UI

### Could any of these serve as a universal backend for a desktop AI team management UI?

**Highest relevance tools:**

| Tool | Why Relevant | Integration Path | Effort |
|------|-------------|------------------|--------|
| **MCP** | Our agents already use MCP. Universal tool protocol. | Already integrated via Claude Code | Low |
| **A2A** | Could enable cross-provider agent communication (Claude + Codex + Gemini agents) | Implement A2A client/server in Electron main process | Medium-High |
| **LiteLLM** | Unified routing to any LLM. A2A agent support. Self-hosted. | Spawn local proxy, route all requests through it | Medium |
| **OpenAgents** | Native MCP + A2A. Manages Claude, Codex, Aider from single CLI. | Could replace/augment Claude Code CLI orchestration | High |
| **AGENTS.md** | Would make our kanban tasks/specs consumable by any agent | Generate AGENTS.md from team config | Low |

### Strategic positioning

Our app (Claude Agent Teams UI) has unique advantages that no competitor offers:

1. **Kanban board** -- nobody else has this for agent orchestration
2. **100% free, open-source, local-first** -- vs. Augment Intent (freemium), Codex App (OpenAI-only), VS Code (ecosystem lock-in)
3. **Claude Code-native** -- deepest integration with Claude's agent teams feature
4. **Cross-team communication** -- agents coordinate across teams, not just within

### Potential evolution path

```
Phase 1 (Current): Claude Code-native orchestration
    |
Phase 2: Add AGENTS.md export (make teams consumable by other agents)
    |
Phase 3: Add A2A server (expose our teams as A2A-discoverable agents)
    |
Phase 4: Add multi-provider support via LiteLLM/A2A
         (Claude + Codex + Gemini agents on same kanban board)
    |
Phase 5: Full "universal AI team management" platform
```

**Key risk:** The VS Code multi-agent hub (Agent HQ) has massive distribution advantage. Our differentiation must come from superior UX (kanban), deeper team management, and open-source community.

### Market context
- Gartner: 40% of enterprise apps will feature AI agents by end of 2026 (up from 5%)
- IDC: agentic AI spending to exceed $1.3T by 2029 (31.9% CAGR)
- UiPath: 65% of organizations piloting agentic systems by mid-2025

---

## Sources

### Protocols & Standards
- [Google Developers Blog - A2A Protocol](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [Google Cloud Blog - A2A Upgrade](https://cloud.google.com/blog/products/ai-machine-learning/agent2agent-protocol-is-getting-an-upgrade)
- [Linux Foundation - A2A Project](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)
- [A2A GitHub](https://github.com/a2aproject/A2A)
- [MCP Official Site](https://modelcontextprotocol.io/)
- [MCP 2026 Roadmap](http://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)
- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [Pento - A Year of MCP](https://www.pento.ai/blog/a-year-of-mcp-2025-review)
- [The New Stack - MCP Roadmap 2026](https://thenewstack.io/model-context-protocol-roadmap-2026/)
- [MCP Wikipedia](https://en.wikipedia.org/wiki/Model_Context_Protocol)
- [IBM - ACP](https://www.ibm.com/think/topics/agent-communication-protocol)
- [IBM Research - ACP](https://research.ibm.com/blog/agent-communication-protocol-ai)
- [ACP Joins A2A](https://lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a-under-the-linux-foundations-lf-ai-data/)
- [AGENTS.md Official Site](https://agents.md/)
- [InfoQ - AGENTS.md](https://www.infoq.com/news/2025/08/agents-md/)
- [IBM - What is BeeAI](https://www.ibm.com/think/topics/beeai)
- [NIST - AI Agent Standards Initiative](https://www.nist.gov/news-events/news/2026/02/announcing-ai-agent-standards-initiative-interoperable-and-secure)

### Governance
- [Linux Foundation - AAIF](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)
- [OpenAI - AAIF](https://openai.com/index/agentic-ai-foundation/)
- [Anthropic - AAIF](https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation)
- [Block - AAIF](https://block.xyz/inside/block-anthropic-and-openai-launch-the-agentic-ai-foundation)
- [AAIF Official Site](https://aaif.io/)

### Frameworks & SDKs
- [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
- [OpenAI Agents SDK GitHub](https://github.com/openai/openai-agents-python)
- [Google ADK Docs](https://google.github.io/adk-docs/)
- [Google ADK GitHub](https://github.com/google/adk-python)
- [AWS Strands Agents](https://strandsagents.com/)
- [AWS - Introducing Strands](https://aws.amazon.com/blogs/opensource/introducing-strands-agents-an-open-source-ai-agents-sdk/)
- [AWS - Strands 1.0](https://aws.amazon.com/blogs/opensource/introducing-strands-agents-1-0-production-ready-multi-agent-orchestration-made-simple/)
- [Microsoft Agent Framework](https://github.com/microsoft/agent-framework)
- [Microsoft Learn - Agent Framework](https://learn.microsoft.com/en-us/agent-framework/overview/)
- [Visual Studio Magazine - Agent Framework](https://visualstudiomagazine.com/articles/2025/10/01/semantic-kernel-autogen--open-source-microsoft-agent-framework.aspx)
- [LangGraph](https://github.com/langchain-ai/langgraph)
- [CrewAI](https://crewai.com/)
- [OpenAgents](https://openagents.org/)
- [OpenAgents GitHub](https://github.com/openagents-org/openagents)
- [GitAgent GitHub](https://github.com/open-gitagent/gitagent)
- [MarkTechPost - GitAgent](https://www.marktechpost.com/2026/03/22/meet-gitagent-the-docker-for-ai-agents-that-is-finally-solving-the-fragmentation-between-langchain-autogen-and-claude-code/)
- [Goose GitHub](https://github.com/block/goose)
- [Block - Introducing Goose](https://block.xyz/inside/block-open-source-introduces-codename-goose)

### Routing & Gateways
- [LiteLLM Docs](https://docs.litellm.ai/)
- [LiteLLM GitHub](https://github.com/BerriAI/litellm)
- [OpenRouter](https://openrouter.ai/)
- [Top 5 LiteLLM Alternatives 2026](https://www.getmaxim.ai/articles/top-5-litellm-alternatives-in-2026/)

### Desktop Tools
- [VS Code Blog - Multi-Agent](https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development)
- [The New Stack - VS Code Multi-Agent](https://thenewstack.io/vs-code-becomes-multi-agent-command-center-for-developers/)
- [GitHub Blog - Agent HQ](https://github.blog/news-insights/company-news/pick-your-agent-use-claude-and-codex-on-agent-hq/)
- [Augment Code - Intent](https://www.augmentcode.com/blog/intent-a-workspace-for-agent-orchestration)
- [Augment Code - Best Desktop Apps](https://www.augmentcode.com/tools/best-ai-coding-agent-desktop-apps)
- [IntuitionLabs - Codex App](https://intuitionlabs.ai/articles/openai-codex-app-ai-coding-agents)

### Framework Comparisons
- [DataCamp - CrewAI vs LangGraph vs AutoGen](https://www.datacamp.com/tutorial/crewai-vs-langgraph-vs-autogen)
- [OpenAgents Blog - Frameworks Compared](https://openagents.org/blog/posts/2026-02-23-open-source-ai-agent-frameworks-compared)
- [DEV - Agent Showdown 2026](https://dev.to/topuzas/the-great-ai-agent-showdown-of-2026-openai-autogen-crewai-or-langgraph-1ea8)
- [Shakudo - Top 9 AI Agent Frameworks](https://www.shakudo.io/blog/top-9-ai-agent-frameworks)
- [AIMultiple - Top 5 Agentic Frameworks 2026](https://aimultiple.com/agentic-frameworks)

### Market Research
- [Gravitee - A2A vs MCP](https://www.gravitee.io/blog/googles-agent-to-agent-a2a-and-anthropics-model-context-protocol-mcp)
- [RUH.AI - AI Agent Protocols 2026 Complete Guide](https://www.ruh.ai/blogs/ai-agent-protocols-2026-complete-guide)
- [Thoughtworks - MCP Impact 2025](https://www.thoughtworks.com/en-us/insights/blog/generative-ai/model-context-protocol-mcp-impact-2025)
- [Shipyard - Claude Code Multi-Agent 2026](https://shipyard.build/blog/claude-code-multi-agent/)
