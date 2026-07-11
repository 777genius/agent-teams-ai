---
title: Настройка рантайма – Документация Agent Teams
description: Конфигурация Claude Code, Codex или OpenCode. Авторизация, провайдеры, multimodel mode и предзапусковые проверки.
lang: ru-RU
---

# Настройка рантайма

Agent Teams - координационный слой. Работа моделей выполняется через локальные рантаймы и провайдеры.

## Предварительные требования

Перед запуском команды убедитесь, что:

- Runtime binary установлен и находится в `PATH`.
- Ваш аккаунт провайдера имеет доступ к выбранной модели, если вы не начинаете со встроенной OpenCode-модели без авторизации.
- Путь к проекту существует и доступен для чтения.
- Приложение и терминал используют одинаковое home/config окружение, когда вы вручную проверяете auth.

::: tip
Начните с одного teammate и одного провайдера. Подтвердите запуск одной команды, прежде чем добавлять multimodel lanes.
:::

Быстрые terminal checks:

```bash
command -v claude
command -v codex
command -v opencode
```

Запускайте команду для runtime, который планируете использовать. Если вывода нет, установите runtime или исправьте `PATH` до запуска команды.

## Поддерживаемые пути

| Путь | CLI по умолчанию | Типичные провайдеры | Когда использовать |
|------|-------------------|---------------------|-------------------|
| Claude | `claude` | Anthropic | Если вы уже используете Claude Code или Anthropic access |
| Codex | `codex` | OpenAI | Для Codex-native workflows и OpenAI access |
| OpenCode | `opencode` | OpenRouter и многие другие | Для multimodel routing и широкой provider coverage |

Приложение по возможности определяет доступные runtimes и ведёт настройку через UI.


## Доступ к провайдеру

У Agent Teams нет своего платного тарифа. Можно начать со встроенной OpenCode-модели без авторизации - без регистрации, API-ключей и карты. Для дополнительных моделей используйте доступ к провайдеру, который у вас уже есть: подписка, локальная авторизация рантайма или API-ключи в зависимости от выбранного пути.

- Для **Claude** и **Codex** используется auth соответствующего CLI.
- **OpenCode** может сначала работать через встроенную бесплатную модель без авторизации. Другие OpenCode-модели могут требовать provider-specific API keys в файле конфигурации (например, `openrouter`, `openai`, `anthropic`).

## Настройка авторизации

### Claude Code

Запустите стандартный auth flow в терминале:

```bash
claude login
```

Затем проверьте, что CLI доступен:

```bash
claude --version
```

Если packaged app пишет "not logged in", хотя терминал работает, сравните `$HOME` и `PATH`, которые видит приложение, с терминалом, где вы делали login. Auth diagnostic log из [Диагностики](/ru/guide/troubleshooting#диагностический-лог-авторизации) - лучшая стартовая точка.

### Codex

Установите и авторизуйтесь через CLI OpenAI:

```bash
codex login
```

Затем проверьте, что runtime доступен:

```bash
codex --version
```

Codex-native launches используют Codex account state и model catalog data, когда они доступны. Если model не видна в UI, обновите provider status до редактирования team prompts.

### OpenCode

Для встроенной бесплатной модели без авторизации достаточно выбрать её в приложении и запустить без регистрации у провайдера. Для других OpenCode backend создайте или отредактируйте `~/.opencode/config.json` (или эквивалентный путь на вашей платформе):

```json
{
  "providers": {
    "openrouter": {
      "apiKey": "sk-or-..."
    }
  }
}
```

Используйте точное имя провайдера, которое ожидает OpenCode. Если вы используете кастомное имя, убедитесь, что оно совпадает с provider ID в строке модели (например, `openrouter/moonshotai/kimi-k2.6` использует блок `openrouter`).

Примеры model strings:

| Model string | Provider block, который должен существовать |
| --- | --- |
| `openrouter/moonshotai/kimi-k2.6` | `openrouter` |
| `openai/gpt-5.4` | `openai` |
| `anthropic/claude-sonnet-4-6` | `anthropic` |

Если OpenCode запускается, но teammate не становится deliverable, сначала смотрите lane evidence, а не предполагаете, что model проигнорировала prompt. См. [Диагностика](/ru/guide/troubleshooting#opencode-registered-но-bootstrap-не-подтверждён).

## Multimodel-режим

Multimodel-режим может направлять работу через разные provider backends в OpenCode-совместимой конфигурации. Используйте его, когда нужна гибкость провайдеров или разные model lanes для teammates.

::: info Model lanes
Каждый teammate может использовать свою пару `providerId` + `model`. В UI редактирования команды разверните опции member, чтобы переопределить глобальные значения.
:::

Консервативный multimodel setup:

| Role | Provider | Why |
| --- | --- | --- |
| Lead | Claude или Codex | Держит coordination на самом надёжном provider |
| Builder | OpenCode | Даёт broad model routing для implementation work |
| Reviewer | Claude, Codex или второй OpenCode model | Отделяет review judgment от builder lane |

Не смешивайте много незнакомых providers в первом launch. Подтвердите одну маленькую task на каждую lane до broad work.

## Чеклист перед запуском

Перед запуском команды:

1. Выбранный runtime установлен
2. Binary runtime находится в environment `PATH`
3. Auth провайдера настроен для выбранного backend
4. Провайдер имеет доступ к точной строке модели
5. Путь к проекту существует и доступен для чтения

## Когда менять runtime path

Меняйте путь, когда текущий упирается в availability модели, rate limits, provider capabilities или роли команды. После смены проверьте одну маленькую задачу.

::: warning Считайте ошибки setup setup-проблемами
Если auth падает, имя модели отклонено или binary runtime не найден — сначала исправьте настройку. Не меняйте team prompts или код проекта, чтобы обойти проблему конфигурации рантайма.
:::

Используйте эту таблицу решений:

| Symptom | Better first action |
| --- | --- |
| Binary not found | Исправить installation или `PATH` |
| Login работает в terminal, но не app | Проверить Electron auth diagnostic log и environment |
| Model rejected | Проверить точный model id в provider runtime |
| Repeated 429s | Уменьшить concurrency или сменить model/provider |
| OpenCode lane stuck | Проверить lane manifest и `opencode-sessions.json` |
