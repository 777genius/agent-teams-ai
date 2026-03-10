# Phase 1: Read-Only Diff View

## Цель
Показать пользователю что конкретно изменил каждый агент/задача. Без accept/reject — только просмотр.
Кнопка "View Changes" на карточке задачи и в деталях участника.

## Зависимости (npm)
```bash
pnpm add diff    # jsdiff v8 — structuredPatch, createPatch для вычисления диффов
```

---

## Backend

### 1. Типы: `src/shared/types/review.ts` (NEW)

```typescript
/** Один snippet-level дифф от одного tool_use */
export interface SnippetDiff {
  toolUseId: string;
  filePath: string;
  toolName: 'Edit' | 'Write' | 'MultiEdit';
  type: 'edit' | 'write-new' | 'write-update' | 'multi-edit';
  oldString: string;    // пустая строка для Write (create)
  newString: string;
  replaceAll: boolean;  // Edit с replace_all: true → все вхождения old_string заменяются
  timestamp: string;    // ISO timestamp из JSONL
  isError: boolean;     // пропускаем если true
}

/** Агрегированные изменения по файлу */
export interface FileChangeSummary {
  filePath: string;
  relativePath: string;  // относительно projectPath
  snippets: SnippetDiff[];
  linesAdded: number;
  linesRemoved: number;
  isNewFile: boolean;
}

/** Полный набор изменений агента */
export interface AgentChangeSet {
  teamName: string;
  memberName: string;
  files: FileChangeSummary[];
  totalLinesAdded: number;
  totalLinesRemoved: number;
  totalFiles: number;
  computedAt: string;
}

/** Полный набор изменений задачи */
export interface TaskChangeSet {
  teamName: string;
  taskId: string;
  /** Может содержать диффы от нескольких агентов */
  files: FileChangeSummary[];
  totalLinesAdded: number;
  totalLinesRemoved: number;
  totalFiles: number;
  confidence: 'high' | 'medium' | 'low' | 'fallback';  // 'fallback' добавлен для Phase 3 Tier 4
  computedAt: string;
}

/** Краткая статистика для badge на карточке */
export interface ChangeStats {
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
}
```

### 2. Сервис: `src/main/services/team/ChangeExtractorService.ts` (NEW)

**Задача**: Парсить subagent JSONL файлы, извлекать `tool_use.input` для Edit/Write/MultiEdit.

**Паттерн**: Повторяет `MemberStatsComputer` — стримит JSONL, извлекает контент из блоков.

```typescript
import { TeamMemberLogsFinder } from './TeamMemberLogsFinder';

export class ChangeExtractorService {
  private cache = new Map<string, { data: AgentChangeSet; expiresAt: number }>();
  private readonly CACHE_TTL = 3 * 60 * 1000; // 3 мин как в MemberStatsComputer

  constructor(private logsFinder: TeamMemberLogsFinder) {}

  async getAgentChanges(teamName: string, memberName: string): Promise<AgentChangeSet>;
  async getTaskChanges(teamName: string, taskId: string): Promise<TaskChangeSet>;
  async getChangeStats(teamName: string, memberName: string): Promise<ChangeStats>;
}
```

**Ключевые нюансы парсинга subagent JSONL:**

1. **Структура entry**: `obj.message.content` — массив блоков (в отличие от main session где `obj.content`)
2. **Edit tool_use.input**:
   ```json
   { "file_path": "/abs/path", "old_string": "...", "new_string": "...", "replace_all": false }
   ```
3. **Write tool_use.input**:
   ```json
   { "file_path": "/abs/path", "content": "..." }
   ```
   - Write (create) — файл раньше не существовал. Определяем: если `old_string` нет и это первое обращение к файлу → `type: 'write-new'`
   - Write (update) — файл уже был. `type: 'write-update'`, `oldString` будет пустой (без file-history нет "before")
4. **MultiEdit tool_use.input**:
   ```json
   { "file_path": "/abs/path", "edits": [{ "old_string": "...", "new_string": "..." }, ...] }
   ```
