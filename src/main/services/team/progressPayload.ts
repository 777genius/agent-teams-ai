/**
 * Helpers that shape provisioning progress payloads before they are emitted
 * to the renderer over IPC.
 *
 * Rationale: the renderer only renders a small "tail" preview of CLI logs
 * and assistant output in ProvisioningProgressBlock / CliLogsRichView. Sending
 * the full accumulated history on every throttled progress tick (about every
 * second under load) serialized a multi-megabyte string over IPC and forced
 * Zustand to produce a new immutable state object, which triggered renderer
 * V8 OOM crashes for users with long-running teams. These helpers keep the
 * hot emission path bounded. The retained in-process diagnostics are bounded
 * separately so failed launch attempts cannot pin unbounded logs in memory.
 */

import type { TeamLaunchDiagnosticItem } from '@shared/types';

export const PROGRESS_LOG_TAIL_LINES = 200;
export const PROGRESS_OUTPUT_TAIL_PARTS = 20;
export const PROGRESS_TRACE_TAIL_LINES = 120;
export const PROGRESS_LAUNCH_DIAGNOSTICS_LIMIT = 20;
export const PROGRESS_RETAINED_LOG_LINES = 2_000;
export const PROGRESS_RETAINED_LOG_CHARS = 1_000_000;
export const PROGRESS_RETAINED_LOG_LINE_CHARS = 16_384;
export const PROGRESS_RETAINED_OUTPUT_PARTS = 200;
export const PROGRESS_RETAINED_OUTPUT_CHARS = 512_000;
export const PROGRESS_RETAINED_OUTPUT_PART_CHARS = 16_384;
const PROGRESS_LAUNCH_DIAGNOSTIC_TEXT_LIMIT = 500;
const PROGRESS_TRACE_TEXT_LIMIT = 800;
const PROVIDER_API_KEY_FLAG_PATTERN =
  /(--(?:openai|codex|anthropic)[-_]api[-_]key(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_FLAG_PATTERN =
  /(--(?:api[-_]key|token|password|secret|authorization|auth[-_]token)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_ENV_ASSIGNMENT_PATTERN =
  /\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)[A-Z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi;
const AUTH_HEADER_PATTERN = /\b(Authorization\s*:\s*)(Bearer\s+)?("[^"]*"|'[^']*'|\S+)/gi;

function truncateRetainedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const marker = '\n...[truncated]';
  if (maxChars <= marker.length) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - marker.length)}${marker}`;
}

function boundRetainedStrings(
  values: readonly string[],
  options: {
    maxItems: number;
    maxTotalChars: number;
    maxItemChars: number;
  }
): string[] {
  if (values.length === 0) {
    return [];
  }

  const maxItems = Math.max(1, Math.floor(options.maxItems));
  const maxTotalChars = Math.max(1, Math.floor(options.maxTotalChars));
  const maxItemChars = Math.max(1, Math.floor(options.maxItemChars));
  const itemTail = values.length > maxItems ? values.slice(-maxItems) : [...values];
  const truncatedTail = itemTail.map((value) => truncateRetainedText(value, maxItemChars));

  const retained: string[] = [];
  let totalChars = 0;
  for (let index = truncatedTail.length - 1; index >= 0; index -= 1) {
    const value = truncatedTail[index] ?? '';
    const nextTotal = totalChars + value.length;
    if (retained.length > 0 && nextTotal > maxTotalChars) {
      break;
    }
    if (nextTotal > maxTotalChars) {
      retained.push(truncateRetainedText(value, maxTotalChars));
      break;
    }
    retained.push(value);
    totalChars = nextTotal;
  }

  return retained.reverse();
}

export function boundProgressLogLines(
  lines: readonly string[],
  options?: {
    maxLines?: number;
    maxTotalChars?: number;
    maxLineChars?: number;
  }
): string[] {
  return boundRetainedStrings(lines, {
    maxItems: options?.maxLines ?? PROGRESS_RETAINED_LOG_LINES,
    maxTotalChars: options?.maxTotalChars ?? PROGRESS_RETAINED_LOG_CHARS,
    maxItemChars: options?.maxLineChars ?? PROGRESS_RETAINED_LOG_LINE_CHARS,
  });
}

export function boundProgressAssistantParts(
  parts: readonly string[],
  options?: {
    maxParts?: number;
    maxTotalChars?: number;
    maxPartChars?: number;
  }
): string[] {
  return boundRetainedStrings(parts, {
    maxItems: options?.maxParts ?? PROGRESS_RETAINED_OUTPUT_PARTS,
    maxTotalChars: options?.maxTotalChars ?? PROGRESS_RETAINED_OUTPUT_CHARS,
    maxItemChars: options?.maxPartChars ?? PROGRESS_RETAINED_OUTPUT_PART_CHARS,
  });
}

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

function boundRedactedText(
  value: string | undefined,
  limit: number,
  whitespace: 'collapse' | 'preserve'
): string | undefined {
  const prepared = whitespace === 'collapse' ? value?.replace(/\s+/g, ' ').trim() : value?.trim();
  if (!prepared) {
    return undefined;
  }
  const redacted = prepared
    .replace(PROVIDER_API_KEY_FLAG_PATTERN, '$1[redacted]')
    .replace(SECRET_FLAG_PATTERN, '$1[redacted]')
    .replace(SECRET_ENV_ASSIGNMENT_PATTERN, '$1[redacted]')
    .replace(AUTH_HEADER_PATTERN, '$1$2[redacted]')
    .replace(/```/g, "'''");
  return redacted.length > limit ? `${redacted.slice(0, limit - 3).trimEnd()}...` : redacted;
}

function boundDiagnosticText(value: string | undefined): string | undefined {
  return boundRedactedText(value, PROGRESS_LAUNCH_DIAGNOSTIC_TEXT_LIMIT, 'collapse');
}

export function buildProgressTraceLine(input: {
  timestamp: string;
  state: string;
  message: string;
  detail?: string;
}): string {
  const message = boundRedactedText(input.message, PROGRESS_TRACE_TEXT_LIMIT, 'collapse') ?? '';
  const detail = boundRedactedText(input.detail, PROGRESS_TRACE_TEXT_LIMIT, 'collapse');
  return detail
    ? `${input.timestamp} [${input.state}] ${message} - ${detail}`
    : `${input.timestamp} [${input.state}] ${message}`;
}

export function buildProgressTraceTail(
  lines: readonly string[],
  maxLines: number = PROGRESS_TRACE_TAIL_LINES
): string | undefined {
  return buildProgressLogsTail(lines, maxLines);
}

export function buildProgressLiveOutput(
  traceLines: readonly string[],
  assistantParts: readonly string[],
  options?: {
    maxTraceLines?: number;
    maxAssistantParts?: number;
  }
): string | undefined {
  const trace = buildProgressTraceTail(traceLines, options?.maxTraceLines);
  const assistant = buildProgressAssistantOutput(assistantParts, options?.maxAssistantParts);
  if (!trace) {
    return assistant;
  }
  const traceBlock = `**Launch trace**\n\n\`\`\`text\n${trace}\n\`\`\``;
  if (!assistant) {
    return traceBlock;
  }
  return `${traceBlock}\n\n**Runtime output**\n\n${assistant}`;
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
