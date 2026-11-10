# Фаза 1: Continuous Scroll + Scroll-Spy

## 1. Обзор

**Цель:** Заменить текущий single-file diff view на непрерывный scroll всех файлов (как на GitHub PR review).

**Текущее поведение:** `ChangeReviewDialog` показывает один файл за раз. Пользователь кликает по файлу в `ReviewFileTree` — диалог переключает контент. Для каждого файла создаётся/уничтожается один `CodeMirrorDiffView`. При переключении undo history сохраняется в `editorStateCache`. Контент файла загружается lazy (useEffect при смене `selectedReviewFilePath`).

**Новое поведение:**
- Все файлы рендерятся в одном scroll-контейнере вертикально, один за другом
- Каждый файл имеет sticky header (имя, badges, кнопки) — прилипает к верху при скролле
- File tree подсвечивает текущий видимый файл (scroll-spy)
- Клик по файлу в tree = smooth scroll к файлу в контенте
- Все CodeMirror editors живут одновременно — нет необходимости в editorStateCache
- Keyboard navigation: Alt+ArrowDown/Up для перехода между файлами
- Контент всех файлов загружается при открытии диалога (bulk load для фазы 1)

---

## 2. Новые файлы

### 2.1. `FileSectionHeader.tsx`

**Путь:** `src/renderer/components/team/review/FileSectionHeader.tsx`

**Назначение:** Sticky header для каждой file section в continuous scroll. Извлечён из `ChangeReviewDialog.tsx` (строки 437-509 — блок `{/* File header with content source badge and save/discard */}`).

#### Props Interface

```typescript
import type { FileChangeSummary, FileChangeWithContent, HunkDecision } from '@shared/types';

interface FileSectionHeaderProps {
  /** Данные файла (relativePath, isNewFile, filePath и т.д.) */
  file: FileChangeSummary;

  /** Загруженный контент файла (для отображения contentSource badge). null = ещё не загружен */
  fileContent: FileChangeWithContent | null;

  /** Решение по файлу целиком ('accepted' | 'rejected' | 'pending' | undefined) */
  fileDecision: HunkDecision | undefined;

  /** Есть ли несохранённые ручные правки для этого файла */
  hasEdits: boolean;

  /** Идёт ли сейчас операция сохранения/применения (disabled state для кнопки Save) */
  applying: boolean;

  /** Callback: пользователь нажал "Discard" для отмены ручных правок */
  onDiscard: (filePath: string) => void;

  /** Callback: пользователь нажал "Save File" для записи на диск */
  onSave: (filePath: string) => void;
}
```

#### Что рендерит

1. **Sticky container:** `<div className="sticky top-0 z-10 ...">`
   - `data-file-path={file.filePath}` — для scroll-spy (querySelector)
   - `bg-surface-sidebar` фон (непрозрачный, чтобы контент под sticky не просвечивал)
   - `border-b border-border`

2. **Имя файла:** `file.relativePath` — `text-xs font-medium text-text`

3. **NEW badge** (условный):
   ```tsx
   {file.isNewFile && (
     <span className="rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] text-green-400">
       NEW
     </span>
   )}
   ```

4. **Content source badge** (условный, только когда fileContent загружен):
   ```tsx
   {fileContent?.contentSource && (
     <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-text-muted">
       {CONTENT_SOURCE_LABELS[fileContent.contentSource] ?? fileContent.contentSource}
     </span>
   )}
   ```
   `CONTENT_SOURCE_LABELS` определяется в этом же файле (вынесен из `ChangeReviewDialog.tsx` строка 38-44):
   ```typescript
   const CONTENT_SOURCE_LABELS: Record<string, string> = {
     'file-history': 'File History',
     'snippet-reconstruction': 'Reconstructed',
     'disk-current': 'Current Disk',
     'git-fallback': 'Git Fallback',
     unavailable: 'Unavailable',
   };
   ```

5. **File decision indicator** (условный):
   ```tsx
   {fileDecision && (
     <span className={`rounded px-1.5 py-0.5 text-[10px] ${colorClass}`}>
       {fileDecision}
     </span>
   )}
   ```
   Цвета:
   - `accepted` -> `bg-green-500/20 text-green-400`
   - `rejected` -> `bg-red-500/20 text-red-400`
   - `pending` -> `bg-zinc-500/20 text-zinc-400`

6. **Save/Discard кнопки** (условные, только когда `hasEdits === true`):
   - Discard: `<Undo2 />` + "Discard" — `bg-orange-500/15 text-orange-400 hover:bg-orange-500/25`, вызывает `onDiscard(file.filePath)`
   - Save: `<Save />` + "Save File" — `bg-green-500/15 text-green-400 hover:bg-green-500/25`, вызывает `onSave(file.filePath)`, `disabled={applying}`
   - Во время `applying` вместо `<Save />` показывается `<Loader2 className="size-3 animate-spin" />` (спиннер)
   - Кнопка Save имеет `disabled:opacity-50` для disabled state
   - Обе кнопки обёрнуты в `<Tooltip>` (из `@renderer/components/ui/tooltip`)
   - Save tooltip показывает keyboard shortcut `Cmd+Enter` через `<kbd>`:
     ```tsx
     <TooltipContent side="bottom">
       <span>Save file to disk</span>
       <kbd className="ml-2 rounded border border-border bg-surface-raised px-1 py-0.5 font-mono text-[10px] text-text-muted">
         ⌘↵
       </kbd>
     </TooltipContent>
     ```
   - Discard tooltip: "Discard all edits for this file"

   **Импорты иконок:** `Save`, `Undo2`, `Loader2` из `lucide-react`

7. **Кнопки обёрнуты в `ml-auto` контейнер:**
   ```tsx
   <div className="ml-auto flex items-center gap-1.5">
     {hasEdits && ( /* Discard + Save */ )}
   </div>
   ```

#### Sticky позиционирование

```tsx
<div
  className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-surface-sidebar px-4 py-2"
  data-file-path={file.filePath}
>
```

**Важно:** `z-10` гарантирует, что sticky header перекрывает контент CodeMirror. Фон ОБЯЗАТЕЛЬНО непрозрачный (`bg-surface-sidebar`), чтобы diff-строки не просвечивали через header.

**Важно:** Когда несколько sticky headers "стопятся" (файл A scrolled out, файл B виден) — только один header виден сверху. Это нативное поведение CSS `position: sticky`: каждый header прилипает в рамках своего parent section div.

---

### 2.2. `FileSectionDiff.tsx`

**Путь:** `src/renderer/components/team/review/FileSectionDiff.tsx`

**Назначение:** Diff-контент для одного файла в continuous scroll. Извлечён из `ChangeReviewDialog.tsx` (строки 511-561 — блоки loading state, CodeMirror diff view, fallback snippet view).

#### Props Interface

```typescript
import type { EditorView } from '@codemirror/view';
import type { FileChangeSummary, FileChangeWithContent } from '@shared/types';

interface FileSectionDiffProps {
  /** Данные файла */
  file: FileChangeSummary;

  /** Загруженный контент (null = ещё не загружен) */
  fileContent: FileChangeWithContent | null;

  /** Контент загружается */
  isLoading: boolean;

  /** Collapse unchanged regions в CodeMirror */
  collapseUnchanged: boolean;

  /** Callback при accept hunk */
  onHunkAccepted: (filePath: string, hunkIndex: number) => void;

  /** Callback при reject hunk */
  onHunkRejected: (filePath: string, hunkIndex: number) => void;

  /** Callback: файл полностью просмотрен (sentinel виден в viewport) */
  onFullyViewed: (filePath: string) => void;

  /** Callback: ручная правка контента (debounced из CodeMirror) */
  onContentChanged: (filePath: string, content: string) => void;

  /** Callback для регистрации EditorView в общий Map. Вызывается при создании/уничтожении */
  onEditorViewReady: (filePath: string, view: EditorView | null) => void;

  /**
   * Counter для force-rebuild editor (инкрементируется при discard).
   * Используется как часть key для CodeMirrorDiffView.
   */
  discardCounter: number;

  /** Auto-viewed включён (для sentinel IntersectionObserver) */
  autoViewed: boolean;

  /** Файл уже помечен как viewed (не вызывать onFullyViewed повторно) */
  isViewed: boolean;
}
```

