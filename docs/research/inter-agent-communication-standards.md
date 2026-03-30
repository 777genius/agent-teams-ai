# Inter-Agent Communication Standards: How Different AI Agents Can Talk to Each Other

**Date:** 2026-03-25
**Status:** Research complete
**Goal:** Determine the best way for AI agents (Claude, Codex, Gemini) to communicate with each other

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Protocol Landscape Overview](#protocol-landscape-overview)
3. [A2A (Agent-to-Agent Protocol)](#1-a2a--agent-to-agent-protocol)
4. [ACP (Agent Communication Protocol) by IBM/BeeAI](#2-acp--agent-communication-protocol-by-ibmbeeai)
5. [Agent Client Protocol (ACP) by Zed](#3-agent-client-protocol-acp-by-zed)
6. [MCP for Inter-Agent Communication](#4-mcp-for-inter-agent-communication)
7. [Agent Network Protocol (ANP)](#5-agent-network-protocol-anp)
8. [MCP Agent Mail](#6-mcp-agent-mail)
9. [File-Based Inbox Pattern](#7-file-based-inbox-pattern-claude-code-agent-teams)
10. [SQLite/Redis Message Bus](#8-sqliteredis-message-bus)
11. [Cross-Provider Orchestration Tools](#9-cross-provider-orchestration-tools)
12. [Comparison Matrix](#comparison-matrix)
13. [Recommendations for Electron App](#recommendations-for-our-electron-app)
14. [Sources](#sources)

---

## Executive Summary

На март 2026 года НЕ существует единого универсального стандарта для межагентной коммуникации между разными провайдерами (Claude, Codex, Gemini). Однако экосистема быстро консолидируется вокруг нескольких протоколов:

| Уровень | Протокол | Назначение |
|---------|----------|------------|
| Tool access | **MCP** (Anthropic) | Агент <-> инструменты/данные |
| Agent-to-Agent | **A2A** (Google/Linux Foundation) | Агент <-> агент (сетевой) |
| Editor-to-Agent | **ACP** (Zed) | Редактор <-> CLI-агент |
| Local coordination | **File-based inbox** (Claude Code) | Агент <-> агент (локальный) |
| Local coordination | **MCP Agent Mail** | Агент <-> агент (MCP + SQLite + Git) |

**Ключевые выводы:**

1. **A2A** -- самый зрелый протокол для agent-to-agent, но он HTTP/server-based и плохо подходит для чисто локального Electron-приложения без встроенного сервера.
2. **File-based inbox** (как в Claude Code Agent Teams) -- самый простой и проверенный паттерн для локальной коммуникации. Работает в Electron без проблем.
3. **MCP Agent Mail** -- наиболее feature-rich локальное решение (идентичности, mailboxes, file leases, searchable threads), но Python-based.
4. **MCP** сам по себе эволюционирует в сторону inter-agent communication (AWS, Microsoft активно контрибьютят).
5. **OpenCode** -- единственный инструмент, который реально запускает Claude + Codex + Gemini в одной команде через unified inbox pattern.

---

## Protocol Landscape Overview

```
                    ┌─────────────────────────────────────┐
                    │         Agent Network Protocol       │
                    │    (ANP - open internet, P2P, DID)   │
                    └──────────────────┬──────────────────┘
                                       │
                    ┌──────────────────┴──────────────────┐
                    │    Agent-to-Agent Protocol (A2A)     │
                    │  (Google/LF, HTTP, JSON-RPC, tasks)  │
                    └──────────────────┬──────────────────┘
                                       │
          ┌────────────────────────────┼────────────────────────────┐
          │                            │                            │
┌─────────┴─────────┐   ┌─────────────┴─────────────┐   ┌─────────┴─────────┐
│   MCP (Anthropic)  │   │  Agent Client Protocol    │   │  File-based inbox  │
│ Agent <-> Tools    │   │  (Zed, editor <-> agent)  │   │ (Claude Code local)│
└───────────────────┘   └───────────────────────────┘   └───────────────────┘
```

---

## 1. A2A -- Agent-to-Agent Protocol

**Создатель:** Google, теперь под Linux Foundation
**Статус:** v0.3.0 (Draft v1.0), 150+ организаций-участников
**GitHub:** [a2aproject/A2A](https://github.com/a2aproject/A2A) -- 500+ stars (JS SDK)

### Как работает

1. Каждый агент публикует **Agent Card** (JSON) по адресу `/.well-known/agent.json` -- имя, навыки, endpoint, auth
2. Клиент-агент отправляет **задачу** серверу-агенту через JSON-RPC 2.0 over HTTPS
3. Задача проходит жизненный цикл: `submitted` -> `working` -> `completed`/`canceled`
4. Поддерживается streaming через SSE (Server-Sent Events)
5. Результат задачи -- **артефакт** (текст, изображения, файлы)

### TypeScript SDK

```bash
npm install @a2a-js/sdk
# Для Express-интеграции:
npm install express
```

Пакет: [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk) v0.3.10
- 88 зависимых проектов на npm
- Поддержка Express, gRPC, in-memory task store
- Полные типы TypeScript

**Минимальный сервер (Express):**
```typescript
import { AgentCard, AgentExecutor, DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk';
import { agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express';
import express from 'express';

const card: AgentCard = {
  name: 'MyAgent',
  description: 'Example agent',
  protocolVersion: '0.3.0',
  url: 'http://localhost:4000/a2a/jsonrpc',
  skills: [{ id: 'hello', name: 'Hello', description: 'Says hello' }],
  capabilities: {},
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
};

class MyExecutor implements AgentExecutor {
  async execute(context) {
    context.eventBus.publish({ type: 'message', message: { role: 'agent', parts: [{ type: 'text', text: 'Hello!' }] } });
    context.eventBus.finished();
  }
}

const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new MyExecutor());
const app = express();
app.get('/a2a/agent-card', agentCardHandler(handler));
app.post('/a2a/jsonrpc', jsonRpcHandler(handler));
app.listen(4000);
```

### Оценка для Electron

| Критерий | Оценка |
|----------|--------|
| Зрелость протокола | 8/10 -- v0.3, Linux Foundation, 150+ организаций |
| TypeScript поддержка | 9/10 -- официальный SDK, полные типы |
| Electron-совместимость | 5/10 -- требует HTTP-сервер, придётся встраивать Express в main process |
| Локальная работа | 4/10 -- спроектирован для сетевого взаимодействия, localhost возможен но overhead |
| Кросс-провайдер | 9/10 -- протокол-агностик по дизайну |

### Вердикт

A2A -- правильный протокол для **распределённых сетевых** мультиагентных систем. Для локального Electron-приложения это overkill, но если планируется поддержка **удалённых агентов** в будущем -- имеет смысл держать в архитектуре.

---

## 2. ACP -- Agent Communication Protocol by IBM/BeeAI

**Создатель:** IBM Research / BeeAI
**Статус:** MERGED WITH A2A под Linux Foundation. Активная разработка свёрнута.
**GitHub:** [i-am-bee/acp](https://github.com/i-am-bee/acp)

### Как работает

- REST-native (не JSON-RPC как A2A) -- стандартные HTTP-конвенции
- Не требует SDK -- можно использовать через curl/Postman
- Async по умолчанию (fire-and-forget с taskId, poll/subscribe для прогресса)
- Sync также поддерживается (простой HTTP POST)
- Offline discovery -- метаданные агента встроены в пакет распространения

### TypeScript SDK

```bash
npm install @anthropic-ai/beeai-framework  # TypeScript starter
```

BeeAI Framework предоставляет TypeScript-клиент для ACP.

### Оценка для Electron

| Критерий | Оценка |
|----------|--------|
| Зрелость | 3/10 -- merged into A2A, активная разработка прекращена |
| TypeScript | 6/10 -- клиентский SDK есть |
| Electron | 5/10 -- REST-based, аналогично A2A |
| Рекомендация | НЕ использовать, мигрировать на A2A |

### Вердикт

**Устаревший.** Объединён с A2A. Использовать только если уже есть код на ACP -- в таком случае мигрировать на A2A.

---

## 3. Agent Client Protocol (ACP) by Zed

**ВНИМАНИЕ:** Это ДРУГОЙ протокол с тем же акронимом ACP. Не путать с IBM ACP.

**Создатель:** Zed Industries
**Статус:** Активный, ACP Registry запущен (2026)
**GitHub:** [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol)
**Сайт:** [agentclientprotocol.com](https://agentclientprotocol.com/)

### Как работает

- Стандартизирует связь **редактор <-> CLI-агент** (аналогично LSP для языковых серверов)
- JSON-RPC over stdio (локальные агенты как subprocess)
- JSON-RPC over HTTP/WebSocket (удалённые агенты)
- Переиспользует JSON-представления из MCP где возможно
- Добавляет UX-специфичные типы (diff display, file edits)

### Поддерживаемые агенты и редакторы

**Агенты:**
- Claude Code (через Zed SDK adapter)
- Codex CLI
- Gemini CLI (reference implementation)
- OpenCode
- Goose (Block/Square)
- GitHub Copilot CLI
- Kiro CLI

**Редакторы:**
- Zed (нативная поддержка)
- JetBrains IDEs (скоро)
- Neovim (CodeCompanion, avante.nvim)
- Emacs (agent-shell)
- VS Code (расширение ACP Client)

### Оценка для Electron

| Критерий | Оценка |
|----------|--------|
| Зрелость | 7/10 -- активный, registry, множество интеграций |
| TypeScript | 7/10 -- JSON-RPC, спецификация есть |
| Electron | 8/10 -- stdio-based отлично работает с child_process |
| Назначение | Editor <-> Agent, НЕ agent <-> agent |

### Вердикт

ACP (Zed) -- **идеален для связи нашего Electron UI с CLI-агентами**. Но это протокол editor<->agent, не agent<->agent. Для межагентной коммуникации нужен другой протокол поверх.

---

## 4. MCP для Inter-Agent Communication

**Создатель:** Anthropic
**Статус:** Активно развивается в сторону agent-to-agent (2026 roadmap)

### Как это работает для inter-agent

MCP изначально создан для tool integration, но его архитектура позволяет agent-to-agent:

1. **Агент A запускает MCP-сервер**, объявляя свои capabilities как tools
2. **Агент B подключается как MCP-клиент** и вызывает tools агента A
3. Streaming через SSE для real-time обновлений
4. Session resumability для долгих задач
5. Multi-turn interactions через elicitation

### Паттерн "Agent as MCP Server"

```
Agent A (MCP Client) ──────► Agent B (MCP Server)
         │                          │
         │  call tool "analyze"     │
         ├─────────────────────────►│
         │                          │ runs analysis
         │  streaming results       │
         │◄─────────────────────────┤
```

### Кто продвигает

- **AWS** активно контрибьютит в inter-agent MCP, работает с LangGraph, CrewAI, LlamaIndex
- **Microsoft** показала, что A2A-коммуникацию можно построить на MCP
- **Block (Square)** -- 1000+ инженеров используют MCP-координацию (Goose)

### TypeScript SDK

```bash
npm install @modelcontextprotocol/sdk zod
```

Официальный SDK: [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)

### Оценка для Electron

| Критерий | Оценка |
|----------|--------|
| Зрелость для inter-agent | 5/10 -- изначально не для этого, но быстро эволюционирует |
| TypeScript | 10/10 -- официальный SDK, отличная поддержка |
| Electron | 9/10 -- stdio transport, уже используется в нашем приложении |
| Кросс-провайдер | 8/10 -- все провайдеры поддерживают MCP |

### Вердикт

MCP -- **наиболее практичный выбор** для нашего Electron-приложения. Мы уже используем MCP. Паттерн "agent as MCP server" позволяет любому агенту объявить tools/resources, а другой агент подключается как клиент. Roadmap 2026 явно включает agent-to-agent capabilities.

---

## 5. Agent Network Protocol (ANP)

**Создатель:** Open-source community
**Статус:** Draft, white paper на arXiv
**GitHub:** [agent-network-protocol/AgentNetworkProtocol](https://github.com/agent-network-protocol/AgentNetworkProtocol)
**Сайт:** [agent-network-protocol.com](https://agent-network-protocol.com/)

### Как работает

Трёхуровневая архитектура:
1. **Identity & Encrypted Communication** -- W3C DID (Decentralized Identifiers), end-to-end encryption
2. **Meta-Protocol Layer** -- агенты САМИ договариваются о протоколе коммуникации
3. **Application Protocol** -- JSON-LD для описания capabilities

Позиционирование: "HTTP для агентного интернета". Peer-to-peer, без центральных серверов.

### Оценка для Electron

| Критерий | Оценка |
|----------|--------|
| Зрелость | 2/10 -- draft, ранняя стадия |
| TypeScript | 2/10 -- нет SDK |
| Electron | 3/10 -- P2P, сложная интеграция |
| Рекомендация | Следить, НЕ использовать сейчас |

### Вердикт

ANP -- интересная vision для **открытого агентного интернета** (peer-to-peer discovery, DID), но слишком рано для продакшна. Может стать актуален через 1-2 года.

---

## 6. MCP Agent Mail

**Создатель:** Jeff Emanuel (Dicklesworthstone)
**Статус:** Активный, первый open-source agent coordination tool (октябрь 2025)
**GitHub:** [Dicklesworthstone/mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)
**Rust version:** [Dicklesworthstone/mcp_agent_mail_rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust)
**Сайт:** [mcpagentmail.com](https://mcpagentmail.com/)

### Как работает

- MCP-сервер, предоставляющий **34 tool** для координации агентов
- Каждый агент получает **идентичность** (memorable name: GreenCastle, BlueLake)
- **Inbox/Outbox** -- асинхронные mailbox для сообщений
- **Advisory File Reservations** -- агенты объявляют file leases (exclusive/shared) на globs
- **Searchable threads** -- FTS через SQLite
- **Git backing** -- все сообщения и артефакты в Git для аудита
- SQLite для индексации, Git как source of truth

### Cross-Provider Support

Работает с Claude Code, Codex, Gemini CLI, Factory Droid -- любой MCP-совместимый клиент.

### Технические детали

- Python-based сервер (FastMCP)
- Rust-реимплементация доступна (127.0.0.1:8765, TUI console)
- Не npm-пакет, установка через bash-скрипт
- Local-first, no cloud dependencies

### Оценка для Electron

| Критерий | Оценка |
|----------|--------|
| Зрелость | 7/10 -- production-used, хорошо документирован |
| TypeScript | 3/10 -- Python/Rust server, TS клиент через MCP SDK |
| Electron | 6/10 -- можно запустить как sidecar process, но Python/Rust зависимость |
| Feature-richness | 9/10 -- identities, mailboxes, file leases, FTS, Git audit |

### Вердикт

Самое feature-rich решение для координации агентов. **Проблема**: Python/Rust dependency. Для нашего Electron-приложения можно:
- Запустить как sidecar process
- Или реализовать ключевые идеи (mailbox, file leases) на TypeScript нативно

---

## 7. File-Based Inbox Pattern (Claude Code Agent Teams)

**Создатель:** Anthropic (Claude Code)
**Статус:** Production, Claude Code v2.1.32+

### Как работает

Наиболее простой и проверенный паттерн:

```
~/.claude/teams/{team-name}/
├── config.json                    # member registry
└── inboxes/
    ├── lead.json                  # lead's inbox
    ├── frontend-dev.json          # teammate inbox
    └── backend-dev.json           # teammate inbox
```

1. Отправитель **appends** JSON-объект в inbox-файл получателя
2. Получатель **polls** свой inbox-файл между turns
3. Формат сообщения: `{ from, text, timestamp, read }`
4. Broadcast = запись одного сообщения во ВСЕ inbox-файлы

### Особенности

- Zero dependencies -- только fs
- Inspectable -- `cat` любой inbox файл в реальном времени
- File I/O масштабируется для 3-5 агентов
- Нет real-time delivery -- получатель увидит сообщение только после текущего turn
- Ownership: каждый агент читает только СВОЙ inbox

### Inbox/Outbox Pattern (улучшенный)

```
agent-a/
├── inbox.json       # входящие сообщения
├── outbox.json      # исходящие (для аудита)
└── current-task.json

agent-b/
├── inbox.json
├── outbox.json
└── current-task.json
```

Правила координации:
- Агент пишет ТОЛЬКО в свой outbox и чужие inbox
- Агент читает ТОЛЬКО свой inbox и current-task
- Boot Sequence: при старте читать inbox.json, resume из current-task.json

### Оценка для Electron

| Критерий | Оценка |
|----------|--------|
| Зрелость | 9/10 -- production в Claude Code |
| TypeScript | 10/10 -- чистый fs/path, тривиальная реализация |
| Electron | 10/10 -- идеально, никаких зависимостей |
| Масштабируемость | 5/10 -- до ~10 агентов, потом I/O bottleneck |
| Feature-richness | 4/10 -- только messaging, нет identities/leases/FTS |

### Вердикт

**Лучший выбор для немедленного использования.** Мы УЖЕ используем этот паттерн в нашем приложении. Для межагентной коммуникации между разными провайдерами -- это самый простой путь: агенты любого провайдера пишут/читают JSON-файлы.

---

## 8. SQLite/Redis Message Bus

### SQLite Message Bus

Паттерн из сообщества: Flask + SQLite message bus для ~16 агентов.

**Особенности:**
- HTTP API для отправки/получения сообщений
- Broadcast messaging (omit "to" field)
- Reply chains через `reply_to`
- Priority levels (normal/high/urgent)
- Read receipts
- `journal_mode=WAL` для конкурентного доступа
- Auto-archiving старых сообщений

### Redis Approaches

| Подход | Плюсы | Минусы |
|--------|-------|--------|
| Redis Pub/Sub | Real-time, low latency | Ephemeral -- сообщения теряются |
| Redis Streams | Persistent, consumer groups | Требует Redis server |
| redis-bus | Autodiscovery, cache | Legacy (Python 2.7) |

### Оценка для Electron

| Критерий | Оценка |
|----------|--------|
| SQLite bus | 7/10 -- хорошо для Electron (better-sqlite3 уже есть) |
| Redis | 3/10 -- требует отдельный server, overkill для desktop |
| TypeScript | 8/10 (SQLite) / 6/10 (Redis) |
| Масштабируемость | 8/10 (SQLite WAL) / 9/10 (Redis) |

### Вердикт

**SQLite message bus** -- отличный апгрейд с file-based inbox, если нужна persistence, FTS, priority, read receipts. `better-sqlite3` уже хорошо работает в Electron. Redis -- overkill для локального desktop-приложения.

---

## 9. Cross-Provider Orchestration Tools

### OpenCode -- True Multi-Model Agent Teams

OpenCode -- единственный инструмент, который **реально запускает Claude + Codex + Gemini в одной команде**.

**Архитектура:**
- Event-driven inbox (не polling как Claude Code)
- Per-agent JSONL файлы: `{ id, from, text, timestamp, read }`
- Session injection для delivery (не file polling)
- Shared task list с claiming

**Отличия от Claude Code:**
- Multi-model support (Claude, GPT, Gemini в одной команде)
- Peer-to-peer messaging (не только через lead)
- Event-driven (не polling)
- Append-only JSONL (не JSON array)
- Всё in-process (locks в памяти)

### sub-agents-skills

GitHub: [shinpr/sub-agents-skills](https://github.com/shinpr/sub-agents-skills)

Позволяет использовать Codex, Claude Code, Gemini CLI как sub-agents из любого parent session. Cross-LLM делегация задач.

### ZenFlow (Zencoder)

Structured handoffs между Claude и Gemini с quality gates. Не open-source.

### CC Switch

Unified management: proxy Claude/Codex/Gemini, unified MCP panel, markdown editor с cross-app sync для CLAUDE.md/AGENTS.md/GEMINI.md.

---

## Comparison Matrix

| | A2A | MCP (inter-agent) | ACP (Zed) | File Inbox | MCP Agent Mail | SQLite Bus |
|---|---|---|---|---|---|---|
| **Зрелость** | 8/10 | 5/10 | 7/10 | 9/10 | 7/10 | 6/10 |
| **TS SDK** | 9/10 | 10/10 | 7/10 | 10/10 | 3/10 | 8/10 |
| **Electron-ready** | 5/10 | 9/10 | 8/10 | 10/10 | 6/10 | 7/10 |
| **Cross-provider** | 9/10 | 8/10 | 9/10 | 10/10 | 9/10 | 10/10 |
| **No server needed** | No | Partial | Yes (stdio) | Yes | No | Yes |
| **Real-time** | Yes (SSE) | Yes (SSE) | Yes | No (polling) | No | Polling |
| **Persistence** | Optional | No | No | File-based | Git+SQLite | SQLite |
| **File coordination** | No | No | No | No | Yes (leases) | No |
| **Identity system** | Agent Cards | No | No | No | Yes | No |
| **Сложность** | High | Medium | Medium | Very Low | High | Low |

---

## Recommendations for Our Electron App

### Немедленно (Phase 1) -- File-Based Inbox

**Надёжность: 9/10 | Уверенность: 10/10**

Мы уже используем file-based inbox для Claude Code Agent Teams. Этот же паттерн работает для ЛЮБОГО CLI-агента (Codex, Gemini CLI). Агенту не нужно знать протокол -- он просто читает/пишет JSON-файлы.

```
~/.claude_teams/{team-name}/inboxes/
├── claude-lead.json
├── codex-worker.json
├── gemini-researcher.json
```

**Что нужно для cross-provider:**
1. Unified inbox format (уже есть: `{ from, text, timestamp, read }`)
2. Agent spawner для каждого CLI (Claude Code, Codex CLI, Gemini CLI)
3. Каждый агент получает system prompt с инструкцией читать/писать inbox files
4. Task board (shared JSON files с flock)

### Среднесрочно (Phase 2) -- SQLite Message Bus

**Надёжность: 8/10 | Уверенность: 8/10**

Upgrade с file-based на SQLite для:
- Persistence и searchable history
- Priority levels и read receipts
- Better concurrency (WAL mode)
- FTS для поиска по сообщениям

`better-sqlite3` уже отлично работает в Electron.

### Долгосрочно (Phase 3) -- MCP-Based Inter-Agent

**Надёжность: 6/10 | Уверенность: 6/10**

Когда MCP roadmap 2026 реализует agent-to-agent capabilities:
- Каждый агент запускает MCP-сервер со своими capabilities
- Другие агенты подключаются как MCP-клиенты
- Streaming, session management, tool negotiation из коробки
- @modelcontextprotocol/sdk уже в нашем стеке

### Если потребуются удалённые агенты (Phase 4) -- A2A

**Надёжность: 7/10 | Уверенность: 5/10**

A2A имеет смысл только если:
- Нужна коммуникация с агентами на других машинах
- Интеграция с enterprise-системами (Salesforce, SAP агенты)
- Cloud-hosted агенты

В этом случае: встроить Express-сервер в Electron main process, использовать @a2a-js/sdk.

### Конкретный ответ на вопрос: "Как заставить Claude поговорить с Codex?"

**Самый простой работающий способ прямо сейчас:**

1. Spawn Claude Code CLI как child_process
2. Spawn Codex CLI как child_process
3. Оба читают/пишут в общую директорию inbox-файлов
4. System prompt для каждого включает инструкцию: "To communicate with other agents, write to their inbox file at {path}"
5. Наше Electron-приложение выступает оркестратором: следит за inbox-файлами, доставляет сообщения через stdin, обновляет UI

Это РОВНО то, что делает Claude Code Agent Teams, и ровно то, что OpenCode расширил для multi-provider.

---

## Sources

### Протоколы и спецификации
- [A2A Protocol Official Site](https://a2a-protocol.org/latest/)
- [A2A GitHub Repository](https://github.com/a2aproject/A2A)
- [A2A JS SDK](https://github.com/a2aproject/a2a-js) -- [@a2a-js/sdk npm](https://www.npmjs.com/package/@a2a-js/sdk)
- [Agent Client Protocol (Zed)](https://agentclientprotocol.com/) -- [GitHub](https://github.com/agentclientprotocol/agent-client-protocol)
- [ACP Registry](https://zed.dev/blog/acp-registry)
- [Agent Communication Protocol (IBM/BeeAI)](https://github.com/i-am-bee/acp) -- [IBM Research](https://research.ibm.com/projects/agent-communication-protocol)
- [Agent Network Protocol](https://agent-network-protocol.com/) -- [GitHub](https://github.com/agent-network-protocol/AgentNetworkProtocol)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

### Анонсы и статьи
- [Google: Announcing A2A](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [Google Cloud: A2A Getting an Upgrade](https://cloud.google.com/blog/products/ai-machine-learning/agent2agent-protocol-is-getting-an-upgrade)
- [Linux Foundation: A2A Project Launch](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)
- [IBM: What is A2A?](https://www.ibm.com/think/topics/agent2agent-protocol)
- [IBM: What is ACP?](https://www.ibm.com/think/topics/agent-communication-protocol)
- [AWS: Inter-Agent Communication on MCP](https://aws.amazon.com/blogs/opensource/open-protocols-for-agent-interoperability-part-1-inter-agent-communication-on-mcp/)
- [Microsoft: A2A on MCP](https://developer.microsoft.com/blog/can-you-build-agent2agent-communication-on-mcp-yes)
- [Auth0: MCP vs A2A](https://auth0.com/blog/mcp-vs-a2a/)
- [Developer's Guide to AI Agent Protocols](https://developers.googleblog.com/developers-guide-to-ai-agent-protocols/)

### Claude Code Agent Teams
- [Official Docs](https://code.claude.com/docs/en/agent-teams)
- [Reverse-Engineering Claude Code Agent Teams](https://dev.to/nwyin/reverse-engineering-claude-code-agent-teams-architecture-and-protocol-o49)
- [How They Work Under the Hood](https://www.claudecodecamp.com/p/claude-code-agent-teams-how-they-work-under-the-hood)

### Cross-Provider Orchestration
- [OpenCode Agent Teams](https://dev.to/uenyioha/porting-claude-codes-agent-teams-to-opencode-4hol)
- [sub-agents-skills](https://github.com/shinpr/sub-agents-skills)
- [ZenFlow Multi-Agent Orchestration](https://docs.zencoder.ai/user-guides/guides/multi-agent-orchestration-in-zenflow)
- [Zed: External Agents](https://zed.dev/docs/ai/external-agents)

### Agent Coordination
- [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) -- [Site](https://mcpagentmail.com/)
- [MCP Agent Mail Rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust)
- [Inbox/Outbox Pattern](https://earezki.com/ai-news/2026-03-09-the-inbox-outbox-pattern-how-ai-agents-coordinate-without-stepping-on-each-other/)
- [Multi-Agent Communication Patterns](https://dev.to/aureus_c_b3ba7f87cc34d74d49/multi-agent-communication-patterns-that-actually-work-50kp)
- [Agent Message Bus (SQLite)](https://dev.to/linou518/agent-message-bus-communication-infrastructure-for-16-ai-agents-18af)

### Google ADK
- [ADK with A2A](https://google.github.io/adk-docs/a2a/)
- [ADK Docs](https://google.github.io/adk-docs/agents/models/google-gemini/)

### Surveys
- [Survey of Agent Interoperability Protocols (arXiv)](https://arxiv.org/abs/2505.02279)
- [Top 5 Open Protocols for Multi-Agent AI Systems](https://onereach.ai/blog/power-of-multi-agent-ai-open-protocols/)
- [10 Modern AI Agent Protocols](https://www.ssonetwork.com/intelligent-automation/columns/ai-agent-protocols-10-modern-standards-shaping-the-agentic-era)
