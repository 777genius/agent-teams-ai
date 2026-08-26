# Agent Teams, Gas Town, Paperclip, Cursor и Claude Code CLI: проверка для публичной таблицы

> Последняя полная проверка: 2026-08-27. Файл сохраняет исходное имя 2026-06-25, чтобы не ломать публичные ссылки.
> Цель: поддерживать таблицу `Agent Teams | Gas Town | Paperclip | Cursor | Claude Code CLI` без угадываний по конкурентам.
> Метод: локальный source audit Agent Teams; `gh api`, GitHub releases и source files для GitHub-проектов; официальные docs, changelog и pricing pages Cursor и Anthropic.

## Ограничение методики

Оценки live collaboration - качественная редакционная оценка документированных возможностей общения, владения задачами, зависимостей, завершения работы и ревью. Это не benchmark и не результат воспроизводимого performance-теста.

Для Gas Town и Paperclip отдельно различаются последний стабильный release и более свежий default branch. Claims из default branch нельзя автоматически считать доступными в последнем release.

## Локальная проверка Agent Teams

Проверено на `origin/main` commit `f6afac73c` от 2026-08-25.

- **Live collaboration:** inbox delivery, owned tasks, dependencies/unblocking, completion, peer review и cross-team delivery подтверждены в `agent-teams-controller/src/internal`. Поэтому `9/10` остаётся редакционной оценкой сильного live-team flow, но не измеренным benchmark.
- **Organizations:** editable nested organizations, live team/agent state, task counts, relations и runtime cross-team communication overlay подтверждены `src/features/organizations`.
- **Terminal workspace:** подтверждён встроенный visual terminal, scoped per team/project, local shell, tabs, persistent history, autocomplete и settings. Source не подтверждает отдельное переключение между live agent runtime и local shell, поэтому такой claim удалён.
- **Budgets:** monthly token/API-equivalent estimated-cost budgets на global/team/project scopes дают alerts на 80% и 100%, но не являются универсальным monthly hard stop.
- **Scheduled hard cap:** optional schedule budget передаётся поддерживаемому runtime CLI через `--max-budget-usd`. Это нельзя расширять до одинакового enforcement всеми provider paths.

## Snapshot

| Проект | Проверенный срез | Последний stable release | GitHub snapshot | Лицензия |
|---|---|---|---:|---|
| **Gas Town** | `main` `649b832` от 2026-07-23 | `v1.2.1` от 2026-06-06 | `17,794★` на 2026-08-27 | MIT |
| **Paperclip** | `master` `4277ecb` от 2026-08-26 | `v2026.824.1` от 2026-08-25 | `79,432★` на 2026-08-27 | MIT |
| **Claude Code CLI** | official docs на 2026-08-27 | `v2.1.246` от 2026-08-25 | release metadata | proprietary |

Stars - волатильный snapshot, не продуктовая метрика и не часть сравнительного score.

## Что изменилось после 2026-07-11

### Gas Town

- Stable release остался `v1.2.1`, но `main` продолжил развиваться. Встроенные provider presets расширились, включая Kiro; это unreleased source capability относительно `v1.2.1`.
- Current README по-прежнему подтверждает identities, mailboxes, handoffs, git-worktree persistence, terminal feed, web dashboard, escalation и Bors-style Refinery merge queue.
- Scheduler остаётся capacity governor/backpressure для polecat dispatch, а не calendar/cron scheduler.
- `gt costs`, daily digest и cost tiers не дают numeric spend cap или hard stop. Формулировка `Cost tiers + digest, no hard caps` остаётся корректной.

### Paperclip

- Stable вырос с `v2026.707.0` до `v2026.824.1`.
- `v2026.817.0` усилил governed agent-to-agent issue-thread interactions, audit, routines, model catalogs, cost attribution и workspace concurrency.
- `v2026.824.0` сделал chat-style task UI default, добавил task conversation с blockers/sub-task tree/documents/artifacts, HTTPS runtime previews, verified sandbox capability contract, in-product Claude/Codex sign-in и transactional review-policy verdicts.
- `v2026.824.1` исправил background-service onboarding и завершает interactive onboarding открытием dashboard.
- Несмотря на более сильный task chat и governance, default execution остаётся schedule/event-driven heartbeat model. README прямо позиционирует Paperclip как orchestrator, а не code-review tool. Поэтому live score `7/10` и `Review gates, not inline code review` остаются честными.

