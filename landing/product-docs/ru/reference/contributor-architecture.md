---
title: Архитектура для контрибьюторов – Документация Agent Teams
description: Карта для контрибьюторов по feature layout, runtime/provider boundaries, hard guardrails и canonical architecture docs.
lang: ru-RU
---

# Архитектура для контрибьюторов

Эта страница - карта для контрибьюторов. Она ведёт к canonical repo guidance и не дублирует все implementation rules.

## Канонические источники

Используйте эти файлы как source of truth при изменениях в приложении:

| Нужно | Канонический источник |
| --- | --- |
| Обзор репозитория и команды | [README.md](https://github.com/777genius/agent-teams-ai/blob/main/README.md) |
| Локальные рабочие conventions | [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) |
| Жёсткие guardrails | [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) |
| Layout средних и больших features | [docs/FEATURE_ARCHITECTURE_STANDARD.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) |
| Диагностика запуска agent teams | [docs/team-management/debugging-agent-teams.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) |

## Feature layout

Средние и большие features должны жить в `src/features/<feature-name>/` и следовать feature architecture standard. Держите internals за public entrypoints и не делайте deep imports через границы feature.

Для новой работы ориентируйтесь на существующий slice `src/features/recent-projects`. Маленькие fixes можно оставлять рядом с текущим code path, если новый feature slice добавит больше структуры, чем пользы.

## Runtime и provider boundaries

Agent Teams отвечает за orchestration: teams, tasks, messages, launch state, review UI, diagnostics и local persistence.

Выбранный runtime/provider path отвечает за model execution, auth, model availability, rate limits, tool semantics и runtime-specific transcript evidence. Не пытайтесь чинить prompts или UI state вместо missing auth, missing binaries, rejected model ids или provider outages. User-facing детали настройки смотрите в [Провайдерах и рантаймах](/ru/reference/providers-runtimes).

## Диагностика agent teams

При launch hangs, OpenCode `registered` / bootstrap-unconfirmed states, missing teammate replies или подозрительных task logs начинайте с dedicated debugging runbook. Сначала смотрите newest launch failure artifact в `~/.claude/teams/<team>/launch-failure-artifacts/latest.json`, затем сопоставляйте UI state с persisted files и runtime-specific evidence.

Не делайте broad cleanup во время диагностики. Останавливайте только process, lane, team или smoke run, который точно относится к проблеме.

## Contributor conventions

- Используйте `pnpm dev` для desktop Electron app при обычной разработке.
- Не используйте browser dev mode как замену desktop runtime, IPC, terminal, provider auth или team lifecycle behavior.
- Разделяйте ответственности Electron main, preload, renderer, shared и features.
- Используйте `wrapAgentBlock(text)` для agent-only blocks вместо ручной склейки markers.
- Предпочитайте focused verification. Избегайте broad `lint:fix` или formatting churn, если задача не про formatting.
- Parsing, task lifecycle, provider/runtime detection, persistence, IPC, Git и review flows считайте high-risk зонами, где нужны targeted tests или clear verification path.

## Связанные страницы

- [Настройка рантайма](/ru/guide/runtime-setup)
- [Диагностика](/ru/guide/troubleshooting)
- [Код-ревью](/ru/guide/code-review)
- [Приватность и локальные данные](/ru/reference/privacy-local-data)
