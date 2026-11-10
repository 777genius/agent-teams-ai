# Phase 5: Polish + EditorView Map + Toolbar адаптация

## 1. Обзор

Финальная фаза Continuous Scroll Diff View. Задачи:

- **EditorView Map** -- централизованный реестр всех EditorView экземпляров в ContinuousScrollView, необходимый для глобальных действий (Accept All, Reject All) и keyboard navigation.
- **Keyboard shortcuts координация** -- Cmd+Y/N/Enter должны корректно определять, с каким EditorView работать, когда на экране отображаются десятки файлов одновременно.
- **Auto-viewed для каждого файла** -- каждый FileSectionDiff отслеживает свой viewed-статус через IntersectionObserver.
- **ReviewToolbar адаптация** -- кнопки "Accept All" и "Reject All" теперь оперируют ВСЕМИ файлами, а не текущим. Добавляется progress indicator.
- **ChangeReviewDialog адаптация** -- handlers переключаются на multi-file режим, per-file discard counters.
- **Cleanup и edge-cases** -- корректная очистка при unmount, batch-обновления для 50+ файлов.

**Предусловия:** Phase 1 (ContinuousScrollView), Phase 2 (lazy loading), Phase 3 (navigation), Phase 4 (portionCollapse) -- все завершены.

---

## 2. EditorView Map в ContinuousScrollView

### 2.1. Структура данных

```typescript
// ContinuousScrollView.tsx (внутри компонента)
const editorViewMapRef = useRef<Map<string, EditorView>>(new Map());
```

Map хранит `filePath -> EditorView` для каждого смонтированного FileSectionDiff. Используется `useRef`, а не `useState`, потому что:
- EditorView-инстансы не являются React-состоянием
- Изменение Map не должно вызывать ре-рендер ContinuousScrollView
- Доступ к Map нужен синхронно из event handlers

### 2.2. Callback-интерфейс FileSectionDiff

FileSectionDiff использует единый callback для регистрации/дерегистрации EditorView, как определено в Phase 1:

```typescript
// FileSectionDiff.tsx — props interface (из Phase 1, секция 2.2)
interface FileSectionDiffProps {
  filePath: string;
  original: string;
  modified: string;
  fileName: string;
  readOnly: boolean;
  showMergeControls: boolean;
  collapseUnchanged: boolean;
  discardCounter: number;
  // ... другие props

  /**
   * Вызывается при создании EditorView (view !== null) и при уничтожении (view === null).
   * Единый callback по паттерну Phase 1.
   */
  onEditorViewReady: (filePath: string, view: EditorView | null) => void;
}
```

**Важно:** Используется ОДИН callback `onEditorViewReady(filePath, view | null)`, а НЕ два отдельных (`onEditorViewReady` + `onEditorViewDestroyed`). Это соответствует дизайну Phase 1 (секция 2.2 FileSectionDiff), где `view === null` сигнализирует об уничтожении EditorView.

### 2.3. Реализация в FileSectionDiff

FileSectionDiff оборачивает CodeMirrorDiffView и управляет lifecycle:

```typescript
// FileSectionDiff.tsx (из Phase 1, секция 2.2)
const localEditorViewRef = useRef<EditorView | null>(null);

// Sync to parent Map при mount/unmount
useEffect(() => {
  return () => {
    // При unmount сообщить parent что view уничтожен
    onEditorViewReady(filePath, null);
  };
}, [filePath, onEditorViewReady]);

// Нужен useEffect чтобы проверить ref после рендера CodeMirrorDiffView
useEffect(() => {
  if (localEditorViewRef.current) {
    onEditorViewReady(filePath, localEditorViewRef.current);
  }
});
```

**Важно:** CodeMirrorDiffView устанавливает `editorViewRef.current` синхронно в своём useEffect. Наш вторичный useEffect (без deps) ловит это на следующем render cycle.

**Альтернативная реализация с requestAnimationFrame** (для гарантии синхронизации):

```typescript
useEffect(() => {
  const rafId = requestAnimationFrame(() => {
    const view = localEditorViewRef.current;
    if (view) {
      onEditorViewReady(filePath, view);
    }
  });

  return () => {
    cancelAnimationFrame(rafId);
    if (localEditorViewRef.current) {
      onEditorViewReady(filePath, null);
      localEditorViewRef.current = null;
    }
  };
}, [filePath, discardCounter]);
```

### 2.4. Регистрация в ContinuousScrollView

