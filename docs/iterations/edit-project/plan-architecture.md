# Архитектурный план: In-App Code Editor

## Контекст

На странице TeamDetailView рядом с путём проекта (`data.config.projectPath`, строка ~761 файла `TeamDetailView.tsx`) добавляется кнопка, открывающая полноэкранный редактор кода прямо внутри приложения. Редактор базируется на **CodeMirror 6** (уже используется в проекте -- 17 пакетов `@codemirror/*` в `package.json`), а **не** ProseMirror. Это решение основано на том, что CodeMirror -- единственный редактор кода в зависимостях проекта, с готовым набором языковых расширений и темой `oneDark`.

## Оценки

- **Надежность решения**: 8/10 -- CodeMirror 6 проверен в продакшене (VS Code web, Obsidian), все зависимости уже в проекте.
- **Уверенность в плане**: 8/10 -- архитектура повторяет паттерны ChangeReviewDialog (full-screen overlay + file tree + CM editor).

---

## Архитектурная диаграмма (ASCII)

```
                         ┌─────────────────────────────────────────┐
                         │          TeamDetailView.tsx              │
                         │  [FolderOpen icon] [Edit button] ◄──────┤ Кнопка запуска
                         └───────────────────┬─────────────────────┘
                                             │ open={true}
                         ┌───────────────────▼─────────────────────┐
                         │      CodeEditorOverlay (full-screen)     │
                         │  ┌──────────────┐  ┌──────────────────┐ │
                         │  │  FileTreePanel│  │  EditorTabsPanel │ │
                         │  │              │  │  ┌────────────┐  │ │
                         │  │  ProjectTree │  │  │ EditorTab  │  │ │
                         │  │  component   │  │  │ EditorTab  │  │ │
                         │  │  (recursive) │  │  └────────────┘  │ │
                         │  │              │  │  ┌────────────┐  │ │
                         │  │              │  │  │CodeMirror  │  │ │
                         │  │              │  │  │EditorView  │  │ │
                         │  └──────────────┘  │  └────────────┘  │ │
                         │                    └──────────────────┘ │
                         └────────────────────────────────────────-┘
                                        │ IPC
                         ┌──────────────▼──────────────────────────┐
                         │           Preload Bridge                 │
                         │  editor.readDir / readFile / writeFile   │
                         │  editor.createFile / deleteFile          │
                         └──────────────┬──────────────────────────┘
                                        │
                         ┌──────────────▼──────────────────────────┐
                         │     Main Process: ProjectFileService      │
                         │  (sandboxed path validation)             │
                         │  ┌─────────────────────────────────┐    │
                         │  │ fs.readdir / fs.readFile /       │    │
                         │  │ fs.writeFile / fs.unlink /       │    │
                         │  │ fs.mkdir                         │    │
                         │  └─────────────────────────────────┘    │
                         └─────────────────────────────────────────┘
```

---

## 1. Компонентная иерархия

### 1.1 Новые компоненты

Размещение: `src/renderer/components/team/editor/`

```
editor/
├── CodeEditorOverlay.tsx        # Полноэкранный overlay (аналог ChangeReviewDialog)
├── FileTreePanel.tsx            # Левая панель с деревом файлов
├── FileTreeNode.tsx             # Рекурсивная нода дерева (файл / директория)
├── EditorTabsPanel.tsx          # Правая панель: вкладки + CodeMirror
├── EditorTab.tsx                # Одна вкладка открытого файла
├── CodeMirrorEditor.tsx         # Обёртка CM6 для редактирования (не diff)
├── EditorToolbar.tsx            # Панель инструментов (Save, Undo, Redo, язык)
├── EditorStatusBar.tsx          # Status bar: Ln:Col, язык, отступы, кодировка (UX Review 17.1.4)
├── EditorEmptyState.tsx         # Пустое состояние (нет открытых файлов + shortcuts шпаргалка)
├── EditorBinaryState.tsx        # Заглушка для бинарных файлов (UX Review 17.1.6)
└── EditorErrorState.tsx         # Заглушка для ошибок чтения файла (UX Review 17.2.5)
```

### 1.2 Принцип Single Responsibility

| Компонент | Ответственность |
|-----------|----------------|
| `CodeEditorOverlay` | Layout: fixed inset-0, z-50, header/close, split layout |
| `FileTreePanel` | Загрузка дерева, expand/collapse, поиск, контекстное меню |
| `FileTreeNode` | Рендер одной ноды, иконка, клик, drag |
| `EditorTabsPanel` | Управление открытыми табами, переключение |
| `CodeMirrorEditor` | CM6 lifecycle: create/destroy EditorView, extensions, keybindings |
| `EditorToolbar` | Действия: Save (Cmd+S), язык, отступы, кодировка |

### 1.3 Паттерн overlay (повтор ChangeReviewDialog)

Вместо `<Dialog>` от Radix используем raw `<div className="fixed inset-0 z-50">` -- точная копия паттерна из `ChangeReviewDialog.tsx` (строка 508). Причины:
- Radix Dialog ограничивает фокус внутри портала, что конфликтует с CM6
- Full-screen overlay не нуждается в backdrop/animation -- просто замена контента
- macOS traffic light padding: `var(--macos-traffic-light-padding-left, 72px)` в header

---

## 2. State Management

### 2.1 Zustand slice: `editorSlice.ts`

**Решение**: Новый slice в `src/renderer/store/slices/editorSlice.ts`.

**Обоснование**: Состояние редактора (открытые табы, unsaved changes, active tab) должно переживать перемонтирование компонента overlay (например, если юзер случайно закрыл и открыл снова -- unsaved файлы должны быть на месте).

```
EditorSlice {
  // --- Данные ---
  editorProjectPath: string | null          // Путь открытого проекта
  editorFileTree: FileTreeNode | null       // Корневое дерево
  editorFileTreeLoading: boolean
  editorFileTreeError: string | null

  editorOpenTabs: EditorFileTab[]           // Открытые вкладки
  editorActiveTabId: string | null          // Активная вкладка

  editorFileContents: Record<string, string>          // filePath → content (read-only cache)
  editorFileContentsLoading: Record<string, boolean>
  // ПЕРЕСМОТРЕНО (Performance Review 19.4): НЕ хранить modified content здесь!
  // Контент живёт в EditorState (Map<tabId, EditorState> в useRef).
  // Вместо Record<string, string> использовать Set<string> для dirty flags:
  editorModifiedFiles: Set<string>                    // filePath set — dirty markers only

  editorSaving: Record<string, boolean>     // filePath → saving in progress
  editorSaveError: Record<string, string>   // filePath → save error

  // --- Действия ---
  openEditor: (projectPath: string) => Promise<void>
  closeEditor: () => void

  loadFileTree: (dirPath: string) => Promise<void>
  expandDirectory: (dirPath: string) => Promise<void>

  openFile: (filePath: string) => Promise<void>
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void

  updateContent: (filePath: string, content: string) => void
  saveFile: (filePath: string) => Promise<void>
  saveAllFiles: () => Promise<void>
  discardChanges: (filePath: string) => void

  createFile: (parentDir: string, name: string) => Promise<void>
  deleteFile: (filePath: string) => Promise<void>
  createDirectory: (parentDir: string, name: string) => Promise<void>
}
```

### 2.2 Локальное состояние компонентов

Не выносить в store (а хранить в useState):
- Scroll position дерева файлов
- CM6 EditorView ref
- Размер панелей (resizable split)
- Поисковый запрос в дереве файлов
- Состояние контекстного меню

### 2.3 Модель `EditorFileTab`

```typescript
interface EditorFileTab {
  id: string                    // = filePath (уникальный ключ)
  filePath: string              // Абсолютный путь
  fileName: string              // Имя файла для отображения
  language: string              // Определяется по расширению
  isModified: boolean           // Есть unsaved changes (derived)
}
```

