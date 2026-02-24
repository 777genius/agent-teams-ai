# Phase 4: Enhanced Features

## Цель
Качественные улучшения UX diff view: клавиатурная навигация между hunks, отслеживание "просмотренных" файлов, timeline изменений файла, git fallback для случаев когда JSONL данные неполные.

---

## Feature 1: Keyboard Navigation

### Цель
Навигация по hunks и файлам через клавиатуру (как в GitHub PR review). `j`/`k` или `↑`/`↓` для перехода между hunks, `n`/`p` для перехода между файлами.

### Реализация

#### Hook: `src/renderer/hooks/useDiffNavigation.ts` (NEW)

```typescript
interface DiffNavigationState {
  /** Текущий hunk index в выбранном файле */
  currentHunkIndex: number;
  /** Общее количество hunks в файле */
  totalHunks: number;
  /** Перейти к следующему hunk */
  goToNextHunk: () => void;
  /** Перейти к предыдущему hunk */
  goToPrevHunk: () => void;
  /** Перейти к следующему файлу */
  goToNextFile: () => void;
  /** Перейти к предыдущему файлу */
  goToPrevFile: () => void;
  /** Перейти к конкретному hunk */
  goToHunk: (index: number) => void;
  /** Accept текущий hunk */
  acceptCurrentHunk: () => void;
  /** Reject текущий hunk */
  rejectCurrentHunk: () => void;
}

export function useDiffNavigation(
  files: FileChangeSummary[],
  selectedFilePath: string | null,
  onSelectFile: (path: string) => void,
  onHunkAccepted?: (filePath: string, hunkIndex: number) => void,
  onHunkRejected?: (filePath: string, hunkIndex: number) => void,
): DiffNavigationState;
```

**Ключевые shortcuts:**

| Key | Action | Context |
|-----|--------|---------|
| `j` или `↓` | Next hunk | Diff view focused |
| `k` или `↑` | Previous hunk | Diff view focused |
| `n` | Next file | Any |
| `p` или `Shift+N` | Previous file | Any |
| `a` | Accept current hunk | Hunk focused |
| `x` | Reject current hunk | Hunk focused |
| `Shift+A` | Accept all hunks in file | File selected |
| `Shift+X` | Reject all hunks in file | File selected |
| `Enter` | Toggle hunk collapse | Hunk focused |
| `Escape` | Close diff dialog | Any |

**Реализация через existing pattern (useKeyboardShortcuts.ts):**

```typescript
useEffect(() => {
  if (!isDialogOpen) return;

  const handler = (event: KeyboardEvent) => {
    // Не перехватываем если фокус в input/textarea
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement
    ) return;

    switch (event.key) {
      case 'j':
      case 'ArrowDown':
        event.preventDefault();
        goToNextHunk();
        break;
      case 'k':
      case 'ArrowUp':
        event.preventDefault();
        goToPrevHunk();
        break;
      case 'n':
        event.preventDefault();
        goToNextFile();
        break;
      case 'p':
        event.preventDefault();
        goToPrevFile();
        break;
      case 'a':
        if (!event.shiftKey) {
          event.preventDefault();
          acceptCurrentHunk();
        } else {
          event.preventDefault();
          acceptAllFile();
        }
        break;
      case 'x':
        if (!event.shiftKey) {
          event.preventDefault();
          rejectCurrentHunk();
        } else {
          event.preventDefault();
          rejectAllFile();
        }
        break;
      case 'Escape':
        event.preventDefault();
        onClose();
        break;
    }
  };

  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}, [isDialogOpen, currentHunkIndex, selectedFilePath]);
```

**Scroll-to-hunk через CodeMirror API:**

```typescript
// @codemirror/merge предоставляет goToNextChunk / goToPreviousChunk
import { goToNextChunk, goToPreviousChunk } from '@codemirror/merge';

function scrollToHunk(editorView: EditorView, direction: 'next' | 'prev') {
  if (direction === 'next') {
    goToNextChunk(editorView);
  } else {
    goToPreviousChunk(editorView);
  }
}
```

#### Компонент: `src/renderer/components/team/review/KeyboardShortcutsHelp.tsx` (NEW)

Всплывающая подсказка с shortcut list (показывается по `?`).

