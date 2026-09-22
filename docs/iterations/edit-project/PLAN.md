# In-App Code Editor -- Финальный план

## Обзор

На странице `TeamDetailView` рядом с путём проекта (`data.config.projectPath`) добавляется кнопка "Open in Editor", открывающая полноэкранный редактор кода прямо внутри приложения. Редактор позволяет просматривать файловое дерево проекта, открывать файлы во вкладках с подсветкой синтаксиса, редактировать и сохранять их, создавать/удалять файлы, искать по содержимому, и отображать git-статусы.

### Tech Stack

- **Editor engine**: CodeMirror 6 (20+ пакетов `@codemirror/*` уже в `package.json`, 16 языковых пакетов)
- **Не ProseMirror**: ProseMirror -- rich-text WYSIWYG, CodeMirror -- код-редактор. Один автор (Marijn Haverbeke), CM6 уже глубоко интегрирован
- **UI**: React 18, Tailwind CSS, lucide-react иконки, Radix UI (контекстное меню, confirm dialog)
- **State**: Zustand slice (`editorSlice.ts`)
- **Виртуализация**: `@tanstack/react-virtual` (уже в проекте)
- **Fuzzy search**: `cmdk` v1.0.4 (уже в зависимостях)
- **Новые npm-зависимости**: `@codemirror/search` (~15KB gzipped) — для встроенного Cmd+F поиска в файле. Остальное уже установлено

### Ключевые архитектурные решения

| Решение | Обоснование |
|---------|-------------|
| `ProjectFileService` (не `FileEditorService`) | Лучше отражает scope; аналог `TeamDataService` |
| Stateless сервис (без `rootPath` в конструкторе) | Каждый метод принимает `projectRoot`; не привязан к одному проекту |
| EditorState pooling (не CSS show/hide) | Один EditorView + `Map<tabId, EditorState>` в useRef; экономия RAM ~8-12x |
| `editorModifiedFiles: Set<string>` (не `Record<string, string>`) | Контент живёт только в CM6 EditorState; 0 re-render при наборе текста |
| `validateFilePath()` из `pathValidation.ts` (не свой `assertInsideRoot`) | Уже проверяет traversal, symlinks, sensitive patterns, cross-platform |
| `projectRoot` в module-level state (не от renderer) | Фиксируется при `editor:open`; IPC handlers берут из state |
| Overlay вместо Radix Dialog | Radix Dialog ограничивает фокус, конфликтует с CM6 |

---

## Архитектура

### Архитектурная диаграмма

```
                     ┌─────────────────────────────────────────────┐
                     │            TeamDetailView.tsx                │
                     │  [FolderOpen icon] [Edit button] ◄──────────┤ Кнопка запуска
                     └──────────────────┬──────────────────────────┘
                                        │ open={true}
                     ┌──────────────────▼──────────────────────────┐
                     │     ProjectEditorOverlay (fixed inset-0)     │
                     │  ┌──────────────┐  ┌──────────────────────┐ │
                     │  │ EditorFile-  │  │  EditorTabBar        │ │
                     │  │  Tree        │  │  ┌────────────────┐  │ │
                     │  │  (generic    │  │  │ CodeMirrorEditor│  │ │
                     │  │   FileTree   │  │  │ (single View,  │  │ │
                     │  │   + render-  │  │  │  pooled States) │  │ │
                     │  │   props)     │  │  └────────────────┘  │ │
                     │  └──────────────┘  │  EditorStatusBar     │ │
                     │                    └──────────────────────┘ │
                     └──────────────────┬──────────────────────────┘
                                        │ IPC (invokeIpcWithResult)
                     ┌──────────────────▼──────────────────────────┐
                     │           Preload Bridge                     │
                     │  editor: { readDir, readFile, writeFile,     │
                     │           createFile, deleteFile, createDir,  │
                     │           searchInFiles, gitStatus }          │
                     └──────────────────┬──────────────────────────┘
                                        │
                     ┌──────────────────▼──────────────────────────┐
                     │   Main Process: editor.ts (IPC handlers)     │
                     │   activeProjectRoot (module-level state)     │
                     │   wrapHandler() из ipcWrapper.ts             │
                     │                                              │
                     │   ┌────────────────────────────────────┐    │
                     │   │ ProjectFileService (stateless)      │    │
                     │   │ validateFilePath() на КАЖДЫЙ вызов  │    │
                     │   │ fs.readdir / readFile / writeFile    │    │
                     │   │ atomic write (tmp + rename)          │    │
                     │   └────────────────────────────────────┘    │
                     │   ┌────────────────────────────────────┐    │
                     │   │ FileSearchService (итерация 4)      │    │
                     │   │ GitStatusService (итерация 5)       │    │
                     │   │ EditorFileWatcher (итерация 5)      │    │
                     │   └────────────────────────────────────┘    │
                     └─────────────────────────────────────────────┘
```

### Компонентная иерархия

```
src/renderer/components/team/editor/
├── ProjectEditorOverlay.tsx     # Полноэкранный overlay (max 150 LOC)
├── EditorFileTree.tsx           # Обёртка над generic FileTree (max 200 LOC)
├── EditorTabBar.tsx             # Панель вкладок (max 100 LOC)
├── CodeMirrorEditor.tsx         # CM6 wrapper: lifecycle + EditorState pooling (max 150 LOC)
├── EditorToolbar.tsx            # Save, Undo, Redo, язык (max 100 LOC)
├── EditorStatusBar.tsx          # Ln:Col, язык, отступы, кодировка (max 80 LOC)
├── EditorContextMenu.tsx        # Context menu для дерева файлов (итерация 3)
├── NewFileDialog.tsx            # Inline-input для имени нового файла (итерация 3)
├── QuickOpenDialog.tsx          # Cmd+P fuzzy search (итерация 4)
├── SearchInFilesPanel.tsx       # Cmd+Shift+F результаты (итерация 4)
├── EditorBreadcrumb.tsx         # Breadcrumb навигация (итерация 4)
├── EditorEmptyState.tsx         # Нет открытых файлов + shortcuts шпаргалка
├── EditorBinaryState.tsx        # Заглушка для бинарных файлов
├── EditorErrorState.tsx         # Заглушка для ошибок чтения (EACCES, ENOENT)
├── EditorShortcutsHelp.tsx      # Модальное окно shortcuts (кнопка ?)
└── GitStatusBadge.tsx           # M/U/A бейджи в дереве (итерация 5)

src/renderer/components/common/
└── FileTree.tsx                 # Generic FileTree<T> с render-props (рефакторинг из ReviewFileTree)
```

### Слои и направление зависимостей

```
shared/types/editor.ts (чистые типы, zero deps)
  <- main/services/editor/ (зависит от fs, path, shared/types)
  <- main/ipc/editor.ts (зависит от service + shared types)
  <- preload/index.ts (зависит от ipcChannels)
  <- renderer/store/ (зависит от api layer + shared types)
  <- renderer/components/ (зависит от store + utils)
```

Обратных зависимостей нет. Каждый слой зависит только от нижнего.

---

## Безопасность

Каждый IPC handler, работающий с файловой системой, ОБЯЗАН выполнять полный набор проверок. Ниже -- чеклист для каждого handler и описание конкретных уязвимостей.

### Обязательный чеклист для каждого IPC handler

```
[ ] projectRoot из module-level state, НЕ из параметров renderer (SEC-5)
[ ] validateFilePath(path, projectRoot) ДО файловой операции (SEC-1) — кроме readDir (см. ниже)
[ ] Для WRITE-операций (writeFile, createFile, createDir, deleteFile): ДОПОЛНИТЕЛЬНО проверить `isPathWithinRoot(normalizedPath, activeProjectRoot)` ПОСЛЕ `validateFilePath()`. Причина: `validateFilePath()` считает `~/.claude` разрешённой директорией (для read-use-case review.ts), но editor НЕ должен записывать за пределы проекта (SEC-14)
[ ] Для readDir: containment через `isPathWithinAllowedDirectories()`, НЕ `validateFilePath()`. Sensitive файлы помечаются `isSensitive: true`, но НЕ фильтруются. Symlinks: `realpath()` + re-check containment (SEC-2, SEC-6)
[ ] fs.lstat() + isFile()/isDirectory() перед чтением (SEC-4)
[ ] stats.size <= MAX_FILE_SIZE_FULL (2MB) для полной загрузки; <= MAX_FILE_SIZE_PREVIEW (5MB) для preview (SEC-4)
[ ] Buffer.byteLength(content) <= MAX_WRITE_SIZE (2MB) перед записью
[ ] Device paths (/dev/, /proc/, /sys/) блокируются (SEC-4)
[ ] Запись в .git/ запрещена (SEC-12)
[ ] Post-read realpath verify -- TOCTOU mitigation (SEC-3)
[ ] Atomic write через tmp + rename (SEC-9)
[ ] Для rename (если добавлен): ОБА пути валидируются (SEC-10) -- НЕ в MVP
[ ] validateFileName() при создании файлов (SEC-7)
[ ] Только literal search в searchInFiles, НЕ regex (SEC-8)
[ ] Логирование через createLogger('IPC:editor')
[ ] Обёртка в wrapHandler -> IpcResult<T>
```

### Конкретные уязвимости и их решения

