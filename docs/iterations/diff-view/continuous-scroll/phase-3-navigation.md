# Phase 3: Click-to-Scroll + Навигация

## Обзор

Фаза 3 адаптирует навигацию для continuous scroll mode. В текущей реализации (file-at-a-time) каждый файл показывается отдельно: `goToNextFile()` вызывает `onSelectFile()`, который уничтожает текущий EditorView и создаёт новый. В continuous mode все файлы видны одновременно в одном scroll container, поэтому навигация переключается на программный scroll.

**Ключевые изменения:**
- Клик по файлу в sidebar = smooth scroll к секции файла (вместо уничтожения/создания editor)
- Keyboard shortcuts (Alt+ArrowDown/Up) = scroll к следующему/предыдущему файлу
- Cross-file hunk navigation: при достижении последнего hunk файла -- автоматический scroll к следующему файлу
- `useDiffNavigation` работает с `Map<string, EditorView>` вместо одного `editorViewRef`
- Публичный интерфейс `DiffNavigationState` НЕ меняется -- изменяется только внутренняя реализация

**Зависимости:** Phase 1 (ContinuousScrollView, useVisibleFileSection, useContinuousScrollNav) и Phase 2 (lazy loading, EditorView Map из Phase 1).

---

## Модификации

### 1. useDiffNavigation.ts -- полная переработка для continuous mode

**Файл:** `src/renderer/hooks/useDiffNavigation.ts`

#### Текущая сигнатура (без изменений)

```typescript
import { useCallback, useEffect, useRef, useState } from 'react';

import { acceptChunk, goToNextChunk, goToPreviousChunk } from '@codemirror/merge';

import type { EditorView } from '@codemirror/view';
import type { FileChangeSummary } from '@shared/types/review';

// --- Return interface НЕ МЕНЯЕТСЯ ---
interface DiffNavigationState {
  currentHunkIndex: number;
  totalHunks: number;
  goToNextHunk: () => void;
  goToPrevHunk: () => void;
  goToNextFile: () => void;
  goToPrevFile: () => void;
  goToHunk: (index: number) => void;
  acceptCurrentHunk: () => void;
  rejectCurrentHunk: () => void;
  showShortcutsHelp: boolean;
  setShowShortcutsHelp: (show: boolean) => void;
}
```

#### Новый optional параметр continuousOptions

```typescript
// --- НОВАЯ сигнатура (расширение, backward compatible) ---
export function useDiffNavigation(
  files: FileChangeSummary[],
  selectedFilePath: string | null,
  onSelectFile: (path: string) => void,
  editorViewRef: React.RefObject<EditorView | null>,
  isDialogOpen: boolean,
  onHunkAccepted?: (filePath: string, hunkIndex: number) => void,
  onHunkRejected?: (filePath: string, hunkIndex: number) => void,
  onClose?: () => void,
  onSaveFile?: () => void,
  continuousOptions?: ContinuousNavigationOptions  // <-- НОВЫЙ 10-й параметр
): DiffNavigationState;
```

**Важно:** НЕ используем overloads. Один вариант сигнатуры с optional 10-м параметром. Overloads здесь избыточны -- `continuousOptions` опционален, TypeScript корректно проверяет типы без overload.

#### Новый тип ContinuousNavigationOptions

```typescript
interface ContinuousNavigationOptions {
  /**
   * Map всех EditorView по filePath. Заполняется в ContinuousScrollView.
   * Это НЕ ref -- передаётся сам Map (через .current снаружи).
   * Передаётся как value, но мутируется извне (Map reference стабильна).
   */
  editorViewRefs: Map<string, EditorView>;

  /**
   * Текущий видимый файл из scroll-spy (Phase 1 useVisibleFileSection).
   * НЕ selectedFilePath -- это activeFilePath.
   * Обновляется при скролле.
   */
  activeFilePath: string | null;

  /**
   * Программный scroll к секции файла из useContinuousScrollNav (Phase 1).
   * Вызывает scrollIntoView + подавление scroll-spy.
   */
  scrollToFile: (filePath: string) => void;

  /** Флаг continuous mode -- определяет какую логику использовать. */
  enabled: boolean;
}
```

**Дизайн-решение:** Вместо создания отдельного хука (useContinuousDiffNavigation), расширяем существующий через optional 10-й параметр `continuousOptions`. Это позволяет:
1. Не дублировать keyboard handler логику
2. Постепенно мигрировать: `ChangeReviewDialog` просто передаёт `continuousOptions` когда continuous mode включён
3. Сохранить обратную совместимость -- без `continuousOptions` хук работает как раньше

#### Внутренняя реализация -- helper: getActiveEditorView()

```typescript
/**
 * Определяет "активный" EditorView для навигации.
 *
 * Приоритет:
 * 1. Focused editor -- если какой-то CM editor сейчас имеет фокус
 * 2. activeFilePath editor -- editor файла, определённого scroll-spy как видимый
 * 3. Fallback: первый editor в Map
 *
 * В legacy mode: просто возвращает editorViewRef.current.
 */
function getActiveEditorView(
  editorViewRef: React.RefObject<EditorView | null>,
  continuousOptions?: ContinuousNavigationOptions
): EditorView | null {
  // Legacy mode
  if (!continuousOptions?.enabled) {
    return editorViewRef.current;
  }

  const { editorViewRefs, activeFilePath } = continuousOptions;

  // 1. Focused editor -- используем view.hasFocus (CM API)
  for (const [, view] of editorViewRefs) {
    if (view.hasFocus) return view;
  }

  // 2. activeFilePath editor
  if (activeFilePath) {
    const view = editorViewRefs.get(activeFilePath);
    if (view) return view;
  }

  // 3. Fallback: первый editor
  const firstEntry = editorViewRefs.values().next();
  return firstEntry.done ? null : firstEntry.value;
}
```