```typescript
interface KeyboardShortcutsHelpProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
```

**~40 LOC**: Простая таблица с иконками клавиш и описаниями.

---

## Feature 2: "Viewed" File Tracking

### Цель
Пользователь может отметить файл как "просмотренный" (как в GitHub). Состояние сохраняется в localStorage.

### Реализация

#### Storage: `src/renderer/utils/diffViewedStorage.ts` (NEW)

**Паттерн**: Повторяет `teamMessageReadStorage.ts` — простой localStorage с JSON serialization.

```typescript
const STORAGE_PREFIX = 'diff-viewed';

/**
 * Ключ = `diff-viewed:{teamName}:{taskOrMemberKey}`.
 * Значение = JSON array of viewed file paths.
 */
function getStorageKey(teamName: string, scopeKey: string): string {
  return `${STORAGE_PREFIX}:${teamName}:${scopeKey}`;
}

/** Получить Set просмотренных файлов */
export function getViewedFiles(teamName: string, scopeKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(getStorageKey(teamName, scopeKey));
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

/** Отметить файл как просмотренный */
export function markFileViewed(teamName: string, scopeKey: string, filePath: string): void {
  const set = getViewedFiles(teamName, scopeKey);
  set.add(filePath);
  localStorage.setItem(getStorageKey(teamName, scopeKey), JSON.stringify([...set]));
}

/** Отметить файл как НЕ просмотренный */
export function unmarkFileViewed(teamName: string, scopeKey: string, filePath: string): void {
  const set = getViewedFiles(teamName, scopeKey);
  set.delete(filePath);
  localStorage.setItem(getStorageKey(teamName, scopeKey), JSON.stringify([...set]));
}

/** Отметить все файлы как просмотренные */
export function markAllViewed(teamName: string, scopeKey: string, filePaths: string[]): void {
  localStorage.setItem(getStorageKey(teamName, scopeKey), JSON.stringify(filePaths));
}

/** Сбросить все отметки */
export function clearViewed(teamName: string, scopeKey: string): void {
  localStorage.removeItem(getStorageKey(teamName, scopeKey));
}
```

#### Hook: `src/renderer/hooks/useViewedFiles.ts` (NEW)

```typescript
import { useState, useCallback, useMemo } from 'react';
import * as storage from '@renderer/utils/diffViewedStorage';

interface UseViewedFilesResult {
  viewedSet: Set<string>;
  isViewed: (filePath: string) => boolean;
  markViewed: (filePath: string) => void;
  unmarkViewed: (filePath: string) => void;
  markAllViewed: (filePaths: string[]) => void;
  clearAll: () => void;
  viewedCount: number;
  totalCount: number;
  /** Прогресс 0-100 */
  progress: number;
}

export function useViewedFiles(
  teamName: string,
  scopeKey: string,
  totalFiles: string[]
): UseViewedFilesResult {
  // version bump pattern (из useTeamMessagesRead)
  const [version, setVersion] = useState(0);

  const viewedSet = useMemo(() => {
    if (version < 0) return new Set<string>();
    return storage.getViewedFiles(teamName, scopeKey);
  }, [teamName, scopeKey, version]);

  const markViewed = useCallback((filePath: string) => {
    storage.markFileViewed(teamName, scopeKey, filePath);
    setVersion(v => v + 1);
  }, [teamName, scopeKey]);

  const unmarkViewed = useCallback((filePath: string) => {
    storage.unmarkFileViewed(teamName, scopeKey, filePath);
    setVersion(v => v + 1);
  }, [teamName, scopeKey]);

  const markAllViewed = useCallback((filePaths: string[]) => {
    storage.markAllViewed(teamName, scopeKey, filePaths);
    setVersion(v => v + 1);
  }, [teamName, scopeKey]);

  const clearAll = useCallback(() => {
    storage.clearViewed(teamName, scopeKey);
    setVersion(v => v + 1);
  }, [teamName, scopeKey]);

  const viewedCount = totalFiles.filter(f => viewedSet.has(f)).length;

  return {
    viewedSet,
    isViewed: (fp) => viewedSet.has(fp),
    markViewed,
    unmarkViewed,
    markAllViewed,
    clearAll,
    viewedCount,
    totalCount: totalFiles.length,
    progress: totalFiles.length > 0 ? Math.round((viewedCount / totalFiles.length) * 100) : 0,
  };
}
```

