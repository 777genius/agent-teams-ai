# Архитектура

## Архитектурная диаграмма

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

## Компонентная иерархия

```
src/renderer/components/team/editor/
├── ProjectEditorOverlay.tsx     # Полноэкранный overlay (~150-200 LOC)
├── EditorFileTree.tsx           # Обёртка над generic FileTree (~150-200 LOC)
├── EditorTabBar.tsx             # Панель вкладок (~100-130 LOC)
├── CodeMirrorEditor.tsx         # CM6 wrapper: lifecycle + EditorState pooling + editorBridge (~250-350 LOC)
├── EditorToolbar.tsx            # Save, Undo, Redo, язык (~80-100 LOC)
├── EditorStatusBar.tsx          # Ln:Col, язык, отступы, кодировка (~60-80 LOC)
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

src/renderer/utils/
└── editorBridge.ts              # Module-level singleton: Store ↔ CM6 refs bridge (R3)

src/renderer/components/common/
└── FileTree.tsx                 # Generic FileTree<T> с render-props (рефакторинг из ReviewFileTree)
```

## Слои и направление зависимостей

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

  editorExpandedDirs: Record<string, boolean>;  // Сохраняется при re-open. Record — согласовано с editorModifiedFiles (Zustand не отслеживает мутации Set)

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
  //     5. Сброс slice state: tabs=[], tree=null, modified={}, expandedDirs={}, loading={}, errors={}
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
  editorModifiedFiles: Record<string, boolean>;  // dirty markers (НЕ содержимое!). Record вместо Set — Zustand не отслеживает мутации Set
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
  hasUnsavedChanges: () => boolean;                 // Object.keys(editorModifiedFiles).length > 0

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

### Store ↔ Component Bridge (R3 — решение)

`editorBridge.ts` — module-level singleton для связи Zustand store и React refs CodeMirrorEditor.

```typescript
// src/renderer/utils/editorBridge.ts
import type { EditorState, EditorView } from '@codemirror/state';

let stateCache: Map<string, EditorState> | null = null;
let scrollTopCache: Map<string, number> | null = null;
let activeView: EditorView | null = null;

export const editorBridge = {
  /** Вызывается CodeMirrorEditor при mount */
  register(sc: Map<string, EditorState>, stc: Map<string, number>, view: EditorView) {
    stateCache = sc; scrollTopCache = stc; activeView = view;
  },
  /** Вызывается CodeMirrorEditor при unmount */
  unregister() { stateCache = null; scrollTopCache = null; activeView = null; },
  /** Проверка: зарегистрирован ли bridge (HMR guard) */
  get isRegistered(): boolean { return stateCache !== null; },
  /** Для saveFile() — контент из кешированного state */
  getContent(filePath: string): string | null {
    return stateCache?.get(filePath)?.doc.toString() ?? null;
  },
  /** Для saveAllFiles() — контент всех modified файлов */
  getAllModifiedContent(modifiedFiles: Record<string, boolean>): Map<string, string> {
    const result = new Map<string, string>();
    for (const fp of Object.keys(modifiedFiles)) {
      if (!modifiedFiles[fp]) continue;
      const content = stateCache?.get(fp)?.doc.toString();
      if (content !== undefined) result.set(fp, content);
    }
    return result;
  },
  /** Для closeEditor() — полный cleanup */
  destroy() {
    activeView?.destroy();
    stateCache?.clear();
    scrollTopCache?.clear();
    activeView = null;
  },
  /** Обновить ссылку на view (при tab switch view пересоздаётся) */
  updateView(view: EditorView) { activeView = view; },
};
```

Паттерн аналогичен `ConfirmDialog.tsx` (module-level `globalSetState`) и `changeReviewSlice.ts` (module-level state).

