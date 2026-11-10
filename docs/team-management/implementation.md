# Implementation Plan (v7 — Production-Ready Architecture)

> Historical note
> This is a planning and architecture document, not the source of truth for the current shipped product behavior.
> For the current review flow, see [README.md](./README.md) and [kanban-design.md](./kanban-design.md).

## Обзор

~34 новых файлов + 18 модификаций + 18 тестов. Vertical slices (не backend-first).

### Изменения v6 → v7 (по результатам 3 deep-review тимлидов)

| # | Баг/пробел в v6 | Исправление v7 | Severity |
|---|-----------------|----------------|----------|
| 35 | tasks/ — отдельная директория, watcher отсутствует (КРИТИЧНО) | ДВА watcher внутри FileWatcher: teamsWatcher + tasksWatcher | 9 |
| 36 | `IPC_CHANNELS.TEAM_LIST` — объект не существует, реальный паттерн: flat `export const` | Все ссылки исправлены на `TEAM_LIST`, `TEAM_GET_DATA`, etc. (flat imports) | 7 |
| 37 | `listTeams()` падает на dir без config.json (e.g. `default/`) | Graceful skip: `continue` при отсутствии config.json | 7 |
| 38 | Tasks: throw при ENOENT (`~/.claude/tasks/{team}` может не существовать) | Graceful fallback: ENOENT → return `[]` | 7 |
| 39 | `handleSendMessage`: `member as string` без валидации (path traversal) | Добавлен `validateMemberName()` guard | 8 |
| 40 | `requestReview()` — stub без реализации sendMessage reviewer'у | Полная реализация: updateKanban + sendMessage | 6 |
| 41 | Kanban: нет auto-review маппинга (completed → review) | Explicit маппинг: completed без kanban override → 'done' column | 5 |
| 42 | `atomicWriteAsync`: `fs.existsSync()` в async функции | Заменён на `await fs.promises.mkdir(dir, { recursive: true })` | 4 |
| 43 | Нет TeamsTab для list view (только TeamTab для individual teams) | Добавлен `TeamsTab` с `type: 'teams'` в discriminated union | 6 |
| 44 | httpServer.broadcast для team-change не реализован | Добавлен в wireFileWatcherEvents | 4 |
| 45 | Linux: fs.watch без recursive может пропускать events | Добавлен `recursive: true` (macOS native, Linux polyfill) | 3 |
| 46 | Множественные file-change → множественные refreshes | Throttle: 300ms coalesce для team-change events в store | 3 |
| 47 | Inbox `text` содержит serialized JSON (не plain text) | Документировано + UI отображает как текст (Claude Code сам парсит) | 2 |
| 48 | handlers.ts: signature не принимает teamDataService | Добавлен параметр + wiring | 5 |

### Изменения v5 → v6 (по результатам 5 ревью-агентов + 4 тимлидов)

| # | Баг/ошибка в v5 | Исправление v6 | Severity |
|---|-----------------|----------------|----------|
| 22 | `withInboxLock` cleanup: `.then()` creates new Promise, equality всегда false | Сохранять `myTurn` reference, сравнивать с ним | 7 |
| 23 | Tab migration: 8 файлов → реально 12+ (пропущены TabBar, notificationSlice, contextStorage) | Полная карта миграции: 12 файлов | 6 |
| 24 | BaseTab: `fromSearch`, `savedScrollTop`, `showContextPanel` — session-only, не shared | Перенести на SessionTab, оставить на BaseTab только shared поля | 6 |
| 25 | `setupTeamChangeForwarding` — standalone функция сломается при SSH context switch | Интегрировать ВНУТРЬ `wireFileWatcherEvents()` | 8 |
| 26 | TeamDataService в ServiceContext — НЕПРАВИЛЬНО (global, не per-workspace) | Global (как UpdaterService), передавать в initializeIpcHandlers | 8 |
| 27 | TeamMemberResolver дублирует I/O (re-reads config+tasks) | Принимать pre-loaded data: `resolveMembers(config, tasks, messages)` | 5 |
| 28 | kanban-state в `~/.claude/` root — namespace pollution | Хранить в `~/.claude/teams/{teamName}/kanban-state.json` | 5 |
| 29 | GC на каждый fetch — лишние writes | Dirty-check: писать только если entries удалены | 4 |
| 30 | `atomicWriteSync` в async методах KanbanManager | Использовать `atomicWriteAsync` | 5 |
| 31 | Порядок: backend-first → 50% работы без видимого результата | Vertical slices: 5 итераций, каждая end-to-end | — |
| 32 | TabInput: `Omit<Tab, 'id' | 'createdAt'>` с union → нужен distributive Omit | Explicit `SessionTabInput | TeamTabInput | ...` | 5 |
| 33 | Missing httpServer.broadcast для team-change events | Добавить в wireFileWatcherEvents | 3 |
| 34 | IPC handler channel strings hardcoded → должны быть из constants | Import из ipcChannels.ts | 3 |

### Изменения v4 → v5 (по результатам 4 deep-research агентов)

| # | Вопрос v4 | Результат исследования | Решение v5 |
|---|-----------|----------------------|------------|
| 18 | Tab union — сколько мест ломается? | 12+ файлов, 30-35 строк | Полная карта миграции всех 12 файлов |
| 19 | FileWatcher — риск 3-го watcher | ТРИВИАЛЬНЫЙ: copy-paste паттерн, ~60 LOC | Extend существующий FileWatcher (не отдельный) |
| 20 | Inbox race condition | In-process mutex решает IPC races | withInboxLock с ПРАВИЛЬНЫМ cleanup |
| 21 | End-to-end integration gaps | 12 точек интеграции полностью промаплены | Explicit checklist + exact file:line references |

### Изменения v3 → v4 (по результатам 5 ревью-агентов)