| ID | Уязвимость | Критичность | Решение |
|----|-----------|-------------|---------|
| SEC-1 | Path traversal через IPC | Critical | `validateFilePath()` из `pathValidation.ts` на каждом handler. Для `rename` -- оба пути |
| SEC-2 | Symlink escape в readDir | Critical | `entry.isSymbolicLink()` -> `fs.realpath()` -> `validateFilePath()`. Молча пропускать symlinks за пределами |
| SEC-3 | TOCTOU race condition | High | Post-read: `fs.realpath()` + повторная `validateFilePath()`. Write: atomic tmp + rename |
| SEC-4 | File size / device DoS | High | `fs.lstat()` + `isFile()` до чтения. Block `/dev/`, `/proc/`, `/sys/`. Лимит 2MB |
| SEC-5 | projectRoot от renderer | High | Module-level `let activeProjectRoot` в `editor.ts`. Устанавливается через `editor:open` |
| SEC-6 | Credential leakage | Medium | `validateFilePath()` блокирует read. В дереве: иконка замка, "Sensitive file" при клике |
| SEC-7 | XSS через имена файлов | Medium | React JSX экранирует. `validateFileName()` при создании: запрет control chars, path separators, NUL, `..`, длина > 255 |
| SEC-8 | ReDoS в searchInFiles | Medium | Только literal string search. Max 1000 файлов, max 1MB на файл |
| SEC-9 | Non-atomic write | Medium | Переиспользовать `atomicWriteAsync()` из `team/atomicWrite.ts` (randomUUID, fsync, EXDEV fallback, mkdir). Перемещается в `src/main/utils/atomicWrite.ts` |
| SEC-10 | rename двойная валидация | High | Валидировать оба пути + проверить что newPath не существует. **НЕ в MVP** -- rename убран из ProjectFileService |
| SEC-12 | Запись в .git/ | Medium | Проверка `isGitInternalPath()` в writeFile/createFile/rename |
| SEC-13 | IPC rate limiting | Low | Debounce на renderer + max 100 вызовов/секунду на main. AbortController |
| SEC-14 | `validateFilePath()` allows `~/.claude` writes | High | `validateFilePath()` считает `~/.claude/**` разрешённой директорией (линия 112: `isPathWithinRoot(target, claudeDir) → true`). Для read — ОК (review.ts). Для editor write — НЕТ: без дополнительной проверки editor может перезаписать `~/.claude/settings.json`, `teams/*/config.json` и др. Решение: в КАЖДОМ write-handler ПОСЛЕ `validateFilePath()` добавить `isPathWithinRoot(validation.normalizedPath!, activeProjectRoot)`. Если false — throw |
| SEC-15 | `editor:open` projectPath validation | Medium | `editor:open` принимает `projectPath` от renderer без валидации. Злонамеренный renderer может передать `"/"`, делая все пути валидными. Решение: validate при `editor:open` — `path.isAbsolute()`, `fs.stat().isDirectory()`, `!== '/'`, `!isPathWithinRoot(path, claudeDir)` |

### SEC-11: ИСПРАВЛЕНО (hotfix применён)

`handleSaveEditedFile` в `src/main/ipc/review.ts` ранее принимал `filePath` от renderer без валидации. **Hotfix уже применён**: добавлен `validateFilePath(filePath, null)` с проверкой перед записью, блокировкой недопустимых путей и логированием отказов. Патч также инвалидирует кеш `FileContentResolver` после сохранения.

### Новые security-утилиты (добавить в `src/main/utils/`)

| Утилита | Файл | Назначение |
|---------|------|------------|
| `validateFileName(name)` | `pathValidation.ts` | Запрет `.`, `..`, control chars, path separators, NUL, length > 255 |
| `isDevicePath(path)` | `pathValidation.ts` | Проверка `/dev/`, `/proc/`, `/sys/`, `\\\\.\\` |
| `isGitInternalPath(path)` | `pathValidation.ts` | Проверка `.git/` в пути (запрет записи, не чтения) |
| `atomicWriteAsync(path, content)` | `atomicWrite.ts` | **Перемещение** из `src/main/services/team/atomicWrite.ts` — НЕ писать заново. Уже имеет randomUUID, fsync, EXDEV fallback |

### Паттерн IPC handler (обязательный)

```typescript
// src/main/ipc/editor.ts
let activeProjectRoot: string | null = null;

async function handleEditorReadFile(
  _event: IpcMainInvokeEvent,
  filePath: string
): Promise<IpcResult<ReadFileResult>> {
  return wrapHandler('readFile', async () => {
    if (!activeProjectRoot) throw new Error('Editor not initialized');

    // 1. Path validation (traversal, sensitive, symlink)
    const validation = validateFilePath(filePath, activeProjectRoot);
    if (!validation.valid) throw new Error(validation.error!);

    // 1b. Project-only containment (SEC-14: block ~/.claude writes)
    // ОБЯЗАТЕЛЬНО для write-handlers (writeFile, createFile, createDir, deleteFile)
    // Для read-handlers (readFile, readDir) — не нужно (validateFilePath достаточно)
    // if (!isPathWithinRoot(validation.normalizedPath!, activeProjectRoot)) {
    //   throw new Error('Path is outside project root');
    // }

    // 2. Device path block
    if (isDevicePath(validation.normalizedPath!)) throw new Error('Device files blocked');

    // 3. File type check
    const stats = await fs.lstat(validation.normalizedPath!);
    if (!stats.isFile()) throw new Error('Not a regular file');

    // 4. Size check
    if (stats.size > MAX_FILE_SIZE) throw new Error('File too large');

    // 5. Binary check
    const isBinary = await detectBinary(validation.normalizedPath!);

    // 6. Read
    const content = isBinary ? '' : await fs.readFile(validation.normalizedPath!, 'utf8');

    // 7. Post-read TOCTOU verify
    const realPath = await fs.realpath(validation.normalizedPath!);
    const postValidation = validateFilePath(realPath, activeProjectRoot);
    if (!postValidation.valid) throw new Error('Path changed during read');

    return { content, size: stats.size, truncated: false, encoding: 'utf-8', isBinary };
  });
}
```

---

## State Management

### Zustand slice: `editorSlice.ts`

Минимальный slice с Группой 1 создаётся на итерации 1. Группы 2-4 добавляются на итерациях 2-3.

Slice разбит на 4 логические группы:

```typescript
export interface EditorSlice {
  // ═══════════════════════════════════════════════════
  // Группа 1: File tree state + actions
  // ═══════════════════════════════════════════════════
  editorProjectPath: string | null;
  editorFileTree: FileTreeEntry | null;
  editorFileTreeLoading: boolean;
  editorFileTreeError: string | null;

  openEditor: (projectPath: string) => Promise<void>;
  closeEditor: () => void;
  // closeEditor() выполняет полный cleanup:
  //   try {
  //     1. IPC editor:close → сброс activeProjectRoot + остановка watcher (best-effort)
  //   } catch (e) { console.error('editor:close failed', e); }
  //   finally {
  //     // ВСЕГДА выполняется, даже если IPC упал:
  //     2. stateCache.current.clear() — освободить все EditorState из Map
  //     3. scrollTopCache.current.clear() — освободить scroll positions
  //     4. viewRef.current?.destroy() — уничтожить активный EditorView
  //     5. Сброс slice state: tabs=[], tree=null, modified=Set(), loading={}, errors={}
  //   }
  loadFileTree: (dirPath: string) => Promise<void>;
  expandDirectory: (dirPath: string) => Promise<void>;

  // ═══════════════════════════════════════════════════
  // Группа 2: Tab management
  // ═══════════════════════════════════════════════════
  editorOpenTabs: EditorFileTab[];
  editorActiveTabId: string | null;

  openFile: (filePath: string) => Promise<void>;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;

  // ═══════════════════════════════════════════════════
  // Группа 3: Content + Save
  // ВАЖНО: Контент НЕ хранится в store!
  // Контент живёт в EditorState (Map<tabId, EditorState> в useRef).
  // В store -- только dirty flags, loading и статусы сохранения.
  // ═══════════════════════════════════════════════════
  editorFileLoading: Record<string, boolean>;  // per-file loading indicator
  editorModifiedFiles: Set<string>;      // dirty markers (НЕ содержимое!)
  editorSaving: Record<string, boolean>;
  editorSaveError: Record<string, string>;

  markFileModified: (filePath: string) => void;    // debounced, 300ms
  markFileSaved: (filePath: string) => void;
  saveFile: (filePath: string, content: string) => Promise<void>;
  // Компонент CodeMirrorEditor вызывает: saveFile(filePath, viewRef.current.state.doc.toString())
  // Store НЕ обращается к useRef — контент передаётся как аргумент при вызове
  saveAllFiles: (getContent: (filePath: string) => string | null) => Promise<void>;
  // CodeMirrorEditor передаёт callback: saveAllFiles((fp) => stateCache.current.get(fp)?.doc.toString() ?? null)
  discardChanges: (filePath: string) => void;
  hasUnsavedChanges: () => boolean;                 // derived getter

  // ═══════════════════════════════════════════════════
  // Группа 4: File operations (итерация 3)
  // ═══════════════════════════════════════════════════
  createFile: (parentDir: string, name: string) => Promise<void>;
  deleteFile: (filePath: string) => Promise<void>;
  createDirectory: (parentDir: string, name: string) => Promise<void>;
}
```

### EditorFileTab

```typescript
interface EditorFileTab {
  id: string;                      // = filePath (уникальный ключ)
  filePath: string;                // Абсолютный путь
  fileName: string;                // Имя файла для отображения
  disambiguatedLabel?: string;     // "(main/utils)" для дублей
  language: string;                // Определяется по расширению
}
```

### EditorState pooling (Map в useRef)

Контент файлов живёт ТОЛЬКО в CodeMirror EditorState. Один активный EditorView на весь редактор.

```typescript
// CodeMirrorEditor.tsx
const stateCache = useRef(new Map<string, EditorState>());
const scrollTopCache = useRef(new Map<string, number>());  // scroll position per tab
const viewRef = useRef<EditorView | null>(null);

// Переключение таба:
function switchTab(oldTabId: string, newTabId: string) {
  // 1. Сохранить state + scroll текущего таба
  if (viewRef.current) {
    stateCache.current.set(oldTabId, viewRef.current.state);
    scrollTopCache.current.set(oldTabId, viewRef.current.scrollDOM.scrollTop);
    viewRef.current.destroy();
  }
  // 2. Восстановить или создать state нового таба
  const existingState = stateCache.current.get(newTabId);
  viewRef.current = new EditorView({
    state: existingState ?? EditorState.create({ doc: content, extensions }),
    parent: containerRef.current!,
  });
  // 3. Восстановить scroll position (EditorState не хранит scrollTop — это свойство DOM)
  const savedScrollTop = scrollTopCache.current.get(newTabId);
  if (savedScrollTop !== undefined) {
    requestAnimationFrame(() => {
      viewRef.current?.scrollDOM.scrollTop = savedScrollTop;
    });
  }
}

// LRU eviction при > 30 states:
if (stateCache.current.size > 30) {
  // Вытеснить oldest, сохранив { content: doc.toString(), cursorPos }
  // При возврате -- восстановить через EditorState.create()
}
```

### Что в store vs что в local state

| Данные | Где хранить | Почему |
|--------|-------------|--------|
| Дерево файлов, табы, dirty flags | Zustand store | Переживает перемонтирование overlay |
| Содержимое файлов | EditorState (useRef Map) | Без re-render при наборе |
| Scroll position, resize panels | useState | Локальное UI-состояние |
| Контекстное меню state | useState | Эфемерное |
| Поисковый запрос в дереве | useState | Локальное |
| expandedDirs | Zustand store | Сохраняется при re-open |
| Sidebar width | localStorage | Persist между сессиями |

