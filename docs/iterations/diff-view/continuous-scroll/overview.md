# Continuous Scroll Diff View -- Overview

## 1. Цель

Текущий Review Dialog показывает diff для одного файла за раз. Пользователь переключает файлы через дерево слева. Это создает трение при ревью: нужно кликать каждый файл, терять контекст между файлами, невозможно быстро пролистать все изменения.

**Continuous Scroll Diff View** -- это режим, в котором все файлы changeset-а отображаются в одном непрерывном скролле, аналогично GitHub PR diff view. Каждый файл начинается с заголовка (sticky header), за которым идет diff. Пользователь скроллит вниз и видит все изменения последовательно. File tree слева синхронизируется с текущей видимой позицией (scroll-spy), клик на файл в дереве плавно прокручивает к нему.

---

## 2. Целевой UX

### Что видит пользователь

1. Открывает Review Dialog с несколькими файлами
2. Слева -- file tree (как сейчас), справа -- непрерывный скролл всех файлов
3. Каждый файл начинается со **sticky header** (имя файла, badges, +/-) -- при скролле header "прилипает" к верху
4. Под header -- CodeMirror diff view для этого файла
5. Неизменённые регионы свёрнуты (portionCollapse), с возможностью развернуть порциями ("Expand 100" / "Expand All")
6. Файлы, контент которых ещё не загружен, показывают placeholder с skeleton
7. File tree подсвечивает текущий видимый файл (scroll-spy)
8. Клик по файлу в дереве -> плавный скролл к этому файлу
9. Cmd+Y/N accept/reject работают для видимого файла (или focused editor)
10. "Accept All" / "Reject All" применяются ко ВСЕМ файлам
11. Progress bar показывает "12 of 45 changes reviewed"
12. Auto-viewed помечает файлы по мере скролла

### Когда включается continuous mode

- Когда файлов > 1 в changeset -- continuous mode автоматически
- Когда файл один -- обычный single-file mode (без изменений)

---

## 3. Архитектурные решения

### 3.1. Почему НЕ @tanstack/react-virtual

Виртуализация (react-virtual, react-window и т.д.) работает по принципу: рендерить только элементы в viewport, остальные -- placeholder с фиксированной высотой.

**Проблема для CodeMirror:**
- CodeMirror EditorView требует реального DOM-узла для создания editor instance
- EditorView рассчитывает layout, позиции строк, viewport -- всё завязано на реальный DOM
- При "виртуализации" EditorView нужно destroy/create при входе/выходе из viewport
- destroy теряет undo history, scroll position внутри editor, cursor position
- create -- тяжёлая операция (парсинг, syntax highlighting, merge computation)

**Альтернатива: lazy loading + portionCollapse:**
- Все файлы существуют в DOM одновременно
- Но их контент загружается lazy (Phase 2)
- Неизменённые регионы свёрнуты через portionCollapse (Phase 4)
- Итог: 50 файлов в DOM, но каждый занимает минимум строк (только changed lines + margin)

### 3.2. Почему кастомный portionCollapse

CodeMirror из коробки поддерживает `collapseUnchanged` в `unifiedMergeView`:

```typescript
unifiedMergeView({
  collapseUnchanged: { margin: 3, minSize: 4 }
});
```

**Проблема:** встроенный collapse -- monolithic. Кнопка "expand" раскрывает ВСЮ свёрнутую область, без возможности:
- Раскрыть порцию строк (например, 100 строк за одно нажатие)
- Раскрыть полностью по отдельной кнопке
- Показать контекст постепенно

**Решение:** кастомный `portionCollapse.ts` -- StateField + Decoration, который:
- Управляет свёрнутыми регионами как `RangeSet<Decoration>`
- Поддерживает partial expand (portionSize=100 строк за нажатие)
- Полностью заменяет встроенный collapseUnchanged

### 3.3. Lazy loading вместо виртуализации

Файлы загружают контент по мере приближения к viewport:

- IntersectionObserver с `rootMargin: '200% 0px 200% 0px'` на placeholder каждого файла
- Когда placeholder входит в расширенный viewport -- `fetchFileContent()` запускается
- Пока контент грузится -- placeholder показывает skeleton
- После загрузки -- CodeMirrorDiffView рендерится

