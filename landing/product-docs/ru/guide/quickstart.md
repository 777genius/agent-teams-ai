---
title: Быстрый старт – Документация Agent Teams
description: От свежей установки до запущенной команды AI-агентов за несколько минут. Установка, выбор рантайма, создание команды и первый код-ревью.
lang: ru-RU
---

# Быстрый старт

Этот гайд проводит от свежей установки до первой запущенной команды за несколько минут.

## Предварительные требования

Перед началом убедитесь, что у вас есть:

- **macOS, Windows или Linux** машина
- **Git-репозиторий** в качестве проекта (рекомендуется для diff review и worktree isolation)
- Бесплатная модель без авторизации для первого запуска или доступ к провайдеру, если нужны дополнительные модели: Anthropic (Claude), OpenAI (Codex), OpenRouter (OpenCode) или Google (Gemini)
- Node.js 24.16.0 LTS и pnpm 10+ при запуске из исходников

Подробности и ссылки для скачивания — в разделе [Установка](/ru/guide/installation).

## 1. Установите Agent Teams

Скачайте последний релиз под вашу платформу на <a href="/ru/download/" target="_self">странице загрузок</a> или в [GitHub releases](https://github.com/777genius/agent-teams-ai/releases).

::: tip
Приложение бесплатное и с открытым кодом. Можно начать с бесплатной модели без авторизации - без регистрации; дополнительные runtime/provider paths могут требовать доступ к провайдеру. Подробности в разделе [Установка](/ru/guide/installation).
:::

::: info
Desktop-приложение — основной продукт. Agent Teams также работает в браузере для разработки, но браузерный режим не имеет полного desktop IPC, терминала, provider auth и lifecycle. Для обычной разработки используйте `pnpm dev` (Electron), а не браузерный режим.
:::

## 2. Откройте проект

Запустите приложение и выберите директорию проекта, где агенты будут работать. Agent Teams читает локальные файлы проекта и runtime/session state, чтобы показывать задачи, логи, diffs и активность команды.

::: tip
Выберите проект под Git — так вы получите лучший опыт. Изоляция через worktree и ревью по diff зависят от Git.
:::

Перед запуском команды проверьте базовое состояние проекта:

```bash
git status --short
```

Не обязательно иметь идеально чистое дерево, но важно понимать, какие изменения уже были вашими до старта агентов. Так проще доверять task diffs и hunk-level review.

## 3. Выберите runtime

Мастер настройки автоматически определит установленные рантаймы на вашей машине. Стандартные варианты:

| Runtime  | Когда подходит                                                      |
| -------- | ------------------------------------------------------------------- |
| Claude   | Если вы уже используете Claude Code или у вас есть Anthropic access |
| Codex    | Для Codex-native workflows и OpenAI access                          |
| OpenCode | Бесплатная модель без авторизации, multi-model команды и много provider backends |

::: info
Gemini — поддерживаемый провайдер. Варианты auth смотрите в разделе [Провайдеры и рантаймы](/ru/reference/providers-runtimes).
:::

Подробная настройка каждого провайдера — в разделе [Настройка рантайма](/ru/guide/runtime-setup).

Чтобы проверить платный или account-backed runtime вне приложения, запустите соответствующую команду версии:

```bash
claude --version
codex --version
opencode --version
```

Если команда падает в терминале, сначала исправьте runtime installation или `PATH`. Team prompts не смогут компенсировать отсутствующий binary или provider auth для моделей, которым он нужен.

Также можно проверить, что бинарник доступен в `PATH`:

```bash
command -v claude
command -v codex
command -v opencode
```

Если `command -v` ничего не выводит, рантайм не установлен или отсутствует в `PATH`.

## 4. Создайте первую команду

Начните с маленькой команды: lead, implementation agent и review-oriented agent. Этого достаточно, чтобы проверить workflow без лишнего шума.

Рекомендованная структура и советы — в разделе [Создание команды](/ru/guide/create-team).

Для первого запуска используйте примерно такую структуру:

| Member | Responsibility | Notes |
| --- | --- | --- |
| Lead | Делит цель на tasks и координирует status | Держите на самом надёжном provider |
| Builder | Реализует scoped tasks | Дайте понятные file или feature boundaries |
| Reviewer | Проверяет завершённую работу | Попросите фокусироваться на regressions и missing tests |

Не начинайте сразу с пяти и более teammates. Больше агентов означает больше concurrency, logs, provider usage и риск конфликтов до того, как вы убедились, что setup здоровый.

## 5. Дайте lead-агенту конкретную цель

Пишите задачу как инженерному лиду:

```text
Улучши onboarding flow. Разбей работу на задачи, держи изменения маленькими и проси review перед широкими рефакторингами.
```

Хороший первый prompt содержит scope, safety boundaries и verification:

```text
Improve the docs quickstart. Keep edits inside landing/product-docs. Add practical examples, preserve existing VitePress syntax, and run `pnpm --dir landing docs:build` before marking tasks done.
```

Избегайте размытых prompts вроде "make the app better" для первого запуска. Lead может дробить большие цели, но хороший input даёт более маленькие tasks и чище review.

Lead создаёт задачи, назначает работу и координирует teammates. Вы следите за прогрессом на канбан-доске и вмешиваетесь через комментарии или direct messages в любой момент.

## 6. Проверьте результат

Откройте задачи в review/done, посмотрите diff, примите или отклоните изменения. Если нужно понять мотивацию агента, откройте task logs.

Полный процесс ревью — в разделе [Код-ревью](/ru/guide/code-review).

Перед approval первой task проверьте три вещи:

1. Task comment объясняет, что изменилось
2. Изменённые файлы совпадают со scope задачи
3. Verification result виден в task comment или logs

## Частые проблемы

| Симптом | Вероятная причина | Что проверить |
| --- | --- | --- |
| Приложение не видит runtime | Бинарник не в `PATH` или разные окружения у приложения и терминала | Запустите `command -v <runtime>` в терминале |
| Запуск команды зависает | Нет provider auth для платной/account модели, неверная модель или runtime не найден | Раздел [Диагностика](/ru/guide/troubleshooting#team-does-not-launch) |
| OpenCode lane в статусе `registered` | Lane evidence ещё не зафиксирован или несовпадение модели | Проверьте `~/.claude/teams/<team>/.opencode-runtime/lanes/` |
| Ответы агента не приходят | Runtime delivery retry, parsing или task attribution | Откройте task logs и проверьте delivery ledger |
| Провайдер возвращает 429 | Достигнут лимит запросов | Дождитесь сброса или смените модель/провайдера |

## Дальше

- [Создание команды](/ru/guide/create-team) — рекомендованные структуры и написание brief
- [Настройка рантайма](/ru/guide/runtime-setup) — авторизация провайдеров и выбор моделей
- [Код-ревью](/ru/guide/code-review) — ревью, одобрение и запрос правок

### Для разработчиков

- [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) — навигация по репозиторию
- [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) — рабочие конвенции
- [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) — жёсткие правила
- [Feature architecture standard](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) — структура фич
- [Runbook отладки](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) — диагностика запуска