#### Компонент: `src/renderer/components/team/review/ViewedProgressBar.tsx` (NEW)

```typescript
interface ViewedProgressBarProps {
  viewed: number;
  total: number;
  progress: number;
}
```

Тонкий progress bar в header ChangeReviewDialog:
```
[████████░░░░░░░░░░] 5/12 files viewed (42%)
```

#### Интеграция в `ReviewFileTree.tsx` (MODIFY)

Checkbox рядом с каждым файлом:

```typescript
<div className="flex items-center gap-2">
  <input
    type="checkbox"
    checked={isViewed(file.filePath)}
    onChange={(e) => {
      if (e.target.checked) markViewed(file.filePath);
      else unmarkViewed(file.filePath);
    }}
    className="rounded border-border"
    aria-label={`Mark ${file.relativePath} as viewed`}
  />
  <span className={isViewed(file.filePath) ? 'text-text-muted line-through' : 'text-text'}>
    {file.relativePath}
  </span>
</div>
```

**Auto-mark**: Файл автоматически помечается viewed когда пользователь прокрутил весь diff до конца (через IntersectionObserver на последний hunk).

---

## Feature 3: File Edit Timeline

### Цель
Показать хронологию изменений файла в рамках задачи: какие Edit/Write операции произошли, в каком порядке, с какими tool_use.

### Реализация

#### Типы: `src/shared/types/review.ts` (MODIFY)

```typescript
/** Одно событие в timeline файла */
export interface FileEditEvent {
  /** tool_use.id */
  toolUseId: string;
  /** Тип операции */
  toolName: 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit';
  /** Timestamp из JSONL */
  timestamp: string;
  /** Краткое описание: "Edited 3 lines", "Created new file", etc */
  summary: string;
  /** +/- строк */
  linesAdded: number;
  linesRemoved: number;
  /** Индекс snippet в FileChangeSummary.snippets[] */
  snippetIndex: number;
}

/** Timeline для файла */
export interface FileEditTimeline {
  filePath: string;
  events: FileEditEvent[];
  /** Общая длительность (first event → last event) */
  durationMs: number;
}
```

#### Backend: `ChangeExtractorService.ts` (MODIFY — добавить timeline generation)

Timeline генерируется автоматически при `getAgentChanges()` / `getTaskChanges()`:

```typescript
// При сборе snippets — также записываем timeline events
private buildTimeline(snippets: SnippetDiff[]): FileEditEvent[] {
  return snippets.map((s, idx) => ({
    toolUseId: s.toolUseId,
    toolName: s.toolName,
    timestamp: s.timestamp,
    summary: this.generateEditSummary(s),
    linesAdded: Math.max(0, s.newString.split('\n').length - s.oldString.split('\n').length),
    linesRemoved: Math.max(0, s.oldString.split('\n').length - s.newString.split('\n').length),
    snippetIndex: idx,
  }));
}

private generateEditSummary(snippet: SnippetDiff): string {
  switch (snippet.type) {
    case 'write-new': return 'Created new file';
    case 'write-update': return 'Wrote full file content';
    case 'multi-edit': return `Multi-edit (${snippet.oldString.split('\n').length} lines)`;
    case 'edit': {
      const added = snippet.newString.split('\n').length;
      const removed = snippet.oldString.split('\n').length;
      if (removed === 0) return `Added ${added} line${added !== 1 ? 's' : ''}`;
      if (added === 0) return `Removed ${removed} line${removed !== 1 ? 's' : ''}`;
      return `Changed ${removed} → ${added} lines`;
    }
    default: return 'File modified';
  }
}
```

#### Компонент: `src/renderer/components/team/review/FileEditTimeline.tsx` (NEW)

**Паттерн**: Визуально похож на `ActivityItem.tsx` — вертикальная timeline с цветными точками.

```typescript
interface FileEditTimelineProps {
  timeline: FileEditTimeline;
  /** Клик по event → scroll к snippet в diff view */
  onEventClick?: (snippetIndex: number) => void;
  /** Текущий highlighted event */
  activeSnippetIndex?: number;
}
```