### 2.4 Интеграция в AppState

Файл `src/renderer/store/types.ts` -- добавить `EditorSlice` в union type `AppState`.

---

## 3. IPC API Design

### 3.1 Новые IPC-каналы

Файл: `src/preload/constants/ipcChannels.ts`

```
// =============================================================================
// Editor API Channels
// =============================================================================

EDITOR_READ_DIR      = 'editor:readDir'
EDITOR_READ_FILE     = 'editor:readFile'
EDITOR_WRITE_FILE    = 'editor:writeFile'
EDITOR_CREATE_FILE   = 'editor:createFile'
EDITOR_DELETE_FILE   = 'editor:deleteFile'
EDITOR_CREATE_DIR    = 'editor:createDir'
EDITOR_RENAME        = 'editor:rename'
EDITOR_FILE_EXISTS   = 'editor:fileExists'
```

### 3.2 IPC-типы

Файл: `src/shared/types/editor.ts` (NEW)

```
FileTreeEntry {
  name: string
  path: string             // Абсолютный путь
  type: 'file' | 'directory'
  size?: number            // Только для файлов
  children?: FileTreeEntry[]  // Только для директорий (lazy)
}

ReadDirResult {
  entries: FileTreeEntry[]
  truncated: boolean       // Если > MAX_DIR_ENTRIES
}

ReadFileResult {
  content: string
  size: number
  truncated: boolean       // Если > MAX_FILE_SIZE
  encoding: string
}
```

### 3.3 Паттерн IPC handler

Файл: `src/main/ipc/editor.ts` (NEW)

Повторяет паттерн `review.ts`:
- module-level state (`let fileService: ProjectFileService | null`)
- `initializeEditorHandlers(service)`
- `registerEditorHandlers(ipcMain)`
- `removeEditorHandlers(ipcMain)`
- `wrapHandler` из `src/main/ipc/ipcWrapper.ts` (общий, НЕ копия из `review.ts`)

### 3.4 ElectronAPI расширение

Файл: `src/shared/types/api.ts` -- добавить `EditorAPI` interface и свойство `editor: EditorAPI` в `ElectronAPI`.

Файл: `src/preload/index.ts` -- добавить секцию `editor: { ... }` в объект `electronAPI`, все через `invokeIpcWithResult<T>()`.

---

## 4. Main Process: ProjectFileService

### 4.1 Сервис

Файл: `src/main/services/editor/ProjectFileService.ts` (NEW)

Единственная ответственность: безопасные файловые операции внутри заданного projectPath.

> **РЕВИЗИЯ:** Сервис stateless (без `rootPath` в конструкторе). Каждый метод принимает `projectRoot` как первый аргумент. Паттерн аналогичен `TeamDataService` — не привязан к одному проекту.

**Критическая безопасность**: Path traversal prevention через `validateFilePath()` из `pathValidation.ts`.

```
ProjectFileService {
  // Stateless — нет конструктора с rootPath
  // Все методы принимают projectRoot + проверяют через validateFilePath()

  readDir(projectRoot: string, dirPath: string, depth?: number): Promise<ReadDirResult>
  readFile(projectRoot: string, filePath: string): Promise<ReadFileResult>
  writeFile(projectRoot: string, filePath: string, content: string): Promise<void>
  createFile(projectRoot: string, parentDir: string, name: string, content?: string): Promise<void>
  deleteFile(projectRoot: string, filePath: string): Promise<void>
  createDir(projectRoot: string, parentDir: string, name: string): Promise<void>
  rename(projectRoot: string, oldPath: string, newPath: string): Promise<void>
  fileExists(projectRoot: string, filePath: string): Promise<boolean>
}
```

### 4.2 Path Validation

**КРИТИЧЕСКИ ВАЖНО**: Использовать `validateFilePath()` из `src/main/utils/pathValidation.ts`, а НЕ писать свой `assertInsideRoot`. Существующая функция уже обрабатывает:
- Нормализацию пути через `path.resolve()`
- Symlink resolution через `fs.realpathSync.native()`
- Проверку sensitive patterns (`.env`, `.ssh`, credentials и т.д.)
- Проверку что realpath тоже внутри allowed directories
- Cross-platform поддержку (Windows case-insensitive)

```typescript
import { validateFilePath } from '@main/utils/pathValidation';

function assertInsideProject(absolutePath: string, projectRoot: string): string {
  const result = validateFilePath(absolutePath, projectRoot);
  if (!result.valid) {
    throw new Error(`Access denied: ${result.error}`);
  }
  return result.normalizedPath!;
}
```

**Дополнительные проверки для editor (сверх validateFilePath)**:
1. **Symlink-проверка для readDir**: при рекурсивном обходе каждый entry может быть symlink. Нужно `fs.lstat()` + `fs.realpath()` для каждого entry, проверяя что target внутри projectRoot.
2. **Валидация имён файлов при создании**: запрет NUL bytes, запрет `.` / `..` как имени, запрет `/` и `\` в имени, максимальная длина 255 символов.
3. **TOCTOU mitigation**: использовать `O_NOFOLLOW` при открытии файлов или проверять после `open()` через `fstat()`, что дескриптор указывает на файл внутри projectRoot.
4. **Запрет записи в .git/**: добавить `.git` в список запрещённых для записи директорий (чтение можно разрешить для отображения, но НЕ запись).

### 4.3 Файловые лимиты и защита от DoS

```typescript
MAX_FILE_SIZE = 2 * 1024 * 1024   // 2 MB -- безопасный лимит для IPC + CM6
MAX_WRITE_SIZE = 2 * 1024 * 1024  // 2 MB -- лимит на запись (защита от memory bomb)
MAX_DIR_ENTRIES = 5_000            // Защита от node_modules-подобных директорий
MAX_DIR_DEPTH = 15                 // Максимальная глубина рекурсии
MAX_FILENAME_LENGTH = 255          // POSIX лимит
MAX_PATH_LENGTH = 4096             // PATH_MAX

IGNORED_DIRS = ['.git', 'node_modules', '.next', 'dist', '__pycache__', '.cache', '.venv', '.tox', 'vendor']
IGNORED_FILES = ['.DS_Store', 'Thumbs.db']

// Защита от чтения device файлов и спецфайлов
BLOCKED_PATHS = ['/dev/', '/proc/', '/sys/', '\\\\.\\']  // device files на Linux/macOS/Windows
```

**Важно**: Перед чтением файла **обязательно** проверить через `fs.lstat()`:
- `stats.isFile()` === true (не directory, не device, не socket, не FIFO)
- `stats.size` <= MAX_FILE_SIZE (не читать файл если stat показывает огромный размер)
- НЕ использовать `stats.isSymbolicLink()` для решения -- вместо этого `fs.realpath()` + повторная проверка containment

**Перед записью**: проверить `Buffer.byteLength(content, 'utf8')` <= MAX_WRITE_SIZE до вызова `fs.writeFile()`.

### 4.4 Регистрация в handlers.ts

Файл: `src/main/ipc/handlers.ts`
- Импорт `initializeEditorHandlers`, `registerEditorHandlers`, `removeEditorHandlers`
- Создание `ProjectFileService` (stateless, без аргументов) в `initializeIpcHandlers`
- Регистрация при инициализации

---

## 5. Дерево файлов

### 5.1 Рекурсивная модель с lazy-loading

Дерево НЕ грузится целиком. Начальная загрузка -- только root level (depth=1). При expand директории -- IPC `editor:readDir` для конкретной папки.

```
FileTreeNode (renderer-side) {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number

  // Для директорий:
  children: FileTreeNode[] | null   // null = не загружены
  expanded: boolean
  loading: boolean
}
```

### 5.2 Хранение состояния дерева

`expandedDirs: Set<string>` -- хранить в editorSlice. При re-open editor -- дерево подгружается заново, но expanded-состояние сохраняется.

### 5.3 Фильтрация и сортировка

- Скрывать: `.git`, `node_modules`, `dist`, `__pycache__` (configurable)
- Сортировка: директории сначала, затем файлы; внутри группы -- alphabetical
- Поиск: fuzzy filter по имени файла (локальный, без IPC)

### 5.4 Контекстное меню

Правый клик на ноде:
- Файл: Open, Delete, Rename, Copy Path
- Директория: New File, New Directory, Delete, Rename, Copy Path
- Пустое место: New File, New Directory

---

## 6. CodeMirror интеграция

### 6.1 Подход

Компонент `CodeMirrorEditor.tsx` -- обёртка аналогичная `MembersJsonEditor.tsx` (строки 27-59) и `CodeMirrorDiffView.tsx`, но для single-file editing (не diff).

### 6.2 Extensions (переиспользование)

Из уже имеющихся в `CodeMirrorDiffView.tsx`:

```
- Language detection (файл → extension → LanguageDescription)
  Все 17 языков уже подключены: JS/TS, Python, Rust, Go, Java, C++, CSS, HTML,
  JSON, YAML, XML, SQL, PHP, Markdown, Less, Sass
