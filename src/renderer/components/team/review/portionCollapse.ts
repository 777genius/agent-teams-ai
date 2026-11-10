import { updateOriginalDoc } from '@codemirror/merge';
import { type Extension, Facet, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
} from '@codemirror/view';

import { getChunks } from './CodeMirrorDiffUtils';

import type { ChangeDesc, EditorState, Transaction } from '@codemirror/state';

// ─── Configuration ───

interface PortionCollapseConfig {
  margin?: number;
  minSize?: number;
  portionSize?: number;
}

interface ResolvedPortionConfig {
  margin: number;
  minSize: number;
  portionSize: number;
}

// ─── Configuration Facet ───
// Compartment controls this facet value. The StateField reads config from here,
// so reconfiguring the compartment does NOT recreate the field (preserving expanded state).

const portionCollapseConfigFacet = Facet.define<ResolvedPortionConfig, ResolvedPortionConfig>({
  combine: (values) => values[0] ?? { margin: 3, minSize: 4, portionSize: 100 },
});

// ─── State Effects ───

export const expandPortion = StateEffect.define<{ pos: number; count: number }>({
  map: (value, mapping: ChangeDesc) => ({
    pos: mapping.mapPos(value.pos),
    count: value.count,
  }),
});

export const expandAllAtPos = StateEffect.define<number>({
  map: (pos, mapping: ChangeDesc) => mapping.mapPos(pos),
});

// ─── Widget ───

class PortionCollapseWidget extends WidgetType {
  constructor(
    readonly lineCount: number,
    readonly portionSize: number
  ) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-portion-collapse';

    const text = document.createElement('span');
    text.className = 'cm-portion-collapse-text';
    text.textContent = `\u00B7\u00B7\u00B7 ${this.lineCount} unchanged line${this.lineCount !== 1 ? 's' : ''} \u00B7\u00B7\u00B7`;
    container.appendChild(text);

    const actions = document.createElement('div');
    actions.className = 'cm-portion-collapse-actions';

    if (this.lineCount > this.portionSize) {
      const expandBtn = document.createElement('button');
      expandBtn.className = 'cm-portion-expand-btn';
      expandBtn.textContent = `Expand ${this.portionSize}`;
      expandBtn.title = `Show next ${this.portionSize} lines`;
      expandBtn.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pos = view.posAtDOM(container);
        view.dispatch({
          effects: expandPortion.of({ pos, count: this.portionSize }),
        });
      };
      actions.appendChild(expandBtn);
    }

    const expandAllBtn = document.createElement('button');
    expandAllBtn.className = 'cm-portion-expand-all-btn';
    expandAllBtn.textContent = 'Expand All';
    expandAllBtn.title = `Show all ${this.lineCount} unchanged lines`;
    expandAllBtn.onmousedown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pos = view.posAtDOM(container);
      view.dispatch({
        effects: expandAllAtPos.of(pos),
      });
    };
    actions.appendChild(expandAllBtn);

    container.appendChild(actions);
    return container;
  }

  eq(other: PortionCollapseWidget): boolean {
    return this.lineCount === other.lineCount && this.portionSize === other.portionSize;
  }

  // eslint-disable-next-line @typescript-eslint/class-literal-property-style -- WidgetType defines estimatedHeight as getter, cannot override with property
  get estimatedHeight(): number {
    return 28;
  }

  ignoreEvent(event: Event): boolean {
    return event instanceof MouseEvent;
  }
}

// ─── Helpers ───

function buildPortionRanges(
  state: EditorState,
  margin: number,
  minSize: number,
  portionSize: number
): DecorationSet {
  const result = getChunks(state);
  const doc = state.doc;

  if (!result) return Decoration.none;

  const chunks = result.chunks;

  // After all diff chunks are accepted/resolved, chunks is empty.
  // Don't collapse the entire file — there's nothing to review.
  if (chunks.length === 0) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();

  let prevLine = 1;

  for (let i = 0; ; i++) {
    const chunk = i < chunks.length ? chunks[i] : null;
    const collapseFrom = i ? prevLine + margin : 1;
    const collapseTo = chunk ? doc.lineAt(chunk.fromB).number - 1 - margin : doc.lines;
    const lines = collapseTo - collapseFrom + 1;

    if (lines >= minSize) {
      const from = doc.line(collapseFrom).from;
      const to = doc.line(collapseTo).to;
      const widget = new PortionCollapseWidget(lines, portionSize);

      builder.add(from, to, Decoration.replace({ widget, block: true }));
    }

    if (!chunk) break;

    prevLine = doc.lineAt(Math.min(doc.length, chunk.toB)).number;
  }

  return builder.finish();
}

