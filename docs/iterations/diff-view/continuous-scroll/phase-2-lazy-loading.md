# Фаза 2: Lazy Loading контента

## 1. Обзор

**Предпосылка:** В фазе 1 continuous scroll рендерит все файлы одновременно. Но контент файлов (`FileChangeWithContent`) загружается через IPC-вызов `fetchFileContent(teamName, memberName, filePath)` — это сетевой запрос к main process, который читает файл с диска, строит diff и возвращает `originalFullContent` + `modifiedFullContent`.

**Проблема:** При открытии review с 30+ файлами загрузка всех сразу:
- Блокирует main process 30 последовательными IPC-вызовами
- UI показывает 30 skeleton placeholders одновременно
- Пользователь видит контент только после загрузки всех файлов
- Для больших файлов (>10K строк) задержка ощутима

**Решение:** Lazy loading — контент загружается по мере приближения файла к viewport:
- Первые 5 файлов предзагружаются при mount (без ожидания scroll)
- Остальные файлы загружаются при пересечении rootMargin "200% 0px" (2 viewport-высоты до видимости)
- Максимум 3 параллельных загрузки (throttle) — не перегружать main process
- Приоритет: файлы ближе к viewport загружаются раньше

**Результат:** Пользователь видит первые файлы через ~200ms, остальные подгружаются бесшовно при скролле.

---

## 2. Новые файлы

### 2.1. `useLazyFileContent.ts`

**Путь:** `src/renderer/hooks/useLazyFileContent.ts`

**Назначение:** IntersectionObserver-based lazy loading контента файлов через `fetchFileContent` из changeReviewSlice.

#### Interface

```typescript
import type { RefObject } from 'react';
import type { FileChangeWithContent } from '@shared/types';

interface UseLazyFileContentOptions {
  /** Имя команды (для fetchFileContent) */
  teamName: string;

  /** Имя участника (для fetchFileContent) */
  memberName: string | undefined;

  /** Список всех filePath в порядке рендеринга */
  filePaths: string[];

  /** Scroll container ref (ContinuousScrollView outer div) */
  scrollContainerRef: RefObject<HTMLElement>;

  /**
   * Загруженный контент из store (для проверки: уже загружен?).
   * Тип: Record<string, FileChangeWithContent> из changeReviewSlice.
   */
  fileContents: Record<string, FileChangeWithContent>;

  /** Флаги загрузки из store (для проверки: уже грузится?) */
  fileContentsLoading: Record<string, boolean>;

  /**
   * Функция загрузки контента из store.
   * Сигнатура точно как в changeReviewSlice.fetchFileContent:
   * (teamName: string, memberName: string | undefined, filePath: string) => Promise<void>
   *
   * Внутри store уже есть guard от дубликатов (строка 264):
   *   if (state.fileContents[filePath] || state.fileContentsLoading[filePath]) return;
   * Поэтому двойной вызов безопасен.
   */
  fetchFileContent: (
    teamName: string,
    memberName: string | undefined,
    filePath: string
  ) => Promise<void>;

  /** Lazy loading включён (false = загрузить всё сразу, для fallback) */
  enabled: boolean;
}

interface UseLazyFileContentReturn {
  /**
   * Регистрация file section для lazy-load наблюдения.
   * Возвращает ref callback — передать в div section.
   * Пример: <div ref={registerLazyRef(file.filePath)}>
   */
  registerLazyRef: (filePath: string) => (element: HTMLElement | null) => void;
}
```

#### Полная реализация (описание)

