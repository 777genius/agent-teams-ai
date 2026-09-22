# Риски, бенчмарки, полный список файлов

## Риски

| # | Риск | Вероятность | Импакт | Итерация | Митигация |
|---|------|------------|--------|----------|-----------|
| 1 | Path traversal через IPC | Средняя | Критический | 1+ | `validateFilePath()` на КАЖДОМ handler + module-level projectRoot |
| 2 | Symlink escape из projectRoot | Высокая | Критический | 1 | `fs.realpath()` + re-check на каждом entry в readDir |
| 3 | node_modules/огромные директории -- OOM | Высокая | Высокий | 1 | IGNORED_DIRS фильтр + MAX_DIR_ENTRIES=500 + виртуализация (итерация 4) |
| 4 | CM6 тормозит на файлах >2MB | Низкая | Средний | 1 | Hard limit 2MB + тиерная стратегия + external editor fallback |
| 5 | TOCTOU race condition при save | Высокая | Высокий | 2 | Atomic write (tmp + rename) + post-read verify |
| 6 | Race condition: агент и пользователь редактируют один файл | Высокая | Высокий | 5 | mtime check + conflict dialog (overwrite / cancel / diff) |
| 7 | Unsaved data loss при crash | Средняя | Средний | 2 | Draft autosave в localStorage (30 сек debounce, max 10 drafts x 500KB). Recovery banner при reopen |
| 8 | Device file DoS (/dev/zero) | Средняя | Высокий | 1 | `fs.lstat()` + `isFile()` + block /dev/ /proc/ /sys/ |
| 9 | Credential leakage (.env, .key) | Высокая | Высокий | 1 | `validateFilePath()` + визуальная пометка + блокировка чтения |
| 10 | ReDoS в searchInFiles | Средняя | Средний | 4 | Только literal search + timeout через AbortController |
| 11 | Memory leak: 20+ EditorView | Высокая | Критический | 2 | EditorState pooling + LRU eviction |
| 12 | Zustand keystroke storm | Высокая | Высокий | 2 | Content вне store + debounced dirty flag |
| 13 | XSS через имена файлов | Низкая | Средний | 1 | React JSX + validateFileName() при создании |
| 14 | Запись в .git/ | Средняя | Высокий | 2 | `isGitInternalPath()` блокирует write |
| 15 | ~~review.ts без валидации пути~~ | ~~Существует~~ | ~~Критический~~ | **ИСПРАВЛЕНО** | `validateFilePath()` добавлен в handleSaveEditedFile (hotfix применён) |

---

## Тест-стратегия

### Unit-тесты (Vitest)
~15 файлов, покрывают: сервисы (ProjectFileService, FileSearchService, GitStatusService), store slices, утилиты (fileTreeBuilder, tabLabelDisambiguation, codemirrorLanguages, atomicWrite), IPC wrapper. Запуск: `pnpm test`.

### Integration-тесты (Vitest + happy-dom)
Для компонентов использующих CM6 — happy-dom НЕ поддерживает `contenteditable` полностью. Стратегия:
- **CodeMirrorEditor**: тестировать через mock EditorView. Проверять lifecycle (mount → register bridge, unmount → unregister), tab switch (stateCache save/restore), dirty flag propagation
- **editorSlice + editorBridge**: интеграционный тест — store action вызывает bridge, bridge возвращает mock content
- **IPC handlers (editor.ts)**: тестировать с mock fs + mock ProjectFileService. Проверять security guards (path traversal, .git/ write block, device paths)

### Manual smoke-тесты (каждая итерация)
Обязательный чеклист перед мёрджем каждого PR:
- [ ] Открыть editor, навигировать по дереву, открыть файл — подсветка работает
- [ ] Редактировать файл, Cmd+S — сохранение без ошибок
- [ ] Unsaved changes при закрытии — confirmation dialog
- [ ] ChangeReviewDialog по-прежнему работает корректно (regression)
- [ ] Горячие клавиши НЕ конфликтуют с глобальными при закрытом editor

### Benchmarks (manual, один раз после iter-4)

Запускать вручную через DevTools Performance tab + React DevTools Profiler. Результаты фиксировать в PR description.

```
Benchmark 1: EditorView memory
  Открыть 25 файлов x 200KB
  Измерить: performance.memory.usedJSHeapSize
  Порог: < 150MB

Benchmark 2: Tab switch latency
  Переключить таб (500KB файл с syntax highlighting)
  Измерить: time from click to contentful paint
  Порог: < 50ms

Benchmark 3: File tree render
  5000+ файлов, все папки раскрыты (с виртуализацией)
  Измерить: FPS при скролле
  Порог: >= 55fps

Benchmark 4: readDir latency
  Директория с 5000 файлами
  Измерить: time from click to tree displayed
  Порог: < 200ms

Benchmark 5: Keystroke re-renders
  React DevTools Profiler при наборе текста
  Порог: FileTreePanel и TabBar рендерятся 0 раз при наборе
```