function handleExpandPortion(
  decorations: DecorationSet,
  value: { pos: number; count: number },
  state: EditorState,
  minSize: number,
  portionSize: number
): DecorationSet {
  const { pos, count } = value;
  const doc = state.doc;

  let targetFrom = -1;
  let targetTo = -1;

  decorations.between(0, doc.length, (from, to) => {
    if (from <= pos && pos <= to) {
      targetFrom = from;
      targetTo = to;
      return false;
    }
  });

  if (targetFrom < 0) return decorations;

  const fromLine = doc.lineAt(targetFrom).number;
  const toLine = doc.lineAt(targetTo).number;
  const newFromLine = fromLine + count;
  const remainingLines = toLine - newFromLine + 1;

  if (remainingLines < minSize) {
    return decorations.update({
      filter: (from) => from !== targetFrom,
    });
  }

  const newFrom = doc.line(newFromLine).from;
  const widget = new PortionCollapseWidget(remainingLines, portionSize);

  return decorations.update({
    filter: (from) => from !== targetFrom,
    add: [Decoration.replace({ widget, block: true }).range(newFrom, targetTo)],
  });
}

function handleExpandAll(decorations: DecorationSet, pos: number): DecorationSet {
  return decorations.update({
    filter: (from, to) => !(from <= pos && pos <= to),
  });
}

// ─── Theme ───

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
    position: 'sticky',
    left: '0',
    boxSizing: 'border-box',
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
      backgroundColor: 'var(--diff-expand-hover-bg)',
      borderColor: 'var(--color-border-emphasis)',
    },
    '&:active': {
      backgroundColor: 'var(--diff-expand-active-bg)',
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
      backgroundColor: 'var(--diff-expand-all-hover-bg)',
      borderColor: 'var(--color-border)',
    },
    '&:active': {
      backgroundColor: 'var(--diff-expand-all-active-bg)',
    },
  },
});

// ─── Singleton StateField ───
// Defined at MODULE level so compartment.reconfigure() reuses the same field instance.
// CM recognizes it's the same field → keeps accumulated state (expanded regions) → no create() call.
// Config is read from portionCollapseConfigFacet (controlled by compartment).

interface PortionCollapseState {
  decorations: DecorationSet;
  /**
   * Once the user expands everything (i.e. removes the last collapse widget),
   * we should NOT re-initialize collapse on harmless transactions like cursor moves.
   */
  userExpandedAll: boolean;
}

