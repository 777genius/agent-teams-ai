# Итерация 02 — Team Detail + Members

Эта итерация добавляет **детальную страницу команды**: по клику из списка команд открывается вкладка команды, где видно **участников** и **задачи**. Плюс включаем **live refresh** через file watcher для `~/.claude/teams` и `~/.claude/tasks`.

Основание: `docs/team-management/implementation.md` (Iteration 2) + research-доки в `docs/team-management/`.

---

## Цель итерации

- Из `Teams` списка можно кликнуть команду → открывается **Team tab** (тип `team`)
- В Team tab отображаются:
  - **участники** (минимум: имя + текущая задача/статус-заглушка)
  - **задачи** (список задач из `~/.claude/tasks/{team}`)
- При изменении файлов в `~/.claude/teams/**` или `~/.claude/tasks/**` UI автоматически обновляется (с coalesce/throttle)

---

## Не-цели (строго вне scope)

- Kanban и `kanban-state.json` (это итерация 03)
- Чтение/рендер сообщений inbox, compose message, review flow (итерация 04)
- Любые write-path (в inbox, в task status, в kanban state)
- Полный refactor Tab-types в discriminated union (это отдельная тех-итерация, не часть MVP)
- Полное покрытие тестами для Team Management (итерация 05). В этой итерации пишем тесты **только если** что-то ломается и требует стабилизации.

---

## Контракт итерации (Main → Preload → Renderer)

### IPC каналы (flat `export const`)

В `src/preload/constants/ipcChannels.ts`:

- `TEAM_GET_DATA = 'team:getData'`
- `TEAM_CHANGE = 'team:change'` (event main → renderer)

### Нейминг событий (без двусмысленностей)

- **IPC (Electron)**: канал `TEAM_CHANGE = 'team:change'` (строка с двоеточием)
- **SSE (HTTP sidecar)**: событие `team-change` (строка с дефисом), потому что в проекте уже используется этот стиль для SSE (`file-change`, `todo-change`, `notification:new`)

Требование: main process форвардит **одно и то же payload-содержимое** в оба транспорта.

### Shared types

В `src/shared/types/team.ts` вводим/расширяем типы (для итерации 02 — только нужный минимум):

- `TeamSummary` (обновляем контракт из итерации 01, см. ниже)
- `TeamTask`
- `ResolvedTeamMember`
- `TeamData` (без kanban/inbox messages)
- `TeamChangeEvent`

#### TeamSummary (обязательный migration)

В итерации 01 поле `TeamSummary.name` фактически использовалось как “display name”. Для итерации 02 нам нужен стабильный идентификатор для доступа к диску.

**Новый контракт TeamSummary:**

- `teamName: string` — **directory name** (`~/.claude/teams/{teamName}`)
- `displayName: string` — `config.json.name` (человеческое имя)
- `description: string`
- `memberCount: number`
- `taskCount: number` (в итерации 02 можно оставить 0, либо заполнить после чтения задач)
- `lastActivity: string | null` (в итерации 02 остаётся `null`)

**Обязательная правка в этой итерации:** обновить реализацию `team:list` и UI, чтобы клик открывал Team tab по `teamName`, а отображение было по `displayName`.

#### TeamTask (читает Claude Code task file)

- `id: string`
- `subject: string`
- `description?: string`
- `activeForm?: string`
- `owner?: string`
- `status: 'pending' | 'in_progress' | 'completed' | 'deleted'`
- `blocks?: string[]`
- `blockedBy?: string[]`

#### ResolvedTeamMember (итерация 02)

- `name: string`
- `status: 'unknown'` (в итерации 02 **всегда** unknown; статусы по inbox — итерация 04)
- `currentTaskId: string | null` (берём первую `in_progress` задачу по `owner === name`)
- `taskCount: number` (кол-во задач по `owner === name`, исключая `deleted`)

#### TeamData (итерация 02)

- `teamName: string` (канонический идентификатор — **имя директории** в `~/.claude/teams/{teamName}`)
- `config: TeamConfig`
- `tasks: TeamTask[]`
- `members: ResolvedTeamMember[]`
- `warnings?: string[]` (например, “tasks failed to load”)