### Гранулярные Zustand-селекторы (обязательно)

```typescript
// Каждый компонент подписывается ТОЛЬКО на свои данные:
const tabList = useStore(s => s.editorOpenTabs, shallow);     // TabBar
const activeId = useStore(s => s.editorActiveTabId);           // CodeMirrorEditor
const treeLoading = useStore(s => s.editorFileTreeLoading);    // FileTreePanel

// FileTreePanel НЕ подписывается на tabs/content
// TabBar НЕ подписывается на tree state
// CodeMirrorEditor НЕ подписывается на tree/tabs
```

---

## IPC API

### Полная таблица каналов

| Канал | Итерация | Направление | Типы запроса/ответа | Описание |
|-------|----------|-------------|---------------------|----------|
| `editor:open` | 1 | renderer -> main | `(projectPath: string)` -> `IpcResult<void>` | Инициализировать editor, установить activeProjectRoot. **Валидация projectPath (SEC-15)**: `path.isAbsolute()`, `fs.stat().isDirectory()`, `!== '/'`/`'C:\\'`, `!isPathWithinRoot(path, claudeDir)` |
| `editor:close` | 1 | renderer -> main | `()` -> `IpcResult<void>` | Cleanup: сбросить activeProjectRoot, остановить watcher (если запущен) |
| `editor:readDir` | 1 | renderer -> main | `(dirPath: string, maxEntries?: number)` -> `IpcResult<ReadDirResult>` | Чтение директории (depth=1, lazy). Default `maxEntries=500`. "Show all" вызывает с `maxEntries=10000` |
| `editor:readFile` | 1 | renderer -> main | `(filePath: string)` -> `IpcResult<ReadFileResult>` | Чтение файла с binary detection |
| `editor:writeFile` | 2 | renderer -> main | `(filePath: string, content: string)` -> `IpcResult<void>` | Atomic write (tmp + rename) |
| `editor:createFile` | 3 | renderer -> main | `(parentDir: string, name: string, content?: string)` -> `IpcResult<void>` | Создание файла с validateFileName |
| `editor:createDir` | 3 | renderer -> main | `(parentDir: string, name: string)` -> `IpcResult<void>` | Создание директории |
| `editor:deleteFile` | 3 | renderer -> main | `(filePath: string)` -> `IpcResult<void>` | Удаление через shell.trashItem() |
| `editor:searchInFiles` | 4 | renderer -> main | `(query: string, options?: { caseSensitive?: boolean })` -> `IpcResult<SearchResult[]>` | Literal search, default case-insensitive (как SessionSearcher), max 100 results. Кнопка "Aa" в UI для toggle |
| `editor:gitStatus` | 5 | renderer -> main | `()` -> `IpcResult<GitFileStatus[]>` | git status --porcelain, кеш 5 сек |
| `editor:watchDir` | 5 | renderer -> main | `()` -> `IpcResult<void>` | Запуск file watcher |
| `editor:change` | 5 | main -> renderer | event: `EditorFileChangeEvent` | Файл изменился на диске |

### Типы (src/shared/types/editor.ts)

```typescript
interface FileTreeEntry {
  name: string;
  path: string;              // Абсолютный путь
  type: 'file' | 'directory';
  size?: number;             // Только для файлов
  isSensitive?: boolean;     // true для .env, .key, credentials и т.д. — показывать с замком
  children?: FileTreeEntry[];
}

interface ReadDirResult {
  entries: FileTreeEntry[];
  truncated: boolean;        // > MAX_DIR_ENTRIES
}

interface ReadFileResult {
  content: string;
  size: number;
  mtimeMs: number;           // Unix timestamp (stats.mtimeMs) — baseline для conflict detection (итерация 5)
  truncated: boolean;
  encoding: string;
  isBinary: boolean;
}

interface GitFileStatus {
  path: string;
  status: 'modified' | 'untracked' | 'staged' | 'deleted';
}

interface SearchResult {
  filePath: string;
  line: number;
  column: number;
  lineContent: string;
  matchLength: number;
}

interface EditorFileChangeEvent {
  type: 'change' | 'delete' | 'create';
  path: string;
}
```

### API транспорт

Editor API доступен ТОЛЬКО через Electron IPC (`window.electronAPI.editor.*`). HTTP/REST endpoint НЕ требуется -- приложение не имеет standalone browser-режима. Все вызовы проходят через preload bridge (`invokeIpcWithResult`), который автоматически разворачивает `IpcResult<T>`.

### Дедупликация IPC-запросов

`Map<string, Promise<ReadFileResult>>` в renderer. Если файл уже загружается -- ждать результат, не создавать новый запрос. Invalidate при save.

---

## Main Process: ProjectFileService

Файл: `src/main/services/editor/ProjectFileService.ts`

Stateless сервис. Каждый метод принимает `projectRoot` как первый аргумент. Паттерн аналогичен `TeamDataService`.

```typescript
class ProjectFileService {
  // НЕТ конструктора с rootPath
  // Создаётся в module-scope editor.ts (паттерн reviewDecisionStore в review.ts)

  async readDir(projectRoot: string, dirPath: string, depth?: number, maxEntries?: number): Promise<ReadDirResult>
  async readFile(projectRoot: string, filePath: string): Promise<ReadFileResult>
  async writeFile(projectRoot: string, filePath: string, content: string): Promise<void>
  async createFile(projectRoot: string, parentDir: string, name: string, content?: string): Promise<void>
  async deleteFile(projectRoot: string, filePath: string): Promise<void>
  async createDir(projectRoot: string, parentDir: string, name: string): Promise<void>
  async fileExists(projectRoot: string, filePath: string): Promise<boolean>
}
```

### Файловые лимиты и константы

```typescript
const MAX_FILE_SIZE_FULL = 2 * 1024 * 1024;  // 2 MB -- полная загрузка в CM6
const MAX_FILE_SIZE_PREVIEW = 5 * 1024 * 1024; // 5 MB -- preview (100 строк)
const MAX_WRITE_SIZE = 2 * 1024 * 1024;     // 2 MB
const MAX_DIR_ENTRIES = 500;                  // Per directory (не 10,000!)
const MAX_DIR_DEPTH = 15;
const MAX_FILENAME_LENGTH = 255;
const MAX_PATH_LENGTH = 4096;

const IGNORED_DIRS = ['.git', 'node_modules', '.next', 'dist', '__pycache__', '.cache', '.venv', '.tox', 'vendor'];
const IGNORED_FILES = ['.DS_Store', 'Thumbs.db'];
const BLOCKED_PATHS = ['/dev/', '/proc/', '/sys/', '\\\\.\\'];
```

### Тиерная стратегия readFile

| Размер | Поведение | Константа |
|--------|-----------|-----------|
| < 256 KB | Мгновенная загрузка, полный контент в CM6 | -- |
| 256 KB -- 2 MB | Progress indicator, полный контент в CM6 | `MAX_FILE_SIZE_FULL` |
| 2 MB -- 5 MB | Preview only (первые 100 строк) + warning banner "File too large for editing" | `MAX_FILE_SIZE_PREVIEW` |
| > 5 MB | Предложить открыть в external editor (`shell:openPath`), контент НЕ читается | -- |

Для preview-режима (2-5 MB): `readFile` возвращает `{ content: first100Lines, truncated: true, ... }`. CM6 открывается в `readOnly` режиме.

Дополнительно: детектировать минификацию (строка > 10,000 chars) -- banner "Minified" + предложение line wrapping. Binary detection: null bytes в первых 8KB или расширение (.png, .wasm, .jpg, .zip и т.д.).

### Atomic write

**Переиспользовать существующий `atomicWriteAsync()`** из `src/main/services/team/atomicWrite.ts` (НЕ писать новый). Он надёжнее:
- `randomUUID()` для tmp-имён (vs `pid.Date.now()` — менее уникально)
- `fsync()` (best-effort) для durability
- `EXDEV` fallback (cross-filesystem: `copyFile` + `unlink`)
- `mkdir({ recursive: true })` для безопасности

**Рефакторинг**: переместить `atomicWriteAsync()` из `src/main/services/team/atomicWrite.ts` в `src/main/utils/atomicWrite.ts` (shared utility). Обновить все импорты в team-сервисах (TeamTaskWriter, TeamDataService, TeamKanbanManager и др.). Или, при высоком blast radius, просто импортировать из `team/atomicWrite.ts` напрямую (допустимый cross-domain import для общей утилиты).

```typescript
// src/main/utils/atomicWrite.ts (перемещено из team/atomicWrite.ts)
// Используется в: ProjectFileService.writeFile(), TeamTaskWriter, TeamDataService, ...
import { atomicWriteAsync } from '@main/utils/atomicWrite';
```

### Регистрация в handlers.ts

`ProjectFileService` создаётся в module-scope внутри `editor.ts` (паттерн `reviewDecisionStore` в review.ts:55). НЕ передаётся через `initializeIpcHandlers()` — его сигнатура уже имеет 15+ параметров.

```typescript
// src/main/ipc/editor.ts (module-level)
const projectFileService = new ProjectFileService();

// src/main/ipc/handlers.ts — добавить 3 вызова:
import { initializeEditorHandlers, registerEditorHandlers, removeEditorHandlers } from './editor';

// В initializeIpcHandlers():
initializeEditorHandlers();   // без аргументов — сервис в module scope editor.ts

// В registerXxx блок:
registerEditorHandlers(ipcMain);

// В removeIpcHandlers():
removeEditorHandlers(ipcMain);
```

---

## Компоненты

### ProjectEditorOverlay.tsx (max 150 LOC)

**Ответственность**: Layout shell -- `fixed inset-0 z-50`, header с кнопкой закрытия, split layout (sidebar + main).

- Паттерн: точная копия `ChangeReviewDialog.tsx` (строка 508) -- raw `<div>`, не Radix Dialog
- macOS traffic light padding: `var(--macos-traffic-light-padding-left, 72px)` в header
- `inert` атрибут на фоновый контент пока overlay открыт
- При открытии: фокус на первый файл в дереве (или CM6 если таб открыт)
- При закрытии: вернуть фокус на кнопку "Open in Editor" через `returnFocusRef`
- Escape/X с unsaved changes: ConfirmDialog с тремя кнопками -- "Save All & Close" / "Discard & Close" / "Cancel"
- Кнопка `?` в header: открывает `EditorShortcutsHelp`

