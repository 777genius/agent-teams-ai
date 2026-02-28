# Итерация 1: Walking Skeleton (read-only файловый браузер)

> Зависит от: [PR 0 (Рефакторинги)](iter-0-refactoring.md)

## Цель

Минимальный end-to-end вертикальный срез -- кнопка "Open in Editor" на TeamDetailView открывает полноэкранный overlay с деревом файлов слева и содержимым файла с подсветкой синтаксиса (read-only) справа.

## Новые npm-зависимости

- `@codemirror/search` (`pnpm add @codemirror/search`) — встроенный Cmd+F поиск в файле
- `isbinaryfile` v5.0.7 (`pnpm add isbinaryfile`) — binary detection (33M downloads/нед, zero deps, умнее null-byte scan: UTF-16, BOM, encoding hints)

## IPC каналы

| Канал | Описание |
|-------|----------|
| `editor:open` | Инициализировать editor, установить activeProjectRoot в module-level state |
| `editor:close` | Cleanup: сброс activeProjectRoot, остановка watcher |
| `editor:readDir` | Рекурсивное чтение директории (depth=1, lazy) |
| `editor:readFile` | Чтение содержимого файла с binary detection |

## Новые файлы

| # | Файл | Описание |
|---|------|----------|
| 1 | `src/shared/types/editor.ts` | `FileTreeEntry`, `ReadDirResult`, `ReadFileResult` |
| 2 | `src/main/services/editor/ProjectFileService.ts` | Stateless сервис: `readDir`, `readFile` с полной валидацией |
| 3 | `src/main/services/editor/index.ts` | Barrel export: `{ ProjectFileService }` (расширяется в итерациях 4-5) |
| 4 | `src/main/ipc/editor.ts` | IPC handlers с module-level `activeProjectRoot` |
| 5 | `src/main/ipc/ipcWrapper.ts` | Общий `createIpcWrapper()` (рефакторинг из review.ts) |
| 6 | `src/renderer/store/slices/editorSlice.ts` | Минимальный slice: Группа 1 (tree state + actions) |
| 7 | `src/renderer/utils/fileTreeBuilder.ts` | Generic `buildTree<T>()` (рефакторинг из ReviewFileTree) |
| 8 | `src/renderer/utils/codemirrorLanguages.ts` | `getSyncLanguageExtension()` (рефакторинг) |
| 9 | `src/renderer/utils/codemirrorTheme.ts` | `baseEditorTheme` (рефакторинг) |
| 10 | `src/renderer/components/common/FileTree.tsx` | Generic FileTree<T> с render-props |
| 11 | `src/renderer/components/team/editor/ProjectEditorOverlay.tsx` | Full-screen overlay |
| 12 | `src/renderer/components/team/editor/EditorFileTree.tsx` | Обёртка над generic FileTree |
| 13 | `src/renderer/components/team/editor/CodeMirrorEditor.tsx` | Read-only CM6 view (один EditorView, без pooling пока) |
| 14 | `src/renderer/components/team/editor/EditorEmptyState.tsx` | Нет открытых файлов |
| 15 | `src/renderer/components/team/editor/EditorBinaryState.tsx` | Заглушка для бинарных файлов |
| 16 | `src/renderer/components/team/editor/EditorErrorState.tsx` | Заглушка для ошибок чтения |
| 17 | `src/renderer/components/team/editor/EditorErrorBoundary.tsx` | React ErrorBoundary для CM6 (аналог DiffErrorBoundary) |

## Изменения в существующих файлах

| # | Файл | Изменение |
|---|------|-----------|
| 1 | `src/shared/types/api.ts` | `EditorAPI` interface + `editor: EditorAPI` в `ElectronAPI` |
| 2 | `src/shared/types/index.ts` | +`export type * from './editor'` (barrel re-export, паттерн как team/review/terminal) |
| 3 | `src/preload/constants/ipcChannels.ts` | `EDITOR_OPEN`, `EDITOR_CLOSE`, `EDITOR_READ_DIR`, `EDITOR_READ_FILE` |
| 4 | `src/preload/index.ts` | Секция `editor: { ... }` в `electronAPI` |
| 5 | `src/main/ipc/handlers.ts` | `initializeEditorHandlers` + `registerEditorHandlers` |
| 6 | `src/main/ipc/review.ts` | Заменить `wrapReviewHandler` на import из `ipcWrapper.ts` |
| 7 | `src/renderer/components/team/TeamDetailView.tsx` | Кнопка "Open in Editor" + state для overlay |
| 8 | `src/renderer/components/team/review/ReviewFileTree.tsx` | Рефакторинг: использовать generic FileTree + fileTreeBuilder |
| 9 | `src/renderer/components/team/review/CodeMirrorDiffView.tsx` | Рефакторинг: импорт из codemirrorLanguages/Theme |
| 10 | `src/main/utils/pathValidation.ts` | Добавить `validateFileName()`, `isDevicePath()`, `isGitInternalPath()`. Экспортировать `matchesSensitivePattern()` (приватная) для `isSensitive` в readDir. Экспортировать `isPathWithinRoot()` (приватная, строка ~30) — нужна для SEC-15 в `editor:open` handler уже в iter-1, а также для SEC-14 write-handler guard в iter-2 |
| 11 | `src/main/index.ts` | Добавить базовый cleanup в `mainWindow.on('closed')`: вызвать `cleanupEditorState()` (экспорт из editor.ts, сбрасывает `activeProjectRoot = null`). Без этого при Cmd+Q на macOS state "утечёт" и `editor:open` откажет при следующем открытии окна. Полный watcher cleanup — итерация 5, но базовый reset нужен с итерации 1 |
| 12 | `src/renderer/api/httpClient.ts` | Stub для `editor: EditorAPI` — throw "Editor is not available in browser mode" (паттерн как `review`, `terminal`, `teams`) |
| 13 | `src/renderer/store/types.ts` | `EditorSlice` в AppState |
| 14 | `src/renderer/store/index.ts` | `createEditorSlice` |

