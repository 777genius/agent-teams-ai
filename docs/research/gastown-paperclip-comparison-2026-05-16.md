# Gastown и Paperclip comparison для лендинга и README

> Дата проверки: 2026-05-16
> Цель: публичная таблица `Agent Teams | Gastown | Paperclip | Cursor | Claude Code CLI` без угадываний по конкурентам.
> Метод: `gh repo view`, `gh api` по первичным GitHub-файлам, официальные docs Cursor и Claude Code, страница Claude pricing.

## Snapshot

| Проект | Позиционирование | Статус на 2026-05-16 | Лицензия |
|---|---|---:|---|
| **Gastown** | multi-agent workspace manager для coding agents | `15,228★`, latest `v1.1.0` от `2026-05-07`, push `2026-05-15` | MIT |
| **Paperclip** | control plane для autonomous AI companies | `65,796★`, latest `v2026.513.0` от `2026-05-13`, push `2026-05-16` | MIT |

## Что изменилось после проверки 2026-05-05

- **Gastown**: свежий GitHub snapshot изменился с `v1.0.1` на `v1.1.0`; README/provider/scheduler факты для публичной таблицы остались валидными.
- **Paperclip**: свежий GitHub snapshot изменился с `v2026.428.0` на `v2026.513.0`; README/adapters/budget/runtime/Kanban facts остались валидными.
- **Claude Code costs**: официальный cost guide теперь называет `/usage` как команду для session token/cost tracking. Поэтому публичная строка `Budget controls` для Claude Code CLI обновлена с `/cost + workspace limits` на `/usage + workspace limits`.
- **Claude pricing**: Team pricing page явно включает Claude Code в Team seats; публичная строка `Claude plan or API usage` остаётся корректной.
- **Cursor**: official docs по Background Agents, Diffs & Review, Bugbot и usage/pricing по-прежнему поддерживают текущие формулировки таблицы. Background Agents остаются remote/async agents on separate branches/VMs with auto-run terminal commands; Bugbot остаётся PR-review product with its own pricing.

## Проверенные публичные формулировки

### Gastown

- README по-прежнему позиционирует Gas Town как workspace manager для Claude Code, GitHub Copilot, Codex, Gemini и других coding agents.
- Provider guide по-прежнему описывает tmux/provider contract для Claude, Gemini, Codex, Cursor, AMP, OpenCode, Copilot и других.
- Scheduler docs по-прежнему подтверждают `scheduler.max_polecats`, deferred dispatch, capacity governor, pause/resume и daemon dispatch cycle.
- Dashboard остаётся monitoring view for agents, convoys, hooks, queues, issues and escalations, а не Kanban product.
- Refinery merge queue есть, но это не hunk-level diff review UI.

Публичная оценка не меняется:

- `Task dependencies` - `✅ Beads DAG waves`
- `Kanban board` - `❌ Dashboard, not Kanban`
- `Per-task code review` - `⚠️ Merge queue, no diff UI`
- `Budget controls` - `⚠️ Cost tiers + digest, no hard caps`

### Paperclip