```typescript
// ContinuousScrollView.tsx (единый handler по паттерну Phase 1)
const handleEditorViewReady = useCallback(
  (filePath: string, view: EditorView | null) => {
    if (view) {
      editorViewMapRef.current.set(filePath, view);
    } else {
      editorViewMapRef.current.delete(filePath);
    }
  },
  []
);
```

Передаётся каждому `FileSectionDiff`:

```tsx
<FileSectionDiff
  filePath={file.filePath}
  onEditorViewReady={handleEditorViewReady}
  // ... другие props
/>
```

### 2.5. Передача Map наружу

ContinuousScrollView передает Map наружу через `useImperativeHandle`:

```typescript
// ContinuousScrollView.tsx
export interface ContinuousScrollViewHandle {
  getEditorViewMap: () => Map<string, EditorView>;
  getActiveEditorView: () => EditorView | null;
}

const ContinuousScrollView = forwardRef<ContinuousScrollViewHandle, ContinuousScrollViewProps>(
  (props, ref) => {
    const editorViewMapRef = useRef<Map<string, EditorView>>(new Map());

    useImperativeHandle(ref, () => ({
      getEditorViewMap: () => editorViewMapRef.current,
      getActiveEditorView: () => {
        // Логика определения активного editor (см. секцию 3)
        return resolveActiveEditorView(editorViewMapRef.current, props.activeFilePath);
      },
    }), [props.activeFilePath]);

    // ...
  }
);
```

В ChangeReviewDialog:

```typescript
const continuousScrollRef = useRef<ContinuousScrollViewHandle>(null);

<ContinuousScrollView ref={continuousScrollRef} ... />

// Использование:
const map = continuousScrollRef.current?.getEditorViewMap();
const activeView = continuousScrollRef.current?.getActiveEditorView();
```

**Решение:** используем `useImperativeHandle` -- он инкапсулирует логику определения активного editor внутри ContinuousScrollView, где есть доступ к scroll-spy данным.

---

## 3. Keyboard shortcuts координация (Cmd+Y/N)

### 3.1. Проблема

В single-file режиме `editorViewRef.current` -- всегда один EditorView. В continuous scroll -- их может быть десятки. Нужно определить, какой EditorView является "активным" для команд accept/reject.

### 3.2. Алгоритм resolveActiveEditorView

```typescript
function resolveActiveEditorView(
  editorViewMap: Map<string, EditorView>,
  activeFilePath: string
): EditorView | null {
  // 1. Приоритет: EditorView, который имеет фокус
  const activeEl = document.activeElement;
  if (activeEl) {
    for (const [, view] of editorViewMap) {
      if (view.dom.contains(activeEl)) {
        return view;
      }
    }
  }

  // 2. Fallback: EditorView для activeFilePath (из scroll-spy)
  if (activeFilePath) {
    return editorViewMap.get(activeFilePath) ?? null;
  }

  return null;
}
```

**Логика приоритетов:**
1. Если пользователь кликнул в CodeMirror editor (ставит фокус) -- используем именно этот editor. `document.activeElement` будет внутри `.cm-content` элемента.
2. Если фокус вне editor (например, после скролла мышью) -- используем editor для файла, определенного scroll-spy как видимый (`activeFilePath`).

### 3.3. Интеграция с useDiffNavigation (Phase 3)

Phase 3 уже определяет `continuousOptions?: ContinuousNavigationOptions` как 10-й параметр `useDiffNavigation`. Этот объект включает:

```typescript
interface ContinuousNavigationOptions {
  editorViewRefs: Map<string, EditorView>;
  activeFilePath: string | null;
  scrollToFile: (filePath: string) => void;
  enabled: boolean;
}
```

Внутри `useDiffNavigation` Phase 3 реализует helper `getActiveEditorView()`, который определяет активный editor по приоритету: focused > activeFilePath > first editor.

**Phase 5 НЕ добавляет новых параметров в useDiffNavigation.** Вся логика определения активного editor уже заложена в Phase 3 через `continuousOptions`. Phase 5 лишь использует эту инфраструктуру:

```typescript
// В ChangeReviewDialog.tsx — передача continuousOptions (определено Phase 3)
const continuousOptions = useMemo(
  (): ContinuousNavigationOptions | undefined => {
    if (!isContinuousMode) return undefined;
    return {
      editorViewRefs: continuousScrollRef.current?.getEditorViewMap() ?? new Map(),
      activeFilePath: continuousScrollActiveFilePath,
      scrollToFile: scrollToFile,
      enabled: true,
    };
  },
  [isContinuousMode, continuousScrollActiveFilePath, scrollToFile]
);

const diffNav = useDiffNavigation(
  activeChangeSet?.files ?? [],
  selectedReviewFilePath,
  handleSelectFile,
  editorViewRef,
  open,
  (filePath, hunkIndex) => setHunkDecision(filePath, hunkIndex, 'accepted'),
  (filePath, hunkIndex) => setHunkDecision(filePath, hunkIndex, 'rejected'),
  () => onOpenChange(false),
  handleSaveCurrentFile,
  continuousOptions  // <-- 10-й параметр из Phase 3
);
```

### 3.4. Cmd+Y: Accept + goToNextChunk

Поток действий:
1. `resolveActiveEditorView()` -> получаем EditorView
2. `acceptChunk(view)` -- принимает текущий chunk в этом editor
3. `requestAnimationFrame(() => goToNextChunk(view))` -- прокручивает к следующему chunk
4. **Cross-file transition:** если это был последний chunk в файле, Phase 3 обрабатывает cross-file navigation через `isLastChunkInFile()` и `scrollToFile()`.

### 3.5. Cmd+N: Reject + goToNextChunk

Аналогично Cmd+Y, но вызывает `rejectChunk(view)`. Обработка через IPC-listener `window.electronAPI.review.onCmdN`:

```typescript
// В ChangeReviewDialog.tsx — модификация IPC listener
useEffect(() => {
  if (!open) return;
  const cleanup = window.electronAPI?.review.onCmdN?.(() => {
    const view = isContinuousMode
      ? continuousScrollRef.current?.getActiveEditorView() ?? null
      : editorViewRef.current;
    if (view) {
      rejectChunk(view);
      requestAnimationFrame(() => goToNextChunk(view));
    }
  });
  return cleanup ?? undefined;
}, [open, isContinuousMode]);
```

### 3.6. Cmd+Enter: Save file

Сохраняет только `activeFilePath`, не все файлы:

```typescript
// Cmd+Enter handler
if (isMeta && event.key === 'Enter') {
  event.preventDefault();
  if (activeFilePath) {
    saveEditedFile(activeFilePath);
  }
  return;
}
```

Где `activeFilePath` -- из scroll-spy (ContinuousScrollView props).

### 3.7. Alt+J: Next change

```typescript
// Alt+J handler (реализовано в Phase 3 keyboard handler)
if (event.altKey && event.key.toLowerCase() === 'j') {
  event.preventDefault();
  const view = getActiveEditorView(editorViewRef, continuousOptions);
  if (view) goToNextChunk(view);
  return;
}
```

---

## 4. Auto-viewed для каждого файла

### 4.1. Текущий механизм (single-file mode)

В CodeMirrorDiffView.tsx:
- `endSentinelRef` -- невидимый `<div>` после editor
- IntersectionObserver с `threshold: 1.0`
- При пересечении вызывается `onFullyViewed()` callback
- В ChangeReviewDialog: `handleFullyViewed` -> `markViewed(selectedReviewFilePath)`

### 4.2. Continuous mode: per-file sentinel

Каждый `FileSectionDiff` содержит свой sentinel для auto-viewed:

```typescript
// FileSectionDiff.tsx
const endSentinelRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  if (!endSentinelRef.current || !autoViewed) return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          onFullyViewed(filePath);
        }
      }
    },
    { threshold: 0.85 }  // НЕ 1.0 — portionCollapse может компактить файл
  );

  observer.observe(endSentinelRef.current);
  return () => observer.disconnect();
}, [filePath, autoViewed, onFullyViewed]);

return (
  <div>
    <CodeMirrorDiffView ... />
    {/* Sentinel для auto-viewed detection */}
    <div ref={endSentinelRef} className="h-px shrink-0" />
  </div>
);
```

### 4.3. Threshold: 0.85 вместо 1.0

Обоснование:
- `threshold: 1.0` означает "100% элемента видимо". Для sentinel в 1px это работает.
- Но в continuous mode sentinel может быть в viewport из-за подскролла следующего файла, пока текущий файл ещё не полностью просмотрен.
- Решение: sentinel размещаем ПОСЛЕ CodeMirrorDiffView внутри FileSectionDiff. Threshold 0.85 дает некоторый margin для portionCollapse, который может сильно уменьшить высоту файла.
- Sentinel для 1px элемента с threshold 0.85 сработает, когда sentinel "почти полностью" видим -- это надежно.