**ИСПРАВЛЕНИЕ:** Оригинальный вариант использовал `document.activeElement.closest('.cm-editor')` + сравнение с `view.dom`. Это ненадёжно -- CM editor может содержать nested elements, и `closest` не всегда корректно разрешает до внешнего `.cm-editor`. Используем встроенный `view.hasFocus` -- это официальный CM API для проверки фокуса.

#### Внутренняя реализация -- helper: getActiveFilePath()

```typescript
/**
 * Определяет путь активного файла для контекста навигации.
 *
 * В continuous mode: activeFilePath из scroll-spy.
 * В legacy mode: selectedFilePath.
 */
function getActiveFilePath(
  selectedFilePath: string | null,
  continuousOptions?: ContinuousNavigationOptions
): string | null {
  if (continuousOptions?.enabled && continuousOptions.activeFilePath) {
    return continuousOptions.activeFilePath;
  }
  return selectedFilePath;
}
```

#### Внутренняя реализация -- helper: getFilePathForView()

```typescript
/**
 * Находит filePath для данного EditorView в Map.
 * Нужно для определения "в каком файле мы сейчас" при focused editor.
 */
function getFilePathForView(
  view: EditorView,
  editorViewRefs: Map<string, EditorView>
): string | null {
  for (const [filePath, v] of editorViewRefs) {
    if (v === view) return filePath;
  }
  return null;
}
```

#### Внутренняя реализация -- helpers: isLastChunkInFile() / isFirstChunkInFile()

```typescript
import { getChunks } from '@renderer/components/team/review/CodeMirrorDiffUtils';
```

**ВАЖНО: API `getChunks`.**

`getChunks` реэкспортируется из `@codemirror/merge`. Сигнатура:
```typescript
function getChunks(state: EditorState): { chunks: readonly Chunk[]; side: "a" | "b" | null } | null;
```

Где `Chunk` имеет поля:
- `fromA`, `toA` -- диапазон в original document (side A)
- `fromB`, `toB` -- диапазон в modified document (side B)
- `changes` -- внутренние изменения

В `unifiedMergeView` (которую мы используем) side всегда `"b"`. Позиции курсора соответствуют side B.

```typescript
/**
 * Проверяет, находится ли курсор на последнем chunk файла.
 * Нужно для cross-file navigation: если на последнем chunk -- scroll к следующему файлу.
 *
 * Алгоритм:
 * 1. Получаем chunks из CM state через getChunks()
 * 2. Определяем текущую позицию курсора (view.state.selection.main.head)
 * 3. Проверяем: курсор находится в или после последнего chunk
 *
 * ВАЖНО: goToNextChunk -- это StateCommand. Возвращает boolean:
 * - true: перешёл к следующему chunk (dispatch вызван)
 * - false: нет chunks в документе ИЛИ только один chunk и курсор уже в нём
 *
 * goToNextChunk возвращает false НЕ когда "нет больше chunks после текущего",
 * а когда chunks.length === 0 или chunks.length === 1 && cursor уже в нём.
 * При >1 chunks goToNextChunk ВСЕГДА возвращает true (циклическая навигация!).
 *
 * Поэтому мы НЕ можем полагаться на return value goToNextChunk для определения
 * "последний ли это chunk". Нужна отдельная проверка через getChunks().
 */
function isLastChunkInFile(view: EditorView): boolean {
  const result = getChunks(view.state);
  if (!result || result.chunks.length === 0) return true;

  const cursorPos = view.state.selection.main.head;
  const chunks = result.chunks;
  const lastChunk = chunks[chunks.length - 1];

  // Курсор в пределах последнего chunk или после него
  // fromB -- начало chunk в modified document
  // toB -- конец chunk (1 past end of last line)
  return cursorPos >= lastChunk.fromB;
}

/**
 * Аналогично для первого chunk.
 */
function isFirstChunkInFile(view: EditorView): boolean {
  const result = getChunks(view.state);
  if (!result || result.chunks.length === 0) return true;

  const cursorPos = view.state.selection.main.head;
  const firstChunk = result.chunks[0];

  // Курсор в пределах первого chunk или перед ним
  return cursorPos <= firstChunk.toB;
}
```

**ИСПРАВЛЕНИЕ:** Уточнено поведение `goToNextChunk` -- это **циклическая** навигация (moveByChunk берёт `chunks[(pos + offset) % chunks.length]`). При >1 chunks всегда возвращает `true`. Поэтому:
- `const moved = goToNextChunk(view); if (!moved)` -- значит 0 или 1 chunk, а НЕ "последний chunk"
- Для определения "последний chunk" нужен `isLastChunkInFile()`
- В `goToNextHunk` правильная логика: **сначала** проверить `isLastChunkInFile`, **потом** решить -- переходить к следующему файлу или вызвать `goToNextChunk`

#### Изменения в goToNextFile()

```typescript
const goToNextFile = useCallback(() => {
  if (files.length === 0) return;

  const currentPath = getActiveFilePath(selectedFilePath, continuousOptions);
  const currentIdx = files.findIndex((f) => f.filePath === currentPath);
  const nextIdx = currentIdx < files.length - 1 ? currentIdx + 1 : 0;
  const nextFilePath = files[nextIdx].filePath;

  if (continuousOptions?.enabled) {
    // Continuous mode: smooth scroll к следующему файлу
    continuousOptions.scrollToFile(nextFilePath);
    // НЕ вызываем onSelectFile -- scroll-spy обновит activeFilePath сам
  } else {
    // Legacy mode: переключение файла
    onSelectFile(nextFilePath);
  }
}, [files, selectedFilePath, onSelectFile, continuousOptions]);
```