```typescript
export function useLazyFileContent(
  options: UseLazyFileContentOptions
): UseLazyFileContentReturn {
  const {
    teamName,
    memberName,
    filePaths,
    scrollContainerRef,
    fileContents,
    fileContentsLoading,
    fetchFileContent,
    enabled,
  } = options;

  // === Throttle State ===

  // Set: filePath текущих in-flight загрузок
  const activeLoads = useRef(new Set<string>());

  // Queue: filePath ожидающих загрузки (FIFO, но с приоритетом)
  const pendingQueue = useRef<string[]>([]);

  // Max параллельных загрузок
  const MAX_CONCURRENT = 3;

  // Observer ref
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Element refs
  const elementRefs = useRef(new Map<string, HTMLElement>());

  // Stable refs для текущих значений (избежание stale closures)
  const fileContentsRef = useRef(fileContents);
  const fileContentsLoadingRef = useRef(fileContentsLoading);

  useEffect(() => {
    fileContentsRef.current = fileContents;
    fileContentsLoadingRef.current = fileContentsLoading;
  }, [fileContents, fileContentsLoading]);

  // === Throttled Loader ===

  /**
   * Проверяет, нужно ли загружать filePath:
   * - Не загружен (нет в fileContents)
   * - Не грузится (нет в fileContentsLoading или false)
   * - Не в activeLoads (не in-flight)
   *
   * ВАЖНО: проверяем fileContentsRef (ref), а не fileContents (prop) —
   * чтобы callback IntersectionObserver видел актуальное состояние.
   */
  const shouldLoad = useCallback((filePath: string): boolean => {
    if (fileContentsRef.current[filePath]) return false;
    if (fileContentsLoadingRef.current[filePath]) return false;
    if (activeLoads.current.has(filePath)) return false;
    return true;
  }, []);

  /**
   * Запустить загрузку одного файла.
   * Возвращает Promise (для chaining).
   */
  const loadFile = useCallback(
    async (filePath: string): Promise<void> => {
      if (!shouldLoad(filePath)) return;

      activeLoads.current.add(filePath);
      try {
        await fetchFileContent(teamName, memberName, filePath);
      } finally {
        activeLoads.current.delete(filePath);
        // После завершения — попробовать следующий из очереди
        processQueue();
      }
    },
    [teamName, memberName, fetchFileContent, shouldLoad]
  );

  /**
   * Обработать очередь: запустить загрузки пока slots < MAX_CONCURRENT.
   */
  const processQueue = useCallback(() => {
    while (
      activeLoads.current.size < MAX_CONCURRENT &&
      pendingQueue.current.length > 0
    ) {
      const nextPath = pendingQueue.current.shift()!;
      if (shouldLoad(nextPath)) {
        void loadFile(nextPath);
      }
      // Если nextPath уже не нужен (загружен за время ожидания) — пропускаем, берём следующий
    }
  }, [shouldLoad, loadFile]);

  /**
   * Добавить filePath в очередь загрузки.
   * Если есть свободные слоты — загрузить сразу.
   * Если нет — добавить в pending queue.
   */
  const enqueueLoad = useCallback(
    (filePath: string) => {
      if (!shouldLoad(filePath)) return;

      if (activeLoads.current.size < MAX_CONCURRENT) {
        // Есть свободный слот — загружаем сразу
        void loadFile(filePath);
      } else {
        // Очередь заполнена — добавить в pending (если ещё нет)
        if (!pendingQueue.current.includes(filePath)) {
          pendingQueue.current.push(filePath);
        }
      }
    },
    [shouldLoad, loadFile]
  );

  // === Preload первых N файлов при mount ===

  const PRELOAD_COUNT = 5;

  useEffect(() => {
    if (!enabled) return;

    // Загрузить первые 5 файлов сразу
    const toPreload = filePaths.slice(0, PRELOAD_COUNT);
    for (const fp of toPreload) {
      enqueueLoad(fp);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]); // Намеренно: только при mount (enabled = true)

  // === IntersectionObserver ===

  useEffect(() => {
    if (!enabled) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;

          const filePath = entry.target.getAttribute('data-lazy-file');
          if (!filePath) continue;

          enqueueLoad(filePath);

          // После загрузки — перестать наблюдать (загружается один раз)
          // Но мы не можем unobserve сразу (загрузка async) — unobserve когда контент загружен
          // Проще: observer продолжает наблюдать, shouldLoad() вернёт false для загруженных
        }
      },
      {
        root: scrollContainerRef.current,
        // 200% от viewport сверху и снизу — предзагрузка за 2 экрана
        rootMargin: '200% 0px 200% 0px',
        threshold: 0,
      }
    );

    // Зарегистрировать все уже mounted элементы
    for (const [, element] of elementRefs.current) {
      observerRef.current.observe(element);
    }

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [enabled, scrollContainerRef, enqueueLoad]);

  // === Register ref callback ===

  const registerLazyRef = useCallback((filePath: string) => {
    return (element: HTMLElement | null) => {
      const observer = observerRef.current;

      // Cleanup previous
      const prev = elementRefs.current.get(filePath);
      if (prev && observer) {
        observer.unobserve(prev);
      }
      elementRefs.current.delete(filePath);

      // Register new
      if (element) {
        element.setAttribute('data-lazy-file', filePath);
        elementRefs.current.set(filePath, element);
        if (observer) {
          observer.observe(element);
        }
      }
    };
  }, []);

  return { registerLazyRef };
}
```

