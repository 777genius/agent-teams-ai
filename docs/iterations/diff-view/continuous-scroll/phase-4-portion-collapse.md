# Phase 4: Portion Collapse

## Обзор

**Проблема:** Стандартный `collapseUnchanged` из `@codemirror/merge` при клике на collapsed region разворачивает ВСЮ зону целиком. Для файлов с 500+ неизменённых строк между изменениями это создаёт резкий скачок контента и потерю контекста. GitHub решает это кнопками "Expand 20 lines" / "Expand all", позволяя раскрывать порциями.

**Решение:** Кастомный CodeMirror StateField (`portionCollapseExtension`) который создаёт `Decoration.replace` с виджетами, содержащими кнопки "Expand N" и "Expand All". При клике на "Expand N" виджет разворачивает только указанное количество строк, оставляя остаток свёрнутым.

**Зависимости:** Независим от Phase 1-3 (continuous scroll). Может использоваться как в single-file mode, так и в continuous mode.

---

## Почему кастомный StateField

### Ограничения CM's collapseUnchanged

`@codemirror/merge` реализует `collapseUnchanged` через приватный StateField `CollapsedRanges` + `Decoration.replace` с внутренним `CollapseWidget`. При клике на collapsed widget используется StateEffect `uncollapseUnchanged` (экспортируется из `@codemirror/merge`), который ПОЛНОСТЬЮ удаляет decoration для зоны через `deco.update({ filter: from => from != e.value })`.

```typescript
// Экспорт из @codemirror/merge
declare const uncollapseUnchanged: StateEffectType<number>;
```

**Ключевая деталь реализации CM:** `CollapsedRanges` использует паттерн `StateField.define` + `StateField.init()`:
- `create()` возвращает `Decoration.none` (пустые decorations)
- `collapseUnchanged()` возвращает `CollapsedRanges.init(state => buildCollapsedRanges(state, margin, minSize))` — init переопределяет create при инициализации state
- `update()` делает ТОЛЬКО `deco.map(tr.changes)` + filter по `uncollapseUnchanged` effect
- `update()` НЕ делает rebuild при `docChanged` или `updateOriginalDoc` — CM пересоздаёт collapse decorations через reconfigure compartment при изменении chunks

Проблемы:
1. **Нет partial expand** — `uncollapseUnchanged` принимает только `pos: number` и разворачивает всю зону
2. **Нет public API** для получения списка collapsed зон или модификации отдельных зон
3. **WidgetType** внутренний (CollapseWidget) — нет возможности заменить DOM widget без форка
4. **CollapsedRanges StateField** — приватный, недоступен для расширения

### Почему не обёртка

Теоретически можно было бы:
- Перехватить `uncollapseUnchanged` effect в транзакции
- Вместо полного uncollapse — создать два новых collapsed regionа
- Но `uncollapseUnchanged` привязан к внутреннему `CollapsedRanges` StateField, который фильтрует decorations по `from` position

Это хрупко и сломается при обновлении @codemirror/merge. Надёжнее написать свой StateField.

---

## Новый файл: portionCollapse.ts

**Путь:** `src/renderer/components/team/review/portionCollapse.ts`

### Exports

```typescript
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from '@codemirror/view';
import {
  type ChangeDesc,
  type EditorState,
  type Extension,
  RangeSetBuilder,
  StateEffect,
  type StateEffectType,
  StateField,
  type Transaction,
} from '@codemirror/state';

import { getChunks, type updateOriginalDoc } from './CodeMirrorDiffUtils';
// updateOriginalDoc используется только для .is() проверки в update(),
// поэтому импортируем его напрямую:
import { updateOriginalDoc } from '@codemirror/merge';

// ─── Configuration ───

interface PortionCollapseConfig {
  /**
   * Количество строк контекста, оставляемых видимыми до/после изменения.
   * Default: 3
   * Соответствует поведению CM's collapseUnchanged.margin.
   */
  margin?: number;

  /**
   * Минимальное количество строк в unchanged зоне для создания collapse.
   * Зоны короче этого значения остаются видимыми целиком.
   * Default: 4
   * Соответствует CM's collapseUnchanged.minSize.
   */
  minSize?: number;

  /**
   * Количество строк, раскрываемых за одно нажатие "Expand N".
   * Default: 100
   * При меньшем остатке кнопка показывает "Expand <остаток>".
   */
  portionSize?: number;
}

// ─── State Effects ───

/**
 * Раскрыть portionSize строк из collapsed зоны.
 * pos — позиция начала текущей collapsed decoration.
 * count — количество строк для раскрытия (обычно = portionSize).
 *
 * StateEffect.define с map() для корректного ремаппинга при изменениях документа.
 * map callback: (value, mapping: ChangeDesc) => Value | undefined.
 * Возврат undefined удаляет effect (не наш случай — always remap).
 */
export const expandPortion: StateEffectType<{
  pos: number;
  count: number;
}> = StateEffect.define<{ pos: number; count: number }>({
  map: (value, mapping: ChangeDesc) => ({
    pos: mapping.mapPos(value.pos),
    count: value.count,
  }),
});

/**
 * Полностью раскрыть collapsed зону по позиции.
 * pos — позиция начала collapsed decoration.
 */
export const expandAllAtPos: StateEffectType<number> = StateEffect.define<number>({
  map: (pos, mapping: ChangeDesc) => mapping.mapPos(pos),
});

// ─── Public API ───

/**
 * Создаёт Extension для порционного collapse неизменённых зон.
 *
 * ВАЖНО: Эта extension НЕ совместима с collapseUnchanged из unifiedMergeView.
 * Если portionCollapse включён — collapseUnchanged в mergeConfig НЕ должен быть задан.
 *
 * @param config — опциональная конфигурация
 * @returns Extension для добавления в EditorView
 */
export function portionCollapseExtension(config?: PortionCollapseConfig): Extension;
```

### Внутренняя структура

#### PortionCollapseWidget

