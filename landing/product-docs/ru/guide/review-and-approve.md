---
title: "Проверить и approve - Документация Agent Teams"
description: "Понятный workflow ревью: task detail, execution logs, code changes, hunk decisions, approvals и fix requests."
lang: ru-RU
---

# Проверить и approve

Не считайте работу агента завершённой, пока не проверили результат задачи, logs и changes. Review удерживает качество и scope.

## 1. Откройте задачу

Начните с задачи в Review или Done. Сначала прочитайте title, owner, status и description.

<ZoomImage src="/screenshots/guides/task-detail-annotated.png" alt="Аннотированный task detail для review" caption="Начните с task description, затем проверьте attachments, changes и execution logs до approval." />

Проверьте:

- понятная ли цель задачи
- совпадают ли файлы с ожидаемым scope
- есть ли final comment от teammate
- есть ли verification command и result

## 2. Проверьте execution evidence

Execution Logs отвечают на базовые вопросы доверия:

| Вопрос | Что искать |
| --- | --- |
| Агент реально работал над этой задачей? | Tool calls, comments и status changes внутри task timeline. |
| Он запускал verification? | Build, test, lint или docs commands с результатом. |
| Он координировался с другими? | Messages или comments с handoffs и blockers. |
| Он трогал неожиданные файлы? | Changes, которые не совпадают с task description. |

Если logs и final comment расходятся, попросите уточнение до approval.

## 3. Проверьте diff

Откройте **Changes** и просмотрите каждый changed file.

<ZoomImage src="/screenshots/guides/code-review-annotated.png" alt="Аннотированный code review screen с changed files, Accept All и hunk actions" caption="Сначала проверьте каждый file. Accept All используйте только после понимания diff. Keep или undo применяйте для отдельных hunks." />

Порядок:

1. Прочитать file list.
2. Открыть каждый changed file.
3. Проверить, что изменения совпадают с задачей.
4. Keep для правильных hunks.
5. Undo или reject для рискованных hunks.
6. Approve только после проверки важных files.

## 4. Просите fixes конкретно

Если что-то не так, не ограничивайтесь reject. Оставьте конкретный fix request:

```text
Please keep the copy improvements, but revert the unrelated runtime wording in the provider table. Add the `pnpm --dir landing docs:build` result before resubmitting.
```

Хороший fix request называет:

- что оставить
- что изменить
- чего избегать
- какая verification обязательна

## 5. Approve только полный результат

Approve уместен, когда:

- task scope закрыт
- diff совпадает с задачей
- verification прошёл или отсутствие verification объяснено
- нет unrelated changes
- comments объясняют важные решения

Если task менял docs или UI, перед approval откройте соответствующую страницу или экран приложения.

## 6. Финальный checklist

Перед закрытием review:

- изменённые files ожидаемые
- есть final result comment
- есть verification result
- risky hunks проверены отдельно
- lead или reviewer поставил approved

Если что-то непонятно, request changes лучше, чем approve.