#### Ключевые аспекты

##### rootMargin "200% 0px 200% 0px"

IntersectionObserver `rootMargin` расширяет область наблюдения за пределы видимого viewport. `200%` означает 2x viewport-высоты сверху и снизу.

**Пример:** Viewport = 800px. rootMargin = 200% -> +1600px сверху и снизу. Файл начнёт загружаться когда его section находится в 1600px от видимой области.

**Почему 200%:** Smooth scroll на Chromium покрывает ~300-400px/сек. При viewport 800px пользователь доскроллит до следующей "зоны" за 2-4 секунды. Загрузка файла через IPC занимает ~50-200ms. 200% даёт достаточный запас для предзагрузки.

##### MAX_CONCURRENT = 3

**Почему 3, а не больше:**
- Electron main process обрабатывает IPC последовательно (single thread)
- Каждый `fetchFileContent` читает файл, парсит diff, возвращает контент
- 3 параллельных запроса = main process занят ~100% на файловых операциях
- Больше 3 = запросы встают в очередь IPC, но main process не ускоряется
- Бонус: оставляет "дышать" main process для других IPC (file watcher, config)

##### Preload первых 5 файлов

При mount (открытие диалога) загружаем первые 5 файлов немедленно (без ожидания IntersectionObserver).

**Почему 5:**
- Viewport обычно вмещает 2-3 file sections
- 5 = 2-3 видимых + 2 "за кадром" для плавного scroll
- Preload занимает ~200-500ms (3 параллельно + 2 в очереди)

**Timing:** Preload запускается одновременно с рендерингом DOM. К моменту первого paint IntersectionObserver ещё не успел сработать, но preload уже отправил запросы.

##### Приоритет в очереди

В текущей реализации очередь FIFO (first-in, first-out). Файлы добавляются в порядке пересечения rootMargin — ближайшие к viewport первыми.

**Возможное улучшение (если потребуется):** Реордеринг очереди при scroll event. Но FIFO достаточно для типичного use case (скролл сверху вниз).

##### Repeated observations

IntersectionObserver продолжает наблюдать все элементы, даже загруженные. Это ОК:
1. Callback вызовется для уже загруженного файла
2. `shouldLoad()` проверяет `fileContentsRef.current[filePath]` -> файл есть -> `return false`
3. `enqueueLoad` ничего не делает

Альтернатива `observer.unobserve()` после загрузки добавляет сложности (нужен callback из store, race conditions). Текущий подход проще и не имеет performance penalty (observer callback -- O(1) проверка).

---

## 3. Модификации существующих файлов

### 3.1. `changeReviewSlice.ts` -- НЕ требует изменений

**Решение: `prefetchFileContents` НЕ НУЖЕН.**

Изначально предполагался convenience-метод `prefetchFileContents` для batch-вызова. Однако при ревью обнаружено:

1. `useLazyFileContent` уже реализует preload первых 5 файлов через `enqueueLoad` в useEffect при mount -- это полностью покрывает потребность в batch preload.
2. `fetchFileContent` уже имеет внутренний guard от дубликатов (строка 262-264 в `changeReviewSlice.ts`):
   ```typescript
   const state = get();
   // Skip if already loaded or loading
   if (state.fileContents[filePath] || state.fileContentsLoading[filePath]) return;
   ```
3. `useLazyFileContent.enqueueLoad` добавляет поверх store guard ещё `activeLoads` ref-трекинг для throttle -- т.е. тройная защита от дубликатов.

Добавление `prefetchFileContents` в store создаст дублирование с `useLazyFileContent` preload и не даст throttle (все запросы уйдут параллельно). **Оставляем store без изменений.**

---

### 3.2. `ContinuousScrollView.tsx`

#### Интеграция `useLazyFileContent`

**Новые props (добавляются к существующим props фазы 1):**