**Важно:** В continuous mode `goToNextFile()` НЕ вызывает `onSelectFile()`. Вместо этого:
1. Вызывается `scrollToFile(nextFilePath)` из `useContinuousScrollNav`
2. `scrollToFile` выполняет `element.scrollIntoView({ behavior: 'smooth' })`
3. `isProgrammaticScroll` подавляет scroll-spy
4. `waitForScrollEnd()` ждёт стабилизации (timeout 500ms, из `navigation/utils.ts`)
5. `isProgrammaticScroll = false`, scroll-spy обнаруживает новый видимый файл
6. `activeFilePath` обновляется через `onVisibleFileChange` callback

#### Изменения в goToPrevFile()

```typescript
const goToPrevFile = useCallback(() => {
  if (files.length === 0) return;

  const currentPath = getActiveFilePath(selectedFilePath, continuousOptions);
  const currentIdx = files.findIndex((f) => f.filePath === currentPath);
  const prevIdx = currentIdx > 0 ? currentIdx - 1 : files.length - 1;
  const prevFilePath = files[prevIdx].filePath;

  if (continuousOptions?.enabled) {
    continuousOptions.scrollToFile(prevFilePath);
  } else {
    onSelectFile(prevFilePath);
  }
}, [files, selectedFilePath, onSelectFile, continuousOptions]);
```

#### Изменения в goToNextHunk()

```typescript
const goToNextHunk = useCallback(() => {
  const view = getActiveEditorView(editorViewRef, continuousOptions);
  if (!view) return;

  if (continuousOptions?.enabled) {
    // Cross-file hunk navigation
    if (isLastChunkInFile(view)) {
      // Уже на последнем hunk файла -- переход к следующему файлу
      const currentPath = getActiveFilePath(selectedFilePath, continuousOptions);
      const currentIdx = files.findIndex((f) => f.filePath === currentPath);

      if (currentIdx < files.length - 1) {
        const nextFilePath = files[currentIdx + 1].filePath;
        continuousOptions.scrollToFile(nextFilePath);

        // После scroll -- перейти к первому hunk нового файла
        // Используем requestAnimationFrame чтобы дождаться scroll + render
        requestAnimationFrame(() => {
          const nextView = continuousOptions.editorViewRefs.get(nextFilePath);
          if (nextView) {
            // Перемещаем курсор в начало файла, потом goToNextChunk
            nextView.dispatch({
              selection: { anchor: 0 },
            });
            goToNextChunk(nextView);
          }
        });
      }
      // Если это последний файл -- no-op (конец списка)
    } else {
      // Не последний chunk -- обычная навигация внутри файла
      goToNextChunk(view);
    }
  } else {
    // Legacy mode: навигация внутри текущего файла
    goToNextChunk(view);
  }

  setCurrentHunkIndex((prev) => Math.min(prev + 1, totalHunks - 1));
}, [editorViewRef, totalHunks, setCurrentHunkIndex, files, selectedFilePath, continuousOptions]);
```

**ИСПРАВЛЕНИЕ (критическое):** Оригинальный вариант вызывал `goToNextChunk(view)` ПЕРЕД проверкой `isLastChunkInFile`. Проблема: `goToNextChunk` -- циклическая навигация. Если курсор на последнем chunk, `goToNextChunk` перейдёт к ПЕРВОМУ chunk (wrap-around), а потом `isLastChunkInFile` вернёт `false`. Результат: cross-file navigation никогда не сработает.

Правильная логика: **сначала** `isLastChunkInFile()`, **потом** решение -- переход к следующему файлу ИЛИ `goToNextChunk()` для навигации внутри файла.

#### Изменения в goToPrevHunk()

```typescript
const goToPrevHunk = useCallback(() => {
  const view = getActiveEditorView(editorViewRef, continuousOptions);
  if (!view) return;

  if (continuousOptions?.enabled) {
    if (isFirstChunkInFile(view)) {
      // Первый hunk файла -- переход к предыдущему файлу
      const currentPath = getActiveFilePath(selectedFilePath, continuousOptions);
      const currentIdx = files.findIndex((f) => f.filePath === currentPath);

      if (currentIdx > 0) {
        const prevFilePath = files[currentIdx - 1].filePath;
        continuousOptions.scrollToFile(prevFilePath);

        requestAnimationFrame(() => {
          const prevView = continuousOptions.editorViewRefs.get(prevFilePath);
          if (prevView) {
            // Перемещаем курсор в конец файла, потом goToPreviousChunk
            const docLength = prevView.state.doc.length;
            prevView.dispatch({
              selection: { anchor: docLength },
            });
            goToPreviousChunk(prevView);
          }
        });
      }
    } else {
      // Не первый chunk -- обычная навигация назад
      goToPreviousChunk(view);
    }
  } else {
    goToPreviousChunk(view);
  }

  setCurrentHunkIndex((prev) => Math.max(prev - 1, 0));
}, [editorViewRef, setCurrentHunkIndex, files, selectedFilePath, continuousOptions]);
```

#### Изменения в acceptCurrentHunk()

```typescript
const acceptCurrentHunk = useCallback(() => {
  const activePath = getActiveFilePath(selectedFilePath, continuousOptions);
  if (activePath && onHunkAccepted) {
    onHunkAccepted(activePath, currentHunkIndex);
  }
}, [selectedFilePath, currentHunkIndex, onHunkAccepted, continuousOptions]);
```

