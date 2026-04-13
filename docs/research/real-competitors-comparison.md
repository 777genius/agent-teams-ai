# Реальные конкуренты для Comparison в README

> Дата проверки: 2026-04-13  
> Статус: внутренний comparison draft  
> Цель: заменить в нашем внутреннем thinking `Vibe Kanban` и `Aperant` на реальные ориентиры - `Gastown`, `Claude Code Agent Teams`, `GoClaw`

## Что именно сравнивается

В этом документе "мы" = не только README-маркетинг, а текущий продуктовый стек:

- `claude_team` как frontend/workbench
- `agent_teams_orchestrator` как локальный runtime и task/review/log pipeline

Сравнение идёт по тем же строкам, что уже есть в `Comparison` секции README, но с реальными конкурентами.

## Как сравнивал

- `✅` - фича есть как явная продуктовая возможность
- `⚠️` - фича есть частично, экспериментально, только вручную, только через CLI/TUI, или без сильного UI/UX
- `❌` - фича не задокументирована как продуктовая возможность или явно отсутствует

Правило важное:

- если capability есть только "под капотом" или через обходной workflow, это не `✅`
- для нашей стороны я учитывал не только README, но и реальный frontend/code surface
- для конкурентов брал только первичные источники: official docs, official GitHub repo, official releases

## Короткий snapshot

| Система | Позиционирование | GitHub / живость | Самое важное |
|---|---|---|---|
| **Claude Agent Teams UI** | local-first coding-team cockpit | `577★`, push `2026-04-12` | сильнейший UI для task logs, review, editor, live processes |
| **Gastown** | process-model multi-agent workspace manager | `13,931★`, latest `v1.0.0` от `2026-04-03` | сильный orchestration runtime, mailboxes, handoffs, git worktrees |
| **Claude Code Agent Teams** | нативные team lead + teammates внутри Claude Code | `113,180★` у `anthropics/claude-code`, latest `v2.1.104` от `2026-04-13` | самый нативный Claude-first team runtime, но без нашего UI-слоя |
| **GoClaw** | self-hosted multi-tenant agent platform | `2,634★`, latest `v3.6.0` от `2026-04-13` | самый широкий platform surface: kanban, approvals, providers, channels |

## Feature matrix

