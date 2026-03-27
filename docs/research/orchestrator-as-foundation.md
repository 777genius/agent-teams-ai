# Оценка: внешний оркестратор как фундамент вместо собственного agent management

**Дата**: 2026-03-25
**Вопрос**: стоит ли взять готовый multi-agent оркестратор и посадить наш Electron UI сверху, вместо того чтобы развивать собственный TeamProvisioningService?

---

## 1. Что мы бы заменяли (наш текущий стек)

### Собственная инфраструктура

| Компонент | Файлы | LOC | Что делает |
|-----------|-------|-----|------------|
| `TeamProvisioningService.ts` | 1 | ~8000 | Полный lifecycle команды: создание, запуск, stream-json протокол, preflight, stdin relay, tool approval, stall detection, cross-team messaging |
| `agent-teams-controller/` | ~20 модулей | ~4050 | Kanban store, task management, review workflow, cross-team protocol, runtime helpers, message store, process store |
| Остальные team сервисы | 38 файлов | ~13200 | TeamConfigReader, TeamInboxReader/Writer, TeamTaskReader/Writer, TeamKanbanManager, TeamMcpConfigBuilder, CascadeGuard, CrossTeamService, ReviewApplier, MemberStatsComputer, TeamBackupService и др. |
| `childProcess.ts` | 1 | ~220 | spawnCli/execCli с Windows fallback, process tree kill |
| MCP server tools | 8 файлов | ~500 | taskTools, kanbanTools, reviewTools, messageTools, processTools, runtimeTools, crossTeamTools |
| **ИТОГО** | ~68 файлов | **~26000 LOC** | |

### Ключевые точки spawn (spawnCli вызовы)

- `TeamProvisioningService.ts` — 4 точки: create team, launch team, launch member, DM relay
- `CliInstallerService.ts` — install CLI
- `ScheduledTaskExecutor.ts` — scheduled tasks
- `McpHealthDiagnosticsService.ts`, `PluginInstallService.ts`, `McpInstallService.ts` — execCli для MCP/plugin операций

### Что уникально в нашей реализации

1. **stream-json протокол** — двусторонний, lead читает stdin, teammates читают inbox
2. **Tool approval system** — перехват tool_use запросов, auto-approve по правилам, UI промпт
3. **Cross-team communication** — structured TaskRef, inbox files, cross-team MCP tools
4. **Kanban + code review** — 5-column board, diff view, approve/request_changes workflow
5. **MCP config builder** — передача `--mcp-config` с наследованием для teammates
6. **SIGKILL-only kill** — предотвращение cleanup CLI, который удаляет team файлы
7. **Context monitoring** — token usage tracking по категориям

---

## 2. Оценка кандидатов

### 2.1 MCO (mco-org/mco)

**GitHub**: https://github.com/mco-org/mco
**Stars**: ~249 | **Лицензия**: MIT | **Язык**: TypeScript (CLI)
**npm**: `@tt-a1i/mco`

| Критерий | Оценка |
|----------|--------|
| Используется как библиотека? | **НЕТ** — только CLI. Нет programmatic API для import. |
| Inter-agent communication? | Частично — агенты диспатчат задачи через MCO CLI, но нет inbox/messaging системы |
| MCP поддержка? | Да — может работать как MCP server |
| Что бы мы СОХРАНИЛИ? | Всё UI, kanban, review, context tracking |
| Что бы мы ЗАМЕНИЛИ? | Только dispatch логику (4 spawnCli точки), и то частично |
| Effort интеграции | **Высокий** — MCO не даёт API, пришлось бы обёртывать CLI вызовы |
| Риск зависимости | **Средний** — 249 stars, 1 основной автор |

**Вердикт**: MCO решает другую задачу (dispatch к разным CLI), а не управление командой. У нас уже есть более продвинутая система.
- Надёжность решения: **3/10**
- Уверенность в оценке: **8/10**

---

### 2.2 Overstory (jayminwest/overstory)

**GitHub**: https://github.com/jayminwest/overstory
**Stars**: ~1100 | **Лицензия**: MIT | **Язык**: TypeScript (Bun-native)
**npm**: `@os-eco/overstory-cli`

