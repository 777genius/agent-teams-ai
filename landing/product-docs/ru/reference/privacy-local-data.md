---
title: Приватность и локальные данные – Документация Agent Teams
description: Что Agent Teams хранит локально, что может покинуть машину через provider-backed model calls, и практические рекомендации по приватности.
lang: ru-RU
---

# Приватность и локальные данные

Agent Teams local-first, но выбранный runtime/provider path всё равно важен. Эта страница описывает, что desktop app хранит локально и что может покинуть машину, когда agents вызывают provider-backed models.

## Что остаётся локально

Desktop app работает на вашей машине и читает local project/runtime data для UI. Обычно локально есть:

- project files
- team configuration и member metadata
- task metadata, task comments и task references
- inbox messages
- runtime/session logs
- launch state и bootstrap diagnostics
- review state
- local app settings

Важные local locations:

| Платформа | Location | Purpose |
| --- | --- | --- |
| macOS/Linux | `~/.claude/teams/<team>/` | Team config, member metadata, inboxes, launch state, bootstrap evidence, runtime diagnostics, sent-message records, kanban state и review-related team files. |
| Windows | `%APPDATA%\Claude\teams\<team>\` | То же — team config, member metadata, inboxes, launch state и diagnostics. |
| macOS/Linux | `~/.claude/tasks/<team>/` | Durable task JSON files для team board. |
| Windows | `%APPDATA%\Claude\tasks\<team>\` | То же — durable task JSON files. |
| macOS/Linux | `~/.claude/projects/<encoded-project>/` | Claude/Codex-style project session files для session history, context analysis и transcript-backed UI. |
| Windows | `%APPDATA%\Claude\projects\<encoded-project>\` | То же — project session files. |

Точные файлы зависят от runtime и версии app. Для launch debugging самые свежие evidence обычно лежат в соответствующей папке `~/.claude/teams/<team>/` (или `%APPDATA%\Claude\teams\<team>\`).

## Что может выйти с машины

Agent Teams сам по себе не является cloud code-sync сервисом для репозитория. Ему не нужно загружать весь project на Agent Teams server, чтобы показывать board, inbox, logs или review UI.

Но когда агент обращается к provider-backed model, prompt context, selected file contents, task text, comments, tool results, command output и другой runtime-provided context могут отправляться через выбранный runtime/provider path. Что именно отправится, зависит от runtime, model, tool calls, prompt и provider configuration.

Provider authentication, provider-side retention, training, logging, regional processing и billing регулируются выбранным provider/runtime. Для sensitive projects проверяйте их policies.

Типичные примеры:

| Action | Data, которое может уйти через runtime/provider |
| --- | --- |
| Попросить агента редактировать file | Task prompt, relevant file contents, tool results и command output |
| Прикрепить screenshot | Attachment content и связанный task/comment text |
| Попросить code review | Diff context, selected files, comments и verification logs |
| Debug failing command | Error output, stack traces и referenced source snippets |

## Чего app не гарантирует

- App не может гарантировать, что provider-backed model calls никогда не получат private code.
- App не может переопределить provider retention или billing policies.
- App не может сделать remote provider полностью local model.
- App не защитит secrets, если агенту поручили вставить их в prompts, task comments, files или commands.
- App не может заставить все runtimes отдавать одинаковый transcript или audit detail.

## Практические правила

- Не прикладывайте secrets к tasks, comments или direct messages.
- Проверяйте provider policies для sensitive projects.
- Используйте меньшую autonomy для risky repositories.
- Держите task scope узким при работе с private code.
- Для диагностики опирайтесь на local evidence и logs.
- Проверяйте generated prompts, task descriptions и attached files перед работой с confidential material.
- Выбирайте provider/model paths, которые соответствуют вашим privacy requirements.

Перед использованием Agent Teams на sensitive repository:

1. Уберите secrets из working tree и task attachments
2. Выберите runtime/provider path, который вам разрешено использовать
3. Начните с low autonomy и small tasks
4. Review task prompts и generated comments до расширения scope
5. Храните logs локально, если не собираетесь специально делиться ими для support

## Open source

Само приложение open source и бесплатное. В репозитории можно посмотреть, как устроены local orchestration, task tracking, inboxes, runtime diagnostics и review flows.