Это даёт:
- Быстрый первичный рендер (только заголовки + placeholders)
- Предварительная загрузка за 2 viewport-высоты до видимости
- Нет потери undo history (EditorView живёт, пока диалог открыт)

---

## 4. Карта файлов

### 4.1. Новые файлы (8)

| Файл | Путь | Фаза | Ответственность |
|------|------|------|-----------------|
| `FileSectionHeader.tsx` | `src/renderer/components/team/review/FileSectionHeader.tsx` | Phase 1 | Sticky header для каждого файла: имя, badges (+/-), content source, viewed checkbox, file-level decision indicator. Использует `position: sticky; top: 0; z-index: 10`. |
| `FileSectionDiff.tsx` | `src/renderer/components/team/review/FileSectionDiff.tsx` | Phase 1 | Обёртка над CodeMirrorDiffView для одного файла в continuous scroll. Управляет lifecycle EditorView (onEditorViewReady(filePath, view \| null) единый callback), содержит sentinel для auto-viewed, передаёт все props в CodeMirrorDiffView. |
| `FileSectionPlaceholder.tsx` | `src/renderer/components/team/review/FileSectionPlaceholder.tsx` | Phase 1 | Placeholder-скелетон для файла, пока контент не загружен. Фиксированная высота (~200px). Содержит IntersectionObserver trigger для lazy loading (Phase 2). |
| `ContinuousScrollView.tsx` | `src/renderer/components/team/review/ContinuousScrollView.tsx` | Phase 1 | Главный контейнер: рендерит файлы последовательно (FileSectionHeader + FileSectionDiff/Placeholder). Хранит EditorView Map (Phase 5). useImperativeHandle для доступа к Map из родителя. Обрабатывает scroll events для scroll-spy. |
| `useVisibleFileSection.ts` | `src/renderer/hooks/useVisibleFileSection.ts` | Phase 1 | Hook для scroll-spy: IntersectionObserver определяет, какой file section сейчас виден в viewport. Возвращает `activeFilePath`. Учитывает programmatic scroll (flag `isProgrammaticScroll`). |
| `useContinuousScrollNav.ts` | `src/renderer/hooks/useContinuousScrollNav.ts` | Phase 1 | Hook для programmatic navigation: `scrollToFile(filePath)` -- плавный скролл к конкретному файлу. Использует `Element.scrollIntoView({ behavior: 'smooth' })`. Устанавливает `isProgrammaticScroll` flag для подавления scroll-spy. |
| `useLazyFileContent.ts` | `src/renderer/hooks/useLazyFileContent.ts` | Phase 2 | Hook для lazy loading контента файлов: IntersectionObserver с rootMargin для prefetch. Вызывает `fetchFileContent()` из store. Отслеживает loaded/loading state per file. |
| `portionCollapse.ts` | `src/renderer/components/team/review/portionCollapse.ts` | Phase 4 | CodeMirror StateField + Decoration для partial collapse неизменённых regions. Кнопки "Expand 100" (portionSize=100) и "Expand All". Rebuilds decorations после accept/reject. Включает `portionCollapseTheme` со стилями. |

### 4.2. Модифицируемые файлы (8)