#### Логика рендеринга

1. **Loading state:** Если `isLoading` — показать `FileSectionPlaceholder` (из соседнего файла)

2. **Unavailable fallback:** Если `!fileContent || fileContent.contentSource === 'unavailable'` — показать `<ReviewDiffContent file={file} />`

   **Важно:** Также проверить `fileContent.modifiedFullContent !== null`. В текущем коде (строка 523) условие: `fileContent.contentSource !== 'unavailable' && fileContent.modifiedFullContent !== null`. Если `modifiedFullContent === null` — тоже fallback на ReviewDiffContent.

3. **CodeMirror diff:** Иначе — полноценный CodeMirror:
   ```tsx
   <DiffErrorBoundary
     filePath={file.filePath}
     oldString={fileContent.originalFullContent ?? ''}
     newString={fileContent.modifiedFullContent!}
   >
     <CodeMirrorDiffView
       key={`${file.filePath}:${discardCounter}`}
       original={fileContent.originalFullContent ?? ''}
       modified={fileContent.modifiedFullContent!}
       fileName={file.relativePath}
       readOnly={false}
       showMergeControls={true}
       collapseUnchanged={collapseUnchanged}
       onHunkAccepted={(idx) => onHunkAccepted(file.filePath, idx)}
       onHunkRejected={(idx) => onHunkRejected(file.filePath, idx)}
       onFullyViewed={handleFullyViewed}
       editorViewRef={localEditorViewRef}
       onContentChanged={(content) => onContentChanged(file.filePath, content)}
     />
   </DiffErrorBoundary>
   ```

   **Обрати внимание:**
   - `initialState` **не передаётся** — в continuous mode нет cache, editors живут одновременно
   - `onFullyViewed` передаётся как `handleFullyViewed` (локальный callback без аргументов, т.к. `CodeMirrorDiffView.onFullyViewed` имеет тип `() => void`)
   - `DiffErrorBoundary.props`: `filePath` (string), `oldString` (optional string), `newString` (optional string), `onRetry` (optional callback). Без `onRetry` — нет кнопки retry, только показ ошибки

4. **handleFullyViewed — bridge между sentinel и parent callback:**

   `CodeMirrorDiffView.onFullyViewed` имеет сигнатуру `() => void`. Наш `FileSectionDiff.onFullyViewed` принимает `(filePath: string) => void`. Нужен bridge:

   ```typescript
   const handleFullyViewed = useCallback(() => {
     onFullyViewed(file.filePath);
   }, [file.filePath, onFullyViewed]);
   ```

   Этот `handleFullyViewed` передаётся и в `CodeMirrorDiffView.onFullyViewed`, и в sentinel observer (оба вызывают одну функцию). Однако в continuous mode мы используем **собственный sentinel** вместо встроенного `CodeMirrorDiffView` sentinel (см. ниже).

5. **EditorView регистрация:**
   ```typescript
   const localEditorViewRef = useRef<EditorView | null>(null);

   // Sync to parent Map при mount/unmount
   useEffect(() => {
     return () => {
       // При unmount сообщить parent что view уничтожен
       onEditorViewReady(file.filePath, null);
     };
   }, [file.filePath, onEditorViewReady]);

   // Нужен useEffect чтобы проверить ref после рендера CodeMirrorDiffView
   useEffect(() => {
     if (localEditorViewRef.current) {
       onEditorViewReady(file.filePath, localEditorViewRef.current);
     }
   });
   ```

   **Как CodeMirrorDiffView устанавливает ref:**
   В `CodeMirrorDiffView.tsx` строки 685-688 — при создании EditorView он синхронно записывает view в `externalViewRef.current`:
   ```typescript
   const extRef = externalViewRefHolder.current;
   if (extRef) {
     (extRef as React.MutableRefObject<EditorView | null>).current = view;
   }
   ```
   Это происходит в useEffect (строка 666), после чего наш вторичный useEffect (без deps) на следующем render cycle ловит значение и вызывает `onEditorViewReady`.

6. **Sentinel для auto-viewed:**

   В continuous mode встроенный sentinel `CodeMirrorDiffView` (`endSentinelRef` внутри компонента, строка 281) может некорректно работать, т.к. `CodeMirrorDiffView` рендерится внутри `<div className="flex-col" style={{ maxHeight }}>` с `maxHeight: '100%'`. В continuous scroll нет фиксированной высоты — CodeMirror занимает весь свой контент. Поэтому встроенный sentinel (`threshold: 1.0`, строка 755) может не сработать.

   **Решение:** Внешний sentinel в `FileSectionDiff`, с `threshold: 0.85` (а не 1.0). Причина: в continuous scroll с collapsed unchanged regions файл может не занимать 100% viewport, и sentinel может быть виден на 85-90%.

   ```tsx
   const sentinelRef = useRef<HTMLDivElement>(null);

   useEffect(() => {
     if (!sentinelRef.current || !autoViewed || isViewed) return;

     const observer = new IntersectionObserver(
       (entries) => {
         for (const entry of entries) {
           if (entry.isIntersecting) {
             onFullyViewed(file.filePath);
           }
         }
       },
       { threshold: 0.85 }
     );

     observer.observe(sentinelRef.current);
     return () => observer.disconnect();
   }, [autoViewed, isViewed, file.filePath, onFullyViewed]);
   ```

   Sentinel div в конце секции:
   ```tsx
   <div ref={sentinelRef} className="h-1 shrink-0" />
   ```

   **Edge case:** Для очень коротких файлов (3-5 строк) sentinel может быть сразу виден при mount. Это ОК — файл просмотрен.

   **Дублирование:** Встроенный `CodeMirrorDiffView.onFullyViewed` тоже вызовет `handleFullyViewed` при scroll end внутри CM. Можно передать `onFullyViewed={undefined}` в CodeMirrorDiffView чтобы отключить встроенный observer (проп optional). Или оставить оба — двойной вызов `markViewed` для уже viewed файла — no-op (проверяется через `isViewed`).

   **Рекомендация:** Передать `onFullyViewed={undefined}` в CodeMirrorDiffView и полагаться только на внешний sentinel.

#### Важные замечания

- `DiffErrorBoundary` оборачивает только CodeMirror, не fallback `ReviewDiffContent`
- `key` включает `discardCounter` для force-rebuild при discard edits
- Условие для CodeMirror рендеринга: `!isLoading && fileContent && fileContent.contentSource !== 'unavailable' && fileContent.modifiedFullContent !== null`

---

### 2.3. `FileSectionPlaceholder.tsx`

**Путь:** `src/renderer/components/team/review/FileSectionPlaceholder.tsx`

**Назначение:** Skeleton placeholder для file section пока контент загружается.

#### Props Interface

```typescript
interface FileSectionPlaceholderProps {
  /** Имя файла для отображения в заголовке skeleton */
  fileName: string;
}
```

#### Что рендерит

```tsx
export const FileSectionPlaceholder = ({ fileName }: FileSectionPlaceholderProps) => (
  <div className="animate-pulse">
    {/* Header area */}
    <div className="flex items-center gap-2 border-b border-border bg-surface-sidebar px-4 py-2">
      <span className="text-xs font-medium text-text-muted">{fileName}</span>
      <div className="h-4 w-16 rounded bg-surface-raised" />
    </div>

    {/* Content shimmer lines */}
    <div className="space-y-2 p-4">
      <div className="h-4 w-3/4 rounded bg-surface-raised" />
      <div className="h-4 w-1/2 rounded bg-surface-raised" />
      <div className="h-4 w-5/6 rounded bg-surface-raised" />
      <div className="h-4 w-2/3 rounded bg-surface-raised" />
    </div>
  </div>
);
```