## Security-требования

1. **SEC-15**: `editor:open` handler валидирует `projectPath` ДО установки `activeProjectRoot`: `path.isAbsolute()`, `fs.stat().isDirectory()`, `!== '/'`/`'C:\\'`, `!isPathWithinRoot(path, claudeDir)`. Без этого злонамеренный renderer может передать `"/"`, делая ВСЕ пути валидными
2. `ProjectFileService.readDir()`: для каждого entry проверять containment через `isPathWithinAllowedDirectories()` (экспортирована из pathValidation.ts). Для symlinks -- `fs.realpath()` + повторная проверка containment. Молча пропускать entries за пределами projectRoot (SEC-2). **НЕ вызывать `validateFilePath()` целиком** — она блокирует sensitive файлы, а readDir должен их ПОКАЗЫВАТЬ с пометкой `isSensitive: true`. Для пометки использовать новую экспортируемую функцию `matchesSensitivePattern()` из pathValidation.ts (сейчас приватная — нужно экспортировать) (SEC-6)
3. `ProjectFileService.readFile()`: `fs.lstat()` -> `isFile()` ДО чтения. `stats.size <= 2MB`. Block device paths. Post-read realpath verify (SEC-3, SEC-4)
4. `activeProjectRoot` в module-level state, НЕ от renderer (SEC-5)
5. Sensitive файлы: показывать с замком в дереве, "Sensitive file, cannot open" при клике (SEC-6)

## Performance-требования

- MAX_ENTRIES_PER_DIR = 500; при превышении -- "N more files..."
- readFile тиерная стратегия: <256KB мгновенно, 256KB-2MB progress, 2MB-5MB preview, >5MB external
- Binary detection: `isbinaryfile` (v5.0.7) — `isBinaryFile(filePath)` вместо ручного null-byte scan
- Дедупликация IPC: `Map<string, Promise<ReadFileResult>>` для readFile

## UX-требования

- Focus management: при открытии -- фокус на первый файл. При закрытии -- вернуть фокус на кнопку. `inert` на фон
- ARIA: file tree сразу с `role="tree"`, `role="treeitem"`, `aria-expanded`, `role="group"`
- Пустой проект: "No files found" + кнопка Create (неактивна до итерации 3)
- Binary файлы: `EditorBinaryState.tsx` с кнопкой "Open in System Viewer"
- Max indent 12 уровней, tooltip на глубоких узлах

## State management

Создать минимальный `editorSlice` уже на итерации 1 с полями `editorProjectPath`, `editorFileTree`, `editorFileTreeLoading`, `editorFileTreeError`, `openEditor()`, `closeEditor()`, `loadFileTree()`, `expandDirectory()`. Это избавит от болезненной миграции useState → Zustand на итерации 2. Табы и dirty-состояние добавляются в slice на итерации 2.

## Тестирование

| # | Что тестировать | Файл |
|---|----------------|------|
| 1 | `ProjectFileService` -- чтение директории с mock fs, проверка security (reject paths outside projectRoot), исключение node_modules, symlink escape | `test/main/services/editor/ProjectFileService.test.ts` |
| 2 | `editorSlice` -- open/close editor, loadFileTree, expandDirectory | `test/renderer/store/editorSlice.test.ts` |
| 3 | `EditorFileTree` -- snapshot тесты рендеринга | — |
| 4 | `fileTreeBuilder.ts` -- unit тесты `buildTree()` (с generic типами для FileChangeSummary и FileTreeEntry) | `test/renderer/utils/fileTreeBuilder.test.ts` |
| 5 | `ipcWrapper.ts` -- unit тесты createIpcWrapper | `test/main/ipc/ipcWrapper.test.ts` |
| 6 | Manual: открыть TeamDetailView -> "Open in Editor" -> дерево загружается -> клик по файлу -> подсветка синтаксиса | — |

## Критерии готовности

- [ ] Кнопка видна на TeamDetailView рядом с путём проекта
- [ ] Overlay открывается по клику, закрывается по Escape или X
- [ ] Дерево файлов загружается для projectPath команды
- [ ] Клик по файлу показывает содержимое с синтаксической подсветкой
- [ ] Binary файлы показывают заглушку
- [ ] Попытка прочитать файл за пределами проекта -- отказ
- [ ] `pnpm typecheck` проходит
- [ ] Рефакторинги R1-R4 выполнены, тесты ReviewFileTree и CodeMirrorDiffView проходят

## Оценка

- **Надёжность решения: 8/10** -- CodeMirror 6 проверен в продакшене, все зависимости в проекте, паттерны повторяют ChangeReviewDialog.
- **Уверенность: 9/10** -- самый понятный этап, минимум неизвестных.
