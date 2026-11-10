# Gastown и Paperclip comparison для лендинга и README

> Дата проверки: 2026-05-05
> Цель: публичная таблица `Agent Teams | Gastown | Paperclip | Cursor | Claude Code CLI` без угадываний по конкурентам.
> Метод: первичные источники, `gh repo view`, official README/docs/releases, локальные клоны `gastownhall/gastown` и `paperclipai/paperclip`.

## Snapshot

| Проект | Позиционирование | Статус на 2026-05-05 | Лицензия |
|---|---|---:|---|
| **Gastown** | multi-agent workspace manager для coding agents | `14,962★`, latest `v1.0.1` от `2026-04-25`, push `2026-05-03` | MIT |
| **Paperclip** | control plane для autonomous AI companies | `62,668★`, latest `v2026.428.0` от `2026-04-28`, push `2026-05-05` | MIT |

## Что важно для публичного сравнения

### Gastown

Сильные факты:

- README позиционирует Gastown как workspace manager для Claude Code, GitHub Copilot, Codex, Gemini и других AI agents.
- Есть built-in mailboxes, identities, handoffs, Beads ledger, git-backed hooks, convoys, Witness/Deacon watchdog, Refinery merge queue.
- Dependencies сильнее, чем просто "convoys": convoy stage/launch строит DAG, считает waves, запускает Wave 1, а последующие waves daemon dispatches автоматически.
- Есть `gt feed`, web dashboard, OpenTelemetry events/metrics, `gt costs record`, cost tier presets, daily cost digest и context-budget guard.
- Agent provider story шире README: provider guide прямо перечисляет Claude, Gemini, Codex, Cursor, AMP, OpenCode, Copilot и loose-coupled tmux integration tiers.
- Scheduler сильнее простого queue: `scheduler.max_polecats` включает deferred dispatch, capacity governor, pause/resume, queued sling context beads и daemon dispatch cycle.

Ограничения:

- Это не Kanban product: README описывает dashboard как обзор agents, convoys, hooks, queues, issues, escalations.
- Нет явного built-in editor, hunk-level review или task attachment workflow как продуктовой возможности.
- Бюджеты не равны Paperclip budgets: у Gastown есть cost tiers/logging/guards, но я не нашёл hard monthly caps с automatic pause/cancel.

Публичная оценка:

- `Task dependencies` - `✅ Beads DAG waves`
- `Kanban board` - `❌ Dashboard, not Kanban`
- `Per-task code review` - `⚠️ Merge queue, no diff UI`
- `Budget controls` - `⚠️ Cost tiers + digest, no hard caps`

### Paperclip

Сильные факты:

- README: Node.js server + React UI that orchestrates a team of AI agents. Works with OpenClaw, Claude Code, Codex, Cursor, Bash, HTTP.
- README прямо заявляет org charts, budgets, governance, goal alignment, agent coordination.
- README under the hood: issues have company/project/goal/parent links, atomic checkout, execution locks, blocker dependencies, comments, documents, attachments, work products.
- Budget section: scoped budget policies with warning thresholds and hard stops, overspend pauses agents and cancels queued work automatically.
- `ui/src/components/KanbanBoard.tsx` содержит `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `cancelled` и drag-and-drop через `@dnd-kit`.
- `packages/shared/src/validators/work-product.ts` содержит work products: `preview_url`, `runtime_service`, `pull_request`, `branch`, `commit`, `artifact`, `document`; statuses include `ready_for_review`, `approved`, `changes_requested`, `merged`.
- Architecture docs: built-in stable adapters listed as Claude Local, Codex Local, Process, HTTP; adapter overview also lists OpenCode, Cursor, OpenClaw Gateway, Pi, Hermes and experimental Gemini.
- Execution policy docs: runtime enforces comment-required, review and approval stages; decisions are audited; reviewers/approvers can be agents or users.
- Workspace/runtime docs: services and jobs are manually controlled from UI, execution workspaces isolate checkout/branch/runtime state, and services are not auto-started by issue execution.
- Issue API docs: @mentions in comments trigger heartbeats and issue-thread interactions can request confirmations, ask questions, or suggest tasks through UI cards.

Ограничения:

- README явно говорит: Paperclip is not a code review tool. It orchestrates work, not pull requests.
- Нет hunk-level accept/reject UI и нет built-in code editor уровня нашего workbench.
- Это broader company/org control plane, а не coding cockpit.
- Work products are real in code, but public roadmap still has "Artifacts & Work Products" as future work, so public `Per-task code review` should stay `⚠️`, not `✅`.

Публичная оценка:

- `Kanban board` - `✅ 7 columns, drag-and-drop`
- `Per-task code review` - `⚠️ PR/work products, no inline diff`
- `Hunk-level review` - `❌ Bring your own review`
- `Budget controls` - `✅ Per-agent budgets + hard stops`

## Маркетинговая позиция

Честный framing для нас:

- Против Gastown продаём не "мы мощнее как orchestration OS", а **coding-team workbench**: review, logs, editor, live processes, attachments, operator UX.
- Против Paperclip продаём не "у нас больше governance", а **agentic IDE / coding cockpit**: hunk-level review, task-scoped developer logs, built-in editor, live process controls.
- `Multi-agent backend` у нас больше не надо показывать как "In development": публично корректнее писать `Claude, Codex + OpenCode teammates`.

## Второй глубокий проход

Что поменял после повторной проверки:

- Убрал Gemini из нашей публичной строки. Теперь у нас: `Claude, Codex + OpenCode teammates`.
- Paperclip `Agent-to-agent messaging` точнее как `Comments + @mentions`, а не как полноценный mailbox. @mentions будят агентов, но это не прямой peer mailbox как у нас или Gastown.
- Paperclip `Execution log viewer` усилил до `Run transcripts + ledger`: в UI есть `RunTranscriptView` и `IssueRunLedger`, а architecture docs описывают capture stdout, cost/session state и run records.
- Paperclip `Live processes` уточнил до `Manual services + previews`: runtime services/jobs есть в UI, но docs прямо говорят, что issue execution не стартует и не стопает их автоматически.
- Gastown `Session analysis` уточнил до `Session recall, feed, OTEL`: это сильная ops/observability модель, но не наш task-scoped analysis cockpit.
- Gastown `Budget controls` уточнил до `Cost tiers + digest, no hard caps`: есть model tiering, `gt costs record`, daily digest bead, но не нашёл Paperclip-style hard budget pause.

Вывод не поменялся: публично выгоднее и честнее продавать наш **coding workbench** - hunk review, task logs, editor, live processes, attachments, team UI. Не надо притворяться, что мы глубже Gastown как orchestration OS или глубже Paperclip как governance/budget company control plane.

## Третий глубокий проход по тексту таблицы

Что уточнил после проверки README/docs/source:

- Paperclip `Cross-team communication` заменил на `Company-scoped org work`: README говорит про multi-company isolation и org charts, но не про свободную коммуникацию между независимыми компаниями.
- Paperclip `Agent-to-agent messaging` заменил на `Comments + @mentions`: docs называют comments primary channel, а @mentions будят агента через heartbeat. Это не peer mailbox.
- Gastown `Linked tasks` заменил на `Beads deps + convoys`: source сильнее, чем просто "convoys", потому что stage/launch строит DAG по dependency edges.
- Gastown `Session analysis` заменил на `Session recall, feed, OTEL`: публично понятнее, чем термин `Seance`, но всё ещё отражает session discovery, TUI feed и OpenTelemetry.
- Gastown `Full autonomy` заменил на `Mayor, convoys, recovery`: не спорим с их глубокой autonomy моделью, но не перегружаем публичную таблицу внутренними health терминами.
- Paperclip `Zero setup` заменил на `npx + embedded Postgres`: quickstart реально идёт через `npx paperclipai onboard --yes`, и docs говорят, что embedded PostgreSQL создаётся автоматически.
- Paperclip `Price` уточнил до `OSS, self-hosted + infra`: честнее, потому что Paperclip account не нужен, но self-hosting и agent/provider runtime costs всё равно остаются.

## Четвёртый глубокий проход: Claude Code CLI и Cursor

Что поменял после проверки официальных docs Cursor и Claude Code:

- Claude Code CLI нельзя честно держать как слабый baseline: официальные `agent teams` уже дают direct teammate messaging, shared task list, mailbox, task dependencies, team review scenarios и hooks for quality gates. Поэтому я поднял Claude CLI в строках `Agent-to-agent messaging`, `Linked tasks`, `Full autonomy`, `Task dependencies`, `Review workflow`.
- Но Claude Code agent teams всё ещё experimental, disabled by default, требуют `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, работают в CLI/terminal display modes и имеют known limitations. Поэтому наш selling point против Claude CLI - не "у них нет teams", а **у них нет полноценного product UI/cockpit**: kanban, task attachments, hunk review UI, task logs, live process section, cross-team UI, cost/context dashboard.
- Claude Code `Multi-agent backend` теперь точнее как `Claude-only experimental teams`, а не просто `Claude-only teams`.
- Claude Code `Git worktree isolation` точнее как `Manual worktrees`: official workflows рекомендуют git worktree для параллельных sessions, но это не автоматическая продуктовая isolation как у нас/Gastown/Paperclip.
- Cursor `Full autonomy` точнее как `Background agents, not teams`: background agents сильные, но это не team backend with shared task list/mailbox.
- Cursor `Execution log viewer` и `Live processes` понижены до `⚠️`: есть agent chat/terminal/background terminals, но нет task-scoped execution timeline и process URL section как у нас.
- Cursor `Flexible autonomy` понижен до `⚠️`: official background-agent security docs прямо говорят, что background agents auto-run terminal commands, в отличие от foreground approvals.
- Cursor `Git worktree isolation` понижен до `⚠️ Background branches/VMs`: docs говорят про isolated remote machines and separate branches, не про встроенный local worktree strategy.
- Cursor `Price` заменил с `$0-$200/mo` на `Free + paid usage`, потому что pricing/usage docs теперь акцентируют included API usage, usage dashboard, Bugbot pricing и background-agent spend limits.

