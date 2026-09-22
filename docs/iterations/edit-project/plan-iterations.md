# Plan: In-App Project Editor -- Iteration Plan

## Контекст и предпосылки

На странице деталей команды (`TeamDetailView.tsx`) рядом с путём проекта (строки 761-769 в `TeamDetailView.tsx`, используется `FolderOpen` иконка и `formatProjectPath()`) добавляется кнопка "Open in Editor", которая открывает полноэкранный оверлей с файловым деревом, CodeMirror-редактором, вкладками и файловыми операциями.

### Существующие паттерны, на которые опираемся

1. **Fullscreen overlay**: `ChangeReviewDialog.tsx` -- полноэкранный `fixed inset-0 z-50` компонент с хедером, левой панелью (ReviewFileTree) и правой панелью (ContinuousScrollView). Это точный архитектурный прототип.

2. **File tree**: `ReviewFileTree.tsx` -- дерево файлов с `buildTree()`, collapse/expand, активный элемент. Будет адаптирован для файлового браузера (не review).

3. **CodeMirror**: уже установлен в проекте (`@codemirror/*` ~20 пакетов), используется в `CodeMirrorDiffView.tsx`. Функция `getSyncLanguageExtension()` уже мапит расширения на языковые пакеты. Тема `diffTheme` использует CSS-переменные проекта.

4. **IPC-паттерн**: module-level state + `initialize/register/remove` тройка + `wrapHandler<T>()` для IpcResult. Ближайший пример: `review.ts`.

5. **Preload bridge**: `invokeIpcWithResult<T>()` для IpcResult, прямой `ipcRenderer.invoke()` для остальных. Группировка методов через sub-объект (как `review: ReviewAPI`).

6. **Path security**: `validateFilePath()` из `pathValidation.ts` -- проверяет путь на sensitive patterns и sandbox.

7. **Store**: Zustand slices с паттерном `data/selectedId/loading/error`.

---

## Итерация 1: Walking Skeleton (файловое дерево + read-only просмотр)

### Цель
Минимальный end-to-end вертикальный срез: кнопка "Open in Editor" на TeamDetailView открывает полноэкранный оверлей, где слева -- дерево файлов проекта, справа -- содержимое выбранного файла (read-only, с подсветкой синтаксиса через CodeMirror).

### Зависимости (npm)
Никаких новых -- все CodeMirror-пакеты и lucide-react иконки уже установлены.

### IPC каналы (новые)

| Канал | Направление | Описание |
|-------|-------------|----------|
| `editor:readDir` | renderer -> main | Рекурсивное чтение директории (возвращает дерево) |
| `editor:readFile` | renderer -> main | Чтение содержимого файла по абсолютному пути |

### Новые файлы

| Файл | Описание |
|------|----------|
| `src/shared/types/editor.ts` | Типы: `EditorTreeNode`, `EditorFileContent`, запросы/ответы |
| `src/main/services/editor/ProjectFileService.ts` | Сервис: чтение директорий (рекурсивно с лимитами) и файлов. Использует `validateFilePath()` для security |
| `src/main/ipc/editor.ts` | IPC handlers: `editor:readDir`, `editor:readFile`. Паттерн: module-level state + `wrapEditorHandler()` |
| `src/preload/constants/ipcChannels.ts` | Добавить `EDITOR_READ_DIR`, `EDITOR_READ_FILE` |
| `src/renderer/components/team/editor/ProjectEditorOverlay.tsx` | Главный fullscreen overlay (по образцу `ChangeReviewDialog.tsx`) |
| `src/renderer/components/team/editor/EditorFileTree.tsx` | Компонент дерева файлов (адаптация `ReviewFileTree.tsx` для filesystem -- без review-статусов) |
| `src/renderer/components/team/editor/EditorCodeView.tsx` | Read-only CodeMirror view (адаптация `CodeMirrorDiffView.tsx` без merge mode) |

### Изменения в существующих файлах

| Файл | Изменение |
|------|-----------|
| `src/shared/types/api.ts` | Добавить `EditorAPI` интерфейс + `editor: EditorAPI` в `ElectronAPI` |
| `src/preload/index.ts` | Добавить `editor:` группу в `electronAPI` объект |
| `src/main/ipc/handlers.ts` | Добавить `initialize/register/removeEditorHandlers` |
| `src/renderer/components/team/TeamDetailView.tsx` | Кнопка "Open in Editor" рядом с projectPath (строка ~770), state для open/close оверлея |

### Важные решения

