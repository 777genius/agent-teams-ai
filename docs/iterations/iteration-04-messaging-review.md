# Итерация 04 — Messaging + Review (Inbox + ReviewDialog)

> Historical note
> This document captures the planned scope and assumptions at iteration time.
> It is not the source of truth for the current product contract.
> For the current review flow, see [../team-management/README.md](../team-management/README.md) and [../team-management/kanban-design.md](../team-management/kanban-design.md).

Эта итерация добавляет **панель активности (inbox messages)** и **отправку сообщений** тиммейтам, а также закрывает MVP review-flow: **Request Review → Approve / Request Changes**.

Основание:
- `docs/team-management/implementation.md` (**Iteration 4: Messaging + Review**)
- `docs/team-management/research-inbox.md` (формат, race conditions, messageId verify)
- `docs/team-management/research-messaging.md` (почему inbox, ограничения доставки)
- `docs/team-management/kanban-design.md` (review flow, allowed transitions)
- `docs/team-management/research-tasks.md` (безопасная запись status при Fix)

---

## Цель итерации

- Во вкладке Team появляется **ActivityTimeline** (история сообщений) и **MessageComposer** (отправка DM).
- Реализован review-flow:
  - **Request Review**: перевод задачи в `REVIEW` + (если есть reviewer) уведомление в его inbox.
  - **Approve**: перевод задачи в `APPROVED`.
  - **Request Changes**: опциональный комментарий → задача возвращается исполнителю:
    - kanban-state запись удаляется (задача вернётся в `IN PROGRESS` по `task.status`)
    - `task.status` становится `in_progress` (atomic write + verify)
    - отправляется сообщение owner’у с описанием правок
- Live refresh: изменения inbox/task/kanban отражаются в UI (уже существующий `team:change` + coalesce).

---

## Не-цели (строго вне scope)

- Hard interrupt (прерывание mid-turn) — ограничение платформы, Phase 2.
- Архивация inbox / очистка истории / JSONL формат — Phase 2.
- Полноценный drag-and-drop для review — Phase 2 (пока click-to-move/кнопки).
- Round-robin балансировка reviewer’ов и reviewHistory — Phase 2.
- Любые write-path, связанные с созданием задач и `.highwatermark`.

---

## Контракт итерации (Main → Preload → Renderer)

### Shared types (`src/shared/types/team.ts`)

Добавляем/расширяем:

- `InboxMessage` (как в `research-inbox.md`):
  - `from: string`
  - `text: string` (plain text или JSON-строка)
  - `timestamp: string` (ISO)
  - `read: boolean`
  - `summary?: string`
  - `color?: string`
  - `messageId?: string` (в наших исходящих обязателен)
- `SendMessageRequest`:
  - `member: string`
  - `text: string`
  - `summary?: string`
  - `from?: 'user' | string` (по умолчанию `'user'`)
- `SendMessageResult`:
  - `deliveredToInbox: boolean` (означает “записано в файл и verify прошёл”)
  - `messageId: string`

Расширяем `TeamData`:

- `messages: InboxMessage[]` (агрегированные по всем inbox, отсортированные по `timestamp`)

Расширяем `ResolvedTeamMember`:

- `status: 'active' | 'idle' | 'terminated' | 'unknown'`
- `lastActiveAt: string | null`
- `messageCount: number`
- `color?: string`

Правила статуса (из `docs/team-management/README.md`):
- `ACTIVE`: last activity < 5 минут
- `IDLE`: last activity ≥ 5 минут
- `TERMINATED`: получен shutdown-event с approve=true (в доках встречаются разные названия, поэтому считаем terminated если structured `text` после JSON.parse имеет:
  - `type === 'shutdown_response' && approve === true`, **или**
  - `type === 'shutdown_approved'`, **или**
  - `type === 'shutdown_response' && approved === true`
- если данных нет → `unknown`

### IPC каналы

В `src/preload/constants/ipcChannels.ts` добавляем:

- `TEAM_SEND_MESSAGE = 'team:sendMessage'`
- `TEAM_REQUEST_REVIEW = 'team:requestReview'`
- `TEAM_UPDATE_KANBAN` уже существует с итерации 03 и **расширяется** (см. ниже) для `request_changes`.

Важно: в v7-плане перечислены именно `team:sendMessage`, `team:requestReview`, `team:updateKanban`. В этой итерации не вводим новые каналы сверх этого набора.

### TeamsAPI (`src/shared/types/api.ts`)

Расширяем:

- `sendMessage(teamName: string, req: SendMessageRequest): Promise<SendMessageResult>`
- `requestReview(teamName: string, taskId: string): Promise<void>`
- `updateKanban(teamName: string, taskId: string, patch: UpdateKanbanPatch): Promise<void>` (из итерации 03, расширяем patch)

#### UpdateKanbanPatch — расширение в итерации 04 (без двусмысленностей)

К существующим операциям добавляем:

- `{ op: 'request_changes'; comment?: string }`

Семантика `request_changes` (всё внутри main, как единая операция):
1) Удалить kanban-state запись для taskId (remove)
2) Обновить task файл: `status = 'in_progress'` (atomic write + verify)
3) Отправить сообщение owner’у задачи с комментарием (если owner отсутствует → ошибка)

