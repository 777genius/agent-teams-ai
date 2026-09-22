# Анализ переиспользования кодовой базы для In-App Project Editor

## 1. Переиспользуемые компоненты

### 1.1 ReviewFileTree -- высокий потенциал извлечения

**Файл:** `/Users/belief/dev/projects/claude/claude_team/src/renderer/components/team/review/ReviewFileTree.tsx`

Это самый важный компонент для переиспользования. Внутри него:

- **`buildTree(files)` функция (строки 42-83)** -- построение дерева из плоского списка путей. Алгоритм: разбивает пути по `/`, строит иерархию `TreeNode`, коллапсирует одноуровневые папки (как в VS Code). Это **универсальный** алгоритм, не привязанный к review.
- **`TreeItem` компонент (строки 147-264)** -- рекурсивный рендеринг узла дерева с иконками, отступами, коллапсом папок.
- **`ReviewFileTree` (строки 297-376)** -- корневой компонент с auto-expand и auto-scroll.

**Проблема:** Сейчас `ReviewFileTree` жестко привязан к review-контексту:
- `TreeItem` принимает `hunkDecisions`, `fileDecisions`, `fileChunkCounts`, `viewedSet` -- всё review-специфичное
- `FileStatusIcon` рендерит статусы review (accepted/rejected/mixed/pending)
- Строки +/- в каждом файле (`linesAdded`, `linesRemoved`)

**Рекомендация:** Извлечь **generic FileTree** из `ReviewFileTree`. Структура:
1. Выделить `buildTree()` и `TreeNode` в утилиту `src/renderer/utils/fileTreeBuilder.ts`
2. Создать generic `FileTree` компонент с `renderItem` callback (render-prop для кастомизации правой части каждого файлового элемента)
3. `ReviewFileTree` становится тонкой обёрткой вокруг `FileTree` с review-специфичным `renderItem`
4. `EditorFileTree` -- вторая обёртка для редактора (показывает иконки по типу файла, dirty-маркер)

**Оценка надёжности: 8/10** -- buildTree проверен в продакшене, алгоритм коллапса протестирован.
**Оценка уверенности: 9/10** -- это чистый extract-and-wrap рефакторинг.

### 1.2 CodeMirrorDiffView -- частичное переиспользование

**Файл:** `/Users/belief/dev/projects/claude/claude_team/src/renderer/components/team/review/CodeMirrorDiffView.tsx`

Этот компонент содержит ценную инфраструктуру:

- **`getSyncLanguageExtension(fileName)` (строки 64-123)** -- маппинг расширений файлов на CodeMirror language extensions. 16+ языков. **Должен быть извлечён в общую утилиту.**
- **`getAsyncLanguageDesc(fileName)` (строки 126-128)** -- async fallback через `@codemirror/language-data`.
- **`diffTheme` (строки 158-283)** -- тема CodeMirror на CSS-переменных. Частично переиспользуема для обычного редактора (базовые стили `.cm-gutters`, `.cm-content`, `.cm-scroller`).
- **`langCompartment` паттерн** -- Compartment для ленивой инжекции языка. Полностью переиспользуем.
- **`buildExtensions()` (строки 477-688)** -- настройка расширений. Для редактора нужна упрощённая версия (без merge/diff, без hunk navigation).

**Что НЕ переиспользуется:** Вся diff/merge логика (`unifiedMergeView`, `mergeCompartment`, chunk navigation, merge toolbar) -- это 60%+ кода компонента.

**Рекомендация:** Создать `CodeMirrorEditor` компонент (без diff) рядом или вместо fork'а `CodeMirrorDiffView`:
1. Извлечь `getLanguageExtension()` в `src/renderer/utils/codemirrorLanguages.ts`
2. Извлечь базовую тему в `src/renderer/utils/codemirrorTheme.ts`
3. Новый `CodeMirrorEditor` использует эти утилиты + `@codemirror/autocomplete` (уже в `package.json`!)

**Оценка надёжности: 7/10** -- ядро проверено, но отделение от diff-логики требует внимания.
**Оценка уверенности: 8/10** -- чётко понятно что извлекать.

### 1.3 ChangeReviewDialog -- паттерн layout

**Файл:** `/Users/belief/dev/projects/claude/claude_team/src/renderer/components/team/review/ChangeReviewDialog.tsx`

Это **полноэкранный overlay** (не Radix Dialog!). Паттерн (строки 507-676):
```
fixed inset-0 z-50 flex flex-col bg-surface
├── Header (border-b, bg-surface-sidebar, macOS traffic-light padding)
├── Toolbar (border-b)
└── Content (flex flex-1 overflow-hidden)
    ├── Sidebar (w-64, overflow-y-auto, border-r, bg-surface-sidebar)
    └── Main content area (flex-1)
```

**Что переиспользуется:**
- Layout паттерн: header + sidebar + content
- macOS traffic-light padding (`--macos-traffic-light-padding-left`, `WebkitAppRegion: 'drag'`)
- Escape-to-close (строки 346-353)
- Loading/Error/Empty states (строки 586-673)

