---
title: Каналы уведомлений — Telegram, Discord, Slack, Teams и Google Chat
description: Как подключить внешние уведомления Agent Teams, проверить отправку и выбрать каналы для каждого события.
---

# Каналы доставки уведомлений

Откройте **Agent Teams → Настройки → Уведомления → Delivery Channels**. Здесь можно один раз добавить нужный канал, затем возле каждого типа уведомления выбрать **Desktop**, Telegram, Discord, Slack, Microsoft Teams или Google Chat. Можно выбрать несколько направлений одновременно.

## Быстрый старт

1. Нажмите **Add channel**, выберите провайдера и укажите понятное имя.
2. Получите токен или ссылку **входящего вебхука** по официальной инструкции ниже. Вставьте её в форму, сохраните и нажмите **Test**.
3. Убедитесь, что тест пришёл в нужный чат. Включите канал (**Enabled**), затем выберите его возле нужного типа события. По умолчанию остаётся Desktop.
4. Общий переключатель уведомлений должен быть включён, а **Snooze** — снят.

**Секреты** (bot token и вебхуки) нельзя публиковать в чатах, логах и тикетах. Они хранятся отдельно в зашифрованном локальном хранилище. Внешние сообщения содержат только название типа события — **без текста агента, названия команды, задач, путей и промптов**.

## Telegram

1. В Telegram откройте [@BotFather](https://t.me/BotFather), введите `/newbot` и получите токен. [Официальная инструкция Telegram](https://core.telegram.org/bots/features#botfather).
2. Для личных сообщений откройте диалог с ботом и нажмите **Start**. Для канала добавьте бота с правами публикации.
3. В Agent Teams выберите **Telegram**: вставьте токен в **Bot token**, а в **Chat ID or @channelname** — числовой ID (например, `123456789`) или имя канала вида `@my_team_alerts`.
4. Сохраните и нажмите **Test**.

Пример *формата* токена: `123456789:<TOKEN_FROM_BOTFATHER>` (нерабочий пример).

## Discord

В Discord откройте настройки нужного канала: **Edit Channel → Integrations → Webhooks → New Webhook**. Выберите канал, скопируйте URL и вставьте его в Agent Teams → **Discord → Official webhook URL**. Сохраните и протестируйте. [Официальная инструкция Discord](https://discord.com/safety/using-webhooks-and-embeds).

Формат: `https://discord.com/api/webhooks/<id>/<token>`. Это **не** обычная ссылка на Discord-канал.

## Slack

По [официальной инструкции Slack](https://api.slack.com/messaging/webhooks) создайте Slack App, включите **Incoming Webhooks**, установите приложение в workspace и выберите канал. Вставьте полученную ссылку в **Slack → Official webhook URL** и нажмите **Test**.

Формат: `https://hooks.slack.com/services/<workspace>/<channel>/<secret>`.

## Microsoft Teams (Workflows)

**Используйте Workflows.** Microsoft прекратила поддержку старых Office 365 Incoming Webhooks в мае 2026 года. [Официальная инструкция Microsoft](https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook).

В Teams откройте меню канала **… → Workflows**, выберите **Send webhook alerts to a channel** либо триггер **When a Teams webhook request is received**. При создании своего триггера установите **Who can trigger the flow? → Anyone**: Agent Teams не передаёт OAuth-токен, поэтому режимы с ограничением по организации не работают. Сохраните workflow и скопируйте выданную URL-ссылку. **Храните её в секрете** — ссылка даёт право отправлять сообщения. Вставьте её в Agent Teams → **Microsoft Teams → Official webhook URL**, сохраните и протестируйте. Thinwrap формирует Adaptive Card автоматически.

Пример формы: `https://prod-00.<region>.logic.azure.com/workflows/<id>/triggers/manual/paths/invoke?...&sig=<secret>`. Используйте полный URL, который сгенерировал Teams.

## Google Chat

В браузере откройте нужное пространство Google Chat: **Apps & integrations → Add webhooks**. Назовите вебхук, сохраните, скопируйте ссылку. Вставьте её в Agent Teams → **Google Chat**, сохраните и нажмите **Test**. Администратор Google Workspace может ограничить использование вебхуков. [Официальная инструкция Google](https://developers.google.com/workspace/chat/quickstart/webhooks).

Формат: `https://chat.googleapis.com/v1/spaces/<space>/messages?key=<key>&token=<token>`. Нужны **оба** параметра.

## Частые проблемы

- **Automatic external delivery is paused** — общий переключатель уведомлений выключен либо включён **Snooze**. Включите уведомления или снимите паузу. Ручная кнопка **Test** доступна даже во время паузы.
- **Dev Mode** — другое предупреждение. macOS называет dev-сборку **Electron** (`com.github.Electron`), а не Agent Teams. Разрешения на системные уведомления проверяются в настройках macOS для Electron. **Это не причина Snooze.**
- **Test проходит, а автоматические сообщения не приходят** — включите канал, назначьте его для типа события, проверьте общий выключатель и Snooze. Старые события не отправляются повторно.
- **Credential unavailable** — отредактируйте канал и вставьте новый секрет.
- **Неверный вебхук или нет прав** — заново получите URL у провайдера и проверьте доступ к чату.
- **Веб-режим** — редактирование секретов разрешено только из Electron или страницы на том же локальном адресе, что и API.
- **Приложение закрыто** — доставки нет: облачного ретранслятора, offline-очереди и автоматических повторов пока нет.

## Произвольный вебхук

Пока не поддерживается: адреса сторонних сайтов без проверенного домена создают риск SSRF и утечки секретов. Для нового провайдера понадобится отдельный валидируемый адаптер и transport-тесты. Эта мера защищает пользователя и локальную сеть.