| Критерий | Оценка |
|----------|--------|
| Используется как библиотека? | Частично — есть pluggable AgentRuntime интерфейс, но **ТРЕБУЕТ BUN** (не Node.js/Electron) |
| Inter-agent communication? | **Да** — SQLite mail system, 8 типов сообщений, WAL mode, broadcast |
| MCP поддержка? | Упоминается, но без деталей |
| Зависимости | **Bun v1.0+, tmux, git** — все три обязательны |
| Что бы мы СОХРАНИЛИ? | UI, kanban, review, context tracking, MCP server |
| Что бы мы ЗАМЕНИЛИ? | TeamProvisioningService, inbox system, process management |
| Effort интеграции | **КРИТИЧЕСКИЙ** — Bun runtime несовместим с Electron (Node.js). Потребуется форк или полный переписывание на Node.js |
| Риск зависимости | **Высокий** — 1 автор, Bun lock-in, tmux dependency |

**Вердикт**: Архитектурно интересен (SQLite mail, pluggable runtimes, watchdog), но **Bun dependency — dealbreaker** для Electron-приложения. tmux dependency тоже проблема (нет на Windows).
- Надёжность решения: **2/10**
- Уверенность в оценке: **9/10**

---

### 2.3 ComposioHQ/agent-orchestrator

**GitHub**: https://github.com/ComposioHQ/agent-orchestrator
**Stars**: ~5400 | **Лицензия**: MIT | **Язык**: TypeScript (pnpm monorepo)
**npm**: `@composio/ao` (CLI)

| Критерий | Оценка |
|----------|--------|
| Используется как библиотека? | **Условно** — monorepo с packages, но core не опубликован как отдельный npm пакет `@composio/ao-core`. Нет документации по programmatic API. |
| Inter-agent communication? | **Нет прямой** — агенты изолированы в worktrees, координация через dashboard/server |
| MCP поддержка? | Не упоминается |
| Зависимости | tmux, Next.js dashboard (порт 3000) |
| Plugin architecture | **Сильная** — 8 swappable slots (Runtime, Agent, Workspace, Tracker, SCM, Notifier, Terminal, Lifecycle) |
| Что бы мы СОХРАНИЛИ? | Kanban UI, review, context tracking, cross-team messaging, MCP tools |
| Что бы мы ЗАМЕНИЛИ? | Process spawning, workspace isolation |
| Effort интеграции | **Высокий** — нет published API, потребуется fork monorepo, вырезание Next.js dashboard, адаптация под Electron IPC |
| Риск зависимости | **Средний** — 5.4K stars, Composio (коммерческая компания) за спиной, но agent-orchestrator =/= их core business |

**Вердикт**: Самый продвинутый из кандидатов. Plugin architecture — то что нужно. НО: нет published programmatic API, нет inter-agent messaging (мы это уже имеем), требует tmux, и dashboard на Next.js конфликтует с нашим Electron. Интеграция = фактически форк.
- Надёжность решения: **4/10**
- Уверенность в оценке: **8/10**

---

### 2.4 MetaSwarm (dsifry/metaswarm)

**GitHub**: https://github.com/dsifry/metaswarm
**Stars**: ~148 | **Лицензия**: MIT | **Язык**: TypeScript/JS (skills + commands)
**npm**: `metaswarm` (npx installer)

| Критерий | Оценка |
|----------|--------|
| Используется как библиотека? | **НЕТ** — это framework из skills/commands/hooks, инжектируемый в CLAUDE.md. Не importable. |
| Inter-agent communication? | Через Claude Code Team Mode (нативный) |
| MCP поддержка? | Нет собственной — использует нативный Claude Code |
| Что бы мы ЗАМЕНИЛИ? | Ничего — это workflow methodology, не runtime |
| Effort интеграции | **Неприменимо** — это не backend, это набор CLAUDE.md инструкций и скриптов |
| Риск зависимости | **Высокий** — 148 stars, 2 контрибьютора, последний коммит feb 2026 |

**Вердикт**: MetaSwarm — это не оркестратор в техническом смысле. Это structured workflow (skills, personas, phases), который инжектируется в prompt. Не подходит как backend.
- Надёжность решения: **1/10**
- Уверенность в оценке: **9/10**

---

### 2.5 ORCH (oxgeneral/ORCH)

**GitHub**: https://github.com/oxgeneral/ORCH (404 на момент проверки, возможно приватный)
**Website**: https://www.orch.one
**Stars**: Неизвестно | **Лицензия**: MIT | **Язык**: TypeScript
**npm**: `@oxgeneral/orch` (GitHub Packages registry)