```typescript
interface ContinuousScrollViewProps {
  // ... все существующие props из фазы 1 (см. phase-1 документ) ...

  // === НОВЫЕ для фазы 2 ===
  /** Имя команды */
  teamName: string;

  /** Имя участника */
  memberName: string | undefined;

  /**
   * Функция загрузки контента из store.
   * Сигнатура: (teamName: string, memberName: string | undefined, filePath: string) => Promise<void>
   * Из changeReviewSlice.fetchFileContent
   */
  fetchFileContent: (
    teamName: string,
    memberName: string | undefined,
    filePath: string
  ) => Promise<void>;
}
```

**Интеграция в компоненте:**

```typescript
export const ContinuousScrollView = (props: ContinuousScrollViewProps) => {
  const {
    files,
    fileContents,
    fileContentsLoading,
    teamName,
    memberName,
    fetchFileContent,
    scrollContainerRef,
    isProgrammaticScroll,
    // ... rest из Phase 1
  } = props;

  const filePaths = useMemo(() => files.map((f) => f.filePath), [files]);

  // Scroll-spy (фаза 1)
  const { registerFileSectionRef } = useVisibleFileSection({
    onVisibleFileChange: props.onVisibleFileChange,
    scrollContainerRef,
    isProgrammaticScroll,
  });

  // Lazy loading (фаза 2)
  const { registerLazyRef } = useLazyFileContent({
    teamName,
    memberName,
    filePaths,
    scrollContainerRef,
    fileContents,
    fileContentsLoading,
    fetchFileContent,
    enabled: true,
  });

  // Комбинированный ref callback: регистрация в обоих observers
  const combinedRef = useCallback(
    (filePath: string) => {
      const sectionRef = registerFileSectionRef(filePath);
      const lazyRef = registerLazyRef(filePath);

      return (element: HTMLElement | null) => {
        sectionRef(element);
        lazyRef(element);
      };
    },
    [registerFileSectionRef, registerLazyRef]
  );

  // EditorView registration callback (Phase 1, без изменений)
  const handleEditorViewReady = useCallback(
    (filePath: string, view: EditorView | null) => {
      if (view) {
        props.editorViewMapRef.current.set(filePath, view);
      } else {
        props.editorViewMapRef.current.delete(filePath);
      }
    },
    [props.editorViewMapRef]
  );

  return (
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
      {files.map((file) => {
        const filePath = file.filePath;
        const content = fileContents[filePath] ?? null;
        const isLoading = fileContentsLoading[filePath] ?? false;
        const hasContent = content !== null;

        return (
          <div
            key={filePath}
            ref={combinedRef(filePath)}    // <-- Комбинированный ref (Phase 1 scroll-spy + Phase 2 lazy)
            className="border-b border-border"
          >
            <FileSectionHeader
              file={file}
              fileContent={content}
              fileDecision={props.fileDecisions[filePath]}
              hasEdits={filePath in props.editedContents}
              applying={props.applying}
              onDiscard={props.onDiscard}
              onSave={props.onSave}
            />

            {/* Контент ещё не загружен — placeholder */}
            {!hasContent && isLoading && (
              <FileSectionPlaceholder fileName={file.relativePath} />
            )}

            {/* Контент ещё не начал грузиться — тоже placeholder */}
            {!hasContent && !isLoading && (
              <FileSectionPlaceholder fileName={file.relativePath} />
            )}

            {/* Контент загружен — diff */}
            {hasContent && (
              <FileSectionDiff
                file={file}
                fileContent={content}
                isLoading={false}
                collapseUnchanged={props.collapseUnchanged}
                onHunkAccepted={props.onHunkAccepted}
                onHunkRejected={props.onHunkRejected}
                onFullyViewed={props.onFullyViewed}
                onContentChanged={props.onContentChanged}
                onEditorViewReady={handleEditorViewReady}
                discardCounter={props.discardCounter}
                autoViewed={props.autoViewed}
                isViewed={props.viewedSet.has(filePath)}
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

**Отличие от Phase 1 ContinuousScrollView:** В Phase 1 `ref={registerFileSectionRef(filePath)}` использовался напрямую. В Phase 2 заменён на `ref={combinedRef(filePath)}`, который вызывает оба ref callback (scroll-spy + lazy). Phase 1 рендерил `FileSectionDiff` / `FileSectionPlaceholder` по условию `isLoading` (ternary). Phase 2 добавляет промежуточное состояние "не начал грузиться" (`!hasContent && !isLoading`).

#### Два placeholder состояния

| Состояние | `hasContent` | `isLoading` | Что показывать |
|-----------|-------------|-------------|----------------|
| Не начал грузиться | false | false | `FileSectionPlaceholder` |
| Грузится | false | true | `FileSectionPlaceholder` |
| Загружен | true | - | `FileSectionDiff` |
| Ошибка загрузки | false | false | `FileSectionPlaceholder` (потом retry) |

**Замечание:** "Не начал грузиться" -- файл ещё не попал в rootMargin IntersectionObserver. Placeholder показывается, но без индикатора загрузки. Визуально идентичен "грузится" -- это ОК, пользователь не различает.

**Ошибка загрузки:** `fetchFileContent` в store ставит `fileContentsLoading[fp] = false` (строка 279) и НЕ записывает в `fileContents` (строка 278 -- catch блок). Результат: `hasContent = false, isLoading = false` -- снова placeholder. IntersectionObserver при следующем пересечении вызовет `enqueueLoad` -- retry произойдёт автоматически (при re-scroll).

**Важно:** `shouldLoad()` в `useLazyFileContent` проверяет `fileContentsRef.current[filePath]` -- после ошибки этого ключа нет, поэтому повторный вызов пройдёт. Также `fileContentsLoadingRef.current[filePath]` будет `false` (store сбросил loading). Таким образом retry корректно сработает.

Если нужен явный retry без scroll: добавить кнопку "Retry" в placeholder. Но для фазы 2 автоматический retry через scroll достаточен.

#### `combinedRef` -- объединение двух ref callbacks

```typescript
const combinedRef = useCallback(
  (filePath: string) => {
    const sectionRef = registerFileSectionRef(filePath);
    const lazyRef = registerLazyRef(filePath);

    return (element: HTMLElement | null) => {
      sectionRef(element);
      lazyRef(element);
    };
  },
  [registerFileSectionRef, registerLazyRef]
);
```

**Зачем:** Оба хука (`useVisibleFileSection`, `useLazyFileContent`) используют IntersectionObserver на одном и том же элементе (file section div). Вместо двух отдельных ref -- один объединённый.

**data attributes:** Каждый callback ставит свой атрибут:
- `registerFileSectionRef` -> `data-file-path`
- `registerLazyRef` -> `data-lazy-file`

Оба атрибута на одном элементе -- ОК, они используются разными observers.

---

### 3.3. `ChangeReviewDialog.tsx`

#### Убрать lazy-load useEffect

**Было** (строки 224-237 текущего файла):
```typescript
// Lazy-load file content when file selected
useEffect(() => {
  if (!open || !selectedReviewFilePath) return;
  if (fileContents[selectedReviewFilePath] || fileContentsLoading[selectedReviewFilePath]) return;
  void fetchFileContent(teamName, memberName, selectedReviewFilePath);
}, [
  open,
  selectedReviewFilePath,
  teamName,
  memberName,
  fileContents,
  fileContentsLoading,
  fetchFileContent,
]);
```

**Стало:** Удалить этот useEffect целиком. Загрузка контента теперь полностью делегирована `useLazyFileContent` внутри `ContinuousScrollView`:
- Preload первых 5 файлов при mount
- Остальные подгружаются по IntersectionObserver

#### Передать новые props в ContinuousScrollView

```tsx
<ContinuousScrollView
  // ... props из фазы 1 ...
  teamName={teamName}
  memberName={memberName}
  fetchFileContent={fetchFileContent}