**Рекомендация:** Создать `FullScreenPanel` layout-компонент, который предоставляет:
- Header slot с macOS-safe padding
- Optional sidebar slot
- Content slot
- Escape-to-close behaviour
- Loading/Error/Empty state handling

Или проще -- просто скопировать layout-паттерн в `ProjectEditor`, а рефакторить в общий компонент потом.

**Оценка надёжности: 7/10**
**Оценка уверенности: 7/10** -- зависит от того, насколько сильно отличается layout редактора.

### 1.4 DiffErrorBoundary -- прямое переиспользование

**Файл:** `/Users/belief/dev/projects/claude/claude_team/src/renderer/components/team/review/DiffErrorBoundary.tsx`

Специализированный error boundary для diff-view. Нужен **аналогичный** для CodeMirror editor. Можно обобщить:
- Переименовать в `EditorErrorBoundary`
- Убрать diff-специфичные пропы (`oldString`, `newString`)
- Добавить generic error info display

**Оценка надёжности: 9/10**
**Оценка уверенности: 9/10**

### 1.5 UI примитивы

Прямое переиспользование без изменений:

| Компонент | Путь | Применение |
|-----------|------|-----------|
| `ErrorBoundary` | `src/renderer/components/common/ErrorBoundary.tsx` | Обёртка всего редактора |
| `CopyablePath` | `src/renderer/components/common/CopyablePath.tsx` | Путь к файлу в header |
| `CopyButton` | `src/renderer/components/common/CopyButton.tsx` | Копирование содержимого |
| `ConfirmDialog` | `src/renderer/components/common/ConfirmDialog.tsx` | "Save before close?" |
| `Tooltip` | `src/renderer/components/ui/tooltip.tsx` | Тултипы на кнопках toolbar |
| `Button` | `src/renderer/components/ui/button.tsx` | Кнопки toolbar |
| `Dialog` | `src/renderer/components/ui/dialog.tsx` | Мелкие модалки (settings) |
| `Tabs` | `src/renderer/components/ui/tabs.tsx` | Табы открытых файлов |

### 1.6 Компоненты review, которые НЕ стоит переиспользовать

- `ReviewToolbar` -- слишком review-специфичен (accept/reject/apply counters)
- `ContinuousScrollView` -- scroll-spy для diff-review, не подходит для редактора
- `FileSectionDiff` / `FileSectionHeader` -- привязаны к diff workflow
- `ViewedProgressBar` -- review-only
- `ConflictDialog` -- review-only

---

## 2. Существующие IPC каналы

### 2.1 Уже есть -- файловые операции

| Канал | Файл | Что делает | Применимость |
|-------|------|-----------|-------------|
| `review:saveEditedFile` | `src/main/ipc/review.ts` | Сохраняет файл на диск (`filePath`, `content`) | **УЯЗВИМОСТЬ: нет валидации пути!** НЕ переиспользовать без исправления (см. SEC-11). Для editor -- отдельный канал с валидацией |
| `review:getFileContent` | `src/main/ipc/review.ts` | Читает файл + original + modified | Частично -- нужна упрощённая версия |
| `read-mentioned-file` | `src/main/ipc/utility.ts` | Читает файл по абсолютному пути с валидацией | Можно использовать, но ограничен `maxTokens` |
| `shell:openPath` | `src/main/ipc/utility.ts` | Открывает файл в системном приложении | "Open in external editor" |
| `shell:showInFolder` | `src/main/ipc/utility.ts` | Показывает файл в Finder | "Reveal in Finder" |

### 2.2 Чего НЕТ -- нужно создать

Для полноценного редактора проекта нужны **новые IPC каналы**:

1. **`editor:listDirectory(dirPath)`** -- рекурсивный listing файлов (с ignore-паттернами: `.git`, `node_modules`, etc.)
2. **`editor:readFile(filePath)`** -- чтение файла без ограничений `maxTokens` (в отличие от `read-mentioned-file`)
3. **`editor:saveFile(filePath, content)`** -- можно переиспользовать `review:saveEditedFile`, но лучше отдельный канал с более широкой валидацией
4. **`editor:createFile(filePath, content?)`** -- создание нового файла
5. **`editor:deleteFile(filePath)`** -- удаление файла (с `confirm` на renderer стороне)
6. **`editor:renameFile(oldPath, newPath)`** -- переименование
7. **`editor:watchDirectory(dirPath)`** -- подписка на изменения в директории (для обновления file tree)

**Паттерн регистрации** (из `src/main/ipc/review.ts`):
```typescript
// Module-level state + guard
let service: EditorService | null = null;
function getService(): EditorService { ... }

// Forward-compatible config object
export interface EditorHandlerDeps { ... }
export function initializeEditorHandlers(deps: EditorHandlerDeps): void { ... }
export function registerEditorHandlers(ipcMain: IpcMain): void { ... }
export function removeEditorHandlers(ipcMain: IpcMain): void { ... }
```

