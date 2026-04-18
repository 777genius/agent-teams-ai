import type { SessionDetail } from '../../types';

/**
 * Strip the raw `messages` array from a `SessionDetail` before it crosses the
 * IPC / HTTP boundary to the renderer.
 *
 * The renderer consumes `session`, `chunks`, `processes`, and `metrics` only —
 * `messages` is an implementation detail that `ChunkBuilder` retains for
 * internal callers. Including it in the serialized payload roughly doubled
 * the IPC cost for sessions with large JSONL files (tens of MB per response)
 * while also inflating the in-memory `DataCache` footprint. The field is
 * preserved (as an empty array) so the shared `SessionDetail` type stays
 * satisfied and downstream code can still observe `.messages.length === 0`
 * without runtime type narrowing.
 */
export function stripSessionDetailMessages(detail: SessionDetail): SessionDetail {
  if (detail.messages.length === 0) {
    return detail;
  }
  return {
    ...detail,
    messages: [],
  };
}