---

## Definition of Done (DoD)

- **Messaging UI**
  - В Team tab есть ActivityTimeline (список сообщений) и MessageComposer.
  - Можно выбрать участника и отправить сообщение → появляется “Delivered” (или ошибка).
  - Сообщение записывается в `~/.claude/teams/{team}/inboxes/{member}.json` с `messageId`.
- **Review UI**
  - На задачах в `DONE` есть действие “Request Review”.
  - В `REVIEW` есть кнопки “Approve” и “Request Changes”.
  - “Request Changes” открывает диалог с опциональным комментарием.
- **Backend safety**
  - Inbox write: atomic write + verify `messageId` + retry/backoff (по плану ниже).
  - Task status write (Fix): atomic write + verify `status` + warning в UI при конфликте.
- **Качество**
  - `pnpm typecheck` проходит.
  - `pnpm test` проходит.

---

## Выходные изменения (файлы)

### Новые файлы

- `src/main/services/team/TeamInboxWriter.ts` (write-path: atomic + verify + retry + lock)
- `src/main/services/team/TeamTaskWriter.ts` (минимум: `updateStatus(teamName, taskId, status)`), чтобы не смешивать чтение и запись
- `src/renderer/components/team/activity/ActivityTimeline.tsx`
- `src/renderer/components/team/activity/ActivityItem.tsx`
- `src/renderer/components/team/activity/MessageComposer.tsx`
- `src/renderer/components/team/dialogs/ReviewDialog.tsx`

### Изменяемые файлы

- `src/shared/types/team.ts` (InboxMessage, SendMessage*, member status, `TeamData.messages`)
- `src/shared/types/api.ts` (TeamsAPI methods)
- `src/preload/constants/ipcChannels.ts` (+ 3 канала)
- `src/preload/index.ts` (bridge для sendMessage/requestReview/updateKanban)
- `src/main/ipc/guards.ts` (+ `validateMemberName()`, `validateFromField()` если потребуется)
- `src/main/ipc/teams.ts` (+ handlers)
- `src/main/services/team/TeamInboxReader.ts` (расширить: `getMessagesFor()`, `getMessages()`)
- `src/main/services/team/TeamMemberResolver.ts` (status/messageCount/color/lastActiveAt + terminated detection)
- `src/main/services/team/TeamDataService.ts` (подтянуть messages + review methods; опираться на kanban из итерации 03; в requestReview — sendMessage первому reviewer при наличии)
- `src/main/services/team/index.ts` (exports)
- `src/renderer/store/slices/teamSlice.ts` (actions + sending states)
- `src/renderer/components/team/TeamDetailView.tsx` (layout: members + kanban + activity)
- `src/main/services/infrastructure/FileWatcher.ts` (ничего нового: inbox/task/kanban уже должны попадать в `team-change`)

---

## Порядок работ (runbook) с контрольными точками

### CP0 — типы компилируются

1) Обновить `src/shared/types/team.ts` и `src/shared/types/api.ts` (контракты выше).
2) `pnpm typecheck`

---

### CP1 — Inbox read/write в main готов (без UI)

3) **Inbox read**
   - `listInboxNames(teamName)` (уже есть/или оставить) — список `*.json` без расширения
   - `getMessagesFor(teamName, member)`:
     - ENOENT → `[]`
     - invalid JSON → `[]` + warning
   - `getMessages(teamName)`:
     - читает все inbox `*.json` (параллельно, best-effort)
     - merge в один массив
     - сортировка по `timestamp` (desc)

4) **Inbox write: atomic + verify + retry**

Реализация должна следовать `research-inbox.md`:

- Каждое сообщение, которое пишет приложение, включает:
  - `messageId = crypto.randomUUID()`
  - `from = 'user'` (по умолчанию)
  - `read = false`
  - `timestamp = new Date().toISOString()`

