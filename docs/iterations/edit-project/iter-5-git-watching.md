# Итерация 5: Git status, file watching, расширенные возможности

> Зависит от: [Итерация 4](iter-4-search-shortcuts.md)

## Цель

Git status в дереве файлов. Live refresh при изменениях на диске. Conflict detection при сохранении. Line wrap toggle.

## Новые npm-зависимости

- `simple-git` v3.32+ (`pnpm add simple-git`) — обёртка над git CLI с TypeScript типами, parsed StatusResult, встроенным timeout/abort. 7.9M downloads/нед, dual ESM/CJS, не native module
- `chokidar` v4.0.3 (`pnpm add chokidar@4`) — file watcher (117M downloads/нед). Решает все проблемы raw `fs.watch`: нормализация событий, recursive на Linux, ENOSPC handling, symlinks. Dual CJS/ESM, Node 14+

## IPC каналы

| Канал | Описание |
|-------|----------|
| `editor:gitStatus` | Git status через `simple-git` (v3.32+), кеш 5 сек |
| `editor:watchDir` | Запуск file watcher (opt-in, НЕ по умолчанию) |
| `editor:change` | Event: файл изменился на диске (main -> renderer) |

## Новые файлы

| # | Файл | Описание |
|---|------|----------|
| 1 | `src/main/services/editor/EditorFileWatcher.ts` | FileWatcher через `chokidar` v4 (~50-70 LOC). Burst coalescing, ENOSPC, recursive Linux — всё встроено. Фильтрация node_modules/.git/dist через `ignored` option |
| 2 | `src/main/services/editor/GitStatusService.ts` | Git status через `simple-git` с `StatusResult` маппингом, кеш 5 сек. Переиспользовать `isGitRepo()` из `GitDiffFallback.ts` (~80-100 LOC) |
| 3 | `src/main/services/editor/conflictDetection.ts` | Утилита mtime check: сравнение mtime до/после save, conflict resolution (~40 LOC) |
| 4 | `src/renderer/components/team/editor/GitStatusBadge.tsx` | M/U/A бейджи в дереве |

## Изменения в существующих файлах

| # | Файл | Изменение |
|---|------|-----------|
| 1 | `src/shared/types/editor.ts` | `GitFileStatus`, `EditorFileChangeEvent` |
| 2 | `src/shared/types/api.ts` | `gitStatus`, `onEditorChange` в EditorAPI |
| 3 | `src/main/ipc/editor.ts` | Handlers для git status и file watcher |
| 4 | `src/preload/index.ts` | `editor.gitStatus`, `editor.onEditorChange` (НЕ `onFileChange` — конфликт с существующим `ElectronAPI.onFileChange`) |
| 5 | `src/preload/constants/ipcChannels.ts` | `EDITOR_GIT_STATUS`, `EDITOR_WATCH_DIR`, `EDITOR_CHANGE` |
| 6 | `src/renderer/components/team/editor/EditorFileTree.tsx` | Git status badges |
| 7 | `src/renderer/components/team/editor/CodeMirrorEditor.tsx` | Conflict detection (mtime check) при сохранении |
| 8 | `src/renderer/components/team/editor/ProjectEditorOverlay.tsx` | File watcher подписка, auto-refresh, conflict modal |
| 9 | `src/renderer/store/slices/editorSlice.ts` | Git status data, file watcher state |
| 10 | `src/renderer/store/index.ts` | В `initializeNotificationListeners()` добавить подписку `if (api.editor?.onEditorChange)` → обновление дерева/табов при внешних изменениях (guard обязателен — паттерн из всех существующих subscriptions) |
| 11 | `src/main/index.ts` | `mainWindow.on('closed')` → `cleanupEditorState()`. `shutdownServices()` → `cleanupEditorState()` |

## Security-требования

1. `editor:gitStatus`: `cwd = activeProjectRoot` (валидный). Не передавать full paths от git без валидации
2. `editor:change`: пути в events могут утечь через symlink -- валидировать перед передачей в renderer (SEC-2)

## Watcher lifecycle cleanup (macOS: window closed but app alive)

- `editor:open` — если `activeProjectRoot !== null`, сначала остановить предыдущий watcher и сбросить state (идемпотентный reset). Guard: `if (activeProjectRoot !== null) throw new Error('Another editor is already open')`
- `mainWindow.on('closed')` в `src/main/index.ts` — вызвать `cleanupEditorState()` (экспорт из `editor.ts`): сброс `activeProjectRoot`, остановка watcher. Аналог существующего cleanup для `notificationManager`, `ptyTerminalService`
- `shutdownServices()` — добавить `cleanupEditorState()` рядом с `removeIpcHandlers()`

## Performance-требования (R4/R5)

- File watcher opt-in: по умолчанию ВЫКЛЮЧЕН. Toggle "Watch for external changes". По умолчанию ручной refresh (F5)

