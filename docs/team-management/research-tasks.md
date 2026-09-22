# Research: Task-файлы Claude Code

## Формат

**Путь**: `~/.claude/tasks/{teamName}/{id}.json`

```json
{
  "id": "48",
  "subject": "Rename package in pubspec.yaml",
  "description": "Change name: dartdoc to name: dartdoc_vitepress",
  "activeForm": "Updating pubspec.yaml",
  "owner": "senior-1-rename",
  "status": "completed",
  "blocks": [],
  "blockedBy": [],
  "metadata": { "_internal": true }
}
```

### Поля

| Поле | Обязательно | Тип | Описание |
|------|:-----------:|-----|----------|
| `id` | YES | string | Числовой ID в виде строки ("1", "48") |
| `subject` | YES | string | Краткий заголовок задачи |
| `description` | NO | string | Детальное описание |
| `activeForm` | NO | string | Present continuous для спиннера ("Updating...") |
| `owner` | NO | string | Имя агента-владельца |
| `status` | YES | string | pending / in_progress / completed / deleted |
| `blocks` | NO | string[] | ID задач, которые зависят от этой |
| `blockedBy` | NO | string[] | ID задач, от которых зависит эта |
| `metadata` | NO | object | Произвольный объект |

### Статусы

```
pending       — задача создана, ждёт исполнителя
in_progress   — агент работает над задачей
completed     — агент завершил
deleted       — задача удалена
```

---

## .highwatermark

**Путь**: `~/.claude/tasks/{teamName}/.highwatermark`
**Содержимое**: число (последний выданный ID)

### Как используется

```
1. TaskCreate → читает .highwatermark (например, "48")
2. Новый ID = 49
3. Создаёт 49.json
4. Записывает "49" в .highwatermark
```

### Риск при внешней записи

Если мы создаём задачу с ID=50, но .highwatermark = 48:
- Следующий TaskCreate создаст 49.json (ОК)
- Ещё один — 50.json → **ПЕРЕЗАПИШЕТ нашу задачу**

**Решение**: Не создавать задачи напрямую. Мы только ЧИТАЕМ задачи и модифицируем status/metadata.

---

## .lock файл

**Путь**: `~/.claude/tasks/{teamName}/.lock`
**Содержимое**: пустой файл (0 байт)

### Поведение

- Обновляется (touch) при обращении к tasks
- Механизм блокировки НЕДОКУМЕНТИРОВАН
- Вероятно используется как advisory lock (наличие = кто-то работает)

### Наш подход

Не трогаем .lock. Он для Claude Code. Мы делаем atomic write (tmp + rename) что безопасно без lock.

---

## Видимость для агентов

| Инструмент | Видит status | Видит metadata | Видит owner | Видит blockedBy |
|------------|:---:|:---:|:---:|:---:|
| TaskList | YES | **NO** | YES | YES |
| TaskGet | YES | YES | YES | YES |
| TaskUpdate | Меняет | Меняет | Меняет | Меняет |

**Следствие**: Агент через TaskList НЕ увидит наш kanbanColumn в metadata. Поэтому хранить kanban-состояние в metadata бессмысленно для агентов, и рискованно (может быть перезаписано).

---

## metadata: merge vs replace

### Проблема

**НЕДОКУМЕНТИРОВАНО.** Неизвестно что происходит при:
```typescript
// Текущее состояние:
{ metadata: { kanbanColumn: "REVIEW", _internal: true } }

// Агент делает TaskUpdate:
TaskUpdate({ metadata: { owner_note: "done" } })

// Результат ???
// MERGE:   { kanbanColumn: "REVIEW", _internal: true, owner_note: "done" }
// REPLACE: { owner_note: "done" }  ← kanbanColumn ПОТЕРЯНО
```

### Решение

Не полагаемся на metadata. Kanban-состояние храним в собственном файле `kanban-state.json`.

---

## Конкурентный доступ

### Сценарий

```
T=0: App читает task.json: { status: "completed", metadata: {} }
T=1: Agent читает тот же файл: { status: "completed", metadata: {} }
T=5: App пишет: { status: "in_progress", metadata: {} }  (Fix)
T=6: Agent пишет: { status: "completed", metadata: { note: "done" } }
→ Наш status: "in_progress" ПОТЕРЯН
```

### Вероятность

**СРЕДНЯЯ** — мы пишем в task только при Fix (status → in_progress). Но агент может одновременно обновлять тот же файл.

### Митигация

1. **Atomic write** (tmp + rename)
2. **Verify after write**: перечитать файл, проверить что status = наш
3. **File watcher**: если status изменился обратно → показать warning в UI

### Что пишем в task-файлы

Минимум — только `status` при Fix:
```typescript
// Читаем текущий task
const task = JSON.parse(fs.readFileSync(taskPath));
// Меняем только status
task.status = 'in_progress';
// Atomic write
const tmp = taskPath + '.tmp.' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
fs.renameSync(tmp, taskPath);
```

Всё остальное (kanbanColumn, reviewStatus) — в нашем kanban-state.json.