### 4.4. onFullyViewed callback в ContinuousScrollView

```typescript
// ContinuousScrollView.tsx
const handleFileFullyViewed = useCallback((filePath: string) => {
  if (autoViewed && !isViewed(filePath)) {
    markViewed(filePath);
  }
}, [autoViewed, isViewed, markViewed]);
```

Передается каждому FileSectionDiff:

```tsx
<FileSectionDiff
  filePath={file.filePath}
  autoViewed={autoViewed}
  onFullyViewed={handleFileFullyViewed}
  // ...
/>
```

### 4.5. Отличие от single-file mode

В single-file mode за один скролл пользователь видит один файл. В continuous mode несколько файлов могут быть "viewed" за один скролл. Это корректное поведение:

- Маленькие файлы (1-5 строк diff) мгновенно проскакивают viewport
- Их sentinel пересекается с viewport -> onFullyViewed срабатывает
- `markViewed()` идемпотентен (useViewedFiles проверяет через Set)

### 4.6. autoViewed toggle

Toggle в toolbar контролирует глобальный `autoViewed` state. Когда выключен:
- IntersectionObserver все ещё работает, но `handleFileFullyViewed` проверяет `autoViewed` flag и делает early return
- Альтернатива: не создавать IntersectionObserver при `autoViewed === false` (более оптимально)

Предпочтительная реализация (оптимизированная):

```typescript
// FileSectionDiff.tsx
useEffect(() => {
  if (!endSentinelRef.current || !autoViewed) return;
  // Observer создается только когда autoViewed=true
  // ...
}, [filePath, autoViewed, onFullyViewed]);
```

---

## 5. Модификация ReviewToolbar.tsx

### 5.1. Accept All / Reject All -- все файлы

Текущие tooltip:
- "Accept all changes in current file"
- "Reject all changes in current file"

В continuous mode:
- "Accept all changes across all files"
- "Reject all changes across all files"

**Реализация:** ReviewToolbar получает новый prop `isContinuousMode`:

```typescript
interface ReviewToolbarProps {
  stats: { pending: number; accepted: number; rejected: number };
  changeStats: ChangeStats;
  collapseUnchanged: boolean;
  applying: boolean;
  autoViewed: boolean;
  onAutoViewedChange: (auto: boolean) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onApply: () => void;
  onCollapseUnchangedChange: (collapse: boolean) => void;
  editedCount?: number;
  /** Phase 5: continuous scroll mode -- changes tooltip text */
  isContinuousMode?: boolean;
}
```

Tooltip:

```tsx
<TooltipContent side="bottom">
  {isContinuousMode
    ? 'Accept all changes across all files'
    : 'Accept all changes in current file'}
</TooltipContent>
```

### 5.2. Progress indicator: "12 of 45 changes reviewed"

Новый UI элемент между change stats и action buttons.

```typescript
// ReviewToolbar.tsx — новый prop
interface ReviewToolbarProps {
  // ...
  /** Total hunks reviewed (accepted + rejected) */
  reviewedCount?: number;
  /** Total hunks across all files */
  totalHunks?: number;
}
```

Вычисление в ChangeReviewDialog:

```typescript
const reviewProgress = useMemo(() => {
  if (!activeChangeSet) return { reviewed: 0, total: 0 };

  let total = 0;
  let reviewed = 0;

  for (const file of activeChangeSet.files) {
    for (let i = 0; i < file.snippets.length; i++) {
      total++;
      const key = `${file.filePath}:${i}`;
      const decision = hunkDecisions[key];
      if (decision === 'accepted' || decision === 'rejected') {
        reviewed++;
      }
    }
  }

  return { reviewed, total };
}, [activeChangeSet, hunkDecisions]);
```

Отображение в ReviewToolbar:

```tsx
{/* Progress indicator */}
{totalHunks !== undefined && totalHunks > 0 && (
  <div className="flex items-center gap-2 text-xs">
    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-zinc-700/50">
      <div
        className="h-full rounded-full bg-blue-500/70 transition-all duration-300"
        style={{ width: `${totalHunks > 0 ? (reviewedCount! / totalHunks) * 100 : 0}%` }}
      />
    </div>
    <span className="text-text-muted">
      {reviewedCount} of {totalHunks} reviewed
    </span>
  </div>
)}
```

**Позиция в toolbar:** после change stats (`+N -M across K files`), перед separator (`<div className="h-4 w-px bg-border" />`).

