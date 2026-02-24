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
  toolName: 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit';
  type: 'edit' | 'write-new' | 'write-update' | 'multi-edit';
  oldString: string;    // пустая строка для Write (create)
  newString: string;
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
  confidence: 'high' | 'medium' | 'low';
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
5. **Пропуск ошибок**: Следующий за tool_use блок `tool_result` с `is_error: true` → пропускаем этот tool_use
6. **Фильтрация proxy_ префикса**: Имена инструментов приходят как `proxy_Edit` — нужно strip prefix (паттерн из MemberStatsComputer)
7. **Подсчёт строк**: `linesAdded = newString.split('\n').length - oldString.split('\n').length` (для добавленных), аналогично для removed

**Task scoping (для `getTaskChanges`):**

1. Найти JSONL файлы агента через `logsFinder.findLogsForTask(teamName, taskId)`
2. Парсить файлы, ища маркеры `TaskUpdate` tool_use:
   - `input.taskId === taskId && input.status === 'in_progress'` → начало
   - `input.taskId === taskId && input.status === 'completed'` → конец
3. Альтернативно: Bash teamctl `task start|complete <id>` (regex)
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
import { IpcResult } from '@shared/types/api';
import { ChangeExtractorService } from '@main/services/team/ChangeExtractorService';
import { REVIEW_GET_AGENT_CHANGES, REVIEW_GET_TASK_CHANGES, REVIEW_GET_CHANGE_STATS } from '@preload/constants/ipcChannels';

let changeExtractor: ChangeExtractorService | null = null;

export function initializeReviewHandlers(service: ChangeExtractorService): void {
  changeExtractor = service;
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

// Handlers follow wrapTeamHandler pattern from teams.ts
```

### 5. Регистрация в main process

В `src/main/index.ts` (или где инициализируются IPC):
- Создать `ChangeExtractorService` с зависимостью `TeamMemberLogsFinder`
- Вызвать `initializeReviewHandlers(changeExtractor)`
- Вызвать `registerReviewHandlers(ipcMain)` после team handlers

### 6. Preload bridge: `src/preload/index.ts` (MODIFY)

Добавить в `electronAPI`:
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
| `src/main/services/team/ChangeExtractorService.ts` | NEW | 350 |
| `src/main/ipc/review.ts` | NEW | 80 |
| `src/main/services/team/index.ts` | MODIFY | +1 |
| `src/main/index.ts` | MODIFY | +10 |
| `src/preload/constants/ipcChannels.ts` | MODIFY | +3 |
| `src/preload/index.ts` | MODIFY | +10 |
| `src/renderer/store/slices/changeReviewSlice.ts` | NEW | 100 |
| `src/renderer/store/index.ts` | MODIFY | +5 |
| `src/renderer/components/team/review/ChangeReviewDialog.tsx` | NEW | 150 |
| `src/renderer/components/team/review/ReviewFileTree.tsx` | NEW | 180 |
| `src/renderer/components/team/review/ReviewDiffContent.tsx` | NEW | 250 |
| `src/renderer/components/team/review/ChangeStatsBadge.tsx` | NEW | 40 |
| `src/renderer/components/team/kanban/KanbanTaskCard.tsx` | MODIFY | +30 |
| `src/renderer/components/team/TeamDetailView.tsx` | MODIFY | +40 |
| **Итого** | 8 NEW + 7 MODIFY | ~1,330 |

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