- **Security**: `ProjectFileService` ОБЯЗАН использовать `validateFilePath(filePath, projectRoot)` для каждого запроса. Путь должен быть внутри projectRoot (sandbox). Нельзя читать файлы вне проекта.
- **Лимиты**: readDir рекурсия ограничена глубиной (max 10 уровней) и количеством файлов (max 5000 nodes). Исключаются `node_modules`, `.git`, `dist`, `build`, `__pycache__`, `.next`.
- **Read-only**: на этой итерации CodeMirror создаётся с `EditorState.readOnly.of(true)`.
- **Lazy loading дерева**: первый вызов readDir возвращает только верхний уровень. При раскрытии папки -- повторный вызов для поддиректории (ленивая загрузка). Или: полное дерево сразу, но с лимитом глубины и ignored patterns.

### Тестирование

- **Unit**: `ProjectFileService` -- чтение директории с mock fs, проверка security (reject paths outside projectRoot), проверка исключения node_modules.
- **Unit**: `EditorFileTree` -- snapshot тесты рендеринга дерева.
- **Manual**: открыть TeamDetailView, нажать "Open in Editor", убедиться что дерево загружается, клик по файлу показывает содержимое с подсветкой.

### Критерии готовности

- Кнопка видна на TeamDetailView рядом с путём проекта
- Оверлей открывается по клику, закрывается по Escape или X
- Дерево файлов загружается для projectPath команды
- Клик по файлу показывает содержимое с синтаксической подсветкой
- Попытка прочитать файл за пределами проекта -- отказ
- `pnpm typecheck` проходит

### Надёжность решения: 8/10
### Уверенность: 9/10

---

## Итерация 2: Editable CodeMirror + сохранение файлов

### Цель
Переключить CodeMirror из read-only в редактируемый режим. Добавить Cmd+S для сохранения. Показывать индикатор unsaved changes.

### IPC каналы (новые)

| Канал | Направление | Описание |
|-------|-------------|----------|
| `editor:writeFile` | renderer -> main | Запись содержимого файла на диск |

### Новые файлы

| Файл | Описание |
|------|----------|
| `src/renderer/components/team/editor/EditorTabBar.tsx` | Панель вкладок (один файл пока, но подготовка к multi-tab) |
| `src/renderer/components/team/editor/useEditorState.ts` | Хук для управления состоянием открытых файлов, dirty flags, save |
| `src/renderer/store/slices/editorSlice.ts` | Zustand slice: openFiles, activeFilePath, dirtyFiles, loading/error |

### Изменения в существующих файлах

| Файл | Изменение |
|------|-----------|
| `src/shared/types/editor.ts` | Добавить типы для write request/response |
| `src/shared/types/api.ts` | Добавить `writeFile` в `EditorAPI` |
| `src/main/services/editor/ProjectFileService.ts` | Метод `writeFile(projectRoot, filePath, content)` с validation |
| `src/main/ipc/editor.ts` | Handler `editor:writeFile` |
| `src/preload/index.ts` | Добавить `editor.writeFile` |
| `src/preload/constants/ipcChannels.ts` | `EDITOR_WRITE_FILE` |
| `src/renderer/components/team/editor/ProjectEditorOverlay.tsx` | Интеграция EditorTabBar, переключение read-only -> editable |
| `src/renderer/components/team/editor/EditorCodeView.tsx` | Убрать readOnly, добавить onChange callback, Cmd+S keymap |
| `src/renderer/store/index.ts` | Подключить editorSlice |
| `src/renderer/store/types.ts` | Расширить AppState типом editorSlice |

### Важные решения

- **Cmd+S**: перехватывается через CodeMirror keymap extension (не глобальный listener), чтобы не конфликтовать с другими горячими клавишами.
- **Dirty flag**: отслеживается через сравнение текущего содержимого с оригинальным (при загрузке). Точка в названии вкладки для dirty файлов.
- **Confirm on close**: если есть unsaved changes -- `confirm()` через существующий `ConfirmDialog`.
- **Backup**: перед записью -- никакого backup на этой итерации (файл просто перезаписывается). В будущем можно добавить.
- **Concurrency**: если файл изменился на диске пока был открыт -- пока не обрабатываем (это итерация 4-5).

### Тестирование

- **Unit**: `ProjectFileService.writeFile` -- запись с mock fs, reject для файлов вне проекта.
- **Unit**: `editorSlice` -- открытие/закрытие файлов, dirty state, сохранение.
- **Unit**: `useEditorState` -- хук тестирование с Zustand store.
- **Manual**: открыть файл, отредактировать, Cmd+S, убедиться что файл записался, dirty индикатор сбрасывается.

### Критерии готовности

- Файл редактируется в CodeMirror (не read-only)
- Cmd+S сохраняет файл
- Dirty indicator (точка) на вкладке
- При закрытии с unsaved changes -- confirmation dialog
- Сохранение отказывает для файлов вне projectRoot

### Надёжность решения: 7/10
### Уверенность: 8/10

---

## Итерация 3: Multi-tab + создание/удаление файлов

### Цель
Поддержка нескольких открытых файлов во вкладках. Контекстное меню на файловом дереве: создать файл, создать папку, удалить файл. Переименование -- вне scope.