/>
```

**Примечание:** `teamName` берётся из props `ChangeReviewDialogProps`, `memberName` оттуда же (optional prop). `fetchFileContent` берётся из `useStore()` (строка 77 текущего файла).

---

## 4. Throttle реализация: детали

### Структура данных

```
┌─────────────────┐
│  activeLoads     │ Set<string>  -- max 3 элемента
│  (in-flight)     │
├─────────────────┤
│  pendingQueue    │ string[]     -- FIFO очередь
│  (waiting)       │
└─────────────────┘
```

### Жизненный цикл загрузки

```
1. IntersectionObserver fires -> enqueueLoad(filePath)
2. shouldLoad() checks:
   - fileContentsRef.current[fp]? -> skip (already loaded)
   - fileContentsLoadingRef.current[fp]? -> skip (store knows about it)
   - activeLoads.has(fp)? -> skip (our local tracking)
3. activeLoads.size < MAX_CONCURRENT?
   -> YES: loadFile(fp) immediately
   -> NO: pendingQueue.push(fp)
4. loadFile(fp):
   - activeLoads.add(fp)
   - await fetchFileContent(teamName, memberName, fp)
   - activeLoads.delete(fp)
   - processQueue() <-- проверить, есть ли ожидающие
5. processQueue():
   - while (activeLoads.size < MAX_CONCURRENT && pendingQueue.length > 0)
   - shift from queue, check shouldLoad, loadFile