#### Изменения в rejectCurrentHunk()

```typescript
const rejectCurrentHunk = useCallback(() => {
  const activePath = getActiveFilePath(selectedFilePath, continuousOptions);
  if (activePath && onHunkRejected) {
    onHunkRejected(activePath, currentHunkIndex);
  }
}, [selectedFilePath, currentHunkIndex, onHunkRejected, continuousOptions]);
```

#### Keyboard handler -- адаптация

**ВАЖНО: Конфликт с useContinuousScrollNav (Phase 1).**

В Phase 1 `useContinuousScrollNav` регистрирует keyboard listener для Alt+ArrowDown/Up. В Phase 3 `useDiffNavigation` тоже хочет обрабатывать эти клавиши. Два обработчика на одно событие -- конфликт.

**Решение:** Удалить keyboard handler для Alt+Arrow из `useContinuousScrollNav` (Phase 1). Вся keyboard обработка навигации живёт в `useDiffNavigation`. Причина: `useDiffNavigation` уже обрабатывает все shortcuts и имеет доступ к `continuousOptions.scrollToFile`. Дублирование нарушает single-responsibility.

```typescript
useEffect(() => {
  if (!isDialogOpen) return;

  const handler = (event: KeyboardEvent) => {
    // Skip if CM keymap already handled
    if (event.defaultPrevented) return;
    // Skip inputs/textareas
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement
    ) {
      return;
    }

    const isMeta = event.metaKey || event.ctrlKey;

    // Alt+J -> next change (работает в обоих режимах)
    if (event.altKey && event.key.toLowerCase() === 'j') {
      event.preventDefault();
      goToNextHunk();
      return;
    }

    // Alt+K -> prev change (НОВЫЙ shortcut)
    if (event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      goToPrevHunk();
      return;
    }

    // Alt+ArrowDown -> next file (scroll в continuous mode, onSelectFile в legacy)
    if (event.altKey && event.key === 'ArrowDown') {
      event.preventDefault();
      goToNextFile();
      return;
    }

    // Alt+ArrowUp -> prev file
    if (event.altKey && event.key === 'ArrowUp') {
      event.preventDefault();
      goToPrevFile();
      return;
    }

    // Cmd+Enter -> save active file
    if (isMeta && event.key === 'Enter') {
      event.preventDefault();
      onSaveFileRef.current?.();
      return;
    }

    // Cmd+Y -> accept chunk + next (на active editor)
    if (isMeta && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      const view = getActiveEditorView(editorViewRef, continuousOptions);
      if (view) {
        acceptChunk(view);
        requestAnimationFrame(() => {
          if (continuousOptions?.enabled && isLastChunkInFile(view)) {
            // Cross-file: scroll к следующему файлу после accept последнего chunk
            goToNextFile();
          } else {
            goToNextChunk(view);
          }
        });
      }
      return;
    }

    // ? -> toggle shortcuts help
    if (event.key === '?' && !isMeta && !event.altKey) {
      event.preventDefault();
      setShowShortcutsHelp((prev) => !prev);
      return;
    }

    // Escape handling
    if (event.key === 'Escape') {
      if (showShortcutsHelp) {
        event.preventDefault();
        setShowShortcutsHelp(false);
      }
    }
  };

  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}, [
  isDialogOpen,
  showShortcutsHelp,
  editorViewRef,
  continuousOptions,
  goToNextFile,
  goToPrevFile,
  goToNextHunk,
  goToPrevHunk,
]);
```

**ИСПРАВЛЕНИЕ:** Alt+J/K теперь вызывают `goToNextHunk()` / `goToPrevHunk()` (callback из хука), а не напрямую `goToNextChunk(view)`. Это обеспечивает cross-file навигацию в continuous mode. В оригинале Alt+J вызывал `goToNextChunk` напрямую -- cross-file не работал бы.

#### Полная таблица keyboard shortcuts

| Shortcut | Action | Legacy mode | Continuous mode |
|----------|--------|:-----------:|:---------------:|
| `Alt+J` | Next change (hunk) | goToNextHunk (внутри файла) | goToNextHunk (cross-file) |
| `Alt+K` | Prev change (hunk) | goToPrevHunk (внутри файла) | goToPrevHunk (cross-file) |
| `Alt+ArrowDown` | Next file | goToNextFile (onSelectFile) | goToNextFile (scrollToFile) |
| `Alt+ArrowUp` | Prev file | goToPrevFile (onSelectFile) | goToPrevFile (scrollToFile) |
| `Cmd+Y` | Accept change + next | acceptChunk + goToNextChunk | acceptChunk + cross-file navigation |
| `Cmd+N` | Reject change + next | rejectChunk + goToNextChunk (IPC) | rejectChunk + cross-file navigation (IPC) |
| `Cmd+Enter` | Save file | save selectedFilePath | save activeFilePath |
| `?` | Toggle shortcuts help | toggle | toggle |
| `Escape` | Close help / dialog | close help или dialog | close help или dialog |
| `Ctrl+Alt+ArrowDown` | Next change (CM keymap) | goToNextChunk (built-in) | goToNextChunk (built-in per-editor) |
| `Ctrl+Alt+ArrowUp` | Prev change (CM keymap) | goToPreviousChunk (built-in) | goToPreviousChunk (built-in per-editor) |

**Примечание:** Ctrl+Alt+Arrow -- это встроенный CM keymap, не наш. Он работает per-editor (без cross-file). Это ОК -- пользователи, привыкшие к CM keymap, получают привычное поведение внутри файла. Alt+J/K -- наш shortcut с cross-file.