### chokidar конфигурация

```typescript
// src/main/services/editor/EditorFileWatcher.ts
import { watch, type FSWatcher } from 'chokidar';

let watcher: FSWatcher | null = null;

function startWatching(projectRoot: string, onChange: (event: EditorFileChangeEvent) => void) {
  watcher = watch(projectRoot, {
    ignored: /(node_modules|\.git|dist|__pycache__|\.cache|\.next|\.venv|\.tox|vendor)/,
    ignoreInitial: true,
    followSymlinks: false,
    depth: 20,
  });
  watcher.on('change', path => onChange({ type: 'change', path }));
  watcher.on('add', path => onChange({ type: 'create', path }));
  watcher.on('unlink', path => onChange({ type: 'delete', path }));
}

function stopWatching() {
  watcher?.close();
  watcher = null;
}
```

- **chokidar v4** решает все проблемы raw `fs.watch`: нормализация событий macOS, recursive на Linux, ENOSPC handling, debounce
- **macOS**: FSEvents через chokidar (надёжность 9/10)
- **Linux**: inotify через chokidar с автоматическим fallback (надёжность 8/10, было 6/10 с raw fs.watch)
- Git status кешировать на 5 секунд. Invalidate по file watcher event

### simple-git конфигурация

```typescript
// src/main/services/editor/GitStatusService.ts
import { simpleGit, StatusResult, SimpleGit } from 'simple-git';

// Создать инстанс с --no-optional-locks + timeout
const createGit = (projectRoot: string): SimpleGit =>
  simpleGit({
    baseDir: projectRoot,
    timeout: { block: 10_000 },  // 10s (паттерн из GitDiffFallback.ts)
  }).env('GIT_OPTIONAL_LOCKS', '0');  // эквивалент --no-optional-locks

// Маппинг StatusResult → GitFileStatus[]
function mapStatus(result: StatusResult): GitFileStatus[] {
  const files: GitFileStatus[] = [];
  for (const p of result.modified)   files.push({ path: p, status: 'modified' });
  for (const p of result.not_added)  files.push({ path: p, status: 'untracked' });
  for (const p of result.staged)     files.push({ path: p, status: 'staged' });
  for (const p of result.deleted)    files.push({ path: p, status: 'deleted' });
  for (const p of result.conflicted) files.push({ path: p, status: 'conflict' });
  for (const r of result.renamed)    files.push({ path: r.to, status: 'renamed', renamedFrom: r.from });
  return files;
}
```

- **`GIT_OPTIONAL_LOCKS=0`** — предотвращает `.git/index.lock` конфликты (критично для фоновых запросов!)
- **`timeout.block: 10_000`** — SIGINT после 10 сек без вывода
- **Парсинг не нужен** — `simple-git` делает полный парсинг porcelain вывода включая renamed, conflicts, ahead/behind
- Переиспользовать `isGitRepo()` из `GitDiffFallback.ts` для проверки наличия `.git`
- Graceful degradation:
  - Нет git → скрыть git бейджи, "Git not available" в status bar
  - Не git-repo → скрыть git бейджи
  - Timeout → "Git status unavailable" + кнопка retry

## UX-требования

- File changed on disk while open: banner в табе "File changed on disk. [Reload] [Keep mine] [Show diff]" (НЕ перезаписывать молча)
- File deleted on disk while open: banner "File no longer exists on disk. [Close tab]"
- Conflict detection при save: mtime check. Если изменился -- dialog "Overwrite / Cancel / Show diff"
- Line wrap toggle в toolbar

## Тестирование

| # | Что тестировать | Файл |
|---|----------------|------|
| 1 | `GitStatusService` -- маппинг `simple-git` StatusResult → GitFileStatus[], кеш, graceful degradation | `test/main/services/editor/GitStatusService.test.ts` |
| 2 | `EditorFileWatcher` -- chokidar watcher lifecycle (start/stop), event mapping, cleanup | `test/main/services/editor/EditorFileWatcher.test.ts` |
| 3 | `conflictDetection` -- mtime check логика | `test/main/services/editor/conflictDetection.test.ts` |
| 4 | Manual: изменить файл в внешнем редакторе -> conflict banner | — |

## Критерии готовности

- [ ] Git status бейджи (M/U/A/C) в файловом дереве (C = conflict для UU/AA/DD)
- [ ] Auto-refresh при изменениях на диске (при включённом watcher)
- [ ] Conflict detection при сохранении
- [ ] Line wrap toggle

## Оценка

- **Надёжность решения: 9/10** (было 8/10) -- `simple-git` + `chokidar` убирают ~300 LOC ручного кода: парсинг porcelain, fs.watch нормализация, ENOSPC fallback. Всё покрыто проверенными пакетами.
- **Уверенность: 9/10** -- simple-git 7.9M + chokidar 117M downloads/нед. Оба с TypeScript, проверены в production.