### IPC каналы (новые)

| Канал | Направление | Описание |
|-------|-------------|----------|
| `editor:createFile` | renderer -> main | Создать файл (с опциональным начальным содержимым) |
| `editor:createDir` | renderer -> main | Создать директорию |
| `editor:deleteFile` | renderer -> main | Удалить файл (в Trash через Electron shell.trashItem) |

### Новые файлы

| Файл | Описание |
|------|----------|
| `src/renderer/components/team/editor/EditorContextMenu.tsx` | Context menu для дерева файлов (New File, New Folder, Delete, Reveal in Finder) |
| `src/renderer/components/team/editor/NewFileDialog.tsx` | Маленький inline-input для ввода имени нового файла/папки |

### Изменения в существующих файлах

| Файл | Изменение |
|------|-----------|
| `src/shared/types/editor.ts` | Типы для create/delete запросов |
| `src/shared/types/api.ts` | Расширить `EditorAPI` методами `createFile`, `createDir`, `deleteFile` |
| `src/main/services/editor/ProjectFileService.ts` | Методы `createFile`, `createDir`, `deleteFile`. deleteFile использует `shell.trashItem()` (безопасное удаление) |
| `src/main/ipc/editor.ts` | 3 новых handler |
| `src/preload/index.ts` | 3 новых метода в editor |
| `src/preload/constants/ipcChannels.ts` | `EDITOR_CREATE_FILE`, `EDITOR_CREATE_DIR`, `EDITOR_DELETE_FILE` |
| `src/renderer/components/team/editor/EditorTabBar.tsx` | Multi-tab: массив вкладок, переключение, close (X), close other tabs, middle-click close |
| `src/renderer/components/team/editor/EditorFileTree.tsx` | Right-click context menu, refresh после create/delete |
| `src/renderer/components/team/editor/ProjectEditorOverlay.tsx` | Управление массивом открытых файлов, переключение активной вкладки |
| `src/renderer/store/slices/editorSlice.ts` | Массив openTabs, activeTabId, actions: openFile, closeFile, switchTab, reorderTabs |

### Важные решения

- **Удаление через Trash**: используем `shell.trashItem()` (Electron API) вместо `fs.unlink()`. Это безопасно -- пользователь может восстановить файл из корзины.
- **Confirm on delete**: обязательный ConfirmDialog перед удалением.
- **Tab ordering**: drag-and-drop для вкладок через `@dnd-kit` (уже установлен в проекте).
- **Имя нового файла**: валидация -- запрет на `.`, `..`, `/` в начале, запрет на спецсимволы.
- **Refresh дерева**: после create/delete автоматически перечитываем поддерево. Не нужен FileWatcher -- явный refresh.

### Тестирование

- **Unit**: `ProjectFileService.createFile/deleteFile` с mock fs.
- **Unit**: `editorSlice` -- multi-tab actions (open, close, reorder).
- **Unit**: `EditorContextMenu` -- рендеринг, клики.
- **Manual**: открыть несколько файлов, переключаться между вкладками, создать файл, удалить файл.

### Критерии готовности

- Можно открыть несколько файлов одновременно
- Вкладки переключаются, закрываются
- Правый клик по дереву -- New File, New Folder, Delete
- Создание файла добавляет его в дерево
- Удаление -- через Trash с confirmation

### Надёжность решения: 7/10
### Уверенность: 8/10

---

## Итерация 4: Горячие клавиши, поиск, UX polish

### Цель
Клавиатурная навигация (Cmd+P quick open, Cmd+W close tab, Cmd+Shift+[ / ] switch tabs). Поиск по содержимому файлов через Cmd+Shift+F. Breadcrumb навигация. Иконки файлов по типу.

### IPC каналы (новые)

| Канал | Направление | Описание |
|-------|-------------|----------|
| `editor:searchInFiles` | renderer -> main | Поиск по содержимому файлов (grep-like) |

### Новые файлы

| Файл | Описание |
|------|----------|
| `src/renderer/components/team/editor/QuickOpenDialog.tsx` | Cmd+P dialog: fuzzy search по именам файлов (по образцу `cmdk` -- уже установлен) |
| `src/renderer/components/team/editor/SearchInFilesPanel.tsx` | Панель результатов поиска (заменяет или дополняет file tree) |
| `src/renderer/components/team/editor/EditorBreadcrumb.tsx` | Breadcrumb навигация по пути текущего файла |
| `src/renderer/components/team/editor/fileIcons.ts` | Маппинг расширений на lucide-react иконки и цвета |
| `src/renderer/hooks/useEditorKeyboardShortcuts.ts` | Хук для всех горячих клавиш редактора |
| `src/main/services/editor/FileSearchService.ts` | Сервис: search in files с лимитами (grep-like, max 100 results) |

### Изменения в существующих файлах