```typescript
/**
 * Widget для отображения collapsed зоны с кнопками "Expand N" / "Expand All".
 *
 * Визуально повторяет стиль .cm-collapsedLines из CM's collapseUnchanged,
 * но с двумя кнопками вместо одной кликабельной полосы.
 *
 * Сравнение с CM's CollapseWidget:
 * - CM: `ignoreEvent(e) { return e instanceof MouseEvent; }` (игнорирует ВСЕ MouseEvent'ы)
 * - Мы: `ignoreEvent(e) { return e.type === 'mousedown'; }` (игнорируем только mousedown)
 * - CM: `estimatedHeight` = 27 (фиксированная высота виджета)
 * - Мы: `estimatedHeight` = 28 (наш виджет чуть выше из-за кнопок)
 */
class PortionCollapseWidget extends WidgetType {
  /**
   * @param lineCount — количество скрытых строк в этой зоне
   * @param pos — позиция начала decoration в документе (для dispatch effects)
   * @param portionSize — количество строк для "Expand N" кнопки
   */
  constructor(
    readonly lineCount: number,
    readonly pos: number,
    readonly portionSize: number
  ) {
    super();
  }

  /**
   * Создаёт DOM для collapsed зоны.
   *
   * Структура DOM:
   * ```html
   * <div class="cm-portion-collapse">
   *   <span class="cm-portion-collapse-text">
   *     ··· 247 unchanged lines ···
   *   </span>
   *   <div class="cm-portion-collapse-actions">
   *     <button class="cm-portion-expand-btn">
   *       Expand 100
   *     </button>
   *     <button class="cm-portion-expand-all-btn">
   *       Expand All
   *     </button>
   *   </div>
   * </div>
   * ```
   *
   * Кнопка "Expand N":
   * - Если lineCount <= portionSize: скрывается (остаётся только "Expand All")
   * - Если lineCount > portionSize: показывает "Expand {portionSize}"
   * - При клике: dispatch expandPortion.of({ pos: this.pos, count: this.portionSize })
   *
   * Кнопка "Expand All":
   * - Всегда видна
   * - При клике: dispatch expandAllAtPos.of(this.pos)
   *
   * ВАЖНО: Обе кнопки используют onmousedown (не onclick) с preventDefault()
   * чтобы предотвратить потерю фокуса CM editor.
   * Паттерн аналогичен CM's CollapseWidget (addEventListener("click")),
   * но mousedown + preventDefault надёжнее предотвращает перемещение selection.
   */
  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-portion-collapse';

    // Текст: "··· N unchanged lines ···"
    const text = document.createElement('span');
    text.className = 'cm-portion-collapse-text';
    text.textContent = `\u00B7\u00B7\u00B7 ${this.lineCount} unchanged line${this.lineCount !== 1 ? 's' : ''} \u00B7\u00B7\u00B7`;
    container.appendChild(text);

    // Actions container
    const actions = document.createElement('div');
    actions.className = 'cm-portion-collapse-actions';

    // "Expand N" button (только если lineCount > portionSize)
    if (this.lineCount > this.portionSize) {
      const expandBtn = document.createElement('button');
      expandBtn.className = 'cm-portion-expand-btn';
      expandBtn.textContent = `Expand ${this.portionSize}`;
      expandBtn.title = `Show next ${this.portionSize} lines`;
      expandBtn.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        view.dispatch({
          effects: expandPortion.of({
            pos: this.pos,
            count: this.portionSize,
          }),
        });
      };
      actions.appendChild(expandBtn);
    }

    // "Expand All" button (всегда)
    const expandAllBtn = document.createElement('button');
    expandAllBtn.className = 'cm-portion-expand-all-btn';
    expandAllBtn.textContent = 'Expand All';
    expandAllBtn.title = `Show all ${this.lineCount} unchanged lines`;
    expandAllBtn.onmousedown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({
        effects: expandAllAtPos.of(this.pos),
      });
    };
    actions.appendChild(expandAllBtn);

    container.appendChild(actions);
    return container;
  }

  /**
   * Сравнение виджетов для оптимизации рендеринга.
   * CM вызывает eq() при обновлении decorations — если true, DOM не пересоздаётся.
   *
   * ВАЖНО: pos НЕ нужно сравнивать в eq(). CM вызывает eq() только для decorations
   * на ОДИНАКОВЫХ позициях. Если позиция decoration изменилась — это уже другой range,
   * и CM не вызовет eq(). Сравниваем только визуально-значимые параметры.
   */
  eq(other: PortionCollapseWidget): boolean {
    return (
      this.lineCount === other.lineCount &&
      this.portionSize === other.portionSize
    );
  }

  /**
   * Оценка высоты widget для scrollbar.
   *
   * CM использует estimatedHeight для замещающих (replace) decorations
   * чтобы скорректировать scrollbar. Возвращаем высоту самого widget (28px),
   * а НЕ высоту скрытого контента. CM's CollapseWidget возвращает 27.
   *
   * Это корректно: scrollbar должен отражать ВИДИМУЮ высоту документа.
   * Скрытые строки не занимают места — вместо них виден widget.
   */
  get estimatedHeight(): number {
    return 28;
  }

  /**
   * Ignore events: позволяет кнопкам внутри widget обрабатывать клики.
   * Без этого CM перехватит mousedown и поставит курсор.
   *
   * CM's CollapseWidget использует `e instanceof MouseEvent` (блокирует все mouse events).
   * Мы используем проверку по type для большей точности.
   */
  ignoreEvent(event: Event): boolean {
    return event instanceof MouseEvent;
  }
}
```

#### buildPortionRanges()