| Feature | Claude Agent Teams UI | Gastown | Claude Code Agent Teams | GoClaw |
|---|---|---|---|---|
| **Cross-team communication** | ✅ Native cross-team messaging between teams | ⚠️ Cross-rig coordination exists, but not a polished team-to-team chat surface | ❌ No documented team-to-team concept | ❌ Team-local messaging, no documented cross-team agent comms |
| **Agent-to-agent messaging** | ✅ Native mailbox-style teammate and lead messaging | ✅ Built-in mailboxes, identities, handoffs | ✅ Shared mailbox + direct teammate messaging | ✅ Team messaging, member-to-member messages |
| **Linked tasks** | ✅ `#task-id` references + task dependencies | ⚠️ Beads, convoys and deps exist, but linking UX is more operational than productized | ⚠️ Shared task list + dependencies, but minimal linking UX | ✅ Task numbers, search, `blocked_by`, comments, audit trail |
| **Session analysis** | ✅ Task-specific logs, exact task log matching, deep session analysis, token tracking | ⚠️ Event stream, seance, OTLP logs, but no rich per-session analytics UI | ❌ No dedicated session analysis surface | ⚠️ Traces, audit events and task detail exist, but not our depth of per-task session analysis |
| **Task attachments** | ✅ Task and comment attachments in team workflow | ❌ Not documented as a task feature | ❌ Not documented | ✅ Task attachments + media auto-copy into team workspace |
| **Hunk-level review** | ✅ Accept / reject individual hunks | ❌ | ❌ | ❌ |
| **Built-in code editor** | ✅ Built-in editor with Git support | ❌ | ❌ | ❌ Workspace browser exists, but not a real built-in code editor |
| **Full autonomy** | ✅ Agents can create, assign, review and progress tasks end-to-end with human override | ✅ Mayor + convoy + witness/deacon orchestration | ⚠️ Strong autonomy, but feature is still experimental | ✅ Strong autonomous team/task orchestration |
| **Task dependencies (blocked by)** | ✅ Explicit task dependencies and ordering | ✅ Beads deps / blocked work exist | ✅ Dependencies unblock automatically | ✅ `blocked_by`, blocked lifecycle, retry, stale handling |
| **Review workflow** | ✅ Agent peer review + human review UI | ⚠️ Merge/review workflows exist, but not as a productized task review cockpit | ⚠️ Plan approval + hooks, but no rich review board | ✅ `in_review`, approve/reject, reviewer-agent gates |
| **Zero setup** | ✅ Claude Code install + auth from the app | ❌ Many prerequisites and workspace bootstrap steps | ❌ Claude Code install + experimental flag required | ❌ Standard setup needs infra/provider config; Lite is easier but still not zero-setup |
| **Kanban board** | ✅ Real-time board | ❌ Dashboard overview, not Kanban | ❌ Shared task list, no Kanban board | ✅ Dashboard Kanban board |
| **Execution log viewer** | ✅ Task log panels, exact logs, stream, timeline | ⚠️ Feed/dashboard/event logs exist, but not a task log cockpit | ❌ No dedicated log viewer | ⚠️ Trace spans + task events/comments, but not strong raw per-task execution logs |
| **Live processes** | ✅ View, stop, inspect, open URLs | ⚠️ Agent/session monitoring exists, but not a developer process cockpit | ⚠️ Split panes let you watch sessions, but there is no processes dashboard | ❌ No comparable live-process UI surfaced like ours |
| **Per-task code review** | ✅ Per-task diff review with accept / reject / comment flow | ❌ | ❌ | ⚠️ Task approval exists, but not inline code diff review |
| **Flexible autonomy** | ✅ Granular approvals, notifications, autonomy controls | ✅ Strong human gates, escalation and intervention, mostly via CLI/TUI | ⚠️ Plan approval, hooks and permissions exist, but control plane is thin | ✅ Team settings, approval workflows, exec approval, task approval |
| **Git worktree isolation** | ✅ Optional per-agent worktree strategy | ✅ Core architectural primitive | ⚠️ Manual worktrees exist in Claude Code, but not as the native team model | ❌ Not a core team isolation model |
| **Multi-agent backend** | ⚠️ Claude is mature; Codex/Gemini plumbing exists in code but is still emerging as product surface | ✅ Claude Code, Codex, Gemini, Copilot and other runtimes | ❌ Claude-first only, models per teammate but no real multi-provider backend | ✅ 20+ providers including Claude CLI and ChatGPT OAuth |
| **Price** | Free OSS UI, but a Claude Code plan is still needed today | Free OSS, but you still pay for the underlying runtime plans/seats you use | Claude subscription | Free self-hosted OSS, but infra + provider/API/subscription costs remain |

## Самые важные выводы по matrix

### 1. Наше главное отличие - мы сильнее именно как coding workbench

По frontend/product surface у нас очень большой отрыв в четырёх местах:

- task-scoped logs
- hunk-level review
- built-in editor
- live processes

Это и есть та часть, которую README сейчас продаёт лучше всего, и она реально подтверждается кодом.

### 2. Gastown - реальный конкурент по orchestration, но не по UI

Gastown нельзя сравнивать с нами как с "kanban app". Это скорее process-model orchestrator:

- Mayor
- mailboxes
- handoffs
- witness/deacon monitoring
- convoys
- git worktree isolation

Но по UX для review, editor, per-task logs и task attachments он заметно слабее.

### 3. Claude Code Agent Teams - это ближайший конкурент именно по runtime-модели

Если смотреть на core idea:

- team lead
- teammates
- mailbox
- shared task list
- dependencies
- direct teammate messaging

то это самый близкий конкурент нашему runtime foundation. Но у них почти нет того UI-слоя, который у нас уже есть как продукт: kanban, per-task review, logs, attachments, processes, editor.

### 4. GoClaw - сильнейший platform competitor, но не лучший coding cockpit

GoClaw выигрывает у нас по:

- multi-provider breadth
- self-hosted platform maturity
- Kanban + approvals + task lifecycle
- OAuth/provider surface
- multi-tenant / channels / ops