---

## Стратегия отката

Каждая итерация — отдельный PR. При проблемах — revert PR целиком.

| Итерация | Fallback при провале | Минимально жизнеспособный результат |
|----------|---------------------|-------------------------------------|
| PR 0 | Revert PR. Рефакторинги механические (извлечение функций), не трогают review logic. При проблеме — revert + дублировать код в editor | — |
| Iter 1 | Read-only browser без CM6 — просто дерево + `<pre>` с raw text | Кнопка "Open in Editor" → файловый браузер |
| Iter 2 | Оставить read-only из iter-1, открывать файлы в external editor (`shell:openPath`) | Read-only + external editor fallback |
| Iter 3 | Один таб (последний открытый файл). CRUD через terminal/external | Single-tab editor |
| Iter 4 | Без Quick Open, без search — ручная навигация по дереву. Без виртуализации (работает до ~2000 файлов) | Editor без search/shortcuts |
| Iter 5 | Без git badges, без file watcher — ручной F5 refresh. Без conflict detection — last-write-wins | Полный editor без live features |

**Критическая точка невозврата**: нет. Каждый PR изолирован. Даже если iter-5 провалится, iter-1-4 дают полноценный editor без git/watcher.

---

## Полный список файлов

### Новые файлы (~36)

| # | Файл | Итерация | Описание |
|---|------|----------|----------|
| 1 | `src/shared/types/editor.ts` | 1 | Все типы editor |
| 2 | `src/main/services/editor/ProjectFileService.ts` | 1 | Stateless файловый сервис |
| 3 | `src/main/services/editor/index.ts` | 1 | Barrel export: `{ ProjectFileService }` (расширяется в итерациях 4-5) |
| 4 | `src/main/services/editor/FileSearchService.ts` | 4 | Search in files |
| 5 | `src/main/services/editor/GitStatusService.ts` | 5 | git status через simple-git (~80-100 LOC) |
| 6 | `src/main/services/editor/EditorFileWatcher.ts` | 5 | FileWatcher через chokidar v4 (~50-70 LOC) |
| 7 | `src/main/services/editor/conflictDetection.ts` | 5 | Утилита mtime check: сравнение mtime до/после save, conflict resolution (~40 LOC) |
| 8 | `src/main/ipc/editor.ts` | 1 | IPC handlers |
| 9 | `src/main/ipc/ipcWrapper.ts` | 1 | Общий `createIpcWrapper()` |
| 10 | `src/main/utils/atomicWrite.ts` | 2 | Перемещение `atomicWriteAsync()` из `team/atomicWrite.ts` (randomUUID, fsync, EXDEV fallback) |
| 11 | `src/renderer/utils/fileTreeBuilder.ts` | 1 | buildTree (рефакторинг) |
| 12 | `src/renderer/utils/codemirrorLanguages.ts` | 1 | Языковой маппинг (рефакторинг) |
| 13 | `src/renderer/utils/codemirrorTheme.ts` | 1 | Базовая тема CM (рефакторинг) |
| 14 | `src/renderer/utils/tabLabelDisambiguation.ts` | 3 | Disambiguation дублей |
| 15 | `src/renderer/store/slices/editorSlice.ts` | 1 | Zustand slice (Группа 1: tree), расширяется в итерации 2-3 |
| 16 | `src/renderer/hooks/useEditorKeyboardShortcuts.ts` | 4 | Горячие клавиши |
| 17 | `src/renderer/components/common/FileTree.tsx` | 1 | Generic FileTree с render-props |
| 18 | `src/renderer/components/team/editor/ProjectEditorOverlay.tsx` | 1 | Full-screen overlay |
| 19 | `src/renderer/components/team/editor/EditorFileTree.tsx` | 1 | Обёртка над FileTree |
| 20 | `src/renderer/components/team/editor/CodeMirrorEditor.tsx` | 1 | CM6 wrapper (~250-350 LOC: pooling + LRU + bridge + dirty + autosave) |
| 21 | `src/renderer/components/team/editor/EditorTabBar.tsx` | 2 | Панель вкладок |
| 22 | `src/renderer/components/team/editor/EditorToolbar.tsx` | 2 | Toolbar |
| 23 | `src/renderer/components/team/editor/EditorStatusBar.tsx` | 2 | Status bar |
| 24 | `src/renderer/components/team/editor/EditorEmptyState.tsx` | 1 | Empty state |
| 25 | `src/renderer/components/team/editor/EditorBinaryState.tsx` | 1 | Binary файлы |
| 26 | `src/renderer/components/team/editor/EditorErrorState.tsx` | 1 | Ошибки чтения |
| 27 | `src/renderer/components/team/editor/EditorErrorBoundary.tsx` | 1 | React ErrorBoundary для CM6 (аналог DiffErrorBoundary) |
| 29 | `src/renderer/components/team/editor/EditorContextMenu.tsx` | 3 | Context menu |
| 30 | `src/renderer/components/team/editor/NewFileDialog.tsx` | 3 | Inline-input |
| 31 | `src/renderer/components/team/editor/QuickOpenDialog.tsx` | 4 | Cmd+P dialog |
| 32 | `src/renderer/components/team/editor/SearchInFilesPanel.tsx` | 4 | Cmd+Shift+F |
| 33 | `src/renderer/components/team/editor/EditorBreadcrumb.tsx` | 4 | Breadcrumb |
| 34 | `src/renderer/components/team/editor/EditorShortcutsHelp.tsx` | 4 | Shortcuts modal |
| 35 | `src/renderer/components/team/editor/fileIcons.ts` | 4 | Иконки файлов |
| 36 | `src/renderer/components/team/editor/GitStatusBadge.tsx` | 5 | M/U/A/C(conflict) бейджи |
| 37 | `src/renderer/utils/editorBridge.ts` | 2 | Module-level singleton: Store ↔ CM6 refs bridge (R3) |

