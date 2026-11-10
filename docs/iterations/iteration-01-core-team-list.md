# Итерация 01 — Core Foundation + Team List

Эта итерация реализует **первый вертикальный срез** Team Management: от файлов `~/.claude/teams/*` до UI, где открывается вкладка со списком команд.

База для решений и порядка работ:
- `docs/team-management/implementation.md` (v7)
- `~/.claude/plans/goofy-napping-river.md` (summary v7)
- `docs/team-management/research-*.md` + `docs/team-management/kanban-design.md`

---

## Цель итерации

Сделать **видимый результат** без “backend-first” провала:

- В приложении есть **вкладка `Teams`** (тип таба `teams`, **singleton в рамках активной pane**, как `Notifications`)
- В ней отображается **список команд** из `~/.claude/teams/{teamName}/config.json`
- Если команд нет (или директория отсутствует) — корректный **empty state**
- Ошибки чтения/парсинга не валят UI: **graceful degradation**

---

## Не-цели (строго вне scope)

- Team detail (страница конкретной команды)
- Members/Tasks/Messages/Kanban UI
- Любые write-path (inbox write, kanban update, task status update)
- FileWatcher расширение (teamsWatcher/tasksWatcher) и live refresh по `team-change`
- Tests/fixtures (это отдельная итерация 5), кроме минимальных правок тестов, если они ломаются из‑за добавления нового `tab.type`

---

## Контракт итерации (что именно считаем “готово”)

### API-контракт (Main → Preload → Renderer)

**IPC channel**
- `TEAM_LIST` = `'team:list'` (flat `export const`, без `IPC_CHANNELS.*`)

**Response**
- Возвращает `TeamSummary[]`
- Никаких side effects (только чтение)
- Должен быть безопасен при отсутствии `~/.claude/teams`

**TeamSummary (на итерации 1)**
- `name: string` — отображаемое имя команды (из `config.json`)
- `description: string` — описание (из `config.json` или `''`)
- `memberCount: number` — `config.members.length` или 0
- `taskCount: number` — **0** (пока не читаем tasks)
- `lastActivity: string | null` — **null** (пока не читаем inbox)

### Definition of Done

- **UI**: вкладка `Teams` открывается, показывает список/empty state, без падений при:
  - отсутствии `~/.claude/teams`
  - наличии “мусорных” директорий без `config.json` (например `default/`)
  - наличии битого `config.json` (пропускаем, не падаем)
- **IPC**: есть канал `TEAM_LIST` (`'team:list'`), который возвращает `TeamSummary[]`
- **Типы**: `IpcResult<T>` дедуплицирован в `src/shared/types/ipc.ts`
- **Качество**: проходит `pnpm typecheck`, приложение запускается в dev, вкладка доступна из UI

---

## Главные решения, которые сохраняем