- README по-прежнему описывает org charts, budgets, governance, goal alignment and agent coordination.
- Adapter overview подтверждает Claude Local, Codex Local, Gemini experimental, OpenCode Local, Cursor, OpenClaw Gateway, Process and HTTP adapters.
- Budget docs подтверждают per-agent monthly budgets, warning threshold at 80%, hard stop at 100%, auto-pause and no more heartbeats.
- Runtime services docs подтверждают manual UI-managed services/jobs and execution workspaces with isolated checkout/branch/runtime state.
- Kanban source по-прежнему содержит `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `cancelled` and `@dnd-kit`.
- Work product validators подтверждают `preview_url`, `runtime_service`, `pull_request`, `branch`, `commit`, `artifact`, `document` and review statuses.

Публичная оценка не меняется:

- `Kanban board` - `✅ 7 columns, drag-and-drop`
- `Per-task code review` - `⚠️ PR/work products, no inline diff`
- `Hunk-level review` - `❌ Bring your own review`
- `Budget controls` - `✅ Per-agent budgets + hard stops`

### Cursor

- Background Agents are asynchronous remote agents that edit/run code in isolated machines, use GitHub branches, support follow-ups and can auto-run terminal commands.
- Diffs & Review still supports diff review with accept/reject flows and selective acceptance.
- Bugbot still focuses on PR review and comments with explanations/fix suggestions; pricing remains separate from normal Cursor subscriptions.
- Usage/pricing docs still describe Free + paid usage, included agent usage by plan, dashboard token/usage breakdowns, background-agent access and spend limits.

Публичная оценка не меняется:

- `Full autonomy` - `⚠️ Background agents, not teams`
- `Hunk-level review` - `✅`
- `Review workflow` - `⚠️ PR/BugBot only`
- `Flexible autonomy` - `⚠️ BG agents auto-run commands`
- `Price` - `Free + paid usage`

### Claude Code CLI

- Agent teams are still experimental and disabled by default through `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`.
- Official docs still confirm shared task list, mailbox, direct teammate messaging, task dependencies, plan approval requests, quality-gate hooks and local team/task storage.
- Agent teams require Claude Code `v2.1.32` or later according to the docs.
- Worktrees remain an official workflow for isolated sessions, but this is not the same as a product-level worktree strategy UI.
- Cost docs now use `/usage` for detailed token usage statistics, plus workspace spend limits and usage reporting in Console for API users.

Публичная оценка после свежей проверки:

- `Agent-to-agent messaging` - `✅ Team mailbox, no UI`
- `Linked tasks` - `✅ Shared task list`
- `Task dependencies` - `✅ Team task deps, no UI`
- `Budget controls` - `⚠️ /usage + workspace limits`
- `Multi-agent backend` - `⚠️ Claude-only experimental teams`

## Источники

- Gastown repo: <https://github.com/gastownhall/gastown>
- Gastown v1.1.0: <https://github.com/gastownhall/gastown/releases/tag/v1.1.0>
- Gastown provider guide: <https://github.com/gastownhall/gastown/blob/main/docs/agent-provider-integration.md>
- Gastown scheduler docs: <https://github.com/gastownhall/gastown/blob/main/docs/design/scheduler.md>
- Paperclip repo: <https://github.com/paperclipai/paperclip>
- Paperclip v2026.513.0: <https://github.com/paperclipai/paperclip/releases/tag/v2026.513.0>
- Paperclip adapters: <https://github.com/paperclipai/paperclip/blob/master/docs/adapters/overview.md>
- Paperclip costs and budgets docs: <https://github.com/paperclipai/paperclip/blob/master/docs/guides/board-operator/costs-and-budgets.md>
- Paperclip runtime services docs: <https://github.com/paperclipai/paperclip/blob/master/docs/guides/board-operator/execution-workspaces-and-runtime-services.md>
- Paperclip Kanban source: <https://github.com/paperclipai/paperclip/blob/master/ui/src/components/KanbanBoard.tsx>
- Paperclip work products source: <https://github.com/paperclipai/paperclip/blob/master/packages/shared/src/validators/work-product.ts>
- Cursor Background Agents: <https://docs.cursor.com/en/background-agents>
- Cursor Diffs & Review: <https://docs.cursor.com/en/agent/review>
- Cursor Bugbot: <https://docs.cursor.com/en/bugbot>
- Cursor usage/pricing: <https://docs.cursor.com/en/account/usage>
- Claude Code agent teams: <https://code.claude.com/docs/en/agent-teams>
- Claude Code subagents: <https://code.claude.com/docs/en/sub-agents>
- Claude Code common workflows: <https://code.claude.com/docs/en/common-workflows>
- Claude Code costs: <https://code.claude.com/docs/en/costs>
- Claude pricing: <https://claude.com/pricing>