---

### 2. useContinuousScrollNav.ts -- изменения для Phase 3

**Файл:** `src/renderer/hooks/useContinuousScrollNav.ts`

Phase 1 реализует:
- `scrollToFile(filePath)` -- программный scroll к секции файла
- `isProgrammaticScroll` ref -- подавление scroll-spy при программном scroll

Phase 3 изменения:

1. **Убрать keyboard handler (Alt+Arrow) из useContinuousScrollNav.** Keyboard навигация теперь полностью в `useDiffNavigation`. Это устраняет конфликт двойной регистрации event listener.

2. **Убрать `activeFilePath` и `filePaths` из options** -- они больше не нужны хуку (keyboard handler убран). Упрощённый interface:

```typescript
interface UseContinuousScrollNavOptions {
  /** Ref на scroll container */
  scrollContainerRef: RefObject<HTMLElement>;

  /** Диалог открыт (для cleanup) */
  isOpen: boolean;
}

interface UseContinuousScrollNavReturn {
  /** Scroll к файлу по filePath (smooth) */
  scrollToFile: (filePath: string) => void;

  /** Ref-flag: true пока идёт programmatic scroll */
  isProgrammaticScroll: RefObject<boolean>;
}
```

3. **scrollToFile -- без `setActiveFilePath`:**

```typescript
const scrollToFile = useCallback(
  (filePath: string) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const section = container.querySelector<HTMLElement>(
      `[data-file-path="${CSS.escape(filePath)}"]`
    );
    if (!section) return;

    // Suppress scroll-spy during programmatic scroll
    isProgrammaticScroll.current = true;

    section.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Дождаться стабилизации scroll, потом разрешить scroll-spy
    void waitForScrollEnd(container, 500).then(() => {
      isProgrammaticScroll.current = false;
      // scroll-spy сам обнаружит новый видимый файл и обновит activeFilePath
    });
  },
  [scrollContainerRef]
);
```

**ИСПРАВЛЕНИЕ:** Оригинальный вариант вызывал `setActiveFilePath(filePath)` внутри `scrollToFile`. Проблема: `setActiveFilePath` не является частью hook state `useContinuousScrollNav` -- он живёт в parent (`ChangeReviewDialog` как `useState`). Передавать setter внутрь нарушает separation of concerns. Вместо этого: после `isProgrammaticScroll = false` scroll-spy (`useVisibleFileSection`) сам обнаружит видимый файл и вызовет `onVisibleFileChange`, который обновит `activeFilePath` в parent. Задержка ~100ms (debounce scroll-spy), но это ОК -- UI уже показывает правильный файл.

**waitForScrollEnd signature** (из `src/renderer/hooks/navigation/utils.ts`):
```typescript
function waitForScrollEnd(container: HTMLElement, timeoutMs?: number): Promise<void>
```
- `container` -- scroll container DOM element
- `timeoutMs` -- fallback timeout (default 400ms, мы передаём 500ms для запаса smooth scroll)
- Возвращает Promise, resolve когда scrollTop стабилизировался (3 consecutive frames без изменений)

---

### 3. ChangeReviewDialog.tsx -- интеграция

**Файл:** `src/renderer/components/team/review/ChangeReviewDialog.tsx`

#### Новый state: continuous mode toggle

```typescript
// Новый state для continuous mode (Phase 3)
const [isContinuousMode, setIsContinuousMode] = useState(false);
```

#### EditorView Map для continuous mode

```typescript
// Map всех EditorViews в continuous mode
// Заполняется через callback из ContinuousScrollView (Phase 1)
// Уже существует из Phase 1: editorViewMapRef
const editorViewMapRef = useRef(new Map<string, EditorView>());
```

#### Получение данных из useContinuousScrollNav

```typescript
// useContinuousScrollNav теперь принимает options object (Phase 1 interface,
// упрощённый в Phase 3):
const { scrollToFile, isProgrammaticScroll } = useContinuousScrollNav({
  scrollContainerRef,
  isOpen: open,
});
```

#### Передача continuousOptions в useDiffNavigation

```typescript
// Формируем continuousOptions только когда continuous mode включён.
//
// ВАЖНО: НЕ оборачивать editorViewMapRef.current в useMemo deps --
// .current не реактивен. Map reference стабильна (useRef), мутируется извне.
// useDiffNavigation обращается к Map.get() в момент вызова (не при создании options).
// activeFilePath и scrollToFile -- реактивны, они меняются.
const continuousOptions = useMemo(
  (): ContinuousNavigationOptions | undefined => {
    if (!isContinuousMode) return undefined;
    return {
      editorViewRefs: editorViewMapRef.current,
      activeFilePath: continuousScrollNav.activeFilePath,
      scrollToFile: continuousScrollNav.scrollToFile,
      enabled: true,
    };
  },
  [isContinuousMode, continuousScrollNav.activeFilePath, continuousScrollNav.scrollToFile]
);

const diffNav = useDiffNavigation(
  activeChangeSet?.files ?? [],
  selectedReviewFilePath,
  handleSelectFile,
  editorViewRef,          // Legacy ref (используется если continuousOptions undefined)
  open,
  (filePath, hunkIndex) => setHunkDecision(filePath, hunkIndex, 'accepted'),
  (filePath, hunkIndex) => setHunkDecision(filePath, hunkIndex, 'rejected'),
  () => onOpenChange(false),
  handleSaveCurrentFile,
  continuousOptions       // <-- НОВЫЙ 10-й параметр
);
```

