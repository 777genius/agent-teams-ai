# Требуемый ресёрч

> Зафиксировано после 4-агентного ревью плана. Каждый пункт — пробел в знаниях, без закрытия которого реализация рискованна.

## R1: Scope isolation горячих клавиш

**Проблема**: 6 из 12 шорткатов (`Cmd+W`, `Cmd+B`, `Cmd+F`, `Cmd+Shift+[/]`, `Ctrl+Tab`) конфликтуют с глобальными в `useKeyboardShortcuts.ts`.

**Нужно выяснить**:
- Как CM6 keymaps (через `keymap.of()`) взаимодействуют с глобальным `window.addEventListener('keydown')`?
- Останавливает ли CM6 propagation события?
- Какой паттерн используют VS Code / другие Electron-editors для scope isolation?
- Варианты: guard `isEditorOpen` в глобальном хуке? KeyboardEvent stack? Priority system?

**Статус**: COMPLETED

**Результат**:
- Глобальный handler в `useKeyboardShortcuts.ts` использует `window.addEventListener('keydown')` в bubble phase (строка 278)
- CM6 использует bubble phase на `.cm-content`, вызывает `preventDefault()` но НЕ `stopPropagation()` по умолчанию
- CM6 поддерживает `stopPropagation: true` опцию per keybinding
- `ChangeReviewDialog` уже использует capture-phase handler с guard (строки 379-408)
- **Рекомендация: Approach A** — Guard в глобальном handler с флагом `editorOverlayOpen` в store (~20-30 LOC, надёжность 8/10)
  - В `useKeyboardShortcuts.ts`: `const editorOpen = useStore(s => s.editorProjectPath !== null);` → early return для конфликтующих shortcuts
  - Плюс: добавить `stopPropagation: true` к CM6 keybindings как safety net
- Конкретные конфликты: `Cmd+W` (строка 155), `Cmd+B` (271), `Cmd+F` (241), `Cmd+Shift+[/]` (177), `Ctrl+Tab` (81)

---

## R2: CM6 Compartment + EditorState pooling

**Проблема**: План хранит Compartments в `useRef` (один экземпляр) и использует для 30+ EditorState в пуле. CM6 может не поддерживать sharing одного Compartment между разными EditorState.

**Нужно выяснить**:
- Документация CM6: привязан ли Compartment к конкретному EditorState?
- Что происходит при `compartment.of(X)` в extensions для разных EditorState?
- Что происходит при `dispatch({ effects: compartment.reconfigure(Y) })` если другой state в кэше использует тот же Compartment?
- Паттерн из CodeMirrorDiffView: один View + один State — работает, но не pooling.
- Альтернатива: Compartment-per-state в Map (рядом с EditorState).

**Статус**: COMPLETED

**Результат**:
- **Compartment — opaque identity token** без внутреннего state. Подтверждено Marijn Haverbeke (автор CM6): "Compartments can be shared without issue"
- Каждый EditorState имеет свой `Map<Compartment, Extension>` в config
- `reconfigure()` на одном View не влияет на cached states в пуле
- **Рекомендация: Option A** — Общие Compartment-инстансы для всех states (надёжность 9/10)
  - useRef Compartments безопасны для sharing: `readOnlyCompartment.current.of(...)` в extensions для каждого нового EditorState
  - При unmount+remount: кешированные states ссылаются на старые Compartments → при remount создать новые Compartments, заново создать EditorState для активного таба
  - LRU eviction теряет undo history (ожидаемо), cursor сохраняется через EditorSelection

---

## R3: Store ↔ Component ref bridge (closeEditor + saveAllFiles)

**Проблема**: `closeEditor()` и `saveAllFiles()` в Zustand action должны работать с `stateCache` и `viewRef` из useRef компонента CodeMirrorEditor. Zustand actions не имеют доступа к React refs.

**Нужно выяснить**:
- Как существующий код решает аналогичные проблемы (например, terminal cleanup)?
- Варианты: (a) global ref registry; (b) store хранит cleanup callback через `registerCleanup(fn)`; (c) компонент слушает `editorProjectPath === null` в useEffect и делает cleanup сам; (d) zustand subscribe в компоненте.
- Какой вариант минимально инвазивен и надёжен при unmount?

**Статус**: COMPLETED

**Результат**:
Существующие паттерны в кодовой базе:
- `MembersJsonEditor` — компонент владеет lifecycle полностью
- `CodeMirrorDiffView` — внешний ref holder
- `changeReviewSlice` — module-level state (строки 5-12)
- `ConfirmDialog` — singleton-регистрация с module-level `globalSetState`
- `ChangeReviewDialog` — компонент оркестрирует

