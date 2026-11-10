# AI Agent Orchestration Tools & Frameworks (March 2026)

> Research date: 2026-03-24
> Focus: Multi-provider AI coding agent orchestration — tools that coordinate Claude Code, Codex CLI, Gemini CLI, and other AI agents together.

## Executive Summary

The multi-agent AI orchestration market has exploded in 2025-2026. Gartner reports a **1,445% surge** in multi-agent system inquiries from Q1 2024 to Q2 2025. The AI agent market reached **$7.84B in 2025**, projected to hit **$52.62B by 2030** (CAGR 46.3%).

The landscape splits into three distinct categories:
1. **Desktop orchestrators** — Electron/Tauri apps managing parallel coding agents with kanban boards, diff viewers, git worktree isolation
2. **CLI/framework orchestrators** — Command-line tools and Python/TypeScript frameworks for multi-agent coordination
3. **General-purpose multi-agent frameworks** — Provider-agnostic frameworks for building any multi-agent system (not coding-specific)

**Key finding for our project:** Multiple direct competitors have emerged with kanban boards + multi-agent orchestration (Vibe Kanban, Dorothy, Mozzie). However, none combine all of: multi-provider agent support + kanban + code review + team communication + Electron desktop app in the way Claude Agent Teams UI does.

---

## Category 1: Desktop Orchestrators (Most Relevant to Our Project)

### 1.1 Vibe Kanban (BloopAI)

| Attribute | Details |
|-----------|---------|
| **URL** | [github.com/BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) |
| **Stars** | ~23,700 |
| **License** | Open source (free) |
| **Tech Stack** | Rust (backend) + TypeScript/React (frontend) |
| **AI Providers** | Claude Code, Codex, Gemini CLI, GitHub Copilot, Amp, Cursor, OpenCode, Droid, CCR, Qwen Code (10+) |
| **Reliability** | 8/10 |
| **Confidence** | 9/10 |

**Architecture:** Cross-platform orchestration platform (CLI + web UI) with kanban board. Each agent gets its own git worktree and branch. Implements MCP both as client and server — the kanban board itself becomes an API for AI agents.

**Key features:**
- Kanban board with drag-and-drop task management
- Parallel agent execution in isolated workspaces
- Built-in diff review with inline comments
- Built-in browser preview with devtools
- MCP server — other agents can create tasks, move cards, read board status
- PR creation and merge from UI
- Install via `npx vibe-kanban`

**Relevance to us:** **DIRECT COMPETITOR.** Has kanban + multi-agent + diff review. Key differences: no team communication/messaging between agents, no session analysis, no context monitoring. Uses Rust backend (not Electron).

---

### 1.2 Dorothy

