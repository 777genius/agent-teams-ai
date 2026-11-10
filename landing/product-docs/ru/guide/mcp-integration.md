---
title: MCP интеграция – Документация Agent Teams
description: Как использовать MCP в Agent Teams для board operations, координации teammates и внешних tool servers.
lang: ru-RU
---

# MCP интеграция

Agent Teams использует MCP двумя практическими способами:

| Слой | Что делает | Кто использует |
| --- | --- | --- |
| Board MCP tools | Создают, стартуют, комментируют, завершают и читают tasks | Agents и leads |
| External MCP servers | Добавляют инструменты вроде browser, design, docs или company systems | Users и настроенные runtimes |

Держите эти слои отдельно. Board MCP нужен для координации внутри Agent Teams. External MCP servers - это дополнительные инструменты для runtimes.

## Board MCP workflow

Agents должны использовать board MCP tools, когда работа относится к task:

1. Прочитать свежий task context.
2. Стартовать task только когда реально начинают работу.
3. Добавлять task comments для blockers, plan и final results.
4. Завершать task после result comment.
5. Отправлять короткое сообщение, если lead или teammate должен увидеть результат.

Пример flow:

```text
task_get -> task_start -> edit/test -> task_add_comment -> task_complete -> message_send
```

Direct message подходит для координации. Task comment подходит для durable task history.

::: tip
Если заметка влияет на review, verification, changed scope или blocker, пишите её в task.
:::

## External MCP servers

Используйте external MCP servers, когда teammate нужен устойчивый tool connection, а не один prompt с pasted context.

Хорошие случаи:

- browser или website testing tools
- design или product data tools
- internal docs и search systems
- issue tracker или support systems
- database inspection tools с read-only credentials

Плохие случаи:

- secrets, вставленные в prompts
- one-off files, которые проще attached напрямую
- tools, которые меняют production systems без review
- широкий local filesystem access, когда достаточно project scope

## Scopes

Agent Teams распознаёт shared и project-oriented MCP scopes.

| Scope | Когда использовать |
| --- | --- |
| User или Global | Один server нужен в разных projects |
| Project или Local | Server относится к одному repository, workspace или team context |

Выбирайте самый узкий scope, который всё ещё удобен. Project-scoped servers легче проверять на review, потому что tool привязан к изменяемому project.

## Setup checklist

Перед task, который зависит от MCP server:

1. Установите или настройте server.
2. Проверьте, что он виден в installed MCP list.
3. Запустите diagnostics, если app их предлагает.
4. Начните с low-risk read-only task.
5. Укажите ожидаемый MCP tool use в task description или team brief.

Если diagnostics падают, сначала чините setup. Лучший prompt не исправит missing command, неправильный config path или rejected credentials.

## Task example

```text
Audit the docs home page with the browser MCP. Check desktop and mobile widths, capture any layout issue as a task comment, and only edit landing/product-docs files. Run `pnpm --dir landing docs:build` before completion.
```

Такой task работает, потому что называет tool, surface, write boundary и verification step.

## Safety rules

- Не выдавайте каждому teammate все MCP servers по умолчанию.
- Не добавляйте write-capable tools в broad teams без review.
- Для inspection tasks предпочитайте read-only credentials.
- Production-impacting tool use фиксируйте через explicit task comments и review.
- MCP diagnostic failures считайте setup failures, а не agent failures.

## Related guides

- [Настройка рантайма](/ru/guide/runtime-setup)
- [Примеры team brief](/ru/guide/team-brief-examples)
- [Работа агентов](/ru/guide/agent-workflow)