**Рекомендация: Hybrid C+D** — `editorBridge.ts` module-level singleton (надёжность 9/10):
```typescript
// src/renderer/utils/editorBridge.ts (module-level)
let stateCache: Map<string, EditorState> | null = null;
let scrollTopCache: Map<string, number> | null = null;
let viewRef: EditorView | null = null;

export const editorBridge = {
  register(sc, stc, v) { stateCache = sc; scrollTopCache = stc; viewRef = v; },
  unregister() { stateCache = null; scrollTopCache = null; viewRef = null; },
  getContent(filePath) { return stateCache?.get(filePath)?.doc.toString() ?? null; },
  getAllModifiedContent(modifiedFiles) { /* iterate stateCache */ },
  destroy() { viewRef?.destroy(); stateCache?.clear(); scrollTopCache?.clear(); },
};
```
- Компонент вызывает `register()` при mount, `unregister()` при unmount
- Store actions (closeEditor, saveAllFiles) используют `editorBridge.getContent()` / `editorBridge.destroy()`
- `saveAllFiles`: компонент итерирует и вызывает `store.saveFile()` для каждого (паттерн ChangeReviewDialog)
- `discardChanges`: store делает IPC read, компонент применяет через `view.dispatch({ changes })`

---

## R4: fs.watch recursive на Linux + watcher reliability

**Проблема**: `fs.watch({ recursive: true })` экспериментальный на Linux в Node.js 18. Может тихо не работать. Нет fallback.

**Нужно выяснить**:
- Какую версию Node.js использует Electron 40? Поддерживается ли `recursive: true` на Linux?
- Существующий `FileWatcher.ts` в проекте: использует ли он `recursive: true`? Есть ли fallback?
- Альтернативы: chokidar (но добавляет зависимость), polling, non-recursive watch + manual traversal.
- `max_user_watches` лимит inotify — как обойти?
- macOS FSEvents: coalescing events — как существующий FileWatcher решает это?

**Статус**: COMPLETED

**Результат**:
- **Electron 40 = Node.js 24 (LTS)** — `recursive: true` работает на macOS (FSEvents, надёжность 9/10) и Linux (inotify, надёжность 6/10)
- Существующий `FileWatcher.ts` (1098 строк) — зрелый watcher с debounce (строки 1060-1074), recovery (424-457), catch-up scan (992-1051)
- **НЕ добавлять chokidar** — использовать паттерны из FileWatcher.ts
- macOS: fs.watch recursive reliable (FSEvents), burst coalescing для git checkout сценариев
- Linux: `ENOSPC` → fallback на polling (5-10 секунд интервал)
- `max_user_watches` лимит inotify: при ENOSPC не падать, а деградировать до polling
- **Рекомендация**: EditorFileWatcher ~250-300 LOC (вместо первоначальных ~60 LOC), включая:
  - Burst coalescing (200ms debounce + batch)
  - ENOSPC fallback to polling
  - Фильтрация: node_modules/.git/dist
  - Graceful stop/restart

---

## R5: Git CLI availability & performance

**Проблема**: `git status --porcelain` без проверки наличия git. На больших монорепо — десятки секунд. Non-git проекты не обработаны.

**Нужно выяснить**:
- Есть ли в проекте утилита проверки наличия git? (проверить существующие git-related сервисы)
- `git status --porcelain` performance: `--untracked-files=no` ускоряет? `--ignore-submodules`?
- Timeout стратегия: AbortSignal + child_process?
- Graceful degradation: что показывать если git недоступен / не git-repo?
- `.git/index.lock` — как обрабатывать concurrent git operations?

**Статус**: COMPLETED

**Результат**:
- **`isGitRepo()`** уже есть в `GitDiffFallback.ts` (строки 118-133) — переиспользовать
- Оптимальная команда: `git --no-optional-locks status --porcelain -z --untracked-files=normal --ignore-submodules`
  - `--no-optional-locks` — критично, предотвращает `.git/index.lock` конфликты
  - `-z` — NUL-separated вывод (безопасный парсинг путей с пробелами)
  - `--ignore-submodules` — ускорение на монорепо
- Timeout: 10 секунд (паттерн из GitDiffFallback.ts), AbortSignal
- Добавить `'conflict'` статус в `GitFileStatus` для merge conflicts (`UU`, `AA`, `DD` коды)
- Graceful degradation: проверить git available → проверить is repo → timeout handling
  - Нет git: скрыть git бейджи, показать "Git not available" в status bar
  - Не git-repo: скрыть git бейджи
  - Timeout: показать "Git status unavailable" + кнопка retry
- **GitStatusService ~200-250 LOC**, EditorFileWatcher **~250-300 LOC**
