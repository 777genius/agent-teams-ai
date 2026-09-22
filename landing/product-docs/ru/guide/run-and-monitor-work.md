---
title: "Запустить и отслеживать работу - Документация Agent Teams"
description: "Как дать lead понятный brief, читать task board, использовать messages и comments, открывать task detail и удерживать работу в движении."
lang: ru-RU
---

# Запустить и отслеживать работу

После запуска команды ваша задача - держать работу видимой, ограниченной и готовой к review. Главная поверхность - board.

## 1. Дайте lead понятный brief

Lead нужна цель, которую можно разбить на задачи. Укажите:

- outcome
- разрешённые файлы или область продукта
- что не трогать
- verification commands
- когда просить review

Хороший brief:

```text
Create a beginner docs path. Keep edits inside landing/product-docs. Add screenshots where they clarify actions. Do not touch runtime code. Run `pnpm --dir landing docs:build` before marking tasks complete.
```

Слабый brief:

```text
Improve docs.
```

Слабый brief даёт lead слишком много свободы и усложняет review.

## 2. Читайте board по колонкам

<ZoomImage src="/screenshots/guides/task-board-annotated.png" alt="Аннотированная доска с messages, kanban lanes, review cards и task list" caption="Board помогает одновременно видеть messages, task state, review-ready work и правый task list без чтения raw-файлов." />

| Колонка | Что значит | Что делать |
| --- | --- | --- |
| Todo | Задачи есть, но ещё не активны. | Проверить, достаточно ли конкретные titles. |
| In Progress | Teammate активно работает. | Смотреть updates и не назначать duplicate work. |
| Review | Работу нужно проверить. | Открыть task и review changes. |
| Done | Работа завершена, но может требовать review flow. | Проверить review state перед доверием результату. |
| Approved | Review прошёл. | Считать результат завершённым. |

## 3. Используйте messages и comments осознанно

Task comments подходят для контекста конкретной задачи:

```text
Please keep this task scoped to the quickstart page. Do not change runtime setup wording in this pass.
```

Direct messages подходят для координации:

```text
Lead, pause new task creation until the current review queue is cleared.
```

Если возможно, предпочитайте task comments. Они остаются привязанными к работе.

## 4. Открывайте task detail, когда карточке нужно внимание

Открывайте task detail, если:

- title слишком размытый
- задача слишком долго in progress
- задача готова к review
- output упоминает неожиданные файлы
- нужно проверить attachments, changes или logs

<ZoomImage src="/screenshots/guides/task-detail-annotated.png" alt="Аннотированная карточка задачи с description, attachments, changes и execution logs" caption="Task detail помогает подтвердить scope, attached context, changed files и runtime evidence." />

## 5. Разблокируйте работу

Если teammate заблокирован, попросите минимальный следующий шаг:

```text
Post the blocker, the file or command involved, and the next action you need from the lead or user.
```

Если задача слишком большая, попросите lead разделить её:

```text
Split this into separate tasks for copy edits, screenshot assets, and navigation updates. Keep each task independently reviewable.
```

## 6. Когда остановить команду

Остановите или поставьте на паузу, если:

- review queue больше, чем вы можете проверить
- lead повторно создаёт размытые задачи
- runtime errors появляются в нескольких задачах
- агенты начали менять unrelated files
- completed work не содержит verification

Команду можно перезапустить после уточнения brief.

Дальше: [Проверить и approve](/ru/guide/review-and-approve).