### EditorFileTree.tsx (max 200 LOC)

**Ответственность**: Тонкая обёртка над generic `FileTree<FileTreeEntry>`.

- Предоставляет `renderNodeExtra` с dirty marker + file type icon
- Предоставляет `renderNodeIcon` с иконками по типу файла
- Context menu integration (делегирует `EditorContextMenu`)
- Git status badges через `renderNodeExtra` (итерация 5)
- Пустой проект: "No files found. Create a new file?"
- Sensitive файлы: иконка замка, при клике "Sensitive file, cannot open"
- Max визуальный indent: 12 уровней (`min(level, 12) * 12px`), tooltip с полным путём
- Длинные имена: `truncate` + `title` tooltip
- ARIA: `role="tree"`, `role="treeitem"`, `aria-expanded`, `role="group"`, keyboard navigation (arrow keys)

### Generic FileTree.tsx (common/, max 250 LOC)

**Ответственность**: Переиспользуемый generic tree с render-props.

```typescript
interface FileTreeProps<T extends { name: string; path: string; type: 'file' | 'directory' }> {
  nodes: TreeNode<T>[];
  activeNodePath: string | null;
  onNodeClick: (node: TreeNode<T>) => void;
  renderLeafNode?: (node: TreeNode<T>, isSelected: boolean, depth: number) => React.ReactNode;
  renderFolderLabel?: (node: TreeNode<T>, isOpen: boolean, depth: number) => React.ReactNode;
  renderNodeIcon?: (node: TreeNode<T>) => React.ReactNode;
  collapsedFolders: Set<string>;
  onToggleFolder: (fullPath: string) => void;
}

// TreeNode<T> -- generic обёртка, возвращаемая buildTree<T>():
interface TreeNode<T> {
  name: string;          // Имя узла (или "src/main" при collapse)
  fullPath: string;      // Полный путь
  isFile: boolean;
  data?: T;              // Исходный элемент (только для leaf)
  children: TreeNode<T>[];
}
```

- `ReviewFileTree`: использует `renderLeafNode` для полного рендеринга (FileStatusIcon, Eye, +/-) с кастом `node.data as FileChangeSummary`
- `EditorFileTree`: использует `renderLeafNode` для dirty marker + file type icon с кастом `node.data as FileTreeEntry`
- `renderLeafNode` заменяет весь leaf-элемент (не просто "extra"), что покрывает сложные сценарии ReviewFileTree (11 пропсов из store)
- Виртуализация через `@tanstack/react-virtual` с итерации 4: `flattenTree(tree, expandedDirs) -> FlatNode[]` + `useVirtualizer({ count, estimateSize: () => 28 })`

### EditorTabBar.tsx (max 100 LOC)

**Ответственность**: Панель вкладок с переключением, закрытием, dirty indicator.

- Modified dot ПЕРЕД текстом (не обрезается при truncate)
- Max-width ~160px на таб, `truncate`, tooltip с полным путём
- Disambiguation: два "index.ts" показывают "(main/utils)" и "(renderer/utils)" через `getDisambiguatedTabLabel()`
- Иконки файлов по типу на вкладках
- Middle-click close, X button close
- ARIA: `role="tablist"`, `role="tab"`, `aria-selected`

### CodeMirrorEditor.tsx (max 150 LOC)

**Ответственность**: CM6 lifecycle -- EditorState pooling, extensions, keybindings.

- Один EditorView на весь редактор (активный файл)
- `Map<tabId, EditorState>` в useRef
- Extensions через `buildEditorExtensions(options)` -- фабрика, компонент не знает о конкретных CM plugins
- Dirty flag через debounced `EditorView.updateListener` (300ms)
- LRU eviction при > 30 states
- Паттерн lifecycle из `MembersJsonEditor.tsx` (строки 27-73)

### EditorStatusBar.tsx (max 80 LOC)

**Ответственность**: Нижняя полоска: `[Ln 42, Col 15] | [TypeScript] | [UTF-8] | [Spaces: 2] | [LF]`

- Данные из CM6 state (cursor position, language)
- CSS: `bg-surface-sidebar border-t border-border text-text-muted text-xs h-6`

### EditorBinaryState.tsx (max 60 LOC)

**Ответственность**: Заглушка вместо CM6 для бинарных файлов.

- Иконка файла, тип, размер
- Кнопки "Open in System Viewer" (`shell:openPath`) и "Close Tab"

### EditorErrorState.tsx (max 60 LOC)

**Ответственность**: Заглушка при ошибке чтения.

- AlertTriangle + текст ошибки + [Retry] + [Close Tab]
- ENOENT: "File was deleted. Create new? / Close tab"
- EACCES: "Permission denied"

---

## File Tree

### Lazy loading

- Начальная загрузка: только root level (depth=1)
- Expand директории: IPC `editor:readDir` для конкретной папки (depth=1)
- Prefetch при hover (debounced 200ms) -- опционально
- MAX_ENTRIES_PER_DIR = 500; при превышении: "N more files..." + кнопка "Show all"

### Фильтрация и сортировка

- Скрывать на стороне main process: `.git`, `node_modules`, `.next`, `dist`, `__pycache__`, `.cache`, `.venv`, `.tox`, `vendor`, `.DS_Store`, `Thumbs.db`
- Сортировка: директории сначала, затем файлы; внутри группы -- alphabetical
- Локальный fuzzy filter по имени (без IPC)

### Виртуализация (итерация 4)

```typescript
// flattenTree преобразует иерархию в плоский массив для виртуализации
function flattenTree(tree: FileTreeEntry[], expandedDirs: Set<string>): FlatNode[] { ... }

// В компоненте:
const flatNodes = useMemo(() => flattenTree(tree, expandedDirs), [tree, expandedDirs]);
const virtualizer = useVirtualizer({
  count: flatNodes.length,
  estimateSize: () => 28,
  getScrollElement: () => scrollRef.current,
});
```

Benchmark: 5000+ файлов, все папки раскрыты, FPS скролла >= 55fps.

### Контекстное меню (итерация 3)

- Правый клик на файл: Open, Delete, Copy Path, Reveal in Finder
- Правый клик на директорию: New File, New Directory, Delete, Copy Path, Reveal in Finder
- Правый клик на пустом: New File, New Directory

---

## CodeMirror Integration

### Extensions

Все уже установлены в проекте. Список extensions для editor (собираются в `buildEditorExtensions()`):

```typescript
interface EditorExtensionOptions {
  readOnly: boolean;
  fileName: string;
  onContentChanged?: () => void;   // debounced dirty flag
  onSave?: () => void;             // Cmd+S
  tabSize?: number;                // default 2
  lineWrapping?: boolean;          // toggle
}

// Compartments для динамических настроек (toggle без пересоздания EditorView)
// Паттерн из CodeMirrorDiffView.tsx (langCompartment, mergeCompartment, portionCompartment)
// ВАЖНО: Compartments хранить в useRef внутри CodeMirrorEditor, НЕ на уровне модуля:
//   const readOnlyCompartment = useRef(new Compartment());
//   const lineWrappingCompartment = useRef(new Compartment());
//   const tabSizeCompartment = useRef(new Compartment());
// Причина: useRef гарантирует изоляцию если компонент монтируется дважды (React Strict Mode).
// Паттерн из CodeMirrorDiffView.tsx:332-336 (langCompartment/mergeCompartment/portionCompartment в useRef).

function buildEditorExtensions(options: EditorExtensionOptions): Extension[] {
  return [
    // Языковые
    getLanguageExtension(options.fileName),   // внутри тоже Compartment (из codemirrorLanguages.ts)
    syntaxHighlighting(oneDarkHighlightStyle),

    // UI
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    bracketMatching(),
    closeBrackets(),

    // История
    history(),

    // Поиск (CM6 built-in, @codemirror/search)
    search(),

    // Настройки через Compartment (переключаются через view.dispatch без потери undo)
    // ВАЖНО: readOnly требует ОБА facet для корректного UX (паттерн из CodeMirrorDiffView.tsx:482-483):
    // - EditorState.readOnly — блокирует мутации документа
    // - EditorView.editable — убирает contenteditable + cursor (без него курсор мигает в read-only)
    readOnlyCompartment.current.of(options.readOnly
      ? [EditorView.editable.of(false), EditorState.readOnly.of(true)]
      : []),
    lineWrappingCompartment.current.of(options.lineWrapping ? EditorView.lineWrapping : []),
    tabSizeCompartment.current.of(indentUnit.of(' '.repeat(options.tabSize ?? 2))),

    // Все keymaps ОБЯЗАТЕЛЬНО через keymap.of() — bare KeyBinding[] не является Extension!
    // Паттерн из CodeMirrorDiffView.tsx:492 и MembersJsonEditor.tsx:40
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...closeBracketsKeymap,
      indentWithTab,
      { key: 'Mod-s', run: () => { options.onSave?.(); return true; } },
    ]),

    // onChange (debounced)
    EditorView.updateListener.of(update => {
      if (update.docChanged) options.onContentChanged?.();
    }),

    // Тема
    baseEditorTheme,  // из codemirrorTheme.ts
  ];
}

// Toggle line wrapping (итерация 5) — без потери undo/scroll:
// view.dispatch({ effects: lineWrappingCompartment.reconfigure(EditorView.lineWrapping) });
// view.dispatch({ effects: lineWrappingCompartment.reconfigure([]) });
// Refs на compartments хранить в useRef компонента CodeMirrorEditor
```

### Определение языка

Функция `getSyncLanguageExtension(fileName)` извлекается из `CodeMirrorDiffView.tsx` в `src/renderer/utils/codemirrorLanguages.ts`. 16+ языков синхронно + `@codemirror/language-data` async fallback для остальных. Используется `Compartment` для ленивой инжекции.

### Тема

Базовая тема извлекается из `diffTheme` (`CodeMirrorDiffView.tsx` строки 158-198) в `src/renderer/utils/codemirrorTheme.ts`:

```typescript
export const baseEditorTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-text)',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    fontSize: '13px',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--color-surface)',
    borderRight: '1px solid var(--color-border)',
  },
  '.cm-cursor': { borderLeftColor: 'var(--color-text)' },
  '.cm-selectionBackground': { backgroundColor: 'rgba(100, 153, 255, 0.2)' },
  // ... остальные базовые стили
});
```