**Layout:**
```
  ● 10:23:45  Created new file                    [+42]
  │
  ● 10:24:12  Changed 5 → 8 lines                 [+3]
  │
  ● 10:25:01  Multi-edit (12 lines)               [+2 -3]
  │
  ● 10:26:33  Added 15 lines                      [+15]
```

**~120 LOC**: Timeline items с timestamp, summary, +/- badge, clickable.

#### Интеграция в `ChangeReviewDialog.tsx` (MODIFY)

Timeline показывается в sidebar под file tree (collapsible section):

```typescript
// Под ReviewFileTree
{selectedFile && (
  <div className="border-t border-border pt-3">
    <button
      onClick={() => setTimelineOpen(!timelineOpen)}
      className="flex items-center gap-1 text-xs text-text-secondary hover:text-text w-full"
    >
      <Clock className="w-3.5 h-3.5" />
      Edit Timeline ({selectedTimeline.events.length})
      <ChevronDown className={`w-3 h-3 transition-transform ${timelineOpen ? 'rotate-180' : ''}`} />
    </button>
    {timelineOpen && (
      <FileEditTimeline
        timeline={selectedTimeline}
        onEventClick={(idx) => scrollToSnippet(idx)}
        activeSnippetIndex={currentHunkIndex}
      />
    )}
  </div>
)}
```

---

## Feature 4: Git Fallback

### Цель
Когда JSONL данные неполные (Write без original, повреждённый файл) — использовать git для получения diff информации.

### Реализация