- oneDarkHighlightStyle (уже импортируется)
- lineNumbers()
- history() + historyKeymap
- indentWithTab
- defaultKeymap
- syntaxHighlighting()
```

Дополнительно для editor (не diff):

```
- closeBrackets + closeBracketsKeymap (уже используется в MembersJsonEditor)
- bracketMatching (уже используется в MembersJsonEditor)
- EditorView.updateListener для onChange
- Cmd+S keymap для save
- search + searchKeymap (Cmd+F)
- indentUnit настройка (2/4 spaces)
- EditorView.lineWrapping (toggle)
- highlightActiveLine
- highlightActiveLineGutter
```

### 6.3 Определение языка по расширению

Функция `getLanguageExtension(fileName)` -- уже реализована в `CodeMirrorDiffView.tsx` (примерно строки 1-25, маппинг extension -> language plugin). Вынести в общий util `src/renderer/utils/codemirrorLanguage.ts` для переиспользования.

### 6.4 Тема

Единая тема для всего приложения: `oneDark` + CSS custom properties из `index.css`. Дополнительная кастомизация через `EditorView.theme({})`:
- Фон: `var(--color-surface)`
- Шрифт: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace`
- font-size: 13px (чуть крупнее чем в diff view)

### 6.5 Управление EditorView lifecycle

> **ПЕРЕСМОТРЕНО после Performance Review (секция 19.1-19.2).** Оригинальный подход CSS show/hide заменён на EditorState pooling.

- ~~Один `EditorView` на открытый tab~~ -> Один `EditorView` на ВЕСЬ редактор (активный файл)
- При закрытии tab: `savedStates.delete(tabId)`
- Хранить `Map<tabId, EditorState>` в ref (НЕ EditorView!)
- При переключении tab: `savedStates.set(oldId, view.state)` -> `view.destroy()` -> `new EditorView({ state: savedStates.get(newId), parent: container })`
- LRU eviction при >30 states: сохранить content + cursor, вытеснить undo history
- Паттерн: аналог initialState в CodeMirrorDiffView.tsx (строки 699-705)

---

## 7. Tab-система для нескольких файлов

### 7.1 Модель

```
openTabs: EditorFileTab[]
activeTabId: string | null
```

### 7.2 Поведение

- Клик на файл в дереве:
  - Если tab уже открыт -- activate
  - Если нет -- создать tab, загрузить содержимое через IPC, activate
- Закрытие tab:
  - Если есть unsaved changes -- confirm dialog (Save / Discard / Cancel)
  - Cmd+W закрывает активный tab
- Modified indicator: точка на tab (аналог VS Code)
- Порядок табов: по порядку открытия, drag-to-reorder не нужен на первой итерации

---

## 8. Error Handling Strategy

### 8.1 Уровни ошибок

| Уровень | Обработка | Пример |
|---------|----------|--------|
| IPC failure | Toast/banner в overlay | Сеть, main process crash |
| File read error | Inline в tab | ENOENT, EACCES, binary file |
| File write error | Inline + retry | EACCES, disk full |
| Path traversal | Reject + log | Попытка выйти за projectPath |
| File too large | Inline warning | > MAX_FILE_SIZE |

### 8.2 Паттерн ошибок в slice

Повторяет teamSlice:

```
editorFileTreeError: string | null
editorSaveError: Record<string, string>   // per-file
```

### 8.3 Main process

`wrapEditorHandler<T>()` -- ловит все исключения, возвращает `IpcResult<T>`.

### 8.4 Renderer

`unwrapIpc('editor:readFile', ...)` -- стандартный паттерн из `unwrapIpc.ts`.

---

## 9. Производительность

### 9.1 Большие директории

- **Lazy loading**: грузим дерево по одному уровню, expand подгружает children
- **Фильтрация**: `node_modules`, `.git` и т.д. фильтруются на стороне main process (НЕ отправляются по IPC)
- **Лимит**: MAX_DIR_ENTRIES = 10,000 entries per directory, truncation flag

### 9.2 Большие файлы

- **Лимит**: MAX_FILE_SIZE = 5MB. Больше -- показываем warning, предлагаем открыть в внешнем редакторе (`shell:openPath`)
- **Бинарные файлы**: Определять по magic bytes / extension. Показывать "Binary file, cannot edit"
- **CM6 производительность**: CodeMirror 6 обрабатывает файлы до 5MB без проблем (virtual rendering)

### 9.3 Оптимизация IPC

- **File content caching**: кэшируем `editorFileContents` в store. Invalidate при save.
- **Debounced onChange**: updateContent вызывается при каждом keystroke, но это локальная операция (set state). Фактический save только по Cmd+S.
- **Tree caching**: после загрузки дерево хранится в store. Re-fetch только при explicit refresh (F5 или кнопка refresh).

### 9.4 Memory

- Удалять CM EditorView при закрытии tab для освобождения памяти
- Не хранить больше 20 одновременно открытых EditorView (soft limit, предупреждение)

---

## 10. Data Flow

### 10.1 Открытие редактора

```
1. Юзер кликает кнопку [Code] рядом с projectPath в TeamDetailView
2. editorSlice.openEditor(data.config.projectPath)
3. set({ editorProjectPath, editorFileTreeLoading: true })
4. IPC: editor:readDir(projectPath, depth=1)
5. Main: ProjectFileService.readDir() → валидация пути → fs.readdir
6. Результат: FileTreeEntry[]
7. set({ editorFileTree, editorFileTreeLoading: false })
8. CodeEditorOverlay рендерится (fixed inset-0 z-50)
```

### 10.2 Открытие файла

```
1. Юзер кликает на файл в FileTreePanel
2. editorSlice.openFile(filePath)
3. Проверка: есть ли уже tab с этим filePath?
   ДА → setActiveTab(tabId)
   НЕТ → создать tab, IPC: editor:readFile(filePath)
4. Main: ProjectFileService.readFile() → валидация → fs.readFile
5. Результат: ReadFileResult { content, size, truncated }
6. set({ editorFileContents[filePath]: content })
7. CM EditorState создаётся, единственный EditorView пересоздаётся
```

### 10.3 Сохранение файла

```
1. Юзер нажимает Cmd+S (или кнопку Save)
2. editorSlice.saveFile(filePath)
3. content = EditorState (из useRef Map) ?? editorFileContents[filePath]
4. set({ editorSaving[filePath]: true })
5. IPC: editor:writeFile(filePath, content)
6. Main: ProjectFileService.writeFile() → валидация → fs.writeFile (atomic via tmp+rename)
7. set({ editorSaving: false, editorModifiedFiles: remove filePath })
8. Tab isModified indicator исчезает
```