| Файл | Изменение |
|------|-----------|
| `src/shared/types/editor.ts` | Типы для search request/response |
| `src/shared/types/api.ts` | `searchInFiles` в EditorAPI |
| `src/main/ipc/editor.ts` | Handler `editor:searchInFiles` |
| `src/preload/index.ts` | `editor.searchInFiles` |
| `src/preload/constants/ipcChannels.ts` | `EDITOR_SEARCH_IN_FILES` |
| `src/renderer/components/team/editor/ProjectEditorOverlay.tsx` | Интеграция QuickOpen, SearchInFiles, Breadcrumb, keyboard shortcuts |
| `src/renderer/components/team/editor/EditorFileTree.tsx` | Иконки файлов по типу |
| `src/renderer/components/team/editor/EditorTabBar.tsx` | Иконки файлов на вкладках |

### Важные решения

- **Quick Open**: использовать `cmdk` (уже в зависимостях, v1.0.4) для fuzzy search по именам файлов. Список файлов загружается при открытии оверлея.
- **Search in Files**: серверная сторона делает простой grep по файлам с Node.js (readline + regex). Не используем external tools типа ripgrep -- держим zero-dependency. Лимит: 100 результатов, max 10MB на файл.
- **Горячие клавиши**: Cmd+P (quick open), Cmd+W (close tab), Cmd+S (save), Cmd+Shift+F (search), Cmd+Shift+[ / ] (switch tabs), Cmd+\ (toggle file tree).
- **Breadcrumb**: кликабельный -- каждый сегмент пути открывает эту папку в дереве.

### Тестирование

- **Unit**: `FileSearchService` -- поиск по mock файлам, лимиты.
- **Unit**: `useEditorKeyboardShortcuts` -- обработка горячих клавиш.
- **Unit**: `fileIcons.ts` -- маппинг расширений.
- **Manual**: Cmd+P, Cmd+Shift+F, навигация клавиатурой.

### Критерии готовности

- Cmd+P открывает quick open с fuzzy search
- Cmd+Shift+F показывает результаты поиска по содержимому
- Все основные горячие клавиши работают
- Breadcrumb-навигация для текущего файла
- Иконки файлов по типу в дереве и вкладках

### Надёжность решения: 7/10
### Уверенность: 7/10

---

## Итерация 5: Git status, file watching, расширенные возможности

### Цель
Показывать git status (modified/untracked/staged) в дереве файлов. Live refresh при изменениях на диске. Conflict detection при сохранении. Minimap. Line numbers toggle.

### IPC каналы (новые)

| Канал | Направление | Описание |
|-------|-------------|----------|
| `editor:gitStatus` | renderer -> main | Получить git status для директории (modified, staged, untracked) |
| `editor:watchDir` | renderer -> main | Запустить file watcher для проекта (возвращает cleanup) |
| `editor:change` | main -> renderer | Event: файл изменился на диске |

### Новые файлы

| Файл | Описание |
|------|----------|
| `src/main/services/editor/EditorFileWatcher.ts` | FileWatcher адаптация (~60 LOC) для отслеживания изменений в projectRoot |
| `src/main/services/editor/GitStatusService.ts` | Сервис: вызывает git status --porcelain и парсит вывод |
| `src/renderer/components/team/editor/GitStatusBadge.tsx` | Бейджи M/U/A рядом с файлами в дереве |

### Изменения в существующих файлах

| Файл | Изменение |
|------|-----------|
| `src/shared/types/editor.ts` | `GitFileStatus`, `EditorFileChangeEvent` |
| `src/shared/types/api.ts` | `gitStatus`, `onEditorFileChange` в EditorAPI |
| `src/main/ipc/editor.ts` | Handlers для git status и file watcher events |
| `src/preload/index.ts` | `editor.gitStatus`, `editor.onFileChange` |
| `src/preload/constants/ipcChannels.ts` | `EDITOR_GIT_STATUS`, `EDITOR_WATCH_DIR`, `EDITOR_CHANGE` |
| `src/renderer/components/team/editor/EditorFileTree.tsx` | Git status badges (M = modified, U = untracked, A = staged) |
| `src/renderer/components/team/editor/EditorCodeView.tsx` | Line wrapping toggle, conflict detection при сохранении |
| `src/renderer/components/team/editor/ProjectEditorOverlay.tsx` | File watcher подписка, auto-refresh дерева, conflict modal при concurrent edit |
| `src/renderer/store/slices/editorSlice.ts` | Git status data, file watcher state |

### Важные решения