Diff-специфичные стили (`.cm-changedLine`, `.cm-deletedChunk`, `.cm-merge-*`, `.cm-collapsedLines`) выносятся в отдельный `const diffSpecificTheme = EditorView.theme({...})` внутри `CodeMirrorDiffView.tsx`. В `buildExtensions()` diff-view использует `[baseEditorTheme, diffSpecificTheme]`, а editor -- только `[baseEditorTheme]`. Light theme работает автоматически через CSS-переменные.

### EditorView lifecycle

Один EditorView, переключение через EditorState pooling. При tab switch ~3-5ms для 100KB файла. Undo history, cursor, selection сохраняются в EditorState.

---

## Keyboard Shortcuts

| Shortcut | Действие | Итерация |
|----------|---------|----------|
| `Cmd+S` | Сохранить активный файл | 2 |
| `Cmd+Shift+S` | Сохранить все | 2 |
| `Cmd+W` | Закрыть активный tab | 3 |
| `Cmd+P` | Quick Open (fuzzy search файлов) | 4 |
| `Cmd+F` | Поиск в файле (CM6 search) | 2 |
| `Cmd+Shift+F` | Поиск по содержимому файлов | 4 |
| `Cmd+Shift+[` / `Cmd+Shift+]` | Переключение табов влево/вправо | 4 |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Переключение табов (MRU) | 4 |
| `Cmd+B` | Toggle file tree sidebar | 4 |
| `Cmd+G` | Go to line (CM6 gotoLine) | 4 |
| `Cmd+Z` / `Cmd+Shift+Z` | Undo/Redo (CM6 native) | 2 |
| `Escape` | Закрыть overlay (с confirm при unsaved) | 1 |

Замечания:
- `Cmd+[` / `Cmd+]` НЕ используются для табов -- это indent/outdent в CM6 и VS Code
- `Cmd+S` перехватывается через CodeMirror keymap (не глобальный listener) -- нет конфликта с другими горячими клавишами
- Sidebar width persist в localStorage

---

## CSS-переменные

### Уже имеющиеся (100% достаточно для MVP)

- Surfaces: `--color-surface`, `--color-surface-raised`, `--color-surface-sidebar`
- Borders: `--color-border`, `--color-border-subtle`, `--color-border-emphasis`
- Text: `--color-text`, `--color-text-secondary`, `--color-text-muted`
- Code: `--code-bg`, `--code-border`, `--code-line-number`, `--code-filename`
- Syntax: `--syntax-string`, `--syntax-comment`, `--syntax-keyword` и все остальные
- Scrollbar: `--scrollbar-thumb`, `--scrollbar-thumb-hover`
- Cards: `--card-bg`, `--card-border`, `--card-header-bg`

### Рекомендуемые дополнения (добавить в `:root` в `index.css`)

```css
--editor-tab-active-bg: var(--color-surface);
--editor-tab-inactive-bg: var(--color-surface-sidebar);
--editor-tab-modified-dot: #f59e0b;
--editor-tab-border: var(--color-border);
--editor-statusbar-bg: var(--color-surface-sidebar);
--editor-statusbar-text: var(--color-text-muted);
--editor-sidebar-resize-handle: rgba(148, 163, 184, 0.15);
--editor-sidebar-resize-handle-hover: rgba(148, 163, 184, 0.3);
```

---

## Итерации

### Рефакторинги (перед итерацией 1)

Обязательные рефакторинги -- без них будет дублирование кода. Выполняются ДО написания нового кода. Тесты `ReviewFileTree` и `CodeMirrorDiffView` должны проходить после рефакторинга (zero behavior change).

**ВАЖНО: Рефакторинги R1-R4 — ОТДЕЛЬНЫЙ PR (итерация 0)**. Причина: R1 затрагивает production ReviewFileTree (используется в ChangeReviewDialog), R3 затрагивает production CodeMirrorDiffView. Объединение рефакторинга production-кода + 15 новых файлов в одну итерацию — чрезмерный blast radius (28 файлов). Разделение:
- **PR 0 ("Refactoring")**: R1-R4 + тесты. Мёрдж только после проверки что ChangeReviewDialog работает корректно.
- **PR 1 ("Walking Skeleton")**: Новые editor-файлы. Зависит от PR 0.

| # | Что извлечь | Откуда | Куда | LOC |
|---|-------------|--------|------|-----|
| R1 | `buildTree()` + `collapse()` + сортировка | `ReviewFileTree.tsx:42-83` | `src/renderer/utils/fileTreeBuilder.ts` | ~50 | **NB**: ReviewFileTree работает с `FileChangeSummary` (имеет `status`, `additions`, `deletions`), а editor использует `FileTreeEntry` (имеет `size`, `children`). `buildTree<T>()` должен быть generic по типу node, принимая `getPath: (item: T) => string` и `isDirectory: (item: T) => boolean` как параметры. |
| R2 | `getSyncLanguageExtension()` + `getAsyncLanguageDesc()` | `CodeMirrorDiffView.tsx:64-128` | `src/renderer/utils/codemirrorLanguages.ts` | ~70 |
| R3 | Базовая тема CM (без diff-стилей) | `CodeMirrorDiffView.tsx:158-198` (из единого `diffTheme` объекта строки 158-283) | `src/renderer/utils/codemirrorTheme.ts` | ~40 | **NB**: `diffTheme` — один `EditorView.theme({...})` на 125 строк. Рефакторинг: (1) извлечь строки 158-198 в `baseEditorTheme = EditorView.theme({...})` в `codemirrorTheme.ts`; (2) в `CodeMirrorDiffView.tsx` создать `const diffSpecificTheme = EditorView.theme({...})` со строками 199-283; (3) в `buildExtensions()` заменить `diffTheme` на `[baseEditorTheme, diffSpecificTheme]`. |
| R4 | `wrapReviewHandler<T>()` | `review.ts:133-145` | `src/main/ipc/ipcWrapper.ts` | ~15 | **NB**: `teams.ts` имеет аналогичный `wrapTeamHandler` (40+ вызовов), но его миграция — отдельный follow-up PR после итерации 1. Blast radius слишком высокий (1755 строк) для совмещения с основной фичей. В итерации 1 R4 применяется ТОЛЬКО к `review.ts` + новому `editor.ts`. |

После рефакторинга:
- `ReviewFileTree.tsx` импортирует `buildTree`, `TreeNode` из `fileTreeBuilder.ts`
- `CodeMirrorDiffView.tsx` импортирует из `codemirrorLanguages.ts` и `codemirrorTheme.ts`
- `review.ts` импортирует `createIpcWrapper` из `ipcWrapper.ts`
- `teams.ts` — миграция `wrapTeamHandler` → `createIpcWrapper` в отдельном follow-up PR (40+ замен, высокий blast radius)

```typescript
// src/main/ipc/ipcWrapper.ts
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

// review.ts:
const wrapHandler = createIpcWrapper('IPC:review');

// editor.ts:
const wrapHandler = createIpcWrapper('IPC:editor');
```

---

### Итерация 1: Walking Skeleton (read-only файловый браузер)

**Цель**: Минимальный end-to-end вертикальный срез -- кнопка "Open in Editor" на TeamDetailView открывает полноэкранный overlay с деревом файлов слева и содержимым файла с подсветкой синтаксиса (read-only) справа.

**Новые npm-зависимости**: `@codemirror/search` (`pnpm add @codemirror/search`).

**IPC каналы**:
| Канал | Описание |
|-------|----------|
| `editor:open` | Инициализировать editor, установить activeProjectRoot в module-level state |
| `editor:close` | Cleanup: сброс activeProjectRoot, остановка watcher |
| `editor:readDir` | Рекурсивное чтение директории (depth=1, lazy) |
| `editor:readFile` | Чтение содержимого файла с binary detection |

**Новые файлы**:
| Файл | Описание |
|------|----------|
| `src/shared/types/editor.ts` | `FileTreeEntry`, `ReadDirResult`, `ReadFileResult` |
| `src/main/services/editor/ProjectFileService.ts` | Stateless сервис: `readDir`, `readFile` с полной валидацией |
| `src/main/services/editor/index.ts` | Barrel export: `{ ProjectFileService }` (расширяется в итерациях 4-5) |
| `src/main/ipc/editor.ts` | IPC handlers с module-level `activeProjectRoot` |
| `src/main/ipc/ipcWrapper.ts` | Общий `createIpcWrapper()` (рефакторинг из review.ts) |
| `src/renderer/store/slices/editorSlice.ts` | Минимальный slice: Группа 1 (tree state + actions) |
| `src/renderer/utils/fileTreeBuilder.ts` | Generic `buildTree<T>()` (рефакторинг из ReviewFileTree) |
| `src/renderer/utils/codemirrorLanguages.ts` | `getSyncLanguageExtension()` (рефакторинг) |
| `src/renderer/utils/codemirrorTheme.ts` | `baseEditorTheme` (рефакторинг) |
| `src/renderer/components/common/FileTree.tsx` | Generic FileTree<T> с render-props |
| `src/renderer/components/team/editor/ProjectEditorOverlay.tsx` | Full-screen overlay |
| `src/renderer/components/team/editor/EditorFileTree.tsx` | Обёртка над generic FileTree |
| `src/renderer/components/team/editor/CodeMirrorEditor.tsx` | Read-only CM6 view (один EditorView, без pooling пока) |
| `src/renderer/components/team/editor/EditorEmptyState.tsx` | Нет открытых файлов |
| `src/renderer/components/team/editor/EditorBinaryState.tsx` | Заглушка для бинарных файлов |
| `src/renderer/components/team/editor/EditorErrorState.tsx` | Заглушка для ошибок чтения |

