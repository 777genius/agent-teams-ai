---
title: Документация Agent Teams – Запускайте команды AI-агентов из локального desktop-приложения
description: Документация Agent Teams, бесплатного desktop-приложения для оркестрации AI-агентов. Создавайте команды, наблюдайте за канбан-доской, ревьюйте изменения и координируйте Claude, Codex, OpenCode и multimodel workflows.
lang: ru-RU
layout: home
hero:
  name: Документация Agent Teams
  text: Запускайте команды AI-агентов из локального desktop-приложения
  tagline: Создавайте команды, наблюдайте за канбан-доской, ревьюйте изменения и координируйте Claude, Codex, OpenCode и multimodel workflows без потери локального контроля.
  actions:
    - theme: brand
      text: Путь новичка
      link: /ru/guide/beginner-workflow
    - theme: alt
      text: Установка
      link: /ru/guide/installation
    - theme: alt
      text: Концепции
      link: /ru/reference/concepts
features:
  - icon: "01"
    title: Командный workflow
    details: Опишите роли, запустите lead-агента и дайте команде разбивать, брать и координировать задачи.
    link: /ru/guide/create-team
    linkText: Создать команду
  - icon: "02"
    title: Живая канбан-доска
    details: Видно, как задачи проходят todo, in progress, review, done и approved во время работы агентов.
    link: /ru/guide/agent-workflow
    linkText: Разобрать workflow
  - icon: "03"
    title: Встроенное код-ревью
    details: Проверяйте diff по задаче, принимайте или отклоняйте hunks и оставляйте комментарии.
    link: /ru/guide/code-review
    linkText: Ревью изменений
  - icon: "04"
    title: Настройка рантайма
    details: Используйте Claude, Codex, OpenCode или multimodel-провайдеры через доступ, который у вас уже есть.
    link: /ru/guide/runtime-setup
    linkText: Настроить рантаймы
  - icon: "05"
    title: Local-first контроль
    details: Приложение читает локальный проект и runtime-состояние. Код остаётся у вас, если выбранный провайдер не получает контекст для model call.
    link: /ru/reference/privacy-local-data
    linkText: Модель приватности
  - icon: "06"
    title: Диагностируемые команды
    details: Отслеживайте task logs, runtime output, сообщения агентов и live processes, когда запуск или задача застряли.
    link: /ru/guide/troubleshooting
    linkText: Диагностика
---

<InstallBlock label="Скопировать" copied-label="Скопировано" />

## С чего начать

Agent Teams - бесплатное desktop-приложение для оркестрации команд AI-агентов. Это не просто одиночные промпты одному агенту: вы создаёте команду, задаёте роли и смотрите, как агенты координируют работу через task board.

<DocsCardGrid />

## Что дальше после запуска

После создания первой команды изучите эти руководства:

- **Настройка рантайма** - настройте Claude, Codex, OpenCode или multimodel-провайдеров: [Настроить рантаймы](/ru/guide/runtime-setup)
- **Путь новичка** - полный первый маршрут от проекта до approval: [Начать walkthrough](/ru/guide/beginner-workflow)
- **Создать первую команду** - lead, builder, reviewer, роли, модели и Worktree: [Создать команду](/ru/guide/create-first-team)
- **Запустить и отслеживать работу** - board, comments, task detail и logs: [Запустить работу](/ru/guide/run-and-monitor-work)
- **Проверить и approve** - task results и code changes до approval: [Проверить работу](/ru/guide/review-and-approve)
- **Workflow агентов** - как агенты координируются через task board: [Разобрать workflow](/ru/guide/agent-workflow)
- **Примеры team briefs** - паттерны промптов из реальных примеров: [Примеры](/ru/guide/team-brief-examples)
- **Код-ревью** - проверяйте diff, принимайте или отклоняйте изменения: [Ревью изменений](/ru/guide/code-review)
- **Диагностика** - исправляйте проблемы запуска и missing teammates: [Диагностика](/ru/guide/troubleshooting)
- **Стратегия git worktree** - используйте изоляцию worktree, когда несколько участников редактируют один репозиторий параллельно: [О работе с worktree](/ru/guide/git-worktree-strategy)
- **Релизы** - что нового в каждой версии: [Релизы](/ru/reference/release-notes)

## Справочник

Используйте справочник, когда нужны точные термины, поведение провайдеров, contributor architecture или границы приватности.

<DocsCardGrid type="reference" />

## Превью продукта

<ZoomImage src="/screenshots/product-preview.png" alt="Канбан-доска Agent Teams" caption="Статусы задач, активность агентов и review workflow видны в одном рабочем пространстве." />
