---
title: Быстрый старт – Документация Agent Teams
description: От свежей установки до запущенной команды AI-агентов за несколько минут. Установка, выбор рантайма, создание команды и первый код-ревью.
lang: ru-RU
---

# Быстрый старт

Этот гайд проводит от свежей установки до первой запущенной команды за несколько минут.

## 1. Установите Agent Teams

Скачайте последний релиз под вашу платформу на <a href="/ru/download/" target="_self">странице загрузок</a> или в [GitHub releases](https://github.com/777genius/agent-teams-ai/releases).

::: tip
Приложение бесплатное и с открытым кодом. Выбранный runtime может требовать доступ к провайдеру — подробности в разделе [Установка](/ru/guide/installation).
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
| OpenCode | Для multi-model команд и большого числа provider backends           |

::: info
Gemini — поддерживаемый провайдер. Варианты auth смотрите в разделе [Провайдеры и рантаймы](/ru/reference/providers-runtimes).
:::

Подробная настройка каждого провайдера — в разделе [Настройка рантайма](/ru/guide/runtime-setup).

Чтобы проверить выбранный runtime вне приложения, запустите соответствующую команду версии:

```bash
claude --version
codex --version
opencode --version
```

Если команда падает в терминале, сначала исправьте runtime installation или `PATH`. Team prompts не смогут компенсировать отсутствующий binary или provider auth.

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

## Дальше

- [Создание команды](/ru/guide/create-team) — рекомендованные структуры и написание brief
- [Настройка рантайма](/ru/guide/runtime-setup) — авторизация провайдеров и выбор моделей
- [Код-ревью](/ru/guide/code-review) — ревью, одобрение и запрос правок