**CSS:** `animate-pulse` — встроенная Tailwind анимация для skeleton loading. Пульсирует opacity между 1 и 0.5.

**Высота:** Примерно 120-140px, достаточно чтобы placeholder не "прыгал" при загрузке контента. Но это не идеальное совпадение с финальной высотой diff — абсолютной точности не требуется.

---

### 2.4. `useVisibleFileSection.ts`

**Путь:** `src/renderer/hooks/useVisibleFileSection.ts`

**Назначение:** Scroll-spy хук. Отслеживает какой файл сейчас виден в viewport. По паттерну `useVisibleAIGroup.ts`.

#### Interface

```typescript
import { type RefObject } from 'react';

interface UseVisibleFileSectionOptions {
  /** Callback: вызывается при смене видимого файла */
  onVisibleFileChange: (filePath: string) => void;

  /** Scroll container ref (ContinuousScrollView outer div) */
  scrollContainerRef: RefObject<HTMLElement>;

  /** Подавление scroll-spy во время programmatic scroll */
  isProgrammaticScroll: RefObject<boolean>;
}

interface UseVisibleFileSectionReturn {
  /**
   * Регистрация file section элемента для наблюдения.
   * Возвращает ref callback — передать в div section.
   * Пример: <div ref={registerFileSectionRef(file.filePath)}>
   */
  registerFileSectionRef: (filePath: string) => (element: HTMLElement | null) => void;
}
```

#### Реализация (описание)

```typescript
export function useVisibleFileSection(
  options: UseVisibleFileSectionOptions
): UseVisibleFileSectionReturn {
  const { onVisibleFileChange, scrollContainerRef, isProgrammaticScroll } = options;

  // Set видимых filePath
  const visibleFilePaths = useRef<Set<string>>(new Set());

  // Map: filePath -> HTMLElement
  const elementRefs = useRef<Map<string, HTMLElement>>(new Map());

  // Observer ref
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Debounce timer
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Определить topmost visible file
  const updateTopmostVisible = useCallback(() => {
    // Если programmatic scroll — не обновлять (иначе race condition)
    if (isProgrammaticScroll.current) return;

    if (visibleFilePaths.current.size === 0) return;

    let topmostPath: string | null = null;
    let minTop = Infinity;

    visibleFilePaths.current.forEach((filePath) => {
      const element = elementRefs.current.get(filePath);
      if (element) {
        const rect = element.getBoundingClientRect();
        if (rect.top < minTop) {
          minTop = rect.top;
          topmostPath = filePath;
        }
      }
    });

    if (topmostPath) {
      onVisibleFileChange(topmostPath);
    }
  }, [onVisibleFileChange, isProgrammaticScroll]);

  // Debounced версия
  const debouncedUpdate = useCallback(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(updateTopmostVisible, 100);
  }, [updateTopmostVisible]);

  // Создание IntersectionObserver
  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        let changed = false;

        for (const entry of entries) {
          const filePath = entry.target.getAttribute('data-file-path');
          if (!filePath) continue;

          if (entry.isIntersecting && entry.intersectionRatio >= 0.1) {
            if (!visibleFilePaths.current.has(filePath)) {
              visibleFilePaths.current.add(filePath);
              changed = true;
            }
          } else {
            if (visibleFilePaths.current.has(filePath)) {
              visibleFilePaths.current.delete(filePath);
              changed = true;
            }
          }
        }

        if (changed) {
          debouncedUpdate();
        }
      },
      {
        root: scrollContainerRef.current,
        threshold: 0.1,
        rootMargin: '0px',
      }
    );

    return () => {
      observerRef.current?.disconnect();
      clearTimeout(debounceRef.current);
    };
  }, [scrollContainerRef, debouncedUpdate]);

  // Register ref callback
  const registerFileSectionRef = useCallback((filePath: string) => {
    return (element: HTMLElement | null) => {
      const observer = observerRef.current;
      if (!observer) return;

      // Cleanup previous
      const prev = elementRefs.current.get(filePath);
      if (prev) {
        observer.unobserve(prev);
        elementRefs.current.delete(filePath);
        visibleFilePaths.current.delete(filePath);
      }

      // Register new
      if (element) {
        element.setAttribute('data-file-path', filePath);
        elementRefs.current.set(filePath, element);
        observer.observe(element);
      }
    };
  }, []);

  return { registerFileSectionRef };
}
```

#### Ключевые отличия от `useVisibleAIGroup`

| Аспект | `useVisibleAIGroup` | `useVisibleFileSection` |
|--------|--------------------|-----------------------|
| threshold | `0.5` (default, configurable via `threshold?` option) | `0.1` (файлы длинные, 50% может быть за viewport) |
| debounce | нет (вызывает updateTopmostVisible синхронно) | 100ms (стабильность при быстром скролле) |
| programmatic scroll suppression | нет | да (`isProgrammaticScroll` ref) |
| data attribute | `data-aigroup-id` | `data-file-path` |
| root | опциональный `rootRef?.current ?? null` | обязательный `scrollContainerRef.current` |
| callback name | `onVisibleChange` | `onVisibleFileChange` |

#### Edge Cases

- **Пустой список файлов:** Observer создаётся, но никто не регистрируется — no-op
- **Один файл:** Всегда виден, `onVisibleFileChange` вызовется один раз при mount
- **Быстрый scroll:** Debounce 100ms группирует обновления
- **Resize окна:** IntersectionObserver автоматически пересчитывает intersections
- **scrollContainerRef.current is null при первом рендере:** Observer создаётся с `root: null` — будет наблюдать viewport вместо контейнера. Решение: добавить guard `if (!scrollContainerRef.current) return;` в useEffect, либо убедиться что ref установлен до mount дочерних компонентов (ref на тот же div что и scrollContainerRef)

---

### 2.5. `useContinuousScrollNav.ts`

**Путь:** `src/renderer/hooks/useContinuousScrollNav.ts`

**Назначение:** Навигация в continuous scroll — scroll-to-file, keyboard shortcuts, подавление scroll-spy во время programmatic scroll.

#### Interface

```typescript
import type { RefObject } from 'react';

interface UseContinuousScrollNavOptions {
  /** Ref на scroll container (ContinuousScrollView outer div) */
  scrollContainerRef: RefObject<HTMLElement>;

  /** Упорядоченный список filePath (порядок = порядок рендеринга) */
  filePaths: string[];

  /** Текущий активный файл (от scroll-spy) */
  activeFilePath: string | null;

  /** Диалог открыт (для keyboard listeners) */
  isOpen: boolean;
}

interface UseContinuousScrollNavReturn {
  /** Scroll к файлу по filePath (smooth) */
  scrollToFile: (filePath: string) => void;

  /**
   * Ref-flag: true пока идёт programmatic scroll.
   * Передаётся в useVisibleFileSection для подавления scroll-spy.
   */
  isProgrammaticScroll: RefObject<boolean>;
}
```

#### Реализация (описание)