**Каналы в `ipcChannels.ts`** -- плоские `export const`, НЕ объект (подтверждено в MEMORY.md).

**Оценка надёжности: 8/10** -- паттерн отработан на 20+ модулях.
**Оценка уверенности: 9/10**

---

## 3. Zustand-паттерн для Editor Slice

### 3.1 Существующий паттерн slice'ов

**Файл:** `/Users/belief/dev/projects/claude/claude_team/src/renderer/store/types.ts`

18 slice'ов, объединённых через intersection type. Каждый slice:
```typescript
export interface SomeSlice {
  // Data
  someData: T[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;

  // Actions
  fetchData: () => Promise<void>;
  selectItem: (id: string | null) => void;
}

export const createSomeSlice: StateCreator<AppState, [], [], SomeSlice> = (set, get) => (
  // initial state + actions
});
```

### 3.2 Рекомендуемая структура EditorSlice

```typescript
export interface EditorSlice {
  // State
  editorProjectPath: string | null;     // Текущий проект
  editorFileTree: FileTreeNode[];       // Дерево файлов
  editorFileTreeLoading: boolean;
  editorOpenFiles: OpenFile[];          // Открытые файлы (табы)
  editorActiveFilePath: string | null;  // Активный файл
  editorDirtyFiles: Set<string>;        // Файлы с несохранёнными изменениями
  editorError: string | null;

  // File content cache (path -> content)
  editorFileContents: Record<string, string>;
  editorFileContentsLoading: Record<string, boolean>;

  // Actions
  openEditor: (projectPath: string) => Promise<void>;
  closeEditor: () => void;
  loadFileTree: (dirPath: string) => Promise<void>;
  openFile: (filePath: string) => Promise<void>;
  closeFile: (filePath: string) => void;
  setActiveFile: (filePath: string) => void;
  updateFileContent: (filePath: string, content: string) => void;
  saveFile: (filePath: string) => Promise<void>;
  saveAllDirty: () => Promise<void>;
}
```

**Важно:** Следовать правилу из CLAUDE.md -- "Store over Props": дочерние компоненты читают из store напрямую через `useStore()`.

**Куда добавить:**
1. `src/renderer/store/slices/editorSlice.ts` -- новый slice
2. Добавить `EditorSlice` в `AppState` type в `types.ts`
3. Добавить `...createEditorSlice(...args)` в `store/index.ts`

**Оценка надёжности: 9/10**
**Оценка уверенности: 9/10**

### 3.3 Ближайший аналог -- `changeReviewSlice`

**Файл:** `/Users/belief/dev/projects/claude/claude_team/src/renderer/store/slices/changeReviewSlice.ts`

Этот slice ближе всего к будущему `editorSlice`:
- `fileContents: Record<string, FileChangeWithContent>` -- кеш содержимого файлов
- `fileContentsLoading: Record<string, boolean>` -- состояние загрузки per-file
- `editedContents: Record<string, string>` -- несохранённые изменения
- `saveEditedFile(filePath)` -- сохранение на диск
- `discardFileEdits(filePath)` -- отмена изменений
- Debounced persistence

---

## 4. CSS/Theme -- переиспользование

### 4.1 Существующие CSS-переменные

**Файл:** `/Users/belief/dev/projects/claude/claude_team/src/renderer/index.css`

Полностью подходят для редактора:

| Категория | Переменные | Применение в редакторе |
|-----------|-----------|----------------------|
| Surfaces | `--color-surface`, `--color-surface-raised`, `--color-surface-sidebar` | Фон редактора, sidebar, header |
| Borders | `--color-border`, `--color-border-subtle`, `--color-border-emphasis` | Разделители панелей |
| Text | `--color-text`, `--color-text-secondary`, `--color-text-muted` | Текст в file tree, status bar |
| Code | `--code-bg`, `--code-border`, `--code-line-number`, `--code-filename` | Фон редактора, номера строк |
| Syntax | `--syntax-string`, `--syntax-comment`, `--syntax-keyword` и т.д. | Подсветка синтаксиса |
| Inline code | `--inline-code-bg`, `--inline-code-text` | Инлайн код в markdown |
| Scrollbar | `--scrollbar-thumb`, `--scrollbar-thumb-hover` | Скроллбар в file tree |
| Card | `--card-bg`, `--card-border`, `--card-header-bg` | Панели, headers |
| Skeleton | `--skeleton-base`, `--skeleton-base-light` | Loading state |

### 4.2 Тема CodeMirror

`diffTheme` в `CodeMirrorDiffView.tsx` (строки 158-283) уже использует CSS-переменные:
```typescript
'&': {
  backgroundColor: 'var(--color-surface)',
  color: 'var(--color-text)',
  fontFamily: 'ui-monospace, SFMono-Regular, ...',
  fontSize: '13px',
},
'.cm-gutters': {
  backgroundColor: 'var(--color-surface)',
  borderRight: '1px solid var(--color-border)',
  ...
}
```

