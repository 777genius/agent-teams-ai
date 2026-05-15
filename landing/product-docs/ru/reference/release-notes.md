---
title: Релизы – Документация Agent Teams
description: Release notes и changelog для Agent Teams. Ссылки на канонические RELEASE.md и CHANGELOG.md.
lang: ru-RU
---

# Релизы

Текущий релиз: **v1.2.0** (2026-03-31). Активная разработка продолжается в ветке `main` с незарелизенными изменениями для member work-sync, OpenCode delivery hardening и CI stabilization.

## Как публикуются релизы

Agent Teams следует [Semantic Versioning](https://semver.org/). Пуш тега в репозиторий запускает автоматический [release workflow](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md), который собирает подписанные пакеты для macOS, Windows и Linux и публикует их в GitHub Releases.

## Последние релизы

### v1.2.0 — Agent Graph, per-team tool approval, interactive AskUserQuestion

Agent Graph с force-directed визуализацией и kanban layout, per-team tool approval controls с понятными permission prompts, уведомления о комментариях к задачам и интерактивные AskUserQuestion кнопки. Permission system overhaul с Write/Edit/NotebookEdit seeding и MCP tool catalog. Полный [changelog](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#120---2026-03-31).

### v1.1.0 — React 19 + Electron 40, user-initiated task starts

React 19 + Electron 40 migration, запуск задач пользователем с kanban board, auth troubleshooting guide, подсветка синтаксиса для R/Ruby/PHP/SQL, ускорение поиска транскриптов в 3 раза, исправления WSL/Windows paths и XSS vulnerability. Полный [changelog](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#110---2026-03-25).

### v1.0.0 — Первый публичный релиз

Первый стабильный билд: надёжность CLI/auth в packaged apps, IPC hardening, cross-platform packaging с подписанными macOS сборками, open-source governance docs (LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY). Полный [changelog](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#100---2026-03-23).

## Канонические источники

| Документ | Описание |
| --- | --- |
| [RELEASE.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) | Процесс релиза, версионирование, имена артефактов, auto-update setup и шаблон release notes. |
| [CHANGELOG.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md) | Полный changelog со всеми версиями, фичами, улучшениями и исправлениями. |
| [GitHub Releases](https://github.com/777genius/agent-teams-ai/releases) | Установочные файлы для всех платформ. |

## Связанные страницы

- [Установка](/ru/guide/installation)
- [Быстрый старт](/ru/guide/quickstart)
- [Архитектура для контрибьюторов](/ru/reference/contributor-architecture)
- [Разработчикам](/ru/developers/)