Но проигрывает в IDE-like coding surfaces:

- hunk review
- per-task code review UX
- built-in editor
- live process control
- task-scoped raw logs as a strong developer cockpit

## Более глубокое чтение каждого конкурента

### Gastown

Что после более глубокого чтения видно особенно ясно:

- Это не просто "ещё один agent manager", а очень осознанная process-model система.
- Самые load-bearing примитивы у них - `Mayor`, `Witness`, `Deacon`, `Refinery`, `Convoy`, `Hooks`, `Beads`.
- У них сильный recovery story:
  - persistent identity
  - session handoff
  - recovery mail protocol
  - watchdog chain
  - capacity-controlled dispatch
- Они явно думают не как "чат с LLM", а как "операционная система для swarm of coding agents".

Что тянет вниз:

- setup тяжёлый
- UI мониторинговый, не IDE-like
- per-task review/log/editor surfaces слабее
- часть силы живёт в терминах и process model, а не в простой product UX

### Claude Code Agent Teams

После более глубокого чтения видно:

- Это лучший нативный Claude-first фундамент для team lead + teammates.
- Shared task list, mailbox, direct teammate messaging и automatic dependency unblocking у них реальные.
- Есть plan approval loop и hooks-based quality gates.
- Но feature всё ещё experimental, и docs сами предупреждают про limits around resumption / coordination / shutdown.

Что это значит practically:

- как native runtime foundation это сильная штука
- как самостоятельный продукт для управления coding team это пока тонко
- без нашего UI-слоя там очень мало operator ergonomics

### GoClaw

После более глубокого чтения и docs, и кода:

- Это самый сбалансированный platform product в сравнении.
- У него сильный task engine, approvals, Kanban, workspace, provider layer, OAuth paths, traces, channels.
- Он лучше остальных выглядит как "готовая self-hosted platform", а не как набор сильных primitives.

Что тянет вниз:

- слабее IDE-like coding workbench
- infra/setup тяжелее нашего и Claude Code path
- non-commercial license очень сильно режет "open source leverage"

## Scorecards

Ниже уже не просто feature presence, а моя независимая оценка по 10-балльной шкале.

### 1. Чисто как orchestration engine

| Проект | Оценка | Почему |
|---|---:|---|
| **Gastown** | **9.2** | Самый сильный process-model orchestration для coding swarms: mailboxes, handoffs, convoys, witness/deacon, worktrees, merge queue, recovery |
| **GoClaw** | **8.9** | Самый зрелый durable workflow-state engine: board lifecycle, approvals, `blocked_by`, retry, stale, traces, provider-agnostic task system |
| **Claude Agent Teams UI + orchestrator** | **7.8** | Сильный local orchestrator и deterministic bootstrap, но task/state engine менее durable и менее mature |
| **Claude Code Agent Teams** | **7.7** | Хороший native runtime foundation, но lifecycle проще и feature всё ещё experimental |

### 2. Как coding cockpit / agentic IDE

| Проект | Оценка | Почему |
|---|---:|---|
| **Claude Agent Teams UI + orchestrator** | **9.4** | Лучший review, per-task logs, built-in editor, live processes, operator control |
| **GoClaw** | **7.2** | Хороший dashboard/workspace/product UI, но не настолько сильный coding workbench |
| **Claude Code Agent Teams** | **6.0** | Живые teammate sessions и direct messaging есть, но это всё ещё CLI-native control, не полноценный cockpit |
| **Gastown** | **5.7** | Сильный TUI/dashboard monitoring, но IDE-like surfaces почти нет |

### 3. Setup / onboarding

| Проект | Оценка | Почему |
|---|---:|---|
| **Claude Agent Teams UI + orchestrator** | **8.5** | Самый сильный zero-setup путь для Claude Code сценария |
| **Claude Code Agent Teams** | **7.2** | Относительно просто, если пользователь уже живёт в Claude Code, но нужен install + experimental flag |
| **GoClaw** | **6.2** | Lite заметно упрощает вход, но standard edition всё ещё тяжёлая |
| **Gastown** | **4.6** | Сильный toolchain tax: Go, Git, Dolt, beads, sqlite3, tmux, CLI runtimes, HQ bootstrap |