Нужно извлечь **базовую тему** (без diff-стилей `.cm-changedLine`, `.cm-deletedChunk` и т.д.) -- примерно 40% от текущей темы.

### 4.3 Light theme

Поддержка есть через `:root.light` override'ы в `index.css`. Если `diffTheme` использует CSS-переменные (а он использует), то light theme заработает автоматически.

---

## 5. CodeMirror vs ProseMirror

### 5.1 CodeMirror 6 -- уже в проекте

**Из `package.json`:**
```json
"@codemirror/autocomplete": "^6.20.0",
"@codemirror/commands": "^6.10.2",
"@codemirror/lang-cpp", "@codemirror/lang-css", "@codemirror/lang-go",
"@codemirror/lang-html", "@codemirror/lang-java", "@codemirror/lang-javascript",
"@codemirror/lang-json", "@codemirror/lang-less", "@codemirror/lang-markdown",
"@codemirror/lang-php", "@codemirror/lang-python", "@codemirror/lang-rust",
"@codemirror/lang-sass", "@codemirror/lang-sql", "@codemirror/lang-xml",
"@codemirror/lang-yaml",
"@codemirror/language", "@codemirror/language-data",
"@codemirror/merge", "@codemirror/state",
"@codemirror/theme-one-dark", "@codemirror/view"
```

Это **16 языковых пакетов** + `@codemirror/language-data` (ещё ~30 языков async). Плюс `@codemirror/autocomplete` уже установлен.

### 5.2 Рекомендация: ТОЛЬКО CodeMirror 6

**Однозначно CodeMirror 6, НЕ ProseMirror.** Причины:

1. **Уже 20+ пакетов CodeMirror в зависимостях** -- нулевой overhead по bundle size
2. **Работающая инфраструктура**: `getSyncLanguageExtension()`, `getAsyncLanguageDesc()`, тема, Compartment-паттерн -- всё протестировано в production
3. **`@codemirror/autocomplete`** уже установлен -- автодополнение из коробки
4. **CodeMirror = код-редактор**, ProseMirror = rich text / WYSIWYG. Для проектного редактора нужен именно код-редактор
5. **ProseMirror добавил бы ~150-200KB** в bundle + совершенно новая экосистема плагинов

**Не нужно добавлять НИКАКИХ новых зависимостей** для базового редактора. Всё есть.

**Оценка надёжности: 10/10** -- CodeMirror 6 зрелый, используется в VSCode, Chrome DevTools
**Оценка уверенности: 10/10** -- ProseMirror для code editing = антипаттерн

---

## 6. Anti-patterns и риски

### 6.1 Размер компонентов

**Проблема:** `ChangeReviewDialog.tsx` -- **677 строк**. `CodeMirrorDiffView.tsx` -- **809 строк**. Оба на грани допустимого.

**Рекомендация для Editor:**
- `ProjectEditor.tsx` -- max 150 строк (layout shell, делегирует всё дочерним)
- `EditorFileTree.tsx` -- max 200 строк
- `EditorTabBar.tsx` -- max 100 строк
- `EditorCodePane.tsx` -- max 150 строк (обёртка вокруг CodeMirror)
- `EditorToolbar.tsx` -- max 100 строк
- Хуки (`useEditorKeyboard`, `useEditorFileOps`) -- по 50-100 строк

### 6.2 Performance с большими файлами

**Проблема:** CodeMirror 6 virtual scrolling работает, но:
- Файлы >5MB могут замедлить парсинг языка
- `readFile` через IPC сериализует содержимое как JSON string -- большие файлы замедляют IPC

**Рекомендация:**
- Лимит чтения: ~2MB (показывать "File too large, open externally")
- `EditorView.scrollPastEnd` -- чтобы пользователь мог скроллить ниже конца файла
- Lazy language loading через Compartment (уже реализовано в `CodeMirrorDiffView`)

### 6.3 Dirty state и unsaved changes

**Проблема:** `changeReviewSlice` хранит `editedContents` как `Record<string, string>` -- весь контент файла в памяти per-dirty-file. При 10+ грязных файлах это может быть гигабайт RAM.

**Рекомендация:**
- Хранить ТОЛЬКО для активного файла + 2-3 соседних табов (LRU cache)
- Для остальных -- хранить `EditorState` объект CodeMirror (он уже в памяти CM)
- При переключении табов -- сохранять `EditorState` (включая undo history), не строку

### 6.4 File watching race conditions

**Проблема:** Если пользователь редактирует файл в нашем редакторе, а CLI-агент одновременно меняет его через `review:saveEditedFile` -- конфликт.

**Рекомендация:**
- `mtime` check перед записью (как `review:checkConflict`)
- Уведомление "File changed on disk" с выбором (reload / keep mine / show diff)

### 6.5 Missing error boundaries