**HMR guard**: При HMR модуль перезагружается → refs обнуляются. Компонент CodeMirrorEditor в `useEffect` проверяет `editorBridge.isRegistered` и перерегистрируется при необходимости:
```typescript
useEffect(() => {
  editorBridge.register(stateCache.current, scrollTopCache.current, viewRef.current!);
  return () => editorBridge.unregister();
}, []); // single registration at mount
```
Store actions проверяют `editorBridge.isRegistered` перед обращением — при false логируют warning и graceful fallback (не крашат).

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
  // LRU eviction: вытеснить наименее недавно использованный state (least recently used).
  // Трекинг порядка: обновлять `accessOrder: string[]` при каждом switchTab (push tabId в конец,
  // удалить предыдущее вхождение). Вытеснять accessOrder[0].
  // При eviction:
  // 1. Удалить dirty flag из editorModifiedFiles (если был) + очистить draft из localStorage
  // 2. Сохранить { content: doc.toString(), cursorPos } для восстановления через EditorState.create()
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
  status: 'modified' | 'untracked' | 'staged' | 'deleted' | 'conflict';
  // 'conflict' = merge conflicts (git porcelain codes UU, AA, DD)
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

### ProjectEditorOverlay.tsx (~150-200 LOC)

**Ответственность**: Layout shell -- `fixed inset-0 z-50`, header с кнопкой закрытия, split layout (sidebar + main).

- Паттерн: точная копия `ChangeReviewDialog.tsx` (строка 508) -- raw `<div>`, не Radix Dialog
- macOS traffic light padding: `var(--macos-traffic-light-padding-left, 72px)` в header
- `inert` атрибут на фоновый контент пока overlay открыт
- При открытии: фокус на первый файл в дереве (или CM6 если таб открыт)
- При закрытии: вернуть фокус на кнопку "Open in Editor" через `returnFocusRef`
- Escape/X с unsaved changes: ConfirmDialog с тремя кнопками -- "Save All & Close" / "Discard & Close" / "Cancel"
- Кнопка `?` в header: открывает `EditorShortcutsHelp`

### EditorFileTree.tsx (~150-200 LOC)

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

### Generic FileTree.tsx (common/, ~200-250 LOC)

**Ответственность**: Переиспользуемый generic tree с render-props.