### Модификации существующих файлов (~18)

| # | Файл | Итерация | Изменение |
|---|------|----------|-----------|
| 1 | `src/preload/constants/ipcChannels.ts` | 1-5 | +12 констант EDITOR_* (включая EDITOR_CLOSE) |
| 2 | `src/preload/index.ts` | 1-5 | Секция `editor: { ... }` |
| 3 | `src/shared/types/api.ts` | 1-5 | `EditorAPI` interface |
| 4 | `src/main/ipc/review.ts` | 1 | Замена wrapReviewHandler на import из ipcWrapper |
| 5 | `src/main/utils/pathValidation.ts` | 1 | +validateFileName, +isDevicePath, +isGitInternalPath |
| 6 | `src/renderer/store/types.ts` | 1 | +EditorSlice в AppState |
| 7 | `src/renderer/store/index.ts` | 1 | +createEditorSlice |
| 8 | `src/renderer/components/team/TeamDetailView.tsx` | 1 | Кнопка "Open in Editor" + overlay state |
| 9 | `src/renderer/components/team/review/ReviewFileTree.tsx` | 1 | Рефакторинг: generic FileTree + fileTreeBuilder |
| 10 | `src/renderer/components/team/review/CodeMirrorDiffView.tsx` | 1 | Рефакторинг: импорт из codemirrorLanguages/Theme |
| 11 | `src/main/ipc/handlers.ts` | 1 | +initializeEditorHandlers() + registerEditorHandlers(ipcMain) + removeEditorHandlers(ipcMain) |
| 12 | `src/renderer/api/httpClient.ts` | 1 | Stub для editor: EditorAPI (throw "not available in browser mode") |
| 13 | `src/main/ipc/teams.ts` | follow-up | Миграция wrapTeamHandler → createIpcWrapper (40+ замен, отдельный PR) |
| 14 | `src/shared/types/index.ts` | 1 | +`export type * from './editor'` (barrel re-export, паттерн как team/review/terminal) |
| 15 | `src/main/index.ts` | 1 (расш. 5) | `mainWindow.on('closed')` → `cleanupEditorState()` (базовый reset в iter-1, watcher cleanup в iter-5) |
| 16 | `src/renderer/index.css` | 2 | +editor CSS-переменные |
| 17 | `src/renderer/hooks/useKeyboardShortcuts.ts` | 4 | Guard `editorOpen` для 6 конфликтующих shortcuts (R1) |

### Тесты (новые, ~15)

| # | Файл | Итерация |
|---|------|----------|
| 1 | `test/main/services/editor/ProjectFileService.test.ts` | 1 |
| 2 | `test/main/ipc/editor.test.ts` | 1 |
| 3 | `test/main/ipc/ipcWrapper.test.ts` | 1 |
| 4 | `test/main/utils/atomicWrite.test.ts` | 2 |
| 5 | `test/renderer/utils/fileTreeBuilder.test.ts` | 1 |
| 6 | `test/renderer/utils/codemirrorLanguages.test.ts` | 1 |
| 7 | `test/renderer/store/editorSlice.test.ts` | 1 (расширяется в 2-3) |
| 8 | `test/renderer/utils/tabLabelDisambiguation.test.ts` | 3 |
| 9 | `test/renderer/components/team/editor/EditorContextMenu.test.ts` | 3 |
| 10 | `test/main/services/editor/FileSearchService.test.ts` | 4 |
| 11 | `test/renderer/hooks/useEditorKeyboardShortcuts.test.ts` | 4 |
| 12 | `test/renderer/components/team/editor/fileIcons.test.ts` | 4 |
| 13 | `test/main/services/editor/GitStatusService.test.ts` | 5 |
| 14 | `test/main/services/editor/EditorFileWatcher.test.ts` | 5 |
| 15 | `test/main/services/editor/conflictDetection.test.ts` | 5 |