**Изменения в существующих файлах**:
| Файл | Изменение |
|------|-----------|
| `src/shared/types/api.ts` | `EditorAPI` interface + `editor: EditorAPI` в `ElectronAPI` |
| `src/shared/types/index.ts` | +`export type * from './editor'` (barrel re-export, паттерн как team/review/terminal) |
| `src/preload/constants/ipcChannels.ts` | `EDITOR_OPEN`, `EDITOR_CLOSE`, `EDITOR_READ_DIR`, `EDITOR_READ_FILE` |
| `src/preload/index.ts` | Секция `editor: { ... }` в `electronAPI` |
| `src/main/ipc/handlers.ts` | `initializeEditorHandlers` + `registerEditorHandlers` |
| `src/main/ipc/review.ts` | Заменить `wrapReviewHandler` на import из `ipcWrapper.ts` |
| `src/renderer/components/team/TeamDetailView.tsx` | Кнопка "Open in Editor" + state для overlay |
| `src/renderer/components/team/review/ReviewFileTree.tsx` | Рефакторинг: использовать generic FileTree + fileTreeBuilder |
| `src/renderer/components/team/review/CodeMirrorDiffView.tsx` | Рефакторинг: импорт из codemirrorLanguages/Theme |
| `src/main/utils/pathValidation.ts` | Добавить `validateFileName()`, `isDevicePath()`, `isGitInternalPath()`. Экспортировать `matchesSensitivePattern()` (сейчас приватная) для пометки `isSensitive` в readDir |
| `src/main/index.ts` | Добавить базовый cleanup в `mainWindow.on('closed')`: вызвать `cleanupEditorState()` (экспорт из editor.ts, сбрасывает `activeProjectRoot = null`). Без этого при Cmd+Q на macOS state "утечёт" и `editor:open` откажет при следующем открытии окна. Полный watcher cleanup — итерация 5, но базовый reset нужен с итерации 1 |
| `src/renderer/api/httpClient.ts` | Stub для `editor: EditorAPI` — throw "Editor is not available in browser mode" (паттерн как `review`, `terminal`, `teams`) |
| `src/renderer/store/types.ts` | `EditorSlice` в AppState |
| `src/renderer/store/index.ts` | `createEditorSlice` |

**Security-требования**:
- `ProjectFileService.readDir()`: для каждого entry проверять containment через `isPathWithinAllowedDirectories()` (экспортирована из pathValidation.ts). Для symlinks -- `fs.realpath()` + повторная проверка containment. Молча пропускать entries за пределами projectRoot (SEC-2). **НЕ вызывать `validateFilePath()` целиком** — она блокирует sensitive файлы, а readDir должен их ПОКАЗЫВАТЬ с пометкой `isSensitive: true`. Для пометки использовать новую экспортируемую функцию `matchesSensitivePattern()` из pathValidation.ts (сейчас приватная — нужно экспортировать) (SEC-6)
- `ProjectFileService.readFile()`: `fs.lstat()` -> `isFile()` ДО чтения. `stats.size <= 2MB`. Block device paths. Post-read realpath verify (SEC-3, SEC-4)
- `activeProjectRoot` в module-level state, НЕ от renderer (SEC-5)
- Sensitive файлы: показывать с замком в дереве, "Sensitive file, cannot open" при клике (SEC-6)

**Performance-требования**:
- MAX_ENTRIES_PER_DIR = 500; при превышении -- "N more files..."
- readFile тиерная стратегия: <256KB мгновенно, 256KB-2MB progress, 2MB-5MB preview, >5MB external
- Binary detection: null bytes в первых 8KB
- Дедупликация IPC: `Map<string, Promise<ReadFileResult>>` для readFile

**UX-требования**:
- Focus management: при открытии -- фокус на первый файл. При закрытии -- вернуть фокус на кнопку. `inert` на фон
- ARIA: file tree сразу с `role="tree"`, `role="treeitem"`, `aria-expanded`, `role="group"`
- Пустой проект: "No files found" + кнопка Create (неактивна до итерации 3)
- Binary файлы: `EditorBinaryState.tsx` с кнопкой "Open in System Viewer"
- Max indent 12 уровней, tooltip на глубоких узлах

**State management**: Создать минимальный `editorSlice` уже на итерации 1 с полями `editorProjectPath`, `editorFileTree`, `editorFileTreeLoading`, `editorFileTreeError`, `openEditor()`, `closeEditor()`, `loadFileTree()`, `expandDirectory()`. Это избавит от болезненной миграции useState → Zustand на итерации 2. Табы и dirty-состояние добавляются в slice на итерации 2.

**Тестирование**:
- `ProjectFileService` -- чтение директории с mock fs, проверка security (reject paths outside projectRoot), исключение node_modules, symlink escape
- `editorSlice` -- open/close editor, loadFileTree, expandDirectory
- `EditorFileTree` -- snapshot тесты рендеринга
- `fileTreeBuilder.ts` -- unit тесты `buildTree()` (с generic типами для FileChangeSummary и FileTreeEntry)
- `ipcWrapper.ts` -- unit тесты createIpcWrapper
- Manual: открыть TeamDetailView -> "Open in Editor" -> дерево загружается -> клик по файлу -> подсветка синтаксиса

**Критерии готовности**:
- Кнопка видна на TeamDetailView рядом с путём проекта
- Overlay открывается по клику, закрывается по Escape или X
- Дерево файлов загружается для projectPath команды
- Клик по файлу показывает содержимое с синтаксической подсветкой
- Binary файлы показывают заглушку
- Попытка прочитать файл за пределами проекта -- отказ
- `pnpm typecheck` проходит
- Рефакторинги R1-R4 выполнены, тесты ReviewFileTree и CodeMirrorDiffView проходят

**Надёжность решения: 8/10** -- CodeMirror 6 проверен в продакшене, все зависимости в проекте, паттерны повторяют ChangeReviewDialog.
**Уверенность: 9/10** -- самый понятный этап, минимум неизвестных.

---

### Итерация 2: Editable CodeMirror + сохранение файлов

**Цель**: Переключить CodeMirror из read-only в редактируемый режим. Cmd+S для сохранения. Индикатор unsaved changes. Status bar.

**IPC каналы**:
| Канал | Описание |
|-------|----------|
| `editor:writeFile` | Запись файла (atomic write через tmp + rename) |

**Новые файлы**:
| Файл | Описание |
|------|----------|
| `src/main/utils/atomicWrite.ts` | Перемещение существующего `atomicWriteAsync()` из `src/main/services/team/atomicWrite.ts` (shared utility, используется в writeFile + team-сервисах) |
| `src/renderer/components/team/editor/EditorTabBar.tsx` | Панель вкладок (один файл пока, подготовка к multi-tab) |
| `src/renderer/components/team/editor/EditorStatusBar.tsx` | Ln:Col, язык, отступы |
| `src/renderer/components/team/editor/EditorToolbar.tsx` | Save, Undo, Redo |

**Изменения в существующих файлах**:
| Файл | Изменение |
|------|-----------|
| `src/shared/types/editor.ts` | Типы для write request/response |
| `src/shared/types/api.ts` | `writeFile` в `EditorAPI` |
| `src/main/services/editor/ProjectFileService.ts` | Метод `writeFile()` с atomic write |
| `src/main/ipc/editor.ts` | Handler `editor:writeFile` |
| `src/preload/index.ts` | `editor.writeFile` |
| `src/preload/constants/ipcChannels.ts` | `EDITOR_WRITE_FILE` |
| `src/renderer/components/team/editor/ProjectEditorOverlay.tsx` | Интеграция TabBar, StatusBar |
| `src/renderer/components/team/editor/CodeMirrorEditor.tsx` | Убрать readOnly, EditorState pooling (Map<tabId, EditorState>), Cmd+S keymap |
| `src/renderer/store/slices/editorSlice.ts` | Расширить: +Группа 2 (tabs) + Группа 3 (dirty/save) |
| `src/renderer/index.css` | +8 editor CSS-переменных (--editor-tab-active-bg, --editor-tab-modified-dot и др.) |

**Security-требования**:
- `writeFile`: `validateFilePath()` ДО записи. **+ SEC-14**: `isPathWithinRoot(normalizedPath, activeProjectRoot)` для блокировки `~/.claude` writes. `Buffer.byteLength(content, 'utf8') <= 2MB`. Atomic write. Запрет записи в `.git/`. `activeProjectRoot` из module-level state (SEC-9, SEC-12)
- Файл удалён извне при save: ENOENT -> inline-ошибка "File was deleted. Create new? / Close tab" (не падать)

**Performance-требования**:
- НЕ хранить modified content в Zustand. Контент только в EditorState CM. В store: `editorModifiedFiles: Set<string>` (dirty flags)
- Dirty flag через debounced `EditorView.updateListener` (300ms)
- Гранулярные Zustand-селекторы: FileTreePanel не подписывается на tabs/content
- EditorState pooling: один EditorView, Map<tabId, EditorState> в useRef
- LRU eviction при > 30 states

**UX-требования**:
- Status bar: `[Ln 42, Col 15] | [TypeScript] | [UTF-8] | [Spaces: 2]`
- Unsaved changes при закрытии overlay: три кнопки ("Save All & Close" / "Discard & Close" / "Cancel")
- Dirty indicator (точка) на вкладке ПЕРЕД текстом
- `hasUnsavedChanges()` в slice

**Тестирование**:
- `ProjectFileService.writeFile` -- запись с mock fs, reject для файлов вне проекта, atomic write
- `editorSlice` -- open/close файлы, dirty state, save
- EditorState pooling -- save/restore state при switch tab
- Manual: открыть файл -> отредактировать -> Cmd+S -> dirty indicator сбрасывается

**Критерии готовности**:
- Файл редактируется в CodeMirror (не read-only)
- Cmd+S сохраняет файл через atomic write
- Dirty indicator на вкладке
- Status bar показывает позицию курсора и язык
- При закрытии overlay с unsaved changes -- confirmation dialog
- Benchmark: 0 re-render FileTreePanel/TabBar при наборе текста

**Надёжность решения: 7/10** -- atomic write и EditorState pooling добавляют сложность.
**Уверенность: 8/10** -- паттерны известны, но dirty tracking через CM6 updateListener требует тестирования.

---

### Итерация 3: Multi-tab + создание/удаление файлов

**Цель**: Поддержка нескольких открытых файлов во вкладках. Контекстное меню: создать файл/папку, удалить. Tab management.

**IPC каналы**:
| Канал | Описание |
|-------|----------|
| `editor:createFile` | Создать файл (validateFileName + валидация parentDir) |
| `editor:createDir` | Создать директорию |
| `editor:deleteFile` | Удалить файл через `shell.trashItem()` (безопасно) |

**Новые файлы**:
| Файл | Описание |
|------|----------|
| `src/renderer/components/team/editor/EditorContextMenu.tsx` | Context menu (New File, New Folder, Delete, Reveal in Finder) |
| `src/renderer/components/team/editor/NewFileDialog.tsx` | Inline-input для имени файла/папки |
| `src/renderer/utils/tabLabelDisambiguation.ts` | `getDisambiguatedTabLabel()` для дублей "index.ts" |