### 10.4 Создание/удаление файла

```
Создание:
1. Юзер через контекстное меню → "New File"
2. Inline input в дереве (имя файла)
3. IPC: editor:createFile(parentDir, name)
4. Main: fs.writeFile(path.join(parentDir, name), '')
5. Обновить дерево: expandDirectory(parentDir)
6. Автоматически открыть новый файл в tab

Удаление:
1. Контекстное меню → "Delete"
2. Confirm dialog
3. IPC: editor:deleteFile(filePath)
4. Main: fs.unlink (файл) или fs.rm (директория, recursive)
5. Закрыть tab если был открыт
6. Обновить дерево
```

---

## 11. Keyboard Shortcuts

| Shortcut | Действие |
|----------|---------|
| `Cmd+S` | Сохранить активный файл |
| `Cmd+Shift+S` | Сохранить все |
| `Cmd+W` | Закрыть активный tab |
| `Cmd+P` | Quick Open (поиск файла) -- Phase 2 |
| `Cmd+F` | Поиск в файле (CM6 search) |
| `Escape` | Закрыть overlay (с confirm при unsaved changes) |
| `Cmd+Shift+[` / `Cmd+Shift+]` | Переключение табов влево/вправо |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Переключение табов (MRU) |
| `Cmd+B` | Toggle file tree sidebar |
| `Cmd+G` | Go to line (CM6 gotoLine) |
| `Cmd+Z` / `Cmd+Shift+Z` | Undo/Redo (CM6 native) |

---

## 12. Новые зависимости

**Нет новых npm-зависимостей!** Все нужные пакеты уже в `package.json`:
- CodeMirror 6 -- 17 пакетов `@codemirror/*`
- lucide-react -- иконки (File, Folder, FolderOpen, Save, X, Plus, Trash2)
- Radix UI -- для контекстного меню (Popover) и confirm dialog (Dialog)

---

## 13. План итераций реализации

### Итерация 1: Read-Only File Browser
- `FileEditorService` с `readDir` + `readFile` (main process)
- IPC каналы `editor:readDir`, `editor:readFile`
- `editorSlice` (минимальный: tree + openFile + tabs)
- `CodeEditorOverlay` + `FileTreePanel` + `CodeMirrorEditor` (read-only)
- Кнопка в TeamDetailView

### Итерация 2: File Editing + Save
- `writeFile` в сервисе + IPC
- Modified content tracking в store
- Cmd+S save
- Unsaved changes indicator (dot on tab)
- Close tab с confirm

### Итерация 3: File Operations
- `createFile`, `deleteFile`, `createDir`, `rename` в сервисе
- Контекстное меню в дереве файлов
- Inline rename в дереве

### Итерация 4: Polish
- Quick Open (Cmd+P) -- fuzzy search по файлам
- Binary file detection
- Large file warning
- File watcher integration (auto-refresh tree при внешних изменениях)
- Resizable split panels

---

## 14. Список файлов для создания/модификации

### Новые файлы (~15)

| Файл | Описание |
|------|----------|
| `src/shared/types/editor.ts` | Типы: FileTreeEntry, ReadDirResult, ReadFileResult |
| `src/main/services/editor/ProjectFileService.ts` | Main process сервис файловых операций (stateless) |
| `src/main/ipc/editor.ts` | IPC handlers для editor |
| `src/main/ipc/ipcWrapper.ts` | Общий `createIpcWrapper()` (извлечь из review.ts) |
| `src/renderer/store/slices/editorSlice.ts` | Zustand slice (итерация 2+) |
| `src/renderer/components/team/editor/ProjectEditorOverlay.tsx` | Full-screen overlay |
| `src/renderer/components/team/editor/EditorFileTree.tsx` | Обёртка над generic FileTree |
| `src/renderer/components/common/FileTree.tsx` | Generic FileTree с render-props (рефакторинг из ReviewFileTree) |
| `src/renderer/components/team/editor/EditorTabsPanel.tsx` | Табы + editor |
| `src/renderer/components/team/editor/CodeMirrorEditor.tsx` | CM6 wrapper |
| `src/renderer/components/team/editor/EditorToolbar.tsx` | Toolbar |
| `src/renderer/components/team/editor/EditorEmptyState.tsx` | Empty state |
| `src/renderer/utils/codemirrorLanguages.ts` | Языковой маппинг (извлечь из CodeMirrorDiffView) |
| `src/renderer/utils/codemirrorTheme.ts` | Базовая тема CM (извлечь из diffTheme) |
| `src/renderer/utils/fileTreeBuilder.ts` | buildTree + сортировка (извлечь из ReviewFileTree) |

### Модификации (~10)

| Файл | Изменение |
|------|-----------|
| `src/preload/constants/ipcChannels.ts` | +8 констант EDITOR_* |
| `src/preload/index.ts` | +секция `editor: { ... }` в electronAPI |
| `src/shared/types/api.ts` | +`EditorAPI` interface, +`editor: EditorAPI` в `ElectronAPI` |
| `src/shared/types/index.ts` | +export из editor.ts |
| `src/main/ipc/handlers.ts` | +регистрация editor handlers |
| `src/main/ipc/review.ts` | Заменить локальный `wrapReviewHandler` на import из `ipcWrapper.ts` |
| `src/renderer/store/types.ts` | +`EditorSlice` в AppState union (итерация 2) |
| `src/renderer/store/index.ts` | +`createEditorSlice` (итерация 2) |
| `src/renderer/components/team/TeamDetailView.tsx` | +кнопка Code + импорт ProjectEditorOverlay |
| `src/renderer/components/team/review/ReviewFileTree.tsx` | Рефакторинг: использовать generic FileTree + fileTreeBuilder |
| `src/renderer/components/team/review/CodeMirrorDiffView.tsx` | Рефакторинг: импортировать из codemirrorLanguages.ts и codemirrorTheme.ts |

---

## 15. Риски и митигации

| Риск | Вероятность | Митигация |
|------|------------|-----------|
| Path traversal через IPC | Средняя | `validateFilePath()` из pathValidation.ts на КАЖДОМ IPC handler |
| CM6 тормозит на файлах >2MB | Низкая | Hard limit 2MB + warning + external editor fallback |
| node_modules в дереве -- OOM | Высокая | IGNORED_DIRS фильтр на main process + MAX_DIR_ENTRIES |
| Race condition при save (TOCTOU) | Высокая | Atomic write (tmp + rename) + fstat после open + saving flag |
| Unsaved data loss при crash | Средняя | Phase 2: autosave в localStorage/IndexedDB |
| Symlink escape из rootPath | Высокая | `validateFilePath()` уже делает `fs.realpathSync.native()` + re-check |
| Device file DoS (/dev/zero) | Средняя | `fs.lstat()` + `isFile()` проверка ДО чтения |
| Credential leakage (.env, .key) | Высокая | `validateFilePath()` проверяет SENSITIVE_PATTERNS |
| XSS через имена файлов | Низкая | React экранирует автоматически; НЕ использовать innerHTML |
| IPC flooding | Средняя | Debounce на renderer + AbortController |
| ReDoS в searchInFiles | Средняя | Только literal search, НЕ regex от пользователя |

---

## 16. Архитектурная ревизия (SOLID / DRY / Clean Architecture)

> Добавлено после ревизии архитектором. Все замечания основаны на анализе реального кода проекта.

### 16.1 SOLID-анализ

#### S -- Single Responsibility

**Проблема 1: `FileTreePanel.tsx` несёт двойную ответственность.**
В плане FileTreePanel отвечает и за загрузку данных дерева (IPC вызовы, expand/collapse), и за рендеринг UI (поиск, контекстное меню).

