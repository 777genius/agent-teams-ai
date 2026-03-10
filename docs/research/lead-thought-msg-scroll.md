## Findings: реверс порядка lead thoughts (свежие вверху)

### Затронутые файлы

| Файл | Что менять |
|------|------------|
| `LeadThoughtsGroup.tsx` | Основной компонент. Строка 471: `chronologicalThoughts = [...thoughts].reverse()` — убрать reverse (thoughts уже newest-first). Логика автоскрола внутри `LeadThoughtsGroupRow` (строки 570-658). |
| `ActivityTimeline.tsx` | Pinned thought group (строка 322). Порядок messages — newest-first (desc), thoughts группируются через `groupTimelineItems()`. |
| `collapseState.ts` | `findNewestMessageIndex()` ищет первый `type: 'message'` — при реверсе внутри группы не затронут. |
| `AnimatedHeightReveal.tsx` | Не требует изменений — анимирует высоту, а не направление. |

### Архитектура текущего скрола thoughts

**LeadThoughtsGroupRow** имеет свой собственный скрол-контейнер (строки 780-807):
- `scrollRef` — div с `maxHeight: 200px`, `overflowY: auto`
- `contentRef` — внутренний div с thoughts
- Автоскрол к **низу** (`queueScrollSync('bottom')`) — потому что newest внизу
- `isUserScrolledUpRef` — трекает, отскроллил ли юзер вверх
- `distanceFromBottomRef` — сохраняет позицию для `preserve` mode
- `handleScroll` (строка 652) — обновляет `isUserScrolledUpRef` через `AUTO_SCROLL_THRESHOLD = 30px`
- `handleCollapse` (строка 661) — при Show Less скроллит к `scrollHeight` (к низу)
- `syncScrollableBody` (строка 598) — оркестрирует: force bottom / preserve / noop

**Рендеринг** (строка 795): `chronologicalThoughts.map()` — oldest-first, newest в конце. Анимация `shouldAnimate` только для последнего (newest).

### Что нужно изменить для реверса

1. **Убрать `.reverse()` на строке 471** — thoughts уже newest-first, рендерить как есть
2. **Перевернуть автоскрол**: вместо scroll-to-bottom → scroll-to-top (`scrollTop = 0`)
3. **Анимация нового thought**: `shouldAnimate` для `idx === 0` (вместо `idx === chronologicalThoughts.length - 1`)
4. **`isUserScrolledUpRef`** → переименовать в `isUserScrolledDownRef`, проверять расстояние от **верха** (`scrollTop > threshold`)
5. **`queueScrollSync`** — `mode: 'top'` вместо `'bottom'` (`scrollTop = 0`), preserve mode: `scrollTop = distanceFromTopRef.current`
6. **Show More кнопка** — сейчас внизу (ChevronDown). При реверсе: newest вверху, кнопка "Show more" нужна внизу для загрузки старых thoughts — по сути остаётся на месте
7. **Show Less** (`handleCollapse`) — скроллит к верху (`scrollTop = 0`) вместо `scrollHeight`
8. **Divider timestamps** (строка 355-360): `showDivider` при `idx > 0` — работает корректно и при реверсе

### Edge Cases

1. **Новый thought приходит во время скрола вниз к старым** — если юзер прокрутил вниз (к старым), новый thought добавляется вверху. Нужно сохранить `scrollTop` позицию. Решение: `preserve` mode отслеживает `distanceFromTop` вместо `distanceFromBottom`.

2. **Первый thought в пустой группе** — скролл не нужен (нет overflow), анимация fade-in для первого элемента.

3. **Переход collapsed → expanded** — `setExpanded(true)` убирает maxHeight. При реверсе scrollTop=0 уже наверху, без скачков. Проблем нет.

4. **Expanded → collapsed (Show Less)** — сейчас `handleCollapse` скроллит к scrollHeight. При реверсе → скроллить к 0. Плюс `scrollIntoView` на контейнер — остаётся как есть.

5. **Real-time streaming** — thoughts приходят через InboxMessage live updates. Каждый новый thought prepend-ится в начало массива `thoughts[]` (newest-first). При реверсе рендера: новый появляется вверху, анимируется LeadThoughtItem с `shouldAnimate`. Ключевой риск: `AnimatedHeightReveal` wrapper расширяется вниз (grid-template-rows: 0fr→1fr). При insert-е вверху контейнер сдвигает всё вниз → **layout shift**. Mitigation: CSS `overflow-anchor: none` уже стоит (строка 790). Но для items внутри scroll-контейнера нужно `overflow-anchor: auto` на последнем видимом элементе. **Это главный технический риск.**

6. **`getThoughtGroupKey`** (строка 67-70) — использует oldest thought для стабильного ключа. При реверсе rendering порядок меняется, но key остаётся тот же. Проблем нет.

7. **ResizeObserver** (строка 632-637) — наблюдает за contentRef. При реверсе content растёт вверху → ResizeObserver сработает, вызовет syncScrollableBody. Нужно убедиться что `preserve` mode корректно считает offset от верха.

8. **`isBodyVisible` toggle** (collapse mode из ActivityTimeline) — скрывает/показывает body. При реверсе: после re-show нужно скроллить к top (не bottom). Затронуто useLayoutEffect на строке 625-638.

### Аналоги в проекте для референса

- `DisplayItemList.tsx:107` — использует `flex-col-reverse` для newest-first. Простой подход, но не подходит для нашего случая (у нас свой scroll container с автоскролом).
- `CliLogsRichView.tsx:376` — `[...entries].reverse()` для newest-first порядка.

### Предложенный план реализации

1. В `LeadThoughtsGroupRow`: убрать `chronologicalThoughts` reverse, рендерить `thoughts` напрямую (newest-first)
2. Перевернуть scroll-sync логику: auto-scroll к `scrollTop=0`, preserve через `distanceFromTop`
3. Обновить `shouldAnimate` для `idx === 0`
4. Обновить `handleCollapse` → `scrollTop = 0`
5. Show More/Show Less кнопки: Show More внизу (для старых thoughts) — без изменений. Show Less — без изменений.
6. Тестировать layout shift при live streaming

### Оценки

**Сложность реализации: 5/10**
- Основная логика сосредоточена в одном файле (LeadThoughtsGroup.tsx)
- Scroll-sync перевернуть — умеренно сложно (6 точек изменения: queueScrollSync, handleScroll, handleCollapse, syncScrollableBody, useLayoutEffect, shouldAnimate)
- Нет зависимости от внешнего useAutoScrollBottom — LeadThoughtsGroupRow имеет свой собственный scroll management
- Не нужно трогать groupTimelineItems() или ActivityTimeline

**Уверенность в оценке: 8/10**
- Код хорошо изолирован — весь scroll management внутри одного компонента
- Единственный серьёзный риск — layout shift при real-time prepend (edge case #5)
- CSS overflow-anchor может не работать идеально для insert-вверх в scroll container

### Оценка рисков

| Риск | Вероятность | Последствие | Mitigation |
|------|-------------|-------------|------------|
| Layout shift при live streaming | Средняя | Визуальные скачки | overflow-anchor + manual scrollTop adjustment |
| Broken Show More/Less | Низкая | UX деградация | Простой фикс scrollTop |
| Regression в collapsed mode | Низкая | Thoughts не видны | Не затрагивает collapse logic |
| Browser inconsistency overflow-anchor | Низкая | Скачки в Safari | Fallback: manual scroll compensation |