- **Git status**: вызываем child_process с git status --porcelain -u в projectRoot. Парсим вывод. Кешируем на 5 секунд. Не используем libgit2 -- слишком тяжёлый.
- **File watcher**: используем существующий chokidar-подобный паттерн (как `FileWatcher` в проекте). Debounce 200ms. При получении события -- refresh дерева и уведомление если открытый файл изменился.
- **Conflict detection**: при сохранении -- проверить mtime файла. Если изменился после последнего чтения -- показать conflict dialog (перезаписать / отменить / diff).
- **Minimap**: CodeMirror не имеет встроенного minimap. Можно использовать @replit/codemirror-minimap или пропустить. Решение: пропустить minimap (слишком специфичная dependency), вместо этого добавить line wrap toggle и go-to-line (Cmd+G).

### Тестирование

- **Unit**: `GitStatusService` -- парсинг git status --porcelain вывода.
- **Unit**: `EditorFileWatcher` -- debounce, event types.
- **Unit**: conflict detection логика.
- **Manual**: изменить файл в внешнем редакторе, убедиться что отображается conflict.

### Критерии готовности

- Git status бейджи в файловом дереве
- Auto-refresh при изменениях на диске
- Conflict detection при сохранении файла, изменённого извне
- Go-to-line (Cmd+G)
- Line wrap toggle

### Надёжность решения: 6/10
### Уверенность: 7/10

---

## Сводная таблица файлов по итерациям

### Итерация 1 (7 новых, 4 изменения)
**Новые:** `shared/types/editor.ts`, `main/services/editor/ProjectFileService.ts`, `main/ipc/editor.ts`, `renderer/components/team/editor/ProjectEditorOverlay.tsx`, `renderer/components/team/editor/EditorFileTree.tsx`, `renderer/components/team/editor/EditorCodeView.tsx`
**Изменения:** `shared/types/api.ts`, `preload/index.ts`, `preload/constants/ipcChannels.ts`, `main/ipc/handlers.ts`, `renderer/components/team/TeamDetailView.tsx`

### Итерация 2 (3 новых, ~8 изменений)
**Новые:** `renderer/components/team/editor/EditorTabBar.tsx`, `renderer/hooks/useEditorState.ts`, `renderer/store/slices/editorSlice.ts`
**Изменения:** `shared/types/editor.ts`, `shared/types/api.ts`, `main/services/editor/ProjectFileService.ts`, `main/ipc/editor.ts`, `preload/index.ts`, `preload/constants/ipcChannels.ts`, `renderer/components/team/editor/*`, `renderer/store/index.ts`, `renderer/store/types.ts`

### Итерация 3 (2 новых, ~8 изменений)
**Новые:** `renderer/components/team/editor/EditorContextMenu.tsx`, `renderer/components/team/editor/NewFileDialog.tsx`
**Изменения:** многие файлы из итерации 2

### Итерация 4 (6 новых, ~8 изменений)
**Новые:** `QuickOpenDialog.tsx`, `SearchInFilesPanel.tsx`, `EditorBreadcrumb.tsx`, `fileIcons.ts`, `useEditorKeyboardShortcuts.ts`, `main/services/editor/FileSearchService.ts`

### Итерация 5 (3 новых, ~7 изменений)
**Новые:** `EditorFileWatcher.ts`, `GitStatusService.ts`, `GitStatusBadge.tsx`

---

## Риски и предупреждения

1. **Безопасность (критичный риск)**: каждый файловый IPC handler ОБЯЗАН валидировать что запрашиваемый путь находится внутри `projectRoot`. Path traversal (`../../etc/passwd`) -- главный вектор атаки. Используем существующий `validateFilePath()` из `src/main/utils/pathValidation.ts` (НЕ писать свой).

2. **Большие проекты**: дерево файлов может содержать тысячи файлов. Обязательны excluded patterns (`node_modules`, `.git`) и лимиты. Для поиска по файлам -- лимит на размер файла.

3. **Race conditions при сохранении**: если агент Claude параллельно редактирует тот же файл -- потеря данных. Итерация 5 добавляет mtime-проверку, но полноценный lock отсутствует.

4. **Memory**: CodeMirror для очень больших файлов (10MB+) может потреблять много памяти. Лимит на размер читаемого файла: **2MB** (не 5MB -- снижено после security review; IPC сериализация удваивает потребление памяти).

5. **ProseMirror vs CodeMirror**: в requirements указан ProseMirror, но в проекте уже глубоко интегрирован CodeMirror (20+ пакетов, diff view, языковые пакеты). Рекомендация: использовать CodeMirror (не ProseMirror). ProseMirror ориентирован на rich-text, а CodeMirror -- на код. CodeMirror 6 = тот же автор (Marijn Haverbeke), уже в проекте, zero additional dependencies.

---

## Архитектурные решения после ревизии

> Добавлено после ревизии. Влияет на каждую итерацию.

### Обязательные рефакторинги ДО или ВО ВРЕМЯ итерации 1

1. **Извлечь `buildTree()` в `src/renderer/utils/fileTreeBuilder.ts`** (из `ReviewFileTree.tsx`).
   Иначе будет дублирование при создании `EditorFileTree`. Рефакторинг не ломает Review -- это extract-and-import.