| Attribute | Details |
|-----------|---------|
| **URL** | [github.com/Charlie85270/Dorothy](https://github.com/Charlie85270/Dorothy) |
| **Website** | [dorothyai.app](https://dorothyai.app/) |
| **License** | Open source |
| **Tech Stack** | Electron + React/Next.js |
| **AI Providers** | Claude Code, Codex, Gemini CLI |
| **Reliability** | 7/10 |
| **Confidence** | 8/10 |

**Architecture:** Electron desktop app with isolated PTY terminal sessions per agent. Features a "Super Agent" orchestrator that programmatically controls all other agents via MCP tools.

**Key features:**
- Kanban board with drag-and-drop, agents auto-pick work by skill
- 5 MCP servers (40+ tools) for programmatic agent control
- Super Agent meta-orchestrator that delegates across agent pool
- GitHub, JIRA, Telegram, Slack integrations
- Google Workspace integration (Gmail, Drive, Sheets, Calendar)
- Community skill plugins from skills.sh
- 3D animated agent visualization
- Agent automations (trigger on GitHub PRs, issues, events)
- Scheduling and recurring agent tasks

**Relevance to us:** **DIRECT COMPETITOR.** Electron + kanban + multi-agent + MCP. Most similar to our architecture. Lacks: team-level communication, deep session analysis, context token tracking, structured code review workflow.

---

### 1.3 Superset

| Attribute | Details |
|-----------|---------|
| **URL** | [github.com/superset-sh/superset](https://github.com/superset-sh/superset) |
| **Website** | [superset.sh](https://superset.sh/) |
| **Stars** | ~7,800 |
| **License** | Elastic License 2.0 (ELv2) — NOT MIT/Apache |
| **Tech Stack** | Electron + React + xterm.js + TailwindCSS v4, Bun + Turborepo |
| **AI Providers** | Claude Code, Codex, OpenCode, Cursor Agent — any CLI agent |
| **Reliability** | 7/10 |
| **Confidence** | 8/10 |

**Architecture:** Electron desktop terminal environment. Each task gets its own git worktree. Built-in diff viewer and editor. Same terminal stack as VS Code (xterm.js).

**Key features:**
- Run 10+ agents simultaneously
- Git worktree isolation per task
- Built-in diff viewer
- Workspace presets (automate env setup, deps)
- One-click open in external IDE
- Agent status monitoring and notifications

**Relevance to us:** Competitor in the parallel-agent-desktop space. Less feature-rich (no kanban, no team messaging, no code review workflow). More of a "terminal multiplexer for agents" than a full management platform.

---

### 1.4 Mozzie

| Attribute | Details |
|-----------|---------|
| **URL** | [github.com/usemozzie/mozzie](https://github.com/usemozzie/mozzie) |
| **License** | Open source |
| **Tech Stack** | Tauri (Rust) + Node + pnpm |
| **AI Providers** | Claude Code, Gemini CLI, Codex CLI, custom scripts |
| **Reliability** | 6/10 |
| **Confidence** | 7/10 |

**Architecture:** Tauri desktop app with LLM orchestrator. Agents communicate via ACP (Agent Communication Protocol) over stdio. Persistent orchestrator conversation history.

**Key features:**
- LLM orchestrator that creates work items, sets dependencies, assigns agents
- Git worktree isolation per work item
- Dependency graph with cycle detection
- Sub-work-items with stacked branches
- Review workflow (approve to push, reject with feedback)
- Live streaming of agent output with tool-call visualization
- Agents learn from rejection history

**Relevance to us:** Competitor. Tauri-based (lighter than Electron). Has dependency management and review workflow. No kanban board per se, more of a work-item queue.

---

### 1.5 Parallel Code

| Attribute | Details |
|-----------|---------|
| **URL** | [github.com/johannesjo/parallel-code](https://github.com/johannesjo/parallel-code) |
| **License** | MIT |
| **AI Providers** | Claude Code, Codex CLI, Gemini CLI |
| **Reliability** | 6/10 |
| **Confidence** | 7/10 |

**Architecture:** Desktop app with automatic git worktree creation per task. Keyboard-first design.

**Key features:**
- Automatic branch + worktree per task
- 5+ agents in parallel, zero conflicts
- Unified session view
- Built-in diff viewer with one-click merge
- Mobile monitoring via QR code (Wi-Fi/Tailscale)
- Keyboard-first, mouse optional

**Relevance to us:** Simpler competitor focused on parallel execution + diff review. No kanban, no team communication.

---

## Category 2: CLI/Framework Orchestrators for Coding Agents

### 2.1 MCO (Multi-CLI Orchestrator)

| Attribute | Details |
|-----------|---------|
| **URL** | [github.com/mco-org/mco](https://github.com/mco-org/mco) |
| **License** | Open source |
| **Language** | TypeScript/Node |
| **AI Providers** | Claude Code, Codex CLI, Gemini CLI, OpenCode, Qwen Code |
| **Reliability** | 7/10 |
| **Confidence** | 7/10 |

**Architecture:** Neutral orchestration layer. Dispatches prompts to multiple agent CLIs in parallel, aggregates results, returns structured output (JSON, SARIF, PR-ready Markdown). No vendor lock-in.

**Key concept:** "Work like a Tech Lead" — assign one task to multiple agents, run in parallel, compare outcomes. Designed to be called by any IDE or agent (Cursor, Trae, Copilot, Windsurf).

**Integration potential:** Could be used as a backend dispatch layer. MCO handles the multi-agent fan-out; our UI handles the visualization and management.

---

### 2.2 Agent Orchestrator (ComposioHQ)

| Attribute | Details |
|-----------|---------|
| **URL** | [github.com/ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator) |
| **Stars** | ~4,500 |
| **License** | MIT |
| **Language** | TypeScript |
| **AI Providers** | Claude Code, Codex, Aider (agent-agnostic plugin system) |
| **Reliability** | 7/10 |
| **Confidence** | 8/10 |

**Architecture:** Plugin-based orchestrator managing fleets of coding agents. 8 pluggable abstraction slots: agent, runtime, tracker, reviewer, etc. Each agent gets own git worktree, branch, and PR.

**Key features:**
- Agent-agnostic (Claude Code, Codex, Aider)
- Runtime-agnostic (tmux, Docker)
- Tracker-agnostic (GitHub, Linear)
- Auto-fix CI failures and address review comments
- Centralized dashboard for monitoring
- 100% AI co-authored codebase (impressive dogfooding)
- 30 concurrent agents at peak

**Impressive stat:** 8 days from first commit to 43K lines of TypeScript, 91 commits, 61 PRs merged, 84% of PRs created by AI agent sessions.

---

### 2.3 AWS CLI Agent Orchestrator (CAO)

| Attribute | Details |
|-----------|---------|
| **URL** | [github.com/awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator) |
| **License** | Open source |
| **Language** | Python |
| **AI Providers** | Amazon Q CLI, Claude Code (Codex CLI, Gemini CLI, Qwen CLI planned) |
| **Reliability** | 7/10 |
| **Confidence** | 8/10 |

**Architecture:** Hierarchical multi-agent system with Supervisor Agent coordinating Worker Agents. Each agent in isolated tmux session. Communication via MCP servers. Local HTTP server processes orchestration requests.

**Orchestration patterns:**
- Handoff (synchronous task transfer)
- Assign (async parallel execution)
- Send Message (direct agent communication)
- Flow — scheduled cron-like runs

**Caveat:** Supervisor runs on Amazon Bedrock — requires AWS credentials and account. Open source code but can't run without AWS infrastructure.

---

### 2.4 MetaSwarm

| Attribute | Details |
|-----------|---------|
| **URL** | [github.com/dsifry/metaswarm](https://github.com/dsifry/metaswarm) |
| **License** | Open source |
| **Language** | TypeScript/Node |
| **AI Providers** | Claude Code, Gemini CLI, Codex CLI |
| **Reliability** | 7/10 |
| **Confidence** | 7/10 |

**Architecture:** Self-improving multi-agent orchestration with 18 specialized agent personas, 13 skills, 15 commands. 9-phase workflow from issue to merged PR.

**Key features:**
- Recursive orchestration (swarm of swarms)
- Cross-model review (writer reviewed by different AI model)
- Per-task and per-session USD budget circuit breakers
- TDD enforcement, quality gates
- Git worktree isolation with sandbox protection
- Auto-detects Team Mode when multiple sessions active
- Install via `npx metaswarm init`

---

### 2.5 Overstory

| Attribute | Details |
|-----------|---------|
| **URL** | [github.com/jayminwest/overstory](https://github.com/jayminwest/overstory) |
| **License** | Open source |
| **Language** | TypeScript (Bun) |
| **AI Providers** | Claude Code, Pi, Gemini CLI, Aider, Goose, Amp (11 runtime adapters) |
| **Reliability** | 6/10 |
| **Confidence** | 7/10 |

**Architecture:** Pluggable `AgentRuntime` interface. Tmux isolation per agent in git worktrees. SQLite WAL-mode mail system for inter-agent messaging (~1-5ms per query). Two-layer instruction system (Base + per-task Overlay).

**Key features:**
- 11 runtime adapters
- FIFO merge queue with 4-tier conflict resolution
- Tiered watchdog system (mechanical daemon + AI triage + monitor agent)
- Instruction overlays for orchestrated workers
- Honest self-critique in project docs (refreshing transparency)

---

### 2.6 Claude Octopus

| Attribute | Details |
|-----------|---------|
| **URL** | [github.com/nyldn/claude-octopus](https://github.com/nyldn/claude-octopus) |
| **License** | Open source |
| **AI Providers** | Codex, Gemini, Claude, Perplexity, OpenRouter, Copilot, Qwen, Ollama (8 providers) |
| **Reliability** | 6/10 |
| **Confidence** | 7/10 |

**Architecture:** Multi-LLM orchestration plugin for Claude Code. 75% consensus gate catches disagreements before production. 32 specialized personas, 47 commands, 50 skills. Zero providers required to start — add them one at a time.

---

### 2.7 agtx

| Attribute | Details |
|-----------|---------|
| **URL** | [github.com/fynnfluegge/agtx](https://github.com/fynnfluegge/agtx) |
| **License** | Open source |
| **AI Providers** | Claude Code, Codex, Gemini CLI, OpenCode, Cursor |
| **Reliability** | 6/10 |
| **Confidence** | 6/10 |

**Architecture:** Multi-session AI coding terminal manager. Orchestrator agent picks up tasks, plans, and delegates to multiple coding agents running in parallel.

---

## Category 3: General-Purpose Multi-Agent Frameworks

### 3.1 CrewAI

| Attribute | Details |
|-----------|---------|
| **URL** | [github.com/crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) |
| **Stars** | ~45,900 |
| **License** | MIT |
| **Language** | Python |
| **AI Providers** | OpenAI, Anthropic, Gemini, Ollama, any via LiteLLM |
| **Maturity** | Production-ready, 100K+ certified developers |
| **Reliability** | 9/10 |
| **Confidence** | 9/10 |

**Architecture:** Role-based metaphor (role, goal, backstory per agent). Three process types: sequential, hierarchical, consensual. Native MCP and A2A support. Two approaches: Crews (autonomy) and Flows (enterprise production).

**Electron integration potential:** Python-based, so would need a subprocess/API bridge. Not designed for desktop UI integration but could serve as an orchestration backend.

---

### 3.2 Microsoft Agent Framework (AutoGen + Semantic Kernel)

| Attribute | Details |
|-----------|---------|
| **URL** | [learn.microsoft.com/en-us/agent-framework](https://learn.microsoft.com/en-us/agent-framework/overview/) |
| **Stars** | AutoGen: ~52,000 |
| **License** | Open source (MIT) |
| **Language** | Python, .NET |
| **AI Providers** | OpenAI, Azure OpenAI, Anthropic, Gemini, local models |
| **Maturity** | GA targeted end Q1 2026 |
| **Reliability** | 8/10 |
| **Confidence** | 8/10 |

**Architecture:** Unified SDK + runtime merging AutoGen + Semantic Kernel. Orchestration patterns: sequential, concurrent, group chat, handoff, Magentic (dynamic task ledger). Event-driven core, async-first.

**Electron integration potential:** Primarily Python/.NET. Could use as a backend runtime via API.

---

### 3.3 Agno

| Attribute | Details |
|-----------|---------|
| **URL** | [github.com/agno-agi/agno](https://github.com/agno-agi/agno) |
| **Stars** | ~38,900 |
| **License** | Apache-2.0 |
| **Language** | Python |
| **AI Providers** | OpenAI, Anthropic, Groq, and many more |
| **Maturity** | Production-ready (AgentOS + FastAPI runtime) |
| **Reliability** | 8/10 |
| **Confidence** | 8/10 |

**Architecture:** Three-layer design: framework (agents, teams, workflows), runtime (stateless FastAPI backends), monitoring. Claims 529x faster instantiation than LangGraph. Teams with automatic agent-to-agent communication, context passing, result aggregation.

**Electron integration potential:** FastAPI backend makes it easy to integrate via HTTP API.

---

### 3.4 OpenAI Agents SDK (successor to Swarm)

| Attribute | Details |
|-----------|---------|
| **URL** | [github.com/openai/openai-agents-python](https://github.com/openai/openai-agents-python) |
| **License** | MIT |
| **Language** | Python |
| **AI Providers** | OpenAI + 100+ LLMs via provider-agnostic design |
| **Maturity** | Production-ready (launched March 2025) |
| **Reliability** | 8/10 |
| **Confidence** | 9/10 |

**Architecture:** Core primitives: Agents, Handoffs, Guardrails, Function tools, MCP server tool calling, Sessions, Tracing. Handoff pattern: agents transfer control explicitly, carrying conversation context. Built-in MCP integration.

---

### 3.5 LangGraph (by LangChain)

| Attribute | Details |
|-----------|---------|
| **URL** | [github.com/langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) |
| **License** | MIT |
| **Language** | Python, TypeScript |
| **AI Providers** | Model-agnostic (plug different LLMs into different nodes) |
| **Maturity** | Production-ready, LangSmith observability |
| **Reliability** | 8/10 |
| **Confidence** | 9/10 |

**Architecture:** Graph-based design. Each agent is a node maintaining its own state. Conditional edges, multi-team coordination, hierarchical control. Supervisor nodes for scalable orchestration.

---

### 3.6 AWS Agent Squad (formerly Multi-Agent Orchestrator)

| Attribute | Details |
|-----------|---------|
| **URL** | [github.com/awslabs/agent-squad](https://github.com/awslabs/agent-squad) |
| **License** | Open source |
| **Language** | Python, TypeScript (dual) |
| **AI Providers** | AWS Bedrock, extensible |
| **Reliability** | 7/10 |
| **Confidence** | 8/10 |

**Architecture:** Intelligent intent classification routes queries dynamically. Streaming + non-streaming support. Context management across agents. Universal deployment (Lambda to any cloud).

---

### 3.7 Google ADK (Agent Development Kit)

| Attribute | Details |
|-----------|---------|
| **URL** | [cloud.google.com](https://cloud.google.com/blog/products/ai-machine-learning/unlock-ai-agent-collaboration-convert-adk-agents-for-a2a) |
| **License** | Open source |
| **Language** | Python |
| **AI Providers** | Gemini (primary), extensible |
| **Reliability** | 7/10 |
| **Confidence** | 8/10 |

**Architecture:** Hierarchical agent tree. Native A2A protocol support — agents from different frameworks can discover and invoke each other.

---

### 3.8 OpenAI Symphony (New — March 2026)

| Attribute | Details |
|-----------|---------|
| **URL** | See [Medium article](https://medium.com/@georgethomasm_89397/openai-symphony-the-new-orchestration-framework-for-multi-agent-systems-2ec991ee74cc) |
| **License** | Open source |
| **Language** | Python |
| **Maturity** | Very early (released March 5, 2026) |
| **Reliability** | 4/10 |
| **Confidence** | 5/10 |

**Architecture:** Hierarchical delegation, iterative refinement, composable workflows. Checkpoint-based recovery — if agent fails mid-execution, workflow resumes from last checkpoint. Documentation sparse, community small, but growing.

---

## Key Protocols & Standards

### Google A2A (Agent-to-Agent Protocol)

| Attribute | Details |
|-----------|---------|
| **URL** | [a2a-protocol.org](https://a2a-protocol.org/latest/) |
| **GitHub** | [github.com/a2aproject/A2A](https://github.com/a2aproject/A2A) |
| **Status** | v0.3 (July 2025), donated to Linux Foundation |
| **Supporters** | 150+ organizations (Google, Atlassian, Salesforce, SAP, etc.) |
| **Confidence** | 9/10 |

**Purpose:** Agent-to-agent communication standard. Complementary to MCP (agent-to-tool). Agent Cards (JSON) for capability discovery. HTTP + gRPC transport. Becoming the de facto interop standard.

### Anthropic MCP (Model Context Protocol)

Already integrated into our project. MCP = agent-to-tool communication. A2A = agent-to-agent communication. The two are complementary.

---

## Comparison Matrix: Desktop Orchestrators

| Feature | **Our App** | **Vibe Kanban** | **Dorothy** | **Superset** | **Mozzie** |
|---------|------------|-----------------|-------------|--------------|------------|
| **Kanban board** | Yes | Yes | Yes | No | No |
| **Multi-provider agents** | Claude only* | 10+ agents | 3 agents | Any CLI | 3+ agents |
| **Code review / diff** | Yes | Yes | No | Yes | Yes |
| **Team communication** | Yes | No | Via Super Agent | No | No |
| **Session analysis** | Yes (deep) | No | No | No | No |
| **Context monitoring** | Yes | No | No | No | No |
| **MCP integration** | Yes | Yes (client+server) | Yes (5 servers) | No | ACP |
| **Agent-to-agent messaging** | Yes | Via MCP | Via Super Agent | No | Via ACP |
| **Dependency graph** | No | No | No | No | Yes |
| **External integrations** | No | GitHub | GitHub, JIRA, Slack, Telegram | IDE integration | No |
| **Tech stack** | Electron/React | Rust/React | Electron/React | Electron/React | Tauri |
| **License** | MIT | Free/OSS | OSS | ELv2 | OSS |
| **GitHub stars** | ~small | ~23,700 | Unknown | ~7,800 | Unknown |

*Currently Claude-only, but the architecture could support multi-provider agents.

---

## Strategic Recommendations

### Immediate Opportunities

1. **Multi-provider support is the #1 gap.** Every competitor now supports Claude + Codex + Gemini. Our single-provider approach is a significant limitation. Priority: HIGH.

2. **MCP server exposure.** Dorothy and Vibe Kanban expose their kanban board as an MCP server — agents can programmatically create tasks, move cards, check status. This is a powerful pattern we should adopt.

3. **A2A protocol awareness.** The A2A standard (150+ orgs, Linux Foundation) is becoming the agent-to-agent interop standard. We should monitor and potentially implement it.

### Integration Paths for Multi-Provider Support

| Approach | Description | Effort | Reliability |
|----------|-------------|--------|-------------|
| **Direct CLI integration** | Spawn Codex CLI / Gemini CLI alongside Claude Code in separate processes | Medium | 8/10 |
| **MCO as dispatch layer** | Use MCO to fan out tasks across multiple agent CLIs | Low | 7/10 |
| **Plugin architecture** | Build pluggable AgentRuntime interface (like Overstory) | High | 9/10 |
| **A2A protocol** | Implement A2A for cross-agent communication | High | 7/10 |

### Unique Differentiators We Should Protect

1. **Deep session analysis** (bash commands, reasoning, subprocesses) — nobody else has this
2. **Context monitoring** (token usage by category) — unique feature
3. **Team communication model** (lead + teammates with direct messaging) — only Dorothy's Super Agent comes close
4. **Post-compact context recovery** — unique
5. **Code review workflow** (accept/reject/comment per task) — Vibe Kanban is closest competitor here

### Tools Worth Investigating Further

1. **Vibe Kanban** — most direct competitor, 23.7K stars, Rust backend, mature feature set
2. **Dorothy** — Electron architecture closest to ours, MCP-heavy, good integration model
3. **Agent Orchestrator (ComposioHQ)** — plugin architecture is excellent, could inspire our multi-provider design
4. **MCO** — lightweight dispatch layer we could integrate as-is
5. **Overstory** — SQLite mail system for inter-agent messaging is elegant

---

## Curated Resource Lists

- [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators) — Comprehensive list of orchestration tools
- [awesome-cli-coding-agents](https://github.com/bradAGI/awesome-cli-coding-agents) — 80+ CLI coding agents + orchestration harnesses
- [awesome-ai-agents-2026](https://github.com/caramaschiHG/awesome-ai-agents-2026) — 300+ resources across 20+ categories

---

## Sources

- [Top 5 Open-Source Agentic AI Frameworks in 2026](https://aimultiple.com/agentic-frameworks)
- [Top 9 AI Agent Frameworks — Shakudo](https://www.shakudo.io/blog/top-9-ai-agent-frameworks)
- [Best Open Source Frameworks for AI Agents — Firecrawl](https://www.firecrawl.dev/blog/best-open-source-agent-frameworks)
- [Microsoft Agent Framework Announcement](https://devblogs.microsoft.com/foundry/introducing-microsoft-agent-framework-the-open-source-engine-for-agentic-ai-apps/)
- [OpenAI Symphony — Medium](https://medium.com/@georgethomasm_89397/openai-symphony-the-new-orchestration-framework-for-multi-agent-systems-2ec991ee74cc)
- [CrewAI Open Source](https://crewai.com/open-source)
- [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
- [AWS CLI Agent Orchestrator](https://aws.amazon.com/blogs/opensource/introducing-cli-agent-orchestrator-transforming-developer-cli-tools-into-a-multi-agent-powerhouse/)
- [Google A2A Protocol](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [A2A Protocol v0.3 Upgrade](https://cloud.google.com/blog/products/ai-machine-learning/agent2agent-protocol-is-getting-an-upgrade)
- [Warp Oz Platform](https://www.warp.dev/blog/oz-orchestration-platform-cloud-agents)
- [Vibe Kanban](https://vibekanban.com/)
- [Dorothy AI](https://dorothyai.app/)
- [Superset IDE](https://superset.sh/)
- [MCO — mco-org/mco](https://github.com/mco-org/mco)
- [Agent Orchestrator — ComposioHQ](https://github.com/ComposioHQ/agent-orchestrator)
- [MetaSwarm](https://github.com/dsifry/metaswarm)
- [Overstory](https://github.com/jayminwest/overstory)
- [Claude Octopus](https://github.com/nyldn/claude-octopus)
- [Mozzie](https://github.com/usemozzie/mozzie)
- [Parallel Code](https://github.com/johannesjo/parallel-code)
- [Orchestral AI Paper](https://arxiv.org/abs/2601.02577)
- [LLM Orchestration 2026 — AIMultiple](https://aimultiple.com/llm-orchestration)
- [Multi-Agent Frameworks 2026 — GuruSup](https://gurusup.com/blog/best-multi-agent-frameworks-2026)
- [Agno Framework](https://github.com/agno-agi/agno)
- [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)
- [awesome-cli-coding-agents](https://github.com/bradAGI/awesome-cli-coding-agents)