5. **NotebookEdit — SKIP**: `NotebookEdit` имеет другую структуру input (`notebook_path`, `cell_number`, `new_source`) — **нет** `file_path`, `old_string`, `new_string`. Пропускаем при парсинге (`toolName !== 'NotebookEdit'` guard). НЕ включаем в SnippetDiff.
6. **replace_all** — при `replace_all: true` в Edit input:
   - В SnippetDiff записываем `replaceAll: true`
   - При snippet chain reconstruction используем `content.replaceAll(oldString, newString)` вместо `content.replace()`
   - При reject — нужно откатить ВСЕ вхождения, не только первое (см. Phase 2)
7. **Пропуск ошибок** — `tool_result` с `is_error: true` находится в **ДРУГОМ JSONL entry** (следующий user/isMeta entry), а НЕ в том же content массиве:
   - Парсить JSONL попарно: assistant entry (с tool_use) → user entry (с tool_result)
   - Маппить `tool_use.id` → `tool_result.tool_use_id`
   - Если `is_error: true` → пропускаем соответствующий tool_use
   - **Простой подход**: первый pass — собрать `Set<string>` errored tool_use_id из всех tool_result блоков. Второй pass — фильтровать tool_use по этому set.
8. **Фильтрация proxy_ префикса**: Имена инструментов приходят как `proxy_Edit` — нужно strip prefix (паттерн из MemberStatsComputer)
7. **Подсчёт строк** (через `jsdiff.diffLines`):
   ```typescript
   import { diffLines } from 'diff';
   const changes = diffLines(oldString, newString);
   const linesAdded = changes.filter(c => c.added).reduce((sum, c) => sum + (c.count ?? 0), 0);
   const linesRemoved = changes.filter(c => c.removed).reduce((sum, c) => sum + (c.count ?? 0), 0);
   ```
   **НЕ использовать** `newString.split('\n').length - oldString.split('\n').length` — это даёт "net difference", а не отдельные added/removed. Может давать отрицательные числа.

**Task scoping (для `getTaskChanges`):**

1. Найти JSONL файлы агента через `logsFinder.findLogsForTask(teamName, taskId)`
2. Парсить файлы, ища маркеры `TaskUpdate` tool_use:
   - `input.taskId === taskId && input.status === 'in_progress'` → начало
   - `input.taskId === taskId && input.status === 'completed'` → конец
3. Альтернативно: исторические Bash teamctl логи `task start|complete <id>` (regex)
4. Все tool_use Edit/Write между start и end маркерами = изменения задачи
5. Если 86% кейс (1 задача в сессии): вся сессия = задача

**Confidence scoring:**
- `high`: Найдены оба маркера (start + end) ИЛИ single-task session
- `medium`: Найден только end-маркер
- `low`: Нет маркеров, используем fallback (owner + text search)

### 3. IPC каналы: `src/preload/constants/ipcChannels.ts` (MODIFY)

Добавить 3 канала:
```typescript
export const REVIEW_GET_AGENT_CHANGES = 'review:getAgentChanges';
export const REVIEW_GET_TASK_CHANGES = 'review:getTaskChanges';
export const REVIEW_GET_CHANGE_STATS = 'review:getChangeStats';
```

### 4. IPC хендлеры: `src/main/ipc/review.ts` (NEW)

**Паттерн**: Копируем из `src/main/ipc/teams.ts` — module-level state + guard + wrapHandler.

```typescript
import { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { IpcResult } from '@shared/types'; // IpcResult живёт в @shared/types/ipc.ts, barrel через @shared/types
import { ChangeExtractorService } from '@main/services/team/ChangeExtractorService';
import { REVIEW_GET_AGENT_CHANGES, REVIEW_GET_TASK_CHANGES, REVIEW_GET_CHANGE_STATS } from '@preload/constants/ipcChannels';
import { createLogger } from '@shared/utils/logger';

const logger = createLogger('IPC:review');

// --- Module-level state (паттерн из teams.ts) ---

let changeExtractor: ChangeExtractorService | null = null;

function getChangeExtractor(): ChangeExtractorService {
  if (!changeExtractor) throw new Error('Review handlers not initialized');
  return changeExtractor;
}

// --- Forward-compatible config object (Phase 2/3/4 добавят новые сервисы) ---

interface ReviewHandlerDeps {
  extractor: ChangeExtractorService;
  // Phase 2 добавит: applier?: ReviewApplierService; contentResolver?: FileContentResolver;
  // Phase 4 добавит: gitFallback?: GitDiffFallback;
}

export function initializeReviewHandlers(deps: ReviewHandlerDeps): void {
  changeExtractor = deps.extractor;
}

export function registerReviewHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(REVIEW_GET_AGENT_CHANGES, handleGetAgentChanges);
  ipcMain.handle(REVIEW_GET_TASK_CHANGES, handleGetTaskChanges);
  ipcMain.handle(REVIEW_GET_CHANGE_STATS, handleGetChangeStats);
}

export function removeReviewHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(REVIEW_GET_AGENT_CHANGES);
  ipcMain.removeHandler(REVIEW_GET_TASK_CHANGES);
  ipcMain.removeHandler(REVIEW_GET_CHANGE_STATS);
}

// --- Local wrapReviewHandler (копия wrapTeamHandler из teams.ts, НЕ экспортируется) ---

async function wrapReviewHandler<T>(operation: string, handler: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    const data = await handler();
    return { success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Review handler error [${operation}]:`, message);
    return { success: false, error: message };
  }
}