2. **Извлечь `getSyncLanguageExtension()` + `getAsyncLanguageDesc()` в `src/renderer/utils/codemirrorLanguages.ts`** (из `CodeMirrorDiffView.tsx`).
   Аналогично -- extract-and-import, `CodeMirrorDiffView` начинает импортировать из утилиты.

3. **Извлечь базовую тему CM в `src/renderer/utils/codemirrorTheme.ts`** (из `diffTheme` в `CodeMirrorDiffView.tsx`).
   Общие стили (`&`, `.cm-gutters`, `.cm-scroller`, `.cm-content`, `.cm-cursor`, `.cm-selectionBackground`) -- в общую тему.
   Diff-специфичные (`.cm-changedLine`, `.cm-deletedChunk` и т.д.) -- остаются в `CodeMirrorDiffView.tsx`.

4. **Извлечь `wrapHandler` в `src/main/ipc/ipcWrapper.ts`** (из `review.ts`).
   `createIpcWrapper('IPC:editor')` вместо копирования `wrapReviewHandler`.

5. **Имя сервиса: `ProjectFileService`** (не `FileEditorService`). Stateless, без `rootPath` в конструкторе.
   Каждый метод принимает `projectRoot` как первый аргумент. Паттерн: `TeamDataService`.

### Изменения в итерациях по результатам ревизии

**Итерация 1:**
- `EditorFileTree.tsx` использует generic `FileTree` из `fileTreeBuilder.ts` + render-prop для иконок
- `EditorCodeView.tsx` использует extracted `codemirrorLanguages.ts` и `codemirrorTheme.ts`
- `ProjectFileService` -- stateless, `readDir(projectRoot, dirPath)`, `readFile(projectRoot, filePath)`
- Security: `validateFilePath()` из `pathValidation.ts`, НЕ свой `assertInsideRoot()`
- НЕ создавать editorSlice на итерации 1 -- state для read-only просмотра можно держать в useState

**Итерация 2:**
- `editorSlice.ts` создаётся с чёткими секциями-группами (tree / tabs / content-save)
- `buildEditorExtensions(options)` -- фабрика extensions, компонент не знает о конкретных CM plugins
- `useEditorState.ts` -> убрать. Логика целиком в slice. Хук `useEditorState` дублирует slice.

**Итерация 3:**
- Tab management actions (`openFile`, `closeTab`, `setActiveTab`) уже в slice с итерации 2
- `EditorContextMenu.tsx` -- ОК, отдельный компонент
- `NewFileDialog.tsx` -- ОК, inline input

**Итерация 4:**
- `FileSearchService.ts` -- отдельный сервис в main, ОК (SRP)
- `useEditorKeyboardShortcuts.ts` -- ОК, отдельный хук
- `fileIcons.ts` -- ОК, чистая утилита

**Итерация 5:**
- `GitStatusService.ts` -- отдельный сервис, ОК
- `EditorFileWatcher.ts` -- повторяет паттерн FileWatcher (~60 LOC), ОК
- mtime conflict detection -- необходима проверка и в `saveFile` (slice), и в `writeFile` (service)

---

## UX Review

> Добавлено после UX-ревью. Дополнения и исправления по итерациям.

### Дополнения к итерации 1 (Walking Skeleton)

1. **Focus management:** При открытии overlay -- фокус на первый файл в дереве. При закрытии -- вернуть фокус на кнопку "Open in Editor" (паттерн `returnFocusRef`). Добавить `inert` на фоновый контент.

2. **ARIA:** File tree сразу с `role="tree"`, `role="treeitem"`, `aria-expanded`, `role="group"`. Не откладывать accessibility на потом.

3. **Пустой проект:** Если `readDir` возвращает 0 видимых файлов -- показать "No files found" + "Create a new file?" (кнопка неактивна до итерации 3).

4. **Binary файлы:** Уже на итерации 1 (read-only) нужна проверка бинарности. Добавить `isBinary` в `ReadFileResult` и `EditorBinaryState.tsx` -- "This file is binary. Open in system viewer?"

5. **Глубокая вложенность:** Max визуальный indent = 12 уровней. Tooltip с полным путём на глубоких узлах.

### Дополнения к итерации 2 (Editing + Save)

1. **Status bar:** Добавить `EditorStatusBar.tsx` -- `[Ln 42, Col 15] | [TypeScript] | [Spaces: 2]`. Данные из CM6 state. CSS: `bg-surface-sidebar border-t border-border text-text-muted text-xs h-6`.

2. **Unsaved changes при закрытии overlay:** Не только при закрытии tab, но и при Escape/X для overlay. Три кнопки: "Save All & Close" / "Discard & Close" / "Cancel". Добавить `hasUnsavedChanges()` в slice.

3. **Файл удалён извне:** При `saveFile` с ENOENT -- inline-ошибка "File was deleted. Create new? / Close tab". Не падать.