#### TeamChangeEvent

- `type: 'config' | 'inbox' | 'task'`
- `teamName: string`
- `detail?: string` (например `inboxes/alice.json` или `12.json`)

### TeamsAPI (shared `src/shared/types/api.ts`)

Расширяем интерфейс `TeamsAPI`:

- `getData: (teamName: string) => Promise<TeamData>`
- `onTeamChange: (callback: (event: unknown, data: TeamChangeEvent) => void) => () => void`

`list()` остаётся как есть.

---

## Важное решение без двусмысленностей: идентификатор = teamName (directory name)

Вся адресация на диске идёт по `teamName`, который равен имени директории:

- `~/.claude/teams/{teamName}/config.json`
- `~/.claude/teams/{teamName}/inboxes/*.json`
- `~/.claude/tasks/{teamName}/*.json`

**Следствие:** в `team:list` должен быть явный `teamName` (см. новый `TeamSummary`), и все навигации/IPC используют именно его.

---

## Definition of Done (DoD)

- **UI**
  - В `Teams` списке клик по карточке открывает Team tab
  - Team tab показывает MemberList и TasksList (или таблицу)
  - Есть пустые/ошибочные состояния: “нет задач”, “не удалось загрузить”
- **IPC**
  - `TEAM_GET_DATA` работает, валидирует аргументы, возвращает `TeamData`
  - `TEAM_CHANGE` событие приходит в renderer при изменениях teams/tasks
- **FileWatcher**
  - Добавлены `teamsWatcher` и `tasksWatcher` (v7 fix #35)
  - В local режиме используют `fs.watch(..., { recursive: true })`
  - В SSH режиме эти watchers **не запускаются**
- **Store**
  - Есть `selectTeam(teamName)` и `refreshTeamData(teamName)`
  - Есть coalesce/throttle 300ms на `TEAM_CHANGE` (v7 fix #46)
- **Качество**
  - `pnpm typecheck` проходит
  - `pnpm test` проходит (регрессия не допущена)

---

## Выходные изменения (файлы) — что добавляем/меняем

### Новые файлы

- `src/main/services/team/TeamTaskReader.ts`
- `src/main/services/team/TeamInboxReader.ts` (в итерации 02 — только `listInboxNames()`)
- `src/main/services/team/TeamMemberResolver.ts`
- `src/renderer/components/team/TeamDetailView.tsx`
- `src/renderer/components/team/members/MemberList.tsx`
- `src/renderer/components/team/members/MemberCard.tsx`
- `src/renderer/components/team/tasks/TaskList.tsx`
- `src/renderer/components/team/tasks/TaskRow.tsx`

### Изменяемые файлы

- `src/shared/types/team.ts` (расширение типов)
- `src/main/utils/pathDecoder.ts` (+ `getTasksBasePath()`)
- `src/main/services/team/TeamConfigReader.ts` (обновить `listTeams()` под новый `TeamSummary`, + `getConfig(teamName)`)
- `src/main/services/team/TeamDataService.ts` (+ `getTeamData(teamName)`)
- `src/main/ipc/guards.ts` (+ `validateTeamName()` для teamName)
- `src/main/ipc/teams.ts` (+ handler `TEAM_GET_DATA`)
- `src/main/ipc/handlers.ts` (register/remove остаётся; добавить ничего нового кроме импорта константы/инициализации не нужно)
- `src/preload/constants/ipcChannels.ts` (+ `TEAM_GET_DATA`, `TEAM_CHANGE`)
- `src/preload/index.ts` (добавить `teams.getData()` и `teams.onTeamChange()`)
- `src/main/services/infrastructure/FileWatcher.ts` (добавить `teamsWatcher/tasksWatcher`, emit `team-change`)
- `src/main/index.ts` (wire `team-change` forwarding + httpServer.broadcast)
- `src/renderer/store/slices/teamSlice.ts` (расширить slice: selected team + refresh + throttling hooks)
- `src/renderer/store/index.ts` (в `initializeNotificationListeners()` подписка на `api.teams.onTeamChange`)
- `src/renderer/types/tabs.ts` (добавить `type: 'team'` + поле `teamName?: string`)
- `src/renderer/components/layout/PaneContent.tsx` (рендер `TeamDetailView` для `tab.type === 'team'`)
- `src/renderer/components/layout/SortableTab.tsx` (иконка для `team`)
- `src/renderer/components/team/TeamListView.tsx` (клик по карточке → `openTeamTab(team.teamName)`, отображение `team.displayName`)
- `src/renderer/api/httpClient.ts` (добавить заглушки для `getData/onTeamChange`)

---

## Порядок работ (runbook) с контрольными точками

### CP0 — типы компилируются

1) **Shared types**
   - Обновить `TeamSummary` на `{ teamName, displayName, ... }` (migration из итерации 01)
   - Расширить `src/shared/types/team.ts` новыми типами (см. “Контракт”)
   - Расширить `src/shared/types/api.ts` (`TeamsAPI.getData`, `TeamsAPI.onTeamChange`)

2) `pnpm typecheck`

