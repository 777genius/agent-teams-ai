---
title: "Создать первую команду - Документация Agent Teams"
description: "Пошаговая настройка первой команды: lead, builder, reviewer, роли, модели, worktree isolation и launch brief."
lang: ru-RU
---

# Создать первую команду

Цель первого setup - не собрать самую большую команду, а создать маленькую команду, которая стабильно запускается и делает reviewable tasks.

## 1. Откройте проект

Откройте проект, в котором агенты будут работать. Лучше использовать Git-проект, чтобы Agent Teams мог показывать diff, task-linked changes и review state.

Перед запуском проверьте baseline:

```bash
git status --short
```

Если уже есть ваши изменения, учитывайте их при review.

## 2. Создайте команду

Через team selector создайте новую команду для текущего проекта. Название держите коротким и рабочим: `docs-onboarding`, `landing-fixes`, `runtime-audit`.

<ZoomImage src="/screenshots/guides/create-team-annotated.png" alt="Аннотированный диалог Create Team" caption="Create Team: назовите команду, добавьте участников, выберите роли и модели, затем включайте Worktree только если нужна Git-изоляция." />

## 3. Начните с трёх ролей

Рекомендуемая первая форма команды:

| Роль | Ответственность | Зачем |
| --- | --- | --- |
| Lead | Делит цель на задачи, назначает owners, отслеживает blockers. | Держит работу скоординированной. |
| Builder | Делает scoped implementation tasks. | Создаёт основное изменение. |
| Reviewer | Проверяет completed tasks и просит fixes. | Не даёт непроверенному результату стать финальным. |

Специалистов можно добавить позже. Для первого запуска маленькую команду легче диагностировать и ревьюить.

## 4. Выберите provider и model для каждого

Каждому участнику нужен provider и model. Для lead выбирайте самый надёжный runtime, потому что lead управляет decomposition и coordination.

Обычная первая настройка:

| Участник | Какой provider выбрать |
| --- | --- |
| Lead | Самую надёжную модель из доступных. |
| Builder | Быструю модель для scoped implementation. |
| Reviewer | Более аккуратную модель с сильным reasoning. |

Если provider отсутствует, сначала исправьте runtime setup: [Настройка рантайма](/ru/guide/runtime-setup).

## 5. Решите, нужен ли Worktree

Включайте **Worktree**, когда участники могут параллельно менять один репозиторий и нужна Git-изоляция. Для самого простого первого запуска можно оставить выключенным.

Worktree полезен, когда:

- несколько teammates могут одновременно менять код
- нужны более чистые diffs по участникам
- проект уже является Git-репозиторием

Не включайте Worktree, если:

- проект не в Git
- вы только проверяете UI flow
- хотите минимум движущихся частей в первом запуске

## 6. Напишите инструкции участникам

Member prompt должен описывать ответственность участника, а не весь проект.

Lead:

```text
Split the user goal into small tasks. Assign clear owners, avoid broad refactors, keep task comments updated, and request review before approval.
```

Builder:

```text
Implement only the assigned task. Keep changes scoped, post the files you changed, and include the verification command and result before marking work complete.
```

Reviewer:

```text
Review completed tasks for correctness, regressions, missing tests, and scope creep. Ask for fixes with specific comments before approving.
```

## 7. Запустите с узкой целью

Launch brief должен содержать outcome, scope, boundaries и verification:

```text
Improve the docs onboarding path. Keep changes inside landing/product-docs. Create a beginner-friendly guide sequence, add practical examples, preserve VitePress syntax, and run `pnpm --dir landing docs:build`.
```

## 8. Проверьте, что запуск здоровый

После запуска:

- lead создаёт задачи
- хотя бы один teammate начинает задачу
- board показывает движение в In Progress
- task comments или logs показывают, что делает teammate

Если запуск завис или задач нет, откройте [Диагностику](/ru/guide/troubleshooting#team-does-not-launch).

Дальше: [Запустить и отслеживать работу](/ru/guide/run-and-monitor-work).