```typescript
/**
 * Вычисляет ranges для collapsed зон на основе текущих chunks.
 *
 * Алгоритм повторяет CM's buildCollapsedRanges() из @codemirror/merge,
 * но с добавлением portionSize для PortionCollapseWidget.
 *
 * Оригинальный алгоритм CM (для справки):
 * ```javascript
 * function buildCollapsedRanges(state, margin, minLines) {
 *   let builder = new RangeSetBuilder();
 *   let isA = state.facet(mergeConfig).side == "a";
 *   let chunks = state.field(ChunkField);
 *   let prevLine = 1;
 *   for (let i = 0;; i++) {
 *     let chunk = i < chunks.length ? chunks[i] : null;
 *     let collapseFrom = i ? prevLine + margin : 1;
 *     let collapseTo = chunk
 *       ? state.doc.lineAt(isA ? chunk.fromA : chunk.fromB).number - 1 - margin
 *       : state.doc.lines;
 *     let lines = collapseTo - collapseFrom + 1;
 *     if (lines >= minLines) {
 *       builder.add(
 *         state.doc.line(collapseFrom).from,
 *         state.doc.line(collapseTo).to,
 *         Decoration.replace({ widget: new CollapseWidget(lines), block: true })
 *       );
 *     }
 *     if (!chunk) break;
 *     prevLine = state.doc.lineAt(Math.min(state.doc.length, isA ? chunk.toA : chunk.toB)).number;
 *   }
 *   return builder.finish();
 * }
 * ```
 *
 * Ключевые отличия от CM:
 * 1. Используем getChunks(state) вместо state.field(ChunkField) — public API
 * 2. Unified view → side="b", поэтому всегда используем fromB/toB
 * 3. Первая зона: CM начинает с line 1 без margin (collapseFrom = 1 при i=0),
 *    мы делаем то же самое для совместимости
 * 4. Добавляем portionSize в PortionCollapseWidget
 *
 * @param state — текущее состояние EditorState
 * @param margin — количество строк контекста (default 3)
 * @param minSize — минимум строк для collapse (default 4)
 * @param portionSize — строк за "Expand N" (default 100)
 * @returns DecorationSet с collapsed зонами
 */
function buildPortionRanges(
  state: EditorState,
  margin: number,
  minSize: number,
  portionSize: number
): DecorationSet {
  const result = getChunks(state);
  const doc = state.doc;

  // Если merge view ещё не инициализирован — пустые decorations
  if (!result) return Decoration.none;

  const chunks = result.chunks;
  const builder = new RangeSetBuilder<Decoration>();

  // Повторяем алгоритм CM's buildCollapsedRanges для unified view (side="b")
  let prevLine = 1;

  for (let i = 0; ; i++) {
    const chunk = i < chunks.length ? chunks[i] : null;

    // Для первой зоны (i=0): начинаем с line 1 БЕЗ margin (как CM)
    // Для последующих: prevLine + margin
    const collapseFrom = i ? prevLine + margin : 1;

    // Конец зоны: строка перед началом следующего chunk - margin
    // Или последняя строка документа (если chunk=null = зона после последнего chunk)
    const collapseTo = chunk
      ? doc.lineAt(chunk.fromB).number - 1 - margin
      : doc.lines;

    const lines = collapseTo - collapseFrom + 1;

    if (lines >= minSize) {
      const from = doc.line(collapseFrom).from;
      const to = doc.line(collapseTo).to;

      const widget = new PortionCollapseWidget(lines, from, portionSize);

      builder.add(
        from,
        to,
        Decoration.replace({
          widget,
          block: true,
        })
      );
    }

    if (!chunk) break;

    // prevLine = номер строки конца текущего chunk (для вычисления следующей зоны)
    // Math.min(doc.length, chunk.toB) — защита от toB за пределами документа
    // (CM Chunk: toB может быть "1 past the end of the last line")
    prevLine = doc.lineAt(Math.min(doc.length, chunk.toB)).number;
  }

  return builder.finish();
}
```

**Важно про chunks и позиции:**