| Критерий | Оценка |
|----------|--------|
| Используется как библиотека? | **НЕТ** — CLI-only (`npm i -g @oxgeneral/orch`). Нет programmatic API. |
| Inter-agent communication? | **Да** — direct messaging + broadcast + shared key-value store |
| MCP поддержка? | Не упоминается |
| State machine | task states: todo → in_progress → review → done |
| Зависимости | git worktrees, TUI (терминал) |
| Что бы мы ЗАМЕНИЛИ? | Process management, state machine, messaging |
| Effort интеграции | **Высокий** — CLI-only, GitHub Packages registry (не стандартный npm), GitHub 404 |
| Риск зависимости | **КРИТИЧЕСКИЙ** — GitHub repo недоступен (404), 1 автор |

**Вердикт**: Архитектурно интересен (DDD, state machine, 987 тестов), но **GitHub repo 404** — красный флаг. CLI-only без programmatic API. Нельзя рассматривать как зависимость.
- Надёжность решения: **1/10**
- Уверенность в оценке: **7/10** (7 потому что repo недоступен, не можем полноценно проверить)

---

### 2.6 conductor-oss (charannyk06/conductor-oss)

**GitHub**: https://github.com/charannyk06/conductor-oss
**Stars**: ~14 | **Лицензия**: MIT | **Язык**: Rust (backend) + TypeScript (Next.js frontend)
**Adapters**: 10 (Claude Code, Codex, Gemini, Qwen, Amp, Cursor CLI, OpenCode, Droid, Copilot, CCR)

| Критерий | Оценка |
|----------|--------|
| Используется как библиотека? | **Частично** — Rust binary + HTTP API (port 4747). Можно использовать API. |
| Inter-agent communication? | Через orchestrator server |
| MCP поддержка? | **Да** — `mcp-server` команда, stdio transport |
| Dashboard | Next.js (порт 3000) — конфликт с нашим Electron |
| Что бы мы ЗАМЕНИЛИ? | Agent spawning, workspace isolation, adapter layer |
| Что бы мы СОХРАНИЛИ? | Всё UI, kanban, review, messaging, context tracking |
| Effort интеграции | **Средний-Высокий** — HTTP API есть, но Rust binary нужно распространять с Electron, Next.js dashboard лишний |
| Риск зависимости | **КРИТИЧЕСКИЙ** — 14 stars, 1 автор, Rust dependency в TypeScript/Electron проекте |

**Вердикт**: HTTP API делает интеграцию возможной, 10 адаптеров впечатляют. НО: 14 stars, Rust sidecar binary для Electron — серьёзная сложность в packaging и distribution. Проект слишком молодой.
- Надёжность решения: **2/10**
- Уверенность в оценке: **8/10**

---

## 3. Сводная таблица

| Оркестратор | Stars | Library? | Inter-agent msg | MCP | Electron-совместим | Effort | Риск |
|-------------|-------|----------|-----------------|-----|-------------------|--------|------|
| **MCO** | 249 | CLI only | Partial | Yes | Partial | High | Medium |
| **Overstory** | 1.1K | Bun only | SQLite mail | Partial | **NO (Bun)** | Critical | High |
| **Composio AO** | 5.4K | No published API | No direct | No | Partial (tmux) | High | Medium |
| **MetaSwarm** | 148 | No (skills) | Native CC | No | N/A | N/A | High |
| **ORCH** | ? | CLI only | Yes | No | No (TUI) | High | **Critical** |
| **conductor-oss** | 14 | HTTP API | Via server | Yes | Partial (Rust) | Medium-High | **Critical** |

---

## 4. Что конкретно нам дал бы внешний оркестратор

### Потенциальная ценность
1. **Multi-runtime support** — запуск не только Claude Code, но и Codex, Gemini, Aider
2. **Git worktree isolation** — у нас нет, но и не нужен (Claude Code сам управляет файлами)
3. **Adapters pattern** — абстракция спавна разных CLI

### Что мы УЖЕ имеем и ни один оркестратор не даёт
1. **stream-json bidirectional protocol** — уникальная интеграция с Claude Code Agent Teams
2. **Tool approval UI** — перехват и approve/reject tool calls в реальном времени
3. **Cross-team structured messaging** — TaskRef, zero-width metadata encoding
4. **Kanban с code review** — diff view, approve/request_changes per task
5. **Context monitoring** — 6-category token tracking
6. **MCP server with 7 tool groups** — kanban, tasks, review, messages, processes, runtime, cross-team
7. **Post-compact context recovery** — восстановление инструкций после compaction
8. **SIGKILL team kill protocol** — предотвращение file cleanup
9. **Cascading guard** — предотвращение cascade team deletion

