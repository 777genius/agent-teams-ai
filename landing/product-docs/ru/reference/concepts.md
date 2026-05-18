---
title: Концепции – Документация Agent Teams
description: "Основные термины Agent Teams: teams, leads, teammates, tasks, kanban, inboxes, agent blocks, context phases, runtimes, providers."
lang: ru-RU
---

# Концепции

Основные термины Agent Teams. Эта страница задаёт общий словарь для приложения, доски задач, сообщений и review flow.

## Team

Team - именованная группа агентов, привязанная к одному project path. У команды есть lead, опциональные teammates, настройки runtime/provider, prompts, inboxes, tasks и локальное состояние запуска.

## Lead {#lead}

Lead - координатор команды. Он превращает цель пользователя в tasks, назначает или перенаправляет teammates, отслеживает blockers, запрашивает review и двигает работу по board.

[Teammate →](#teammate)

Сообщения lead доставляются иначе, чем сообщения teammate: приложение ретранслирует записи inbox в lead runtime, а teammates читают свои inbox-файлы между turns.

## Teammate {#teammate}

Teammate - не-lead агент в команде. Обычно teammate отвечает за сфокусированную роль: builder, reviewer, researcher или tester. Teammate может получать direct messages, task assignments, task comments и review requests.

[Lead ↑](#lead)

## Task

Task - долговечная единица работы. У неё есть id, status, owner, description, comments, logs, attachments, task references и reviewable changes.

Типичные состояния task: `todo`, `in_progress`, `done`, `review`, `approved`. Файл task хранит рабочее состояние, а review/approval позиция может дополнительно храниться в kanban overlay state.

## Kanban

Kanban - board view для командной работы. Он помогает смотреть tasks по состояниям, открывать детали, читать logs, ревьюить diffs, approve finished work или request changes.

## Inbox

Inbox - локальный message-файл участника команды. Agent Teams использует inboxes для user messages, lead messages, teammate messages, runtime delivery metadata, cross-team messages и части system notifications.

Messages - долговечные локальные записи. Но доставка всё равно зависит от того, жив ли выбранный runtime и сможет ли он обработать следующий turn.

## Agent Block

Agent Block - скрытый agent-only instruction text, обёрнутый в `<info_for_agent>...</info_for_agent>`. UI убирает такие блоки из обычного human-facing display, но agents и runtime delivery могут использовать их для coordination details.

Текущий canonical marker — `info_for_agent`. В старых документах могут встречаться fenced code blocks с маркером ````info_for_agent```` или XML-подобные теги `<agent_block>` — это устаревшие паттерны, которые стоит заменить на `info_for_agent` при встрече.

## Context Phase

Context Phase - сегмент session context timeline. Compaction начинает новую phase, поэтому token/context usage можно анализировать до и после reset.

Context tracking разделяет категории: project instructions, mentioned files, tool output, thinking text, team coordination и user messages. Эти числа нужны для диагностики, а не как provider billing statement.

## Runtime

Runtime - локальный execution path, который выполняет agent turn. Поддерживаемые runtime paths: Claude Code, Codex и OpenCode.

Runtime отвечает за model execution behavior, auth details, tool execution semantics, rate limits, model availability и часть transcript/log formats.

## Provider

Provider - путь доступа к модели за runtime. Текущие provider ids: Anthropic, Codex, Gemini и OpenCode. OpenCode может маршрутизировать к множеству model providers через собственную конфигурацию.

Agent Teams orchestrates tasks and messages, но не заменяет provider authentication или provider policy.

## Solo mode

Solo mode запускает команду из одного агента. Полезно для небольших задач, меньшего coordination overhead и проверки prompt перед расширением до команды.

## Cross-team communication

Агенты могут писать внутри и между командами. Это нужно, когда разные teams владеют связанными частями работы, но их не хочется объединять в одну большую команду.

## Autonomy level

Autonomy определяет, сколько агент может делать до запроса подтверждения. Больше autonomy быстрее, меньше - безопаснее для sensitive code paths, persistence, provider auth, Git operations и releases.

## Review

Review - task-scoped acceptance flow. Task может перейти в review, получить comments или requested changes, а затем перейти в approved, когда результат принят.

Review привязан к local diffs и task history, поэтому лучше работает с узкими tasks и явным упоминанием task, над которой агент работает.
