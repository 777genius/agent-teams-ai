---
title: Код-ревью – Документация Agent Teams
description: Проверять diff по задаче, принимать или отклонять hunks, оставлять inline comments и управлять review states от none до approved.
lang: ru-RU
---

# Код-ревью

Код-ревью в Agent Teams строится вокруг задачи. Вы смотрите изменения конкретной задачи, а не огромный неструктурированный diff.

## Поверхность ревью

Для каждой завершённой задачи, затронувшей файлы, review UI позволяет:

- Смотреть changed files с контекстом до/после
- Принимать или отклонять отдельные hunks
- Оставлять inline comments
- Связывать diff с описанием задачи и логами агента

## Решения на уровне hunk

Принимайте маленькие правильные изменения и отклоняйте отдельные ошибки без удаления всей работы. Это полезно, когда агент в целом решил задачу, но переборщил в одном файле.

::: tip Принимайте по частям
Если diff в основном верен, сначала примите хорошие hunks и запросите правки только для проблемных частей. Это не даёт доске застопориться.
:::

Используйте hunk-level decisions так:

| Situation | Action |
| --- | --- |
| Correct scoped change | Accept hunk |
| Correct idea, wrong file или broad refactor | Reject hunk и request narrower fix |
| Unclear behavior change | Comment и попросить verification |
| Generated formatting noise | Reject, если formatting не был частью task |

## Инициирование ревью

1. Откройте завершённую задачу
2. Перейдите на вкладку **Changes**
3. Если diff выглядит разумно, нажмите **Request Review**, чтобы переместить задачу в колонку review

Во время ревью задача ещё не считается завершённой, поэтому другие teammates или lead могут всё ещё комментировать её.

## Review loop

Здоровый review loop выглядит так:

1. Owner публикует result comment с changed scope и verification
2. Reviewer открывает task diff и сверяет hunks с task description
3. Reviewer принимает хорошие hunks, отклоняет плохие или requests changes
4. Owner исправляет только requested scope и пишет follow-up comment
5. Reviewer approves, когда task result и diff совпадают

Пример request-changes comment:

```text
Please keep the copy improvements, but revert the unrelated runtime wording in the provider table. Add the `pnpm --dir landing docs:build` result before resubmitting.
```

## Состояния ревью

| Состояние | Значение |
|-----------|---------|
| `none` | Задача новая, в работе или завершена, но ещё не на ревью |
| `review` | Задача активно на ревью |
| `needsFix` | Запрошены правки; владелец должен обновить до повторного approve |
| `approved` | Ревью принято, задача финализирована |

## Рабочий процесс ревью агентами

Команды могут ревьюить работу друг друга до вашего финального решения. Это ловит очевидные регрессии, но risky areas всё равно стоит проверять вручную.

Agent review полезнее, когда reviewer получает ясный rubric. Например, попросите проверить только docs clarity, только IPC safety или только test coverage. Широкие запросы "review everything" обычно дают более слабый feedback.

## Участники ревью

Team lead — ревьюер по умолчанию. Вы можете настроить дополнительных ревьюеров в настройках Kanban, если хотите, чтобы peers ревьюили работу друг друга.

## Что проверять вручную

Приоритетные области при ревью:

- **Provider auth и runtime detection** — не сломает ли агент настройку runtime для других путей?
- **IPC, preload и filesystem boundaries** — сохраняйте разделение ответственности Electron
- **Git и worktree behavior** — проверяйте имена веток, коммиты и push
- **Parsing и task lifecycle logic** — изменения в task references, chunking или filtering могут сломать доставку сообщений
- **Persistence и code review flows** — изменения в хранении задач или review state должны оставаться консистентными через IPC layers

Canonical feature layout и hard guardrail links смотрите в [Архитектуре для контрибьюторов](/ru/reference/contributor-architecture).

## Верификация

Лучше запускать focused verification commands. Broad formatting или lint-fix команды не стоит использовать, если задача явно не про форматирование.

Хорошие verification comments включают command и result:

```text
Verified with `pnpm --dir landing docs:build`. Build passed.
```

Если verification пропущена, task comment должен объяснять почему:

```text
Docs-only wording change. Build not run because the existing dev server was busy; checked Markdown links manually.
```

::: warning Не запускайте автоформатирование по всему проекту
Если задача не специфически про форматирование, избегайте `pnpm lint:fix` на несвязанных файлах. Это создаёт шум в review surface.
:::