**Проблема:** `ErrorBoundary` в `common/` -- один на всё приложение. `DiffErrorBoundary` -- только для diff. Если CodeMirror крашится в editor mode, нужен отдельный boundary.

**Рекомендация:** Обернуть `CodeMirrorEditor` в специализированный `EditorErrorBoundary` (можно обобщить `DiffErrorBoundary`).

### 6.6 IPC parameter validation

**Проблема (CRITICAL):** В `review.ts` IPC handler `handleSaveEditedFile` **НЕ валидирует путь** -- прямой `writeFile()` без `validateFilePath()`. Это существующая уязвимость (см. секцию 10.3).

**Рекомендация:**
- **ВСЕ** IPC handlers, работающие с файлами, ОБЯЗАНЫ вызывать `validateFilePath()` из `src/main/utils/pathValidation.ts`
- Для editor: выделенный module-level `activeProjectRoot`, не принимаемый от renderer при каждом вызове
- Дополнительно: `validateFileName()` для создания файлов, `isDevicePath()` для блокировки device files, запрет записи в `.git/`
- Подробный чеклист -- в `plan-architecture.md` секция 18

---

## 7. Итоговая архитектурная рекомендация

### Что ИЗВЛЕЧЬ из существующего кода (рефакторинг):

1. `buildTree()` + `TreeNode` --> `src/renderer/utils/fileTreeBuilder.ts`
2. `getSyncLanguageExtension()` + `getAsyncLanguageDesc()` --> `src/renderer/utils/codemirrorLanguages.ts`
3. Базовая CM тема (без diff) --> `src/renderer/utils/codemirrorTheme.ts`
4. `ReviewFileTree` --> generic `FileTree` + `ReviewFileTree` wrapper

### Что СОЗДАТЬ с нуля:

1. `src/renderer/store/slices/editorSlice.ts`
2. `src/main/ipc/editor.ts` + handler'ы
3. `src/preload/constants/ipcChannels.ts` -- добавить `EDITOR_*` каналы
4. `src/preload/index.ts` -- добавить `editor` API
5. `src/renderer/components/editor/` -- компоненты редактора
6. `src/main/services/editor/EditorService.ts` -- сервис файловых операций

### Что ПЕРЕИСПОЛЬЗОВАТЬ напрямую:

- Все UI примитивы из `components/ui/`
- `ErrorBoundary`, `ConfirmDialog`, `CopyablePath`, `CopyButton`
- CSS-переменные (100% готовы)
- CodeMirror 6 пакеты (все 20+ уже в зависимостях)
- `wrapHandler<T>()` паттерн для IPC
- Zustand slice pattern

---

## 8. Архитектурная ревизия: дополнения к reuse-анализу

> Добавлено после ревизии. Конкретизирует что именно извлекать и как.

### 8.1 Обязательные рефакторинги перед реализацией

Эти рефакторинги -- не optional. Без них будет дублирование кода, нарушающее DRY:

| Что извлечь | Откуда | Куда | Строки |
|-------------|--------|------|--------|
| `buildTree()` + `collapse()` + сортировка | `ReviewFileTree.tsx:42-83` | `src/renderer/utils/fileTreeBuilder.ts` | ~50 LOC |
| `getSyncLanguageExtension()` + `getAsyncLanguageDesc()` | `CodeMirrorDiffView.tsx:64-128` | `src/renderer/utils/codemirrorLanguages.ts` | ~70 LOC |
| Базовая тема CM (без diff-стилей) | `CodeMirrorDiffView.tsx:158-198` | `src/renderer/utils/codemirrorTheme.ts` | ~40 LOC |
| `wrapReviewHandler<T>()` | `review.ts:133-145` | `src/main/ipc/ipcWrapper.ts` | ~15 LOC |

**Порядок:** Рефакторинги 1-4 выполняются ПЕРЕД написанием нового кода итерации 1.
`ReviewFileTree.tsx` и `CodeMirrorDiffView.tsx` начинают импортировать из новых утилит.
Тесты этих компонентов должны продолжать проходить (zero behavior change).

### 8.2 Расхождения между файлами планов (исправлены)

| Расхождение | plan-architecture.md | plan-iterations.md | Решение |
|-------------|---------------------|-------------------|---------|
| Имя сервиса | `FileEditorService` | `ProjectFileService` | `ProjectFileService` |
| Stateful/Stateless | `constructor(rootPath)` | Не указано | Stateless, `projectRoot` как аргумент |
| Security | Свой `assertInsideRoot()` | `validateFilePath()` | `validateFilePath()` из `pathValidation.ts` |
| editorSlice в итерации 1 | Да | Нет (хук `useEditorState`) | Нет slice в итерации 1, useState достаточно |
| `useEditorState.ts` хук | Не упомянут | Создаётся в итерации 2 | Убран, вся логика в slice |
| Overlay name | `CodeEditorOverlay` | `ProjectEditorOverlay` | `ProjectEditorOverlay` (лучше отражает scope) |

### 8.3 Review FileTree: конкретный план generic extraction

