---
title: "Путь новичка - Документация Agent Teams"
description: "Структурированный первый запуск для новых пользователей: проект, команда, доска задач, карточка задачи и ревью."
lang: ru-RU
---

# Путь новичка

Этот маршрут нужен, если вы впервые открыли Agent Teams и хотите пройти путь от запуска приложения до безопасного approval результата.

Первый запуск должен доказать четыре вещи:

1. Приложение открывает ваш проект.
2. Небольшая команда запускается с выбранным runtime.
3. Задачи двигаются по доске и их состояние видно.
4. Вы можете проверить изменения до approval.

## Базовая модель

В Agent Teams есть четыре основные рабочие поверхности:

| Поверхность | Что там делать |
| --- | --- |
| Project и team selector | Выбрать проект и команду, которая будет в нём работать. |
| Team editor | Назвать команду, добавить участников, выбрать роли, модели и worktree-настройки. |
| Task board | Смотреть, как задачи проходят Todo, In Progress, Review, Done и Approved. |
| Task detail и review | Читать задачу, проверять логи, смотреть изменения и approve/request fixes. |

<ZoomImage src="/screenshots/guides/task-board-annotated.png" alt="Аннотированная доска задач Agent Teams" caption="Доска - главная рабочая поверхность после запуска: сообщения, колонки, review-карточки и список задач видны вместе." />

## Рекомендуемый порядок гайдов

Для первого успешного запуска идите в таком порядке:

1. [Создать первую команду](/ru/guide/create-first-team) - собрать небольшую команду lead-builder-reviewer.
2. [Запустить и отслеживать работу](/ru/guide/run-and-monitor-work) - дать lead конкретную цель и следить за task board.
3. [Проверить и approve](/ru/guide/review-and-approve) - проверить task detail, logs и code changes.
4. [Диагностика](/ru/guide/troubleshooting) - если запуск, сообщения или task logs выглядят неправильно.

## Перед запуском

Начинайте с Git-проекта и понятного baseline:

```bash
git status --short
```

Чистое дерево не обязательно, но важно понимать, какие изменения уже были до запуска агентов.

Для первого запуска держите команду маленькой:

| Участник | Первая ответственность |
| --- | --- |
| Lead | Разбивает цель на задачи и координирует статус. |
| Builder | Делает ограниченные implementation tasks. |
| Reviewer | Проверяет завершённые задачи и просит исправления. |

Не запускайте сразу много участников. Больше агентов - больше логов, параллельных правок, provider usage и review-нагрузки.

## Шаблон первой цели

Цель должна иметь scope, границы и verification:

```text
Improve the documentation quickstart. Keep edits inside landing/product-docs, add practical examples, preserve existing VitePress syntax, and run `pnpm --dir landing docs:build` before marking tasks done.
```

Хорошая первая цель конкретная, проверяемая и ограничена известной областью.

## Как выглядит здоровый прогресс

В здоровом запуске:

- lead создаёт маленькие задачи, а не одну огромную
- каждый teammate пишет план или progress comment
- работа двигается из Todo в In Progress
- завершённая работа попадает в Review до approval
- task detail показывает description, attachments, changes и execution logs
- финальный comment содержит verification command и result

## Когда вмешиваться

Вмешивайтесь, если задача слишком широкая, размытая, заблокирована или без verification. Пишите task comment, если сообщение относится к конкретной задаче. Пишите direct message, если надо перенаправить teammate или lead.

Примеры:

```text
Split this into smaller tasks. Each task should have a narrow file scope and a clear verification step.
```

```text
Before continuing, post the files you plan to change and the command you will run to verify the result.
```

```text
This task is too broad. Keep the change inside the docs guide pages and avoid touching app runtime code.
```

## Checklist завершения

Первый запуск можно считать успешным, если:

- команда запустилась без runtime errors
- хотя бы одна задача прошла через Review
- вы открыли и проверили diff
- result comment содержит verification result
- понятно, какие файлы изменились и почему

Дальше: [Создать первую команду](/ru/guide/create-first-team).