### 4. Provider flexibility / subscription paths

| Проект | Оценка | Почему |
|---|---:|---|
| **GoClaw** | **9.6** | 20+ providers, Claude CLI, ChatGPT OAuth, channels, pooling |
| **Gastown** | **8.8** | Очень хороший multi-runtime story: Claude Code, Codex, Gemini, Copilot и др. |
| **Claude Agent Teams UI + orchestrator** | **5.8** | Путь на multi-provider проступает в коде, но продукт всё ещё Claude-first |
| **Claude Code Agent Teams** | **4.2** | Claude-first by design |

### 5. Maturity / engineering confidence

Это уже composite signal по docs + releases + tests + architectural surface.

| Проект | Оценка | Что учитывал |
|---|---:|---|
| **Gastown** | **8.6** | `13.9k★`, `v1.0.0`, `492` `*test.go`, глубокая design-doc surface |
| **GoClaw** | **8.5** | `v3.6.0`, `351` `*test.go`, очень широкая docs surface, частая релизная активность |
| **Claude Code Agent Teams** | **7.5** | Огромный repo и релизный cadence сильные, но сама feature experimental |
| **Claude Agent Teams UI + orchestrator** | **6.9** | UI очень силён, но stars/coverage/maturity пока заметно слабее; у frontend сейчас `0` test files |

## Архитектурный deep-dive

### Coordination topology

| Проект | Топология | Сильная сторона | Ограничение |
|---|---|---|---|
| **Наш стек** | lead-centered orchestration + rich operator UI | человек очень хорошо держит команду руками | engine менее durable, много ценности живёт в operator loop |
| **Gastown** | process-model roles + externalized state via beads/hooks/mail | лучшая декомпозиция swarm как операционной системы | высокая когнитивная и инфраструктурная сложность |
| **Claude Code Agent Teams** | lead + teammates + peer messaging + shared task list | максимально нативная Claude-first team модель | experimental state machine и тонкий control plane |
| **GoClaw** | DB-backed task engine + team tools + orchestration modes | самый продуктово цельный runtime | менее выразительный IDE/workbench слой |

### Persistence model

| Проект | Persistence | Что это даёт | Комментарий |
|---|---|---|---|
| **Наш стек** | local app state + Claude logs + runtime stores + bootstrap state | сильный session/task visibility для local work | меньше durable workflow truth, чем у `Gastown`/`GoClaw` |
| **Gastown** | Git worktrees + Beads ledger + Dolt + mail protocol | crash-surviving coordination и сильная work history | сложнее понять и сопровождать |
| **Claude Code Agent Teams** | local files in `~/.claude/teams` and `~/.claude/tasks` | surprisingly practical lightweight persistence | проще и слабее, чем полноценный DB-backed engine |
| **GoClaw** | PostgreSQL in standard, SQLite in Lite | самый сильный durable task/store foundation | инфраструктурная цена выше |

### Observability model

| Проект | Лучшее в observability | Что слабее |
|---|---|---|
| **Наш стек** | лучший task-scoped log visibility и review-oriented debugging | слабее общий durable ops/trace plane |
| **Gastown** | сильные OTLP logs, activity feed, structured runtime events | слабее productized per-task log cockpit |
| **Claude Code Agent Teams** | visibility через sessions and split panes | почти нет отдельного observability product layer |
| **GoClaw** | traces, audit logs, approvals, task events, activity pages | raw per-task coding logs ощущаются слабее, чем у нас |

### Review / merge model

| Проект | Review model | Practical impact |
|---|---|---|
| **Наш стек** | per-task diff review + hunks + comments + approvals | лучший human review loop |
| **Gastown** | refinery / merge queue / PR-oriented review flow | сильный integration discipline, но слабый UI review cockpit |
| **Claude Code Agent Teams** | plan approval + hooks quality gates | хороший gate mechanism, но не review product |
| **GoClaw** | task `in_review` + approve/reject + reviewer agent gates | сильный workflow review, но слабее code-review UX |

## Weighted verdicts

Здесь самый важный момент: **"лучший проект" зависит от весов**.  
Ниже три независимые линзы, каждая со своими весами.

### Lens A - Self-hosted multi-agent product