Текущий `ReviewFileTree.tsx` (~377 строк) содержит:
- `TreeNode` тип -- generic (name, fullPath, isFile, children, file?)
- `buildTree()` -- generic (принимает `files` с `.relativePath`)
- `collapse()` -- generic (одноуровневый collapse)
- `TreeItem` -- review-specific (FileStatusIcon, +/- lines, viewedSet, hunkDecisions)
- `getFileStatus()` -- review-specific
- `ReviewFileTree` -- review-specific (reads from store: hunkDecisions, fileDecisions)

**Plan для generic `FileTree`:**
```
src/renderer/utils/fileTreeBuilder.ts:
  - export type TreeNode<T = unknown> = { name, fullPath, isFile, data?: T, children }
  - export function buildTree<T>(items: T[], getRelativePath: (item: T) => string): TreeNode<T>[]
  - export function sortTreeNodes<T>(nodes: TreeNode<T>[]): TreeNode<T>[]

src/renderer/components/common/FileTree.tsx:
  - Generic FileTree<T> component
  - Props: nodes, activeNodePath, onNodeClick, renderNodeExtra?, renderNodeIcon?
  - Internal: TreeItem (renders folder/file, delegation через render-props)
  - Handles: collapsedFolders, toggleFolder, auto-expand ancestors, auto-scroll

src/renderer/components/team/review/ReviewFileTree.tsx:
  - Thin wrapper around FileTree<FileChangeSummary>
  - Provides renderNodeExtra with FileStatusIcon + +/- lines
  - Reads hunkDecisions/fileDecisions from store

src/renderer/components/team/editor/EditorFileTree.tsx:
  - Thin wrapper around FileTree<FileTreeEntry>
  - Provides renderNodeExtra with dirty marker
  - Provides renderNodeIcon with file type icons
  - Context menu integration
```

### 8.4 SOLID compliance checklist

- [x] SRP: FileTreePanel -- UI only, data loading in slice
- [x] SRP: CodeMirrorEditor -- lifecycle only, extensions in builder
- [x] OCP: FileTree -- generic with render-props
- [x] LSP: FileTreeNode extends FileTreeEntry (no field duplication)
- [x] ISP: EditorSlice split into 4 documented groups
- [x] DIP: Extensions via factory, not hardcoded in component
- [x] DRY: buildTree, language detection, theme, wrapHandler -- all extracted
- [x] Clean Architecture: dependency flow verified, no backward deps

---

---

## 9. UX Review: дополнения к reuse-анализу

> Добавлено после UX-ревью. Что ещё нужно переиспользовать/создать для качественного UX.

### 9.1 Дополнительные компоненты для переиспользования

| Компонент | Путь | Применение в редакторе |
|-----------|------|----------------------|
| `KeyboardShortcutsHelp` | `review/KeyboardShortcutsHelp.tsx` | Модальное окно со списком shortcuts (кнопка `?` в header) |
| `confirm()` imperative API | `common/ConfirmDialog.tsx` | "Save before close?" при Escape с unsaved changes |

### 9.2 Новые утилиты, вызванные UX-требованиями

| Утилита | Путь | Зачем |
|---------|------|-------|
| `tabLabelDisambiguation.ts` | `src/renderer/utils/` | Показ "(main/utils)" для дублей `index.ts` в табах |
| `binaryDetector.ts` | `src/main/utils/` | Определение бинарных файлов (null bytes в первых 8KB) |

### 9.3 Новые компоненты, вызванные UX-требованиями

| Компонент | Описание |
|-----------|----------|
| `EditorStatusBar.tsx` | Нижняя полоска: Ln:Col, язык, отступы, кодировка |
| `EditorBinaryState.tsx` | Заглушка для бинарных файлов вместо CM6 |
| `EditorErrorState.tsx` | Заглушка для файлов с ошибкой чтения (EACCES, ENOENT) |
| `EditorShortcutsHelp.tsx` | Модальное окно shortcuts (или переиспользовать `KeyboardShortcutsHelp`) |

### 9.4 CSS-переменные -- что уже есть, чего не хватает

**Уже есть (полностью достаточно):**
- `--color-surface`, `--color-surface-sidebar`, `--color-surface-raised` -- для background
- `--color-border`, `--color-border-subtle`, `--color-border-emphasis` -- для разделителей
- `--color-text`, `--color-text-secondary`, `--color-text-muted` -- для текста
- `--code-*`, `--syntax-*` -- для CodeMirror
- `--scrollbar-*` -- для скроллбара
- `--card-*` -- для панелей

**Не хватает (рекомендация: добавить в `:root` в `index.css`):**
```css
/* Editor-specific */
--editor-tab-active-bg: var(--color-surface);
--editor-tab-inactive-bg: var(--color-surface-sidebar);
--editor-tab-modified-dot: #f59e0b;         /* amber для modified indicator */
--editor-tab-border: var(--color-border);
--editor-statusbar-bg: var(--color-surface-sidebar);
--editor-statusbar-text: var(--color-text-muted);
--editor-sidebar-resize-handle: rgba(148, 163, 184, 0.15);
--editor-sidebar-resize-handle-hover: rgba(148, 163, 184, 0.3);
```
Это обеспечит консистентность с остальными CSS-переменными проекта и лёгкую кастомизацию.

