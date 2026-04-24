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

import type { TeamLaunchDiagnosticItem } from '@shared/types';

export const PROGRESS_LOG_TAIL_LINES = 200;
export const PROGRESS_OUTPUT_TAIL_PARTS = 20;
export const PROGRESS_LAUNCH_DIAGNOSTICS_LIMIT = 20;
const PROGRESS_LAUNCH_DIAGNOSTIC_TEXT_LIMIT = 500;
const SECRET_FLAG_PATTERN =
  /(--(?:api-key|token|password|secret|authorization|auth-token)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;

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

function boundDiagnosticText(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  if (!trimmed) {
    return undefined;
  }
  const redacted = trimmed.replace(SECRET_FLAG_PATTERN, '$1[redacted]');
  return redacted.length > PROGRESS_LAUNCH_DIAGNOSTIC_TEXT_LIMIT
    ? `${redacted.slice(0, PROGRESS_LAUNCH_DIAGNOSTIC_TEXT_LIMIT - 3).trimEnd()}...`
    : redacted;
}

export function boundLaunchDiagnostics(
  items: readonly TeamLaunchDiagnosticItem[] | undefined,
  maxItems: number = PROGRESS_LAUNCH_DIAGNOSTICS_LIMIT
): TeamLaunchDiagnosticItem[] | undefined {
  if (!items || items.length === 0) {
    return undefined;
  }

  const bounded = items.slice(0, Math.max(1, maxItems)).map((item) => ({
    ...item,
    label: boundDiagnosticText(item.label) ?? item.code,
    detail: boundDiagnosticText(item.detail),
  }));
  return bounded.length > 0 ? bounded : undefined;
}
