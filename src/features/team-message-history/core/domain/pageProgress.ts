import type { InboxMessageCursor, PageProgressOutcome, RawMessageWindow } from '../../contracts';
import type { InboxMessage } from '@shared/types';

export function validMessagePosition(message: InboxMessage): boolean {
  return (
    Number.isFinite(Date.parse(message.timestamp)) &&
    typeof message.messageId === 'string' &&
    message.messageId.trim().length > 0
  );
}

export function compareNewestFirst(left: InboxMessage, right: InboxMessage): number {
  return (
    Date.parse(right.timestamp) - Date.parse(left.timestamp) ||
    (left.messageId ?? '').localeCompare(right.messageId ?? '')
  );
}

export function isMessageAfterCursor(
  message: InboxMessage,
  cursor: InboxMessageCursor | null
): boolean {
  if (!cursor) return true;
  const time = Date.parse(message.timestamp);
  return (
    time < cursor.timestampMs ||
    (time === cursor.timestampMs && (message.messageId ?? '').localeCompare(cursor.messageId) > 0)
  );
}

export function parseHistoryCursor(
  value: string | null | undefined
):
  | { kind: 'cursor'; cursor: InboxMessageCursor | null }
  | { kind: 'invalid-request'; reason: 'invalid_cursor' } {
  if (value == null) return { kind: 'cursor', cursor: null };
  const separator = value.indexOf('|');
  const timestampMs = Date.parse(value.slice(0, separator));
  const messageId = value.slice(separator + 1);
  if (separator < 1 || !Number.isFinite(timestampMs) || !messageId.trim()) {
    return { kind: 'invalid-request', reason: 'invalid_cursor' };
  }
  return { kind: 'cursor', cursor: { timestampMs, messageId } };
}

export function provenPagePrefix(windows: readonly RawMessageWindow[]): PageProgressOutcome {
  let frontier: InboxMessage | undefined;
  const sourceTruncated = windows.some((window) => window.truncated);
  for (const window of windows) {
    if (window.messages.some((message) => !validMessagePosition(message))) {
      return { kind: 'unavailable', reason: 'invalid_message' };
    }
    if (!window.truncated) continue;
    if (!window.messages.length) return { kind: 'busy', reason: 'no_progress' };
    const oldest = window.messages.reduce((a, b) => (compareNewestFirst(a, b) > 0 ? a : b));
    if (!frontier || compareNewestFirst(oldest, frontier) < 0) frontier = oldest;
  }
  return {
    kind: 'prefix',
    sourceTruncated,
    messages: windows
      .flatMap((window) => window.messages)
      .filter((message) => !frontier || compareNewestFirst(message, frontier) <= 0),
  };
}