### 5.3. Итоговый layout toolbar (слева направо)

1. Decision stats badges (pending, accepted, rejected)
2. Change stats (+N -M across K files)
3. Review progress bar ("12 of 45 reviewed")
4. `flex-1` spacer
5. Collapse toggle
6. Auto-viewed toggle
7. Separator
8. Edited count badge (если есть)
9. Separator (если есть edited)
10. Accept All button
11. Reject All button
12. Apply button

---

## 6. Модификация ChangeReviewDialog.tsx

### 6.1. handleAcceptAll -- все файлы

Текущая реализация:

```typescript
const handleAcceptAll = useCallback(() => {
  const view = editorViewRef.current;
  if (view) acceptAllChunks(view);
  if (selectedReviewFilePath) acceptAllFile(selectedReviewFilePath);
}, [selectedReviewFilePath, acceptAllFile]);
```

Continuous mode:

```typescript
const handleAcceptAll = useCallback(() => {
  if (isContinuousMode) {
    // 1. Store: пометить все hunks во всех файлах как accepted
    acceptAll(); // store action — уже помечает ВСЕ файлы

    // 2. CM: применить acceptAllChunks к каждому EditorView
    const map = continuousScrollRef.current?.getEditorViewMap();
    if (map) {
      const views = Array.from(map.values());
      // Batch: используем requestAnimationFrame для предотвращения layout thrashing
      requestAnimationFrame(() => {
        for (const view of views) {
          acceptAllChunks(view);
        }
      });
    }
  } else {
    // Single-file mode (без изменений)
    const view = editorViewRef.current;
    if (view) acceptAllChunks(view);
    if (selectedReviewFilePath) acceptAllFile(selectedReviewFilePath);
  }
}, [isContinuousMode, acceptAll, selectedReviewFilePath, acceptAllFile]);
```

### 6.2. handleRejectAll -- все файлы

```typescript
const handleRejectAll = useCallback(() => {
  if (isContinuousMode) {
    // 1. Store: пометить все hunks во всех файлах как rejected
    rejectAll(); // store action

    // 2. CM: применить rejectAllChunks к каждому EditorView
    const map = continuousScrollRef.current?.getEditorViewMap();
    if (map) {
      const views = Array.from(map.values());
      requestAnimationFrame(() => {
        for (const view of views) {
          rejectAllChunks(view);
        }
      });
    }
  } else {
    const view = editorViewRef.current;
    if (view) rejectAllChunks(view);
    if (selectedReviewFilePath) rejectAllFile(selectedReviewFilePath);
  }
}, [isContinuousMode, rejectAll, selectedReviewFilePath, rejectAllFile]);
```

### 6.3. handleSaveFile -- по activeFilePath

```typescript
const handleSaveFile = useCallback((filePath: string) => {
  void saveEditedFile(filePath);
}, [saveEditedFile]);

// Для toolbar/keyboard: сохраняет activeFilePath
const handleSaveActiveFile = useCallback(() => {
  if (isContinuousMode) {
    // activeFilePath определяется scroll-spy в ContinuousScrollView
    // Передается через state или callback
    const activePath = continuousScrollActiveFilePath;
    if (activePath) handleSaveFile(activePath);
  } else {
    if (selectedReviewFilePath) handleSaveFile(selectedReviewFilePath);
  }
}, [isContinuousMode, continuousScrollActiveFilePath, selectedReviewFilePath, handleSaveFile]);
```

### 6.4. handleDiscardFile -- per-file

```typescript
const handleDiscardFile = useCallback((filePath: string) => {
  // В continuous mode editorStateCache НЕ используется
  // (все editors живут одновременно — cache не нужен, см. Phase 1 секция 4.3)
  discardFileEdits(filePath);
  setDiscardCounters(prev => ({
    ...prev,
    [filePath]: (prev[filePath] ?? 0) + 1
  }));
}, [discardFileEdits]);

// Для keyboard/toolbar: discard activeFilePath
const handleDiscardActiveFile = useCallback(() => {
  const activePath = isContinuousMode
    ? continuousScrollActiveFilePath
    : selectedReviewFilePath;
  if (activePath) handleDiscardFile(activePath);
}, [isContinuousMode, continuousScrollActiveFilePath, selectedReviewFilePath, handleDiscardFile]);
```

**Важно:** `editorStateCache` не используется в continuous mode. Phase 1 (секция 4.3) устанавливает, что в continuous mode все editors живут одновременно и нет необходимости в кеше EditorState. Discard реализуется через `discardCounters` (пересоздание через key).