### 9.5 Accessibility -- что переиспользовать из существующего

`ReviewFileTree.tsx` (строка 232) имеет `aria-label` на expand/collapse. Это МИНИМУМ. При извлечении generic `FileTree` нужно сразу добавить:
- `role="tree"` на корневой `<ul>`
- `role="treeitem"` + `aria-expanded` на каждой папке
- `role="group"` на вложенных `<ul>`
- `role="treeitem"` + `aria-selected` на файлах
- Keyboard navigation (arrow keys) -- в `FileTree`, не в обёртках

Это не "nice to have" -- это требование WCAG 2.1 Level A для tree view.

---

---

## 10. Security Review: дополнения к reuse-анализу

> Полный аудит безопасности описан в `plan-architecture.md` секция 18. Здесь -- что из существующего кода переиспользовать для безопасности, и обнаруженные проблемы в текущем коде.

### 10.1 Переиспользуемые security-утилиты

| Утилита | Путь | Что делает | Как использовать |
|---------|------|-----------|-----------------|
| `validateFilePath()` | `src/main/utils/pathValidation.ts` | Path traversal, symlink escape, sensitive patterns | КАЖДЫЙ IPC handler ОБЯЗАН вызывать |
| `SENSITIVE_PATTERNS` | `src/main/utils/pathValidation.ts` | Regex-массив: `.env`, `.ssh`, `*.key`, `*.pem` и т.д. | Автоматически через `validateFilePath()` |
| `resolveRealPathIfExists()` | `src/main/utils/pathValidation.ts` | `fs.realpathSync.native()` с обработкой ENOENT | Автоматически через `validateFilePath()` |
| `isPathWithinAllowedDirectories()` | `src/main/utils/pathValidation.ts` | Containment check с cross-platform support | Автоматически через `validateFilePath()` |
| `isPathContained()` | `src/main/ipc/validation.ts` | Простая containment check (normalize + startsWith) | НЕ использовать отдельно -- `validateFilePath` полнее |

### 10.2 Чего НЕ хватает в существующих утилитах (нужно создать для editor)

| Утилита | Описание | Зачем |
|---------|----------|-------|
| `validateFileName(name)` | Валидация имени файла при создании | Запрет `.`, `..`, control chars, path separators, NUL, length > 255 |
| `isDevicePath(path)` | Проверка на `/dev/`, `/proc/`, `/sys/` | Блокировка device files до `fs.readFile()` |
| `isGitInternalPath(path)` | Проверка на `.git/` в пути | Запрет записи в `.git/` (чтение -- ОК) |
| `atomicWriteFile(path, content)` | Atomic write через tmp + rename | Защита от corrupt при crash/disk full |

Рекомендация: добавить в `src/main/utils/pathValidation.ts` (validateFileName, isDevicePath, isGitInternalPath) и `src/main/utils/atomicWrite.ts` (atomicWriteFile).

### 10.3 Обнаруженная уязвимость в review.ts (Critical, existing!)

**При анализе `review.ts` (секция 2.1 reuse-анализа) обнаружена уязвимость:**

`handleSaveEditedFile` (строка 254 `review.ts`) принимает `filePath` от renderer и передаёт в `ReviewApplierService.saveEditedFile()` (строка 320 `ReviewApplierService.ts`), который вызывает `writeFile(filePath, content, 'utf8')` **БЕЗ КАКОЙ-ЛИБО ВАЛИДАЦИИ ПУТИ**.

Текущий код:
```typescript
// review.ts:254
async function handleSaveEditedFile(_event, filePath, content) {
  if (!filePath || typeof content !== 'string') {
    return { success: false, error: 'Invalid parameters' };
  }
  // УЯЗВИМОСТЬ: filePath НЕ проверяется через validateFilePath()
  return wrapReviewHandler('saveEditedFile', async () => {
    const result = await getApplier().saveEditedFile(filePath, content);
    // ...
  });
}

// ReviewApplierService.ts:320
async saveEditedFile(filePath: string, content: string) {
  // УЯЗВИМОСТЬ: прямая запись без валидации
  await writeFile(filePath, content, 'utf8');
  return { success: true };
}
```

**Импакт**: Скомпрометированный renderer может записать произвольный файл куда угодно в ФС.

**Решение**: Добавить `validateFilePath(filePath, projectRoot)` в `handleSaveEditedFile`. Нужен hotfix НЕЗАВИСИМО от editor-фичи.

### 10.4 Security-паттерн для editor IPC (обязательный)