const portionCollapseField = StateField.define<PortionCollapseState>({
  create(state: EditorState): PortionCollapseState {
    const cfg = state.facet(portionCollapseConfigFacet);
    return {
      decorations: buildPortionRanges(state, cfg.margin, cfg.minSize, cfg.portionSize),
      userExpandedAll: false,
    };
  },

  update(value: PortionCollapseState, tr: Transaction): PortionCollapseState {
    const cfg = tr.state.facet(portionCollapseConfigFacet);

    // 1. Expand effects
    let nextDeco = value.decorations;
    let userExpandedAll = value.userExpandedAll;
    let hasExpandEffect = false;
    for (const effect of tr.effects) {
      if (effect.is(expandPortion)) {
        hasExpandEffect = true;
        nextDeco = handleExpandPortion(
          nextDeco,
          effect.value,
          tr.state,
          cfg.minSize,
          cfg.portionSize
        );
      }
      if (effect.is(expandAllAtPos)) {
        hasExpandEffect = true;
        nextDeco = handleExpandAll(nextDeco, effect.value);
      }
    }
    if (hasExpandEffect) {
      if (nextDeco === Decoration.none) {
        userExpandedAll = true;
      }
      return { decorations: nextDeco, userExpandedAll };
    }

    // 2. Accept chunk (updateOriginalDoc) — editor doc unchanged, keep decorations.
    // Full rebuild here would destroy user's expanded state (Expand All / Expand N).
    // The chunk boundaries shift but editor positions stay valid since doc didn't change.
    // When mirrorEditsAfterResolve adds updateOriginalDoc to a docChanged transaction,
    // we must NOT short-circuit — fall through to docChanged handler for proper rebuild.
    if (tr.effects.some((e) => e.is(updateOriginalDoc)) && !tr.docChanged) {
      return value;
    }

    // 3. Document changed (reject, user edit)
    //
    // Rebuilding from scratch here causes a bad UX: after the user expands (or when a hunk is
    // applied) the editor can suddenly re-collapse unchanged regions, hiding the code the user
    // was actively looking at. Instead, keep the user's current collapsed/expanded state stable
    // by mapping existing decorations through the document changes.
    if (tr.docChanged) {
      const mapped = value.decorations.map(tr.changes);
      // If we previously had no collapse decoration but chunks are now available, initialize once.
      // BUT: if the user explicitly expanded everything, never re-collapse automatically.
      if (!value.userExpandedAll && value.decorations === Decoration.none) {
        const chunks = getChunks(tr.state);
        if (chunks) {
          return {
            decorations: buildPortionRanges(tr.state, cfg.margin, cfg.minSize, cfg.portionSize),
            userExpandedAll: false,
          };
        }
      }
      return { decorations: mapped, userExpandedAll: value.userExpandedAll };
    }

    // 4. Lazy init
    if (!value.userExpandedAll && value.decorations === Decoration.none) {
      const chunks = getChunks(tr.state);
      if (chunks) {
        return {
          decorations: buildPortionRanges(tr.state, cfg.margin, cfg.minSize, cfg.portionSize),
          userExpandedAll: false,
        };
      }
    }

    return value;
  },

  provide(f) {
    return EditorView.decorations.from(f, (v) => v.decorations);
  },
});

// ─── Viewport-pinning plugin ───
// Block widgets span the full content width (can be thousands of px for wide files).
// This plugin sets an explicit width on .cm-portion-collapse elements so they match
// the visible viewport width, making `position: sticky; left: 0` actually constrain them.

function syncCollapseWidths(view: EditorView): void {
  const scrollerRect = view.scrollDOM.getBoundingClientRect();
  if (!scrollerRect.width) return;
  const els = view.dom.querySelectorAll<HTMLElement>('.cm-portion-collapse');
  for (const el of els) {
    // The widget lives inside .cm-content which may have a left offset (gutters).
    // Compute available width from scroller's right edge minus the element's left position.
    const elRect = el.getBoundingClientRect();
    const w = scrollerRect.right - elRect.left;
    if (w > 0) {
      el.style.width = `${w}px`;
    }
  }
}

const portionCollapsePinPlugin = ViewPlugin.define((view) => {
  // Initial sync after first render
  requestAnimationFrame(() => syncCollapseWidths(view));
  return {
    update() {
      requestAnimationFrame(() => syncCollapseWidths(view));
    },
  };
});

const portionCollapseScrollHandler = EditorView.domEventHandlers({
  scroll(_event, view) {
    syncCollapseWidths(view);
    return false;
  },
});

// ─── Extension ───

export function portionCollapseExtension(config?: PortionCollapseConfig): Extension {
  const margin = config?.margin ?? 3;
  const minSize = config?.minSize ?? 4;
  const portionSize = config?.portionSize ?? 100;

  // Returns the SAME portionCollapseField reference every time.
  // CM sees it's the same StateField → keeps state across compartment reconfigurations.
  // Only the facet value (config) is new — the field reads it dynamically.
  return [
    portionCollapseConfigFacet.of({ margin, minSize, portionSize }),
    portionCollapseField,
    portionCollapseTheme,
    portionCollapsePinPlugin,
    portionCollapseScrollHandler,
  ];
}