```typescript
import { waitForScrollEnd } from '@renderer/hooks/navigation/utils';

export function useContinuousScrollNav(
  options: UseContinuousScrollNavOptions
): UseContinuousScrollNavReturn {
  const { scrollContainerRef, filePaths, activeFilePath, isOpen } = options;

  const isProgrammaticScroll = useRef(false);

  const scrollToFile = useCallback(
    (filePath: string) => {
      const container = scrollContainerRef.current;
      if (!container) return;

      const section = container.querySelector<HTMLElement>(
        `[data-file-path="${CSS.escape(filePath)}"]`
      );
      if (!section) return;

      // Подавить scroll-spy
      isProgrammaticScroll.current = true;

      section.scrollIntoView({ behavior: 'smooth', block: 'start' });

      // Дождаться окончания scroll и снять подавление
      // waitForScrollEnd default timeout = 400ms, передаём 500ms для запаса
      void waitForScrollEnd(container, 500).then(() => {
        isProgrammaticScroll.current = false;
      });
    },
    [scrollContainerRef]
  );

  // Keyboard: Alt+ArrowDown = next file, Alt+ArrowUp = prev file
  useEffect(() => {
    if (!isOpen) return;

    const handler = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const currentIdx = filePaths.indexOf(activeFilePath ?? '');
        const nextIdx = currentIdx < filePaths.length - 1 ? currentIdx + 1 : 0;
        scrollToFile(filePaths[nextIdx]);
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const currentIdx = filePaths.indexOf(activeFilePath ?? '');
        const prevIdx = currentIdx > 0 ? currentIdx - 1 : filePaths.length - 1;
        scrollToFile(filePaths[prevIdx]);
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, filePaths, activeFilePath, scrollToFile]);

  return {
    scrollToFile,
    isProgrammaticScroll,
  };
}
```

#### Race condition: scroll-spy vs programmatic scroll

**Проблема:** Когда пользователь кликает на файл в tree — мы вызываем `scrollToFile()`. Scroll-spy видит промежуточные файлы пролетающие мимо viewport и обновляет `activeFilePath`. Это "мигание" в tree.

**Решение:**
1. `isProgrammaticScroll` ref устанавливается в `true` перед `scrollIntoView`
2. `useVisibleFileSection` проверяет этот ref в `updateTopmostVisible` и молчит
3. `waitForScrollEnd()` (из `navigation/utils.ts`) ждёт стабилизации `scrollTop` (3 стабильных кадра `requestAnimationFrame` с `Math.abs(currentScrollTop - lastScrollTop) < 1`)
4. После стабилизации ref сбрасывается в `false`
5. Scroll-spy продолжает работать нормально

**Timeout:** `waitForScrollEnd` имеет дефолтный fallback timeout 400ms (строка 172 в `navigation/utils.ts`). Smooth scroll в Chromium занимает ~300-400ms. Передаём 500ms для запаса.

#### `CSS.escape(filePath)`

**Важно:** `filePath` может содержать спецсимволы (точки, слеши). `CSS.escape()` экранирует их для `querySelector`. Пример: `src/utils/path.ts` -> `src\/utils\/path\.ts` в селекторе.

#### Edge case: `filePaths.indexOf(activeFilePath ?? '')` returns -1

Если `activeFilePath` нет в `filePaths` (или null), `indexOf` вернёт -1. Тогда:
- ArrowDown: `nextIdx = -1 < length - 1 ? 0 : 0` = 0 — переход к первому файлу. OK.
- ArrowUp: `prevIdx = -1 > 0 ? ... : length - 1` = last — переход к последнему файлу. OK.

---

### 2.6. `ContinuousScrollView.tsx`

**Путь:** `src/renderer/components/team/review/ContinuousScrollView.tsx`

**Назначение:** Главный контейнер continuous scroll. Заменяет single-file diff area в `ChangeReviewDialog`.

#### Props Interface

```typescript
import type { EditorView } from '@codemirror/view';
import type {
  FileChangeSummary,
  FileChangeWithContent,
  HunkDecision,
} from '@shared/types';

interface ContinuousScrollViewProps {
  /** Список файлов из activeChangeSet.files */
  files: FileChangeSummary[];

  /** Загруженный контент: filePath -> FileChangeWithContent */
  fileContents: Record<string, FileChangeWithContent>;

  /** Флаги загрузки контента: filePath -> boolean */
  fileContentsLoading: Record<string, boolean>;

  /** Set просмотренных файлов */
  viewedSet: Set<string>;

  /** Ручные правки: filePath -> content string */
  editedContents: Record<string, string>;

  /** Решения по файлам: filePath -> HunkDecision */
  fileDecisions: Record<string, HunkDecision>;

  /** Collapse unchanged regions */
  collapseUnchanged: boolean;

  /** Applying in progress */
  applying: boolean;

  /** Auto-viewed включён */
  autoViewed: boolean;

  /** Counter для force rebuild editors при discard */
  discardCounter: number;

  // -- Callbacks --

  /** Hunk accepted в CodeMirror */
  onHunkAccepted: (filePath: string, hunkIndex: number) => void;

  /** Hunk rejected в CodeMirror */
  onHunkRejected: (filePath: string, hunkIndex: number) => void;

  /** Файл полностью просмотрен (auto-viewed) */
  onFullyViewed: (filePath: string) => void;

  /** Ручная правка контента */
  onContentChanged: (filePath: string, content: string) => void;

  /** Discard edits для файла */
  onDiscard: (filePath: string) => void;

  /** Save файла на диск */
  onSave: (filePath: string) => void;

  /** Callback: видимый файл изменился (scroll-spy). Parent обновляет activeFilePath */
  onVisibleFileChange: (filePath: string) => void;

  // -- Exposed refs --

  /** Ref для scroll container (передаётся из parent для scroll-to-file) */
  scrollContainerRef: React.RefObject<HTMLDivElement>;

  /** Map EditorView по filePath. Parent использует для keyboard shortcuts */
  editorViewMapRef: React.MutableRefObject<Map<string, EditorView>>;

  /** Ref: подавление scroll-spy (от useContinuousScrollNav) */
  isProgrammaticScroll: React.RefObject<boolean>;
}
```

#### Структура рендеринга

```tsx
export const ContinuousScrollView = ({
  files,
  fileContents,
  fileContentsLoading,
  viewedSet,
  editedContents,
  fileDecisions,
  collapseUnchanged,
  applying,
  autoViewed,
  discardCounter,
  onHunkAccepted,
  onHunkRejected,
  onFullyViewed,
  onContentChanged,
  onDiscard,
  onSave,
  onVisibleFileChange,
  scrollContainerRef,
  editorViewMapRef,
  isProgrammaticScroll,
}: ContinuousScrollViewProps) => {
  // Scroll-spy
  const { registerFileSectionRef } = useVisibleFileSection({
    onVisibleFileChange,
    scrollContainerRef,
    isProgrammaticScroll,
  });

  // EditorView registration callback
  const handleEditorViewReady = useCallback(
    (filePath: string, view: EditorView | null) => {
      if (view) {
        editorViewMapRef.current.set(filePath, view);
      } else {
        editorViewMapRef.current.delete(filePath);
      }
    },
    [editorViewMapRef]
  );

  return (
    <div
      ref={scrollContainerRef}
      className="flex-1 overflow-y-auto"
    >
      {files.map((file) => {
        const filePath = file.filePath;
        const content = fileContents[filePath] ?? null;
        const isLoading = fileContentsLoading[filePath] ?? false;
        const hasEdits = filePath in editedContents;
        const isViewed = viewedSet.has(filePath);
        const decision = fileDecisions[filePath];

        return (
          <div
            key={filePath}
            ref={registerFileSectionRef(filePath)}
            className="border-b border-border"
          >
            <FileSectionHeader
              file={file}
              fileContent={content}
              fileDecision={decision}
              hasEdits={hasEdits}
              applying={applying}
              onDiscard={onDiscard}
              onSave={onSave}
            />

            {isLoading ? (
              <FileSectionPlaceholder fileName={file.relativePath} />
            ) : (
              <FileSectionDiff
                file={file}
                fileContent={content}
                isLoading={false}
                collapseUnchanged={collapseUnchanged}
                onHunkAccepted={onHunkAccepted}
                onHunkRejected={onHunkRejected}
                onFullyViewed={onFullyViewed}
                onContentChanged={onContentChanged}
                onEditorViewReady={handleEditorViewReady}
                discardCounter={discardCounter}
                autoViewed={autoViewed}
                isViewed={isViewed}
              />
            )}
          </div>
        );
      })}

      {files.length === 0 && (
        <div className="flex h-full items-center justify-center text-sm text-text-muted">
          No file changes detected
        </div>
      )}
    </div>
  );
};
```

