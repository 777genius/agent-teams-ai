---
title: Установка – Документация Agent Teams
description: Скачать и установить Agent Teams для macOS, Windows или Linux. Готовые сборки, запуск из source, автообновления и требования.
lang: ru-RU
---

# Установка

Agent Teams распространяется как desktop-приложение для macOS, Windows и Linux.

## Готовые сборки

Скачайте приложение на <a href="/ru/download/" target="_self">странице загрузок</a> или из последнего [GitHub release](https://github.com/777genius/agent-teams-ai/releases):

- macOS Apple Silicon: `.dmg`
- macOS Intel: `.dmg`
- Windows: `.exe`
- Linux: `.AppImage`, `.deb`, `.rpm` или `.pacman`

::: warning Windows SmartScreen
Новые open-source приложения могут вызывать SmartScreen. Если вы доверяете источнику релиза, выберите **More info**, затем **Run anyway**.
:::

## Требования

Пакетная сборка рассчитана на zero-setup onboarding. Можно начать с бесплатной модели без авторизации - без регистрации, API-ключей и карты. Если нужны дополнительные модели, приложение само помогает с runtime detection и provider authentication.

Для платных или account-backed моделей подключите хотя бы один провайдер:

| Провайдер          | Способ доступа                                             |
| ------------------ | ---------------------------------------------------------- |
| Claude (Anthropic) | Claude Code CLI login или API key                          |
| Codex (OpenAI)     | Codex CLI login или API key                                |
| OpenCode           | Встроенная бесплатная модель без авторизации или API key для поддерживаемого бэкенда (например, OpenRouter) |


Для запуска из исходников также нужны:

| Инструмент | Версия |
| ---------- | ------ |
| Node.js    | 24.16.0 LTS |
| pnpm       | 10+    |

На macOS официальные prebuilt-бинарники Node.js 24 требуют macOS 13.5+.

## Запуск из исходников

<InstallBlock command="git clone https://github.com/777genius/agent-teams-ai.git && cd agent-teams-ai && pnpm install && pnpm dev" label="Скопировать" copied-label="Скопировано" />

```bash
git clone https://github.com/777genius/agent-teams-ai.git
cd agent-teams-ai
pnpm install
pnpm dev
```

`pnpm dev` запускает desktop Electron-приложение с hot reload. Это основной режим разработки — не используйте браузерный dev-сервер. Браузерный режим не имеет полного desktop IPC, терминала, provider auth и lifecycle команд.

Ветка `main` содержит актуальную стабильную разработку. Переключайтесь на feature-ветки, только если нужна конкретная неопубликованная правка.

## Автообновления

Пакетная сборка автоматически проверяет обновления при запуске и периодически во время работы. Когда обновление доступно, приложение предложит скачать и установить его. Проверить вручную можно через меню приложения.

::: tip
При запуске из исходников автообновления недоступны. Подтягивайте свежие изменения и запускайте `pnpm install`, если зависимости изменились.
:::

## Обновление из исходников

Подтяните ветку `main` и повторите install, если поменялись зависимости. Всегда используйте `pnpm dev` (Electron) — не браузерный dev-сервер — для обычной разработки:

```bash
git pull
pnpm install
```

## Дальше

- [Быстрый старт](/ru/guide/quickstart) — от установки до первой запущенной команды
- [Настройка рантайма](/ru/guide/runtime-setup) — авторизация провайдеров и выбор моделей
- [Создание команды](/ru/guide/create-team) — рекомендованные структуры и написание brief
