# Итерация 03 — Kanban Board (click-to-move) + `kanban-state.json`

> Historical note
> This document captures the planned Kanban scope at iteration time.
> It is not the source of truth for the current product contract.
> For the current review flow, see [../team-management/README.md](../team-management/README.md) and [../team-management/kanban-design.md](../team-management/kanban-design.md).

Эта итерация добавляет **kanban-доску команды** во вкладке Team и вводит **персистентное состояние** для колонок `REVIEW`/`APPROVED` через файл `~/.claude/teams/{teamName}/kanban-state.json`.

Основание:
- `docs/team-management/implementation.md` (**Iteration 3: Kanban Board**)
- `docs/team-management/kanban-design.md` (колонки, storage, mapping, GC)
- `docs/team-management/research-tasks.md` (ограничения task-файлов, почему не metadata)

---

## Цель итерации

- Во вкладке Team появляется **Kanban** с 5 колонками:
  - `TODO`, `IN PROGRESS`, `DONE` — **авто-маппинг** из `task.status`
  - `REVIEW`, `APPROVED` — управляются **только** через `kanban-state.json`
- Поддерживаем MVP UX: **click-to-move** (select/dropdown на карточке).
- Перемещения пишутся в `~/.claude/teams/{teamName}/kanban-state.json` (atomic write).
- Live refresh уже существующий (`team:change`) обновляет kanban при изменениях tasks/teams.

---

## Не-цели (строго вне scope)

- Drag-and-drop (Phase 2, `@dnd-kit`).
- Отправка сообщений ревьюверу, MessageComposer, ActivityTimeline (это итерация 04).
- Изменение `task.status` (Fix flow) и любые write-path в `~/.claude/tasks/**` (это итерация 04).
- `reviewHistory`, round-robin балансировка ревьюверов (Phase 2).
- Создание новых задач (из-за `.highwatermark` риска, см. `research-tasks.md`).

---

## Контракт итерации (Main → Preload → Renderer)

### Storage: путь и формат

- **Файл**: `~/.claude/teams/{teamName}/kanban-state.json`
- Причина: task `metadata` может быть перезаписан агентом (см. `research-tasks.md`).

Минимальный формат (под MVP):

- `teamName: string`
- `reviewers: string[]` (пока только хранение/чтение; управление — итерация 04)
- `tasks: Record<string, KanbanTaskState>`

`KanbanTaskState` (MVP):
- `column: 'review' | 'approved'`
- `reviewStatus?: 'pending' | 'error'`
- `reviewer?: string | null`
- `errorDescription?: string`
- `movedAt: string` (ISO)

Примечание по scope:
- В итерации 03 мы **пишем только** `reviewStatus: 'pending'` при переходе в `REVIEW`.
- Поля `reviewer` и `errorDescription` закладываем в формат, но не обязаны полноценно использовать до итерации 04.

### Column mapping (единый источник правды)

Логика маппинга колонки для задачи:

1) Если `kanbanState.tasks[task.id]` есть → используем `column` из state (`review|approved`)
2) Иначе:
   - `pending` → `todo`
   - `in_progress` → `in_progress`
   - `completed` → `done`
   - `deleted` → не показываем

Полностью соответствует `docs/team-management/kanban-design.md`.

### Shared types (`src/shared/types/team.ts`)

Добавляем типы:

- `KanbanColumnId = 'todo' | 'in_progress' | 'done' | 'review' | 'approved'`
- `KanbanTaskState`
- `KanbanState`

И расширяем `TeamData`:

- `kanbanState: KanbanState`

### IPC / TeamsAPI

Добавляем канал и метод для обновления kanban state:

- `TEAM_UPDATE_KANBAN = 'team:updateKanban'`
- `TeamsAPI.updateKanban(teamName: string, taskId: string, patch: UpdateKanbanPatch): Promise<void>`

`UpdateKanbanPatch` (строго фиксируем, без “и так понятно”):
- `{ op: 'set_column'; column: 'review' | 'approved' }`
- `{ op: 'remove' }`

Поведение:
- `set_column: review` → записываем `{ column:'review', reviewStatus:'pending', reviewer:null, movedAt: now }`
- `set_column: approved` → записываем `{ column:'approved', movedAt: now }` (reviewStatus/reviewer можно очистить)
- `remove` → удаляем запись для `taskId` из `kanbanState.tasks`