| Файл | Путь | Фазы | Изменения |
|------|------|------|-----------|
| `ChangeReviewDialog.tsx` | `src/renderer/components/team/review/ChangeReviewDialog.tsx` | Phase 1, 3, 5 | **Phase 1:** условный рендер ContinuousScrollView vs single-file mode, убирается file header из content area. **Phase 3:** continuousOptions передаётся в useDiffNavigation (10-й параметр). **Phase 5:** handleAcceptAll/RejectAll multi-file, per-file discardCounters, continuousScrollActiveFilePath state, isContinuousMode computed, EditorView Map через ref. |
| `ReviewFileTree.tsx` | `src/renderer/components/team/review/ReviewFileTree.tsx` | Phase 1 | Highlight active file из scroll-spy (не только selected), новый prop `activeFilePath` для visual indicator (отличается от `selectedFilePath`). В continuous mode `activeFilePath` определяется scroll-spy, `selectedFilePath` не используется. |
| `CodeMirrorDiffView.tsx` | `src/renderer/components/team/review/CodeMirrorDiffView.tsx` | Phase 4 | Замена встроенного `collapseUnchanged` на кастомный portionCollapse extension. Новый prop `usePortionCollapse` (boolean). Добавление portionCollapse StateField в buildExtensions() через отдельный Compartment. |
| `changeReviewSlice.ts` | `src/renderer/store/slices/changeReviewSlice.ts` | Phase 2 | Новый action `prefetchFileContents(teamName, memberName, filePaths)` -- batch-загрузка контента нескольких файлов. Вызывается из useLazyFileContent при пересечении IntersectionObserver. |
| `useDiffNavigation.ts` | `src/renderer/hooks/useDiffNavigation.ts` | Phase 3 | Новый optional param `continuousOptions?: ContinuousNavigationOptions` (10-й параметр). Внутри keyboard handler: `getActiveEditorView()` проверяет focused editor первым, затем activeFilePath, затем первый editor. Cross-file chunk navigation при достижении последнего chunk в файле. Helpers: `isLastChunkInFile()`, `isFirstChunkInFile()`. |
| `ReviewToolbar.tsx` | `src/renderer/components/team/review/ReviewToolbar.tsx` | Phase 5 | Новые props: `isContinuousMode`, `reviewedCount`, `totalHunks`. Tooltip "Accept all changes across all files" в continuous mode. Progress bar компонент. |
| `KeyboardShortcutsHelp.tsx` | `src/renderer/components/team/review/KeyboardShortcutsHelp.tsx` | Phase 3 | Новые shortcuts: Alt+K (prev change), Alt+ArrowDown/Up (next/prev file), ? (toggle help). |
| `useContinuousScrollNav.ts` | `src/renderer/hooks/useContinuousScrollNav.ts` | Phase 3 | Уточнение scrollToFile: принудительный setActiveFilePath после стабилизации scroll. |

---

## 5. Зависимости между фазами

```
Phase 4 (portionCollapse) ─────────────────────────────────────┐
  (изолированный CM extension, можно параллельно с 2/3)        │
                                                                │
Phase 1 (Continuous Scroll + Scroll-Spy) ──┬──> Phase 2 ───────┼──> Phase 5
  (базовая инфраструктура)                 │   (Lazy Loading)   │   (Polish)
                                           │                    │
                                           ├──> Phase 3 ────────┘
                                           │   (Navigation)
                                           │
                                           └──> Phase 5
                                               (EditorView Map + Toolbar)
```

**Детали:**

| Зависимость | Причина |
|-------------|---------|
| Phase 1 -> Phase 2 | useLazyFileContent использует IntersectionObserver на placeholder, созданном в ContinuousScrollView |
| Phase 1 -> Phase 3 | Keyboard navigation в continuous mode требует scroll infrastructure (scrollToFile) и scroll-spy (activeFilePath) |
| Phase 1 -> Phase 5 | EditorView Map живёт в ContinuousScrollView. Accept All/Reject All итерируют по Map. |
| Phase 4 (параллельно) | portionCollapse.ts -- изолированный CM StateField/Extension. Не зависит от ContinuousScrollView. Может разрабатываться и тестироваться отдельно на обычном CodeMirrorDiffView. |
| Phase 5 -> после 1-4 | Финальная полировка, интеграция всех компонентов. Требует: ContinuousScrollView (Phase 1), lazy loading (Phase 2), navigation (Phase 3), portionCollapse (Phase 4). |

**Рекомендованный порядок:**

```
Неделя 1: Phase 1 + Phase 4 (параллельно)
Неделя 2: Phase 2 + Phase 3 (параллельно, после Phase 1)
Неделя 3: Phase 5 (после всех)
```

---

## 6. Критические edge-cases