```

### Диаграмма состояний

```
                  ┌──────────┐
  IO trigger ──> │ enqueue  │
                  └────┬─────┘
                       │
              ┌────────v────────┐
              │ slots available? │
              └──┬─────────┬────┘
                 │ YES     │ NO
          ┌──────v──┐   ┌──v───────┐
          │ loadFile │   │ add to   │
          │ (async)  │   │ pending  │
          └──────┬───┘   │ queue    │
                 │       └──────────┘
          ┌──────v───┐         ^
          │ complete  │         │
          └──────┬───┘         │
                 │             │
          ┌──────v────────┐    │
          │ processQueue  ├────┘
          └───────────────┘
```

### Взаимодействие throttle с store guard

`fetchFileContent` в store (строки 261-282) имеет собственный guard:
```typescript
const state = get();
if (state.fileContents[filePath] || state.fileContentsLoading[filePath]) return;
```

`useLazyFileContent` добавляет `activeLoads` ref поверх. Зачем два уровня защиты:

1. **Store guard** предотвращает повторный IPC-вызов для загружаемого/загруженного файла -- но работает через `get()` (синхронный snapshot). Между двумя вызовами `fetchFileContent` в одном event loop tick `fileContentsLoading` ещё не обновлён (Zustand batch).
2. **`activeLoads` ref** покрывает этот micro-timing gap -- `activeLoads.add(fp)` происходит синхронно ДО await, а `shouldLoad()` проверяет ref мгновенно.

Таким образом:
- Store guard: macro-level (между renders)
- activeLoads ref: micro-level (между тиками в одном frame)
- Оба нужны для надёжности

### Приоритет загрузки

**Текущий подход:** FIFO. IntersectionObserver вызывает callbacks в порядке пересечения rootMargin. Для типичного скролла сверху вниз это означает: верхние файлы раньше нижних.

**Потенциальное улучшение (не для фазы 2):**

Если пользователь быстро скроллит вниз (skip middle files), можно реализовать priority queue:

```typescript
// Вместо string[] использовать priority queue:
interface PendingItem {
  filePath: string;
  priority: number; // расстояние от viewport center
}

// При каждом scroll event -- пересчитать priority для pending items
// Ближайшие к viewport -- выше приоритет
```

Но это оверинжиниринг для фазы 2. FIFO достаточно:
- IntersectionObserver с rootMargin 200% ловит файлы рано
- 3 параллельных загрузки покрывают типичную скорость скролла
- Даже при быстром скролле -- placeholder на 100-200ms, потом контент

### Refs для stale closure prevention

```typescript
const fileContentsRef = useRef(fileContents);
const fileContentsLoadingRef = useRef(fileContentsLoading);

