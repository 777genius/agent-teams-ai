---
title: Разработчикам – Agent Teams Docs
description: Входная страница для contributor docs, архитектуры, guardrails, debugging и MCP extension paths в Agent Teams.
---

# Разработчикам

Эта страница нужна, когда вы меняете Agent Teams, разбираете зависший запуск команды или расширяете runtime через MCP tools. Ссылки ведут в canonical repo docs, чтобы правила реализации не расходились между страницами.

## С чего начать

| Нужно | Открыть |
| --- | --- |
| Обзор репозитория, scripts и setup из исходников | [README.md](https://github.com/777genius/agent-teams-ai/blob/main/README.md) |
| Рабочие правила для агентов и contributors | [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) |
| Жёсткие implementation guardrails | [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) |
| Структура medium и large features | [Feature architecture standard](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) |
| Debugging launch, bootstrap и teammate messaging | [Agent team debugging runbook](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) |
| Contribution process | [Contributing guide](https://github.com/777genius/agent-teams-ai/blob/main/.github/CONTRIBUTING.md) |
| Приватность и модель данных | [Privacy and local data](/ru/reference/privacy-local-data) |
| Релизы / Changelog | [RELEASE.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) — [CHANGELOG.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md) |

## Локальный development path

Для обычной разработки запускайте desktop Electron app:

```bash
pnpm install
pnpm dev
```

Browser/web path не заменяет desktop runtime. Desktop mode - поддерживаемый локальный путь, потому что в нём есть IPC, terminals, provider auth, team lifecycle handling, launch diagnostics и runtime bridges, которые используют реальные команды.

## Architecture checkpoints

Перед изменением feature определите её границу:

| Область | Ожидаемое место |
| --- | --- |
| Medium или large product feature | `src/features/<feature-name>/` |
| Electron main process orchestration | `src/main/` |
| Preload-safe API surface | `src/preload/` |
| Renderer UI и app state | `src/renderer/` |
| Shared types и pure helpers | `src/shared/` |
| Agent Teams board MCP server | `mcp-server/` |
| Board data controller | `agent-teams-controller/` |

Используйте `src/features/recent-projects` как reference slice для feature organization. Держите cross-process contracts явными и не делайте deep imports через feature boundaries.

## Debugging path

Для launch hangs, OpenCode `registered` / bootstrap-unconfirmed states, missing teammate replies или suspicious task logs:

1. Начните с [debugging runbook](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md).
2. Проверьте самый новый artifact pack в `~/.claude/teams/<team>/launch-failure-artifacts/latest.json`.
3. Откройте `manifest.json` и посмотрите `classification`, bootstrap breadcrumbs, launch diagnostics, member spawn statuses и redacted log tails.
4. Очищайте только team, run, pane или process, который точно принадлежит smoke test или failed launch.

## MCP development path

Agent Teams использует встроенный MCP server `agent-teams` для board operations. User и project MCP servers добавляют внешние capabilities для runtimes. См. [MCP integration](/ru/guide/mcp-integration) для setup examples, структуры `.mcp.json` и tool registration guidance.

## Related docs

- [Архитектура для контрибьюторов](/ru/reference/contributor-architecture)
- [Настройка рантайма](/ru/guide/runtime-setup)
- [MCP интеграция](/ru/guide/mcp-integration)
- [Диагностика](/ru/guide/troubleshooting)