| # | Проблема v3 | Исправление v4 | Severity |
|---|-------------|----------------|----------|
| 1 | `openSync('r')` — fsync не работает | `openSync('r+')` + mkdir recursive | 8 |
| 2 | team:change event не прокинут | Полная wiring: FileWatcher → main → renderer → store | 9 |
| 3 | unwrapIpcResult double wrapping | Убран второй unwrap, оставлен только try/catch | 7 |
| 4 | Promise.all partial data loss | Promise.allSettled + graceful fallbacks | 7 |
| 5 | TeamDataService без интерфейсов | 5 интерфейсов + Factory для DI/тестов | 7 |
| 6 | Tab 'team' — optional fields | Discriminated union для Tab types | 5 |
| 7 | teamRefreshGeneration memory leak | Cleanup при close tab + Map.delete | 6 |
| 8 | setTimeout в store action | Заменён на `teamDeletedRedirect` flag в state | 3 |
| 9 | kanban-state без atomic write | atomicWriteSync для всех write-path | 7 |
| 10 | from: "user" не валидируется | validateFromField в guards.ts | 6 |
| 11 | Sync ops блокируют event loop | Async версия atomicWrite для sendMessage | 5 |
| 12 | Orphan .tmp cleanup отсутствует | cleanupOrphanTmpFiles() на startup | 6 |
| 13 | Retry logic отсутствует | appendToInboxWithRetry + exponential backoff | 5 |
| 14 | 1 тест vs 18-20 нужно | Полная тестовая стратегия: 18 файлов + fixtures | — |
| 15 | Нет empty states | Empty states для всех компонентов | — |
| 16 | ServiceContext не содержит team | ~~TeamDataService в ServiceContext~~ v6: global (баг #26) | 6 |
| 17 | KanbanBoard props flow не описан | Явный props flow + callbacks | 8 |

### Архитектурные принципы (без изменений из v3)

| Принцип | Что берём из проекта | Что улучшаем |
|---------|---------------------|--------------|
| **SRP** | Domain-driven services (analysis: 10 классов) | 5 backend классов вместо God-сервиса |
| **OCP** | FileSystemProvider (2 реализации) | Интерфейсы для read/write операций |
| **LSP** | Discriminated unions для chunks | Discriminated unions для Tab + MemberStatus |
| **ISP** | ElectronAPI разбит на субинтерфейсы | TeamsAPI — отдельный субинтерфейс |
| **DIP** | ServiceContext принимает deps через конструктор | Интерфейсы + Factory для всех 5 классов |

### Паттерны: consistency с проектом (без изменений из v3)

| Решение | Что было в v2 | Что стало (v3/v4) | Почему |
|---------|---------------|-------------------|--------|
| **IPC handler** | Class `TeamIpcHandler` | `let state` + `getService()` guard | 12+ модулей: module-level |
| **Renderer service** | Class `TeamService` | `unwrapIpc<T>()` утилита | 15 slices вызывают api напрямую |
| **Line limits** | ≤100 строк/класс | Без строгих лимитов, избегать 300-400+ | Прагматизм |

### IpcResult<T> — дедупликация (без изменений из v3)

Тип дублируется: `ConfigResult<T>` в config.ts и `IpcResult<T>` в preload/index.ts.
Вынести в `@shared/types/ipc.ts` — единый источник правды.

---

## Порядок реализации

### Справочник шагов (Steps)

```
Phase 0: Подготовка
  0.1  IpcResult<T> дедупликация → @shared/types/ipc.ts

Phase 1: Backend (Main Process)
  1    Shared Types (team.ts) — discriminated unions
  2    Path Helpers
  3    Backend Services — 5 интерфейсов + 5 классов + Factory
  4    atomicWrite.ts (ИСПРАВЛЕН: 'r+', mkdir, EXDEV, async, orphan cleanup)
  5    TeamDataService — Facade (Promise.allSettled, не Promise.all)
  6    IPC Channels
  7    IPC Handlers — module-level + guard + wrapTeamHandler
  8    Guards (validateTeamName, validateTaskId, validateFromField)
  9    Preload Bridge + TeamsAPI
  10   FileWatcher Extension + team:change wiring (v6: INSIDE wireFileWatcherEvents)
  11   Global TeamDataService (v6: НЕ в ServiceContext)

Phase 2: Frontend (Renderer)
  12   unwrapIpc<T>() (ИСПРАВЛЕН: без double wrapping)
  13   Tab Type — Discriminated Union (НЕ optional fields)
  14   teamSlice (ИСПРАВЛЕН: cleanup Map, без setTimeout, flag redirect)
  15   Tab Integration (SortableTab, PaneContent, TabBar)
  16   UI Components (14 шт) + Empty States
  17   KanbanBoard с явным props flow
  18   MessageComposer + inbox write (retry + delivery status)
  19   ReviewDialog

Phase 3: Testing
  20   Test fixtures + mocks
  21   Backend tests (8 файлов)
  22   IPC tests (2 файла)
  23   Renderer tests (4 файла)
```

### v6: Порядок реализации — Vertical Slices

> **v6 FIX (баг #31)**: Backend-first порядок означает, что 50% работы будет без видимого результата.
> Переход к vertical slices: каждая итерация даёт видимый результат (types → backend → IPC → UI → тест).

**Iteration 1: Core Foundation + Team List (Steps 0.1, 1, 2, 3-partial, 5-partial, 6, 7-partial, 9, 11, 12, 13, 14-partial, 15, 16-partial)**
- Shared types, path helpers, IpcResult dedup
- ConfigReader (только listTeams, v7: skip dirs without config.json) + Factory (partial)
- IPC: team:list channel + handler + preload bridge (v7: flat export const)
- Tab discriminated union (12 files migration) + TeamsTab (v7 #43) + TeamTab
- teamSlice: fetchTeams only
- TeamView + TeamListView + TeamEmptyState
- **Результат**: открывается Teams tab, видно список команд (или empty state)

**Iteration 2: Team Detail + Members (Steps 3-partial, 5-partial, 7-partial, 10, 14-partial, 16-partial)**
- ConfigReader.getConfig + TaskReader (v7: ENOENT → []) + MemberResolver
- TeamDataService.getTeamData (без kanban/inbox)
- IPC: team:getData handler
- FileWatcher: TWO watchers (teamsWatcher + tasksWatcher, v7 #35) + team:change wiring
- teamSlice: selectTeam + refreshTeamData + throttle (v7 #46)
- TeamDetailView + MemberList + MemberCard
- **Результат**: клик на команду → видно участников и задачи

**Iteration 3: Kanban Board (Steps 3-partial, 4, 5-partial, 7-partial, 8, 16-partial, 17)**
- KanbanManager + atomicWrite (full)
- Guards (validateTeamName, validateTaskId)
- IPC: team:updateKanban handler
- KanbanBoard + KanbanColumn + KanbanTaskCard + ReviewBadge
- **Результат**: kanban доска с 5 колонками, click-to-move работает

**Iteration 4: Messaging + Review (Steps 3-partial, 5-partial, 7-partial, 8, 14-partial, 16-partial, 18, 19)**
- InboxReader + sendMessage + withInboxLock + retry
- IPC: team:sendMessage + team:requestReview handlers + validateMemberName (v7 #39)
- requestReview: updateKanban + sendMessage to reviewer (v7 #40)
- teamSlice: sendTeamMessage + moveTaskToColumn
- ActivityTimeline + MessageComposer + ReviewDialog
- **Результат**: можно отправлять сообщения, запрашивать ревью

**Iteration 5: Testing + Polish (Steps 20-23)**
- Test fixtures + mocks
- Backend tests (8 файлов), IPC tests (2), Renderer tests (4)
- Empty states для всех panels
- Error handling polish, loading states
- **Результат**: полное покрытие тестами, production-ready

---

## Phase 0: Подготовка

### Step 0.1: IpcResult<T> дедупликация (без изменений)

**Create** `src/shared/types/ipc.ts`

```typescript
export interface IpcResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}
```

**Modify** `src/shared/types/index.ts` — `export type { IpcResult } from './ipc';`
**Modify** `src/main/ipc/config.ts` — удалить `ConfigResult<T>`, импортировать `IpcResult<T>` из `@shared/types`
**Modify** `src/preload/index.ts` — удалить `IpcResult<T>`, импортировать из `@shared/types`

---

## Phase 1: Backend (Main Process)

### Step 1: Shared Types

**Create** `src/shared/types/team.ts`

```typescript
// === Типы с диска (Claude Code format) ===

export interface TeamConfig {
  name: string;
  description: string;
  createdAt: number;
  leadAgentId: string;
  leadSessionId: string;
  members: TeamMember[];
}

export interface TeamMember {
  name: string;
  agentId: string;
  agentType: string;
  model?: string;
  joinedAt?: number;
  tmuxPaneId?: string;
  cwd?: string;
  subscriptions?: string[];
}

export interface InboxMessage {
  from: string;
  /**
   * v7 NOTE (#47): `text` field contains SERIALIZED JSON (not plain text).
   * Claude Code serializes message content as JSON string.
   * UI should display as plain text — Claude Code itself handles parsing.
   * Example: '{"type":"message","content":"Hello","summary":"Greeting"}'
   */
  text: string;
  summary?: string;
  timestamp: string;
  color?: string;
  read: boolean;
  /** v7 NOTE: old messages may lack messageId — field is optional */
  messageId?: string;
}

export interface TeamTask {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  owner?: string;           // ОПЦИОНАЛЕН
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
}

// === Наши типы ===

export type MemberStatus = 'active' | 'idle' | 'terminated' | 'unknown';

export interface TeamSummary {
  name: string;
  description: string;
  memberCount: number;
  taskCount: number;
  lastActivity: string | null;
}

export interface TeamData {
  config: TeamConfig;
  members: ResolvedTeamMember[];
  tasks: TeamTask[];
  messages: InboxMessage[];
  kanbanState: KanbanState;
  /** Partial load warnings (e.g., "messages failed to load") */
  warnings?: string[];
}

export interface ResolvedTeamMember {
  name: string;
  agentId?: string;
  agentType?: string;
  color?: string;
  currentTask?: TeamTask;
  messageCount: number;
  lastActive?: string;
  status: MemberStatus;
  role: 'worker' | 'reviewer';
}

// === Kanban ===

export type KanbanColumnId = 'todo' | 'in_progress' | 'done' | 'review' | 'approved';

export interface KanbanColumn {
  id: KanbanColumnId;
  label: string;
}

export type ReviewAction = 'approve' | 'request_changes';

export interface KanbanTaskState {
  column: KanbanColumnId;
  reviewAction?: ReviewAction;
  reviewer?: string;
  comment?: string;
  movedAt: string;
}

export interface KanbanState {
  teamName: string;
  reviewers: string[];
  tasks: Record<string, KanbanTaskState>;
}

export const DEFAULT_KANBAN_COLUMNS: KanbanColumn[] = [
  { id: 'todo', label: 'TODO' },
  { id: 'in_progress', label: 'IN PROGRESS' },
  { id: 'done', label: 'DONE' },
  { id: 'review', label: 'REVIEW' },
  { id: 'approved', label: 'APPROVED' },
];

// === Events ===

export interface TeamChangeEvent {
  type: 'config' | 'task' | 'inbox';
  teamName: string;
  detail?: string;
}

// === Message delivery ===

export interface SendMessageResult {
  delivered: boolean;
  messageId: string;
}
```

**Modify** `src/shared/types/index.ts` — add `export * from './team';`

### Step 2: Path Helpers (без изменений)

**Modify** `src/main/utils/pathDecoder.ts`

```typescript
export function getTeamsBasePath(): string {
  return path.join(getClaudeBasePath(), 'teams');
}

export function getTasksBasePath(): string {
  return path.join(getClaudeBasePath(), 'tasks');
}
```

### Step 3: Backend Services — 5 интерфейсов + 5 классов + Factory

**NEW в v4**: Интерфейсы для DI и тестирования.

```
src/main/services/team/
├── interfaces.ts           — 5 интерфейсов (ITeamConfigReader, etc.)
├── TeamConfigReader.ts     — implements ITeamConfigReader
├── TeamTaskReader.ts       — implements ITeamTaskReader
├── TeamInboxReader.ts      — implements ITeamInboxReader
├── TeamMemberResolver.ts   — implements ITeamMemberResolver
├── TeamKanbanManager.ts    — implements ITeamKanbanManager
├── TeamDataService.ts      — Facade, принимает интерфейсы
├── TeamDataServiceFactory.ts — Composition root
├── atomicWrite.ts          — Atomic write utils (sync + async)
└── index.ts                — barrel export
```

#### interfaces.ts (NEW в v4)

```typescript
import type {
  InboxMessage, KanbanState, KanbanTaskState,
  ResolvedTeamMember, SendMessageResult, TeamConfig, TeamSummary, TeamTask,
} from '@shared/types';

export interface ITeamConfigReader {
  listTeams(): Promise<TeamSummary[]>;
  getConfig(teamName: string): Promise<TeamConfig | null>;
}

export interface ITeamTaskReader {
  getTasks(teamName: string): Promise<TeamTask[]>;
}

export interface ITeamInboxReader {
  getInboxNames(teamName: string): Promise<string[]>;
  getMessages(teamName: string): Promise<InboxMessage[]>;
  getMessagesFor(teamName: string, member: string): Promise<InboxMessage[]>;
  sendMessage(
    teamName: string,
    member: string,
    msg: { from: string; text: string; summary?: string }
  ): Promise<SendMessageResult>;
}

export interface ITeamMemberResolver {
  /** v6 FIX: принимает pre-loaded data, не дублирует I/O */
  resolveMembers(
    config: TeamConfig,
    tasks: TeamTask[],
    messages: InboxMessage[]
  ): ResolvedTeamMember[];
}

export interface ITeamKanbanManager {
  getState(teamName: string): Promise<KanbanState>;
  updateTaskState(teamName: string, taskId: string, state: Partial<KanbanTaskState>): Promise<void>;
  removeTaskState(teamName: string, taskId: string): Promise<void>;
  garbageCollect(teamName: string, existingTaskIds: Set<string>): Promise<void>;
}
```

#### TeamConfigReader

```typescript
export class TeamConfigReader implements ITeamConfigReader {
  constructor(private readonly teamsBasePath: string) {}

  async listTeams(): Promise<TeamSummary[]> {
    const teamsDir = this.teamsBasePath;
    let entries: string[];
    try {
      entries = await fs.promises.readdir(teamsDir);
    } catch {
      return []; // ~/.claude/teams/ doesn't exist yet
    }

    const summaries: TeamSummary[] = [];
    for (const name of entries) {
      const configPath = path.join(teamsDir, name, 'config.json');
      try {
        const raw = await fs.promises.readFile(configPath, 'utf8');
        const config: TeamConfig = JSON.parse(raw);
        summaries.push({
          name: config.name,
          description: config.description ?? '',
          memberCount: config.members?.length ?? 0,
          taskCount: 0, // populated later if needed
          lastActivity: null,
        });
      } catch {
        // v7 FIX (#37): skip dirs without config.json (e.g. "default/" has only inboxes/)
        logger.debug(`Skipping team dir without valid config: ${name}`);
        continue;
      }
    }
    return summaries;
  }

  async getConfig(teamName: string): Promise<TeamConfig | null> {
    const configPath = path.join(this.teamsBasePath, teamName, 'config.json');
    try {
      const raw = await fs.promises.readFile(configPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}
```

#### TeamTaskReader

```typescript
export class TeamTaskReader implements ITeamTaskReader {
  constructor(private readonly tasksBasePath: string) {}

  async getTasks(teamName: string): Promise<TeamTask[]> {
    const tasksDir = path.join(this.tasksBasePath, teamName);
    let entries: string[];
    try {
      entries = await fs.promises.readdir(tasksDir);
    } catch (error) {
      // v7 FIX (#38): ~/.claude/tasks/{team}/ may not exist (graceful fallback)
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const tasks: TeamTask[] = [];
    for (const file of entries) {
      if (!file.endsWith('.json') || file.startsWith('.') || file === '.lock' || file === '.highwatermark') continue;
      try {
        const raw = await fs.promises.readFile(path.join(tasksDir, file), 'utf8');
        const task: TeamTask = JSON.parse(raw);
        if (task.status !== 'deleted') {
          tasks.push(task);
        }
      } catch {
        logger.debug(`Failed to parse task file: ${file}`);
      }
    }
    return tasks;
  }
}
```

#### TeamInboxReader (ИСПРАВЛЕН: async sendMessage)

```typescript
export class TeamInboxReader implements ITeamInboxReader {
  constructor(private readonly teamsBasePath: string) {}

  async getInboxNames(teamName: string): Promise<string[]> { /* readdir inboxes/ */ }
  async getMessages(teamName: string): Promise<InboxMessage[]> { /* merge all, sort by timestamp */ }
  async getMessagesFor(teamName: string, member: string): Promise<InboxMessage[]> { /* one member */ }

  /**
   * Пишет в MAIN inbox. Async версия (не блокирует event loop).
   * Использует atomic write + messageId verify + retry.
   */
  async sendMessage(
    teamName: string,
    member: string,
    msg: { from: string; text: string; summary?: string }
  ): Promise<SendMessageResult> {
    const inboxPath = path.join(this.teamsBasePath, teamName, 'inboxes', `${member}.json`);
    const messageId = await appendToInboxWithRetry(inboxPath, {
      from: msg.from,
      text: msg.text,
      summary: msg.summary,
      timestamp: new Date().toISOString(),
    });
    return { delivered: true, messageId };
  }
}
```

#### TeamMemberResolver (v6 FIX: принимает pre-loaded data)

```typescript
export class TeamMemberResolver implements ITeamMemberResolver {
  /**
   * v6 FIX: принимает pre-loaded data вместо re-reading через readers.
   * TeamDataService уже загрузил config, tasks, messages — не дублируем I/O.
   * Стал СИНХРОННЫМ (pure transform, без async fs reads).
   */
  resolveMembers(
    config: TeamConfig,
    tasks: TeamTask[],
    messages: InboxMessage[]
  ): ResolvedTeamMember[] {
    // union(config.members + message senders + task owners)
    // deduplicate by name (case-insensitive trim)
    // extract colors from messages
    // determine status via determineMemberStatus()
    // match currentTask by owner field from tasks
  }

  private determineMemberStatus(
    lastMessageTime: Date | null,
    hasActiveTask: boolean
  ): MemberStatus {
    if (!lastMessageTime) return 'unknown';
    const ageMs = Date.now() - lastMessageTime.getTime();
    const ACTIVE_WINDOW = 5 * 60 * 1000;   // 5 min
    const IDLE_WINDOW = 60 * 60 * 1000;     // 1 hour
    if (ageMs < ACTIVE_WINDOW || hasActiveTask) return 'active';
    if (ageMs < IDLE_WINDOW) return 'idle';
    return 'terminated';
  }
}
```

#### TeamKanbanManager (v6 FIX: path + async + GC dirty-check)

```typescript
export class TeamKanbanManager implements ITeamKanbanManager {
  /** v6: принимает teamsBasePath (не configDir) для хранения внутри team dir */
  constructor(private readonly teamsBasePath: string) {}

  async getState(teamName: string): Promise<KanbanState> {
    // read kanban-state.json, return default if missing
  }

  async updateTaskState(teamName: string, taskId: string, state: Partial<KanbanTaskState>): Promise<void> {
    const current = await this.getState(teamName);
    current.tasks[taskId] = {
      ...current.tasks[taskId],
      ...state,
      movedAt: new Date().toISOString(),
    };
    // v6 FIX: atomicWriteAsync вместо atomicWriteSync (async method не должен блокировать event loop)
    await atomicWriteAsync(this.getStatePath(teamName), JSON.stringify(current, null, 2));
  }

  async removeTaskState(teamName: string, taskId: string): Promise<void> {
    const current = await this.getState(teamName);
    delete current.tasks[taskId];
    // v6 FIX: atomicWriteAsync
    await atomicWriteAsync(this.getStatePath(teamName), JSON.stringify(current, null, 2));
  }

  async garbageCollect(teamName: string, existingTaskIds: Set<string>): Promise<void> {
    const current = await this.getState(teamName);
    const toRemove = Object.keys(current.tasks).filter(id => !existingTaskIds.has(id));
    // v6 FIX: dirty-check — write ONLY if entries actually removed
    if (toRemove.length === 0) return;
    for (const id of toRemove) {
      delete current.tasks[id];
    }
    await atomicWriteAsync(this.getStatePath(teamName), JSON.stringify(current, null, 2));
  }

  private getStatePath(teamName: string): string {
    // v6 FIX: хранить внутри team directory, не в ~/.claude/ root
    return path.join(this.teamsBasePath, teamName, 'kanban-state.json');
  }
}
```

### Step 4: atomicWrite.ts (ПОЛНОСТЬЮ ПЕРЕПИСАН в v4)

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '@shared/utils/logger';

const logger = createLogger('util:atomicWrite');

/**
 * Atomic write (SYNC): tmp + fsync + rename.
 *
 * v4 исправления:
 * - openSync('r+') вместо 'r' для корректного fsync
 * - mkdir recursive перед write (первый write в новую team)
 * - EXDEV handling (cross-mount rename fallback)
 */
export function atomicWriteSync(targetPath: string, data: string): void {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.tmp.${randomUUID()}`);

  try {
    // Ensure parent directory exists (first write to new team)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(tmpPath, data, 'utf8');

    // fsync с ПРАВИЛЬНЫМ флагом (v3 bug: 'r' → v4 fix: 'r+')
    try {
      const fd = fs.openSync(tmpPath, 'r+');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    } catch {
      // fsync best effort — продолжаем
    }

    // rename с EXDEV fallback
    try {
      fs.renameSync(tmpPath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        fs.copyFileSync(tmpPath, targetPath);
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      } else {
        throw error;
      }
    }
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw error;
  }
}

/**
 * Atomic write (ASYNC): не блокирует event loop.
 * Используется для sendMessage (inbox write может быть 50-100ms).
 */
export async function atomicWriteAsync(targetPath: string, data: string): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.tmp.${randomUUID()}`);

  try {
    // v7 FIX (#42): no fs.existsSync in async function — mkdir recursive is idempotent
    await fs.promises.mkdir(dir, { recursive: true });

    await fs.promises.writeFile(tmpPath, data, 'utf8');

    try {
      const fd = await fs.promises.open(tmpPath, 'r+');
      await fd.sync();
      await fd.close();
    } catch {
      // fsync best effort
    }

    try {
      await fs.promises.rename(tmpPath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        await fs.promises.copyFile(tmpPath, targetPath);
        try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
      } else {
        throw error;
      }
    }
  } catch (error) {
    try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
    throw error;
  }
}

/**
 * v6: In-process write queue — serializes concurrent IPC writes to same inbox.
 * Eliminates read-modify-write race condition within the Electron main process.
 *
 * Pattern source: FileWatcher.processingInProgress Set (same codebase).
 * Note: does NOT protect against cross-process races (CLI writes).
 * Cross-process safety via verify + retry (below).
 *
 * v6 FIX: v5 had a bug where `.then()` created a new Promise on each call,
 * so the equality check `=== existing.then(() => next)` was ALWAYS false.
 * Fixed by saving `myTurn` reference and comparing against it.
 * Also made generic <T> to avoid closure tricks for return values.
 */
const inboxWriteLocks = new Map<string, Promise<void>>();

export async function withInboxLock<T>(
  inboxPath: string,
  fn: () => Promise<T>
): Promise<T> {
  // Wait for predecessor (or resolve immediately if no queue)
  const predecessor = inboxWriteLocks.get(inboxPath) ?? Promise.resolve();

  // Create our "done" signal
  let release!: () => void;
  const myTurn = new Promise<void>(r => { release = r; });

  // Register ourselves as the current tail of the queue
  inboxWriteLocks.set(inboxPath, myTurn);

  // Wait for predecessor to finish
  await predecessor;

  try {
    return await fn();
  } finally {
    release();
    // Cleanup Map only if we're still the last in queue
    // v6 FIX: compare against saved `myTurn` reference (not `.then()` which creates new Promise)
    if (inboxWriteLocks.get(inboxPath) === myTurn) {
      inboxWriteLocks.delete(inboxPath);
    }
  }
}

/**
 * Append message to inbox JSON array with retry + verify.
 * v4: async, exponential backoff, до 3 retry.
 * v5: wrapped in withInboxLock to serialize concurrent writes.
 */
export async function appendToInboxWithRetry(
  inboxPath: string,
  message: Record<string, unknown>,
  maxRetries: number = 3
): Promise<string> {
  let lastError: Error | null = null;

  let resultId = '';
  await withInboxLock(inboxPath, async () => {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        resultId = await appendToInboxWithVerify(inboxPath, message);
        return;
      } catch (error) {
      lastError = error as Error;
      logger.warn(`Inbox write attempt ${attempt + 1} failed: ${lastError.message}`);

        if (attempt < maxRetries) {
          const delayMs = 10 * Math.pow(2, attempt); // 10ms, 20ms, 40ms
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }
    throw lastError ?? new Error('Failed to append to inbox after retries');
  });
  return resultId;
}

/**
 * Single attempt: read → append → atomic write → verify.
 */
async function appendToInboxWithVerify(
  inboxPath: string,
  message: Record<string, unknown>
): Promise<string> {
  const messageId = randomUUID();
  const fullMessage = { ...message, messageId, read: false };

  // 1. Read existing
  let existing: unknown[] = [];
  try {
    const raw = await fs.promises.readFile(inboxPath, 'utf8');
    existing = JSON.parse(raw);
    if (!Array.isArray(existing)) existing = [];
  } catch {
    // Start fresh if missing/broken
  }

  // 2. Append
  const updated = [...existing, fullMessage];

  // 3. Atomic write (async — не блокирует event loop)
  await atomicWriteAsync(inboxPath, JSON.stringify(updated, null, 2));

  // 4. Verify — detect race condition
  const written = JSON.parse(
    await fs.promises.readFile(inboxPath, 'utf8')
  ) as Array<{ messageId?: string }>;
  const found = written.some(m => m.messageId === messageId);
  if (!found) {
    throw new Error(`Message ${messageId} lost (race condition detected)`);
  }

  return messageId;
}

/**
 * Cleanup orphan .tmp files on startup.
 * Called once in main/index.ts after TeamDataService creation.
 */
export async function cleanupOrphanTmpFiles(basePaths: string[]): Promise<void> {
  const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
  const now = Date.now();

  for (const basePath of basePaths) {
    try {
      if (!fs.existsSync(basePath)) continue;
      const entries = await fs.promises.readdir(basePath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Scan subdirectories (inboxes/, etc.)
          const subPath = path.join(basePath, entry.name);
          const subEntries = await fs.promises.readdir(subPath).catch(() => []);
          for (const file of subEntries) {
            if (typeof file === 'string' && file.startsWith('.tmp.')) {
              const filePath = path.join(subPath, file);
              try {
                const stat = await fs.promises.stat(filePath);
                if (now - stat.mtimeMs > MAX_AGE_MS) {
                  await fs.promises.unlink(filePath);
                  logger.debug(`Cleaned orphan: ${filePath}`);
                }
              } catch { /* ignore */ }
            }
          }
        } else if (entry.name.startsWith('.tmp.')) {
          const filePath = path.join(basePath, entry.name);
          try {
            const stat = await fs.promises.stat(filePath);
            if (now - stat.mtimeMs > MAX_AGE_MS) {
              await fs.promises.unlink(filePath);
            }
          } catch { /* ignore */ }
        }
      }
    } catch (error) {
      logger.warn(`Orphan cleanup failed for ${basePath}:`, error);
    }
  }
}
```

### Step 5: TeamDataService — Facade (ИСПРАВЛЕН: интерфейсы + Promise.allSettled)

```typescript
import type {
  ITeamConfigReader, ITeamTaskReader, ITeamInboxReader,
  ITeamMemberResolver, ITeamKanbanManager,
} from './interfaces';
import type { TeamData, TeamSummary, SendMessageResult, KanbanTaskState } from '@shared/types';
import { createLogger } from '@shared/utils/logger';

const logger = createLogger('Service:TeamData');

/**
 * Facade: оркестрирует 5 reader-классов.
 * v4: принимает ИНТЕРФЕЙСЫ (не конкретные классы) для DI/тестов.
 * v4: Promise.allSettled для graceful degradation.
 */
export class TeamDataService {
  constructor(
    private readonly configReader: ITeamConfigReader,
    private readonly taskReader: ITeamTaskReader,
    private readonly inboxReader: ITeamInboxReader,
    private readonly memberResolver: ITeamMemberResolver,
    private readonly kanbanManager: ITeamKanbanManager,
  ) {}

  async listTeams(): Promise<TeamSummary[]> {
    return this.configReader.listTeams();
  }

  async getTeamData(teamName: string): Promise<TeamData> {
    // 1. Config is required — fail fast if missing
    const config = await this.configReader.getConfig(teamName);
    if (!config) {
      throw new Error(`Team not found: ${teamName}`);
    }

    // 2. Load remaining data with partial failure tolerance
    const [tasksResult, messagesResult, kanbanResult] = await Promise.allSettled([
      this.taskReader.getTasks(teamName),
      this.inboxReader.getMessages(teamName),
      this.kanbanManager.getState(teamName),
    ]);

    const warnings: string[] = [];

    // v7 FIX (#38): Tasks — graceful degradation (tasks dir may not exist)
    let tasks: TeamTask[] = [];
    if (tasksResult.status === 'rejected') {
      logger.warn(`Failed to load tasks for ${teamName}:`, tasksResult.reason);
      warnings.push('Tasks failed to load');
    } else {
      tasks = tasksResult.value;
    }

    // Messages: graceful degradation → empty array
    let messages: InboxMessage[] = [];
    if (messagesResult.status === 'rejected') {
      logger.warn(`Failed to load messages for ${teamName}:`, messagesResult.reason);
      warnings.push('Messages failed to load');
    } else {
      messages = messagesResult.value;
    }

    // Kanban: graceful degradation → default state
    let kanbanState: KanbanState;
    if (kanbanResult.status === 'rejected') {
      logger.warn(`Failed to load kanban state for ${teamName}:`, kanbanResult.reason);
      kanbanState = { teamName, reviewers: [], tasks: {} };
      warnings.push('Kanban state failed to load');
    } else {
      kanbanState = kanbanResult.value;
    }

    // 3. GC kanban state AFTER loading tasks
    const existingTaskIds = new Set(tasks.map(t => t.id));
    await this.kanbanManager.garbageCollect(teamName, existingTaskIds);

    // 4. Resolve members — v6 FIX: pass pre-loaded data (не дублируем I/O)
    const members = this.memberResolver.resolveMembers(config, tasks, messages);

    return { config, members, tasks, messages, kanbanState, warnings };
  }

  async sendMessage(
    teamName: string,
    member: string,
    msg: { from: string; text: string; summary?: string }
  ): Promise<SendMessageResult> {
    return this.inboxReader.sendMessage(teamName, member, msg);
  }

  async updateKanban(
    teamName: string,
    taskId: string,
    state: Partial<KanbanTaskState>
  ): Promise<void> {
    await this.kanbanManager.updateTaskState(teamName, taskId, state);
  }

  /** v7 FIX (#40): полная реализация — kanban move + notify reviewer via inbox */
  async requestReview(teamName: string, taskId: string, reviewer?: string): Promise<void> {
    // 1. Move task to 'review' column in kanban
    await this.kanbanManager.updateTaskState(teamName, taskId, {
      column: 'review',
      reviewer,
    });

    // 2. If reviewer specified, send inbox message to notify them
    if (reviewer) {
      const task = (await this.taskReader.getTasks(teamName)).find(t => t.id === taskId);
      const subject = task?.subject ?? `Task #${taskId}`;
      await this.inboxReader.sendMessage(teamName, reviewer, {
        from: 'user',
        text: JSON.stringify({
          type: 'review_request',
          taskId,
          subject,
          message: `Please review: ${subject}`,
        }),
        summary: `Review requested: ${subject}`,
      });
    }
  }
}
```

#### TeamDataServiceFactory.ts (NEW в v4)

```typescript
import { TeamConfigReader } from './TeamConfigReader';
import { TeamTaskReader } from './TeamTaskReader';
import { TeamInboxReader } from './TeamInboxReader';
import { TeamMemberResolver } from './TeamMemberResolver';
import { TeamKanbanManager } from './TeamKanbanManager';
import { TeamDataService } from './TeamDataService';

/**
 * Composition root: создаёт TeamDataService с конкретными реализациями.
 * В тестах: можно создать TeamDataService с mock-реализациями интерфейсов.
 *
 * v6 FIX: MemberResolver больше не принимает readers (pure transform).
 * v6 FIX: KanbanManager принимает teamsBasePath (хранит state в team dir).
 */
export function createTeamDataService(
  teamsBasePath: string,
  tasksBasePath: string
): TeamDataService {
  const configReader = new TeamConfigReader(teamsBasePath);
  const taskReader = new TeamTaskReader(tasksBasePath);
  const inboxReader = new TeamInboxReader(teamsBasePath);
  const memberResolver = new TeamMemberResolver();
  const kanbanManager = new TeamKanbanManager(teamsBasePath);

  return new TeamDataService(configReader, taskReader, inboxReader, memberResolver, kanbanManager);
}
```

### Step 6: IPC Channels (v7 FIX: flat export const)

> **v7 FIX (#36)**: Проект использует flat `export const`, НЕ object namespace.
> Паттерн: `export const CONFIG_GET = 'config:get'`, а не `IPC_CHANNELS.CONFIG_GET`.

**Modify** `src/preload/constants/ipcChannels.ts` — добавить в конец файла:

```typescript
// =============================================================================
// Team API Channels
// =============================================================================

/** List all teams */
export const TEAM_LIST = 'team:list';

/** Get full team data */
export const TEAM_GET_DATA = 'team:getData';

/** Send message to team member */
export const TEAM_SEND_MESSAGE = 'team:sendMessage';

/** Update kanban task state */
export const TEAM_UPDATE_KANBAN = 'team:updateKanban';

/** Request review for a task */
export const TEAM_REQUEST_REVIEW = 'team:requestReview';

/** Team change event channel (main -> renderer) */
export const TEAM_CHANGE = 'team:change';
```

### Step 7: IPC Handlers (v7 FIX: flat imports + validateMemberName)

**Create** `src/main/ipc/teams.ts`

```typescript
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { TeamDataService } from '@main/services/team';
import type { IpcResult } from '@shared/types';
// v7 FIX (#36): flat imports — project uses `export const`, NOT namespace object
import {
  TEAM_LIST, TEAM_GET_DATA, TEAM_SEND_MESSAGE,
  TEAM_UPDATE_KANBAN, TEAM_REQUEST_REVIEW,
} from '@preload/constants/ipcChannels';
import { createLogger } from '@shared/utils/logger';

const logger = createLogger('IPC:team');

// Module-level state + guard (consistency с 12+ модулями)
interface TeamHandlerState {
  service: TeamDataService;
  initialized: boolean;
}

const state: TeamHandlerState = {
  service: null as unknown as TeamDataService,
  initialized: false,
};

function getService(): TeamDataService {
  if (!state.initialized) throw new Error('Team handlers not initialized');
  return state.service;
}

export function initializeTeamHandlers(service: TeamDataService): void {
  if (state.initialized) {
    logger.warn('Team handlers already initialized');
    return;
  }
  state.service = service;
  state.initialized = true;
}

export function registerTeamHandlers(ipcMain: IpcMain): void {
  // v7 FIX (#36): flat channel constants
  ipcMain.handle(TEAM_LIST, handleListTeams);
  ipcMain.handle(TEAM_GET_DATA, handleGetData);
  ipcMain.handle(TEAM_SEND_MESSAGE, handleSendMessage);
  ipcMain.handle(TEAM_UPDATE_KANBAN, handleUpdateKanban);
  ipcMain.handle(TEAM_REQUEST_REVIEW, handleRequestReview);
  logger.info('Team handlers registered');
}

export function removeTeamHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_LIST);
  ipcMain.removeHandler(TEAM_GET_DATA);
  ipcMain.removeHandler(TEAM_SEND_MESSAGE);
  ipcMain.removeHandler(TEAM_UPDATE_KANBAN);
  ipcMain.removeHandler(TEAM_REQUEST_REVIEW);
}

/**
 * v4: Helper для consistent error handling.
 * Все handlers используют одинаковый pattern.
 */
async function wrapTeamHandler<T>(
  operation: string,
  handler: () => Promise<T>
): Promise<IpcResult<T>> {
  try {
    const result = await handler();
    return { success: true, data: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[team:${operation}] Error:`, error);
    return { success: false, error: message };
  }
}

async function handleListTeams(): Promise<IpcResult<TeamSummary[]>> {
  return wrapTeamHandler('list', () => getService().listTeams());
}

async function handleGetData(
  _event: IpcMainInvokeEvent,
  teamName: unknown
): Promise<IpcResult<TeamData>> {
  const validation = validateTeamName(teamName);
  if (!validation.valid) return { success: false, error: validation.error! };
  return wrapTeamHandler('getData', () => getService().getTeamData(validation.value));
}

async function handleSendMessage(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  member: unknown,
  text: unknown,
  summary: unknown
): Promise<IpcResult<SendMessageResult>> {
  const teamValidation = validateTeamName(teamName);
  if (!teamValidation.valid) return { success: false, error: teamValidation.error! };
  // v7 FIX (#39): validate member name to prevent path traversal
  const memberValidation = validateMemberName(member);
  if (!memberValidation.valid) return { success: false, error: memberValidation.error! };
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { success: false, error: 'text must be a non-empty string' };
  }
  return wrapTeamHandler('sendMessage', () =>
    getService().sendMessage(teamValidation.value, memberValidation.value, {
      from: 'user',
      text: text as string,
      summary: typeof summary === 'string' ? summary : undefined,
    })
  );
}

// handleUpdateKanban, handleRequestReview — аналогично через wrapTeamHandler
```

### Step 8: Guards (v7: + validateMemberName для path traversal prevention)

**Modify** `src/main/ipc/guards.ts`

```typescript
const TEAM_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const TASK_ID_PATTERN = /^[0-9]{1,10}$/;
// v7 FIX (#39): member names are used in file paths (inboxes/{member}.json)
// Must prevent path traversal (e.g., "../../etc/passwd")
const MEMBER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function validateTeamName(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string') return { valid: false, error: 'teamName must be a string' };
  const trimmed = value.trim();
  if (!TEAM_NAME_PATTERN.test(trimmed)) {
    return { valid: false, error: `Invalid team name: ${trimmed}` };
  }
  return { valid: true, value: trimmed };
}

export function validateTaskId(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string') return { valid: false, error: 'taskId must be a string' };
  if (!TASK_ID_PATTERN.test(value)) {
    return { valid: false, error: `Invalid task ID: ${value}` };
  }
  return { valid: true, value };
}

/**
 * v7 FIX (#39): Validates member name used in inbox file paths.
 * Critical for security: member is interpolated into file path:
 *   path.join(teamsBasePath, teamName, 'inboxes', `${member}.json`)
 * Without validation, attacker could send member="../../etc/passwd" for path traversal.
 */
export function validateMemberName(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string') return { valid: false, error: 'member must be a string' };
  const trimmed = value.trim();
  if (!MEMBER_NAME_PATTERN.test(trimmed)) {
    return { valid: false, error: `Invalid member name: ${trimmed}` };
  }
  return { valid: true, value: trimmed };
}
```

### Step 9: Preload Bridge (без изменений)

**Modify** `src/shared/types/api.ts` — add `TeamsAPI` + extend `ElectronAPI`
**Modify** `src/preload/index.ts` — teams bridge implementation

### Step 10: FileWatcher Extension + team:change Wiring (v7: ДВА watcher'а)

**Modify** `src/main/services/infrastructure/FileWatcher.ts`

> **v5 research result**: FileWatcher уже имеет 2 параллельных watcher (projectsWatcher + todosWatcher).
> Copy-paste паттерн. ~60 LOC per watcher, нулевой риск для существующих watchers.
>
> **v7 CRITICAL FIX (#35)**: `~/.claude/tasks/` — ОТДЕЛЬНАЯ директория от `~/.claude/teams/`.
> Нужны ДВА новых watcher'а:
> - `teamsWatcher` для `~/.claude/teams/` (config changes, inbox changes)
> - `tasksWatcher` для `~/.claude/tasks/` (task file changes)
> Оба emit'ят `'team-change'` event с разным `type`.

Добавить:
- `teamsWatcher: fs.FSWatcher | null = null` property
- `tasksWatcher: fs.FSWatcher | null = null` property
- `startTeamsWatcher()` method (копия todosWatcher pattern)
- `startTasksWatcher()` method (копия todosWatcher pattern)
- `handleTeamsChange()` → emit `'team-change'` с `type: 'config' | 'inbox'`
- `handleTasksChange()` → emit `'team-change'` с `type: 'task'`
- v7 (#45): `{ recursive: true }` option для fs.watch (macOS native support, Linux Node 19+)
- Update `stop()` и `dispose()` для cleanup обоих watcher'ов
- SSH polling: автоматически поддержан (бесплатно)

```typescript
// Property declarations (alongside existing projectsWatcher, todosWatcher):
private teamsWatcher: fs.FSWatcher | null = null;
private tasksWatcher: fs.FSWatcher | null = null;

// Start methods (called from start() alongside existing watchers):
private startTeamsWatcher(): void {
  const teamsPath = getTeamsBasePath();
  try {
    // v7 (#45): recursive:true — macOS native, Linux Node 19+
    this.teamsWatcher = fs.watch(teamsPath, { recursive: true }, (eventType, filename) => {
      this.handleTeamsChange(eventType, filename);
    });
    this.teamsWatcher.on('error', (err) => {
      logger.warn('Teams watcher error, scheduling retry:', err.message);
      this.teamsWatcher = null;
      setTimeout(() => this.startTeamsWatcher(), WATCHER_RETRY_MS);
    });
  } catch {
    logger.debug('Teams dir not available, will retry');
    setTimeout(() => this.startTeamsWatcher(), WATCHER_RETRY_MS);
  }
}

private startTasksWatcher(): void {
  const tasksPath = getTasksBasePath();
  try {
    this.tasksWatcher = fs.watch(tasksPath, { recursive: true }, (eventType, filename) => {
      this.handleTasksChange(eventType, filename);
    });
    this.tasksWatcher.on('error', (err) => {
      logger.warn('Tasks watcher error, scheduling retry:', err.message);
      this.tasksWatcher = null;
      setTimeout(() => this.startTasksWatcher(), WATCHER_RETRY_MS);
    });
  } catch {
    logger.debug('Tasks dir not available, will retry');
    setTimeout(() => this.startTasksWatcher(), WATCHER_RETRY_MS);
  }
}

// Change handlers with debounce (reuse existing debounce pattern):
private handleTeamsChange(eventType: string, filename: string | null): void {
  // Debounce + determine team name from filename path
  // filename = "my-team/config.json" or "my-team/inboxes/member.json"
  const teamName = filename?.split(path.sep)[0] ?? 'unknown';
  const isInbox = filename?.includes('inboxes');
  this.emit('team-change', {
    type: isInbox ? 'inbox' : 'config',
    teamName,
    detail: filename ?? undefined,
  } satisfies TeamChangeEvent);
}

private handleTasksChange(eventType: string, filename: string | null): void {
  const teamName = filename?.split(path.sep)[0] ?? 'unknown';
  this.emit('team-change', {
    type: 'task',
    teamName,
    detail: filename ?? undefined,
  } satisfies TeamChangeEvent);
}

// Cleanup (in stop() and dispose()):
if (this.teamsWatcher) { this.teamsWatcher.close(); this.teamsWatcher = null; }
if (this.tasksWatcher) { this.tasksWatcher.close(); this.tasksWatcher = null; }
```

Total: ~120 LOC в FileWatcher (60 per watcher) + 20 LOC wiring в main/index.ts

**Modify** `src/main/index.ts` — **v6 FIX: wiring ВНУТРЬ `wireFileWatcherEvents()`** (баг #25)

> **v6 FIX**: Standalone `setupTeamChangeForwarding()` сломается при SSH context switch,
> потому что `wireFileWatcherEvents()` перезапускается для нового context, а standalone — нет.
> Интеграция внутрь `wireFileWatcherEvents()` гарантирует переподключение при смене context.

```typescript
// В wireFileWatcherEvents() (src/main/index.ts, ~line 105):
// ДОБАВИТЬ рядом с существующими file-change и todo-change handlers:

function wireFileWatcherEvents(fileWatcher: FileWatcher, win: BrowserWindow): () => void {
  // ... existing file-change handler ...
  // ... existing todo-change handler ...

  // v6: team-change forwarding (ВНУТРИ wireFileWatcherEvents, не standalone)
  // v7 FIX (#36): flat import, не IPC_CHANNELS object
  const teamChangeHandler = (event: TeamChangeEvent) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send(TEAM_CHANGE, event);
    }
    // v7 FIX (#44): broadcast to HTTP sidecar (browser mode support)
    httpServer?.broadcast('team-change', event);
  };
  fileWatcher.on('team-change', teamChangeHandler);

  // Return combined cleanup (existing + team)
  return () => {
    // ... existing cleanup ...
    fileWatcher.off('team-change', teamChangeHandler);
  };
}
```

### Step 11: Global TeamDataService (v6 FIX: НЕ в ServiceContext)

> **v6 FIX (баг #26)**: ServiceContext — per-workspace (создаётся заново при SSH context switch).
> TeamDataService читает `~/.claude/teams/` и `~/.claude/tasks/` — ЛОКАЛЬНЫЕ пути,
> не зависящие от workspace/SSH. Аналогично UpdaterService — создаётся один раз глобально.

**Modify** `src/main/index.ts` — создать TeamDataService глобально:

```typescript
import { createTeamDataService } from '@main/services/team';
import { cleanupOrphanTmpFiles } from '@main/services/team/atomicWrite';
import { getTeamsBasePath, getTasksBasePath } from '@main/utils/pathDecoder';

// Global — не зависит от ServiceContext/workspace
const teamDataService = createTeamDataService(
  getTeamsBasePath(),
  getTasksBasePath()
);

// Orphan cleanup on startup
cleanupOrphanTmpFiles([getTeamsBasePath(), getTasksBasePath()]);
```

**Modify** `src/main/ipc/handlers.ts` — v7 FIX (#48): добавить teamDataService как параметр:

```typescript
import { initializeTeamHandlers, registerTeamHandlers, removeTeamHandlers } from './teams';
import type { TeamDataService } from '@main/services/team';

// v7 FIX (#48): signature расширен — teamDataService передаётся напрямую (global, не из context)
// Existing params сохранены, добавлен последний параметр
export function initializeIpcHandlers(
  registry: ServiceContextRegistry,
  updater: UpdaterService,
  sshManager: SshConnectionManager,
  contextCallbacks: { /* existing */ },
  teamDataService: TeamDataService  // v7: global parameter, НЕ из ServiceContext
): void {
  // ... existing initialize calls (projects, sessions, search, etc.) ...

  // Team handlers — global service
  initializeTeamHandlers(teamDataService);

  // ... existing register calls ...
  registerTeamHandlers(ipcMain);

  logger.info('All handlers registered');
}

export function removeIpcHandlers(): void {
  // ... existing remove calls ...
  removeTeamHandlers(ipcMain);
  logger.info('All handlers removed');
}
```

**НЕ модифицируем** `ServiceContext.ts` — TeamDataService туда НЕ добавляется.

---

## Phase 2: Frontend (Renderer)

### Step 12: unwrapIpc<T>() (ИСПРАВЛЕН: без double wrapping)

**Create** `src/renderer/utils/unwrapIpc.ts`

```typescript
import { createLogger } from '@shared/utils/logger';

const logger = createLogger('api:unwrap');

export class IpcError extends Error {
  constructor(
    public operation: string,
    message: string,
    public originalError?: unknown
  ) {
    super(message);
    this.name = 'IpcError';
  }
}

/**
 * Единая обёртка для IPC вызовов.
 *
 * v4 FIX: invokeIpcWithResult() в preload УЖЕ throws на !success,
 * поэтому НЕ нужен второй unwrap. Просто catch + wrap в IpcError.
 *
 * Использование:
 *   const teams = await unwrapIpc('team:list', () => api.teams.list());
 */
export async function unwrapIpc<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[IPC:${operation}] Failed: ${message}`);
    throw new IpcError(operation, message, error);
  }
}

// v4: unwrapIpcResult УДАЛЁН — preload уже делает unwrap.
// Если handler возвращает IpcResult<T>, preload/invokeIpcWithResult
// автоматически проверяет success и throws Error на failure.
// unwrapIpc достаточно для всех случаев.
```

### Step 13: Tab Type — Discriminated Union (v6: полная карта миграции 12 файлов)

> **v6 FIX**: v5 насчитал 8 файлов. Реально 12+ файлов, 30-35 строк.
> Пропущены: TabBar.tsx (6+ unsafe accesses), notificationSlice.ts, contextStorage.ts.
> BaseTab поля исправлены: `fromSearch`, `savedScrollTop`, `showContextPanel` → session-only.
> TabInput тип требует distributive variant.

**Полная карта миграции (12 файлов):**

| Файл | Строк | Статус |
|------|-------|--------|
| `store/slices/tabSlice.ts` | 8 | 6 с guards, 2 в factory. TabInput нужен distributive |
| `store/slices/sessionDetailSlice.ts` | 3 | все с guards |
| `store/slices/contextSlice.ts` | 4 | все с guards |
| `store/slices/notificationSlice.ts` | 3 | **ПРОПУЩЕН в v5**: creates SessionTab via openTab, findTabBySessionAndProject |
| `store/slices/paneSlice.ts` | 1 | с guard |
| `store/index.ts` | 2 | 1 unsafe (projectId access) |
| `components/layout/PaneContent.tsx` | 4 | все с type switch, добавить 'team' case |
| `components/layout/SortableTab.tsx` | 3 | 2 с guards, 1 TAB_ICONS → добавить 'team' |
| `components/layout/SessionTabContent.tsx` | 2 | UNSAFE: нет type check |
| `components/layout/TabBar.tsx` | 6 | **ПРОПУЩЕН в v5**: activeTab.projectId, contextMenuTab?.sessionId (6+ accesses) |
| `services/contextStorage.ts` | 2 | **ПРОПУЩЕН в v5**: ContextSnapshot.openTabs: Tab[] → version migration |
| Test files | ~5 | Тесты конструирующие Tab objects |

**Unsafe-места (нужен type narrowing):**
1. `SessionTabContent.tsx:65` — добавить `if (isSessionTab(tab))`
2. `store/index.ts:259` — `visibleSessionTab?.projectId` → narrow first
3. `TabBar.tsx:213` — `activeTab.projectId && activeTab.sessionId` → narrow
4. `TabBar.tsx:239-244` — `contextMenuTab?.sessionId` (4 accesses) → narrow
5. `notificationSlice.ts` — openTab input shape → SessionTabInput
6. `contextStorage.ts` — IndexedDB snapshot version bump (old Tab shape → new union)

**Modify** `src/renderer/types/tabs.ts`

```typescript
// v6: Discriminated union. Session-only поля на SessionTab, НЕ на BaseTab.
// 12 файлов миграции. TabInput — distributive variant.

interface BaseTab {
  id: string;
  label: string;
  createdAt: number;
  // Shared UI fields (genuinely used by ALL tab types):
  pendingNavigation?: TabNavigationRequest;
  lastConsumedNavigationId?: string;
}

export interface SessionTab extends BaseTab {
  type: 'session';
  sessionId: string;
  projectId: string;
  // v6 FIX: session-only поля (НЕ на BaseTab):
  fromSearch?: boolean;
  savedScrollTop?: number;
  showContextPanel?: boolean;
}

/** v7 FIX (#43): List view — singleton tab для списка всех команд */
export interface TeamsTab extends BaseTab {
  type: 'teams';
}

/** Individual team detail tab */
export interface TeamTab extends BaseTab {
  type: 'team';
  teamName: string;
}

export interface DashboardTab extends BaseTab {
  type: 'dashboard';
}

export interface NotificationsTab extends BaseTab {
  type: 'notifications';
}

export interface SettingsTab extends BaseTab {
  type: 'settings';
}

export type Tab = SessionTab | TeamsTab | TeamTab | DashboardTab | NotificationsTab | SettingsTab;

// Type guards
export function isSessionTab(tab: Tab): tab is SessionTab {
  return tab.type === 'session';
}

export function isTeamsTab(tab: Tab): tab is TeamsTab {
  return tab.type === 'teams';
}

export function isTeamTab(tab: Tab): tab is TeamTab {
  return tab.type === 'team';
}

// v6 FIX: TabInput — distributive variant (Omit<union> не дистрибутивен в TypeScript)
export type SessionTabInput = Omit<SessionTab, 'id' | 'createdAt'>;
export type TeamsTabInput = Omit<TeamsTab, 'id' | 'createdAt'>;
export type TeamTabInput = Omit<TeamTab, 'id' | 'createdAt'>;
export type DashboardTabInput = Omit<DashboardTab, 'id' | 'createdAt'>;
export type NotificationsTabInput = Omit<NotificationsTab, 'id' | 'createdAt'>;
export type SettingsTabInput = Omit<SettingsTab, 'id' | 'createdAt'>;
export type TabInput = SessionTabInput | TeamsTabInput | TeamTabInput | DashboardTabInput | NotificationsTabInput | SettingsTabInput;
```

**NOTE**: Breaking change для 12 файлов. Все `tab.sessionId` → type narrowing: `if (isSessionTab(tab)) { tab.sessionId }`.
**NOTE**: `contextStorage.ts` — bump SNAPSHOT_VERSION, handle deserialization of old Tab shape.

### Step 14: teamSlice (ИСПРАВЛЕН: cleanup, без setTimeout, delivery status)

**Create** `src/renderer/store/slices/teamSlice.ts`

```typescript
import { unwrapIpc, IpcError } from '@renderer/utils/unwrapIpc';
import type { TeamData, TeamSummary, KanbanTaskState, SendMessageResult } from '@shared/types';

const { api } = window.electronAPI;

// Generation pattern из sessionSlice
const teamRefreshGeneration = new Map<string, number>();

export interface TeamSlice {
  // State
  teams: TeamSummary[];
  teamsLoading: boolean;
  teamsError: string | null;
  selectedTeamName: string | null;
  selectedTeamData: TeamData | null;
  selectedTeamLoading: boolean;
  selectedTeamError: string | null;
  /** v4: flag for component-level redirect (вместо setTimeout) */
  teamDeletedRedirect: boolean;
  /** v4: message delivery state */
  sendingMessage: boolean;
  lastSendResult: SendMessageResult | null;
  sendError: string | null;

  // Actions
  fetchTeams: () => Promise<void>;
  selectTeam: (teamName: string) => Promise<void>;
  refreshTeamData: (teamName: string) => Promise<void>;
  sendTeamMessage: (member: string, text: string, summary?: string) => Promise<void>;
  moveTaskToColumn: (taskId: string, state: Partial<KanbanTaskState>) => Promise<void>;
  openTeamTab: (teamName: string) => void;
  openTeamsListTab: () => void;
  /** v4: cleanup generation map при закрытии tab */
  cleanupTeamState: (teamName: string) => void;
  clearTeamDeletedRedirect: () => void;
}

export const createTeamSlice: StateCreator<AppState, [], [], TeamSlice> = (set, get) => ({
  teams: [],
  teamsLoading: false,
  teamsError: null,
  selectedTeamName: null,
  selectedTeamData: null,
  selectedTeamLoading: false,
  selectedTeamError: null,
  teamDeletedRedirect: false,
  sendingMessage: false,
  lastSendResult: null,
  sendError: null,

  fetchTeams: async () => {
    set({ teamsLoading: true, teamsError: null });
    try {
      const teams = await unwrapIpc('team:list', () => api.teams.list());
      set({ teams, teamsLoading: false });
    } catch (error) {
      set({
        teamsError: error instanceof IpcError ? error.message : String(error),
        teamsLoading: false,
      });
    }
  },

  selectTeam: async (teamName: string) => {
    set({
      selectedTeamName: teamName,
      selectedTeamLoading: true,
      selectedTeamError: null,
      teamDeletedRedirect: false,
    });
    try {
      const data = await unwrapIpc('team:getData', () => api.teams.getData(teamName));
      set({ selectedTeamData: data, selectedTeamLoading: false });
    } catch (error) {
      if (error instanceof IpcError && error.message.includes('not found')) {
        // v4: set flag, компонент обработает redirect в useEffect
        set({
          selectedTeamData: null,
          selectedTeamError: 'Team was deleted',
          selectedTeamLoading: false,
          teamDeletedRedirect: true,
        });
        return;
      }
      set({ selectedTeamError: String(error), selectedTeamLoading: false });
    }
  },

  refreshTeamData: async (teamName: string) => {
    const generation = (teamRefreshGeneration.get(teamName) ?? 0) + 1;
    teamRefreshGeneration.set(teamName, generation);

    try {
      const data = await unwrapIpc('team:getData', () => api.teams.getData(teamName));
      if (teamRefreshGeneration.get(teamName) !== generation) return;
      set({ selectedTeamData: data, selectedTeamLoading: false });
    } catch (error) {
      if (teamRefreshGeneration.get(teamName) === generation) {
        set({ selectedTeamError: String(error), selectedTeamLoading: false });
      }
    }
  },

  sendTeamMessage: async (member: string, text: string, summary?: string) => {
    const teamName = get().selectedTeamName;
    if (!teamName) return;

    set({ sendingMessage: true, sendError: null, lastSendResult: null });
    try {
      const result = await unwrapIpc('team:sendMessage', () =>
        api.teams.sendMessage(teamName, member, text, summary)
      );
      set({ sendingMessage: false, lastSendResult: result });
      // Refresh data to show new message
      get().refreshTeamData(teamName);
    } catch (error) {
      set({
        sendingMessage: false,
        sendError: error instanceof IpcError ? error.message : String(error),
      });
    }
  },

  // v4: cleanup при закрытии team tab
  cleanupTeamState: (teamName: string) => {
    teamRefreshGeneration.delete(teamName);
  },

  clearTeamDeletedRedirect: () => {
    set({ teamDeletedRedirect: false });
  },

  // ... moveTaskToColumn, openTeamTab, openTeamsListTab
});
```

**Modify** `src/renderer/store/types.ts` — `& TeamSlice`
**Modify** `src/renderer/store/index.ts` — compose + team-change listener:

```typescript
// В initializeNotificationListeners():
// v7 FIX (#46): throttle/coalesce — multiple rapid file changes → single refresh
let teamRefreshTimer: ReturnType<typeof setTimeout> | null = null;
const TEAM_REFRESH_THROTTLE_MS = 300;

api.teams.onTeamChange((event: TeamChangeEvent) => {
  const state = useStore.getState();
  if (state.selectedTeamName !== event.teamName) return;

  // Coalesce rapid changes (e.g., multiple task files written in 100ms)
  if (teamRefreshTimer) clearTimeout(teamRefreshTimer);
  teamRefreshTimer = setTimeout(() => {
    teamRefreshTimer = null;
    const currentState = useStore.getState();
    if (currentState.selectedTeamName === event.teamName) {
      currentState.refreshTeamData(event.teamName);
    }
  }, TEAM_REFRESH_THROTTLE_MS);
});

// Also refresh teams list on any team-change (for TeamListView updates)
api.teams.onTeamChange(() => {
  // Simpler: just refetch teams list (lightweight operation)
  useStore.getState().fetchTeams();
});
```

### Step 15: Tab Integration (v7: + TeamsTab)

- `SortableTab.tsx` — `teams: Users, team: Users` in TAB_ICONS (v7: два типа)
- `PaneContent.tsx`:
  ```typescript
  // v7 FIX (#43): separate TeamsTab (list) vs TeamTab (detail)
  {isTeamsTab(tab) && <TeamView />}
  {isTeamTab(tab) && <TeamView teamName={tab.teamName} />}
  ```
  TeamView без teamName → renders TeamListView; с teamName → TeamDetailView
- `TabBar.tsx` — Teams button: `openTeamsListTab()` (singleton)
- При close team tab → вызвать `cleanupTeamState(tab.teamName)`
- TeamsTab — singleton: при повторном клике не создаёт новый tab, а переключает на существующий

### Step 16: UI Components + Empty States

```
src/renderer/components/team/
├── TeamView.tsx              — Router: list vs detail
├── TeamListView.tsx          — Grid of team cards
├── TeamDetailView.tsx        — Members (left) + Kanban (center) + Activity (right)
├── TeamEmptyState.tsx        — No teams (icon + message)
├── TeamDetailLoadingState.tsx — Skeleton for all 3 panels (NEW v4)
├── members/
│   ├── MemberList.tsx        — Left panel (240px)
│   ├── MemberCard.tsx        — Color dot, name, status, current task
│   └── MemberListEmpty.tsx   — "No members" (NEW v4)
├── kanban/
│   ├── KanbanBoard.tsx       — 5 columns, click-to-move
│   ├── KanbanColumn.tsx      — Header + count + cards
│   ├── KanbanTaskCard.tsx    — Owner badge, subject, column selector, blocked indicator
│   ├── ReviewBadge.tsx       — Approve/RequestChanges badge
│   └── KanbanEmpty.tsx       — "No tasks" (NEW v4)
├── activity/
│   ├── ActivityTimeline.tsx  — Right panel (320px)
│   ├── ActivityItem.tsx      — Color dot, sender, time, summary
│   ├── MessageComposer.tsx   — Recipient + textarea + send + delivery status
│   └── ActivityEmpty.tsx     — "No messages" (NEW v4)
└── dialogs/
    └── ReviewDialog.tsx      — Approve / Request Changes с комментарием
```

### Step 17: KanbanBoard с явным props flow (NEW в v4)

```typescript
// Данные текут: teamSlice.selectedTeamData → TeamDetailView → KanbanBoard

interface KanbanBoardProps {
  tasks: TeamTask[];
  kanbanState: KanbanState;
  onMoveTask: (taskId: string, column: KanbanColumnId) => Promise<void>;
  onRequestReview: (taskId: string) => void;
}

// TeamDetailView пробрасывает:
<KanbanBoard
  tasks={selectedTeamData.tasks}
  kanbanState={selectedTeamData.kanbanState}
  onMoveTask={(taskId, column) => moveTaskToColumn(taskId, { column })}
  onRequestReview={(taskId) => setReviewDialogTaskId(taskId)}
/>

// KanbanBoard группирует tasks по columns:
// 1. tasks с kanbanState → используем kanbanState.column
// 2. tasks БЕЗ kanbanState → v7 FIX (#41) маппинг по task.status:
//    pending → todo, in_progress → in_progress, completed → done
//
// v7 NOTE: auto-review is Phase 2. MVP maps completed → 'done'.
// User can manually move tasks to 'review' column via click-to-move.
// Rationale: auto-mapping completed → review is opinionated and may confuse users
// who expect 'done' to mean 'done'.

// KanbanTaskCard:
interface KanbanTaskCardProps {
  task: TeamTask;
  kanbanState?: KanbanTaskState;
  onMoveToColumn: (column: KanbanColumnId) => void;
  isBlocked: boolean;  // task.blockedBy.length > 0
}

// Blocked tasks: полупрозрачный + иконка 🔒 + tooltip "Blocked by #X, #Y"
```

### Step 18: MessageComposer + delivery status (ДОПОЛНЕН в v4)

```typescript
interface MessageComposerProps {
  members: ResolvedTeamMember[];
  onSend: (member: string, text: string, summary?: string) => Promise<void>;
  sending: boolean;        // from teamSlice.sendingMessage
  sendError: string | null; // from teamSlice.sendError
  lastResult: SendMessageResult | null; // from teamSlice.lastSendResult
}

// UI states:
// 1. Idle: textarea + recipient select + "Send" button
// 2. Sending: "Sending..." + disabled button + spinner
// 3. Sent: "Delivered ✓" toast (3 sec) + clear textarea
// 4. Error: "Failed: {error}" toast (red) + "Retry" button
```

### Step 19: ReviewDialog (без изменений из v3)

---

## Write-Path Safety (обновлён в v4)

### Inbox Protocol (без изменений)

- **Формат**: JSON array `[{from, text, timestamp, read, ...}, ...]`
- **Доставка**: между turns, 1-30 сек задержка
- **Поле `from`**: `"user"` (наше приложение всегда от имени юзера)
- **Сообщения НЕ удаляются**

### Write Strategy (v4 — исправлена)

```
read JSON → parse → append message →
  atomicWriteAsync(tmp → fsync → rename) →
  verify(messageId) →
  retry (до 3 раз, exponential backoff)
```

| Уровень защиты | v3 | v4 | Изменение |
|-----------------|----|----|-----------|
| Atomic write | tmp + fsync + rename | + mkdir + 'r+' flag + EXDEV | Исправлены 3 бага |
| Async write | Sync (блокирует event loop) | fs.promises (non-blocking) | Новое |
| Retry | "до 5 попыток в UI" (не реализовано) | appendToInboxWithRetry, 3 попытки, backoff | Реализовано |
| Orphan cleanup | "На startup" (не реализовано) | cleanupOrphanTmpFiles() в main/index.ts | Реализовано |
| Kanban write | Обычный writeFileSync | atomicWriteSync | Исправлено |
| messageId verify | Sync read-back | Async read-back | Обновлено |

### Что НЕ нужно на MVP (без изменений)

- File locking
- Append-only JSONL
- Separate .ui-inbox.json
- Compare-And-Swap

---

## Phase 3: Testing (NEW в v4)

### Тестовая стратегия

```
test/
├── main/
│   ├── services/team/
│   │   ├── TeamConfigReader.test.ts     — listTeams, getConfig, missing dirs
│   │   ├── TeamTaskReader.test.ts       — getTasks, skip .lock/.highwatermark
│   │   ├── TeamInboxReader.test.ts      — getMessages, sendMessage, verify
│   │   ├── TeamMemberResolver.test.ts   — resolveMembers, status detection
│   │   ├── TeamKanbanManager.test.ts    — CRUD, GC, atomic write
│   │   ├── TeamDataService.test.ts      — orchestration, Promise.allSettled
│   │   └── atomicWrite.test.ts          — sync, async, fsync, EXDEV, race
│   └── ipc/
│       ├── teams.test.ts               — guard, all handlers, wrapTeamHandler
│       └── guards.test.ts (extend)     — validateTeamName, validateTaskId
├── renderer/
│   ├── utils/
│   │   └── unwrapIpc.test.ts           — unwrapIpc, IpcError wrapping
│   ├── store/
│   │   └── teamSlice.test.ts           — actions, generation pattern, redirect
│   └── components/team/
│       └── KanbanBoard.test.ts         — column mapping, blocked tasks
├── fixtures/team/
│   ├── config.json                     — sample team config
│   ├── task-001.json                   — sample task
│   ├── member-inbox.json               — sample inbox (5 messages)
│   ├── kanban-state.json               — sample kanban state
│   └── corrupted/                      — invalid JSON samples
└── mocks/
    └── teamFixtures.ts                 — createMockTeamConfig, createMockTeamTask, etc.
```

### Приоритеты

| Priority | Файлы | Что покрывают |
|----------|-------|---------------|
| P0 (must) | atomicWrite, TeamInboxReader, TeamDataService, teamSlice, teams.test | Core write-path + store |
| P1 (should) | ConfigReader, TaskReader, MemberResolver, KanbanManager, unwrapIpc | Все readers + утилиты |
| P2 (nice) | KanbanBoard, guards extension | UI + validation |

---

## File Change Summary

### New Files (~33)

| # | File | Purpose |
|---|------|---------|
| 1 | `src/shared/types/ipc.ts` | IpcResult<T> (deduplicated) |
| 2 | `src/shared/types/team.ts` | Shared types |
| 3 | `src/main/services/team/interfaces.ts` | 5 интерфейсов (NEW v4) |
| 4 | `src/main/services/team/TeamConfigReader.ts` | Read config.json |
| 5 | `src/main/services/team/TeamTaskReader.ts` | Read task files |
| 6 | `src/main/services/team/TeamInboxReader.ts` | Read/write inbox |
| 7 | `src/main/services/team/TeamMemberResolver.ts` | Resolve members |
| 8 | `src/main/services/team/TeamKanbanManager.ts` | Kanban state CRUD |
| 9 | `src/main/services/team/TeamDataService.ts` | Facade |
| 10 | `src/main/services/team/TeamDataServiceFactory.ts` | Composition root (NEW v4) |
| 11 | `src/main/services/team/atomicWrite.ts` | Atomic write utils |
| 12 | `src/main/services/team/index.ts` | Barrel |
| 13 | `src/main/ipc/teams.ts` | IPC handlers |
| 14 | `src/renderer/utils/unwrapIpc.ts` | IPC error utility |
| 15 | `src/renderer/store/slices/teamSlice.ts` | Store slice |
| 16-30 | `src/renderer/components/team/**` | 15 UI components (+3 empty states) |
| 31 | `test/mocks/teamFixtures.ts` | Test fixtures |
| 32 | `test/fixtures/team/*` | Sample data |

### Modified Files (~18)

| # | File | Change |
|---|------|--------|
| 1 | `src/shared/types/index.ts` | Re-export team types + IpcResult |
| 2 | `src/shared/types/api.ts` | TeamsAPI + ElectronAPI |
| 3 | `src/main/ipc/config.ts` | Replace ConfigResult → IpcResult |
| 4 | `src/main/utils/pathDecoder.ts` | getTeamsBasePath(), getTasksBasePath() |
| 5 | `src/main/services/index.ts` | Barrel export |
| 6 | ~~`src/main/services/infrastructure/ServiceContext.ts`~~ | ~~v4: + teamDataService~~ v6: НЕ модифицируем |
| 7 | `src/main/ipc/handlers.ts` | Wire team init/register/remove + teamDataService param (v7 #48) |
| 8 | `src/main/ipc/guards.ts` | validateTeamName, validateTaskId, validateMemberName (v7 #39) |
| 9 | `src/preload/constants/ipcChannels.ts` | TEAM_* channels (flat export const, v7 #36) |
| 10 | `src/preload/index.ts` | teams API bridge + IpcResult from @shared |
| 11 | `src/main/services/infrastructure/FileWatcher.ts` | TWO watchers: teamsWatcher + tasksWatcher (v7 #35) |
| 12 | `src/main/index.ts` | Forward events, create service, orphan cleanup, httpServer.broadcast (v7 #44) |
| 13 | `src/renderer/types/tabs.ts` | Discriminated union + TeamsTab (v7 #43) |
| 14 | `src/renderer/store/types.ts` | TeamSlice |
| 15 | `src/renderer/store/index.ts` | Compose + team-change listener + throttle (v7 #46) |
| 16 | `src/renderer/components/layout/PaneContent.tsx` | TeamsTab + TeamTab rendering |
| 17 | `src/renderer/api/httpClient.ts` | teams methods for browser mode |
| 18 | `test/mocks/electronAPI.ts` | + teams mock methods |

---

## Architecture Diagram (v6)

```
┌──────────────────── RENDERER ────────────────────┐
│                                                   │
│  Components ──→ teamSlice ──→ unwrapIpc()         │
│  (TeamView,     (state +       (catch+wrap,       │
│   KanbanBoard,   generation     NO double unwrap) │
│   empty states)  + cleanup)                       │
│                       │                           │
│                       ↓ window.electronAPI.teams  │
├───────────────── PRELOAD BRIDGE ─────────────────┤
│                                                   │
│  TeamsAPI interface ←→ IPC Channels               │
│  invokeIpcWithResult() already handles IpcResult  │
│                                                   │
├──────────────────── MAIN PROCESS ────────────────┤
│                                                   │
│  teams.ts ──→ TeamDataService (Facade)            │
│  (module-level    ┌──────────────────────────┐   │
│   + wrapHandler)  │ INTERFACES (DI/testing): │   │
│                   │ ITeamConfigReader         │   │
│  GLOBAL instance  │ ITeamTaskReader           │   │
│  (v6: не в       │ ITeamInboxReader          │   │
│   ServiceContext) │ ITeamMemberResolver       │   │
│                   │ ITeamKanbanManager        │   │
│                   └──────┬───────────────────┘   │
│                          │ atomicWrite            │
│                          │ (async + retry)        │
│                                                   │
│  FileWatcher ──→ 'team-change' ──→ renderer       │
│  (v7: TWO new     + httpServer.broadcast          │
│   watchers:        v6: INSIDE wireFileWatcherEvents│
│   teamsWatcher                                     │
│   + tasksWatcher)                                  │
│                                                   │
├──────────────────── SHARED ──────────────────────┤
│  types/ipc.ts  (IpcResult<T>)                     │
│  types/team.ts (interfaces, discriminated unions)  │
└───────────────────────────────────────────────────┘
```

---

## Verification

1. `pnpm typecheck` — типы компилируются (включая Tab discriminated union)
2. `pnpm dev` — Teams tab открывается, список / пустое состояние
3. Kanban: задачи по 5 колонкам из status + kanban-state
4. Click-to-move: select колонку → задача перемещается
5. Blocked tasks: визуальный индикатор + tooltip
6. Review: Approve/Request Changes badges
7. Messaging: отправка с delivery status (Sending → Sent/Error)
8. Live updates: изменение task-файла → UI обновляется (FileWatcher → team:change → store)
9. Team deletion: graceful redirect через flag (не setTimeout)
10. `pnpm lint:fix && pnpm format`
11. `pnpm test` — тесты не сломаны
12. `pnpm test:teams` — новые тесты проходят

---

## Integration Checklist (v5 — по результатам end-to-end трассировки)

> Агент протрассировал полный путь данных от файла до экрана.
> 12 точек интеграции с exact file:line references.

### Existing Pattern (Session flow — reference):
```
FileWatcher.emit('file-change')     → src/main/services/infrastructure/FileWatcher.ts:552
main/index.ts sends to renderer     → src/main/index.ts:121 (webContents.send)
preload exposes onFileChange        → src/preload/index.ts:334
store listener triggers refresh     → src/renderer/store/index.ts:208
```

### Team Integration Points (ALL 12):

| # | Что | Файл | Действие |
|---|-----|------|----------|
| 1 | IPC channel constants | `src/preload/constants/ipcChannels.ts` (EOF) | Добавить `TEAM_*` (6 flat `export const`, v7 #36) |
| 2 | Preload API methods | `src/preload/index.ts` (~line 461) | `teams: { getData, list, sendMessage, onTeamChange }` |
| 3 | Preload event listener | `src/preload/index.ts` (~line 463) | `ipcRenderer.on('team-change', ...)` |
| 4 | API TypeScript types | `src/shared/types/api.ts` (~line 416) | `TeamsAPI` interface + extend `ElectronAPI` |
| 5 | Handler module | `src/main/ipc/teams.ts` (NEW) | 3 functions: initialize, register, remove |
| 6 | Handler registration | `src/main/ipc/handlers.ts` (lines 19-98) | Import + initialize + register + remove |
| 7 | Event forwarding | `src/main/index.ts` (lines 105-139) | Wire 'team-change' like 'file-change' |
| 8 | FileWatcher emission | `src/main/services/infrastructure/FileWatcher.ts` | Emit 'team-change' events |
| 9 | Store slice creation | `src/renderer/store/slices/teamSlice.ts` (NEW) | Create TeamSlice |
| 10 | Store composition | `src/renderer/store/index.ts` (lines 32-48) | Import + compose |
| 11 | Store listener | `src/renderer/store/index.ts` (lines 208-349) | `api.teams?.onTeamChange()` |
| 12 | Store types | `src/renderer/store/types.ts` | Extend AppState with TeamSlice |

### Critical Gotchas (из трассировки):
- Preload использует `contextBridge.exposeInMainWorld()` → все данные ДОЛЖНЫ быть JSON-serializable
- IPC channels — hardcoded strings, typos fail silently → использовать constants
- `registry.getActive()` в handlers → ServiceContext scope-aware
- Event broadcast: `.send()` (fire-forget), НЕ `.invoke()` (request-response)
- Cleanup функции onTeamChange → PUSH в cleanupFns array → return в useEffect

### Verification Order:
```bash
1. grep -r 'teams:' src/preload/constants/  # channels exist
2. grep -r 'teams\.' src/preload/index.ts   # API methods exist
3. grep -r 'team-change' src/main/          # event forwarded
4. grep -r 'onTeamChange' src/renderer/     # store listens
5. pnpm typecheck                           # types compile
6. pnpm dev → open team tab → change file   # live update works
```

---

## Write-Path Safety: In-Process Mutex (v5)

### Проблема
```
Time  IPC Call 1      IPC Call 2      File State
1     Read [A]        -               [A]
2     -               Read [A]        [A]
3     Write [A,B]     -               [A,B]
4     -               Write [A,C]     [A,C]  ← B LOST!
```

### Решение: InboxWriteQueue (v5)
```
Time  IPC Call 1      IPC Call 2      File State
1     Acquire lock    Wait...         [A]
2     Read [A]        Wait...         [A]
3     Write [A,B]     Wait...         [A,B]
4     Release lock    Acquire lock    [A,B]
5     -               Read [A,B]      [A,B]
6     -               Write [A,B,C]   [A,B,C] ← OK!
```

### Scope:
- **In-process mutex**: Решает races между concurrent IPC calls (99% случаев)
- **Cross-process (CLI)**: НЕ решено, но verify + retry ловят потерянные messages
- **Future**: JSONL append-only формат (Phase 2) устраняет проблему полностью

---

## Phase 2 (после MVP)

- @dnd-kit drag-and-drop для kanban
- Auto-review mapping: completed tasks → 'review' column (v7 #41 deferred to Phase 2)
- reviewHistory + round-robin
- State machine для member status
- Inbox archival (>1000 сообщений)
- FileWatcher → generic WatcherRegistry (если 5-й watcher, v7 now has 4)
- File locking для inbox (если race >1/day)
- JSONL inbox format (eliminates read-modify-write entirely)
- Virtual scrolling для 50+ tasks (react-virtual)
- Keyboard shortcuts для kanban (Ctrl+M → move)
- Search/filter в kanban (by owner, status)
- SSH mode: "Last updated" timestamp + slower refresh
- Structured inbox message types (discriminated union для ActivityTimeline)
- Notifications: desktop + badge для новых сообщений
- Per-tab team data (Phase 2 — MVP uses global selectedTeamData)