**Замечание по `isLoading`:** Когда loading=true, показывается placeholder вместо `FileSectionDiff`. Когда loading завершится (контент загружен) — перерисовка покажет diff. `FileSectionDiff` получает `isLoading={false}` потому что condition уже обработан выше.

**Замечание по `data-file-path`:** Атрибут устанавливается в двух местах:
1. На section div через `registerFileSectionRef` (для scroll-spy IntersectionObserver)
2. На sticky header внутри `FileSectionHeader` (для `querySelector` в `scrollToFile`)

`scrollToFile` использует `querySelector('[data-file-path="..."]')` — найдёт **первый** элемент, а это header (он вложен в section). Чтобы `scrollIntoView` скроллил к началу секции (а не к header внутри), нужно убедиться что selector находит section div. **Решение:** Убрать `data-file-path` из `FileSectionHeader` и оставить только на section div. Тогда `scrollToFile` найдёт section div, а `scrollIntoView({ block: 'start' })` покажет начало секции = sticky header.

#### EditorView Map

```typescript
// В parent (ChangeReviewDialog):
const editorViewMapRef = useRef(new Map<string, EditorView>());
```

**Зачем:** Keyboard shortcuts (`Cmd+Y`, `Cmd+N`) теперь должны знать, к какому EditorView применить действие. Логика:
1. Если EditorView имеет фокус (`view.hasFocus`) — применить к нему
2. Иначе — применить к EditorView `activeFilePath` (от scroll-spy)
3. Fallback — первый EditorView в Map

```typescript
// Helper в ChangeReviewDialog:
function getTargetEditorView(): EditorView | null {
  // 1. Focused editor
  for (const view of editorViewMapRef.current.values()) {
    if (view.hasFocus) return view;
  }
  // 2. Active file's editor
  if (activeFilePath) {
    return editorViewMapRef.current.get(activeFilePath) ?? null;
  }
  // 3. First available
  const first = editorViewMapRef.current.values().next();
  return first.done ? null : first.value;
}
```

---

## 3. Модификации существующих файлов

### 3.1. `ReviewFileTree.tsx`

#### Новые props

```typescript
interface ReviewFileTreeProps {
  files: FileChangeSummary[];
  selectedFilePath: string | null;
  onSelectFile: (filePath: string) => void;
  viewedSet?: Set<string>;
  onMarkViewed?: (filePath: string) => void;
  onUnmarkViewed?: (filePath: string) => void;

  // === НОВЫЕ ===
  /** Активный файл от scroll-spy (мягкая подсветка) */
  activeFilePath?: string;
}
```

#### Отличие `selectedFilePath` vs `activeFilePath`

| | `selectedFilePath` | `activeFilePath` |
|---|---|---|
| Источник | Клик по файлу в tree | Scroll-spy (IntersectionObserver) |
| Визуал | `bg-blue-500/20 text-blue-300` (сильная подсветка) | `border-l-2 border-blue-400` (мягкий индикатор) |
| Поведение | Клик -> scrollToFile | Автоматически обновляется при скролле |
| При клике | Совпадает с activeFilePath | Может отставать (debounce 100ms) |

**Визуальная логика в TreeItem:**

```typescript
const isSelected = node.file.filePath === selectedFilePath;
const isActive = node.file.filePath === activeFilePath && !isSelected;
```

Стили:
```typescript
className={cn(
  'flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors',
  isSelected
    ? 'bg-blue-500/20 text-blue-300'            // Клик
    : isActive
      ? 'border-l-2 border-blue-400 text-text'  // Scroll-spy
      : 'text-text-secondary hover:bg-surface-raised hover:text-text'
)}
```

#### Пробросить `activeFilePath` через TreeItem

TreeItem в текущем коде принимает inline props (не interface, а destructured объект, строки 108-126):

```typescript
const TreeItem = ({
  node,
  selectedFilePath,
  onSelectFile,
  depth,
  hunkDecisions,
  viewedSet,
  onMarkViewed,
  onUnmarkViewed,
}: { ... }) => { ... }
```

Нужно добавить `activeFilePath?: string` в этот inline type и пробрасывать дальше в рекурсивные `<TreeItem>` (строка 195-206).

#### Auto-scroll в tree при смене `activeFilePath`

```typescript
// В ReviewFileTree
useEffect(() => {
  if (!activeFilePath) return;

  const btn = document.querySelector<HTMLElement>(
    `[data-tree-file="${CSS.escape(activeFilePath)}"]`
  );
  if (btn) {
    btn.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}, [activeFilePath]);
```

#### data-tree-file attribute

Добавить на `<button>` файла в TreeItem (строка 131):
```tsx
<button
  data-tree-file={node.file.filePath}
  onClick={() => onSelectFile(node.file!.filePath)}
  className={cn( ... )}
  style={{ paddingLeft: `${depth * 12 + 8}px` }}
>
```

---

### 3.2. `ChangeReviewDialog.tsx`

#### Что УБРАТЬ

1. **`editorViewRef`** (строка 88: `const editorViewRef = useRef<EditorView | null>(null)`) — заменён на `editorViewMapRef`
2. **`editorStateCache`** (строка 95: `const editorStateCache = useRef(new Map<string, EditorState>())`) — не нужен в continuous mode (editors живут одновременно)
3. **`cachedInitialState`** / `setCachedInitialState` (строка 97) — не нужен
4. **`handleSelectFile`** (строки 125-135) — логика сохранения EditorState в cache больше не нужна
5. **Single-file diff area** (строки 432-568) — заменён на `ContinuousScrollView`
6. **`selectedFile` useMemo** (строки 239-242) — не нужен для выбора файла для рендеринга (но нужен для timeline sidebar — см. ниже)
7. **`fileContent` / `isFileContentLoading` derived values** (строки 244-247) — загрузка теперь в bulk при открытии
8. **Lazy-load useEffect** (строки 224-237) — заменяется на bulk-load (см. "Что ДОБАВИТЬ")
9. **`hasCurrentFileEdits`** (строки 120-122) — больше не нужен на уровне dialog (managed per-file в FileSectionHeader)
10. **Import `EditorState`** (строка 25) — больше не используется

#### Что ДОБАВИТЬ

1. **`activeFilePath` state:**
   ```typescript
   const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
   ```

2. **`editorViewMapRef`:**
   ```typescript
   const editorViewMapRef = useRef(new Map<string, EditorView>());
   ```

3. **`scrollContainerRef`:**
   ```typescript
   const scrollContainerRef = useRef<HTMLDivElement>(null);
   ```

4. **`discardCounter` state** — уже есть (строка 93), оставить

5. **`useContinuousScrollNav`:**
   ```typescript
   const filePaths = useMemo(
     () => (activeChangeSet?.files ?? []).map((f) => f.filePath),
     [activeChangeSet]
   );

   const { scrollToFile, isProgrammaticScroll } = useContinuousScrollNav({
     scrollContainerRef,
     filePaths,
     activeFilePath,
     isOpen: open,
   });
   ```

   **Замечание:** `allFilePaths` (строка 103-106) уже вычисляет то же самое для `useViewedFiles`. Можно переиспользовать:
   ```typescript
   const { scrollToFile, isProgrammaticScroll } = useContinuousScrollNav({
     scrollContainerRef,
     filePaths: allFilePaths,
     activeFilePath,
     isOpen: open,
   });
   ```

