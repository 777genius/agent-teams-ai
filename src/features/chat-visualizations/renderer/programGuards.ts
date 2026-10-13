import type { FenceState } from '../contracts';
import type { ParseResult } from '@openuidev/lang-core';

export interface MaterializedNode {
  typeName?: unknown;
  props?: unknown;
  hasDynamicProps?: unknown;
}
export type ChatVisualizationParseResult = ParseResult;
export type ProgramGuardResult =
  | { status: 'ready' }
  | { status: 'progressive' }
  | { status: 'rejected'; message: string };
const READY: ProgramGuardResult = { status: 'ready' };
const PENDING: ProgramGuardResult = { status: 'progressive' };
const reject = (message = 'Visualization unavailable'): ProgramGuardResult => ({
  status: 'rejected',
  message,
});
const limit = (): ProgramGuardResult => reject('Visualization exceeds display limits.');
const missing = (state: FenceState): ProgramGuardResult =>
  state === 'open' ? PENDING : reject('The visualization is incomplete.');
const ROOT_TYPES = new Set(['Card']);
const CONTENT_TYPES = new Set([
  'CardHeader',
  'TextContent',
  'Table',
  'BarChart',
  'LineChart',
  'PieChart',
]);

function propsOf(node: unknown): Record<string, unknown> {
  const props = (node as MaterializedNode | null)?.props;
  return props && typeof props === 'object' ? (props as Record<string, unknown>) : {};
}
function nameOf(node: unknown): unknown {
  return (node as MaterializedNode | null)?.typeName;
}
function merge(results: ProgramGuardResult[]): ProgramGuardResult {
  return (
    results.find((result) => result.status === 'rejected') ??
    (results.some((result) => result.status === 'progressive') ? PENDING : READY)
  );
}
function text(
  value: unknown,
  max: number,
  state: FenceState,
  optional = false
): ProgramGuardResult {
  if (value == null) return optional ? READY : missing(state);
  if (typeof value !== 'string') return reject('Expected plain text.');
  return value.length > max ? limit() : READY;
}
function array(
  value: unknown,
  max: number,
  valid: (item: unknown) => boolean,
  state: FenceState
): ProgramGuardResult {
  if (value == null) return missing(state);
  if (!Array.isArray(value)) return reject('Expected static array data.');
  if (value.length > max) return limit();
  return value.every(valid) ? READY : reject('Unsupported array data.');
}
const finite = (item: unknown): boolean => typeof item === 'number' && Number.isFinite(item);
const cell = (item: unknown): boolean =>
  item === null || typeof item === 'string' || typeof item === 'boolean' || finite(item);
function enumValue(value: unknown, values: readonly string[]): ProgramGuardResult {
  return value == null || (typeof value === 'string' && values.includes(value))
    ? READY
    : reject('Unsupported display option.');
}
function children(
  value: unknown,
  allowed: Set<string>,
  max: number,
  state: FenceState
): ProgramGuardResult {
  if (value == null) return missing(state);
  if (!Array.isArray(value)) return reject('Expected component references.');
  if (value.length > max) return limit();
  return merge(
    value.map((child) => {
      if (child == null) return missing(state);
      const name = nameOf(child);
      if (typeof name !== 'string' || !allowed.has(name))
        return reject('Unsupported component in this slot.');
      return guardChatVisualizationNode(child as MaterializedNode, state);
    })
  );
}
function table(props: Record<string, unknown>, state: FenceState): ProgramGuardResult {
  return children(props.columns, new Set(['Col']), 100, state);
}
function chart(
  props: Record<string, unknown>,
  kind: string,
  state: FenceState
): ProgramGuardResult {
  const checks = [array(props.labels, 500, (value) => typeof value === 'string', state)];
  if (kind === 'PieChart') {
    checks.push(array(props.values, 500, finite, state));
    checks.push(
      enumValue(props.variant, ['pie', 'donut']),
      enumValue(props.appearance, ['circular', 'semiCircular'])
    );
    if (
      state === 'closed' &&
      Array.isArray(props.labels) &&
      Array.isArray(props.values) &&
      props.labels.length !== props.values.length
    ) {
      checks.push(reject('Chart labels and values must align.'));
    }
  } else {
    checks.push(children(props.series, new Set(['Series']), 20, state));
    checks.push(
      enumValue(
        props.variant,
        kind === 'BarChart' ? ['grouped', 'stacked'] : ['linear', 'natural', 'step']
      )
    );
    checks.push(text(props.xLabel, 500, state, true), text(props.yLabel, 500, state, true));
    let points = 0;
    if (Array.isArray(props.series)) {
      for (const series of props.series) {
        const values = propsOf(series).values;
        if (Array.isArray(values)) {
          points += values.length;
          if (
            state === 'closed' &&
            Array.isArray(props.labels) &&
            values.length !== props.labels.length
          ) {
            checks.push(reject('Chart labels and values must align.'));
          }
        }
      }
    }
    if (points > 500) checks.push(limit());
    if (
      props.height != null &&
      (typeof props.height !== 'number' ||
        !Number.isInteger(props.height) ||
        props.height < 160 ||
        props.height > 600)
    ) {
      checks.push(limit());
    }
  }
  return merge(checks);
}

export function guardChatVisualizationNode(
  node: MaterializedNode | null,
  state: FenceState
): ProgramGuardResult {
  if (node == null) return missing(state);
  const props = propsOf(node);
  switch (node.typeName) {
    case 'Stack':
      return children(props.children, ROOT_TYPES, 500, state);
    case 'Card':
      return children(props.children, CONTENT_TYPES, 24, state);
    case 'CardHeader':
      return merge([text(props.title, 500, state, true), text(props.subtitle, 500, state, true)]);
    case 'TextContent':
      return merge([
        text(props.text, 10_000, state),
        enumValue(props.size, ['small', 'default', 'large', 'small-heavy', 'large-heavy']),
      ]);
    case 'Table':
      return table(props, state);
    case 'Col':
      return merge([
        text(props.label, 500, state),
        array(props.data, 500, cell, state),
        enumValue(props.type, ['string', 'number']),
      ]);
    case 'Series':
      return merge([text(props.category, 500, state), array(props.values, 500, finite, state)]);
    case 'BarChart':
    case 'LineChart':
    case 'PieChart':
      return chart(props, node.typeName, state);
    default:
      return reject('Unsupported visualization component.');
  }
}

export function guardChatVisualizationProgram(
  result: ParseResult,
  state: FenceState
): ProgramGuardResult {
  if (
    Object.keys(result.stateDeclarations).length ||
    result.queryStatements.length ||
    result.mutationStatements.length
  ) {
    return reject('Visualizations cannot use state, queries, or mutations.');
  }
  if (!result.root) return missing(state);
  if (result.root.typeName !== 'Stack' || result.root.hasDynamicProps !== false) {
    return reject('Visualizations support a static root Stack only.');
  }
  const checked = guardChatVisualizationNode(result.root, state);
  if (checked.status === 'rejected') return checked;
  if (
    state === 'closed' &&
    (result.meta.errors.length || result.meta.incomplete || result.meta.unresolved.length)
  ) {
    return reject('The visualization is incomplete or invalid.');
  }
  return result.meta.errors.length || result.meta.incomplete || result.meta.unresolved.length
    ? PENDING
    : checked;
}