```typescript
interface FileTreeProps<T extends { name: string; path: string; type: 'file' | 'directory' }> {
  nodes: TreeNode<T>[];
  activeNodePath: string | null;
  onNodeClick: (node: TreeNode<T>) => void;
  renderLeafNode?: (node: TreeNode<T>, isSelected: boolean, depth: number) => React.ReactNode;
  renderFolderLabel?: (node: TreeNode<T>, isOpen: boolean, depth: number) => React.ReactNode;
  renderNodeIcon?: (node: TreeNode<T>) => React.ReactNode;
  collapsedFolders: Record<string, boolean>;
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

### EditorTabBar.tsx (~100-130 LOC)

**Ответственность**: Панель вкладок с переключением, закрытием, dirty indicator.

- Modified dot ПЕРЕД текстом (не обрезается при truncate)
- Max-width ~160px на таб, `truncate`, tooltip с полным путём
- Disambiguation: два "index.ts" показывают "(main/utils)" и "(renderer/utils)" через `getDisambiguatedTabLabel()`
- Иконки файлов по типу на вкладках
- Middle-click close, X button close
- ARIA: `role="tablist"`, `role="tab"`, `aria-selected`

### CodeMirrorEditor.tsx (~250-350 LOC)

**Ответственность**: CM6 lifecycle — EditorState pooling, extensions, keybindings, bridge registration, autosave.

- Один EditorView на весь редактор (активный файл)
- `Map<tabId, EditorState>` в useRef
- Extensions через `buildEditorExtensions(options)` — фабрика, компонент не знает о конкретных CM plugins
- Dirty flag через debounced `EditorView.updateListener` (300ms)
- LRU eviction при > 30 states
- `editorBridge.register()` при mount, `editorBridge.unregister()` при unmount (R3)
- Draft autosave в localStorage (30 сек debounce) + recovery при reopen
- Паттерн lifecycle из `MembersJsonEditor.tsx` (строки 27-73)

### EditorStatusBar.tsx (~60-80 LOC)

**Ответственность**: Нижняя полоска: `[Ln 42, Col 15] | [TypeScript] | [UTF-8] | [Spaces: 2] | [LF]`

- Данные из CM6 state (cursor position, language)
- CSS: `bg-surface-sidebar border-t border-border text-text-muted text-xs h-6`

### EditorBinaryState.tsx (~50-60 LOC)

**Ответственность**: Заглушка вместо CM6 для бинарных файлов.

- Иконка файла, тип, размер
- Кнопки "Open in System Viewer" (`shell:openPath`) и "Close Tab"

### EditorErrorState.tsx (~50-60 LOC)

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
//
// R2 ПОДТВЕРЖДЕНИЕ: Compartment — opaque identity token, sharing между EditorState безопасен.
// Подтверждено автором CM6 (Marijn Haverbeke): "Compartments can be shared without issue".
// Каждый EditorState хранит свой Map<Compartment, Extension> в config.
// reconfigure() на одном View НЕ влияет на cached states в пуле.
// EDGE CASE: при unmount+remount компонента — cached states ссылаются на старые Compartments.
// Решение: при remount создать новые Compartments, заново создать EditorState для АКТИВНОГО таба.
// Evicted LRU states: теряют undo history (ожидаемо), cursor через EditorSelection.

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

| Shortcut | Действие | Итерация | Конфликт |
|----------|---------|----------|----------|
| `Cmd+S` | Сохранить активный файл | 2 | — (CM6 keymap) |
| `Cmd+Shift+S` | Сохранить все | 2 | — |
| `Cmd+W` | Закрыть активный tab | 3 | `useKeyboardShortcuts.ts:155` |
| `Cmd+P` | Quick Open (fuzzy search файлов) | 4 | — |
| `Cmd+F` | Поиск в файле (CM6 search) | 2 | `useKeyboardShortcuts.ts:241` |
| `Cmd+Shift+F` | Поиск по содержимому файлов | 4 | — |
| `Cmd+Shift+[` / `Cmd+Shift+]` | Переключение табов влево/вправо | 4 | `useKeyboardShortcuts.ts:177` |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Переключение табов (MRU) | 4 | `useKeyboardShortcuts.ts:81` |
| `Cmd+B` | Toggle file tree sidebar | 4 | `useKeyboardShortcuts.ts:271` |
| `Cmd+G` | Go to line (CM6 gotoLine) | 4 | — |
| `Cmd+Z` / `Cmd+Shift+Z` | Undo/Redo (CM6 native) | 2 | — |
| `Escape` | Закрыть overlay (с confirm при unsaved) | 1 | — |

### Scope Isolation (R1 — решение)

6 из 12 шорткатов конфликтуют с глобальными в `useKeyboardShortcuts.ts`. Решение:

**Approach A: Guard в глобальном handler** (надёжность 8/10)

```typescript
// useKeyboardShortcuts.ts — добавить guard
const editorOpen = useStore(s => s.editorProjectPath !== null);

// В handler (bubble phase, window.addEventListener('keydown')):
if (editorOpen) {
  // Early return для конфликтующих shortcuts:
  // Cmd+W, Cmd+B, Cmd+F, Cmd+Shift+[/], Ctrl+Tab
  const isEditorConflict = (e.metaKey && ['w','b','f'].includes(e.key))
    || (e.metaKey && e.shiftKey && ['[',']'].includes(e.key))
    || (e.ctrlKey && e.key === 'Tab');
  if (isEditorConflict) return;
}
```

**Safety net: `stopPropagation` в CM6** — все editor keybindings с `stopPropagation: true`:

```typescript
keymap.of([
  { key: 'Mod-f', run: openSearchPanel, stopPropagation: true },
  { key: 'Mod-s', run: () => { onSave?.(); return true; }, stopPropagation: true },
  // ...
]);
```

**Паттерн подтверждён**: `ChangeReviewDialog` уже использует capture-phase handler с guard (строки 379-408).

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
