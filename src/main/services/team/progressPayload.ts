/**
 * Helpers that shape provisioning progress payloads before they are emitted
 * to the renderer over IPC.
 *
 * Rationale: the renderer only renders a small "tail" preview of CLI logs
 * and assistant output in ProvisioningProgressBlock / CliLogsRichView. Sending
 * the full accumulated history on every throttled progress tick (≈ every
 * second under load) serialized a multi-megabyte string over IPC and forced
 * Zustand to produce a new immutable state object — which triggered renderer
 * V8 OOM crashes for users with long-running teams. These helpers keep the
 * hot emission path bounded while leaving the full history in-process for
 * diagnostics and completion-time reports.
 */

export const PROGRESS_LOG_TAIL_LINES = 200;
export const PROGRESS_OUTPUT_TAIL_PARTS = 20;

/**
 * Return the trailing `maxLines` of a line-buffered CLI log, joined with "\n"
 * and trimmed. Returns `undefined` when the tail is empty so callers can
 * skip emitting a noop update.
 */
export function buildProgressLogsTail(
  lines: readonly string[],
  maxLines: number = PROGRESS_LOG_TAIL_LINES
): string | undefined {
  if (lines.length === 0) {
    return undefined;
  }
  const effectiveMax = Math.max(1, maxLines);
  const tail = lines.length > effectiveMax ? lines.slice(-effectiveMax) : lines;
  const joined = tail.join('\n').trim();
  return joined.length === 0 ? undefined : joined;
}

/**
 * Return the trailing `maxParts` of assistant output parts joined with a
 * blank line, matching the renderer's rendering contract. Returns `undefined`
 * when no parts are available.
 */
export function buildProgressAssistantOutput(
  parts: readonly string[],
  maxParts: number = PROGRESS_OUTPUT_TAIL_PARTS
): string | undefined {
  if (parts.length === 0) {
    return undefined;
  }
  const effectiveMax = Math.max(1, maxParts);
  const tail = parts.length > effectiveMax ? parts.slice(-effectiveMax) : parts;
  const joined = tail.join('\n\n');
  return joined.trim().length === 0 ? undefined : joined;
}