### Дополнения к итерации 3 (Multi-tab + file ops)

1. **Disambiguation tab labels:** Два таба "index.ts" -- нужно показать "(main/utils)" и "(renderer/utils)". Утилита `getDisambiguatedTabLabel()` в `src/renderer/utils/tabLabelDisambiguation.ts`.

2. **Длинные имена файлов:** Табы с max-width ~160px, `truncate`, tooltip. Modified dot ПЕРЕД текстом (не обрезается при truncate).

3. **ARIA для tab bar:** `role="tablist"`, `role="tab"`, `aria-selected`, `role="tabpanel"`.

### Исправления к итерации 4 (Hotkeys, search, UX polish)

1. **Keyboard shortcuts -- конфликт:** `Cmd+[` / `Cmd+]` это indent/outdent в CM6 и VS Code! Переключение табов: `Cmd+Shift+[` / `Cmd+Shift+]` (VS Code convention). Добавить `Ctrl+Tab` / `Ctrl+Shift+Tab`.

2. **Cmd+B toggle sidebar:** Добавить в список горячих клавиш. Sidebar width persist в localStorage.

3. **Cmd+G go to line:** Добавить. CM6 уже поддерживает через `gotoLine` command.

4. **Discoverability:** Кнопка `?` в header overlay (как в ChangeReviewDialog). EmptyState показывает шпаргалку shortcuts.

### Дополнения к итерации 5 (Git, file watching)

1. **File changed on disk while open in tab:** При обнаружении изменения -- banner в табе: "File changed on disk. [Reload] [Keep mine] [Show diff]". Не перезаписывать молча.

2. **File deleted on disk while open in tab:** Banner: "File no longer exists on disk. [Close tab]". Не показывать ошибку при попытке сохранить -- показать предупреждение.

---

## Security Review -- дополнения по итерациям

> Полный аудит безопасности описан в `plan-architecture.md` секция 18. Здесь -- конкретные требования для каждой итерации.

### Итерация 1: Security-critical

1. **`ProjectFileService.readDir()`**: Валидировать КАЖДЫЙ entry через `validateFilePath()`. Для symlinks -- `fs.realpath()` + повторная проверка containment. Молча пропускать symlinks, ведущие за пределы projectRoot (см. SEC-2 в plan-architecture.md).

2. **`ProjectFileService.readFile()`**: Проверить `fs.lstat()` -> `isFile()` ДО чтения. Проверить `stats.size <= 2MB`. Блокировать пути `/dev/`, `/proc/`, `/sys/`. После чтения -- post-read verify через `fs.realpath()` (TOCTOU mitigation).

3. **projectRoot**: Хранить в module-level state `editor.ts`, НЕ принимать от renderer при каждом IPC вызове. Устанавливать через `editor:open(projectPath)` с валидацией.

4. **Sensitive файлы**: `validateFilePath()` уже блокирует `.env`, `.ssh`, `credentials.json` и т.д. В readDir: показывать с пометкой "locked", при клике -- "Sensitive file, cannot open".

### Итерация 2: Security-critical

1. **`ProjectFileService.writeFile()`**:
   - `validateFilePath()` ДО записи
   - `Buffer.byteLength(content, 'utf8') <= 2MB` ДО записи
   - Atomic write: tmp файл в той же директории + `rename()`
   - Запрет записи в `.git/` директорию
   - Post-write verify не нужна (atomic rename -- одна операция)

2. **`editor:writeFile` IPC handler**: Параметр `filePath` от renderer валидируется через `validateFilePath(filePath, activeProjectRoot)`. `activeProjectRoot` из module-level state.

### Итерация 3: Security-critical

