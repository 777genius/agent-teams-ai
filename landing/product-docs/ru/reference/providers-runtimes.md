---
title: Провайдеры и рантаймы – Документация Agent Teams
description: Поддерживаемые runtime paths (Claude Code, Codex, OpenCode), provider IDs, модели, multi-provider стратегии и capability checks.
lang: ru-RU
---

# Провайдеры и рантаймы

Agent Teams отделяет orchestration от model access. Приложение управляет teams, tasks, messages, launch state и review UI; выбранный runtime/provider path выполняет реальную model work.

## Что даёт приложение

Agent Teams даёт:

- orchestration команд и задач
- kanban board UI
- teammate messaging
- task logs
- review UI
- local project integration
- runtime detection и capability checks
- local logs и diagnostics

## Что даёт runtime

Runtime отвечает за:

- model execution
- provider authentication
- tool execution behavior
- rate limits и capabilities конкретной модели
- runtime-specific transcripts и delivery evidence

## Поддерживаемые runtime paths

| Runtime path | Provider/model path | Когда подходит | Заметки |
| --- | --- |
| Claude Code | Anthropic / Claude models | Для Claude Code users и Anthropic-backed workflows | Базовый local-first путь для Claude teams. Нужен локально доступный runtime и account access. |
| Codex | Codex / OpenAI-backed models | Для Codex-native workflows | Использует Codex runtime integration и Codex auth/account state, когда они доступны. Часть diagnostics отличается от Claude transcripts. |
| OpenCode | OpenCode-managed model routing | Для multi-provider teams и широкой model coverage | OpenCode может маршрутизировать через множество model providers. Agent Teams считает OpenCode lanes runtime-specific evidence и не угадывает attribution при ambiguous lane identity. |


## Provider ids

В team/runtime configuration приложение сейчас распознаёт такие provider ids:

| Provider id | Смысл |
| --- | --- |
| `anthropic` | Anthropic / Claude Code path |
| `codex` | Codex path |
| `opencode` | OpenCode path, включая OpenCode-managed provider routing |

Эта таблица не гарантирует, что каждый provider authenticated, installed или доступен для каждой модели на каждой машине. Runtime status и capability checks - source of truth для конкретного launch.

## Model ids

Model ids передаются в выбранный runtime. Agent Teams не переписывает provider model catalog в универсальную naming scheme.

Примеры:

| Provider path | Example model id | Notes |
| --- | --- | --- |
| Claude Code | `opus`, `sonnet` или full Claude model id | Availability зависит от Claude Code и account access |
| Codex | `gpt-5.4`, `gpt-5.3-codex` | Availability приходит из Codex account/runtime state |
| OpenCode | `openrouter/moonshotai/kimi-k2.6` | Prefix должен совпадать с OpenCode provider configuration |

Если model name rejected, сначала проверьте его прямо в runtime/provider. Изменение team brief не заставит unavailable model запуститься.

## Multi-provider strategy

Agent Teams остаётся provider-aware, но не provider-owned:

- teams, tasks, inboxes, comments, review state и launch diagnostics хранятся в local Agent Teams storage
- каждый member может нести provider/model settings через team launch metadata
- model availability, auth, rate limits и tool behavior остаются ответственностью runtime/provider
- OpenCode - основной путь, когда одной team нужны разные provider/model lanes

Contributor-facing границы и canonical implementation guidance смотрите в [Архитектуре для контрибьюторов](/ru/reference/contributor-architecture).

Рекомендуемые patterns:

| Pattern | When it helps | Risk |
| --- | --- | --- |
| One provider for all members | First launch, sensitive repos, simplest debugging | Shared rate limits могут остановить всю team |
| Strong lead + cheaper builders | Planning/review остаются надёжными, implementation дешевле | Builder output может требовать более строгого review |
| Separate builder and reviewer models | Ловит model-specific blind spots | Больше setup и attribution для проверки |

## Стоимость providers

Agent Teams бесплатен и open source. Можно начать со встроенной бесплатной модели без авторизации - без регистрации, API-ключей и карты. Платный или account-backed provider usage зависит от выбранного runtime/provider: subscription limits, API keys, account auth, rate limits и provider policies остаются внешними для приложения.

## Capability checks

Во время setup приложение может выполнять access и capability checks. Это помогает найти отсутствующую авторизацию до того, как team launch застрянет в provisioning.

Capability checks могут показать, что provider существует, но не authenticated; model list недоступен; runtime path отсутствует; или конкретная extension capability unsupported. Считайте это setup diagnostics, а не task failures.

Типичные setup fixes:

| Check result | What to do |
| --- | --- |
| Runtime missing | Установить CLI или исправить `PATH` |
| Provider unauthenticated | Запустить provider login flow или добавить нужный API key |
| Model unavailable | Выбрать model, которая видна в model list этого runtime |
| Capability unsupported | Использовать другой runtime path для этого teammate |

## Ожидаемые ограничения

- Runtime support не означает одинаковый feature parity для Claude Code, Codex и OpenCode.
- Log и transcript coverage отличаются по runtime.
- Для OpenCode lanes нужна стабильная lane/session evidence, прежде чем app сможет безопасно attribute runtime logs.
- Provider model names и availability могут меняться вне приложения.
- Team prompt не исправит missing auth, missing PATH entries, provider outages или exhausted rate limits.