---

## 5. Ключевой вопрос: стоит ли зависеть от внешнего оркестратора?

### Аргументы ЗА интеграцию
- Multi-runtime support (Codex, Gemini, Aider) без написания адаптеров
- Потенциально меньше кода для поддержки
- Community contributions и bug fixes

### Аргументы ПРОТИВ (перевешивают)

1. **Ни один оркестратор не имеет programmatic library API для embedding в Electron**
   - Все либо CLI-only, либо CLI + собственный dashboard
   - Интеграция = обёртка над CLI вызовами или fork — то есть по сути мы сами пишем адаптер

2. **Наша интеграция глубже любого оркестратора**
   - stream-json протокол, tool approval, cross-team refs — этого нет НИ У КОГО
   - Мы бы потеряли эти фичи при переходе на внешний backend

3. **Несовместимость со стеком**
   - Bun (Overstory) vs Node.js/Electron
   - Rust sidecar (conductor-oss) — packaging nightmare
   - tmux (Composio, Overstory) — нет на Windows
   - Next.js dashboards — дублирование с нашим Electron UI

4. **Стоимость интеграции >= стоимость написания адаптера**
   - Даже для лучшего кандидата (Composio AO) нужен fork monorepo + выпиливание Next.js + адаптация под IPC
   - Это ~2-4 недели работы с непредсказуемым результатом
   - Наш собственный adapter layer для нового CLI = ~200-500 LOC (1-2 дня)

5. **Риск зависимости**
   - Большинство проектов < 6 месяцев, 1-2 автора
   - Composio AO (5.4K stars) — самый живой, но agent-orchestrator != core business Composio
   - Если проект умирает — мы на форке без community

---

## 6. Рекомендация

### Вердикт: **НЕ ИСПОЛЬЗОВАТЬ внешний оркестратор как фундамент**

Стоимость интеграции выше, чем написание собственного тонкого adapter layer.

### Что стоит ЗАИМСТВОВАТЬ (паттерны, не код)

| Паттерн | Источник | Применение у нас |
|---------|----------|-----------------|
| Plugin architecture (8 slots) | Composio AO | Вынести agent adapter в интерфейс `AgentRuntime` для будущей multi-runtime поддержки |
| SQLite mail system | Overstory | Рассмотреть для замены JSON inbox files (производительность) |
| State machine для tasks | ORCH | У нас уже есть kanban states, но можно формализовать transitions |
| AgentRuntime interface | Overstory | `{ spawn, configure, detectReadiness, parseTranscript }` — хороший контракт |
| Tiered watchdog | Overstory | Stall detection → AI triage → monitor agent |

### Рекомендуемый план

1. **Сейчас**: оставить текущую архитектуру, она работает и покрывает наш use case
2. **Если нужен multi-runtime**: написать `AgentRuntime` интерфейс (~200 LOC) + адаптер для каждого CLI (~300-500 LOC)
3. **Если нужна масштабируемость messaging**: рассмотреть миграцию с JSON inbox → SQLite WAL
4. **Мониторить** Composio AO — если опубликуют `@composio/ao-core` как npm library с programmatic API, пересмотреть решение

- **Надёжность рекомендации**: 8/10
- **Уверенность**: 9/10

---

## Источники

- [MCO (mco-org/mco)](https://github.com/mco-org/mco) — 249 stars, CLI-only orchestrator
- [Overstory (jayminwest/overstory)](https://github.com/jayminwest/overstory) — 1.1K stars, Bun + SQLite + tmux
- [Composio Agent Orchestrator](https://github.com/ComposioHQ/agent-orchestrator) — 5.4K stars, plugin architecture
- [MetaSwarm (dsifry/metaswarm)](https://github.com/dsifry/metaswarm) — 148 stars, workflow framework
- [ORCH (orch.one)](https://www.orch.one/) — CLI runtime, GitHub repo 404
- [conductor-oss (markdown-native)](https://github.com/charannyk06/conductor-oss) — 14 stars, Rust + 10 adapters
- [Awesome Agent Orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators) — каталог 80+ инструментов
- [Composio Architecture Design](https://github.com/ComposioHQ/agent-orchestrator/blob/main/artifacts/architecture-design.md)