### Cursor

- Agents Window теперь официально описывает unified workspace для local/cloud/remote parallel agents.
- Subagents имеют отдельный context, foreground/background execution, parallel launch, optional isolated worktrees/VMs, cloud handoff и ограниченную nested delegation. Результат возвращается parent agent; peer-to-peer mailbox или shared peer task graph не документированы.
- Поэтому live cell уточнён до `Parallel agents + subagents, no peer team`, а score остаётся `6/10`.
- Code-review cell теперь различает configurable local Agent Review и PR-oriented Bugbot. Отдельный Cursor Review продукт остаётся closed beta и не засчитывается как GA capability.
- Cloud Agents работают в isolated VMs/branches, доступны на paid plans, тарифицируются по model API pricing и требуют spend limit при первом использовании.
- Individual plans: Hobby free, Pro `$20/mo`, Pro+ `$60/mo`, Ultra `$200/mo`. Teams: Standard `$40/user/mo`, Premium `$120/user/mo`; team-wide spend limits доступны Teams, per-member limits - Enterprise.

### Claude Code CLI

- Agent teams всё ещё experimental и disabled by default через `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; в `-p`/Agent SDK teammates не spawnятся.
- Teams подтверждают direct peer messaging, shared task list, task dependencies, atomic claims, plan approval и hooks, но сохраняют resume/task-sync/shutdown ограничения. Score `7/10` остаётся обоснованным.
- После 2026-07-11 появился cross-session messaging (`ListAgents`, `SendMessage`, `@session`) между независимыми sessions, в том числе на других машинах. Поэтому `Cross-team communication: ❌` заменено на partial: `Cross-session messaging, no shared cross-team task graph`.
- Worktrees теперь официально встроены для CLI sessions и isolated subagents.
- Costs docs подтверждают `/usage`, plan/org/workspace limits и reporting. `--max-budget-usd` является hard cap только для print mode, включая subagents/background agents, поэтому cell уточнён до `Usage/org limits + print-mode hard cap`.
- Актуальные plan цены: Pro `$20/mo` или `$17/mo` annual; Max `$100/$200`; Team Standard `$20/$25` за seat и Premium `$100/$125`; Enterprise self-serve `$20/seat/mo + API-rate usage` при annual billing.

## Публичные оценки после проверки

### Gas Town

- `Live team collaboration` - `8/10`: persistent identities, async mailboxes/handoffs, shared state и recovery; terminal/tmux-first, без shared live app chat.
- `Task dependencies` - `✅ Dependency waves`: convoys/molecules и dependency-aware work staging; decomposition должна существовать до convoy launch.
- `Kanban board` - `❌ Dashboard, not Kanban`.
- `Code review` - `⚠️ Merge queue, no diff UI`.
- `Budget controls` - `⚠️ Cost tiers + digest, no hard caps`.

### Paperclip

- `Live team collaboration` - `7/10`: durable heartbeat agents, issue comments, mentions and governed interactions; меньше continuously addressable peer teamwork.
- `Team workspace` - `⚠️ Board + task chats, less live teammate view`.
- `Kanban board` - `✅ 7 columns, drag-and-drop`.
- `Code review` - `⚠️ Review gates, not inline code review`.
- `Budget controls` - `✅ Per-agent budgets + hard stops`; current policies также поддерживают company/project scopes.
- `Task attachments` - `✅ Docs, attachments, work products`.

### Cursor

- `Live team collaboration` - `6/10`: parallel agents/subagents, no documented peer team.
- `Team workspace` - `⚠️ Agents Window, no peer team workspace`.
- `Code review` - `✅ Local Agent Review + PR Bugbot`.
- `Git worktree isolation` - `✅ Agents Window worktrees`; subagents need explicit isolation when concurrent edits could collide.
- `Budget controls` - `⚠️ Usage + cloud spend limits`.
- `Price` - `Free + paid usage`.

### Claude Code CLI

- `Live team collaboration` - `7/10`: experimental peer teams + cross-session messaging, with recovery/task-sync limits.
- `Cross-team communication` - `⚠️ Cross-session messaging, no shared cross-team task graph`.
- `Linked tasks` - `✅ Shared task list` with dependencies inside agent teams.
- `Git worktree isolation` - `✅ Built-in for sessions and subagents`.
- `Budget controls` - `⚠️ Usage/org limits + print-mode hard cap`.
- `Mixed AI teammates` - `⚠️ Claude-only experimental teams`.

## Первичные источники

### Agent Teams

- Collaboration controller: <https://github.com/777genius/agent-teams-ai/tree/main/agent-teams-controller/src/internal>
- Organizations: <https://github.com/777genius/agent-teams-ai/tree/main/src/features/organizations>
- Terminal workspace: <https://github.com/777genius/agent-teams-ai/blob/main/src/features/terminal-workspace/renderer/ui/TerminalWorkspacePanel.tsx>
- Token usage budgets: <https://github.com/777genius/agent-teams-ai/blob/main/src/features/token-usage/contracts/dto.ts>
- Scheduled budget cap: <https://github.com/777genius/agent-teams-ai/blob/main/src/main/services/schedule/ScheduledTaskExecutor.ts>

### Gas Town

- Repository/current README: <https://github.com/gastownhall/gastown>
- Checked `main` commit: <https://github.com/gastownhall/gastown/commit/649b832b7672bc7a2dbef26f5983aba6198b819b>
- `v1.2.1`: <https://github.com/gastownhall/gastown/releases/tag/v1.2.1>
- Provider guide: <https://github.com/gastownhall/gastown/blob/main/docs/agent-provider-integration.md>
- Mail protocol: <https://github.com/gastownhall/gastown/blob/main/docs/design/mail-protocol.md>
- Scheduler: <https://github.com/gastownhall/gastown/blob/main/docs/design/scheduler.md>
- Dashboard source: <https://github.com/gastownhall/gastown/blob/main/internal/web/templates/convoy.html>

### Paperclip

- Repository/current README: <https://github.com/paperclipai/paperclip>
- Checked `master` commit: <https://github.com/paperclipai/paperclip/commit/4277ecbb2e7b80cda02c86641a14ae31d0d1a5ba>
- `v2026.824.1`: <https://github.com/paperclipai/paperclip/releases/tag/v2026.824.1>
- Adapters: <https://github.com/paperclipai/paperclip/blob/master/docs/adapters/overview.md>
- Heartbeat runtime: <https://github.com/paperclipai/paperclip/blob/master/docs/agents-runtime.md>
- Heartbeat protocol: <https://github.com/paperclipai/paperclip/blob/master/docs/guides/agent-developer/heartbeat-protocol.md>
- Comments and communication: <https://github.com/paperclipai/paperclip/blob/master/docs/guides/agent-developer/comments-and-communication.md>
- Costs and budgets: <https://github.com/paperclipai/paperclip/blob/master/docs/guides/board-operator/costs-and-budgets.md>
- Runtime services: <https://github.com/paperclipai/paperclip/blob/master/docs/guides/board-operator/execution-workspaces-and-runtime-services.md>
- Kanban source: <https://github.com/paperclipai/paperclip/blob/master/ui/src/components/KanbanBoard.tsx>
- Org chart source: <https://github.com/paperclipai/paperclip/blob/master/ui/src/pages/OrgChart.tsx>
- Work products: <https://github.com/paperclipai/paperclip/blob/master/packages/shared/src/validators/work-product.ts>

### Cursor

- Terminal: <https://cursor.com/docs/agent/tools/terminal>
- Cloud Agents: <https://cursor.com/docs/cloud-agent>
- Agents Window: <https://cursor.com/docs/agent/agents-window>
- Subagents: <https://cursor.com/docs/subagents>
- Agent Review: <https://cursor.com/docs/agent/agent-review>
- Bugbot: <https://cursor.com/docs/bugbot>
- Worktrees: <https://cursor.com/docs/configuration/worktrees>
- Models and pricing: <https://cursor.com/docs/models-and-pricing>
- Team pricing: <https://cursor.com/docs/account/teams/pricing>

### Claude Code CLI

- CLI reference: <https://code.claude.com/docs/en/cli-reference>
- Agent teams: <https://code.claude.com/docs/en/agent-teams>
- Cross-session messaging: <https://code.claude.com/docs/en/cross-session-messaging>
- Worktrees: <https://code.claude.com/docs/en/worktrees>
- Subagents: <https://code.claude.com/docs/en/sub-agents>
- Dynamic workflows: <https://code.claude.com/docs/en/workflows>
- Costs: <https://code.claude.com/docs/en/costs>
- Claude pricing: <https://claude.com/pricing>
- `v2.1.246`: <https://github.com/anthropics/claude-code/releases/tag/v2.1.246>