**Решение:** Разделить на два слоя:
- `FileTreePanel.tsx` -- чистый UI: рендерит дерево, принимает данные через store
- Логика загрузки и expand -- ТОЛЬКО в `editorSlice.ts` (actions `loadFileTree`, `expandDirectory`)
- Контекстное меню -- отдельный `EditorContextMenu.tsx` (уже запланирован на итерацию 3)

**Проблема 2: `CodeMirrorEditor.tsx` смешивает CM lifecycle + keybindings + onChange.**

**Решение:** Извлечь extensions builder в отдельный `buildEditorExtensions.ts` (аналогично `buildExtensions()` в `CodeMirrorDiffView.tsx` строки 477-688). Keybindings (Cmd+S и др.) -- часть extensions, но собираются в builder, а не в компоненте.

#### O -- Open/Closed

**Проблема: FileTree не расширяем через render-prop.**
`ReviewFileTree.tsx` уже содержит `TreeItem` с review-специфичным рендерингом (FileStatusIcon, +/- lines). EditorFileTree будет содержать свой рендеринг (dirty marker, file type icon). Два дерева -- два набора рендеринга без общей абстракции.

**Решение (render-prop / compound components):**
```typescript
// Общий generic FileTree
interface FileTreeProps<T extends { name: string; fullPath: string; isFile: boolean }> {
  nodes: T[];
  activeNodePath: string | null;
  onNodeClick: (node: T) => void;
  renderNodeExtra?: (node: T) => React.ReactNode;  // Правая часть (статус/кол-во строк)
  renderNodeIcon?: (node: T) => React.ReactNode;    // Иконка слева от имени
  collapsedFolders: Set<string>;
  onToggleFolder: (fullPath: string) => void;
}
```
`ReviewFileTree` добавляет `FileStatusIcon` + `+/-` строки через `renderNodeExtra`.
`EditorFileTree` добавляет dirty-маркер и file type icon.
Оба дерева используют один `buildTree()` и `TreeItem` рендеринг.

#### L -- Liskov Substitution

Наследований в плане нет (React -- composition over inheritance). Корректно.

`FileTreeNode` должен расширять `FileTreeEntry`, а не дублировать поля:
```typescript
// shared/types/editor.ts
interface FileTreeEntry { name: string; path: string; type: 'file' | 'directory'; size?: number; }

// renderer (local type)
interface FileTreeNode extends FileTreeEntry {
  children: FileTreeNode[] | null;
  expanded: boolean;
  loading: boolean;
}
```

#### I -- Interface Segregation

**Проблема: `editorSlice` с 15+ actions -- слишком толстый интерфейс.**
Сравнение: `changeReviewSlice` содержит ~25 actions и это одна из самых сложных фич в проекте.

**Решение:** Логически разделить EditorSlice на 4 группы (оставить в одном файле, т.к. Zustand slices -- flat intersection, но документировать секциями):
```
// Группа 1: File tree state + actions
editorProjectPath, editorFileTree, editorFileTreeLoading, editorFileTreeError
openEditor, closeEditor, loadFileTree, expandDirectory

// Группа 2: Tab management
editorOpenTabs, editorActiveTabId
openFile, closeTab, setActiveTab

// Группа 3: Content + Save
editorFileContents, editorModifiedContents, editorSaving, editorSaveError
updateContent, saveFile, saveAllFiles, discardChanges

// Группа 4: File operations (итерация 3)
createFile, deleteFile, createDirectory
```

#### D -- Dependency Inversion

**Проблема:** `CodeMirrorEditor.tsx` напрямую зависит от конкретных CM extensions.

**Решение:** Extensions собираются в фабрике `buildEditorExtensions(options)`:
```typescript
interface EditorExtensionOptions {
  readOnly: boolean;
  fileName: string;
  onContentChanged?: (content: string) => void;
  onSave?: () => void;
  tabSize?: number;
  lineWrapping?: boolean;
}
```
Компонент вызывает `buildEditorExtensions(opts)` и не знает о конкретных extensions.

### 16.2 DRY-анализ

**Проблема 1: Дублирование `buildTree()` + сортировки.**
`ReviewFileTree.tsx` строки 42-83 содержат `buildTree()` с collapse-логикой. `EditorFileTree` будет реализовывать аналогичную, но с другим источником данных.

**Решение (обязательное):**
1. Извлечь generic `buildTree<T>(items, getPath, isFile)` в `src/renderer/utils/fileTreeBuilder.ts`
2. Сортировка (dirs first, alphabetical) тоже в `fileTreeBuilder.ts`
3. `ReviewFileTree` + `EditorFileTree` используют одну и ту же функцию

**Проблема 2: Тема CodeMirror -- частичное дублирование с `diffTheme`.**
~50% стилей `diffTheme` (`&`, `.cm-gutters`, `.cm-scroller`, `.cm-content`, `.cm-cursor`, `.cm-selectionBackground`) идентичны.

**Решение:**
```typescript
// src/renderer/utils/codemirrorTheme.ts
export const baseEditorTheme = EditorView.theme({/* общие стили */});

// CodeMirrorDiffView.tsx -- импортирует baseEditorTheme + свои diff-стили
// CodeMirrorEditor.tsx -- импортирует baseEditorTheme + свои editor-стили
```

**Проблема 3: `wrapEditorHandler` -- копия `wrapReviewHandler`.**
В плане `wrapEditorHandler<T>()` в `editor.ts` -- 1:1 копия из `review.ts` (строки 133-145).

**Решение:** Извлечь общий `createIpcWrapper(logPrefix)` в `src/main/ipc/ipcWrapper.ts`:
```typescript
export function createIpcWrapper(logPrefix: string) {
  const log = createLogger(logPrefix);
  return async function wrap<T>(op: string, fn: () => Promise<T>): Promise<IpcResult<T>> {
    try { return { success: true, data: await fn() }; }
    catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`handler error [${op}]:`, msg);
      return { success: false, error: msg };
    }
  };
}
```

### 16.3 Clean Architecture -- направление зависимостей

Потоки зависимостей проверены -- корректны:
```
shared/types/editor.ts (чистые типы, zero deps)
  <- main/services/editor/ (зависит от fs, path, shared/types)
  <- main/ipc/editor.ts (зависит от service + shared types)
  <- preload/index.ts (зависит от ipcChannels)
  <- renderer/store/ (зависит от api layer + shared types)
  <- renderer/components/ (зависит от store + utils)
```

**Проблема: `FileEditorService` принимает `rootPath` в конструкторе.**
Привязывает один сервис к одному проекту. При переключении команды -- нужно пересоздавать.

**Решение: Stateless service (рекомендуется, 9/10).**
Каждый метод принимает `projectRoot` как аргумент. Валидация -- в каждом методе.
Это паттерн `TeamDataService` (нет привязки к конкретной команде в конструкторе).
В `handlers.ts` создаётся один экземпляр `ProjectFileService()` без аргументов.

### 16.4 Security -- переиспользование существующей валидации

**Проблема:** План описывает свой `assertInsideRoot()`, но в проекте уже есть `validateFilePath()` в `src/main/utils/pathValidation.ts` которая:
- Проверяет абсолютность пути
- Предотвращает path traversal
- Блокирует sensitive files (.ssh, .env, .pem и т.д.)
- Проверяет symlink escapes через `fs.realpathSync`

**Решение:** НЕ писать свой `assertInsideRoot()`. Использовать `validateFilePath(filePath, projectRoot)` из `pathValidation.ts`. Дополнительно нужна ТОЛЬКО проверка что projectRoot -- валидный абсолютный путь (однократно при `openEditor`).

### 16.5 Именование -- приведение к единому стилю

В plan-architecture.md сервис назван `FileEditorService`, в plan-iterations.md -- `ProjectFileService`.