**Примечание:** `continuousScrollNav.activeFilePath` -- это state из `useContinuousScrollNav` или state из parent (`ChangeReviewDialog`). В Phase 1 `activeFilePath` управляется через `onVisibleFileChange` callback. Уточнение: `activeFilePath` -- это `useState` в `ChangeReviewDialog`, обновляется через `setActiveFilePath` callback, переданный в `ContinuousScrollView.onVisibleFileChange`.

#### handleSelectFile адаптация

```typescript
const handleSelectFile = useCallback(
  (filePath: string | null) => {
    if (isContinuousMode && filePath) {
      // В continuous mode: scroll к секции вместо переключения
      scrollToFile(filePath);
      // НЕ вызываем selectReviewFile -- sidebar highlight управляется через activeFilePath
      return;
    }

    // Legacy mode: старая логика
    const view = editorViewRef.current;
    if (view && selectedReviewFilePath) {
      editorStateCache.current.set(selectedReviewFilePath, view.state);
    }
    setCachedInitialState(filePath ? editorStateCache.current.get(filePath) : undefined);
    selectReviewFile(filePath);
  },
  [isContinuousMode, selectedReviewFilePath, selectReviewFile, scrollToFile]
);
```

#### handleSaveCurrentFile адаптация

```typescript
const handleSaveCurrentFile = useCallback(() => {
  // В continuous mode сохраняем activeFilePath (видимый), не selectedReviewFilePath
  const targetFile = isContinuousMode
    ? activeFilePath   // из useState в ChangeReviewDialog
    : selectedReviewFilePath;

  if (targetFile) void saveEditedFile(targetFile);
}, [isContinuousMode, selectedReviewFilePath, activeFilePath, saveEditedFile]);
```

#### handleAcceptAll / handleRejectAll адаптация

```typescript
const handleAcceptAll = useCallback(() => {
  if (isContinuousMode) {
    // В continuous mode: accept all на ACTIVE file's editor
    if (activeFilePath) {
      const view = editorViewMapRef.current.get(activeFilePath);
      if (view) acceptAllChunks(view);
      acceptAllFile(activeFilePath);
    }
  } else {
    const view = editorViewRef.current;
    if (view) acceptAllChunks(view);
    if (selectedReviewFilePath) acceptAllFile(selectedReviewFilePath);
  }
}, [isContinuousMode, selectedReviewFilePath, activeFilePath, acceptAllFile]);
```

#### Sidebar: подсветка activeFilePath в continuous mode

```typescript
{/* File tree -- selectedFilePath меняется на activeFilePath в continuous mode */}
<ReviewFileTree
  files={activeChangeSet.files}
  selectedFilePath={
    isContinuousMode
      ? activeFilePath       // из scroll-spy
      : selectedReviewFilePath  // из store
  }
  onSelectFile={handleSelectFile}
  viewedSet={viewedSet}
  onMarkViewed={markViewed}
  onUnmarkViewed={unmarkViewed}
/>
```

**Примечание:** Phase 1 добавила `activeFilePath` prop в `ReviewFileTree` для мягкой подсветки (border-l). В continuous mode мы просто передаём `activeFilePath` как `selectedFilePath` -- полноценная подсветка (`bg-blue-500/20`). Это проще и визуально понятнее: один выделенный файл в tree.

#### Cmd+N IPC listener адаптация

```typescript
useEffect(() => {
  if (!open) return;
  const cleanup = window.electronAPI?.review.onCmdN?.(() => {
    const view = isContinuousMode
      ? getActiveEditorView(editorViewRef, continuousOptions)
      : editorViewRef.current;

    if (view) {
      rejectChunk(view);
      requestAnimationFrame(() => {
        if (isContinuousMode && isLastChunkInFile(view)) {
          // Cross-file: scroll к следующему файлу
          diffNav.goToNextFile();
        } else {
          goToNextChunk(view);
        }
      });
    }
  });
  return cleanup ?? undefined;
}, [open, isContinuousMode, continuousOptions, diffNav]);
```

**Примечание:** `getActiveEditorView` и `isLastChunkInFile` -- helper функции из `useDiffNavigation`. Для использования в `ChangeReviewDialog` нужно:
- Либо экспортировать helpers из `useDiffNavigation.ts`
- Либо дублировать логику (нежелательно)
- Либо добавить метод в return interface: `diffNav.getActiveView()` / `diffNav.isOnLastChunk()`

**Рекомендация:** Экспортировать `getActiveEditorView` и `isLastChunkInFile` как named exports из `useDiffNavigation.ts`. Они чистые функции, не зависят от hook state.

---

### 4. KeyboardShortcutsHelp.tsx -- новые shortcuts

**Файл:** `src/renderer/components/team/review/KeyboardShortcutsHelp.tsx`

Добавляются новые shortcuts. Текущий массив `shortcuts` (строки 10-18):

```typescript
const shortcuts = [
  { keys: ['\u2325+J'], action: 'Next change' },
  { keys: ['\u2325+K'], action: 'Previous change' },    // НОВЫЙ
  { keys: ['\u2325+\u2193'], action: 'Next file' },      // НОВЫЙ
  { keys: ['\u2325+\u2191'], action: 'Previous file' },  // НОВЫЙ
  { keys: ['\u2318+Y'], action: 'Accept change' },
  { keys: ['\u2318+N'], action: 'Reject change' },
  { keys: ['\u2318+\u21A9'], action: 'Save file' },
  { keys: ['\u2318+Z'], action: 'Undo' },
  { keys: ['\u2318+\u21E7+Z'], action: 'Redo' },
  { keys: ['?'], action: 'Toggle this help' },           // НОВЫЙ
  { keys: ['Esc'], action: 'Close dialog' },
];
```

---