Итоговая позиция после четвёртого прохода:

- Против Claude Code CLI мы не врём, что у него нет multi-agent primitives. У него они есть, но experimental and CLI-first. Мы продаём **операторский UI и review/workbench layer**.
- Против Cursor мы не врём, что у него нет background agents или review. У него есть сильный IDE/PR story. Мы продаём **team/task orchestration, task-scoped logs, cross-agent workflow and review cockpit**.

## Scores

| Критерий | Agent Teams | Gastown | Paperclip |
|---|---:|---:|---:|
| Coding cockpit | **9.2** | 5.6 | 6.8 |
| Orchestration depth | 7.6 | **9.2** | 8.8 |
| Governance / budget control | 6.7 | 6.0 | **9.4** |
| Review UX | **9.3** | 5.8 | 6.2 |
| Setup simplicity | **8.4** | 4.7 | 7.1 |

Вывод по 10-балльной уверенности:

- Agent Teams против Gastown: 🎯 9   🛡️ 8   🧠 5 - сравнение честное, потому что мы отдаём Gastown orchestration depth, но забираем workbench.
- Agent Teams против Paperclip: 🎯 9   🛡️ 8   🧠 6 - сравнение честное, потому что Paperclip сильнее в budgets/governance, но слабее как code-review/editor cockpit.
- Agent Teams против Cursor: 🎯 9   🛡️ 9   🧠 5 - сравнение честное, потому что Cursor сильнее как IDE, но не как multi-agent team/task OS.
- Agent Teams против Claude Code CLI: 🎯 9   🛡️ 9   🧠 6 - сравнение честное только после повышения Claude CLI по official agent teams primitives; наш выигрыш теперь UI/workbench, не наличие базовой team механики.
- Публичная таблица после Claude/Cursor прохода: 🎯 9   🛡️ 9   🧠 5 - около 55 строк изменения в README/landing плюс локали.

## Источники

- Gastown repo: <https://github.com/gastownhall/gastown>
- Gastown v1.0.1: <https://github.com/gastownhall/gastown/releases/tag/v1.0.1>
- Gastown convoy implementation: <https://github.com/gastownhall/gastown/blob/main/internal/cmd/convoy_launch.go>
- Gastown convoy skill docs: <https://github.com/gastownhall/gastown/tree/main/docs/skills/convoy>
- Gastown provider guide: <https://github.com/gastownhall/gastown/blob/main/docs/agent-provider-integration.md>
- Gastown scheduler docs: <https://github.com/gastownhall/gastown/blob/main/docs/design/scheduler.md>
- Paperclip repo: <https://github.com/paperclipai/paperclip>
- Paperclip v2026.428.0: <https://github.com/paperclipai/paperclip/releases/tag/v2026.428.0>
- Paperclip Kanban source: <https://github.com/paperclipai/paperclip/blob/master/ui/src/components/KanbanBoard.tsx>
- Paperclip work products source: <https://github.com/paperclipai/paperclip/blob/master/packages/shared/src/validators/work-product.ts>
- Paperclip architecture docs: <https://github.com/paperclipai/paperclip/blob/master/docs/start/architecture.md>
- Paperclip execution policy docs: <https://github.com/paperclipai/paperclip/blob/master/docs/guides/execution-policy.md>
- Paperclip costs and budgets docs: <https://github.com/paperclipai/paperclip/blob/master/docs/guides/board-operator/costs-and-budgets.md>
- Paperclip runtime services docs: <https://github.com/paperclipai/paperclip/blob/master/docs/guides/board-operator/execution-workspaces-and-runtime-services.md>
- Cursor Background Agents: <https://docs.cursor.com/en/background-agents>
- Cursor Diffs & Review: <https://docs.cursor.com/en/agent/review>
- Cursor Bugbot: <https://docs.cursor.com/en/bugbot>
- Cursor usage/pricing: <https://docs.cursor.com/en/account/usage>
- Claude Code agent teams: <https://code.claude.com/docs/en/agent-teams>
- Claude Code subagents: <https://code.claude.com/docs/en/sub-agents>
- Claude Code common workflows: <https://code.claude.com/docs/en/common-workflows>
- Claude Code costs: <https://code.claude.com/docs/en/costs>
