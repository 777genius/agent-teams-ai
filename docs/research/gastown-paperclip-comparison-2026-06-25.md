# Gastown и Paperclip comparison для лендинга и README

> Дата проверки: 2026-06-25, обновлено 2026-07-09
> Цель: публичная таблица `Agent Teams | Gastown | Paperclip | Cursor | Claude Code CLI` без угадываний по конкурентам.
> Метод: `gh repo view`, `gh release list`, `gh api` по первичным GitHub-файлам, официальные docs Cursor и Claude Code, страница Claude pricing.

## Локальная корректировка Agent Teams на 2026-07-09

- `Org chart / governance` для Agent Teams обновлено с `⚠️ Roles + approvals, no org chart` на `✅ Organization map + approvals`.
- Причина: в текущем коде есть полноценная `features/organizations` slice: configurable organization tree, organizations/units/relations DTO, Organization Map tab, edit mode, team placement and manual relations.
- `Budget controls` для Agent Teams обновлено с `⚠️ Cost/token visibility, no hard caps` на `✅ Usage budgets + scheduled hard caps`.
- Причина: token usage budgets поддерживают monthly token/API-equivalent cost limits на global/team/project scopes, а scheduled runs прокидывают `--max-budget-usd` как жёсткий лимит запуска.
- Важно: это не утверждает Paperclip-style per-agent monthly hard stop для всех runtime. Поэтому формулировка намеренно `Usage budgets + scheduled hard caps`, а не `Per-agent budgets + hard stops`.

## Snapshot

| Проект | Позиционирование | Статус на 2026-07-09 | Лицензия |
|---|---|---:|---|
| **Gastown** | multi-agent workspace manager для coding agents | `16,900★`, latest `v1.2.1` от `2026-06-06`, push `2026-07-08` | MIT |
| **Paperclip** | app/control plane для управления work agents | `73,117★`, latest `v2026.707.0` от `2026-07-07`, push `2026-07-09` | MIT |

## Что изменилось после проверки 2026-05-16

- **Gastown**: свежий GitHub snapshot изменился с `v1.1.0` на `v1.2.1`. Основные изменения релизов `v1.2.0`/`v1.2.1` вокруг dependency/runtime hardening, scheduler/polecat operations, daemon recovery, dashboard fixes и startup diagnostics. Публичные claims README/provider/scheduler/dashboard для таблицы остаются валидными.
- **Paperclip**: свежий GitHub snapshot изменился с `v2026.513.0`/`v2026.517.0` на `v2026.707.0`. Важные новые акценты после майской проверки: Skills Store, self-hostable sandbox execution, per-company isolation, workspace file viewer/artifact links, richer attachments и gateway routing for local adapters. Это усиливает Paperclip как control plane, но не делает его встроенным code editor или hunk-review UI.
- **Cursor**: старые ссылки `docs.cursor.com/en/...` теперь редиректят на новый docs hub. Background Agents официально переименованы в **Cloud Agents**. Cursor также документирует **Agents Window worktrees**, поэтому строку `Git worktree isolation` честнее повысить до `✅ Agents Window worktrees`.
- **Claude Code CLI**: official docs теперь описывают agent teams with post-`v2.1.178` behavior and mention later UI behavior through `v2.1.199`. Teams всё ещё experimental и disabled by default через `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, но setup упростился: teammate spawning больше не требует отдельного team setup step, cleanup автоматический. Публичные формулировки таблицы остаются валидными.
- **Claude Code costs/pricing**: `/usage` остаётся основной командой для session token/cost tracking; docs также упоминают plan usage bars, workspace spend limits, `/usage-credits` для Pro/Max usage credits и Console billing для API users. Строка `Claude plan or API usage` остаётся корректной.

## Проверенные публичные формулировки

### Gastown

- README по-прежнему позиционирует Gas Town как workspace manager для Claude Code, GitHub Copilot, Codex, Gemini и других coding agents.
- Provider guide по-прежнему описывает tmux/provider contract для Claude, Gemini, Codex, Cursor, AMP, OpenCode, Copilot и других.
- Scheduler docs подтверждают `scheduler.max_polecats`, direct/deferred dispatch, daemon dispatch cycle, pause/resume, capacity governor и batching.
- Dashboard остаётся monitoring view for agents, convoys, hooks, queues, issues and escalations, а не Kanban product.
- Refinery/merge queue есть, но не нашёл hunk-level diff review UI.

Публичная оценка не меняется:

- `Task dependencies` - `✅ Dependency waves`
- `Kanban board` - `❌ Dashboard, not Kanban`
- `Per-task code review` - `⚠️ Merge queue, no diff UI`
- `Budget controls` - `⚠️ Cost tiers + digest, no hard caps`

### Paperclip

- README по-прежнему описывает org charts, budgets, governance, goal alignment and agent coordination.
- Adapter overview подтверждает Claude Local, Codex Local, Gemini experimental, OpenCode Local, Cursor, Pi, Hermes, OpenClaw Gateway, Process and HTTP adapters.
- Heartbeat protocol подтверждает wake/assignment/comment-driven bounded runs, durable progress через comments/documents/work products и run liveness.
- Budget docs подтверждают per-agent monthly budgets, warning threshold at 80%, hard stop at 100%, auto-pause and no more heartbeats.
- Runtime services docs подтверждают manual UI-managed services/jobs and execution workspaces with isolated checkout/branch/runtime state.
- Kanban source по-прежнему содержит `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `cancelled` and `@dnd-kit`.
- Work product validators подтверждают `preview_url`, `runtime_service`, `pull_request`, `branch`, `commit`, `artifact`, `document` and review statuses.

Публичная оценка почти не меняется:

- `Task attachments` - `✅ Docs, attachments, work products`
- `Kanban board` - `✅ 7 columns, drag-and-drop`
- `Per-task code review` - `⚠️ PR/work products, no inline diff`
- `Hunk-level review` - `❌ Bring your own review`
- `Budget controls` - `✅ Per-agent budgets + hard stops`

### Cursor

- Cloud Agents run in isolated cloud VMs, clone repos, work on separate branches, can run/build/test/control browser/desktop, support MCP, and can be launched from web, desktop, Slack, GitHub/Bitbucket, Linear or API.
- Cursor docs explicitly say Cloud Agents were formerly called Background Agents.
- Worktrees docs say the Agents Window can create isolated Git checkouts per agent/task; this supports upgrading the public cell from `⚠️ Background branches/VMs` to `✅ Agents Window worktrees`.
- Agent Review is now the live official docs page for dedicated local review. Bugbot remains PR-review oriented and can run automatically or manually on PR updates.
- Pricing docs still support `Free + paid usage`; team docs add paid seats, included usage, on-demand usage, team-wide spending limits and Enterprise per-member spend limits.

Публичная оценка после свежей проверки:

- `Full autonomy` - `⚠️ Cloud agents, not teams`
- `Review workflow` - `⚠️ PR/BugBot only`
- `Git worktree isolation` - `✅ Agents Window worktrees`
- `Flexible autonomy` - `⚠️ Cloud agents run commands`
- `Budget controls` - `⚠️ Usage + cloud spend limits`
- `Price` - `Free + paid usage`

### Claude Code CLI

- Agent teams still experimental and disabled by default through `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`.
- Official docs confirm shared task list, mailbox, direct teammate messaging, task dependencies, plan approval requests, quality-gate hooks and local team/task storage.
- Agent teams docs describe post-`v2.1.178` behavior and mention later UI behavior through `v2.1.199`: teammate spawning no longer needs a separate setup step, cleanup happens automatically, `teammateMode` defaults to in-process unless configured otherwise.
- Worktrees remain an official workflow for isolated sessions, but this is not a desktop/product-level worktree strategy UI.
- Cost docs use `/usage` for detailed token usage statistics and mention workspace spend limits, Console usage reporting, and `/usage-credits` for Pro/Max usage credits.

Публичная оценка не меняется:

- `Agent-to-agent messaging` - `✅ Team mailbox, no UI`
- `Linked tasks` - `✅ Shared task list`
- `Task dependencies` - `✅ Team task deps, no UI`
- `Budget controls` - `⚠️ /usage + workspace limits`
- `Mixed AI teammates` - `⚠️ Claude-only experimental teams`

## Источники

- Agent Teams organizations feature: `src/features/organizations/README.md`
- Agent Teams organizations DTOs: `src/features/organizations/contracts/dto.ts`
- Agent Teams token usage budget DTOs: `src/features/token-usage/contracts/dto.ts`
- Agent Teams scheduled budget cap: `src/main/services/schedule/ScheduledTaskExecutor.ts`
- Gastown repo: <https://github.com/gastownhall/gastown>
- Gastown v1.2.1: <https://github.com/gastownhall/gastown/releases/tag/v1.2.1>
- Gastown provider guide: <https://github.com/gastownhall/gastown/blob/main/docs/agent-provider-integration.md>
- Gastown scheduler docs: <https://github.com/gastownhall/gastown/blob/main/docs/design/scheduler.md>
- Gastown dashboard source: <https://github.com/gastownhall/gastown/blob/main/internal/web/templates/convoy.html>
- Paperclip repo: <https://github.com/paperclipai/paperclip>
- Paperclip v2026.707.0: <https://github.com/paperclipai/paperclip/releases/tag/v2026.707.0>
- Paperclip adapters: <https://github.com/paperclipai/paperclip/blob/master/docs/adapters/overview.md>
- Paperclip heartbeat protocol: <https://github.com/paperclipai/paperclip/blob/master/docs/guides/agent-developer/heartbeat-protocol.md>
- Paperclip org chart: <https://paperclip.inc/docs/guides/board-operator/org-structure/>
- Paperclip OrgChart source: <https://github.com/paperclipai/paperclip/blob/master/ui/src/pages/OrgChart.tsx>
- Paperclip costs and budgets docs: <https://github.com/paperclipai/paperclip/blob/master/docs/guides/board-operator/costs-and-budgets.md>
- Paperclip runtime services docs: <https://github.com/paperclipai/paperclip/blob/master/docs/guides/board-operator/execution-workspaces-and-runtime-services.md>
- Paperclip Kanban source: <https://github.com/paperclipai/paperclip/blob/master/ui/src/components/KanbanBoard.tsx>
- Paperclip work products source: <https://github.com/paperclipai/paperclip/blob/master/packages/shared/src/validators/work-product.ts>
- Cursor Cloud Agents: <https://cursor.com/docs/cloud-agent>
- Cursor Agent Review: <https://cursor.com/docs/agent/agent-review>
- Cursor Bugbot: <https://cursor.com/docs/bugbot>
- Cursor worktrees: <https://cursor.com/docs/configuration/worktrees>
- Cursor Models & Pricing: <https://cursor.com/docs/models-and-pricing>
- Cursor Team Pricing: <https://cursor.com/docs/account/teams/pricing>
- Claude Code agent teams: <https://code.claude.com/docs/en/agent-teams>
- Claude Code subagents: <https://code.claude.com/docs/en/sub-agents>
- Claude Code common workflows: <https://code.claude.com/docs/en/common-workflows>
- Claude Code costs: <https://code.claude.com/docs/en/costs>
- Claude pricing: <https://claude.com/pricing>