| # | Кейс | Решение | Фаза |
|---|------|---------|------|
| 1 | **Scroll-spy + programmatic scroll race:** scroll-spy определяет "не тот" файл во время programmatic scroll (scrollToFile) | `isProgrammaticScroll` ref flag. scrollToFile устанавливает flag=true. Scroll-spy игнорирует IntersectionObserver events пока flag=true. `waitForScrollEnd()` (через `scrollend` event или debounced timeout 150ms) сбрасывает flag и берёт финальный видимый файл. | Phase 1 |
| 2 | **50 EditorViews в памяти:** потенциальная проблема с памятью и производительностью при большом количестве файлов | portionCollapse минимизирует DOM-контент каждого editor (свёрнутые regions = 0 DOM-нод). Lazy loading (Phase 2) гарантирует постепенную загрузку. Если профилирование покажет проблемы -- destroy EditorViews далеко за viewport (будущая оптимизация, не в Phase 5). | Phase 5 |
| 3 | **Keyboard Cmd+Y/N -- какой editor:** несколько EditorView на экране, нужно определить целевой | Приоритет: (1) EditorView, содержащий `document.activeElement` (user clicked into it), (2) EditorView для `activeFilePath` из scroll-spy. Реализовано в `resolveActiveEditorView()`. | Phase 5 |
| 4 | **Cross-file hunk navigation:** goToNextChunk в последнем chunk файла -> нужно перейти к следующему файлу | goToNextChunk не выходит за пределы одного EditorView. Для cross-file: определить, что cursor на последнем chunk (`isLastChunkInFile()`), -> scrollToFile(nextFile) + goToNextChunk(nextView). Реализуется в useDiffNavigation Phase 3 рефакторинге. | Phase 3 |
| 5 | **portionCollapse + accept/reject:** после accept chunk-а, неизменённые regions меняются | portionCollapse rebuilds decorations через `EditorView.updateListener`. При изменении doc или original (updateOriginalDoc effect) -- декорации пересчитываются. | Phase 4 |
| 6 | **Auto-viewed threshold 0.85:** sentinel при threshold 1.0 может не срабатывать из-за collapse | Threshold 0.85 для 1px sentinel элемента. portionCollapse может значительно уменьшить высоту файла, из-за чего sentinel может быть "видим" до полного просмотра. 0.85 дает margin. Sentinel размещается ПОСЛЕ CodeMirrorDiffView. | Phase 1, 5 |
| 7 | **Lazy loading race: файл не загружен при scrollToFile** | scrollToFile прокручивает к placeholder. useLazyFileContent автоматически запустит загрузку через IntersectionObserver. Placeholder -> skeleton -> loaded diff. Пользователь видит transition. | Phase 2 |
| 8 | **Sticky header z-index stacking:** несколько sticky headers при быстром скролле | Каждый header имеет `z-index: 10`. Только один виден как sticky (ближайший к top). Следующий header "выталкивает" предыдущий. CSS `position: sticky; top: 0` с корректным stacking context. | Phase 1 |
| 9 | **Discard one file в continuous mode:** пересоздание одного EditorView не должно сломать остальные | Per-file `discardCounters: Record<string, number>`. Key FileSectionDiff: `${filePath}:${discardCounters[filePath]}`. Инкремент counter только для одного файла -> React пересоздает только этот компонент. | Phase 5 |
| 10 | **Accept All + scroll position:** Accept All меняет высоту всех editors, scroll может "прыгнуть" | Браузер корректирует scroll для элементов выше viewport автоматически. Для элементов в viewport -- пользователь видит изменения, что ожидаемо. Не корректируем scroll искусственно. | Phase 5 |
| 11 | **File с unavailable content в continuous mode** | FileSectionDiff проверяет `contentSource`. Если `unavailable` -- рендерит fallback ReviewDiffContent вместо CodeMirrorDiffView. EditorView не создается -> не попадает в Map. Accept All/Reject All для таких файлов -- только store update. | Phase 1 |

---

## 7. Чеклист верификации

Полный чеклист для тестирования после реализации всех 5 фаз.

### Phase 1: Continuous Scroll + Scroll-Spy

- [ ] ContinuousScrollView рендерит все файлы последовательно
- [ ] Sticky headers "прилипают" при скролле и корректно сменяют друг друга
- [ ] Scroll-spy определяет текущий видимый файл
- [ ] ReviewFileTree подсвечивает видимый файл (не только selected)
- [ ] Клик по файлу в tree -> плавный scroll к этому файлу
- [ ] Programmatic scroll не вызывает "мерцание" в file tree (isProgrammaticScroll flag)
- [ ] Single-file mode (1 файл) -- работает как раньше, без ContinuousScrollView
- [ ] Файлы с `unavailable` content -- показывают fallback
- [ ] Пустой changeset (0 файлов) -- сообщение "No file changes detected"