---

### CP1 — backend + IPC возвращают TeamData

3) **Path helpers**
   - Добавить `getTasksBasePath()` в `src/main/utils/pathDecoder.ts`:
     - `return path.join(getClaudeBasePath(), 'tasks')`

4) **Readers + resolver**
   - `TeamConfigReader.listTeams()`:
     - `teamName = entry.name` (directory name)
     - `displayName = config.name`
     - `description`/`memberCount` как раньше
   - `TeamConfigReader.getConfig(teamName)` читает `config.json`, возвращает `TeamConfig | null`
   - `TeamTaskReader.getTasks(teamName)` читает `~/.claude/tasks/{teamName}`:
     - если директории нет → `[]` (v7 fix #38)
     - пропускать `.lock`, `.highwatermark`, скрытые файлы
     - пропускать задачи со `status === 'deleted'`
   - `TeamInboxReader.listInboxNames(teamName)`:
     - читает `~/.claude/teams/{teamName}/inboxes`
     - возвращает имена пользователей по файлам `*.json` без расширения
     - если директории нет → `[]`
   - `TeamMemberResolver.resolveMembers(config, inboxNames, tasks)`:
     - строит union имён: `config.members[].name` + `inboxNames` + `task.owner`
     - вычисляет `taskCount` и `currentTaskId`
     - `status` = `'unknown'` для всех

5) **TeamDataService.getTeamData(teamName)**
   - `config` обязателен: если нет → throw Error “Team not found”
   - `tasks`/`inboxNames` грузятся с graceful fallback и `warnings[]`
   - `members` строится резолвером

6) **IPC**
   - В `src/main/ipc/guards.ts` добавить `validateTeamName()` (паттерн как `validateSessionId`, но для `teamName`)
   - В `src/main/ipc/teams.ts`:
     - добавить `TEAM_GET_DATA`
     - handler `getData(teamName)`:
       - валидирует teamName
       - вызывает `teamDataService.getTeamData(teamName)`
       - возвращает `IpcResult<TeamData>`

7) **Preload**
   - `src/preload/constants/ipcChannels.ts`: добавить `TEAM_GET_DATA`, `TEAM_CHANGE`
   - `src/preload/index.ts`:
     - `teams.getData(teamName)` через `invokeIpcWithResult<TeamData>(TEAM_GET_DATA, teamName)`
     - `teams.onTeamChange(cb)` подписывается на `TEAM_CHANGE` и возвращает cleanup

8) Быстрая проверка:
   - в DevTools: `await window.electronAPI.teams.getData('<teamName>')`

9) `pnpm typecheck`

---

### CP2 — FileWatcher шлёт team-change, store обновляет данные