**Рекомендация:** Использовать `ProjectFileService` везде -- лучше отражает суть (файловые операции в рамках проекта), не путается с "editor" (который в renderer).

---

## 17. UX Review

> Добавлено после UX-ревью. Анализ user journeys, keyboard-first, accessibility, edge cases.

### 17.1 Критично для MVP

#### 17.1.1 Unsaved changes при закрытии overlay (Escape / кнопка X)

**Проблема:** В секции 11 `Escape` закрывает overlay, но нигде не описано, что происходит с unsaved changes при закрытии ВСЕГО overlay. В секции 7.2 confirm описан только для закрытия отдельного tab, не для overlay.

**Рекомендация:** При `Escape` или клике на `X`, если есть ЛЮБОЙ таб с `isModified: true`:
1. Показать `confirm()` (существующий `ConfirmDialog`): "You have unsaved changes in N files."
2. Три кнопки: **Save All & Close**, **Discard & Close**, **Cancel**
3. `Escape` внутри confirm = Cancel (возврат к редактору)

Добавить в `editorSlice`:
```typescript
hasUnsavedChanges: () => boolean  // derived: Object.keys(editorModifiedContents).length > 0
```

#### 17.1.2 Файл удалён извне пока открыт в табе

**Проблема:** Нигде не описано, что делать если файл, открытый в табе, удалён или переименован на диске (другим процессом, CLI-агентом). Claude Agent активно меняет файлы -- это реальный сценарий.

**Рекомендация:**
- При попытке `saveFile` с ENOENT -- показать inline-ошибку в табе: "File was deleted. Create new? / Close tab"
- При `editor:change` (FileWatcher, итерация 5) -- если файл удалён, показать subtle banner: "File no longer exists on disk"
- Для MVP (без FileWatcher): проверять `fileExists` перед `writeFile`. Если ENOENT -- показать ошибку, не падать.

#### 17.1.3 Два таба с одинаковым именем (разные пути)

**Проблема:** `EditorFileTab.fileName` -- просто имя файла. Если открыть `src/main/utils/index.ts` и `src/renderer/utils/index.ts` -- оба таба покажут "index.ts". Различить невозможно.

**Рекомендация:** VS Code решает добавлением минимального disambiguating parent:
```
index.ts (main/utils)    index.ts (renderer/utils)
```
Утилита `getDisambiguatedTabLabel(tabs)` в `src/renderer/utils/tabLabelDisambiguation.ts`.

#### 17.1.4 Status bar (line:col, язык, кодировка)

**Проблема:** В плане нет status bar -- базовый элемент любого код-редактора.

**Рекомендация:** `EditorStatusBar.tsx` -- нижняя полоска overlay:
```
[Ln 42, Col 15] | [TypeScript] | [UTF-8] | [Spaces: 2] | [LF]
```
CSS: `bg-surface-sidebar border-t border-border text-text-muted text-xs h-6`

#### 17.1.5 Keyboard shortcuts -- конфликт Cmd+[/]

**Проблема:** Секция 11: `Cmd+[` / `Cmd+]` для табов. Но в VS Code и CM6 это indent/outdent.

**Рекомендация:** `Cmd+Shift+[` / `Cmd+Shift+]` для табов. `Ctrl+Tab`/`Ctrl+Shift+Tab` как альтернатива.

#### 17.1.6 Binary файлы -- конкретный UI

**Проблема:** Секция 9.2 -- только текст, нет дизайна.

**Рекомендация:** `EditorBinaryState.tsx` вместо CM6: иконка, тип/размер, кнопки "Open in System Viewer" и "Close Tab". Добавить `isBinary: boolean` в `ReadFileResult`.

#### 17.1.7 Accessibility: ARIA roles

**Проблема:** `ReviewFileTree` -- только `aria-label`. Нет `role="tree"`, `role="treeitem"`, `aria-expanded`.

**Рекомендация:**
- File tree: `role="tree"`, `role="treeitem"`, `aria-expanded`, `role="group"`, arrow keys
- Tab bar: `role="tablist"`, `role="tab"`, `role="tabpanel"`, `aria-selected`

#### 17.1.8 Focus management

**Проблема:** Не описано, куда идёт фокус при открытии/закрытии overlay.

**Рекомендация:**
- Открытие: фокус на первый файл в дереве (или CM6 если таб открыт)
- Закрытие: вернуть фокус на кнопку "Open in Editor" (`returnFocusRef`)
- `inert` атрибут на фон пока overlay открыт

### 17.2 Важно, но не блокирует MVP

#### 17.2.1 Discoverability -- подсказки горячих клавиш

- `EditorEmptyState` показывает шпаргалку shortcuts
- Tooltip на кнопках toolbar: "Save (Cmd+S)"
- Кнопка `?` в header -- модальное окно со всеми шорткатами

#### 17.2.2 Пустой проект и проект с 1 файлом

- 0 файлов: "No files found. Create a new file?" + кнопка
- 1 файл: автоматически открыть в табе
- Все скрыты: "All files are in excluded directories"

#### 17.2.3 Глубокая вложенность (20+ уровней)

- Max визуальный indent: 12 уровней (`min(level, 12) * 12px`)
- Tooltip на глубоких узлах с полным путём
- `buildTree` коллапс однодетных папок

#### 17.2.4 Очень длинные имена файлов

- File tree: `truncate` + `title` tooltip
- Табы: max-width ~160px, modified dot ПЕРЕД текстом
- Breadcrumb: средние сегменты `...`

#### 17.2.5 Ошибка чтения файла (EACCES, ENOENT)

Показать: иконка AlertTriangle + текст ошибки + [Retry] + [Close Tab]

#### 17.2.6 Resizable sidebar

- Default: 240px, min 160px, max 50% viewport
- Drag handle: `cursor-col-resize`
- Persist в localStorage
- `Cmd+B` toggle sidebar

### 17.3 Nice to Have (после MVP)

| Фича | Приоритет |
|------|-----------|
| Cmd+Shift+P Command Palette (`cmdk`) | P2 |
| Split View (Cmd+\) | P3 |
| Minimap | P4 |
| Drag & Drop файлов | P4 |
| Indent guides | P2 |
| Find & Replace (Cmd+H) | P2 |
| Auto-save draft | P2 |

### 17.4 Правки к существующим секциям

1. **Секция 1.1** -- добавить: `EditorStatusBar.tsx`, `EditorBinaryState.tsx`
2. **Секция 2.1** -- добавить `hasUnsavedChanges` computed getter
3. **Секция 2.3** -- добавить `disambiguatedLabel?: string`
4. **Секция 7.2** -- добавить "Close overlay with unsaved changes" (три кнопки)
5. **Секция 9.2** -- добавить `isBinary` в `ReadFileResult`
6. **Секция 11** -- `Cmd+[/]` -> `Cmd+Shift+[/]`; добавить `Cmd+B`, `Cmd+G`
7. **Секция 14** -- обновить: ~14 файлов вместо ~12

---

## 18. Security Review

> Полный аудит безопасности. Проведён на основе анализа существующих паттернов проекта (`pathValidation.ts`, `validation.ts`, `review.ts`, `preload/index.ts`) и 8 планируемых IPC каналов editor.

### SEC-1: Path Traversal -- использовать validateFilePath (Critical)

**Уязвимость**: Каждый из 8 IPC каналов принимает путь от renderer. Скомпрометированный renderer может отправить `../../etc/passwd` или `/etc/shadow`.

**Текущий статус**: Секция 4.2 уже исправлена -- описывает `validateFilePath()` вместо кастомного `assertInsideRoot()`. Хорошо.

