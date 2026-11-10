# Конкуренты: платформы для оркестрации AI-агентов

> Дата: 2026-03-04
> Статус: Исследование завершено

## Цель

Оценить конкурентный ландшафт для концепции **"self-hosted web dashboard для оркестрации команд AI coding-агентов с workflow automation"**.

---

## Часть 1: Multi-Agent фреймворки

### CrewAI

| Параметр | Данные |
|---|---|
| **GitHub** | [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) |
| **Stars** | ~44,600 |
| **Open Source** | Да, MIT |
| **Web UI** | CrewAI Studio (cloud, визуальный no-code билдер) |
| **MCP** | Да — нативный (`mcps` на агентах, `MCPServerAdapter`, экспорт crew как MCP-сервер) |
| **Multi-agent** | Да — основная концепция. Role-based crews, sequential/parallel/conditional архитектуры, A2A делегирование |
| **Self-hosted** | Да — on-premise, AWS/Azure/GCP VPC |
| **Модели** | Любые LLM через LiteLLM |
| **Pricing** | Free (self-host), $99/мес (Basic), до $120K/год (Ultra) |

**Дифференциатор:** Самый популярный multi-agent фреймворк. 60% Fortune 500. Мощная memory-система.
**Слабость:** Python-only. Studio — cloud, не полноценный self-hosted web UI. Нет IDE. Нет фокуса на coding.

---

### LangGraph Studio (LangChain)

| Параметр | Данные |
|---|---|
| **GitHub** | [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) |
| **Stars** | ~25,500 |
| **Open Source** | Да, MIT |
| **Web UI** | LangGraph Studio v2 (браузер), Open Agent Platform (open-source no-code) |
| **MCP** | Да — `langchain-mcp-adapters`, каждый deployed agent = MCP endpoint |
| **Multi-agent** | Да — Swarm, Supervisor, handoff паттерны |
| **Self-hosted** | Частично (Developer tier free, Enterprise — full self-hosted) |
| **Модели** | Любые через LangChain |
| **Pricing** | Developer: free. Plus: $39/seat/мес. Enterprise: от $100K+/год |

**Дифференциатор:** Graph-based DAG архитектура, durable execution, глубокая интеграция с LangSmith.
**Слабость:** Высокий порог входа (code-first). Сложная ценовая структура. Studio больше для дебага.

---

### AutoGen Studio (Microsoft)