10) **FileWatcher: teamsWatcher + tasksWatcher**
    - В `src/main/services/infrastructure/FileWatcher.ts`:
      - добавить `teamsWatcher/tasksWatcher` свойства
      - в `stop()/dispose()` закрыть их
      - в `ensureWatchers()` в local режиме запускать оба watcher’а
      - watchers используют `fs.watch(path, { recursive: true })`
      - emit: `this.emit('team-change', teamChangeEvent)` (EventEmitter name именно `team-change`)
      - события классифицировать:
        - teamsWatcher: `config` если `config.json`, `inbox` если внутри `inboxes/`
        - tasksWatcher: всегда `task`
      - teamName извлекать как первый сегмент пути `filename.split(/[\\/]/)[0]`
      - Поведение при отсутствии директории:
        - если `~/.claude/teams` или `~/.claude/tasks` отсутствует — это НЕ ошибка, watcher просто не стартует и планирует retry (как todos)

11) **Main: forwarding**
    - В `src/main/index.ts` (в `wireFileWatcherEvents`):
      - добавить forwarding для `'team-change'`:
        - `mainWindow.webContents.send(TEAM_CHANGE /* 'team:change' */, event)`
        - `httpServer.broadcast('team-change', event)`
      - обязательно cleanup при rewire (как fileChangeCleanup/todoChangeCleanup)

12) **Renderer store: подписка + throttle**
    - В `src/renderer/store/index.ts` внутри `initializeNotificationListeners()`:
      - подписаться на `api.teams.onTeamChange` (если существует)
      - coalesce 300ms:
        - всегда `fetchTeams()` (лёгкая операция)
        - если активен Team tab данного teamName → вызвать `refreshTeamData(teamName)`

13) `pnpm typecheck`

---

### CP3 — UI: Team tab + MemberList + TaskList

14) **Tabs**
    - `src/renderer/types/tabs.ts`:
      - добавить `type: 'team'`
      - добавить поле `teamName?: string` (инвариант: если `type==='team'`, то строка непустая)
    - `src/renderer/components/layout/PaneContent.tsx`:
      - `tab.type === 'team'` → `TeamDetailView teamName={tab.teamName ?? ''}`
      - если `teamName` пустой → показываем “Invalid team tab” (error state)
    - `src/renderer/components/layout/SortableTab.tsx`:
      - добавить иконку для `team`

15) **TeamSlice**
    - Расширить `src/renderer/store/slices/teamSlice.ts`:
      - `selectedTeamName: string | null`
      - `selectedTeamData: TeamData | null`
      - `selectedTeamLoading: boolean`
      - `selectedTeamError: string | null`
      - `selectTeam(teamName)` → вызывает `api.teams.getData`
      - `refreshTeamData(teamName)` → re-fetch если выбран тот же teamName
      - `openTeamTab(teamName)`:
        - ищет существующий `tab.type==='team' && tab.teamName===teamName` во всех panes → фокусирует
        - иначе `openTab({ type:'team', label: teamName, teamName })`

16) **UI компоненты**
    - `TeamListView`:
      - карточка команды кликабельна и вызывает `openTeamTab(team.teamName)`
      - заголовок карточки показывает `team.displayName`
    - `TeamDetailView`:
      - `useEffect`: `selectTeam(teamName)`
      - 4 состояния: loading / error / empty / data
      - layout: слева `MemberList`, справа `TaskList`
    - `MemberList/MemberCard`:
      - имя + “unknown” статус + текущая задача (если есть)
    - `TaskList/TaskRow`:
      - таблица/лист: id, subject, owner, status, blocked (если `blockedBy.length>0`)

17) `pnpm test`

18) Ручная проверка (обязательная)
    - Открыть `Teams` → кликнуть команду → открылся Team tab
    - Видно участников (включая владельцев задач, даже если их нет в config.members)
    - Видны задачи из `~/.claude/tasks/{teamName}`
    - Потрогать файл задачи (изменить owner/status) → UI обновился в течение ~300ms–1s

---

## Риски и митигации

- **Имя команды ≠ имя директории**: решено контрактом `TeamSummary.teamName` (dir) + `TeamSummary.displayName` (человекочитаемо).
- **fs.watch пропуски событий**: есть existing catch-up scan для sessions; для teams/tasks в этой итерации полагаемся на debounce+coalesce, полноценный catch-up можно добавить позже при необходимости.
- **Шумные события**: coalesce 300ms в renderer, чтобы не спамить refresh.