// --- Handlers ---

async function handleGetAgentChanges(
  _event: IpcMainInvokeEvent,
  teamName: string,
  memberName: string
): Promise<IpcResult<AgentChangeSet>> {
  return wrapReviewHandler('getAgentChanges', () =>
    getChangeExtractor().getAgentChanges(teamName, memberName)
  );
}

// ... аналогично handleGetTaskChanges, handleGetChangeStats
```

### 5. Регистрация в main process

**Файл: `src/main/ipc/handlers.ts`** — единственное место регистрации ВСЕХ IPC handlers.

**Шаг 1: Создание сервиса** — в `src/main/index.ts`, функция `initializeServices()` (после строки ~305 где создаются team services):
```typescript
// После создания teamMemberLogsFinder и memberStatsComputer:
const changeExtractor = new ChangeExtractorService(teamMemberLogsFinder);
```

**Шаг 2: Инициализация** — в `src/main/ipc/handlers.ts`, функция `initializeIpcHandlers()`.

**ВАЖНО**: `initializeIpcHandlers()` использует ПОЗИЦИОННЫЕ параметры (9 штук, строки 76-92).
НЕ менять сигнатуру на объект! Вместо этого добавить `changeExtractor` как 10-й позиционный параметр:

```typescript
// handlers.ts — расширение сигнатуры:
export function initializeIpcHandlers(
  registry: ServiceContextRegistry,
  updater: UpdaterService,
  sshManager: SshConnectionManager,
  teamDataService: TeamDataService,
  teamProvisioningService: TeamProvisioningService,
  teamMemberLogsFinder: TeamMemberLogsFinder,
  memberStatsComputer: MemberStatsComputer,
  contextCallbacks: { ... },
  httpServerDeps?: { ... },
  changeExtractor?: ChangeExtractorService  // ← Phase 1 addition (optional для backward compat)
): void {
  // ... existing initialization ...
  if (changeExtractor) {
    initializeReviewHandlers({ extractor: changeExtractor });
  }
```

```typescript
// index.ts — добавить 10-й аргумент при вызове:
initializeIpcHandlers(
  contextRegistry,
  updaterService,
  sshConnectionManager,
  teamDataService,
  teamProvisioningService,
  teamMemberLogsFinder,
  memberStatsComputer,
  contextCallbacks,
  httpServerDeps,
  changeExtractor  // ← Phase 1
);
```

**Шаг 3: Регистрация** — в `src/main/ipc/handlers.ts`, после `registerTeamHandlers(ipcMain)` (строка ~130):
```typescript
registerReviewHandlers(ipcMain);
```

**Шаг 4: Cleanup** — в `src/main/ipc/handlers.ts`, функция `removeIpcHandlers()` (после `removeTeamHandlers(ipcMain)`, строка ~155):
```typescript
removeReviewHandlers(ipcMain);
```

**Шаг 5: Import** — в `src/main/ipc/handlers.ts`, добавить import:
```typescript
import { initializeReviewHandlers, registerReviewHandlers, removeReviewHandlers } from './review';
```

### 6. Preload bridge + ElectronAPI типы

#### 6a. Типы: `src/shared/types/api.ts` (MODIFY)

**ВАЖНО**: `ElectronAPI` интерфейс (строки ~406-519) типизирует `window.electronAPI`.
Без добавления `review` — TypeScript не пропустит `api.review.*` вызовы.

```typescript
// В src/shared/types/api.ts добавить:

import type { AgentChangeSet, TaskChangeSet, ChangeStats } from './review';

export interface ReviewAPI {
  getAgentChanges: (teamName: string, memberName: string) => Promise<AgentChangeSet>;
  getTaskChanges: (teamName: string, taskId: string) => Promise<TaskChangeSet>;
  getChangeStats: (teamName: string, memberName: string) => Promise<ChangeStats>;
}

// В ElectronAPI интерфейс добавить поле:
export interface ElectronAPI {
  // ... existing fields ...
  review: ReviewAPI;
}
```

#### 6b. HttpAPIClient: `src/renderer/api/httpClient.ts` (MODIFY)

Для browser mode (SSH/remote) нужны заглушки:
```typescript
// В HttpAPIClient class добавить:
review = {
  getAgentChanges: async () => { throw new Error('Review not available in browser mode'); },
  getTaskChanges: async () => { throw new Error('Review not available in browser mode'); },
  getChangeStats: async () => { throw new Error('Review not available in browser mode'); },
};
```

#### 6c. Preload: `src/preload/index.ts` (MODIFY)

Добавить в `electronAPI` объект:
```typescript
review: {
  getAgentChanges: (teamName: string, memberName: string) =>
    invokeIpcWithResult<AgentChangeSet>(REVIEW_GET_AGENT_CHANGES, teamName, memberName),
  getTaskChanges: (teamName: string, taskId: string) =>
    invokeIpcWithResult<TaskChangeSet>(REVIEW_GET_TASK_CHANGES, teamName, taskId),
  getChangeStats: (teamName: string, memberName: string) =>
    invokeIpcWithResult<ChangeStats>(REVIEW_GET_CHANGE_STATS, teamName, memberName),
},
```

---

## Frontend

### 7. Zustand slice: `src/renderer/store/slices/changeReviewSlice.ts` (NEW)

```typescript
export interface ChangeReviewSlice {
  // State
  activeChangeSet: AgentChangeSet | TaskChangeSet | null;
  changeSetLoading: boolean;
  changeSetError: string | null;
  selectedReviewFilePath: string | null;
  changeStatsCache: Record<string, ChangeStats>; // key = "teamName:memberName"

  // Actions
  fetchAgentChanges: (teamName: string, memberName: string) => Promise<void>;
  fetchTaskChanges: (teamName: string, taskId: string) => Promise<void>;
  selectReviewFile: (filePath: string | null) => void;
  clearChangeReview: () => void;
  fetchChangeStats: (teamName: string, memberName: string) => Promise<void>;
}
```

**Паттерн**: Копируем из teamSlice — loading/error/data + async actions с try/catch.

Зарегистрировать в `src/renderer/store/index.ts` как новый slice.

**ВАЖНО**: Также обновить `src/renderer/store/types.ts`:
```typescript
import type { ChangeReviewSlice } from './slices/changeReviewSlice';

export type AppState = ProjectSlice &
  // ... existing slices ...
  UpdateSlice &
  ChangeReviewSlice;  // ← Phase 1 addition
```
Без этого `useStore().fetchAgentChanges` не будет доступен в TypeScript.

### 8. Компоненты

#### `src/renderer/components/team/review/ChangeReviewDialog.tsx` (NEW)
- **Dialog shell**: Полноэкранный overlay (или большой dialog)
- Открывается из KanbanTaskCard или MemberDetailDialog
- Props: `open`, `onOpenChange`, `teamName`, `mode: 'agent' | 'task'`, `memberName?`, `taskId?`
- При открытии вызывает `fetchAgentChanges` или `fetchTaskChanges`
- Содержит resizable split panel:
  - Слева: `ReviewFileTree`
  - Справа: `ReviewDiffContent`

#### `src/renderer/components/team/review/ReviewFileTree.tsx` (NEW)
- Список файлов из `activeChangeSet.files`
- Каждый файл показывает: имя, +N -M badge, иконку статуса
- Клик выбирает файл → `selectReviewFile(filePath)`
- Группировка по директориям (tree view)
- Выделение активного файла

#### `src/renderer/components/team/review/ReviewDiffContent.tsx` (NEW)
- Показывает диффы для выбранного файла
- Phase 1: простой HTML-рендер (old_string красным, new_string зелёным)
- Использует `jsdiff.diffLines()` для вычисления unified diff из old_string/new_string
- Подсветка синтаксиса через существующий `highlight.js` (уже установлен)
- CSS переменные: `--diff-added-bg`, `--diff-removed-bg` и т.д. (уже есть в index.css)
- Если файл имеет несколько snippets — показываем все последовательно с разделителями

#### `src/renderer/components/team/review/ChangeStatsBadge.tsx` (NEW)
- Маленький inline badge: `+142 -38`
- Зелёный для добавленных, красный для удалённых
- Используется в KanbanTaskCard и MemberCard

### 9. Интеграция в существующие компоненты

#### `KanbanTaskCard.tsx` (MODIFY)
- Добавить `ChangeStatsBadge` рядом с subject (для задач в done/review/approved)
- Добавить кнопку "View Changes" (иконка `FileCode` или `GitCompare` из lucide)
- Клик открывает `ChangeReviewDialog` с `mode: 'task'`

#### `TeamDetailView.tsx` (MODIFY)
- Добавить рендер `ChangeReviewDialog` (один инстанс на уровне TeamDetailView)
- State: `reviewDialogState: { open: boolean; mode: 'agent' | 'task'; memberName?: string; taskId?: string }`
- Прокинуть callback `onViewChanges` в KanbanBoard → KanbanTaskCard

---

## Файлы

| Файл | Тип | ~LOC |
|------|-----|---:|
| `src/shared/types/review.ts` | NEW | 80 |
| `src/shared/types/index.ts` | MODIFY | +1 (re-export review types из barrel) |
| `src/shared/types/api.ts` | MODIFY | +15 (ReviewAPI interface + ElectronAPI field) |
| `src/main/services/team/ChangeExtractorService.ts` | NEW | 350 |
| `src/main/ipc/review.ts` | NEW | 100 (с wrapReviewHandler) |
| `src/main/ipc/handlers.ts` | MODIFY | +10 (import + init + register + remove) |
| `src/main/services/team/index.ts` | MODIFY | +1 |
| `src/main/index.ts` | MODIFY | +10 |
| `src/preload/constants/ipcChannels.ts` | MODIFY | +3 |
| `src/preload/index.ts` | MODIFY | +10 |
| `src/renderer/api/httpClient.ts` | MODIFY | +8 (review stubs) |
| `src/renderer/store/slices/changeReviewSlice.ts` | NEW | 100 |
| `src/renderer/store/index.ts` | MODIFY | +5 |
| `src/renderer/store/types.ts` | MODIFY | +2 (import + AppState intersection) |
| `src/renderer/components/team/review/ChangeReviewDialog.tsx` | NEW | 150 |
| `src/renderer/components/team/review/ReviewFileTree.tsx` | NEW | 180 |
| `src/renderer/components/team/review/ReviewDiffContent.tsx` | NEW | 250 (throwaway — заменяется в Phase 2 на CodeMirror) |
| `src/renderer/components/team/review/ChangeStatsBadge.tsx` | NEW | 40 |
| `src/renderer/components/team/kanban/KanbanTaskCard.tsx` | MODIFY | +30 |
| `src/renderer/components/team/TeamDetailView.tsx` | MODIFY | +40 |
| **Итого** | 8 NEW + 10 MODIFY | ~1,430 |

---

## Edge Cases

1. **Файл редактировался несколько раз** — показываем все snippets в хронологическом порядке
2. **Write (update) без old_string** — показываем только новое содержимое с пометкой "Full file content"
3. **MultiEdit** — каждая пара old_string/new_string отдельным snippet
4. **Ошибка парсинга JSONL** — graceful degradation, показываем то что смогли распарсить
5. **Пустой changeSet** — "No file changes detected" empty state
6. **Очень длинные файлы** — виртуальный скроллинг через `@tanstack/react-virtual` (уже установлен)
7. **Binary файлы** — пропускаем, не показываем дифф

## Тестирование

- Unit test для `ChangeExtractorService.parseFile()` с моковым JSONL
- Unit test для task scoping (TaskUpdate маркеры)
- Unit test для `ChangeStatsBadge` рендеринга
- Ручное тестирование на реальных team sessions из `~/.claude/projects/`