**Изменения в существующих файлах**:
| Файл | Изменение |
|------|-----------|
| `src/shared/types/editor.ts` | Типы для create/delete |
| `src/shared/types/api.ts` | `createFile`, `createDir`, `deleteFile` в EditorAPI |
| `src/main/services/editor/ProjectFileService.ts` | `createFile()`, `createDir()`, `deleteFile()` |
| `src/main/ipc/editor.ts` | 3 новых handler |
| `src/preload/index.ts` | 3 новых метода |
| `src/preload/constants/ipcChannels.ts` | `EDITOR_CREATE_FILE`, `EDITOR_CREATE_DIR`, `EDITOR_DELETE_FILE` |
| `src/renderer/components/team/editor/EditorTabBar.tsx` | Multi-tab: массив, переключение, close, middle-click close |
| `src/renderer/components/team/editor/EditorFileTree.tsx` | Right-click context menu, refresh после create/delete |
| `src/renderer/store/slices/editorSlice.ts` | Tab management actions, file operations |

**Security-требования**:
- `createFile`: `validateFileName()` -- запрет `.`, `..`, control chars, path separators, NUL, length > 255. Валидировать и `parentDir`, и `path.join(parentDir, name)` (SEC-7)
- `deleteFile`: `shell.trashItem()`, НЕ `fs.unlink()`. `validateFilePath()` обязательна
- Confirmation dialog перед удалением

**Performance-требования**:
- Tab closing: `stateCache.delete(tabId)` (явная очистка памяти). closeAllTabs: `stateCache.clear()`
- Debounce обновления дерева после create/delete (500ms), не перечитывать после каждой операции

**UX-требования**:
- Disambiguation tab labels: два "index.ts" -> "(main/utils)" и "(renderer/utils)"
- Длинные имена: max-width ~160px, `truncate`, tooltip. Modified dot ПЕРЕД текстом
- ARIA для tab bar: `role="tablist"`, `role="tab"`, `aria-selected`, `role="tabpanel"`

**Тестирование**:
- `ProjectFileService.createFile/deleteFile` с mock fs
- `editorSlice` -- multi-tab actions (open, close, reorder)
- `tabLabelDisambiguation.ts` -- unit тесты
- `EditorContextMenu` -- рендеринг, клики
- Manual: несколько файлов -> вкладки -> создать файл -> удалить файл

**Критерии готовности**:
- Несколько файлов открыты одновременно
- Вкладки переключаются, закрываются (X, middle-click)
- Right-click -> New File, New Folder, Delete
- Создание файла добавляет в дерево + автоматически открывает
- Удаление через Trash с confirmation
- Disambiguation labels для дублирующихся имён

**Надёжность решения: 7/10** -- file operations с правильной валидацией и trash -- надёжный подход.
**Уверенность: 8/10** -- паттерны файловых операций отработаны.

---

### Итерация 4: Горячие клавиши, поиск, UX polish

**Цель**: Клавиатурная навигация, Quick Open (Cmd+P), поиск по файлам (Cmd+Shift+F), breadcrumb, иконки файлов, виртуализация дерева.

**IPC каналы**:
| Канал | Описание |
|-------|----------|
| `editor:searchInFiles` | Literal string search, max 100 results, max 1MB/файл |

**Новые файлы**:
| Файл | Описание |
|------|----------|
| `src/renderer/components/team/editor/QuickOpenDialog.tsx` | Cmd+P: fuzzy search через `cmdk` |
| `src/renderer/components/team/editor/SearchInFilesPanel.tsx` | Cmd+Shift+F: результаты поиска |
| `src/renderer/components/team/editor/EditorBreadcrumb.tsx` | Breadcrumb навигация (кликабельный) |
| `src/renderer/components/team/editor/EditorShortcutsHelp.tsx` | Модальное окно shortcuts (кнопка ?) |
| `src/renderer/components/team/editor/fileIcons.ts` | Маппинг расширений на lucide-react иконки/цвета |
| `src/renderer/hooks/useEditorKeyboardShortcuts.ts` | Все горячие клавиши редактора |
| `src/main/services/editor/FileSearchService.ts` | Search in files (literal, с лимитами) |

**Изменения в существующих файлах**:
| Файл | Изменение |
|------|-----------|
| `src/shared/types/editor.ts` | Типы SearchResult |
| `src/shared/types/api.ts` | `searchInFiles` в EditorAPI |
| `src/main/ipc/editor.ts` | Handler `editor:searchInFiles` |
| `src/preload/index.ts` | `editor.searchInFiles` |
| `src/preload/constants/ipcChannels.ts` | `EDITOR_SEARCH_IN_FILES` |
| `src/renderer/components/team/editor/ProjectEditorOverlay.tsx` | QuickOpen, SearchInFiles, Breadcrumb, shortcuts |
| `src/renderer/components/team/editor/EditorFileTree.tsx` | Виртуализация через react-virtual + иконки файлов |
| `src/renderer/components/team/editor/EditorTabBar.tsx` | Иконки файлов на вкладках |

**Security-требования**:
- `searchInFiles`: ТОЛЬКО literal string search, НЕ regex. Default case-insensitive (`line.toLowerCase().includes(query.toLowerCase())` — ReDoS-безопасно). Опция `caseSensitive?: boolean` в параметрах. Max 1000 файлов, max 1MB/файл. Каждый файл валидируется через `validateFilePath()`. AbortController timeout 5s (SEC-8)

**Performance-требования**:
- File tree виртуализация: `@tanstack/react-virtual` -- `flattenTree()` + `useVirtualizer({ estimateSize: () => 28 })`
- Quick Open: кешировать flat file list при открытии editor. Invalidate по file watcher event или F5
- Search in files: запускать с AbortController timeout

**UX-требования**:
- `Cmd+Shift+[`/`]` для табов (НЕ `Cmd+[/]` -- это indent/outdent!)
- `Cmd+B` toggle sidebar, width persist в localStorage
- `Cmd+G` go to line (CM6 gotoLine)
- EmptyState показывает шпаргалку shortcuts
- Кнопка `?` в header overlay
- Breadcrumb: каждый сегмент кликабелен -- открывает папку в дереве

**Тестирование**:
- `FileSearchService` -- поиск по mock файлам, лимиты
- `useEditorKeyboardShortcuts` -- обработка горячих клавиш
- `fileIcons.ts` -- маппинг расширений
- Виртуализация: benchmark 5000+ файлов, FPS >= 55fps
- Manual: Cmd+P, Cmd+Shift+F, навигация клавиатурой

**Критерии готовности**:
- Cmd+P открывает quick open с fuzzy search
- Cmd+Shift+F показывает результаты поиска по содержимому
- Все горячие клавиши из таблицы работают
- Breadcrumb-навигация для текущего файла
- Иконки файлов по типу в дереве и вкладках
- File tree виртуализирован, скролл плавный

**Надёжность решения: 7/10** -- виртуализация и search добавляют сложность, но библиотеки проверены.
**Уверенность: 7/10** -- много нового UI, но каждый компонент изолирован.

---

### Итерация 5: Git status, file watching, расширенные возможности

**Цель**: Git status в дереве файлов. Live refresh при изменениях на диске. Conflict detection при сохранении. Line wrap toggle.

**IPC каналы**:
| Канал | Описание |
|-------|----------|
| `editor:gitStatus` | `git status --porcelain`, кеш 5 сек |
| `editor:watchDir` | Запуск file watcher (opt-in, НЕ по умолчанию) |
| `editor:change` | Event: файл изменился на диске (main -> renderer) |

**Новые файлы**:
| Файл | Описание |
|------|----------|
| `src/main/services/editor/EditorFileWatcher.ts` | FileWatcher (~60 LOC), fs.watch + debounce 200ms |
| `src/main/services/editor/GitStatusService.ts` | `git status --porcelain` парсинг, кеш 5 сек |
| `src/main/services/editor/conflictDetection.ts` | Утилита mtime check: сравнение mtime до/после save, conflict resolution (~40 LOC) |
| `src/renderer/components/team/editor/GitStatusBadge.tsx` | M/U/A бейджи в дереве |

**Изменения в существующих файлах**:
| Файл | Изменение |
|------|-----------|
| `src/shared/types/editor.ts` | `GitFileStatus`, `EditorFileChangeEvent` |
| `src/shared/types/api.ts` | `gitStatus`, `onEditorChange` в EditorAPI |
| `src/main/ipc/editor.ts` | Handlers для git status и file watcher |
| `src/preload/index.ts` | `editor.gitStatus`, `editor.onEditorChange` (НЕ `onFileChange` — конфликт с существующим `ElectronAPI.onFileChange`) |
| `src/preload/constants/ipcChannels.ts` | `EDITOR_GIT_STATUS`, `EDITOR_WATCH_DIR`, `EDITOR_CHANGE` |
| `src/renderer/components/team/editor/EditorFileTree.tsx` | Git status badges |
| `src/renderer/components/team/editor/CodeMirrorEditor.tsx` | Conflict detection (mtime check) при сохранении |
| `src/renderer/components/team/editor/ProjectEditorOverlay.tsx` | File watcher подписка, auto-refresh, conflict modal |
| `src/renderer/store/slices/editorSlice.ts` | Git status data, file watcher state |
| `src/renderer/store/index.ts` | В `initializeNotificationListeners()` добавить подписку `if (api.editor?.onEditorChange)` → обновление дерева/табов при внешних изменениях (guard обязателен — паттерн из всех существующих subscriptions) |
| `src/main/index.ts` | `mainWindow.on('closed')` → `cleanupEditorState()`. `shutdownServices()` → `cleanupEditorState()` |

**Security-требования**:
- `editor:gitStatus`: `cwd = activeProjectRoot` (валидный). Не передавать full paths от git без валидации
- `editor:change`: пути в events могут утечь через symlink -- валидировать перед передачей в renderer (SEC-2)

**Watcher lifecycle cleanup** (macOS: window closed but app alive):
- `editor:open` — если `activeProjectRoot !== null`, сначала остановить предыдущий watcher и сбросить state (идемпотентный reset). Guard: `if (activeProjectRoot !== null) throw new Error('Another editor is already open')`
- `mainWindow.on('closed')` в `src/main/index.ts` — вызвать `cleanupEditorState()` (экспорт из `editor.ts`): сброс `activeProjectRoot`, остановка watcher. Аналог существующего cleanup для `notificationManager`, `ptyTerminalService`
- `shutdownServices()` — добавить `cleanupEditorState()` рядом с `removeIpcHandlers()`

**Performance-требования**:
- File watcher opt-in: по умолчанию ВЫКЛЮЧЕН. Toggle "Watch for external changes". По умолчанию ручной refresh (F5)
- `fs.watch({ recursive: true })` + фильтрация (node_modules/.git/dist) + debounce 200ms
- Git status кешировать на 5 секунд. Invalidate по file watcher event

