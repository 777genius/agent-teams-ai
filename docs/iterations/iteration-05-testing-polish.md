# Итерация 05 — Testing + Polish (production-ready)

> Historical note
> This document captures iteration-era test and polish assumptions.
> It is not the source of truth for the current product contract.
> For the current review flow, see [../team-management/README.md](../team-management/README.md) and [../team-management/kanban-design.md](../team-management/kanban-design.md).

Эта итерация закрывает **качество**: тесты на критические пути (read/write), фиксация edge cases, UX-polish (empty/error/loading), и небольшие оптимизации под реальные объёмы inbox/tasks.

Основание:
- `docs/team-management/implementation.md` (**Iteration 5: Testing + Polish**)
- `docs/team-management/research-inbox.md` (race + verify, messageId)
- `docs/team-management/research-tasks.md` (task write verify)
- `docs/team-management/kanban-design.md` (GC order, mapping)

---

## Цель итерации

- Добавить **тесты** на:
  - kanban-state чтение/запись/GC
  - inbox read/write (atomic + verify + retry + lock)
  - task status write verify (request changes)
  - IPC guards и handlers (валидаторы + happy/err paths)
  - store coalesce/throttle на `team:change`
- Улучшить UX:
  - ясные empty/error/loading состояния для всех team-panels
  - аккуратные сообщения об ошибках write-path (inbox/task)
  - ограничение и оптимизация рендера больших списков
- Подготовить основу для Phase 2 (D&D, archive, round-robin), не реализуя их.

---

## Не-цели

- E2E/UI automation (можно позже отдельным треком).
- Полный performance-профайлинг приложения.
- Редизайн UI — только точечный polish.

---

## Definition of Done (DoD)

- **Тесты**
  - Добавлены новые тесты (см. ниже), все проходят локально.
  - `pnpm test` зелёный.
  - `pnpm typecheck` зелёный.
- **UX**
  - Нет “пустых серых экранов”: каждый экран имеет понятное состояние.
  - Ошибки write-path показываются пользователю понятным текстом.
- **Надёжность**
  - Все write-path используют atomic write.
  - Верификация после записи включена для inbox и task status.

---

## Тестовая стратегия (конкретно что проверяем)

### 1) TeamKanbanManager

- `getState()`:
  - ENOENT → default state
  - corrupted JSON → default + warning (если warnings протаскиваются)
- `updateTask()`:
  - set column → появляется запись с `movedAt`
  - remove → запись исчезает
- `garbageCollect()`:
  - удаляет только невалидные taskId
  - dirty-check: не пишет файл, если удалять нечего
- **GC order**:
  - тест на `TeamDataService.getTeamData()` что GC вызывается **после** чтения tasks (контракт из `kanban-design.md`)

### 2) Inbox write-path

- `sendMessage()`:
  - пишет `messageId`, `timestamp`, `read:false`
  - после записи verify находит `messageId`
- Race simulation (упрощённо):
  - смоделировать “потерю” (подменой read-back) → retry с backoff вызывается нужное число раз и в итоге error/ok как ожидается
- `withInboxLock()`:
  - два параллельных send в один inbox → оба сообщения сохраняются

### 3) Task status write-path

- `updateStatus()`:
  - меняет только `status`
  - verify после write подтверждает изменение
  - конфликт (подменить файл после write) → ошибка, UI сможет показать warning

### 4) IPC / Guards

- `validateTeamName`, `validateTaskId`, `validateMemberName`:
  - reject path traversal (`../`, слеши, пробелы, пустые)
  - accept валидные имена
- Handlers:
  - invalid args → `IpcResult.success=false`
  - happy path → `success=true`

### 5) Renderer store

- Coalesce/throttle на `team:change`:
  - серия событий <300ms → один refresh
  - если team не виден → не делает лишние `getData` (но обновляет list если это заложено)

---

## Рекомендуемая структура тестов (адаптировать под текущее дерево)

```
test/
├── main/
│   ├── services/team/
│   │   ├── TeamKanbanManager.test.ts
│   │   ├── TeamInboxReader.test.ts        # read (list + merge + sort)
│   │   ├── TeamInboxWriter.test.ts        # sendMessage (atomic + verify + retry + lock)
│   │   ├── TeamTaskWriter.test.ts
│   │   └── TeamDataService.test.ts        # orchestration + GC order
│   └── ipc/
│       ├── guards.test.ts                 # расширить (team/task/member/from)
│       └── teams.test.ts                  # новые каналы/handlers
├── renderer/
│   └── store/
│       └── teamSlice.test.ts              # refresh, send, review actions, throttle
└── fixtures/team/
    ├── teams/
    │   └── my-team/
    │       ├── config.json
    │       ├── kanban-state.json
    │       └── inboxes/
    │           ├── alice.json
    │           └── reviewer.json
    └── tasks/
        └── my-team/
            ├── 12.json
            ├── 13.json
            ├── .lock
            └── .highwatermark
```

Важно:
- `.lock`/`.highwatermark` должны присутствовать в fixture, чтобы гарантировать “пропуск мусорных файлов”.
- Не используем реальный `~/.claude` в тестах.

---

## UX/Polish checklist

- **Empty states**
  - Нет tasks → “Нет задач в этой команде”
  - Нет сообщений → “Нет сообщений” + подсказка “Отправь сообщение”
  - Нет reviewers → в REVIEW показывать “Manual review” (без авто-assign)
- **Error states**
  - Inbox write verify failed → “Сообщение записано, но не подтверждено (race). Попробуй отправить ещё раз.”
  - Task status verify failed → “Не удалось обновить статус задачи (возможен конфликт с агентом).”
- **Loading**
  - Skeleton для TeamDetailView (3 панели)
- **Performance**
  - ActivityTimeline: рендерим только последние N (например 200), кнопка “Показать ещё” (не обязателен infinite scroll)
  - Если tasks > 200: предусмотреть простую фильтрацию по owner/status (минимально)
- **Accessibility**
  - Кнопки имеют понятные `aria-label`
  - Навигация по клавиатуре: focus ring виден

---

## Порядок работ (runbook)

### CP0 — стабилизируем контракты

- Пройтись по типам `TeamData`, `InboxMessage`, kanban types.
- `pnpm typecheck`

### CP1 — тесты main/services

- Добавить fixtures.
- Написать тесты для kanban/inbox/task writer/service orchestration.
- `pnpm test` (обязательно запускать сразу после добавления/правки тестов)

### CP2 — тесты IPC/guards

- Расширить `guards.test.ts`
- Добавить `teams.test.ts` для новых handler’ов
- `pnpm test`

### CP3 — тесты store + polish

- teamSlice tests на coalesce и actions.
- UI polish по чеклисту.
- `pnpm typecheck` + `pnpm test`

---

## Риски и митигации

- **Тесты станут “флейковыми”** из-за таймеров/throttle:
  - использовать fake timers и явный flush.
- **Слишком много моков Electron**:
  - держать единый helper mock `electronAPI` в `test/mocks/`.
- **Большие списки сообщений**:
  - ограничение N + простой “show more” снимают риск O(n) перерендера.

---

## Минимальный чеклист регрессии (ручной)

1) Teams → открыть команду → kanban/задачи/участники видны  
2) Move DONE → REVIEW → состояние сохранилось (после перезапуска app остаётся)  
3) Отправить сообщение → delivered + появилось в Activity  
4) Request Review → карточка в REVIEW + (если reviewer задан) сообщение ушло  
5) Request Changes → task.status стал `in_progress` + owner получил сообщение  
6) Любое изменение файлов `~/.claude/teams/**` / `~/.claude/tasks/**` → UI обновился в пределах ~1с  