### 6.5. isContinuousMode state

```typescript
// ChangeReviewDialog.tsx
// Phase 5: continuous scroll mode
// Вычисляется, не является toggle:
const isContinuousMode = (activeChangeSet?.files.length ?? 0) > 1;
```

**Решение:** `isContinuousMode` вычисляется, не является toggle. Continuous mode включается когда файлов > 1. Для одного файла -- обычный single-file mode (без ContinuousScrollView).

### 6.6. activeFilePath из ContinuousScrollView

ContinuousScrollView определяет видимый файл через scroll-spy и сообщает родителю:

```typescript
// ContinuousScrollView.tsx props
interface ContinuousScrollViewProps {
  // ...
  onActiveFileChange: (filePath: string) => void;
}
```

В ChangeReviewDialog:

```typescript
const [continuousScrollActiveFilePath, setContinuousScrollActiveFilePath] = useState<string | null>(null);

<ContinuousScrollView
  onActiveFileChange={setContinuousScrollActiveFilePath}
  // ...
/>
```

---

## 7. Per-file discard counter

### 7.1. Проблема

Текущий `discardCounter` -- одно число для всего диалога. При discard оно инкрементируется, и CodeMirrorDiffView пересоздается через `key={filePath}:${discardCounter}`.

В continuous mode каждый файл имеет свой `CodeMirrorDiffView`. Инкремент общего counter пересоздаст ВСЕ EditorView -- это неэффективно и потеряет scroll position.

### 7.2. Решение: Record<string, number>

```typescript
// ChangeReviewDialog.tsx
const [discardCounters, setDiscardCounters] = useState<Record<string, number>>({});
```

### 7.3. Использование в FileSectionDiff key

```tsx
// ContinuousScrollView.tsx — передает counter каждому FileSectionDiff
{files.map(file => (
  <FileSectionDiff
    key={`${file.filePath}:${discardCounters[file.filePath] ?? 0}`}
    filePath={file.filePath}
    discardCounter={discardCounters[file.filePath] ?? 0}
    // ...
  />
))}
```

Внутри FileSectionDiff, CodeMirrorDiffView:

```tsx
<CodeMirrorDiffView
  key={`${filePath}:${discardCounter}`}
  // ...
/>
```

### 7.4. Discard action

```typescript
const handleDiscardFile = useCallback((filePath: string) => {
  // 1. Удаляем edited content из store
  discardFileEdits(filePath);

  // 2. Инкрементируем counter ТОЛЬКО для этого файла
  setDiscardCounters(prev => ({
    ...prev,
    [filePath]: (prev[filePath] ?? 0) + 1,
  }));
}, [discardFileEdits]);
```

Результат: пересоздается ТОЛЬКО EditorView для конкретного файла. Все остальные EditorViews сохраняют состояние.

### 7.5. Обратная совместимость

Для single-file mode (когда ContinuousScrollView не используется) сохраняется существующий `discardCounter: number` без изменений. `discardCounters: Record<string, number>` используется только в continuous mode. Оба варианта сосуществуют в ChangeReviewDialog:

```typescript
// Single-file mode: существующий counter
const [discardCounter, setDiscardCounter] = useState(0);

// Continuous mode: per-file counters
const [discardCounters, setDiscardCounters] = useState<Record<string, number>>({});
```

---

## 8. Cleanup при закрытии

### 8.1. EditorView Map

При unmount ContinuousScrollView:
1. Каждый FileSectionDiff вызывает `onEditorViewReady(filePath, null)` (единый callback)
2. Map автоматически очищается
3. EditorView.destroy() вызывается внутри CodeMirrorDiffView cleanup

```typescript
// ContinuousScrollView.tsx
useEffect(() => {
  return () => {
    // Safety: на случай если unmount происходит до cleanup дочерних
    editorViewMapRef.current.clear();
  };
}, []);
```

### 8.2. Store state

`clearChangeReview()` из changeReviewSlice уже сбрасывает:
- `activeChangeSet`
- `hunkDecisions`
- `fileDecisions`
- `fileContents`
- `fileContentsLoading`
- `editedContents`
- `applying`
- `applyError`

Дополнительных действий не требуется.

### 8.3. Viewed state

`viewedSet` persistent через `localStorage` (useViewedFiles -> diffViewedStorage). НЕ очищается при закрытии диалога -- это намеренное поведение (пользователь может закрыть и открыть диалог, и viewed файлы останутся).