## Return Interface

```typescript
interface DiffNavigationState {
  currentHunkIndex: number;
  totalHunks: number;
  goToNextHunk: () => void;
  goToPrevHunk: () => void;
  goToNextFile: () => void;
  goToPrevFile: () => void;
  goToHunk: (index: number) => void;
  acceptCurrentHunk: () => void;
  rejectCurrentHunk: () => void;
  showShortcutsHelp: boolean;
  setShowShortcutsHelp: (show: boolean) => void;
}
```

Интерфейс **НЕ меняется**. Все вызовы `diffNav.goToNextFile()`, `diffNav.goToNextHunk()` и т.д. в ChangeReviewDialog продолжают работать без изменений. Внутренняя реализация каждого метода проверяет `continuousOptions?.enabled` и выбирает стратегию.

---

## Edge-cases

### 1. scrollToFile + scroll-spy подавление

**Проблема:** При `scrollToFile(nextFile)` scroll-spy может обнаружить промежуточные файлы (мелькание activeFilePath).

**Решение:** `isProgrammaticScroll` ref в `useContinuousScrollNav`. При программном scroll:
1. `isProgrammaticScroll.current = true` устанавливается ДО `scrollIntoView`
2. Scroll-spy IntersectionObserver проверяет `isProgrammaticScroll.current` в `updateTopmostVisible()` и ИГНОРИРУЕТ обновления
3. После стабилизации scroll (через `waitForScrollEnd(container, 500)`) -- сбрасывается в `false`
4. Scroll-spy автоматически обнаруживает видимый файл на следующем intersection event

**Таймаут:** `waitForScrollEnd` имеет fallback timeout. Сигнатура: `waitForScrollEnd(container: HTMLElement, timeoutMs?: number): Promise<void>`. Default timeout 400ms. Мы передаём 500ms. Smooth scroll в Chromium занимает ~300-400ms. 500ms достаточно.

### 2. Cross-file hunk navigation: определение границы файла

**Проблема:** Как определить что мы на последнем/первом hunk файла?

**Решение:** Функции `isLastChunkInFile(view)` / `isFirstChunkInFile(view)` используют `getChunks(view.state)` для получения списка chunks, и сравнивают позицию курсора (`view.state.selection.main.head`) с позицией первого/последнего chunk.

**Критическая деталь `goToNextChunk`:**
- `goToNextChunk` -- это `StateCommand` (тип: `(target: { state, dispatch }) => boolean`)
- `EditorView` реализует этот интерфейс (имеет `.state` и `.dispatch()`)
- `goToNextChunk` реализует **циклическую** навигацию: `chunks[(pos + offset) % chunks.length]`
- При >1 chunks `goToNextChunk` **ВСЕГДА** возвращает `true` (перешёл к следующему chunk, даже если wrap-around к первому)
- `false` возвращается ТОЛЬКО когда: chunks.length === 0, или chunks.length === 1 && cursor уже в этом chunk

Поэтому использовать `const moved = goToNextChunk(view); if (!moved)` для определения "последний chunk" -- **некорректно**. Нужна явная проверка `isLastChunkInFile()`.

### 3. Multiple EditorViews: какой active?

**Проблема:** В continuous mode 10+ EditorView одновременно. Какой считать "активным" для keyboard shortcuts?

**Решение:** Приоритет в `getActiveEditorView()`:
1. **Focused editor** -- `view.hasFocus` (CM API). Пользователь кликнул в editor для редактирования.
2. **activeFilePath editor** -- editor файла, определённого scroll-spy как видимый. Пользователь скроллит, но не кликает в editor.
3. **Первый editor** -- fallback, если ни один не подходит.

**Нюанс:** Когда пользователь кликает в sidebar (ReviewFileTree), фокус уходит из CM editor. `view.hasFocus` становится `false` для всех. В этом случае activeFilePath editor используется корректно.

### 4. goToNextChunk на пустом файле (0 chunks)

**Проблема:** Файл целиком новый (`isNewFile: true`) -- весь контент является одним "inserted" chunk. Или файл без diff (identical). `goToNextChunk` возвращает `false` при 0 chunks.

**Решение:** `isLastChunkInFile` и `isFirstChunkInFile` возвращают `true` при 0 chunks. В `goToNextHunk` continuous mode: если `isLastChunkInFile` true и 0 chunks -- переходим к следующему файлу. Это корректно: файл без changes пропускается.

Для new file (1 chunk covering entire file): `isLastChunkInFile` вернёт `true` если курсор >= chunk.fromB. При первом заходе курсор в позиции 0 = chunk.fromB = 0, значит `isLastChunkInFile` true -- сразу переход к следующему файлу. Это может быть нежелательно для больших new files. **Решение:** Для файлов с 1 chunk можно добавить проверку `cursorPos >= lastChunk.toB - 1` (конец chunk, не начало). Но это edge case, оставляем для будущей итерации.

### 5. Cmd+Enter save: какой файл сохраняется?

**Проблема:** В continuous mode несколько файлов видны одновременно. `Cmd+Enter` должен сохранять конкретный файл.

**Решение:** Сохраняется файл из `handleSaveCurrentFile`:
- В continuous mode: `activeFilePath` из scroll-spy
- В legacy mode: `selectedReviewFilePath` из store

`onSaveFileRef.current` в keyboard handler вызывает `handleSaveCurrentFile`, который уже адаптирован.

### 6. Cross-file navigation + requestAnimationFrame timing

**Проблема:** При переходе к следующему файлу, `scrollToFile` триггерит smooth scroll. EditorView нового файла может быть не готов.