```typescript
// src/main/ipc/editor.ts -- каждый handler ОБЯЗАН следовать этому паттерну:

let activeProjectRoot: string | null = null; // module-level, set by editor:open

async function handleEditorReadFile(
  _event: IpcMainInvokeEvent,
  filePath: string // от renderer
): Promise<IpcResult<ReadFileResult>> {
  return wrapHandler('readFile', async () => {
    if (!activeProjectRoot) throw new Error('Editor not initialized');

    // 1. Path validation (traversal, sensitive, symlink)
    const validation = validateFilePath(filePath, activeProjectRoot);
    if (!validation.valid) throw new Error(validation.error!);

    // 2. Device path block
    if (isDevicePath(validation.normalizedPath!)) throw new Error('Device files blocked');

    // 3. File type check
    const stats = await fs.lstat(validation.normalizedPath!);
    if (!stats.isFile()) throw new Error('Not a regular file');

    // 4. Size check
    if (stats.size > MAX_FILE_SIZE) throw new Error('File too large');

    // 5. Read
    const content = await fs.readFile(validation.normalizedPath!, 'utf8');

    // 6. Post-read TOCTOU verify
    const realPath = await fs.realpath(validation.normalizedPath!);
    const postValidation = validateFilePath(realPath, activeProjectRoot);
    if (!postValidation.valid) throw new Error('Path changed during read');

    return { content, size: stats.size, truncated: false, encoding: 'utf-8' };
  });
}
```

---

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- `/Users/belief/dev/projects/claude/claude_team/src/renderer/components/team/review/ReviewFileTree.tsx` - FileTree logic to extract (buildTree algorithm, TreeNode type, collapse/expand)
- `/Users/belief/dev/projects/claude/claude_team/src/renderer/components/team/review/CodeMirrorDiffView.tsx` - CodeMirror infrastructure to extract (language detection, theme, Compartment pattern)
- `/Users/belief/dev/projects/claude/claude_team/src/renderer/store/slices/changeReviewSlice.ts` - Pattern to follow for editorSlice (fileContents cache, editedContents, saveEditedFile)
- `/Users/belief/dev/projects/claude/claude_team/src/main/ipc/review.ts` - IPC handler pattern to follow (wrapHandler, module-level state, deps injection) + EXISTING VULNERABILITY in saveEditedFile
- `/Users/belief/dev/projects/claude/claude_team/src/main/utils/pathValidation.ts` - Security validation to REUSE (not rewrite) -- validateFilePath, SENSITIVE_PATTERNS, symlink resolution

---

## Performance-Critical Reuse Notes

> Дополнение после Performance Review (plan-architecture.md секция 19). Конкретные performance-аспекты при переиспользовании кода.

### CodeMirrorDiffView -- что НЕ копировать

**`editorViewMapRef` из ChangeReviewDialog (строка 91)** хранит `Map<string, EditorView>` для всех видимых файлов в continuous scroll view. Это допустимо для review (10-50 файлов одновременно), но **НЕДОПУСТИМО** для editor с 20+ табами.

Для editor использовать **EditorState pooling**:
```typescript
// ПРАВИЛЬНО для editor:
const stateCache = useRef(new Map<string, EditorState>());
const viewRef = useRef<EditorView | null>(null);

// При переключении таба:
stateCache.current.set(oldTabId, viewRef.current!.state);
viewRef.current!.destroy();
viewRef.current = new EditorView({
  state: stateCache.current.get(newTabId)!,
  parent: containerRef.current!,
});
```

Паттерн `initialState` из CodeMirrorDiffView (строка 56, 699-705) -- это именно то, что нужно.

### changeReviewSlice -- что НЕ копировать

**`editedContents: Record<string, string>`** (строка 74) хранит полный текст каждого редактированного файла в Zustand. В review это терпимо (изменения применяются и сбрасываются). Для editor каждый keystroke вызывает `set()` с новым Record -- все Zustand-подписчики перерисовываются.

Для editor **контент живёт только в EditorState**, не в Zustand. В store хранить:
```typescript
editorModifiedFiles: Set<string>  // dirty flags, не содержимое
```

### @tanstack/react-virtual -- использовать для FileTree

Уже в проекте. Примеры:
- `DateGroupedSessions.tsx` -- виртуализация списка сессий
- `ChatHistory.tsx` -- виртуализация чата
- `NotificationsView.tsx` -- виртуализация уведомлений

Для FileTree (итерация 4): `flattenTree() -> FlatNode[]` + `useVirtualizer()`.

### MembersJsonEditor -- правильный lifecycle паттерн

`MembersJsonEditor.tsx` (строки 27-73) -- **образцовый** паттерн для editor:
1. `EditorState.create()` с extensions
2. `new EditorView({ state, parent })` -- один раз при mount
3. `view.destroy()` -- в cleanup useEffect
4. Обновление doc через `view.dispatch({ changes: ... })` -- при prop change
5. `onChangeRef.current = onChange` -- для callback без re-create view

Этот паттерн масштабировать до EditorState pooling (Map вместо одного state).