### 8.4. discardCounters

React state -- автоматически GC при unmount компонента. Не persistent.

---

## 9. Edge-cases

### 9.1. 50 EditorViews в памяти

**Проблема:** каждый EditorView -- DOM-элемент с syntax highlighting, diff computations, merge extensions.

**Смягчение:**
- portionCollapse (Phase 4) минимизирует видимый контент: свёрнутые regions не рендерят DOM-ноды
- Lazy loading (Phase 2) гарантирует, что контент загружается по мере необходимости, а не все сразу

**Если профилирование покажет проблемы:**
- Будущая оптимизация: destroy EditorView для файлов далеко за пределами viewport
- `onEditorViewReady(filePath, null)` уже в интерфейсе -- переход на destroy/recreate модель не потребует изменения API
- Placeholder вместо destroyed EditorView (высота сохраняется через cached `scrollHeight`)

**Реализация (не в Phase 5, на будущее):**

```typescript
// Идея: IntersectionObserver с rootMargin для pre-destroy
const DESTROY_MARGIN = '2000px'; // destroy если > 2000px от viewport

const observer = new IntersectionObserver(
  entries => {
    for (const entry of entries) {
      const filePath = entry.target.dataset.filePath!;
      if (entry.isIntersecting) {
        // Восстановить EditorView
      } else {
        // Destroy EditorView, сохранить высоту
      }
    }
  },
  { rootMargin: DESTROY_MARGIN }
);
```

### 9.2. Accept All + 50 файлов

**Проблема:** `acceptAllChunks` на 50 EditorView может вызвать layout thrashing.

**Решение:**

```typescript
// Batch: один rAF на все view updates
requestAnimationFrame(() => {
  const map = continuousScrollRef.current?.getEditorViewMap();
  if (!map) return;

  for (const view of map.values()) {
    acceptAllChunks(view);
  }
});
```

Это группирует все DOM-мутации в один frame. CodeMirror batches DOM updates внутри `dispatch()`, так что 50 dispatches в одном rAF -- приемлемо.

**Store:** `acceptAll()` уже batched -- одна транзакция `set()` обновляет все `hunkDecisions` и `fileDecisions`.

### 9.3. Cmd+Y/N без видимых chunks

**Сценарий:** все chunks в текущем файле уже accepted/rejected. Пользователь нажимает Cmd+Y.

**Поведение:** `acceptChunk(view)` от @codemirror/merge не делает ничего, если нет chunk под cursor. `goToNextChunk(view)` аналогично -- no-op.

**Это корректно.** Не нужен дополнительный feedback (звук, toast и т.д.).

### 9.4. File save в continuous mode

**Сценарий:** пользователь нажимает Cmd+Enter. Сохраняется только `activeFilePath`, НЕ все отредактированные файлы.

**Обоснование:**
- Пользователь ожидает "save THIS file", не "save ALL files"
- Для массового save есть Apply All Changes
- Если добавить "Save All Edited" -- это отдельная фича (не в Phase 5)

### 9.5. Scroll position после Accept All / Reject All

**Проблема:** Accept All может значительно изменить высоту контента (deleted chunks исчезают). Scroll position может сместиться.

**Решение:** браузер автоматически корректирует scroll при изменении высоты элементов ВЫШЕ viewport. Для элементов В viewport -- пользователь увидит изменение, что ожидаемо.

Если нужно сохранить позицию:

```typescript
// Перед Accept All
const scrollTop = scrollContainerRef.current?.scrollTop ?? 0;
// ... apply accept all ...
requestAnimationFrame(() => {
  scrollContainerRef.current?.scrollTo({ top: scrollTop });
});
```

Но это может быть нежелательно (пользователь хочет видеть результат). **Решение: не корректировать scroll.**

### 9.6. Race condition: onEditorViewReady + component key change

**Сценарий:** discard file -> key меняется -> old FileSectionDiff unmount -> new mount.

**Порядок:**
1. Old component: cleanup effect -> `onEditorViewReady(filePath, null)` -> Map.delete
2. New component: effect -> `onEditorViewReady(filePath, newView)` -> Map.set

React гарантирует cleanup effects ПЕРЕД mount effects. Race condition невозможна.

### 9.7. EditorView для файла с unavailable content

Если `fileContent.contentSource === 'unavailable'`, FileSectionDiff рендерит fallback (ReviewDiffContent), не CodeMirrorDiffView. EditorView не создается -> не попадает в Map.

