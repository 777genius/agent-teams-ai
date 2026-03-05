/**
 * Inbox "noise" messages are structured JSON objects that represent internal coordination
 * signals (idle/shutdown/etc.). They should not trigger user-facing notifications or
 * automatic lead relays.
 */
export const INBOX_NOISE_TYPES = [
  'idle_notification',
  'shutdown_approved',
  'teammate_terminated',
  'shutdown_request',
] as const;

const INBOX_NOISE_SET = new Set<string>(INBOX_NOISE_TYPES);

export function parseInboxJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON
  }
  return null;
}

export function getInboxJsonType(text: string): string | null {
  const parsed = parseInboxJson(text);
  if (!parsed) return null;
  return typeof parsed.type === 'string' ? parsed.type : null;
}

export function isInboxNoiseMessage(text: string): boolean {
  const type = getInboxJsonType(text);
  return !!type && INBOX_NOISE_SET.has(type);
}
