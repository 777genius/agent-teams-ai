# Итерация 5: Git status, file watching, расширенные возможности

> Зависит от: [Итерация 4](iter-4-search-shortcuts.md)

## Цель

Git status в дереве файлов. Live refresh при изменениях на диске. Conflict detection при сохранении. Line wrap toggle.

## IPC каналы

| Канал | Описание |
|-------|----------|
| `editor:gitStatus` | `git --no-optional-locks status --porcelain -z --untracked-files=normal --ignore-submodules`, кеш 5 сек |
| `editor:watchDir` | Запуск file watcher (opt-in, НЕ по умолчанию) |
| `editor:change` | Event: файл изменился на диске (main -> renderer) |

## Новые файлы

| # | Файл | Описание |
|---|------|----------|
| 1 | `src/main/services/editor/EditorFileWatcher.ts` | FileWatcher (~250-300 LOC, не ~60!). fs.watch + burst coalescing (200ms debounce + batch) + ENOSPC fallback to polling (Linux). Фильтрация node_modules/.git/dist |
| 2 | `src/main/services/editor/GitStatusService.ts` | `git --no-optional-locks status --porcelain -z` парсинг (NUL-separated), кеш 5 сек. Переиспользовать `isGitRepo()` из `GitDiffFallback.ts` (~200-250 LOC) |
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
- `fs.watch({ recursive: true })` + фильтрация (node_modules/.git/dist) + burst coalescing 200ms
- **macOS**: FSEvents reliable (надёжность 9/10)
- **Linux**: inotify (надёжность 6/10). При `ENOSPC` → fallback на polling (5-10 сек). НЕ падать, деградировать
- Git status кешировать на 5 секунд. Invalidate по file watcher event
- Git command: `git --no-optional-locks status --porcelain -z --untracked-files=normal --ignore-submodules`
  - `--no-optional-locks` — предотвращает `.git/index.lock` конфликты (критично!)
  - `-z` — NUL-separated вывод (безопасный парсинг путей с пробелами). **Важные особенности парсинга**:
    - Записи разделены NUL (`\0`), НЕ newline
    - Rename/copy (R/C коды): 2 пути через NUL — `R  old\0new\0` (3 записи в сплите, считывать парами)
    - Conflict коды: `UU` (both modified), `AA` (both added), `DD` (both deleted) → маппить на `status: 'conflict'`
    - Untracked: `?? path\0` → `status: 'untracked'`
    - Формат каждой записи: `XY path` где X=index status, Y=worktree status (2 символа + пробел + путь)
  - `--ignore-submodules` — ускорение на монорепо
- Timeout: 10 секунд (паттерн из GitDiffFallback.ts), AbortSignal
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
| 1 | `GitStatusService` -- парсинг `git status --porcelain` вывода | `test/main/services/editor/GitStatusService.test.ts` |
| 2 | `EditorFileWatcher` -- debounce, event types | `test/main/services/editor/EditorFileWatcher.test.ts` |
| 3 | `conflictDetection` -- mtime check логика | `test/main/services/editor/conflictDetection.test.ts` |
| 4 | Manual: изменить файл в внешнем редакторе -> conflict banner | — |

## Критерии готовности

- [ ] Git status бейджи (M/U/A/C) в файловом дереве (C = conflict для UU/AA/DD)
- [ ] Auto-refresh при изменениях на диске (при включённом watcher)
- [ ] Conflict detection при сохранении
- [ ] Line wrap toggle

## Оценка

- **Надёжность решения: 7/10** (было 6/10) -- R4/R5 ресёрч закрыл ключевые пробелы: `--no-optional-locks`, ENOSPC fallback, burst coalescing. Race conditions остаются, но митигированы.
- **Уверенность: 8/10** (было 7/10) -- паттерны FileWatcher + GitDiffFallback изучены, переиспользование кода подтверждено.