#### Backend: `src/main/services/team/GitDiffFallback.ts` (NEW)

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class GitDiffFallback {
  /**
   * Получить содержимое файла из конкретного коммита.
   * Используется когда file-history-snapshot недоступен.
   */
  async getFileAtCommit(
    projectPath: string,
    filePath: string,
    commitHash: string
  ): Promise<string | null> {
    try {
      const relativePath = filePath.replace(projectPath + '/', '');
      const { stdout } = await execFileAsync('git', [
        'show', `${commitHash}:${relativePath}`
      ], {
        cwd: projectPath,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      return stdout;
    } catch {
      return null; // File didn't exist at that commit
    }
  }

  /**
   * Найти коммит ближайший к timestamp.
   * Используется для определения "original" состояния файла.
   */
  async findCommitNearTimestamp(
    projectPath: string,
    filePath: string,
    timestamp: string
  ): Promise<string | null> {
    try {
      const relativePath = filePath.replace(projectPath + '/', '');
      const { stdout } = await execFileAsync('git', [
        'log', '--format=%H', '--before', timestamp,
        '-1', '--', relativePath
      ], { cwd: projectPath });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Получить git diff для файла между двумя точками.
   * Fallback когда JSONL snippet chain неполный.
   */
  async getGitDiff(
    projectPath: string,
    filePath: string,
    fromCommit: string,
    toCommit: string = 'HEAD'
  ): Promise<string | null> {
    try {
      const relativePath = filePath.replace(projectPath + '/', '');
      const { stdout } = await execFileAsync('git', [
        'diff', fromCommit, toCommit, '--', relativePath
      ], { cwd: projectPath });
      return stdout || null;
    } catch {
      return null;
    }
  }

  /**
   * Получить историю изменений файла (для timeline enrichment).
   */
  async getFileLog(
    projectPath: string,
    filePath: string,
    maxCount: number = 20
  ): Promise<Array<{ hash: string; timestamp: string; message: string }>> {
    try {
      const relativePath = filePath.replace(projectPath + '/', '');
      const { stdout } = await execFileAsync('git', [
        'log', `--max-count=${maxCount}`,
        '--format=%H|%aI|%s',
        '--', relativePath
      ], { cwd: projectPath });

      return stdout.trim().split('\n')
        .filter(line => line.includes('|'))
        .map(line => {
          const [hash, timestamp, ...msgParts] = line.split('|');
          return { hash, timestamp, message: msgParts.join('|') };
        });
    } catch {
      return [];
    }
  }

  /**
   * Проверить: является ли projectPath git repo.
   */
  async isGitRepo(projectPath: string): Promise<boolean> {
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: projectPath,
      });
      return true;
    } catch {
      return false;
    }
  }
}
```

**Интеграция с существующим `GitIdentityResolver`:**

```typescript
// GitIdentityResolver уже имеет getBranch() и worktree detection.
// GitDiffFallback добавляет file-level операции.
// Оба используют execFile('git', ...) — одинаковый паттерн.
```

#### Модификация: `FileContentResolver.ts` (MODIFY — Phase 2 + Phase 4)

Добавляем git fallback как третий уровень:

```typescript
async resolveFileContent(
  teamName: string,
  memberName: string,
  filePath: string
): Promise<...> {
  // Level 1: file-history-snapshot backup
  const backup = await this.tryFileHistoryBackup(filePath);
  if (backup) return { ...backup, source: 'file-history' };

  // Level 2: Snippet chain reconstruction
  const snippetResult = await this.trySnippetReconstruction(memberName, filePath);
  if (snippetResult) return { ...snippetResult, source: 'snippet-reconstruction' };

  // Level 3 (Phase 4): Git fallback
  const gitResult = await this.tryGitFallback(filePath);
  if (gitResult) return { ...gitResult, source: 'git-fallback' };

  // Level 4: Current disk (worst case)
  return this.readCurrentDisk(filePath);
}

private async tryGitFallback(filePath: string): Promise<...> {
  const projectPath = this.getProjectPath(filePath);
  if (!projectPath) return null;

  const isGit = await this.gitFallback.isGitRepo(projectPath);
  if (!isGit) return null;

  // Найти ближайший коммит к первому изменению
  const firstSnippetTimestamp = /* ... */;
  const commitHash = await this.gitFallback.findCommitNearTimestamp(
    projectPath, filePath, firstSnippetTimestamp
  );
  if (!commitHash) return null;

  const original = await this.gitFallback.getFileAtCommit(
    projectPath, filePath, commitHash
  );
  if (!original) return null;

  // Modified = текущий файл на диске
  const modified = await readFile(filePath, 'utf8');

  return { original, modified };
}
```

#### IPC: `src/preload/constants/ipcChannels.ts` (MODIFY)

```typescript
// Phase 4 additions
export const REVIEW_GET_GIT_FILE_LOG = 'review:getGitFileLog';
```

#### Preload: `src/preload/index.ts` (MODIFY)

```typescript
review: {
  // ... Phase 1-3 methods

  // Phase 4
  getGitFileLog: (projectPath: string, filePath: string) =>
    invokeIpcWithResult<Array<{ hash: string; timestamp: string; message: string }>>(
      REVIEW_GET_GIT_FILE_LOG, projectPath, filePath
    ),
},
```

---

## Feature 5: Auto-Viewed Detection

### Цель
Автоматически помечать файл как "viewed" когда пользователь прокрутил diff до конца.

### Реализация

```typescript
// В CodeMirrorDiffView.tsx
const endSentinelRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  if (!endSentinelRef.current) return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          // Файл просмотрен до конца
          onFullyViewed?.();
        }
      }
    },
    { threshold: 1.0 }
  );

  observer.observe(endSentinelRef.current);
  return () => observer.disconnect();
}, [onFullyViewed]);