**Дополнительные требования**:
- Для `editor:rename` -- валидировать ОБА пути (oldPath и newPath)
- Для `editor:readDir` -- валидировать dirPath и КАЖДЫЙ обнаруженный entry
- Не доверять конструкции `path.join(projectRoot, relativePath)` без последующей проверки -- это не защищает от `path.join('/project', '/etc/passwd')` (абсолютный путь перезаписывает base)

### SEC-2: Symlink Resolution при рекурсивном обходе (Critical)

**Уязвимость**: `readDir` рекурсивно обходит директорию. Если внутри проекта symlink `./data -> /etc/`, readDir вернёт содержимое `/etc/`.

**Решение**: В `safeReadDir()` для каждого entry проверять `entry.isSymbolicLink()`. Если да -- `fs.realpath()` + `validateFilePath()` на resolved target. Молча пропускать symlinks, ведущие за пределы projectRoot.

### SEC-3: TOCTOU Race Condition (High)

**Уязвимость**: Между `validateFilePath(path)` и `fs.readFile(path)` файл может быть заменён на symlink к sensitive файлу.

**Решение**: После `fs.readFile()` повторно `fs.realpath()` + `validateFilePath()` (post-read verification). Для записи: atomic write через tmp + `rename()`. Вероятность эксплуатации в desktop-app низкая, но импакт критический.

### SEC-4: File Size DoS / Device Files (High)

**Уязвимость**: Чтение `/dev/zero` (бесконечный поток нулей) или огромных файлов. Device файлы показывают `size = 0` в stat.

**Текущий статус**: Секция 4.3 исправлена -- лимит 2MB, проверка `isFile()`, блокировка `/dev/`, `/proc/`, `/sys/`.

### SEC-5: projectRoot НЕ от renderer (High)

**Уязвимость**: Скомпрометированный renderer отправляет `projectRoot = '/'` и обходит все проверки.

**Решение**: При stateless-подходе (секция 16.3): projectRoot хранится в module-level `let activeProjectRoot` в `editor.ts`. Устанавливается через `editor:open(projectPath)` (с валидацией). IPC handlers берут rootPath из module-level state, НЕ принимают от renderer.

### SEC-6: Credential Leakage через readDir (Medium)

**Уязвимость**: `.env`, `credentials.json`, `*.key` видны в дереве. `validateFilePath()` блокирует readFile, но readDir покажет имена.

**Решение**: Показывать в дереве с визуальной пометкой (иконка замка). При клике -- "Sensitive file, cannot open in editor". Рассмотреть расширение SENSITIVE_PATTERNS: `*.p12`, `*.pfx`, `serviceAccountKey.json`.

### SEC-7: XSS через имена файлов (Medium)

**Уязвимость**: Имя `<script>alert(1)</script>.txt` безопасно в React JSX, но опасно в `document.title`, tooltip с raw HTML, или `window.open()` title.

**Решение**: Рендерить имена только через JSX `{fileName}`. При создании: `validateFileName()` в main process -- запрет control characters (`\x00-\x1f`), path separators (`/\:`), имён `.` и `..`, длины > 255.

### SEC-8: ReDoS в searchInFiles (Medium, итерация 4)

**Уязвимость**: Malicious regex `(a+)+$` вызывает catastrophic backtracking в main process.

**Решение**: Только literal string search. Если regex нужен -- `re2` engine или `worker_thread` с timeout. Лимит: max 1000 файлов, max 1MB на файл.

### SEC-9: Atomic Write (Medium)

**Решение**: Write в tmp файл (`${dir}/.tmp.${basename}.${pid}.${Date.now()}`) + `rename()`. Cleanup tmp при ошибке. `rename()` атомарен только на одном filesystem -- tmp в той же директории обязательно.

### SEC-10: editor:rename -- двойная валидация (High)

**Уязвимость**: Если валидируется только oldPath, можно переименовать файл ЗА ПРЕДЕЛЫ проекта или перезаписать чужой файл.

**Решение**: Валидировать ОБА пути через `validateFilePath()`. Проверить что newPath не существует (не перезаписывать). Валидировать новое имя файла.

### SEC-11: СУЩЕСТВУЮЩАЯ уязвимость в review.ts (Critical, existing!)

**ВНИМАНИЕ**: `handleSaveEditedFile` в `src/main/ipc/review.ts` (строка 254) принимает `filePath` от renderer и передаёт в `ReviewApplierService.saveEditedFile()` (строка 320 `ReviewApplierService.ts`), который вызывает `writeFile(filePath, content, 'utf8')` **БЕЗ КАКОЙ-ЛИБО ВАЛИДАЦИИ ПУТИ**. Скомпрометированный renderer может записать произвольный файл куда угодно в файловой системе.

**Решение**: Добавить `validateFilePath()` в `handleSaveEditedFile` ДО записи. Это нужно исправить КАК МОЖНО СКОРЕЕ, НЕЗАВИСИМО от editor-фичи, как отдельный hotfix.

### SEC-12: Запрет записи в .git/ (Medium)

**Уязвимость**: Модификация файлов в `.git/` (особенно `hooks/`, `config`) может привести к произвольному выполнению кода при `git commit/push/pull`.

**Решение**: В `ProjectFileService.writeFile/createFile/rename` -- проверка что target path не внутри `.git/` директории. Чтение `.git/` -- можно разрешить (для информации), запись -- запретить.

### SEC-13: IPC Rate Limiting (Low)

**Уязвимость**: Скомпрометированный renderer спамит IPC вызовами, вызывая disk I/O saturation.

**Решение**: Debounce на renderer (уже запланирован). На main process: простой counter -- max 100 вызовов/секунду. AbortController для отмены предыдущего readDir при новом запросе.

### Сводная таблица уязвимостей

| ID | Уязвимость | Критичность | Статус |
|----|-----------|-------------|--------|
| SEC-1 | Path traversal через IPC | Critical | Исправлено в секции 4.2 |
| SEC-2 | Symlink escape в readDir | Critical | Нужно добавить в реализацию |
| SEC-3 | TOCTOU race condition | High | Нужно добавить post-read verify |
| SEC-4 | File size / device DoS | High | Исправлено в секции 4.3 |
| SEC-5 | projectRoot от renderer | High | Нужно зафиксировать в module-level state |
| SEC-6 | Credential leakage | Medium | Частично покрыто validateFilePath |
| SEC-7 | XSS через имена файлов | Medium | React JSX покрывает, нужна validateFileName |
| SEC-8 | ReDoS в поиске | Medium | Нужно literal search, не regex |
| SEC-9 | Non-atomic write | Medium | Нужен tmp+rename |
| SEC-10 | rename двойная валидация | High | Нужно при реализации |
| SEC-11 | **review.ts без валидации** | **Critical** | **СУЩЕСТВУЮЩИЙ БАГ, нужен hotfix** |
| SEC-12 | Запись в .git/ | Medium | Нужно при реализации |
| SEC-13 | IPC rate limiting | Low | Optional |

### Чеклист для реализации каждого IPC handler

```
[ ] validateFilePath(path, projectRoot) ДО файловой операции
[ ] projectRoot из module-level state, НЕ из параметров renderer
[ ] fs.lstat() + isFile()/isDirectory() перед чтением
[ ] stats.size <= MAX_FILE_SIZE (2MB) перед чтением
[ ] Buffer.byteLength(content) <= MAX_WRITE_SIZE (2MB) перед записью
[ ] Для rename: ОБА пути валидируются
[ ] Для readDir: каждый entry + symlinks проверяются
[ ] validateFileName() при создании файлов
[ ] Логирование через createLogger('IPC:editor')
[ ] Обёртка в wrapHandler -> IpcResult<T>
[ ] Device paths (/dev/, /proc/, /sys/) блокируются
[ ] Запись в .git/ запрещена
[ ] Post-read realpath verify (TOCTOU mitigation)
```

---

## 19. Performance Review