### Phase 2: Lazy Loading

- [ ] При открытии dialog загружается контент только видимых файлов (1-3 штуки)
- [ ] При скролле вниз -- файлы загружаются за 2 viewport-высоты до видимости
- [ ] Placeholder с skeleton виден пока контент грузится
- [ ] После загрузки -- placeholder заменяется CodeMirrorDiffView
- [ ] Быстрый скролл через много файлов -- не спамит запросы (MAX_CONCURRENT=3 throttle)
- [ ] Повторное посещение файла -- контент уже в кэше (store), нет повторного запроса

### Phase 3: Navigation

- [ ] Alt+J -- переход к следующему change в текущем editor
- [ ] Alt+K -- переход к предыдущему change
- [ ] Alt+ArrowDown -- переход к следующему файлу (smooth scroll)
- [ ] Alt+ArrowUp -- переход к предыдущему файлу (smooth scroll)
- [ ] Cmd+Y -- accept chunk + next chunk
- [ ] Cmd+N -- reject chunk + next chunk
- [ ] Cross-file navigation: после последнего chunk в файле -> переход к первому chunk следующего файла
- [ ] Keyboard shortcuts работают и с focused editor, и без фокуса (fallback на activeFilePath)
- [ ] ? -- toggle shortcuts help dialog

### Phase 4: Portion Collapse

- [ ] Неизменённые regions >= 10 строк свёрнуты по умолчанию (minSize=4 + margin=3 с обеих сторон = 10 строк минимум для создания collapse)
- [ ] Widget "N unchanged lines" виден на месте свёрнутого региона
- [ ] Клик "Expand 100" -- раскрывает 100 строк (portionSize=100)
- [ ] Если строк меньше portionSize -- только кнопка "Expand All" (без "Expand N")
- [ ] Клик "Expand All" -- раскрывает свёрнутый регион полностью
- [ ] Accept chunk -> decorations пересчитываются (новые неизменённые areas корректно collapse)
- [ ] Reject chunk -> decorations пересчитываются
- [ ] Работает в single-file mode (без ContinuousScrollView)

### Phase 5: Polish

- [ ] "Accept All" -> все hunks во всех файлах accepted (store + CM)
- [ ] "Reject All" -> все hunks во всех файлах rejected (store + CM)
- [ ] Tooltip "Accept all changes across all files" (не "in current file")
- [ ] Progress bar "12 of 45 reviewed" обновляется при accept/reject
- [ ] Cmd+Y с focused editor -> accept в этом editor
- [ ] Cmd+Y без фокуса -> accept в activeFilePath editor
- [ ] Cmd+Enter -> save только activeFilePath
- [ ] Discard файла -> только этот EditorView пересоздается
- [ ] Auto-viewed помечает файлы по мере скролла (multiple files per scroll)
- [ ] Auto-viewed toggle off -> скролл не помечает файлы
- [ ] Закрытие dialog -> viewed state сохранён (persistent localStorage)
- [ ] 20+ файлов -- нет видимых лагов при scroll/accept all

### Cross-cutting

- [ ] Escape закрывает dialog
- [ ] Typecheck: `pnpm typecheck` проходит без ошибок
- [ ] Lint: `pnpm lint:fix` без warnings
- [ ] Тесты: `pnpm test` все проходят
- [ ] Нет регрессий в single-file mode
- [ ] macOS: traffic light padding корректен
- [ ] Dark/light theme: все CSS variables работают

---

## 8. Ссылки на файлы фаз

- [Phase 1: Continuous Scroll + Scroll-Spy](./phase-1-continuous-scroll-and-scroll-spy.md)
- [Phase 2: Lazy Loading](./phase-2-lazy-loading.md)
- [Phase 3: Navigation](./phase-3-navigation.md)
- [Phase 4: Portion Collapse](./phase-4-portion-collapse.md)
- [Phase 5: Polish + EditorView Map + Toolbar](./phase-5-polish.md)