6. **Bulk-load контента при открытии:**
   Заменить lazy-load useEffect (строки 224-237) на:
   ```typescript
   useEffect(() => {
     if (!open || !activeChangeSet) return;

     for (const file of activeChangeSet.files) {
       if (!fileContents[file.filePath] && !fileContentsLoading[file.filePath]) {
         void fetchFileContent(teamName, memberName, file.filePath);
       }
     }
   }, [open, activeChangeSet, teamName, memberName, fileContents, fileContentsLoading, fetchFileContent]);
   ```

   **Важно:** `fetchFileContent` внутри себя проверяет `if (state.fileContents[filePath] || state.fileContentsLoading[filePath]) return;` (строка 264 в changeReviewSlice), поэтому дублирования запросов не будет. Но для чистоты проверяем и на стороне вызова.

   **Замечание:** `fetchFileContent` принимает `(teamName, memberName | undefined, filePath)`. В mode='task' `memberName` может быть undefined — это ОК, store обработает.

7. **`onSelectFile` в FileTree теперь вызывает `scrollToFile`:**
   ```typescript
   const handleTreeFileClick = useCallback(
     (filePath: string) => {
       scrollToFile(filePath);
     },
     [scrollToFile]
   );
   ```

8. **`handleAcceptAll` / `handleRejectAll`** — работают с `activeFilePath`:
   ```typescript
   const handleAcceptAll = useCallback(() => {
     const targetPath = activeFilePath;
     if (!targetPath) return;

     const view = editorViewMapRef.current.get(targetPath);
     if (view) acceptAllChunks(view);
     acceptAllFile(targetPath);
   }, [activeFilePath, acceptAllFile]);

   const handleRejectAll = useCallback(() => {
     const targetPath = activeFilePath;
     if (!targetPath) return;

     const view = editorViewMapRef.current.get(targetPath);
     if (view) rejectAllChunks(view);
     rejectAllFile(targetPath);
   }, [activeFilePath, rejectAllFile]);
   ```

9. **`handleSaveCurrentFile` / `handleDiscardCurrentFile`** — теперь принимают `filePath` как аргумент:

   **Важно:** `FileSectionHeader` вызывает `onDiscard(file.filePath)` и `onSave(file.filePath)`, передавая filePath. Поэтому callbacks должны принимать filePath:

   ```typescript
   const handleSaveFile = useCallback(
     (filePath: string) => {
       void saveEditedFile(filePath);
     },
     [saveEditedFile]
   );

   const handleDiscardFile = useCallback(
     (filePath: string) => {
       discardFileEdits(filePath);
       setDiscardCounter((c) => c + 1);
     },
     [discardFileEdits]
   );
   ```

   **Замечание о discardCounter:** В текущем single-file mode `discardCounter` инкрементируется глобально и используется в `key`. В continuous mode counter глобальный — при discard одного файла ВСЕ editors пересоздадутся. Это неоптимально, но допустимо для фазы 1. Оптимизация (per-file counter) — в будущем.

10. **`handleFullyViewed`** — теперь принимает filePath:
    ```typescript
    const handleFullyViewed = useCallback(
      (filePath: string) => {
        if (autoViewed && !isViewed(filePath)) {
          markViewed(filePath);
        }
      },
      [autoViewed, isViewed, markViewed]
    );
    ```

11. **`getTargetEditorView` helper:**
    ```typescript
    const getTargetEditorView = useCallback((): EditorView | null => {
      for (const view of editorViewMapRef.current.values()) {
        if (view.hasFocus) return view;
      }
      if (activeFilePath) {
        return editorViewMapRef.current.get(activeFilePath) ?? null;
      }
      const first = editorViewMapRef.current.values().next();
      return first.done ? null : first.value;
    }, [activeFilePath]);
    ```

12. **Cmd+N IPC listener** — использует `getTargetEditorView`:
    ```typescript
    useEffect(() => {
      if (!open) return;
      const cleanup = window.electronAPI?.review.onCmdN?.(() => {
        const view = getTargetEditorView();
        if (view) {
          rejectChunk(view);
          requestAnimationFrame(() => goToNextChunk(view));
        }
      });
      return cleanup ?? undefined;
    }, [open, getTargetEditorView]);
    ```

13. **`useDiffNavigation` — адаптация:**

    Текущая сигнатура:
    ```typescript
    useDiffNavigation(
      files: FileChangeSummary[],
      selectedFilePath: string | null,
      onSelectFile: (path: string) => void,
      editorViewRef: React.RefObject<EditorView | null>,
      isDialogOpen: boolean,
      onHunkAccepted?: (filePath: string, hunkIndex: number) => void,
      onHunkRejected?: (filePath: string, hunkIndex: number) => void,
      onClose?: () => void,
      onSaveFile?: () => void
    )
    ```

    В continuous mode:
    - `selectedFilePath` -> `activeFilePath`
    - `onSelectFile` -> `scrollToFile`
    - `editorViewRef` -> нужен прокси ref, или рефакторинг хука

    **Что используется из `useDiffNavigation`:**
    - `diffNav.showShortcutsHelp` / `diffNav.setShowShortcutsHelp` — для `KeyboardShortcutsHelp` (строка 337-339)
    - `diffNav.goToHunk(idx)` — для `FileEditTimeline.onEventClick` (строка 424)
    - `diffNav.currentHunkIndex` — для `FileEditTimeline.activeSnippetIndex` (строка 425)
    - Keyboard handlers (Cmd+Y, Alt+J, Cmd+Enter) — дублируют CM keymap + `useContinuousScrollNav`

    **Решение для фазы 1:**
    - Создать прокси ref `activeEditorViewRef` что всегда указывает на `getTargetEditorView()`:
      ```typescript
      const activeEditorViewRef = useRef<EditorView | null>(null);
      // Sync при смене activeFilePath
      useEffect(() => {
        activeEditorViewRef.current = editorViewMapRef.current.get(activeFilePath ?? '') ?? null;
      }, [activeFilePath]);
      ```
    - Передать в `useDiffNavigation`:
      ```typescript
      const diffNav = useDiffNavigation(
        activeChangeSet?.files ?? [],
        activeFilePath,
        scrollToFile,
        activeEditorViewRef,
        open,
        (filePath, hunkIndex) => setHunkDecision(filePath, hunkIndex, 'accepted'),
        (filePath, hunkIndex) => setHunkDecision(filePath, hunkIndex, 'rejected'),
        () => onOpenChange(false),
        handleSaveFile.bind(null, activeFilePath ?? '')
      );
      ```
    - **Проблема:** `handleSaveFile` ожидает filePath, а `onSaveFile` в useDiffNavigation — `() => void`. Нужен wrapper:
      ```typescript
      const handleSaveActiveFile = useCallback(() => {
        if (activeFilePath) void saveEditedFile(activeFilePath);
      }, [activeFilePath, saveEditedFile]);
      ```

    Keyboard handlers в `useDiffNavigation` (Cmd+Y, Alt+J) будут работать через `activeEditorViewRef` — они проверяют `event.defaultPrevented` (строка 123), поэтому если CM keymap уже обработал — пропустят.

#### Diff content area — замена

**Было** (строки 432-568):
```tsx
<div className="flex-1 overflow-y-auto">
  {selectedFile ? ( /* single file diff */ ) : ( /* "Select a file" placeholder */ )}
</div>
```