**UX-требования**:
- File changed on disk while open: banner в табе "File changed on disk. [Reload] [Keep mine] [Show diff]" (НЕ перезаписывать молча)
- File deleted on disk while open: banner "File no longer exists on disk. [Close tab]"
- Conflict detection при save: mtime check. Если изменился -- dialog "Overwrite / Cancel / Show diff"
- Line wrap toggle в toolbar

**Тестирование**:
- `GitStatusService` -- парсинг `git status --porcelain` вывода
- `EditorFileWatcher` -- debounce, event types
- Conflict detection логика
- Manual: изменить файл в внешнем редакторе -> conflict banner

**Критерии готовности**:
- Git status бейджи (M/U/A) в файловом дереве
- Auto-refresh при изменениях на диске (при включённом watcher)
- Conflict detection при сохранении
- Line wrap toggle

**Надёжность решения: 6/10** -- file watching и conflict detection -- наиболее сложная часть, race conditions вероятны.
**Уверенность: 7/10** -- паттерны FileWatcher уже в проекте, но интеграция с editor добавляет edge cases.

---

## Риски

| Риск | Вероятность | Импакт | Итерация | Митигация |
|------|------------|--------|----------|-----------|
| Path traversal через IPC | Средняя | Критический | 1+ | `validateFilePath()` на КАЖДОМ handler + module-level projectRoot |
| Symlink escape из projectRoot | Высокая | Критический | 1 | `fs.realpath()` + re-check на каждом entry в readDir |
| node_modules/огромные директории -- OOM | Высокая | Высокий | 1 | IGNORED_DIRS фильтр + MAX_DIR_ENTRIES=500 + виртуализация (итерация 4) |
| CM6 тормозит на файлах >2MB | Низкая | Средний | 1 | Hard limit 2MB + тиерная стратегия + external editor fallback |
| TOCTOU race condition при save | Высокая | Высокий | 2 | Atomic write (tmp + rename) + post-read verify |
| Race condition: агент и пользователь редактируют один файл | Высокая | Высокий | 5 | mtime check + conflict dialog (overwrite / cancel / diff) |
| Unsaved data loss при crash | Средняя | Средний | 2 | Возможен autosave в localStorage/IndexedDB (P2 фича) |
| Device file DoS (/dev/zero) | Средняя | Высокий | 1 | `fs.lstat()` + `isFile()` + block /dev/ /proc/ /sys/ |
| Credential leakage (.env, .key) | Высокая | Высокий | 1 | `validateFilePath()` + визуальная пометка + блокировка чтения |
| ReDoS в searchInFiles | Средняя | Средний | 4 | Только literal search + timeout через AbortController |
| Memory leak: 20+ EditorView | Высокая | Критический | 2 | EditorState pooling + LRU eviction |
| Zustand keystroke storm | Высокая | Высокий | 2 | Content вне store + debounced dirty flag |
| XSS через имена файлов | Низкая | Средний | 1 | React JSX + validateFileName() при создании |
| Запись в .git/ | Средняя | Высокий | 2 | `isGitInternalPath()` блокирует write |
| ~~review.ts без валидации пути~~ | ~~Существует~~ | ~~Критический~~ | **ИСПРАВЛЕНО** | `validateFilePath()` добавлен в handleSaveEditedFile (hotfix применён) |

---

## Benchmarks

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

## Полный список файлов

### Новые файлы (~30)

| Файл | Итерация | Описание |
|------|----------|----------|
| `src/shared/types/editor.ts` | 1 | Все типы editor |
| `src/main/services/editor/ProjectFileService.ts` | 1 | Stateless файловый сервис |
| `src/main/services/editor/index.ts` | 1 | Barrel export: `{ ProjectFileService }` (расширяется в итерациях 4-5) |
| `src/main/services/editor/FileSearchService.ts` | 4 | Search in files |
| `src/main/services/editor/GitStatusService.ts` | 5 | git status --porcelain |
| `src/main/services/editor/EditorFileWatcher.ts` | 5 | FileWatcher (~60 LOC) |
| `src/main/services/editor/conflictDetection.ts` | 5 | Утилита mtime check: сравнение mtime до/после save, conflict resolution (~40 LOC) |
| `src/main/ipc/editor.ts` | 1 | IPC handlers |
| `src/main/ipc/ipcWrapper.ts` | 1 | Общий `createIpcWrapper()` |
| `src/main/utils/atomicWrite.ts` | 2 | Перемещение `atomicWriteAsync()` из `team/atomicWrite.ts` (randomUUID, fsync, EXDEV fallback) |
| `src/renderer/utils/fileTreeBuilder.ts` | 1 | buildTree (рефакторинг) |
| `src/renderer/utils/codemirrorLanguages.ts` | 1 | Языковой маппинг (рефакторинг) |
| `src/renderer/utils/codemirrorTheme.ts` | 1 | Базовая тема CM (рефакторинг) |
| `src/renderer/utils/tabLabelDisambiguation.ts` | 3 | Disambiguation дублей |
| `src/renderer/store/slices/editorSlice.ts` | 1 | Zustand slice (Группа 1: tree), расширяется в итерации 2-3 |
| `src/renderer/hooks/useEditorKeyboardShortcuts.ts` | 4 | Горячие клавиши |
| `src/renderer/components/common/FileTree.tsx` | 1 | Generic FileTree с render-props |
| `src/renderer/components/team/editor/ProjectEditorOverlay.tsx` | 1 | Full-screen overlay |
| `src/renderer/components/team/editor/EditorFileTree.tsx` | 1 | Обёртка над FileTree |
| `src/renderer/components/team/editor/CodeMirrorEditor.tsx` | 1 | CM6 wrapper |
| `src/renderer/components/team/editor/EditorTabBar.tsx` | 2 | Панель вкладок |
| `src/renderer/components/team/editor/EditorToolbar.tsx` | 2 | Toolbar |
| `src/renderer/components/team/editor/EditorStatusBar.tsx` | 2 | Status bar |
| `src/renderer/components/team/editor/EditorEmptyState.tsx` | 1 | Empty state |
| `src/renderer/components/team/editor/EditorBinaryState.tsx` | 1 | Binary файлы |
| `src/renderer/components/team/editor/EditorErrorState.tsx` | 1 | Ошибки чтения |
| `src/renderer/components/team/editor/EditorContextMenu.tsx` | 3 | Context menu |
| `src/renderer/components/team/editor/NewFileDialog.tsx` | 3 | Inline-input |
| `src/renderer/components/team/editor/QuickOpenDialog.tsx` | 4 | Cmd+P dialog |
| `src/renderer/components/team/editor/SearchInFilesPanel.tsx` | 4 | Cmd+Shift+F |
| `src/renderer/components/team/editor/EditorBreadcrumb.tsx` | 4 | Breadcrumb |
| `src/renderer/components/team/editor/EditorShortcutsHelp.tsx` | 4 | Shortcuts modal |
| `src/renderer/components/team/editor/fileIcons.ts` | 4 | Иконки файлов |
| `src/renderer/components/team/editor/GitStatusBadge.tsx` | 5 | M/U/A бейджи |

### Модификации существующих файлов (~17)

| Файл | Итерация | Изменение |
|------|----------|-----------|
| `src/preload/constants/ipcChannels.ts` | 1-5 | +12 констант EDITOR_* (включая EDITOR_CLOSE) |
| `src/preload/index.ts` | 1-5 | Секция `editor: { ... }` |
| `src/shared/types/api.ts` | 1-5 | `EditorAPI` interface |
| `src/main/ipc/review.ts` | 1 | Замена wrapReviewHandler на import из ipcWrapper |
| `src/main/utils/pathValidation.ts` | 1 | +validateFileName, +isDevicePath, +isGitInternalPath |
| `src/renderer/store/types.ts` | 1 | +EditorSlice в AppState |
| `src/renderer/store/index.ts` | 1 | +createEditorSlice |
| `src/renderer/components/team/TeamDetailView.tsx` | 1 | Кнопка "Open in Editor" + overlay state |
| `src/renderer/components/team/review/ReviewFileTree.tsx` | 1 | Рефакторинг: generic FileTree + fileTreeBuilder |
| `src/renderer/components/team/review/CodeMirrorDiffView.tsx` | 1 | Рефакторинг: импорт из codemirrorLanguages/Theme |
| `src/main/ipc/handlers.ts` | 1 | +initializeEditorHandlers() + registerEditorHandlers(ipcMain) + removeEditorHandlers(ipcMain) |
| `src/renderer/api/httpClient.ts` | 1 | Stub для editor: EditorAPI (throw "not available in browser mode") |
| `src/main/ipc/teams.ts` | follow-up | Миграция wrapTeamHandler → createIpcWrapper (40+ замен, отдельный PR) |
| `src/shared/types/index.ts` | 1 | +`export type * from './editor'` (barrel re-export, паттерн как team/review/terminal) |
| `src/main/index.ts` | 5 | `mainWindow.on('closed')` → `cleanupEditorState()`. `shutdownServices()` → `cleanupEditorState()` |
| `src/renderer/index.css` | 2 | +editor CSS-переменные |

### Тесты (новые, ~15)

| Файл | Итерация |
|------|----------|
| `test/main/services/editor/ProjectFileService.test.ts` | 1 |
| `test/main/ipc/editor.test.ts` | 1 |
| `test/main/ipc/ipcWrapper.test.ts` | 1 |
| `test/main/utils/atomicWrite.test.ts` | 2 |
| `test/renderer/utils/fileTreeBuilder.test.ts` | 1 |
| `test/renderer/utils/codemirrorLanguages.test.ts` | 1 |
| `test/renderer/store/editorSlice.test.ts` | 1 (расширяется в 2-3) |
| `test/renderer/utils/tabLabelDisambiguation.test.ts` | 3 |
| `test/renderer/components/team/editor/EditorContextMenu.test.ts` | 3 |
| `test/main/services/editor/FileSearchService.test.ts` | 4 |
| `test/renderer/hooks/useEditorKeyboardShortcuts.test.ts` | 4 |
| `test/renderer/components/team/editor/fileIcons.test.ts` | 4 |
| `test/main/services/editor/GitStatusService.test.ts` | 5 |
| `test/main/services/editor/EditorFileWatcher.test.ts` | 5 |
| `test/main/services/editor/conflictDetection.test.ts` | 5 | Тестирует `src/main/services/editor/conflictDetection.ts` (утилита mtime check + conflict resolution) |