| Параметр | Данные |
|---|---|
| **GitHub** | [microsoft/autogen](https://github.com/microsoft/autogen) |
| **Stars** | ~50,400 |
| **Open Source** | Да, MIT |
| **Web UI** | Да — drag-and-drop web UI для multi-agent workflows |
| **MCP** | Да — `autogen_ext.tools.mcp` (Stdio, SSE, Streamable HTTP) |
| **Multi-agent** | Да — async event-driven архитектура |
| **Self-hosted** | Да — полностью (Python package) |
| **Модели** | Любые LLM |
| **Pricing** | Полностью бесплатно |

**Дифференциатор:** Microsoft Research, 50K+ stars, полностью бесплатно.
**Слабость:** ⚠️ **В РЕЖИМЕ MAINTENANCE!** Мержится с Semantic Kernel в "Microsoft Agent Framework". Новые фичи не будут. Миграция неизбежна.

---

## Часть 2: Coding Agent платформы

### ⭐ OpenHands (formerly OpenDevin) — БЛИЖАЙШИЙ КОНКУРЕНТ

| Параметр | Данные |
|---|---|
| **GitHub** | [All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands) |
| **Stars** | ~64,000+ |
| **Open Source** | Да, MIT |
| **Web UI** | Да — полноценный: shell, browser, VSCode-editor, planner, VNC desktop |
| **MCP** | Да — typed tool system с MCP integration |
| **Multi-agent** | Да — hierarchical agent delegation, AgentHub (CodeActAgent, BrowserAgent, Micro-agents) |
| **Self-hosted** | Да — Docker (MIT, free). Enterprise — VPC/Kubernetes |
| **Модели** | Model-agnostic: Claude, GPT, open-source через litellm |
| **Pricing** | Open Source: free. Cloud Growth: $500/мес. Enterprise: custom |

**Дифференциатор:** Самый близкий по духу. Web UI для coding agents, multi-agent, sandbox execution, REST+WebSocket API. MIT лицензия. $18.8M funding.

**Слабость:** Нет визуального workflow editor. Нет Kanban/task management. Нет team provisioning UI. UI для individual sessions, не для управления командами.

---

### Cursor

| Параметр | Данные |
|---|---|
| **Stars** | N/A (closed-source, VS Code fork) |
| **Open Source** | Нет |
| **Web UI** | Нет — desktop IDE |
| **MCP** | Да — first-class MCP, Apps, Marketplace |
| **Multi-agent** | Да — до 8 parallel agents через git worktrees, Background Agents, BugBot |
| **Self-hosted** | Нет |
| **Pricing** | Free (50 req/мес), Pro $20/мес, Ultra $200/мес |

**Дифференциатор:** $500M ARR, $10B valuation. Единственный с multi-agent parallel execution для coding.
**Слабость:** Closed-source, desktop-only, нет self-hosted, vendor lock-in. Это IDE, не платформа оркестрации.

---

### Windsurf (formerly Codeium → Cognition AI)

| Параметр | Данные |
|---|---|
| **Open Source** | Нет (только Vim/Neovim плагины) |
| **Web UI** | Нет — desktop IDE |
| **MCP** | Да — Stdio и HTTP MCP, Marketplace |
| **Multi-agent** | Нет |
| **Self-hosted** | Enterprise: cloud/hybrid/self-hosted |
| **Pricing** | Free (25 credits/мес), Pro $15/мес, Teams $30/user/мес |

**Дифференциатор:** #1 в LogRocket AI Dev Tool Rankings (Feb 2026). Куплен Cognition AI ($250M) → интеграция с Devin.
**Слабость:** Closed-source, desktop-only, нет multi-agent. Acquisition создаёт неопределённость.

---

### Cody / Sourcegraph Amp

| Параметр | Данные |
|---|---|
| **Open Source** | Был open-source (Apache), теперь private repo. Open-core |
| **Web UI** | Частично — web-search по коду, Batch Changes UI |
| **MCP** | Да — MCP tools (GitHub, Sentry, Linear) |
| **Multi-agent** | Нет |
| **Pricing** | Free. Enterprise: $19-59/user/мес |

**Дифференциатор:** Deep Search по огромным кодобазам. 10 лет code intelligence.
**Слабость:** Уже не полностью open-source. Не orchestration-платформа.

---

## Часть 3: Workflow/AI App платформы

### Dify

| Параметр | Данные |
|---|---|
| **GitHub** | [langgenius/dify](https://github.com/langgenius/dify) |
| **Stars** | ~119K |
| **Open Source** | Модифицированная Apache 2.0 |
| **Web UI** | Да — полноценный drag-and-drop visual builder, playground, LLMOps дашборд |
| **MCP** | Да — двусторонний (v1.6.0) |
| **Multi-agent** | Частично — workflows с Agent Nodes |
| **Self-hosted** | Да — Docker/K8s |
| **Модели** | Сотни LLM |

**Дифференциатор:** Самая зрелая LLMOps платформа. 100K+ stars. Визуальные workflows, RAG, MCP.
**Слабость:** Не заточен на coding-агентов. Ограничения лицензии (no multi-tenant без коммерческой).

---

### n8n

| Параметр | Данные |
|---|---|
| **GitHub** | [n8n-io/n8n](https://github.com/n8n-io/n8n) |
| **Stars** | ~177K |
| **Open Source** | Sustainable Use License |
| **Web UI** | Да — лучший визуальный workflow editor в категории |
| **MCP** | Да — двусторонний (MCP Client + MCP Server Trigger) |
| **Multi-agent** | Скоро — "advanced multi-agent" в анонсах |
| **Self-hosted** | Да — Docker/K8s, бесплатно |
| **Модели** | OpenAI, Claude, Gemini через интеграции |

**Дифференциатор:** 177K stars, 500+ интеграций, $180M Series C ($2.5B оценка). Лучший workflow editor.
**Слабость:** Workflow automation, не AI agent orchestration. AI — дополнение, не ядро. SUL лицензия.

---

### Langflow

| Параметр | Данные |
|---|---|
| **GitHub** | [langflow-ai/langflow](https://github.com/langflow-ai/langflow) |
| **Stars** | ~130-140K |
| **Open Source** | MIT |
| **Web UI** | Да — drag-and-drop builder |
| **MCP** | Да — flows как MCP server |
| **Self-hosted** | Да — Docker/pip |

**Дифференциатор:** Самый низкий порог входа, MIT, построен на LangChain.
**Слабость:** General-purpose, не coding-specific.

---

### Flowise

| Параметр | Данные |
|---|---|
| **GitHub** | [FlowiseAI/Flowise](https://github.com/FlowiseAI/Flowise) |
| **Stars** | ~43K |
| **Open Source** | MIT |
| **Web UI** | Да — drag-and-drop, Agentflow V2 (multi-agent) |
| **MCP** | Не подтверждено |
| **Self-hosted** | Да — Docker |

**Дифференциатор:** Чистая MIT лицензия. Enterprise-фичи (RBAC, SSO). Клиенты — Accenture, Deloitte.
**Слабость:** Меньше чем Dify. Не coding-specific.

---

### Activepieces

| Параметр | Данные |
|---|---|
| **GitHub** | [activepieces/activepieces](https://github.com/activepieces/activepieces) |
| **Stars** | ~20K |
| **Open Source** | MIT |
| **Web UI** | Да — flow builder |
| **MCP** | Да — 400+ MCP серверов |
| **Self-hosted** | Да — Docker |

**Дифференциатор:** MIT, 280+ pieces как MCP, TypeScript-based.
**Слабость:** Zapier-альтернатива для бизнес-автоматизации, не для coding.

---

## Часть 4: Single-agent coding tools (не прямые конкуренты)

| Инструмент | Stars | Open Source | Web UI | Multi-Agent | Комментарий |
|---|---|---|---|---|---|
| **Aider** | 34K | Apache 2.0 | Минимальный (browser mode) | Нет | Лучший CLI pair programmer. Git-native |
| **SWE-agent** | 14K | MIT | Нет | Нет | Академический, SoTA бенчмарки. CLI only |
| **bolt.diy** | 15K | MIT* | Да (browser IDE) | Нет | Full-stack в браузере. WebContainers ограничения |
| **Continue.dev** | 26K | Apache 2.0 | Нет (IDE ext) | Нет | VS Code/JetBrains assistant. MCP support |
| **Devon** | 3.5K | AGPL | Нет | Нет | Ранняя стадия, малая популярность |
| **v0.dev** | N/A | Нет | Да | Нет | Vercel SaaS. Prompt-to-React. Закрытый |

---

## Часть 5: Мёртвые/замороженные проекты

| Проект | Stars | Статус | Причина |
|---|---|---|---|
| **AgentGPT** | 32K | ⚠️ Архивирован (янв 2026) | Reworkd сменил фокус. GPT-only, no multi-agent |
| **AutoGen** | 50.4K | ⚠️ Maintenance mode | Мержится с Semantic Kernel. Миграция неизбежна |

---

## Сводная таблица

| Платформа | Stars | Web UI | MCP | Multi-Agent | Self-Host | Open Source | Coding | Workflow Editor |
|---|---|---|---|---|---|---|---|---|
| **n8n** | 177K | ✅ Лучший | ✅ | Скоро | ✅ | SUL | ❌ | ✅ |
| **Langflow** | 130K | ✅ | ✅ | Частично | ✅ | MIT | ❌ | ✅ |
| **Dify** | 119K | ✅ | ✅ | Частично | ✅ | Apache* | ❌ | ✅ |
| **OpenHands** | 64K | ✅ | ✅ | ✅ | ✅ | MIT | ✅ | ❌ |
| **AutoGen** | 50K | ✅ | ✅ | ✅ | ✅ | MIT | ❌ | ❌ (⚠️ maint.) |
| **CrewAI** | 45K | Cloud | ✅ | ✅ | ✅ | MIT | ❌ | Cloud |
| **Flowise** | 43K | ✅ | ? | ✅ | ✅ | MIT | ❌ | ✅ |
| **Aider** | 34K | Мин. | Community | ❌ | ✅ | Apache | ✅ | ❌ |
| **LangGraph** | 26K | ✅ | ✅ | ✅ | Частично | MIT | ❌ | ❌ |
| **Continue** | 26K | ❌ (IDE) | ✅ | ❌ | ✅ | Apache | ✅ | ❌ |
| **Cursor** | N/A | ❌ (IDE) | ✅ | ✅ (8 par.) | ❌ | ❌ | ✅ | ❌ |
| **Windsurf** | N/A | ❌ (IDE) | ✅ | ❌ | Enterprise | ❌ | ✅ | ❌ |

---

## Выводы: наше позиционирование

### Прямых конкурентов НЕТ

Ни одна существующая платформа не совмещает всё это:
- ✅ Self-hosted web UI
- ✅ Фокус на coding-агентах
- ✅ Multi-agent team orchestration
- ✅ Visual workflow editor
- ✅ Task management (Kanban)
- ✅ MCP/Skills поддержка

### Ближайшие конкуренты по отдельным аспектам

```
                    Coding Focus
                         ↑
                         │
           OpenHands ────┤──── Cursor
           (Web UI,      │     (Multi-agent,
            MIT,          │      но closed,
            multi-agent)  │      desktop-only)
                         │
        ─────────────────┼──────────────────→ Workflow Editor
                         │
           CrewAI ───────┤──── Dify / n8n
           (Multi-agent  │     (Workflow,
            framework)   │      Web UI,
                         │      MCP)
                         │
```

### Наш проект = пересечение трёх категорий

1. **OpenHands** → coding agent + Web UI + multi-agent → но нет workflow editor, нет kanban
2. **Dify / n8n** → workflow orchestration + визуальный editor + MCP → но не coding-specific
3. **Claude Code Teams** → native team orchestration → но нет web UI, нет workflow automation

**Уникальная ценность:** "OpenHands для команд с workflow automation" или "Dify/n8n, специализированный на coding-агентах"

### Ключевые дифференциаторы

- Web UI специально для Claude Code teams (не generic builder)
- Визуализация реальных coding sessions (timeline, chunks, tool calls) — уже есть
- Team provisioning и task management (Kanban) — уже есть
- Visual workflow editor для сборки agent pipelines
- Self-hosted с полным контролем данных
- Фокус на наблюдаемость (context tracking, token usage, cost)

Sources:
- [CrewAI](https://crewai.com/) | [GitHub](https://github.com/crewAIInc/crewAI) | [MCP Docs](https://docs.crewai.com/en/mcp/overview)
- [LangGraph](https://www.langchain.com/langgraph) | [GitHub](https://github.com/langchain-ai/langgraph)
- [AutoGen](https://microsoft.github.io/autogen) | [GitHub](https://github.com/microsoft/autogen) | [Merger Discussion](https://github.com/microsoft/autogen/discussions/7066)
- [OpenHands](https://openhands.dev/) | [GitHub](https://github.com/All-Hands-AI/OpenHands) | [SDK Paper](https://arxiv.org/html/2511.03690v1)
- [Dify](https://dify.ai/) | [GitHub](https://github.com/langgenius/dify) | [MCP Blog](https://dify.ai/blog/v1-6-0-built-in-two-way-mcp-support)
- [n8n](https://n8n.io/) | [GitHub](https://github.com/n8n-io/n8n)
- [Langflow](https://www.langflow.org/) | [GitHub](https://github.com/langflow-ai/langflow)
- [Flowise](https://flowiseai.com/) | [GitHub](https://github.com/FlowiseAI/Flowise)
- [Cursor](https://cursor.com/) | [Features](https://cursor.com/features)
- [Windsurf](https://windsurf.com/)
- [Aider](https://aider.chat/) | [GitHub](https://github.com/Aider-AI/aider)
- [bolt.diy](https://github.com/stackblitz-labs/bolt.diy)
- [Continue.dev](https://www.continue.dev/) | [GitHub](https://github.com/continuedev/continue)
- [AgentGPT](https://github.com/reworkd/AgentGPT) (архивирован)
- [Activepieces](https://github.com/activepieces/activepieces)