Алгоритм (в main):

```
read inbox JSON array (если нет → [])
append message
atomicWriteAsync(tmp + rename)
read back
verify messageId exists
если не найден → retry (до 3) с backoff 10/20/40ms
```

Параллелизм:
- внутри процесса сериализуем записи в один `inboxPath` через `withInboxLock(inboxPath, fn)`,
  чтобы два IPC вызова не затёрли друг друга.

Fallback по `from`:
- делаем это **не магией**, а контрактом API:
  - `SendMessageRequest.from` опционален, но если задан — валидируем (`validateFromField` или reuse `validateMemberName`)
  - UI в этой итерации **не обязано** показывать выбор from; по умолчанию отправляем `from: 'user'`
  - для отладки можно вызывать через DevTools `sendMessage(..., { from:'debug-user', ... })`

5) `pnpm test` (если добавлялись новые unit-тесты) и `pnpm typecheck`

---

### CP2 — Review actions в main + IPC

6) **Task status write (Fix)**

Новый `TeamTaskWriter.updateStatus(teamName, taskId, status)`:
- читает `~/.claude/tasks/{teamName}/{taskId}.json`
- меняет только `status`
- пишет через `atomicWriteAsync`
- перечитывает и проверяет, что `status` равен нужному
- при конфликте (агент перезаписал) → throw, чтобы UI показал warning

7) **TeamDataService**
- `getTeamData(teamName)` теперь возвращает также `messages`
- `requestReview(teamName, taskId)`:
  - `updateKanban(taskId, { op:'set_column', column:'review' })` (reviewStatus: pending)
  - выбрать reviewer:
    - если `kanbanState.reviewers[]` не пуст → первый элемент (round-robin — Phase 2)
    - иначе reviewer отсутствует (manual review)
  - если reviewer выбран → `sendMessage(reviewer, "...")`
 - `approve` делаем напрямую через `updateKanban(taskId, { op:'set_column', column:'approved' })`
 - `request_changes` делаем через `updateKanban(taskId, { op:'request_changes', comment })` (см. семантику patch выше)

8) **IPC**
- `TEAM_SEND_MESSAGE`: принимает `teamName`, `SendMessageRequest`
- `TEAM_REQUEST_REVIEW`: принимает `teamName`, `taskId`
- `TEAM_UPDATE_KANBAN`: принимает `teamName`, `taskId`, `UpdateKanbanPatch` (расширенный)

Guards:
- `validateMemberName()` обязателен (защита от path traversal, member используется в пути inbox файла).
- `validateTaskId()` уже есть с итерации 03.

9) `pnpm typecheck`

---

### CP3 — UI: ActivityTimeline + MessageComposer + ReviewDialog

10) **Layout**
- Team tab становится 3-панельным:
  - слева Members
  - центр Kanban
  - справа Activity (messages + composer)

Чтобы не потерять доступ к “сырому списку задач”, фиксируем простой UI-компромисс:
- правый panel становится **табами**: `Activity` и `Tasks`
- по умолчанию открываем `Activity`, но `Tasks` остаётся доступным (и переиспользует текущий `TaskList`)

11) **ActivityTimeline**
- Рендерит `TeamData.messages` (последние N, например 200) с:
  - цветной dot (если есть `color`)
  - `from`, `summary` (или короткий preview `text`)
  - timestamp (relative time)

12) **MessageComposer**
- select получателя (из `members`)
- textarea (минимум 1–2 строки)
- send → вызывает store action → IPC `sendMessage`
- состояния:
  - sending / delivered / error

13) **ReviewDialog**
- открывается при “Request Changes”
- comment optional
- submit → `updateKanban(..., { op:'request_changes', comment })`

14) Ручная проверка
- Отправить сообщение → файл inbox обновился, message появился в ActivityTimeline после refresh.
- Нажать Request Review → задача в REVIEW, при наличии reviewer’а в `kanban-state.reviewers` ему ушло сообщение.
- Approve → задача в APPROVED.
- Request Changes → задача ушла исполнителю (status=in_progress) + отправлено сообщение owner’у.

15) `pnpm test`

---

## Риски и митигации

- **Race condition inbox**: атомарная запись не решает overwrite race, поэтому делаем `messageId verify` + retry/backoff, плюс in-process `withInboxLock`.
- **Конфликт при записи task.status**: после write делаем verify; если agent перезаписал — показываем warning в UI, не делаем silent fail.
- **Большие inbox**: ограничиваем количество отображаемых сообщений (например 200) и добавляем “Show more” позже (итерация 05).