**Решение:**
1. В Phase 1/2 ВСЕ EditorView создаются при mount (lazy loading загружает контент, но DOM + EditorView создаются сразу для загруженных файлов)
2. `requestAnimationFrame` используется для задержки `goToNextChunk` после scroll
3. Если EditorView ещё не доступен (файл ещё не загружен через lazy loading) -- `continuousOptions.editorViewRefs.get(filePath)` вернёт `undefined`, navigation no-op

**Потенциальная проблема:** rAF может сработать до завершения smooth scroll. Но для `goToNextChunk` / `goToPreviousChunk` это ОК -- CM сам scrollIntoView к chunk. Визуально: scroll к файлу + мгновенный jump к первому chunk.

### 7. Wrap-around: конец/начало списка файлов

**Поведение:**
- `goToNextFile()` на последнем файле: wrap к первому файлу (index 0). Это текущее поведение legacy mode, сохраняем.
- `goToNextHunk()` на последнем hunk последнего файла: no-op (не wrap). Это отличается от goToNextFile -- hunk navigation останавливается на границе.
- `goToPrevHunk()` на первом hunk первого файла: no-op.

### 8. Editor state cache в continuous mode

**Проблема:** В legacy mode `editorStateCache` хранит EditorState для восстановления undo history при переключении файлов. В continuous mode все editors живут одновременно -- cache не нужен.

**Решение:** `editorStateCache` используется только в legacy mode (`handleSelectFile` проверяет `isContinuousMode`). В continuous mode undo history каждого EditorView сохраняется автоматически (editor не уничтожается при навигации).

### 9. goToNextChunk циклическая навигация vs наше поведение

**Ситуация:** `goToNextChunk` при >1 chunks делает wrap-around (с последнего chunk на первый). Наше cross-file поведение ожидает "стоп на последнем chunk -- перейти к следующему файлу".

**Решение:** Мы НЕ вызываем `goToNextChunk` когда `isLastChunkInFile` true. Поэтому wrap-around не происходит. `goToNextChunk` вызывается только когда мы знаем что есть следующий chunk в текущем файле.

---

## Проверка

### Unit тесты

```
test/renderer/hooks/useDiffNavigation.test.ts
```

**Тест-кейсы:**

1. **goToNextFile в continuous mode** -- вызывает scrollToFile, НЕ вызывает onSelectFile
2. **goToNextFile в legacy mode** -- вызывает onSelectFile, НЕ вызывает scrollToFile
3. **getActiveEditorView: focused editor приоритет** -- mock view.hasFocus
4. **getActiveEditorView: fallback на activeFilePath** -- когда hasFocus false для всех
5. **goToNextHunk: isLastChunkInFile true** -- вызывает scrollToFile для следующего файла, НЕ вызывает goToNextChunk
6. **goToNextHunk: isLastChunkInFile false** -- вызывает goToNextChunk, НЕ переходит к файлу
7. **goToPrevHunk cross-file** -- при isFirstChunkInFile=true, вызывает scrollToFile для предыдущего файла
8. **Keyboard: Alt+ArrowDown** -- вызывает goToNextFile
9. **Keyboard: Alt+ArrowUp** -- вызывает goToPrevFile
10. **Keyboard: Alt+J** -- вызывает goToNextHunk (с cross-file)
11. **Keyboard: Cmd+Y + cross-file** -- acceptChunk + goToNextFile если isLastChunkInFile
12. **handleSaveCurrentFile в continuous mode** -- сохраняет activeFilePath
13. **handleSelectFile в continuous mode** -- вызывает scrollToFile вместо selectReviewFile
14. **isLastChunkInFile: 0 chunks** -- returns true
15. **isLastChunkInFile: cursor before last chunk** -- returns false
16. **isLastChunkInFile: cursor at last chunk.fromB** -- returns true

### Ручная проверка

1. Открыть review dialog в continuous mode с 5+ файлами
2. Клик по файлу в sidebar -- плавный scroll к секции
3. Alt+ArrowDown/Up -- навигация между файлами
4. Alt+J -- переход к следующему hunk
5. На последнем hunk файла: Alt+J -- scroll к следующему файлу, первый hunk
6. Cmd+Y на последнем hunk -- accept + scroll к следующему файлу
7. Cmd+Enter -- сохраняет видимый файл (не первый в списке)
8. Переключить на legacy mode -- все shortcuts работают как раньше

### Интеграция с Phase 1/2

- scrollToFile корректно подавляет scroll-spy (isProgrammaticScroll)
- activeFilePath обновляется после программного scroll (через scroll-spy, не принудительно)
- EditorView Map содержит все созданные editors
- Sidebar highlight синхронизирован с activeFilePath в continuous mode
- Lazy loading не мешает навигации (placeholder для незагруженных файлов)

---

## Файлы

| Файл | Тип | ~LOC изменений |
|------|-----|---:|
| `src/renderer/hooks/useDiffNavigation.ts` | MODIFY | ~200 (helpers + goToNext/Prev переработка + keyboard) |
| `src/renderer/hooks/useContinuousScrollNav.ts` | MODIFY | ~-30 (удаление keyboard handler, упрощение interface) |
| `src/renderer/components/team/review/ChangeReviewDialog.tsx` | MODIFY | ~60 (continuousOptions, handleSelectFile, handleSave) |
| `src/renderer/components/team/review/KeyboardShortcutsHelp.tsx` | MODIFY | ~10 (новые shortcuts) |
| `test/renderer/hooks/useDiffNavigation.test.ts` | MODIFY | ~200 (новые тест-кейсы для continuous mode) |
| **Итого** | 0 NEW + 5 MODIFY | ~440 |