**Стало:**
```tsx
<ContinuousScrollView
  files={activeChangeSet.files}
  fileContents={fileContents}
  fileContentsLoading={fileContentsLoading}
  viewedSet={viewedSet}
  editedContents={editedContents}
  fileDecisions={fileDecisions}
  collapseUnchanged={collapseUnchanged}
  applying={applying}
  autoViewed={autoViewed}
  discardCounter={discardCounter}
  onHunkAccepted={(fp, idx) => setHunkDecision(fp, idx, 'accepted')}
  onHunkRejected={(fp, idx) => setHunkDecision(fp, idx, 'rejected')}
  onFullyViewed={handleFullyViewed}
  onContentChanged={updateEditedContent}
  onDiscard={handleDiscardFile}
  onSave={handleSaveFile}
  onVisibleFileChange={setActiveFilePath}
  scrollContainerRef={scrollContainerRef}
  editorViewMapRef={editorViewMapRef}
  isProgrammaticScroll={isProgrammaticScroll}
/>
```

#### Edit Timeline sidebar section

Timeline привязана к `activeFilePath` вместо `selectedReviewFilePath`. Нужно оставить `selectedFile` useMemo, но привязать к `activeFilePath`:

```typescript
const activeFile = useMemo(() => {
  if (!activeChangeSet || !activeFilePath) return null;
  return activeChangeSet.files.find((f) => f.filePath === activeFilePath) ?? null;
}, [activeChangeSet, activeFilePath]);
```

Sidebar секция (строки 406-429):
```tsx
{activeFile?.timeline && activeFile.timeline.events.length > 0 && (
  <div className="border-t border-border">
    <button
      onClick={() => setTimelineOpen(!timelineOpen)}
      className="flex w-full items-center gap-1.5 px-3 py-2 text-xs text-text-secondary hover:text-text"
    >
      <Clock className="size-3.5" />
      <span>Edit Timeline ({activeFile.timeline.events.length})</span>
      <ChevronDown className={cn('ml-auto size-3 transition-transform', timelineOpen && 'rotate-180')} />
    </button>
    {timelineOpen && (
      <FileEditTimeline
        timeline={activeFile.timeline}
        onEventClick={(idx) => diffNav.goToHunk(idx)}
        activeSnippetIndex={diffNav.currentHunkIndex}
      />
    )}
  </div>
)}
```

#### File tree — передать `activeFilePath`

```tsx
<ReviewFileTree
  files={activeChangeSet.files}
  selectedFilePath={null}  // В continuous mode нет "selected" — только active
  activeFilePath={activeFilePath}
  onSelectFile={handleTreeFileClick}
  viewedSet={viewedSet}
  onMarkViewed={markViewed}
  onUnmarkViewed={unmarkViewed}
/>
```

**Замечание:** `selectedFilePath={null}` — в continuous mode нет отдельного "selected" state. Подсветка только через `activeFilePath`.

#### Что делать с `selectReviewFile` из store

`selectReviewFile(filePath)` из `changeReviewSlice` (строка 148-150) устанавливает `selectedReviewFilePath` в store. В continuous mode это больше не используется для переключения контента.

Рекомендация: **не трогать store** — просто не вызывать `selectReviewFile` из ChangeReviewDialog. Store action останется для обратной совместимости. `selectedReviewFilePath` по-прежнему инициализируется при `fetchAgentChanges`/`fetchTaskChanges` (строки 121, 138) — это ОК, просто не используется в UI.

#### Удалить неиспользуемые импорты

После рефакторинга убрать:
- `import type { EditorState } from '@codemirror/state'`
- Если `CONTENT_SOURCE_LABELS` вынесен в `FileSectionHeader` — убрать из ChangeReviewDialog
- `CodeMirrorDiffView` (рендерится в `FileSectionDiff`)
- `DiffErrorBoundary` (рендерится в `FileSectionDiff`)
- `ReviewDiffContent` (рендерится в `FileSectionDiff`)

**Оставить:** `acceptAllChunks`, `rejectAllChunks` из `CodeMirrorDiffUtils` — используются в `handleAcceptAll`/`handleRejectAll`.
**Оставить:** `rejectChunk` из `@codemirror/merge` — используется в Cmd+N handler.
**Оставить:** `goToNextChunk` из `@codemirror/merge` — используется в Cmd+N handler.

---

## 4. Критические детали

### 4.1. Scroll-spy + Programmatic scroll race

**Последовательность при клике на файл в tree:**

1. User кликает файл B в tree
2. `handleTreeFileClick('B')` -> `scrollToFile('B')`
3. `isProgrammaticScroll.current = true`
4. `section.scrollIntoView({ behavior: 'smooth' })`
5. Scroll анимация: файл A проскакивает мимо viewport, файл B появляется
6. IntersectionObserver вызывает callback для файлов A, B, C...
7. `useVisibleFileSection.updateTopmostVisible()` проверяет `isProgrammaticScroll` -> **молчит**
8. `waitForScrollEnd()` resolve через ~300-400ms
9. `isProgrammaticScroll.current = false`
10. Debounced update (100ms) запустится при следующем IO callback — обновит activeFilePath на B

**Edge case:** Если пользователь кликает на другой файл пока предыдущий scroll ещё идёт:
- `isProgrammaticScroll` останется `true`
- Новый `scrollIntoView` перезаписывает scroll target
- Старый `waitForScrollEnd` promise resolve (scrollTop стабилизируется) — сбросит flag
- Новый `waitForScrollEnd` заменит промис — **потенциальный race**: flag может сброситься преждевременно

**Решение:** Использовать counter или AbortController:
```typescript
const scrollGeneration = useRef(0);

const scrollToFile = useCallback((filePath: string) => {
  // ...
  const gen = ++scrollGeneration.current;
  isProgrammaticScroll.current = true;
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  void waitForScrollEnd(container, 500).then(() => {
    if (scrollGeneration.current === gen) {
      isProgrammaticScroll.current = false;
    }
  });
}, [scrollContainerRef]);
```

### 4.2. EditorView Map vs один ref

**Было:** Один `editorViewRef = useRef<EditorView | null>(null)` — переписывался при каждом переключении файла.

**Стало:** `editorViewMapRef = useRef(new Map<string, EditorView>())` — все editors хранятся одновременно.

**Memory:** Каждый EditorView ~ 50-100KB. Для 50 файлов = 2.5-5MB. Приемлемо.

**Lifecycle:**
- Mount: `FileSectionDiff` создаёт CodeMirrorDiffView -> EditorView, регистрирует в Map
- Unmount: `FileSectionDiff` cleanup -> удаляет из Map
- В continuous mode **все** editors живут одновременно (пока все файлы в DOM)

### 4.3. editorStateCache не нужен

В continuous mode все editors живут одновременно. Нет "переключения файла" — нет необходимости сохранять/восстанавливать EditorState. Undo history живёт в самом EditorView.

**Discard edits:** Вместо сброса cache entry — `key` prop с `discardCounter` пересоздаёт CodeMirrorDiffView.

**Замечание:** Текущий `handleDiscardCurrentFile` (строка 153-160) также делает `editorStateCache.current.delete()` и `setCachedInitialState(undefined)`. Оба удаляются.

### 4.4. Keyboard Cmd+Y/N

В continuous scroll фокус может быть:
1. Внутри конкретного CodeMirror (user кликнул в diff) -> CM keymap обработает
2. Вне CodeMirror (user скроллит мышью) -> document keydown handler -> `getTargetEditorView()`

**Приоритет:**
1. CM keymap (если фокус в CM) — обработает и вернёт `true`, event не propagates
2. `useDiffNavigation` keyboard handler проверяет `event.defaultPrevented` (строка 123 в useDiffNavigation.ts) — если CM уже обработал, пропускает
3. Если CM не обработал — `useDiffNavigation` handler использует `activeEditorViewRef.current`
4. Cmd+N IPC handler (через `window.electronAPI.review.onCmdN`) — работает через `getTargetEditorView()`

**Конфликт Cmd+Y:** `useDiffNavigation` вызывает `acceptChunk(view)` (строка 149-153), а CM keymap тоже содержит `Mod-y` handler. Если фокус в CM — CM обработает первым и `event.defaultPrevented` будет true. Если фокус вне CM — useDiffNavigation handler сработает. Нет конфликта.