Chunks из `getChunks(state)` содержат:
- `fromA / toA` — позиции в original документе (A)
- `fromB / toB` — позиции в текущем документе (B = EditorView's doc)

Для unified merge view `side` = `"b"` (или `null`), поэтому decorations в документе B. Используем `fromB / toB`.

Из типов `@codemirror/merge`:
```typescript
class Chunk {
  readonly fromA: number;  // Start в original doc (character offset, 0-based)
  readonly toA: number;    // End в original doc (1 past end of last line, or = fromA if empty)
  readonly fromB: number;  // Start в current doc
  readonly toB: number;    // End в current doc (1 past end of last line, or = fromB if empty)
  readonly changes: readonly Change[];
  readonly precise: boolean;
  get endA(): number;      // fromA if empty, else end of last line (valid doc position)
  get endB(): number;      // fromB if empty, else end of last line (valid doc position)
}
```

**ВАЖНО про toA/toB:** Документация CM явно указывает:
> "Note that `to` positions may point past the end of the document. Use `endA`/`endB` if you need an end position that is certain to be a valid document position."

Поэтому `Math.min(doc.length, chunk.toB)` обязателен при использовании `toB` для `doc.lineAt()`.

Позиции — это OFFSETS в документе (0-based character positions), НЕ номера строк. Конвертация:
```typescript
const lineNumber = doc.lineAt(chunk.fromB).number;  // 1-based line number
const lineStart = doc.line(lineNumber).from;          // character offset
```

#### PortionCollapsedField — StateField

```typescript
/**
 * StateField хранящий текущие collapsed decorations.
 *
 * Обновляется при:
 * 1. Изменении документа (docChanged) — ремаппинг позиций через map()
 * 2. expandPortion effect — частичное раскрытие зоны
 * 3. expandAllAtPos effect — полное раскрытие зоны
 * 4. updateOriginalDoc effect (accept chunk) — полный rebuild
 * 5. Lazy init: если create() вернул Decoration.none (chunks не готовы)
 *
 * Отличие от CM's CollapsedRanges:
 * - CM использует .init() для начального build и map+filter в update
 * - CM НЕ делает rebuild в update (полагается на reconfigure через compartment)
 * - Мы делаем rebuild при accept/reject потому что portion expand state теряется
 */
const PortionCollapsedField = StateField.define<DecorationSet>({
  create(state: EditorState): DecorationSet {
    // getChunks(state) может вернуть null здесь если ChunkField ещё не инициализирован.
    // Это нормально — buildPortionRanges обработает null и вернёт Decoration.none.
    // Decorations будут построены при первом update (lazy init).
    return buildPortionRanges(state, margin, minSize, portionSize);
  },

  update(value: DecorationSet, tr: Transaction): DecorationSet {
    // === 1. Expand effects ===
    let hasExpandEffect = false;

    for (const effect of tr.effects) {
      if (effect.is(expandPortion)) {
        hasExpandEffect = true;
        value = handleExpandPortion(value, effect.value, tr.state, minSize, portionSize);
      }

      if (effect.is(expandAllAtPos)) {
        hasExpandEffect = true;
        value = handleExpandAll(value, effect.value);
      }
    }

    if (hasExpandEffect) {
      return value;
    }

    // === 2. Accept chunk (updateOriginalDoc) → полный rebuild ===
    // acceptChunk() dispatch'ит updateOriginalDoc effect БЕЗ docChanged.
    // Это меняет original doc → chunks пересчитываются → наши decorations невалидны.
    const hasUpdateOriginalDoc = tr.effects.some(e => e.is(updateOriginalDoc));
    if (hasUpdateOriginalDoc) {
      return buildPortionRanges(tr.state, margin, minSize, portionSize);
    }

    // === 3. Document changed (reject chunk, user editing) ===
    if (tr.docChanged) {
      // rejectChunk() делает docChanged (вставляет original текст).
      // Chunks пересчитываются CM автоматически.
      // Полный rebuild — корректнее чем map, т.к. chunks изменились.
      return buildPortionRanges(tr.state, margin, minSize, portionSize);
    }

    // === 4. Lazy init: create() вернул Decoration.none ===
    // Это происходит если getChunks() вернул null при create().
    // После первой транзакции ChunkField уже инициализирован.
    if (value === Decoration.none) {
      const chunks = getChunks(tr.state);
      if (chunks) {
        return buildPortionRanges(tr.state, margin, minSize, portionSize);
      }
    }

    return value;
  },

  provide(field): Extension {
    return EditorView.decorations.from(field);
  },
});
```

**Импорт updateOriginalDoc:**
```typescript
import { updateOriginalDoc } from '@codemirror/merge';
```

Этот effect dispatch'ится при `acceptChunk()` — он обновляет original doc, что меняет chunks. Нужен полный rebuild decorations.

**ВАЖНО:** `updateOriginalDoc` уже импортируется в `CodeMirrorDiffUtils.ts` (строка 7), но НЕ реэкспортируется. Два варианта:
1. Добавить реэкспорт в CodeMirrorDiffUtils.ts: `export { acceptChunk, getChunks, rejectChunk, updateOriginalDoc };`
2. Импортировать напрямую из `@codemirror/merge` (рекомендуется — updateOriginalDoc это низкоуровневый effect, а не utility)

#### handleExpandPortion()

```typescript
/**
 * Обрабатывает частичное раскрытие collapsed зоны.
 *
 * Алгоритм:
 * 1. Найти decoration range, содержащий pos (через DecorationSet.between)
 * 2. Вычислить новые границы: сдвинуть from на count строк вниз
 * 3. Если оставшихся строк < minSize — удалить decoration (= expand all)
 * 4. Иначе — заменить decoration на новый с уменьшенным lineCount и обновлённым pos/from
 *
 * Использует DecorationSet.update({ filter, add }) вместо ручной итерации
 * через RangeSetBuilder — это идиоматичнее и безопаснее.
 *
 * @param decorations — текущий DecorationSet
 * @param value — { pos, count } из expandPortion effect
 * @param state — текущий EditorState (после transaction)
 * @param minSize — минимум строк для collapse
 * @param portionSize — строк для "Expand N" кнопки
 * @returns обновлённый DecorationSet
 */
function handleExpandPortion(
  decorations: DecorationSet,
  value: { pos: number; count: number },
  state: EditorState,
  minSize: number,
  portionSize: number
): DecorationSet {
  const { pos, count } = value;
  const doc = state.doc;

  // Поиск decoration, содержащей pos
  let targetFrom = -1;
  let targetTo = -1;

  decorations.between(0, doc.length, (from, to) => {
    if (from <= pos && pos <= to) {
      targetFrom = from;
      targetTo = to;
      return false; // stop iteration
    }
  });

  // pos не найден — возвращаем без изменений
  if (targetFrom < 0) return decorations;

  // Вычисляем строки
  const fromLine = doc.lineAt(targetFrom).number;
  const toLine = doc.lineAt(targetTo).number;

  // Новый from = старый from + count строк
  const newFromLine = fromLine + count;
  const remainingLines = toLine - newFromLine + 1;

  if (remainingLines < minSize) {
    // Слишком мало строк осталось — убираем decoration целиком
    return decorations.update({
      filter: (from) => from !== targetFrom,
    });
  }

  // Убираем старую decoration и добавляем новую с уменьшенным range
  const newFrom = doc.line(newFromLine).from;
  const widget = new PortionCollapseWidget(remainingLines, newFrom, portionSize);

  return decorations.update({
    filter: (from) => from !== targetFrom,
    add: [
      Decoration.replace({ widget, block: true }).range(newFrom, targetTo),
    ],
  });
}
```

#### handleExpandAll()

```typescript
/**
 * Обрабатывает полное раскрытие collapsed зоны.
 *
 * Использует DecorationSet.update({ filter }) — идиоматичный CM подход.
 * Аналогично тому, как CM's CollapsedRanges обрабатывает uncollapseUnchanged:
 *   deco.update({ filter: from => from != e.value })
 *
 * @param decorations — текущий DecorationSet
 * @param pos — позиция из expandAllAtPos effect
 * @returns обновлённый DecorationSet (без удалённой decoration)
 */
function handleExpandAll(
  decorations: DecorationSet,
  pos: number
): DecorationSet {
  return decorations.update({
    filter: (from, to) => !(from <= pos && pos <= to),
  });
}
```

#### portionCollapseExtension() — реализация

```typescript
export function portionCollapseExtension(config?: PortionCollapseConfig): Extension {
  const resolvedMargin = config?.margin ?? 3;
  const resolvedMinSize = config?.minSize ?? 4;
  const resolvedPortionSize = config?.portionSize ?? 100;

  // Validate
  if (resolvedMargin < 0) throw new Error('portionCollapse: margin must be >= 0');
  if (resolvedMinSize < 1) throw new Error('portionCollapse: minSize must be >= 1');
  if (resolvedPortionSize < 1) throw new Error('portionCollapse: portionSize must be >= 1');

  // Замыкаем config значения для StateField
  const margin = resolvedMargin;
  const minSize = resolvedMinSize;
  const portionSize = resolvedPortionSize;

  // StateField с замыканием на config
  const field = StateField.define<DecorationSet>({
    create(state) {
      return buildPortionRanges(state, margin, minSize, portionSize);
    },
    update(value, tr) {
      // Полная реализация PortionCollapsedField (см. выше)
      // с замыканием на margin, minSize, portionSize

      // 1. Expand effects
      let hasExpandEffect = false;
      for (const effect of tr.effects) {
        if (effect.is(expandPortion)) {
          hasExpandEffect = true;
          value = handleExpandPortion(value, effect.value, tr.state, minSize, portionSize);
        }
        if (effect.is(expandAllAtPos)) {
          hasExpandEffect = true;
          value = handleExpandAll(value, effect.value);
        }
      }
      if (hasExpandEffect) return value;

      // 2. Accept (updateOriginalDoc) → rebuild
      if (tr.effects.some(e => e.is(updateOriginalDoc))) {
        return buildPortionRanges(tr.state, margin, minSize, portionSize);
      }

      // 3. docChanged (reject, user edit) → rebuild
      if (tr.docChanged) {
        return buildPortionRanges(tr.state, margin, minSize, portionSize);
      }

      // 4. Lazy init
      if (value === Decoration.none) {
        const chunks = getChunks(tr.state);
        if (chunks) {
          return buildPortionRanges(tr.state, margin, minSize, portionSize);
        }
      }

      return value;
    },
    provide(f) {
      return EditorView.decorations.from(f);
    },
  });

  return [field, portionCollapseTheme];
}
```

**Дизайн-решение: closure vs Facet.**

Config передаётся через closure в `portionCollapseExtension()`, а не через Facet. Причина: config не меняется после создания editor (только при dynamic reconfigure через Compartment). При reconfigure extension пересоздаётся целиком с новым config.

---

## Модификация CodeMirrorDiffView.tsx

**Файл:** `src/renderer/components/team/review/CodeMirrorDiffView.tsx`

### Новый prop

```typescript
interface CodeMirrorDiffViewProps {
  // ... существующие props ...

  /**
   * Использовать порционный collapse вместо CM's collapseUnchanged.
   * Когда true: collapseUnchanged НЕ передаётся в mergeConfig.
   * Вместо этого portionCollapseExtension добавляется отдельно.
   * Default: false (обратная совместимость).
   */
  usePortionCollapse?: boolean;

  /**
   * Количество строк за одно нажатие "Expand N".
   * Используется только когда usePortionCollapse=true.
   * Default: 100
   */
  portionSize?: number;
}
```

### Новый Compartment для portionCollapse

```typescript
// Существующий:
const mergeCompartment = useRef(new Compartment());

// НОВЫЙ:
const portionCompartment = useRef(new Compartment());
```

### buildMergeExtension: условное исключение collapseUnchanged

```typescript
const buildMergeExtension = useCallback(
  (collapse: boolean, margin: number): Extension => {
    const mergeConfig: Parameters<typeof unifiedMergeView>[0] = {
      original,
      highlightChanges: false,
      gutter: true,
      syntaxHighlightDeletions: true,
    };

    // ИЗМЕНЕНИЕ: collapseUnchanged добавляется ТОЛЬКО если portionCollapse выключен
    if (collapse && !usePortionCollapse) {
      mergeConfig.collapseUnchanged = {
        margin,
        minSize: 4,
      };
    }

    // ... mergeControls logic без изменений ...

    return unifiedMergeView(mergeConfig);
  },
  [original, showMergeControls, scrollToNextChunk, usePortionCollapse]
);
```

### buildExtensions: добавление portionCollapseExtension

```typescript
const buildExtensions = useCallback(() => {
  const extensions: Extension[] = [
    diffTheme,
    lineNumbers(),
    syntaxHighlighting(oneDarkHighlightStyle),
    EditorView.editable.of(!readOnly),
    EditorState.readOnly.of(readOnly),
  ];

  // ... существующие extensions (history, keymap, language, merge controls) ...

  // Unified merge view (compartment) — ОБЯЗАТЕЛЬНО ПЕРВЫМ
  // portionCollapse зависит от ChunkField из merge view
  extensions.push(
    mergeCompartment.current.of(
      buildMergeExtension(collapseRef.current.enabled, collapseRef.current.margin)
    )
  );

  // НОВОЕ: Portion collapse (отдельный compartment для dynamic reconfigure)
  // ОБЯЗАТЕЛЬНО ПОСЛЕ merge view чтобы ChunkField был доступен в create()
  extensions.push(
    portionCompartment.current.of(
      usePortionCollapse && collapseRef.current.enabled
        ? portionCollapseExtension({
            margin: collapseRef.current.margin,
            minSize: 4,
            portionSize: portionSize ?? 100,
          })
        : []
    )
  );

  return extensions;
}, [readOnly, showMergeControls, buildMergeExtension, usePortionCollapse, portionSize]);
```

### Dynamic reconfigure: portionCollapse toggle

```typescript
// Существующий effect для collapse toggle:
useEffect(() => {
  const view = viewRef.current;
  if (!view) return;

  // Merge view reconfigure (без collapseUnchanged если portionCollapse включён)
  view.dispatch({
    effects: mergeCompartment.current.reconfigure(
      buildMergeExtension(collapseUnchangedProp, collapseMargin)
    ),
  });

  // НОВОЕ: portionCollapse reconfigure
  if (usePortionCollapse) {
    view.dispatch({
      effects: portionCompartment.current.reconfigure(
        collapseUnchangedProp
          ? portionCollapseExtension({
              margin: collapseMargin,
              minSize: 4,
              portionSize: portionSize ?? 100,
            })
          : [] // Collapse выключен — убираем portionCollapse decorations
      ),
    });
  }
}, [collapseUnchangedProp, collapseMargin, buildMergeExtension, usePortionCollapse, portionSize]);
```

**Оптимизация:** Два dispatch можно объединить в один:
```typescript
view.dispatch({
  effects: [
    mergeCompartment.current.reconfigure(
      buildMergeExtension(collapseUnchangedProp, collapseMargin)
    ),
    ...(usePortionCollapse
      ? [portionCompartment.current.reconfigure(
          collapseUnchangedProp
            ? portionCollapseExtension({ margin: collapseMargin, minSize: 4, portionSize: portionSize ?? 100 })
            : []
        )]
      : []),
  ],
});
```
Один dispatch = одна транзакция = один update всех StateField. Это важно для consistency.

**Поведение toggle:**
- `collapseUnchanged: true` + `usePortionCollapse: true` = portion collapse ВКЛЮЧЁН
- `collapseUnchanged: false` + `usePortionCollapse: true` = все зоны развёрнуты (portionCollapse off)
- `collapseUnchanged: true` + `usePortionCollapse: false` = CM's стандартный collapse
- `collapseUnchanged: false` + `usePortionCollapse: false` = все зоны развёрнуты

### Import

```typescript
import {
  portionCollapseExtension,
} from './portionCollapse';
```

---

## Стили

### Размещение: отдельная тема в portionCollapse.ts

Стили включаются как часть extension через `portionCollapseTheme` — инкапсулированы рядом с логикой, автоматически включаются/выключаются вместе с extension.

```typescript
// В portionCollapse.ts
const portionCollapseTheme = EditorView.theme({
  '.cm-portion-collapse': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '4px 12px',
    backgroundColor: 'var(--color-surface-raised)',
    borderTop: '1px solid var(--color-border)',
    borderBottom: '1px solid var(--color-border)',
    minHeight: '28px',
    cursor: 'default',
    userSelect: 'none',
  },

  '.cm-portion-collapse-text': {
    fontSize: '12px',
    color: 'var(--color-text-muted)',
    letterSpacing: '0.5px',
  },

  '.cm-portion-collapse-actions': {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },

  '.cm-portion-expand-btn': {
    padding: '2px 10px',
    fontSize: '11px',
    fontWeight: '500',
    lineHeight: '18px',
    color: 'var(--color-text-secondary)',
    backgroundColor: 'transparent',
    border: '1px solid var(--color-border)',
    borderRadius: '4px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    '&:hover': {
      color: 'var(--color-text)',
      backgroundColor: 'rgba(255, 255, 255, 0.06)',
      borderColor: 'var(--color-border-emphasis)',
    },
    '&:active': {
      backgroundColor: 'rgba(255, 255, 255, 0.1)',
    },
  },

  '.cm-portion-expand-all-btn': {
    padding: '2px 10px',
    fontSize: '11px',
    fontWeight: '500',
    lineHeight: '18px',
    color: 'var(--color-text-muted)',
    backgroundColor: 'transparent',
    border: '1px solid transparent',
    borderRadius: '4px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    '&:hover': {
      color: 'var(--color-text-secondary)',
      backgroundColor: 'rgba(255, 255, 255, 0.04)',
      borderColor: 'var(--color-border)',
    },
    '&:active': {
      backgroundColor: 'rgba(255, 255, 255, 0.08)',
    },
  },
});

// Включается в extension
export function portionCollapseExtension(config?): Extension {
  return [field, portionCollapseTheme];
}
```

**Почему не в diffTheme:**
1. Инкапсулирует стили рядом с логикой
2. Тема автоматически включается/выключается с extension
3. Не загрязняет diffTheme стилями для feature, который может быть отключён
4. CM dedup'ит тему если extension добавлена несколько раз

---

## Как portionCollapse получает changed ranges

### Доступные варианты

#### Вариант A: getChunks из @codemirror/merge (public API)

```typescript
import { getChunks } from '@codemirror/merge';
```

`getChunks(state)` возвращает `{ chunks: readonly Chunk[], side: "a" | "b" | null } | null`.

- **Плюс:** Официальный public API
- **Плюс:** Всегда актуальные chunks (обновляются при accept/reject)
- **Минус:** Может вернуть `null` если merge view ещё не инициализирован
- **Минус:** `side` в unified view = `"b"` (не `null` — в документации CM: unified = side "b")

#### Вариант B: getChunks() из CodeMirrorDiffUtils.ts

```typescript
import { getChunks } from './CodeMirrorDiffUtils';
```

Это реэкспорт `getChunks` из `@codemirror/merge`:
```typescript
// CodeMirrorDiffUtils.ts, line 75
export { acceptChunk, getChunks, rejectChunk };
```

- **Плюс:** Уже используется в CodeMirrorDiffView.tsx
- **Плюс:** Единая точка импорта для всех merge utilities
- **Минус:** Тот же API что вариант A (просто реэкспорт)

#### Вариант C: самостоятельное вычисление через diff

```typescript
import { Chunk, getOriginalDoc } from '@codemirror/merge';

function computeChangedRanges(state: EditorState): readonly Chunk[] {
  const original = getOriginalDoc(state);
  return Chunk.build(original, state.doc);
}
```

- **Плюс:** Не зависит от внутреннего ChunkField merge view
- **Минус:** Дублирование вычислений (chunks считаются дважды)
- **Минус:** `Chunk.build` может быть дорогим на больших файлах

### Рекомендация: Вариант B

Используем `getChunks()` из `CodeMirrorDiffUtils.ts` — уже проверенный и используемый в проекте. Это реэкспорт official API, но через единую точку проекта.

```typescript
// portionCollapse.ts
import { getChunks } from './CodeMirrorDiffUtils';
```

**Обработка null:**
```typescript
const result = getChunks(state);
if (!result) return Decoration.none;  // Merge view ещё не готов
```

### Порядок extensions и lazy init

`getChunks` вернёт `null` в `create()` если ChunkField ещё не инициализирован. CM вызывает `create()` для всех StateField при создании EditorState. Порядок вызова `create()` определяется порядком extensions.

**Но** даже если merge extension идёт первой в списке, `ChunkField.init()` может ещё не быть applied в момент `create()` нашего field, потому что `init()` работает как override для `create()` и применяется к тому же проходу инициализации.

Поэтому `buildPortionRanges` обрабатывает `null` от `getChunks` и возвращает `Decoration.none`. Lazy init в `update()` StateField исправляет это при первой же транзакции:

```typescript
update(value, tr) {
  // Lazy init: если create() вернул Decoration.none потому что chunks были null
  if (value === Decoration.none) {
    const chunks = getChunks(tr.state);
    if (chunks) {
      return buildPortionRanges(tr.state, margin, minSize, portionSize);
    }
  }
  // ...
}
```

**Когда вызовется первый update?** При первом dispatch в EditorView. В CodeMirrorDiffView.tsx после создания view сразу идёт reconfigure для language (`langCompartment.current.reconfigure(syncLang)`) — это transaction, которая триггерит update всех StateField. Поэтому lazy init сработает практически мгновенно.

---

## Edge-cases

### 1. portionCollapse + accept/reject

**Проблема:** При `acceptChunk(view)` CM dispatch'ит `updateOriginalDoc` effect (обновляет original doc). Это меняет ChunkField — collapsed зоны могут стать невалидными. При `rejectChunk(view)` CM dispatch'ит `docChanged` (заменяет текст в document B).

**Решение:** В `update()` StateField:
- `updateOriginalDoc` effect detected → полный rebuild через `buildPortionRanges()`
- `tr.docChanged` → полный rebuild через `buildPortionRanges()`

Существующие expanded зоны (пользователь уже нажал "Expand 100") теряются — все collapsed зоны пересоздаются.

**Обоснование:** Accept/reject — редкая операция. Потеря расширенных зон допустима (пользователь expand'ил чтобы посмотреть контекст, а после accept/reject контекст изменился). GitHub ведёт себя аналогично.

**Отличие от CM:** CM's `CollapsedRanges` при accept/reject НЕ делает rebuild в `update()`. CM полагается на reconfigure compartment для пересоздания decorations. Наш подход с rebuild в `update()` проще и не требует внешнего координатора.

### 2. Expand на границе файла

**Проблема:** Collapsed зона в начале файла (строки 1-100). "Expand 100" сдвинет from на 100 строк — зона исчезнет (0 строк). Это нормальное поведение.

**Проблема:** Collapsed зона в конце файла (строки 450-500). "Expand 100" запросит 100 строк, но доступно только 50.

**Решение:** `handleExpandPortion` вычисляет `remainingLines`. Если `remainingLines < minSize` — зона удаляется целиком (эквивалент "Expand All"). Widget показывает `Expand {min(portionSize, lineCount)}` если lineCount < portionSize.

Проверка в PortionCollapseWidget.toDOM():
```typescript
if (this.lineCount > this.portionSize) {
  // Кнопка "Expand {portionSize}"
} else {
  // lineCount <= portionSize — показываем только "Expand All"
  // (кнопка "Expand N" не создаётся — она бы expand'ила всё равно всё)
}
```

### 3. Файл целиком новый (isNewFile: true)

**Проблема:** Новый файл = весь контент "inserted". `getChunks` вернёт один chunk покрывающий весь файл. Unchanged зон НЕТ.

**Решение:** `buildPortionRanges` не создаёт decorations если нет промежутков между chunks. Цикл `for (let i = 0; ; i++)` проверяет `lines >= minSize` для каждой зоны — зон нет → `builder.finish()` возвращает пустой `DecorationSet`.

### 4. Reconfigure при toggle collapseUnchanged

**Проблема:** Пользователь включает/выключает collapse через ReviewToolbar toggle.

**Решение:** Dynamic reconfigure через portionCompartment:
- Toggle ON: `portionCompartment.reconfigure(portionCollapseExtension(config))` — создаётся новый StateField с новыми decorations
- Toggle OFF: `portionCompartment.reconfigure([])` — StateField удаляется, decorations пропадают

**Важно:** При reconfigure ВСЕ expanded зоны сбрасываются (новый StateField = новые decorations). Это ожидаемо — toggle collapse = "пересоздать все collapsed зоны".

### 5. Конфликт с CM's collapseUnchanged

**Проблема:** Если случайно включены оба (collapseUnchanged в mergeConfig И portionCollapseExtension) — двойные `Decoration.replace` на одних и тех же зонах. Это приведёт к невалидным overlapping replace decorations.

**Решение:** `buildMergeExtension` проверяет `usePortionCollapse` и НЕ добавляет collapseUnchanged если portionCollapse включён. Дополнительно, в документации portionCollapseExtension явно указано: "НЕ совместима с collapseUnchanged".

**Дополнительная защита:** Можно добавить runtime check в `buildPortionRanges`:
```typescript
// Если CM's collapseUnchanged уже создал decorations — пропускаем
// (проверка через наличие .cm-collapsedLines элементов в DOM)
```
Но это over-engineering — достаточно документации и проверки в `buildMergeExtension`.

### 6. Очень длинные файлы (10000+ строк)

**Проблема:** Много collapsed зон может замедлить DecorationSet operations.

**Решение:**
1. `RangeSetBuilder` создаёт balanced B-tree RangeSet эффективно (O(n))
2. `DecorationSet.update({ filter })` = O(n) для фильтрации
3. Количество collapsed зон = chunks.length + 1 (максимум)
4. Типичное количество chunks < 100, поэтому collapsed зон < 101
5. CM RangeSet оптимизирован для тысяч ranges

### 7. Expand + docChanged одновременно (concurrent editing)

**Проблема:** Пользователь нажимает "Expand 100" в момент когда CM обрабатывает typing transaction.

**Решение:** CM гарантирует атомарность transactions. `expandPortion` effect будет в отдельной transaction. `StateEffect.define({ map })` обеспечивает корректный ремаппинг позиций если document изменился между dispatch и apply.

Сигнатура map callback: `(value: Value, mapping: ChangeDesc) => Value | undefined`. Если map вернёт `undefined` — effect удаляется из transaction. Наш `expandPortion.map` всегда возвращает объект (mapPos не может вернуть undefined), поэтому effect всегда сохраняется.

### 8. updateDOM vs toDOM в PortionCollapseWidget

**Проблема:** CM вызывает `updateDOM(dom, view)` когда widget с `eq() = false` но того же типа. Можно обновить DOM вместо пересоздания.

**Решение:** НЕ реализуем `updateDOM()`. Причина:
1. Widget пересоздаётся только при expand (нечасто)
2. `eq()` возвращает true если lineCount/portionSize не изменились — DOM не пересоздаётся
3. При rebuild decorations (accept/reject) все widgets пересоздаются в любом случае
4. Сложность updateDOM (изменение текста + показ/скрытие кнопок) не оправдана для редкой операции

### 9. scrollbar высота при collapsed зонах

**Проблема:** CM вычисляет высоту scrollbar на основе видимого контента. Collapsed зоны скрывают строки — scrollbar может стать неточным.

**Решение:** `Decoration.replace({ block: true })` корректно обрабатывается CM для расчёта scrollbar. CM использует `estimatedHeight` widget'а для приблизительной высоты. Наш widget возвращает фиксированную высоту (28px) — это высота видимого widget, не скрытого контента. CM's CollapseWidget возвращает 27px. Scrollbar корректно отражает видимую высоту документа.

### 10. eq() и pos — когда decoration перемещается

**Проблема:** После `map(tr.changes)` позиция decoration может сдвинуться. Виджет хранит `pos` — он станет stale.

**Решение:** `eq()` НЕ сравнивает `pos`. CM вызывает `eq()` только для decorations на ОДНОЙ позиции. Если позиция decoration изменилась после map — это другой range, CM пересоздаёт widget через `toDOM()`. Однако `pos` внутри виджета всё равно может быть stale если decoration map'нулась но eq() вернул true.

**Но:** `pos` используется только в onmousedown для dispatch effect. К моменту клика пользователя — document уже stable, и `pos` совпадает с `from` decoration (потому что виджет создавался с `pos = from`). Если map изменил from — CM пересоздаст виджет (eq = false из-за lineCount изменения или нового toDOM).

Для дополнительной надёжности можно использовать `view.posAtDOM(container)` вместо сохранённого `this.pos`:
```typescript
expandBtn.onmousedown = (e) => {
  e.preventDefault();
  const pos = view.posAtDOM(container);
  view.dispatch({ effects: expandPortion.of({ pos, count: this.portionSize }) });
};
```
Это паттерн из CM's CollapseWidget (`view.posAtDOM(e.target)`). **Рекомендуется** для robustness.

---

## Проверка

### Unit тесты

```
test/renderer/components/team/review/portionCollapse.test.ts
```

**Тест-кейсы для buildPortionRanges:**

1. **Нет chunks** — getChunks returns null → Decoration.none
2. **Один chunk в середине** — создаёт 2 collapsed зоны (до и после)
3. **Chunk в начале файла** — одна collapsed зона после chunk
4. **Chunk в конце файла** — одна collapsed зона до chunk
5. **Два chunks рядом** — зона между ними < minSize → не collapse
6. **Два chunks далеко** — зона между ними >= minSize → collapse с margin
7. **Весь файл — новый (1 chunk на весь файл)** — пустой DecorationSet
8. **margin = 0** — collapse начинается сразу после chunk
9. **minSize = 1** — даже 1 строка сворачивается
10. **Первая зона (до первого chunk)** — начинается с line 1 без margin (как CM)

**Тест-кейсы для handleExpandPortion:**

11. **Expand 100 строк из 247** — новая decoration с 147 строками, смещённый from
12. **Expand 100 строк из 103** — 3 строки осталось < minSize(4) → decoration удалена
13. **Expand 100 строк из 100** — lineCount == portionSize → decoration удалена (< minSize)
14. **pos не найден в decorations** — decorations без изменений

**Тест-кейсы для handleExpandAll:**

15. **Expand all — decoration удалена** — DecorationSet без этой decoration
16. **pos не найден** — decorations без изменений

**Тест-кейсы для PortionCollapseWidget:**

17. **toDOM: lineCount > portionSize** — 2 кнопки (Expand N + Expand All)
18. **toDOM: lineCount <= portionSize** — 1 кнопка (только Expand All)
19. **toDOM: lineCount = 1** — "1 unchanged line" (singular)
20. **eq: same lineCount + portionSize** — true
21. **eq: different lineCount** — false
22. **ignoreEvent: MouseEvent** — true
23. **ignoreEvent: KeyboardEvent** — false

**Тест-кейсы для StateField update:**

24. **updateOriginalDoc effect (accept)** — полный rebuild
25. **docChanged (reject)** — полный rebuild
26. **expandPortion effect** — partial expand
27. **expandAllAtPos effect** — полное удаление
28. **Lazy init: Decoration.none → chunks available** — rebuild
29. **No-op transaction** — value unchanged

### Ручная проверка

1. Открыть файл с 500+ строк между изменениями
2. Видна collapsed зона: "... 247 unchanged lines ..."
3. Кнопка "Expand 100" → зона уменьшается до "... 147 unchanged lines ..."
4. Повторный "Expand 100" → "... 47 unchanged lines ..." (только Expand All если <= 100)
5. "Expand All" → зона полностью развёрнута
6. Accept chunk → collapsed зоны пересчитаны
7. Toggle collapse off/on → все зоны пересозданы (expanded зоны сброшены)
8. Файл целиком новый → нет collapsed зон
9. Маленький файл (< minSize между chunks) → нет collapsed зон

### Визуальная проверка стилей

1. Collapsed зона визуально совпадает с CM's `.cm-collapsedLines` (bg, border, font)
2. Кнопки: hover → subtle highlight
3. Кнопки: active → darker highlight
4. Кнопки не ломают layout при resize окна
5. Текст "N unchanged lines" корректно обновляется при expand

---

## Файлы

| Файл | Тип | ~LOC |
|------|-----|---:|
| `src/renderer/components/team/review/portionCollapse.ts` | NEW | ~300 (StateField + Widget + helpers + theme) |
| `src/renderer/components/team/review/CodeMirrorDiffView.tsx` | MODIFY | ~40 (usePortionCollapse prop, compartment, buildExtensions) |
| `test/renderer/components/team/review/portionCollapse.test.ts` | NEW | ~300 (29 тест-кейсов) |
| **Итого** | 2 NEW + 1 MODIFY | ~640 |