useEffect(() => {
  fileContentsRef.current = fileContents;
  fileContentsLoadingRef.current = fileContentsLoading;
}, [fileContents, fileContentsLoading]);
```

**Зачем:** `shouldLoad()` замыкает `fileContentsRef` и `fileContentsLoadingRef`. Без ref-трюка callback IntersectionObserver "видит" stale `fileContents` из момента создания observer.

**Альтернатива:** Пересоздавать IntersectionObserver при каждом изменении `fileContents`. Но это = disconnect + observe all elements заново = bad performance.

### Edge case: диалог закрыт во время загрузки

`fetchFileContent` -- async. Если пользователь закроет диалог пока идёт загрузка:
1. `ContinuousScrollView` unmounts -> `useLazyFileContent` cleanup
2. IntersectionObserver disconnect
3. Но `fetchFileContent` всё ещё in-flight в store
4. Store обновит `fileContents` / `fileContentsLoading` -- ОК, store не зависит от компонента
5. `clearChangeReview()` вызывается в useEffect cleanup `ChangeReviewDialog` (строка 189) -- сбросит all state

**Вывод:** Нет утечек и race conditions. Store корректно очищается.

### Edge case: файл уже загружен при re-open

При повторном открытии того же review:
1. `clearChangeReview()` сбрасывает `fileContents = {}` (строка 160)
2. `fetchAgentChanges()` / `fetchTaskChanges()` загружает свежий changeSet
3. `useLazyFileContent` preload + observer начинают с нуля
4. Все файлы загружаются заново (свежие данные)

### Edge case: circular dependency loadFile <-> processQueue

`loadFile` вызывает `processQueue` в finally. `processQueue` вызывает `loadFile`. Потенциальный бесконечный цикл?

Нет -- `loadFile` начинается с `if (!shouldLoad(filePath)) return;`, а `activeLoads.add(fp)` происходит синхронно. `processQueue` берёт из очереди (shift), проверяет `shouldLoad`, и вызывает `loadFile` через `void` (fire-and-forget). Каждый `loadFile` -- это новый async task, не рекурсия в call stack. Queue конечна (max = количество файлов). Цикла нет.

---

## 5. Консистентность с Phase 3

Phase 3 (Navigation) зависит от Phase 2 в следующих аспектах:

1. **EditorView Map** -- Phase 2 использует `editorViewMapRef` из Phase 1. Phase 3 использует тот же Map через `ContinuousNavigationOptions.editorViewRefs`. Важно: Phase 3 `editorViewRefs` это `Map<string, EditorView>` (value из `.current`), а Phase 2 работает с `MutableRefObject<Map>`. Нет конфликта -- Phase 3 читает из `.current` напрямую.

2. **Lazy loading + cross-file navigation** -- когда Phase 3 `goToNextFile()` делает `scrollToFile(nextFilePath)`, файл может быть ещё не загружен. IntersectionObserver с rootMargin 200% должен сработать до того как scroll доедет до файла. Если файл далеко -- placeholder покажется на ~100-200ms, потом контент подгрузится. Это приемлемый UX.

3. **activeFilePath** -- Phase 2 НЕ управляет `activeFilePath`. Scroll-spy из Phase 1 (`useVisibleFileSection`) определяет activeFilePath. Phase 2 только загружает контент. Phase 3 использует activeFilePath для определения "текущего" файла в навигации.

---

## 6. Проверка

### Функциональная проверка

- [ ] Открыть review с 10+ файлами
- [ ] Первые 5 файлов показывают контент в первые ~500ms
- [ ] Файлы 6-10 показывают placeholder, потом контент при подскролле
- [ ] Scroll вниз -- файлы подгружаются бесшовно (placeholder -> diff)
- [ ] Scroll быстро вниз -- плейсхолдеры видны на ~200ms, потом контент
- [ ] Scroll обратно вверх -- уже загруженные файлы показывают diff мгновенно
- [ ] Кликнуть на файл 15 в tree -> smooth scroll + контент загружается

### Throttle проверка

- [ ] Открыть DevTools Network tab (или console log)
- [ ] Убедиться: максимум 3 одновременных IPC-вызова `getFileContent`
- [ ] Остальные ждут в очереди и выполняются последовательно по 3

### Edge cases

- [ ] 0 файлов -- нет ошибок в console
- [ ] 1 файл -- загружается мгновенно (preload)
- [ ] Файл с ошибкой загрузки (main process throw) -- placeholder остаётся, scroll retry работает
- [ ] Закрыть диалог во время загрузки -- нет ошибок, store очищен
- [ ] Переоткрыть диалог -- все файлы загружаются заново

### Performance

- [ ] 30 файлов -- UI не зависает при открытии
- [ ] Main process responsive (file watcher работает) во время загрузки 30 файлов
- [ ] Memory: placeholder -> diff transition не утекает (EditorView create/destroy)
- [ ] Scroll FPS > 30 при 20+ загруженных CodeMirror editors