// Sentinel element после CodeMirror editor
return (
  <div>
    <div ref={containerRef} /> {/* CodeMirror mount point */}
    <div ref={endSentinelRef} className="h-1" /> {/* Invisible sentinel */}
  </div>
);
```

**Настройка**: Авто-viewed можно отключить через toggle в ReviewToolbar.

---

## Файлы

| Файл | Тип | ~LOC |
|------|-----|---:|
| **Feature 1: Keyboard Navigation** | | |
| `src/renderer/hooks/useDiffNavigation.ts` | NEW | 120 |
| `src/renderer/components/team/review/KeyboardShortcutsHelp.tsx` | NEW | 40 |
| `src/renderer/components/team/review/CodeMirrorDiffView.tsx` | MODIFY | +30 |
| `src/renderer/components/team/review/ChangeReviewDialog.tsx` | MODIFY | +15 |
| **Feature 2: Viewed Tracking** | | |
| `src/renderer/utils/diffViewedStorage.ts` | NEW | 60 |
| `src/renderer/hooks/useViewedFiles.ts` | NEW | 80 |
| `src/renderer/components/team/review/ViewedProgressBar.tsx` | NEW | 35 |
| `src/renderer/components/team/review/ReviewFileTree.tsx` | MODIFY | +30 |
| `src/renderer/components/team/review/ChangeReviewDialog.tsx` | MODIFY | +20 |
| **Feature 3: Edit Timeline** | | |
| `src/shared/types/review.ts` | MODIFY | +30 |
| `src/main/services/team/ChangeExtractorService.ts` | MODIFY | +50 |
| `src/renderer/components/team/review/FileEditTimeline.tsx` | NEW | 120 |
| `src/renderer/components/team/review/ChangeReviewDialog.tsx` | MODIFY | +25 |
| **Feature 4: Git Fallback** | | |
| `src/main/services/team/GitDiffFallback.ts` | NEW | 180 |
| `src/main/services/team/FileContentResolver.ts` | MODIFY | +60 |
| `src/main/ipc/review.ts` | MODIFY | +20 |
| `src/preload/constants/ipcChannels.ts` | MODIFY | +1 |
| `src/preload/index.ts` | MODIFY | +5 |
| `src/main/services/team/index.ts` | MODIFY | +1 |
| **Feature 5: Auto-Viewed** | | |
| `src/renderer/components/team/review/CodeMirrorDiffView.tsx` | MODIFY | +25 |
| `src/renderer/components/team/review/ReviewToolbar.tsx` | MODIFY | +15 |
| **Итого** | 7 NEW + 14 MODIFY | ~960 |

---

## Edge Cases

### Keyboard Navigation
1. **Пустой файл (0 hunks)** — j/k no-op, показываем "No changes"
2. **Фокус в search input** — не перехватываем shortcuts
3. **Последний/первый hunk** — wrap-around или stop (настройка)
4. **Dialog закрыт** — все handlers disabled

### Viewed Tracking
5. **localStorage full** — graceful catch, показываем toast warning
6. **Scope key collision** — включаем version hash в key для уникальности
7. **Файлы изменились после viewed** — сбрасываем viewed при новом computedAt
8. **Bulk mark viewed** — batch update localStorage (не per-file)

### Edit Timeline
9. **Файл с 50+ edits** — виртуальный скроллинг не нужен (timeline compact), но добавляем "Show all" toggle при >20
10. **Timestamp parsing error** — показываем "Unknown time"
11. **Одинаковые timestamps** — сортировка по lineNumber (порядок в JSONL)

### Git Fallback
12. **Не git repo** — `isGitRepo()` возвращает false, skip git fallback
13. **Git binary not found** — catch ENOENT, log warning
14. **Shallow clone** — `git show` может не найти старый коммит, return null
15. **Uncommitted changes** — `getFileAtCommit('HEAD')` возвращает последний коммит, не рабочую копию
16. **File renamed** — git log --follow не используем (сложно), просто return null для старого пути
17. **Large files (>10MB)** — maxBuffer ограничивает, return null при error

### Auto-Viewed
18. **Scroll fast past** — IntersectionObserver с threshold 1.0 требует полного показа sentinel
19. **Dialog resize** — observer автоматически пере-вычисляет
20. **CodeMirror collapsed sections** — sentinel всегда после editor, collapsed не влияет

---

## Тестирование

### Keyboard Navigation
- Unit test для `useDiffNavigation` — корректный index management, boundary handling
- Test: shortcuts не перехватываются когда фокус в input
- Test: Escape закрывает dialog

### Viewed Tracking
- Unit test для `diffViewedStorage` — CRUD операции, edge cases
- Unit test для `useViewedFiles` — progress calculation, version bump
- Test: localStorage failure handling

### Edit Timeline
- Unit test для `buildTimeline()` — summary generation, sorting
- Unit test для `generateEditSummary()` — все типы операций

### Git Fallback
- Unit test для `GitDiffFallback` с mock execFile
- Test: isGitRepo false → skip
- Test: execFile error → return null
- Integration test: git fallback as last resort in FileContentResolver

### Auto-Viewed
- Test: IntersectionObserver callback triggers markViewed
- Test: disable toggle prevents auto-marking