- **Vertical slice**: делаем end-to-end минимум (types → main → IPC → preload → renderer → UI)
- **Flat IPC constants**: только `export const TEAM_LIST = 'team:list'` и прямые импорты (никаких `IPC_CHANNELS.*`)
- **Graceful skip**: `listTeams()` пропускает директории без валидного `config.json` (v7 fix #37)
- **Global TeamDataService**: сервис создаётся глобально (по аналогии с UpdaterService), не привязан к ServiceContext (подготовка к следующим итерациям, v6/v7 решение)

---

## Выходные изменения (файлы), только для итерации 1

Цель — чтобы по итогам итерации было понятно: **что добавили**, и что менять не пришлось.

### Новые файлы (ожидаемо)

- `src/shared/types/ipc.ts`
- `src/shared/types/team.ts` (минимальный набор типов для list)
- `src/main/services/team/TeamConfigReader.ts`
- `src/main/services/team/TeamDataService.ts` (минимум `listTeams()`; остальное — позже)
- `src/main/ipc/teams.ts` (минимум: `TEAM_LIST`)
- `src/renderer/utils/unwrapIpc.ts`
- `src/renderer/store/slices/teamSlice.ts` (минимум: `fetchTeams`)
- `src/renderer/components/team/TeamListView.tsx`
- `src/renderer/components/team/TeamEmptyState.tsx`

### Изменяемые файлы (ожидаемо)

- `src/shared/types/index.ts` (реэкспорты)
- `src/preload/constants/ipcChannels.ts` (добавить `TEAM_LIST`)
- `src/shared/types/api.ts` (добавить `TeamsAPI.list`)
- `src/preload/index.ts` (проброс `api.teams.list`)
- `src/main/ipc/handlers.ts` (wiring: init + register `TEAM_LIST`)
- `src/main/index.ts` (создание global `teamDataService` и проброс в `initializeIpcHandlers`)
- `src/renderer/types/tabs.ts` (добавить `type: 'teams'`)
- `src/renderer/store/types.ts`, `src/renderer/store/index.ts` (подключение teamSlice)
- layout-компоненты табов (`PaneContent`, `TabBar`, `SortableTab`) — чтобы появился вход в Teams tab

---

## Порядок работ (runbook)

Ниже — “как делаем” в точном порядке, чтобы на каждом шаге был компилируемый код и минимальный риск сломать существующие фичи.

### Контрольные точки (чтобы не тащить поломки дальше)

Контрольные точки привязаны к реально “широким” изменениям (типы/IPC/таб‑routing):

- **CP0**: после 1.1 — `pnpm typecheck`
- **CP1**: после 2.5 — `pnpm typecheck`
- **CP2**: после 4.2 — `pnpm typecheck`
- **CP3**: после 4.4 — `pnpm dev` + ручная проверка

---

### 1) Shared foundation (Phase 0)

#### 1.1 Дедупликация `IpcResult<T>` (Step 0.1)

- Создать `src/shared/types/ipc.ts` с `export interface IpcResult<T = void> { success; data?; error? }`
- Удалить дубликаты:
  - `src/main/ipc/config.ts`: заменить `ConfigResult<T>` → `IpcResult<T>` из `@shared/types`
  - `src/preload/index.ts`: заменить локальный `IpcResult` → импорт из `@shared/types` и обновить `invokeIpcWithResult<T>()` на этот тип
- Обновить `src/shared/types/index.ts`: реэкспорт `IpcResult`

**CP0:** `pnpm typecheck` (на этом шаге обязателен, чтобы не тащить дальше ошибки типов).

---

### 2) Backend: чтение команд (Main Process)

#### 2.1 Типы для Teams (Step 1 — частично)

В этой итерации нужны минимум:

- `TeamConfig` (чтобы распарсить `config.json`)
- `TeamSummary` (чтобы вернуть данные в UI)

Создать/расширить `src/shared/types/team.ts` и реэкспорт в `src/shared/types/index.ts`.

Важно:
- `TeamSummary.lastActivity` на итерации 1 можно держать `null` (не считаем активность без inbox/tasks).

#### 2.2 Path helpers (Step 2 — по минимуму)

Добавить `getTeamsBasePath()` в `src/main/utils/pathDecoder.ts` рядом с `getProjectsBasePath()` / `getTodosBasePath()`:

- `getTeamsBasePath(): string` → `path.join(getClaudeBasePath(), 'teams')`

Эта функция **обязательна** уже в итерации 1, чтобы не раскидывать `'teams'` как литерал по коду.

**Важно (без двусмысленностей):** `TeamConfigReader` **не имеет права** “захардкодить” путь в конструкторе так, чтобы он перестал учитывать `setClaudeBasePathOverride()`.

- `getClaudeBasePath()` в этом репо поддерживает override (через настройки Claude root).
- Поэтому путь к `~/.claude/teams` должен вычисляться **на каждый вызов** `listTeams()` через `getTeamsBasePath()`.

#### 2.3 `TeamConfigReader.listTeams()` (Step 3 — частично)

Создать `src/main/services/team/TeamConfigReader.ts` с поведением:

- Если `~/.claude/teams` отсутствует → вернуть `[]`
- `readdir(teamsDir, { withFileTypes: true })` → обрабатывать **только директории** (Dirent.isDirectory), остальные entries игнорировать
- Для каждой директории:
  - пытаться прочитать `{dir}/config.json`
  - если файла нет / JSON битый / схема не подходит → **continue** (v7 fix #37)
  - собрать `TeamSummary` (name, description, memberCount, taskCount=0, lastActivity=null)

**Нюанс:** в логах можно оставлять `debug` (но не спамить и не падать).

#### 2.4 `TeamDataService.listTeams()` (Step 5 — частично)

Создать каркас `TeamDataService` так, чтобы в итерации 1 он поддерживал минимум:

- `listTeams(): Promise<TeamSummary[]>` → делегирует в `TeamConfigReader`

Остальные методы (`getTeamData`, kanban/inbox/tasks) — не трогаем или оставляем на следующую итерацию, чтобы не расползаться.

#### 2.5 Глобальная инициализация сервиса (Step 11 — частично)

В `src/main/index.ts` создать **один** instance `teamDataService` (global), не в `ServiceContext`.

**Цель итерации 1:** чтобы IPC handler мог вызвать `teamDataService.listTeams()` без привязки к workspace.

**CP1:** `pnpm typecheck` (до IPC лучше убедиться, что main компилируется).

---

### 3) IPC + Preload: TeamsAPI.list()

#### 3.1 IPC channels (Step 6)

В `src/preload/constants/ipcChannels.ts` добавить:

- `export const TEAM_LIST = 'team:list';`

#### 3.2 IPC handler (Step 7 — частично)

Создать `src/main/ipc/teams.ts` в стиле проекта:

- module-level state + `initializeTeamHandlers(service)`
- `registerTeamHandlers(ipcMain)` регистрирует `TEAM_LIST`
- `wrapTeamHandler()` возвращает `IpcResult<T>`
- `handleListTeams()` вызывает `service.listTeams()`

Важно:
- Использовать **flat imports** каналов (`TEAM_LIST`) (v7 fix #36)
- Не завязываться на `ServiceContextRegistry` (данные Teams читаются из `~/.claude`, это локальный глобальный источник)

#### 3.3 Wiring handlers.ts (v7 fix #48 — частично для list)

В этом проекте единая точка регистрации IPC — `src/main/ipc/handlers.ts` (`initializeIpcHandlers()`):

- Добавить импорт `initializeTeamHandlers/registerTeamHandlers/removeTeamHandlers` из `./teams`
- Расширить сигнатуру `initializeIpcHandlers(...)` новым параметром `teamDataService`
- Внутри `initializeIpcHandlers()`:
  - вызвать `initializeTeamHandlers(teamDataService)`
  - вызвать `registerTeamHandlers(ipcMain)`
- В `removeIpcHandlers()`:
  - вызвать `removeTeamHandlers(ipcMain)`

#### 3.4 Preload bridge (Step 9 — частично)

В `src/shared/types/api.ts` добавить интерфейс `TeamsAPI` минимум с:

- `list(): Promise<TeamSummary[]>`

И в `ElectronAPI` добавить поле:

- `teams: TeamsAPI`

В `src/preload/index.ts`:

- Реализовать `api.teams.list()` через существующий `invokeIpcWithResult<T>()` (он уже используется для `config/ssh/context/httpServer`)
- Пробросить в `contextBridge.exposeInMainWorld()`

**Быстрая проверка до UI (делаем всегда):**
- В renderer DevTools выполнить `await window.electronAPI.teams.list()` и убедиться, что вернулся массив.

---

### 4) Renderer: Tabs + store + UI

#### 4.1 `unwrapIpc<T>()` (Step 12)

Создать `src/renderer/utils/unwrapIpc.ts`:

- оборачивает вызов `api.teams.list()`
- не делает “double unwrap” (preload уже бросает ошибку при `success: false`)

#### 4.2 Tabs + UI entry (строго в рамках текущей модели табов)

**Важно:** в текущем коде `Tab` — это один интерфейс с optional `sessionId/projectId` и `type`-switch в местах использования. Полная миграция на discriminated union — отдельная refactor‑итерация (иначе итерация 1 перестанет быть “тонкой” и потеряет фокус на Team List).

В итерации 1 делаем **ровно** следующее:

- В `src/renderer/types/tabs.ts`:
  - расширить union `Tab['type']`, добавив `'teams'`
  - ничего больше не меняем (никаких refactor’ов структуры Tab, никаких новых optional полей)

- В `src/renderer/components/layout/PaneContent.tsx`:
  - добавить ветку `tab.type === 'teams'` → рендер `TeamListView`

- В `src/renderer/components/layout/SortableTab.tsx`:
  - добавить иконку для `teams` в `TAB_ICONS`

- В `src/renderer/components/layout/TabBar.tsx`:
  - добавить кнопку “Teams” (иконка `Users` из `lucide-react`) в ряд action‑кнопок
  - обработчик должен вызывать `openTeamsTab()` (см. следующий пункт)

- В store:
  - добавить action `openTeamsTab()` как **per-pane singleton** (строго по паттерну `openNotificationsTab()`):
    - если в focused pane уже есть таб `type: 'teams'` → активируем его
    - иначе → `openTab({ type: 'teams', label: 'Teams' })` (лейбл фиксируем как `Teams`, как у `Dashboard/Notifications`)

**CP2:** `pnpm typecheck` после всех правок выше (до того, как писать TeamList UI).

#### 4.3 `teamSlice.fetchTeams()` (Step 14 — частично)

Добавить `src/renderer/store/slices/teamSlice.ts` с минимумом:

- `teams: TeamSummary[]`
- `teamsLoading / teamsError`
- `fetchTeams()`: вызывает `unwrapIpc('team:list', () => api.teams.list())`
- `openTeamsTab()`: per-pane singleton (описано в Step 4.2)

Никаких `selectedTeamData`, refresh generation и т.п. — это следующая итерация.

Подключить slice в `src/renderer/store/types.ts` и `src/renderer/store/index.ts`.

#### 4.4 Tab integration + Teams view (Step 15 + Step 16 — частично)

- В `TabBar` добавить кнопку “Teams” → вызывает `openTeamsTab()` (per-pane singleton)
- В `PaneContent` добавить ветку `tab.type === 'teams'` → рендер `TeamListView`

UI-компоненты (минимум для итерации 1):

- `src/renderer/components/team/TeamListView.tsx`
  - на mount вызывает `fetchTeams()`
  - показывает loading/error/empty
  - рендерит список карточек/строк команд
- `src/renderer/components/team/TeamEmptyState.tsx`

---

## Ручная проверка (обязательная для итерации 1, CP3)

1) Запуск:

- `pnpm dev`
- Открыть вкладку `Teams`

1.1) Singleton-поведение вкладки:

- Нажать кнопку “Teams” 2–3 раза
- Ожидание: не создаются новые табы, фокус остаётся на существующем `Teams` табе (per-pane singleton)

2) Empty state:

- Переименовать (временно) `~/.claude/teams` или протестировать на чистой машине
- Ожидание: “Команды не найдены” (без ошибок в UI)

3) Skip dirs без config:

- Создать папку `~/.claude/teams/default/` без `config.json`
- Ожидание: она **не** появляется в списке, UI не падает

4) Happy path:

- Убедиться что реальная команда (где есть `config.json`) отображается

---

## Риски и как их гасим в рамках итерации

- **Добавление нового `tab.type`**: обязательно обновить `PaneContent` + `SortableTab.TAB_ICONS`, иначе получим runtime/TS ошибки. CP2 гарантирует, что всё “сшилось”.
- **Разный формат `config.json` / мусорные директории**: `TeamConfigReader.listTeams()` делает `try/catch` и `continue`, не кидает исключения наружу.
- **Отсутствие `~/.claude/teams`**: `listTeams()` возвращает `[]` без ошибок.
- **Стабильность UI**: в `TeamListView` должны быть 4 состояния: loading → data / empty / error.

---

## Выходные артефакты (что появится после итерации)

- Документированный канал `TEAM_LIST` и `TeamsAPI.list()`
- Минимальный backend reader для списка команд
- Вкладка `Teams` и список команд в UI (или empty state)
- База для следующих итераций без переархитектуривания