1. **`editor:createFile`**: Валидация имени файла через `validateFileName()`:
   - Запрет `.` и `..` как имени
   - Запрет control characters (`\x00-\x1f`)
   - Запрет path separators (`/`, `\`, `:`)
   - Запрет NUL bytes
   - Max длина 255 символов
   - Запрет sensitive паттернов (`.env`, `*.key`) при СОЗДАНИИ (опционально -- можно разрешить)

2. **`editor:deleteFile`**: Использовать `shell.trashItem()`, НЕ `fs.unlink()`. Валидация пути через `validateFilePath()`.

3. **Валидация parentDir**: При `createFile(parentDir, name)` -- валидировать и `parentDir`, и `path.join(parentDir, name)`.

### Итерация 4: Security-critical

1. **`editor:searchInFiles`**:
   - ТОЛЬКО literal string search, НЕ regex от пользователя
   - Max 1000 файлов для поиска, max 1MB на файл
   - Запустить в `worker_thread` или с AbortController timeout
   - Каждый файл для поиска валидировать через `validateFilePath()`

### Итерация 5: Medium security

1. **`editor:gitStatus`**: Выполняет `child_process.exec('git status')` -- убедиться что `cwd` установлен в projectRoot и что projectRoot валиден.

2. **`editor:watchDir`**: FileWatcher на projectRoot -- ОК, но при получении событий не передавать полные пути файлов в renderer без валидации.

3. **`editor:change` events (main->renderer)**: Пути файлов в events -- потенциальная утечка информации если watcher случайно поймает файл за пределами проекта (через symlink).

### ВНИМАНИЕ: Существующая уязвимость (не связана с editor)

**`review:saveEditedFile`** в `src/main/ipc/review.ts` записывает файл без валидации пути. См. SEC-11 в plan-architecture.md. Необходим отдельный hotfix НЕЗАВИСИМО от editor-фичи.

---

## Performance Review -- дополнения по итерациям

> Полный аудит в `plan-architecture.md` секция 19. Здесь -- конкретные performance-требования для каждой итерации.

### Итерация 1: Performance-critical

1. **EditorView lifecycle (CRITICAL):** НЕ использовать `Map<tabId, EditorView>` + CSS show/hide (как описано в plan-architecture секция 6.5). Использовать **EditorState pooling**: `Map<tabId, EditorState>` в useRef + один активный EditorView. При переключении таба: `savedStates.set(oldId, view.state)` -> `view.destroy()` -> `new EditorView({ state: savedStates.get(newId) })`. Паттерн initialState уже используется в CodeMirrorDiffView.tsx (строки 699-705).

2. **readDir лимиты:** MAX_ENTRIES_PER_DIR = 500 (не 10,000). При превышении -- "N more files..." + кнопка "Show all". Только root level при открытии, expand = depth=1 для конкретной папки.

3. **readFile тиерная стратегия:** <256KB мгновенно | 256KB-2MB с progress | 2MB-5MB preview only (100 строк) | >5MB external editor. Детектировать минификацию (строка >10,000 chars) и binary (null bytes в первых 8KB).

4. **Дедупликация IPC:** `Map<string, Promise<ReadFileResult>>` для readFile. Если файл уже загружается -- ждать результат, не создавать новый запрос.

### Итерация 2: Performance-critical

1. **НЕ хранить modified content в Zustand (CRITICAL):** `editorModifiedContents: Record<string, string>` из секции 2.1 plan-architecture -- УБРАТЬ. Контент живёт только в EditorState CodeMirror. В Zustand: `editorModifiedFiles: Set<string>` (только dirty flags). Dirty flag обновляется debounced (300ms) через EditorView.updateListener (паттерн из CodeMirrorDiffView строки 517-527).

2. **Гранулярные Zustand селекторы (обязательно):**
```typescript
const tabList = useStore(s => s.editorOpenTabs, shallow);
const activeId = useStore(s => s.editorActiveTabId);
// FileTreePanel НЕ подписывается ни на content, ни на tabs
// TabBar НЕ подписывается на tree state
```

3. **LRU eviction EditorState:** При >30 states в кеше -- вытеснять oldest, сохраняя `{ content: string, cursorPos: number }` (без undo). При возврате к вытесненному табу -- восстановить через `EditorState.create()`.

### Итерация 3: Performance-medium

1. **Tab closing -- memory cleanup:** При closeTab: `stateCache.delete(tabId)`. При closeAllTabs: `stateCache.clear()`. Явно вызывать -- не полагаться на GC.

2. **Concurrent file operations:** При createFile/deleteFile -- дебаунсить обновление дерева (500ms), не перечитывать после каждой операции.

### Итерация 4: Performance-critical

1. **File tree виртуализация (HIGH):** Перейти на `@tanstack/react-virtual` (уже в проекте -- DateGroupedSessions.tsx, ChatHistory.tsx, NotificationsView.tsx). `flattenTree(tree, expandedDirs) -> FlatNode[]` + `useVirtualizer({ count, estimateSize: () => 28 })`. Рендерить только видимые ноды.

2. **Search in files -- main process:** Запускать в worker_thread или с AbortController (timeout 5s). Limit: 100 результатов, max 1MB на файл. НЕ читать binary файлы для поиска.

3. **Quick Open (Cmd+P):** Кешировать flat file list при открытии editor. НЕ перечитывать на каждое открытие Cmd+P. Invalidate по F5 или file watcher event.

### Итерация 5: Performance-medium

1. **File watcher -- opt-in:** НЕ включать по умолчанию. Toggle "Watch for external changes". По умолчанию -- ручной refresh (F5). При включении: `fs.watch({ recursive: true })` с фильтрацией (node_modules/.git/dist) и debounce 200ms.

2. **Git status -- кеширование:** Результат `git status --porcelain` кешировать на 5 секунд (как в плане). При file watcher event -- invalidate и перечитать.

### Benchmarks для CI/Manual

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
  Порог: FileTreePanel и TabBar рендерятся 0 раз
```

---