Веса:

- orchestration engine - 30%
- product/UI breadth - 25%
- setup/onboarding - 10%
- provider flexibility - 15%
- maturity/confidence - 15%
- license leverage - 5%

| Проект | Итоговый балл |
|---|---:|
| **GoClaw** | **8.1** |
| **Gastown** | **7.6** |
| **Наш стек** | **7.5** |
| **Claude Code Agent Teams** | **6.7** |

Вывод:

- если смотреть на проект как на **самый полноценный self-hosted продукт**, побеждает `GoClaw`

### Lens B - Coding team workstation / agentic IDE

Веса:

- coding cockpit - 35%
- review/log/debug surfaces - 20%
- local operator control - 15%
- setup friction - 10%
- orchestration engine - 10%
- maturity/confidence - 10%

| Проект | Итоговый балл |
|---|---:|
| **Наш стек** | **8.5** |
| **GoClaw** | **7.4** |
| **Claude Code Agent Teams** | **6.8** |
| **Gastown** | **6.6** |

Вывод:

- если смотреть на проект как на **лучший инструмент для реальной работы над кодом**, побеждаем мы

### Lens C - Open-source orchestration leverage

Веса:

- orchestration engine - 30%
- engineering confidence - 20%
- license leverage - 20%
- provider/runtime flexibility - 15%
- observability/recovery - 15%

| Проект | Итоговый балл |
|---|---:|
| **Gastown** | **8.6** |
| **GoClaw** | **7.9** |
| **Наш стек** | **7.0** |
| **Claude Code Agent Teams** | **5.9** |

Вывод:

- если смотреть на проект как на **наиболее ценный open-source фундамент для серьёзной orchestration-системы**, побеждает `Gastown`

## Независимый итоговый verdict

Если заставить меня выбрать **одного общего победителя как продукта**, то это сейчас:

### **1 место overall - GoClaw**

Почему:

- самый сбалансированный проект
- сильный engine
- сильный platform UI
- сильный provider story
- сильный self-hosted story
- сильный docs/release surface

Моя оценка:

- overall: **8.5 / 10**
- 🎯 8.8   🛡️ 8.6   🧠 5

### **2 место overall - Gastown**

Почему:

- как orchestrator для fleets of coding agents он очень силён
- архитектурно у него самый яркий process-model характер
- по recovery / work persistence / worktree isolation он реально впечатляет

Почему не первое место:

- тяжёлый вход
- слабее product UX
- слабее review/log/editor cockpit

Моя оценка:

- overall: **8.2 / 10**
- 🎯 8.6   🛡️ 8.8   🧠 7

### **3 место overall - наш стек**

Почему:

- лучший coding cockpit
- лучший human-in-the-loop control plane
- лучший UI для лида coding-команды

Почему не выше:

- orchestration engine менее зрелый, чем у `Gastown` и `GoClaw`
- maturity signals слабее
- frontend test surface сейчас объективно плохой
- multi-provider story пока не настолько продуктово зрелая

Моя оценка:

- overall: **7.9 / 10**
- 🎯 8.4   🛡️ 7.4   🧠 5

### **4 место overall - Claude Code Agent Teams**

Почему:

- это сильная native runtime функция, но ещё не лучший самостоятельный продукт
- слишком много experimental caveats
- почти нет product/UI advantage по сравнению с остальными

Моя оценка:

- overall: **7.1 / 10**
- 🎯 8.2   🛡️ 6.8   🧠 3

## Кто лучший по конкретным сценариям

| Сценарий | Победитель | Почему |
|---|---|---|
| **Лучший overall product** | **GoClaw** | Самый ровный баланс engine + UI + providers + self-hosted maturity |
| **Лучший pure orchestrator для coding swarms** | **Gastown** | Самый сильный process-model orchestration core |
| **Лучший native Claude runtime foundation** | **Claude Code Agent Teams** | Самая нативная реализация team lead + teammates внутри Claude Code |
| **Лучший coding cockpit / agentic IDE** | **наш стек** | Лучшие review, logs, editor, processes, human control |

## Что особенно важно помнить для README

Если мы когда-нибудь будем переписывать публичный `Comparison` в README, то главный честный framing такой:

- против `Gastown` надо продавать `UI/workbench`, а не пытаться спорить, что мы сильнее как process-model orchestrator
- против `Claude Code Agent Teams` надо продавать "native runtime + настоящий product UI сверху"
- против `GoClaw` надо продавать "agentic IDE / coding cockpit", а не "более широкий platform product"

## Где у нас реально подтверждён сильный frontend

Это ключевые локальные опоры, на которые можно смело ссылаться внутри команды:

- review cockpit - [ChangeReviewDialog](../../src/renderer/components/team/review/ChangeReviewDialog.tsx)
- task detail + attachments + comments - [TaskDetailDialog](../../src/renderer/components/team/dialogs/TaskDetailDialog.tsx)
- task logs - [TaskLogsPanel](../../src/renderer/components/team/taskLogs/TaskLogsPanel.tsx)
- built-in editor - [ProjectEditorOverlay](../../src/renderer/components/team/editor/ProjectEditorOverlay.tsx)
- live processes - [ProcessesSection](../../src/renderer/components/team/ProcessesSection.tsx)
- tool approvals - [ToolApprovalSheet](../../src/renderer/components/team/ToolApprovalSheet.tsx)

Есть и важная продуктовая нюансировка:

- cross-team communication у нас реально есть
- task attachments у нас реально есть
- multimodel/provider surface у нас уже проступает в коде
- но публично и продуктово мы всё ещё остаёмся в первую очередь Claude-first

## Места, где надо быть особенно честными про нас

- `Multi-agent backend` у нас пока не так зрел, как это можно прочитать из одной строки README. В коде есть мосты и статусы для `Anthropic`, `Codex`, `Gemini`, но продуктово основной путь всё ещё Claude-first.
- `Zero setup` у нас честно сильный именно для Claude Code path.
- `Cross-team communication` у нас сильнее, чем у этих конкурентов, но cross-team attachments не выглядят как полностью общий happy path.

## Источники

### Наша сторона

- README: [README.md](../../README.md)
- review UI: [ChangeReviewDialog](../../src/renderer/components/team/review/ChangeReviewDialog.tsx)
- logs UI: [TaskLogsPanel](../../src/renderer/components/team/taskLogs/TaskLogsPanel.tsx)
- editor UI: [ProjectEditorOverlay](../../src/renderer/components/team/editor/ProjectEditorOverlay.tsx)
- processes UI: [ProcessesSection](../../src/renderer/components/team/ProcessesSection.tsx)
- task workflow UI: [TaskDetailDialog](../../src/renderer/components/team/dialogs/TaskDetailDialog.tsx)
- approvals UI: [ToolApprovalSheet](../../src/renderer/components/team/ToolApprovalSheet.tsx)

### Gastown

- Official repo: <https://github.com/gastownhall/gastown>
- README: <https://github.com/gastownhall/gastown/blob/main/README.md>
- Latest release: <https://github.com/gastownhall/gastown/releases/latest>

### Claude Code Agent Teams

- Agent Teams docs: <https://code.claude.com/docs/en/agent-teams>
- CLI auth docs: <https://code.claude.com/docs/en/cli-usage>
- Claude Code repo: <https://github.com/anthropics/claude-code>
- Latest release: <https://github.com/anthropics/claude-code/releases/latest>

### GoClaw

- Official repo: <https://github.com/nextlevelbuilder/goclaw>
- README: <https://github.com/nextlevelbuilder/goclaw/blob/dev/README.md>
- Full docs export: <https://docs.goclaw.sh/llms-full.txt>
- Latest release: <https://github.com/nextlevelbuilder/goclaw/releases/latest>

## Bottom line

Если брать реальные продукты, то текущая внутренняя картина такая:

- **Gastown** - конкурент по orchestration runtime
- **Claude Code Agent Teams** - конкурент по базовой runtime-модели team lead + teammates
- **GoClaw** - конкурент по platform orchestration product
- **мы** - сильнее как agentic IDE / coding-team cockpit

То есть наш главный moat сейчас не "самый широкий agent platform".  
Он в том, что мы уже собрали более сильное рабочее место для лида coding-команды, чем у этих трёх систем.