### 4.5. Performance: много CodeMirror editors одновременно

**Проблема:** 30+ CodeMirror editors в DOM одновременно = нагрузка на рендеринг.

**Mitigation (фаза 2):** Lazy loading — контент загружается по мере scroll. Editors создаются только для загруженных файлов.

**Mitigation (будущая фаза 3):** Virtualized rendering — только видимые файлы + буфер рендерятся в DOM. Файлы за пределами viewport заменяются placeholder фиксированной высоты.

**Для фазы 1:** Не оптимизировать — загрузить контент всех файлов при открытии (bulk). 20-30 файлов — OK для начала.

### 4.6. `data-file-path` дублирование

Атрибут `data-file-path` устанавливается:
1. `registerFileSectionRef` в `useVisibleFileSection` -> на section `<div>` (для IntersectionObserver)
2. Документ ранее предлагал его на sticky header в `FileSectionHeader`

**Решение:** Оставить `data-file-path` **только на section div** (через `registerFileSectionRef`). `scrollToFile` найдёт section div через `querySelector`, `scrollIntoView({ block: 'start' })` покажет начало секции. Scroll-spy observer тоже наблюдает section div. Один источник правды.

В `FileSectionHeader` `data-file-path` **не добавлять**.

### 4.7. Загрузка контента при mode='task'

`fetchFileContent(teamName, memberName, filePath)` — в mode='task' `memberName` может быть `undefined`. Текущая signature в store (строка 261): `fetchFileContent(teamName: string, memberName: string | undefined, filePath: string)`. Это ОК.

---

## 5. Порядок реализации

### Шаг 1: Создать `FileSectionPlaceholder.tsx`
- Простой компонент, без зависимостей
- Тестирование: визуально убедиться что skeleton выглядит ок

### Шаг 2: Создать `FileSectionHeader.tsx`
- Извлечь из ChangeReviewDialog строки 437-509
- Вынести `CONTENT_SOURCE_LABELS`
- Добавить sticky positioning
- Импортировать `Save`, `Undo2`, `Loader2` из lucide-react, `Tooltip`/`TooltipTrigger`/`TooltipContent`
- **НЕ добавлять** `data-file-path` на header (только на section div в ContinuousScrollView)
- Тестирование: рендерить standalone, проверить sticky поведение

### Шаг 3: Создать `FileSectionDiff.tsx`
- Извлечь из ChangeReviewDialog строки 511-561
- Добавить проверку `fileContent.modifiedFullContent !== null` в условие рендеринга CodeMirror
- Добавить sentinel для auto-viewed (threshold: 0.85)
- Добавить editorView registration callback
- Передать `onFullyViewed={undefined}` в CodeMirrorDiffView (отключить встроенный sentinel)
- Тестирование: рендерить с mock data, проверить что CodeMirror создаётся

### Шаг 4: Создать `useVisibleFileSection.ts`
- По паттерну `useVisibleAIGroup.ts`
- Добавить debounce и isProgrammaticScroll
- Guard на `scrollContainerRef.current` is null
- Тестирование: unit test с mock IntersectionObserver

### Шаг 5: Создать `useContinuousScrollNav.ts`
- scrollToFile с waitForScrollEnd(container, 500)
- Keyboard listeners (Alt+Arrow)
- Scroll generation counter для предотвращения race при быстрых кликах
- Тестирование: unit test keyboard events

### Шаг 6: Создать `ContinuousScrollView.tsx`
- Собрать все компоненты вместе
- files.map -> section (header + diff)
- Интегрировать useVisibleFileSection
- `data-file-path` только на section div (через registerFileSectionRef)
- Тестирование: рендерить с 3-5 файлами, проверить scroll и sticky headers

### Шаг 7: Модифицировать `ReviewFileTree.tsx`
- Добавить `activeFilePath` prop в `ReviewFileTreeProps`
- Добавить `activeFilePath` в inline props TreeItem и пробросить рекурсивно
- Добавить `data-tree-file` attribute на button
- Добавить auto-scroll useEffect
- Добавить визуальную подсветку active файла (isActive condition + border-l-2 стиль)
- Тестирование: проверить подсветку active vs selected

### Шаг 8: Модифицировать `ChangeReviewDialog.tsx`
- Заменить single-file area на ContinuousScrollView
- Убрать: editorViewRef, editorStateCache, cachedInitialState, handleSelectFile, hasCurrentFileEdits, selectedFile (заменить на activeFile)
- Добавить: activeFilePath, editorViewMapRef, scrollContainerRef, activeEditorViewRef
- Заменить lazy-load на bulk-load useEffect
- Интегрировать useContinuousScrollNav
- Адаптировать: handleAcceptAll/handleRejectAll, handleSaveFile (принимает filePath), handleDiscardFile (принимает filePath), handleFullyViewed (принимает filePath)
- Адаптировать useDiffNavigation: activeFilePath, scrollToFile, activeEditorViewRef
- Адаптировать Cmd+N handler: getTargetEditorView
- Timeline sidebar: selectedFile -> activeFile
- FileTree: selectedFilePath={null}, activeFilePath, onSelectFile=handleTreeFileClick
- Убрать неиспользуемые импорты
- Тестирование: полный E2E flow

---

## 6. Проверка

### Функциональная проверка

- [ ] Открыть ChangeReviewDialog с 3+ файлами
- [ ] Все файлы отображаются вертикально друг под другом
- [ ] Sticky headers прилипают при скролле
- [ ] File tree подсвечивает текущий файл при скролле (scroll-spy)
- [ ] Клик по файлу в tree = smooth scroll к файлу в контенте
- [ ] Нет "мигания" active файла при programmatic scroll
- [ ] Alt+ArrowDown/Up переключает между файлами
- [ ] Cmd+Y accept chunk работает (focused editor и fallback через getTargetEditorView)
- [ ] Cmd+N reject chunk работает (через IPC и через useDiffNavigation fallback)
- [ ] Accept All / Reject All применяются к active файлу
- [ ] Save/Discard кнопки в header работают (каждый файл независимо)
- [ ] Auto-viewed работает (скроллить до конца файла — sentinel 85%)
- [ ] Viewed checkbox в tree работает
- [ ] Edit timeline sidebar показывается для active файла
- [ ] Escape закрывает диалог
- [ ] Быстрый двойной клик по разным файлам в tree — нет race condition (scroll generation counter)

### Edge cases

- [ ] 0 файлов — показывает "No file changes detected"
- [ ] 1 файл — scroll-spy стабильно, нет navigation issues
- [ ] Файл с `contentSource: 'unavailable'` — показывает ReviewDiffContent fallback
- [ ] Файл с `modifiedFullContent === null` — показывает ReviewDiffContent fallback
- [ ] Файл загружается — показывает FileSectionPlaceholder
- [ ] Файл с isNewFile — показывает NEW badge в sticky header
- [ ] Очень длинный файл (1000+ строк) — smooth scroll работает
- [ ] Collapse unchanged toggle — все editors обновляются (через collapseUnchanged prop -> CodeMirrorDiffView reconfigure)
- [ ] Discard edits — editor пересоздаётся (key с discardCounter; глобальный counter, все editors rebuild — ОК для фазы 1)
- [ ] Resize window — IntersectionObserver пересчитывает, scroll-spy корректен
- [ ] mode='task' с memberName=undefined — bulk-load работает

### Performance

- [ ] 20 файлов — открытие < 2 секунд
- [ ] Scroll не лагает с 10+ CodeMirror editors
- [ ] Memory не утекает при close/reopen диалога (EditorView.destroy() через cleanup в CodeMirrorDiffView + editorViewMapRef cleanup)