Требования:
- Валидация `teamName` (уже есть).
- Валидация `taskId` (добавляем `validateTaskId()`).
- IPC возвращает `IpcResult<void>` (единый паттерн проекта).
- Browser-mode: метод должен возвращать понятную ошибку “доступно только в Electron”, как и остальной Teams API.

---

## Definition of Done (DoD)

- **UI**
  - В Team tab виден kanban с 5 колонками.
  - Карточки задач появляются в корректных колонках по mapping-логике.
  - На карточке в `DONE` есть `Move to: REVIEW` (click-to-move).
  - На карточке в `REVIEW` есть `Move to: APPROVED` и `Move back` (remove state → вернётся в `DONE` по status).
  - В `REVIEW` показывается `ReviewBadge` со статусом `Pending` (manual review; без авто-назначения в итерации 03).
  - Пустые состояния: “нет задач”, “не удалось загрузить kanban”.
- **Backend/IPC**
  - `TEAM_GET_DATA` возвращает `TeamData` с `kanbanState`.
  - `TEAM_UPDATE_KANBAN` обновляет `kanban-state.json` атомарно.
  - GC kanban-state выполняется **только после** полной загрузки `tasks` (см. `kanban-design.md`).
- **Live refresh**
  - Изменение `kanban-state.json` приводит к refresh team data (через существующий `team:change` → store).
- **Качество**
  - `pnpm typecheck` проходит.
  - `pnpm test` проходит.

---

## Выходные изменения (файлы)

### Новые файлы

- `src/main/services/team/TeamKanbanManager.ts`
- `src/main/services/team/atomicWrite.ts` (минимум для `kanban-state.json`, расширим в итерации 04 под inbox/task write)
- `src/renderer/components/team/kanban/KanbanBoard.tsx`
- `src/renderer/components/team/kanban/KanbanColumn.tsx`
- `src/renderer/components/team/kanban/KanbanTaskCard.tsx`
- `src/renderer/components/team/kanban/ReviewBadge.tsx`

### Изменяемые файлы

- `src/shared/types/team.ts` (kanban types + `TeamData.kanbanState`)
- `src/shared/types/api.ts` (TeamsAPI.updateKanban)
- `src/preload/constants/ipcChannels.ts` (+ `TEAM_UPDATE_KANBAN`)
- `src/preload/index.ts` (bridge `teams.updateKanban`)
- `src/main/ipc/guards.ts` (+ `validateTaskId()`)
- `src/main/ipc/teams.ts` (+ handler `TEAM_UPDATE_KANBAN`)
- `src/main/services/team/TeamDataService.ts` (подключить kanban manager, GC)
- `src/main/services/team/index.ts` (export `TeamKanbanManager`)
- `src/main/services/infrastructure/FileWatcher.ts` (teamsWatcher: учитывать `kanban-state.json` как `config` change)
- `src/renderer/store/slices/teamSlice.ts` (action `updateKanban`, refresh после write)
- `src/renderer/components/team/TeamDetailView.tsx` (вставить kanban panel)
- `src/renderer/api/httpClient.ts` (browser-mode заглушка для `updateKanban`)

---

## Порядок работ (runbook) с контрольными точками

### CP0 — типы компилируются

1) **Shared types**
   - В `src/shared/types/team.ts` добавить kanban-типы и `TeamData.kanbanState`.
   - В `src/shared/types/api.ts` добавить `TeamsAPI.updateKanban`.
2) `pnpm typecheck`

---

### CP1 — backend читает/пишет `kanban-state.json`

3) **Atomic write (минимум)**
   - `src/main/services/team/atomicWrite.ts`:
     - `atomicWriteAsync(targetPath, data)` через `tmp + rename` + `mkdir({ recursive:true })`
     - best-effort `fsync` (`open(tmp, 'r+')` → `sync()`), без hard-fail
     - EXDEV fallback (copy+unlink) как safety net