При Accept All/Reject All -- файлы без EditorView обрабатываются только через store (hunkDecisions). Это корректно.

---

## 10. Проверка

### 10.1. Автоматические тесты

**Unit tests:**

| Тест | Файл | Что проверяет |
|------|------|---------------|
| resolveActiveEditorView с focused editor | `resolveActiveEditorView.test.ts` | Возвращает focused EditorView из Map |
| resolveActiveEditorView fallback на activeFilePath | `resolveActiveEditorView.test.ts` | Возвращает EditorView для activeFilePath |
| resolveActiveEditorView пустая Map | `resolveActiveEditorView.test.ts` | Возвращает null |
| discardCounters per-file increment | `ChangeReviewDialog.test.ts` | Инкремент только для одного файла |
| reviewProgress computation | `ChangeReviewDialog.test.ts` | Корректный подсчет reviewed/total |
| ReviewToolbar tooltip в continuous mode | `ReviewToolbar.test.ts` | "across all files" текст |

**Integration tests:**

| Тест | Что проверяет |
|------|---------------|
| Accept All в continuous mode | Store + все EditorViews обновлены |
| Reject All в continuous mode | Store + все EditorViews обновлены |
| Discard one file | Только один EditorView пересоздан |
| Auto-viewed multiple files | Несколько файлов помечены viewed за один скролл |
| Keyboard Cmd+Y с focused editor | Accept в focused editor, не в activeFilePath |

### 10.2. Ручное тестирование

**Чеклист:**

- [ ] Открыть review dialog с 5+ файлами
- [ ] Проскроллить вниз — auto-viewed помечает файлы по мере скролла
- [ ] Выключить auto-viewed toggle — скролл не помечает файлы
- [ ] Cmd+Y в focused editor — принимает chunk в этом editor
- [ ] Cmd+Y без фокуса — принимает chunk в activeFilePath editor
- [ ] Cmd+N — отклоняет chunk + переходит к следующему
- [ ] Cmd+Enter — сохраняет только текущий файл
- [ ] "Accept All" кнопка — все chunks во всех файлах accepted
- [ ] "Reject All" кнопка — все chunks во всех файлах rejected
- [ ] Discard файла — только этот EditorView пересоздается
- [ ] Progress bar обновляется при accept/reject
- [ ] Закрытие и повторное открытие — viewed state сохранен
- [ ] 20+ файлов — scroll не лагает
- [ ] Accept All + 20 файлов — без видимого зависания

### 10.3. Performance профилирование

- [ ] Chrome DevTools Performance: rAF timing при Accept All с 20 файлов (должен быть < 100ms)
- [ ] Memory: heap snapshot с 20 EditorViews (ожидание: ~50-80MB total)
- [ ] Layout: no forced synchronous layouts при scroll

---

## Приложение: Полный diff изменений по файлам

### Новые файлы

Нет новых файлов в Phase 5 (все компоненты созданы в Phase 1-4).

### Модифицируемые файлы

| Файл | Изменения |
|------|-----------|
| `ContinuousScrollView.tsx` | EditorView Map, useImperativeHandle, onActiveFileChange callback |
| `FileSectionDiff.tsx` | onEditorViewReady(filePath, view \| null) единый callback, per-file sentinel, autoViewed |
| `ChangeReviewDialog.tsx` | isContinuousMode, handleAcceptAll/RejectAll multi-file, discardCounters, continuousScrollActiveFilePath state, EditorView Map через ref |
| `ReviewToolbar.tsx` | isContinuousMode tooltip, progress indicator, reviewedCount/totalHunks props |
| `useDiffNavigation.ts` | Без дополнительных изменений Phase 5 — вся continuous mode логика уже реализована в Phase 3 (continuousOptions, getActiveEditorView, cross-file navigation) |

### Неизменяемые файлы

| Файл | Причина |
|------|---------|
| `CodeMirrorDiffView.tsx` | Без изменений — все обертывается через FileSectionDiff |
| `CodeMirrorDiffUtils.ts` | acceptAllChunks/rejectAllChunks уже поддерживают per-view вызов |
| `changeReviewSlice.ts` | acceptAll()/rejectAll() уже работают со всеми файлами |
| `useViewedFiles.ts` | markViewed() уже поддерживает per-file вызовы |
| `ReviewFileTree.tsx` | Без изменений в Phase 5 (модифицирован в Phase 1) |
| `KeyboardShortcutsHelp.tsx` | Без изменений в Phase 5 (модифицирован в Phase 3) |