> Аудит производительности по 9 направлениям. Основан на анализе реального кода: CodeMirrorDiffView.tsx (EditorView lifecycle, initialState, langCompartment), MembersJsonEditor.tsx (CM6 create/destroy), FileWatcher.ts (fs.watch patterns), changeReviewSlice.ts (file content caching), virtual scrolling в DateGroupedSessions/ChatHistory/NotificationsView.

---

### 19.1 Memory Leaks -- EditorView lifecycle (Impact: CRITICAL)

**Проблема:** План (секция 6.5) предлагает `Map<tabId, EditorView>` + CSS show/hide (`display: none/block`). При 20+ табах это 20 живых EditorView в DOM:
- DocumentTree ~2x размер файла
- DOM MutationObserver, ResizeObserver, event listeners на каждом
- Incremental parse tree языкового парсера
- 1MB файл = ~15-25MB RAM на EditorView
- 20 табов x 500KB = ~400-500MB RAM

**В проекте сейчас:** CodeMirrorDiffView.tsx (строки 694-717) корректно вызывает `view.destroy()` в cleanup. MembersJsonEditor.tsx (строки 68-71) аналогично. Оба пересоздают EditorView, НЕ скрывают.

**Решение (ОБЯЗАТЕЛЬНАЯ замена):** EditorState pooling + single EditorView:
```
1. Map<tabId, EditorState> в useRef (НЕ EditorView, НЕ Zustand)
2. Один активный EditorView на весь редактор
3. Переключение таба:
   a. savedStates.set(oldTabId, view.state)  // undo, cursor, selection
   b. currentView.destroy()
   c. new EditorView({ state: savedStates.get(newTabId), parent: container })
4. Закрытие таба: savedStates.delete(tabId)
5. Паттерн initialState уже есть в CodeMirrorDiffView (строка 699-705)
```

Память: EditorState ~1.5x документа (JS only) vs EditorView ~10-15x (DOM). Экономия ~8-12x.

LRU при >30 states: вытеснять oldest, сохраняя `doc.toString()` + cursor (без undo).

**Benchmark:** 25 файлов x 200KB. `performance.memory.usedJSHeapSize`: CSS hide ~500MB vs pooling ~80-120MB.

---

### 19.2 CSS show/hide vs re-mount (Impact: CRITICAL)

**Проблема (секция 6.5):** "show/hide через CSS" -- неправильно:
- 20 EditorView = огромный DOM tree
- `display: none` НЕ отключает observers
- requestMeasure() продолжает вызываться
- При `display: block` -- пересчёт высот строк (LAG)

Re-mount из EditorState: 100KB файл ~3-5ms, undo сохраняется, scroll восстанавливается через `EditorView.scrollIntoView(pos)`.

**Решение:** Заменить секцию 6.5:
```
1. Один EditorView, один DOM-контейнер, один активный файл
2. Map<tabId, EditorState> в useRef
3. save state -> destroy -> new view from saved state
4. Dirty flag через debounced updateListener (300ms)
5. LRU eviction при > 30 states
```

---

### 19.3 IPC Bottlenecks -- readDir/readFile (Impact: HIGH)

**Проблема:** readDir 10,000+ файлов: JSON 500KB-2MB, main thread 50-200ms. readFile 5MB: structured clone ~30-100ms.

**A. readDir -- усиленный lazy loading:**
- Только root level при открытии
- expand -> readDir(path, depth=1)
- MAX_ENTRIES_PER_DIR = 500 (не 10,000)
- \>500: "N more files..." + "Show all"
- Prefetch при hover (debounced 200ms)

**B. readFile -- тиерная стратегия:**
- <256KB: мгновенно
- 256KB-2MB: progress indicator
- 2MB-5MB: preview (100 строк + warning)
- \>5MB: external editor (shell:openPath)

**C. Main process:** AbortSignal, concurrency limit=3, дедупликация.

**Benchmark:** 5000 файлов -> дерево < 200ms.

---

### 19.4 React Re-renders -- keystroke storm (Impact: HIGH)

**Проблема:** `editorModifiedContents: Record<string, string>` -- каждый keystroke -> set() -> новый объект -> все подписчики рендерятся.

**Решение -- НЕ хранить content в Zustand:**
```
// Контент ТОЛЬКО в EditorState CodeMirror
// Zustand: editorModifiedFiles: Set<string>  // только dirty flags
// save: savedEditorStates.get(path)?.doc.toString()
```

0 keystroke re-renders. Dirty flag debounced 300ms (паттерн из CodeMirrorDiffView строки 517-527).

Гранулярные селекторы:
```typescript
const tabList = useStore(s => s.editorOpenTabs, shallow);
const activeId = useStore(s => s.editorActiveTabId);
```

**Benchmark:** React DevTools Profiler. FileTreePanel/TabBar НЕ рендерятся при наборе.

---

### 19.5 File Tree -- виртуализация (Impact: HIGH)

**Проблема:** 5000+ рекурсивных FileTreeNode = 200-500ms render.

**Фаза 1 (итерации 1-2):** Lazy loading + MAX_VISIBLE_NODES=1000 + auto-collapse.

**Фаза 2 (итерация 4):** @tanstack/react-virtual (уже в проекте -- DateGroupedSessions, ChatHistory, NotificationsView):
```
flattenTree(tree, expandedDirs) -> FlatNode[]
useVirtualizer({ count, estimateSize: () => 28 })
```

**Benchmark:** lodash src, все папки раскрыты. FPS скролла через Chrome DevTools.

---

### 19.6 Large Files -- минификация (Impact: MEDIUM)

CM6 virtual scrolling по СТРОКАМ. Одна строка 1MB = один DOM-элемент = LAG.

**Трёхуровневая защита:**
```
Размер: <500KB полный | 500KB-2MB без syntax | 2MB-5MB read-only | >5MB external
Строки: >10,000 chars -> banner "Minified" + Pretty-print/lineWrapping
Binary: null bytes в первых 8KB или расширение (.png, .wasm)
```

---

### 19.7 Concurrent Operations (Impact: MEDIUM)

10 быстрых кликов = 10 параллельных readFile.

**Решение:** Дедупликация через `Map<string, Promise>` + concurrency limit=3 в main process.

---

### 19.8 File Watcher (Impact: MEDIUM)

Проект использует `fs.watch({ recursive: true })`, не chokidar. Electron 40/Node 20+ OK.

**Решение:** fs.watch + фильтр (node_modules/.git/dist) + debounce 200ms + **opt-in** (ручной F5 по умолчанию) + cleanup.

---

### 19.9 Bundle Size (Impact: LOW)

Все CM6 пакеты установлены. Нужен только `@codemirror/search` (~15KB gzipped). Незначительно.

---

### Сводная таблица

| # | Проблема | Impact | Итерация | Статус в плане |
|---|---------|--------|----------|---------------|
| 19.1 | EditorView memory 20+ табов | **CRITICAL** | 1 | НЕВЕРНО -- EditorState pooling |
| 19.2 | CSS show/hide vs re-mount | **CRITICAL** | 1 | НЕВЕРНО -- single EditorView |
| 19.3 | IPC readDir/readFile | **HIGH** | 1 | Частично -- тиеры + очередь |
| 19.4 | Zustand keystroke re-renders | **HIGH** | 2 | НЕ покрыт -- content вне store |
| 19.5 | FileTree без виртуализации | **HIGH** | 4 | НЕ покрыт -- react-virtual |
| 19.6 | Минификация/длинные строки | **MEDIUM** | 1 | Частично -- 3 уровня |
| 19.7 | Concurrent readFile | **MEDIUM** | 1 | НЕ покрыт -- дедупликация |
| 19.8 | fs.watch overhead | **MEDIUM** | 5 | OK, но opt-in |
| 19.9 | Bundle size | **LOW** | 1 | OK |

---