4) **TeamKanbanManager**
   - `getState(teamName)`:
     - читает `~/.claude/teams/{teamName}/kanban-state.json`
     - ENOENT → default `{ teamName, reviewers: [], tasks: {} }`
     - invalid JSON → default + warning (через `TeamData.warnings`)
   - `updateTask(teamName, taskId, patch)`:
     - `patch: { column: 'review'|'approved' }` → set state + `movedAt = now`
     - `patch: { remove: true }` → delete entry
     - write через `atomicWriteAsync`
   - `garbageCollect(teamName, validTaskIds)`:
     - удаляет записи `tasks[id]` которых нет в `validTaskIds`
     - dirty-check: писать файл только если реально что-то удалили

5) **TeamDataService**
   - добавляем зависимость `TeamKanbanManager`
   - в `getTeamData(teamName)`:
     - сначала грузим `tasks`
     - затем `kanbanState`
     - затем **GC** (по `Set(tasks.map(id))`)
     - возвращаем `TeamData` с `kanbanState`

6) `pnpm typecheck`

---

### CP2 — IPC: updateKanban работает end-to-end

7) **Guards**
   - `validateTaskId()` в `src/main/ipc/guards.ts` (pattern как `validateTeamName()`):
     - строка, только цифры, разумный лимит длины (например 1–10)

8) **IPC + preload**
   - `TEAM_UPDATE_KANBAN` в `src/preload/constants/ipcChannels.ts`
   - `src/main/ipc/teams.ts`: handler `updateKanban(teamName, taskId, patch)`:
     - validateTeamName + validateTaskId
     - вызвать `teamDataService.updateKanban(...)` (новый метод)
     - вернуть `IpcResult<void>`
   - `src/preload/index.ts`: `teams.updateKanban(...)` через `invokeIpcWithResult<void>()`

9) Быстрая проверка:
   - в DevTools: `await window.electronAPI.teams.updateKanban(teamName, taskId, { column: 'review' })`

10) `pnpm typecheck`

---

### CP3 — UI: KanbanBoard виден и управляем

11) **UI компоненты**
   - `KanbanBoard` получает:
     - `tasks: TeamTask[]`
     - `kanbanState: KanbanState`
     - `onUpdate(taskId, patch)` → вызывает `teams.updateKanban(...)` через store action
   - `KanbanTaskCard`:
     - показывает subject / owner / status
     - показывает `Move to:` select **только для разрешённых переходов**:
       - `DONE → REVIEW` (set column review)
       - `REVIEW → APPROVED` (set column approved)
       - `REVIEW → DONE` (remove state)
       - `APPROVED → DONE` (remove state)
     - для `TODO`/`IN PROGRESS` — только read-only (двигать нельзя)
      - В колонке `REVIEW` рендерит `ReviewBadge` (в итерации 03 всегда “Pending”)

12) **TeamDetailView layout**
   - Фиксируем layout без вариантов (чтобы не расползлось):
     - **Left**: `MemberList`
     - **Center**: `KanbanBoard`
     - **Right**: текущий `TaskList` (из итерации 02) как “сырой список” задач
   - Обязательные состояния: loading/error/empty/data.
   - UI инвариант: kanban всегда строится из `TeamData.tasks` + `TeamData.kanbanState` (никаких дополнительных fetch).

13) **Live refresh**
   - `FileWatcher`:
     - в `teamsWatcher` добавить обработку `kanban-state.json` как `type: 'config'` (detail: `kanban-state.json`)
     - это гарантирует, что существующий renderer coalesce обновит team data

14) `pnpm test`

15) Ручная проверка
   - Открыть Team tab → kanban виден.
   - Взять completed задачу → `Move to REVIEW` → появляется в REVIEW и создаётся/обновляется `kanban-state.json`.
   - `Move back` → запись удаляется, задача возвращается в DONE.
   - Отредактировать `kanban-state.json` вручную → UI обновится.

---

## Риски и митигации

- **GC удалит валидные записи**: запрещено делать GC до чтения tasks. В `TeamDataService` фиксируем порядок (tasks → kanban → GC).
- **EXDEV/rename нюансы**: в atomic write добавляем fallback copy+unlink.
- **Синхронизация UI**: после `updateKanban` делаем `refreshTeamData(teamName)` (и всё равно придёт watcher-событие; refresh должен быть идемпотентен).
- **Шум от fs.watch**: kanban-write может вызвать два refresh (ручной + watcher). Это ок, но store должен coalesce, а `refreshTeamData` — быть безопасным при частых вызовах.
