import { getEffectiveInboxMessageId } from './inboxMessageIdentity.js';
export interface QueuedUserMessageSummary { messageId: string; text: string; timestamp: string; summary?: string }

/**
 * A queued user message is an inbox row the runtime has not consumed yet:
 * `read: false` and `from: "user"`. Delivered messages (read: true) and
 * agent-to-agent messages must never be touched by discard operations.
 */
export function isQueuedUserInboxRow(row: unknown): boolean {
  if (!row || typeof row !== 'object') {
    return false;
  }
  const record = row as Record<string, unknown>;
  return (
    record.read === false &&
    typeof record.from === 'string' &&
    record.from.trim().toLowerCase() === 'user'
  );
}

export function listQueuedUserMessagesFromRows(
  rows: readonly unknown[]
): QueuedUserMessageSummary[] {
  const queued: QueuedUserMessageSummary[] = [];
  for (const row of rows) {
    if (!isQueuedUserInboxRow(row)) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const messageId = getEffectiveInboxMessageId(record);
    if (!messageId) {
      continue;
    }
    queued.push({
      messageId,
      text: typeof record.text === 'string' ? record.text : '',
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : '',
      ...(typeof record.summary === 'string' && record.summary.trim()
        ? { summary: record.summary }
        : {}),
    });
  }
  return queued;
}

/**
 * Removes exactly the queued user rows named by `messageIds`.
 *
 * The ids are the ones the caller listed and had confirmed, so a queued row
 * that reached the inbox after that listing is not named and survives. There is
 * deliberately no "discard everything" form: it would delete rows nobody was
 * shown. Ids that no longer match a row are ignored - the runtime consuming a
 * message first is a normal race, not a failure.
 */
export function discardQueuedUserMessagesFromRows(
  rows: readonly unknown[],
  messageIds: readonly string[]
): { kept: unknown[]; discarded: number } {
  const targeted = new Set(messageIds);
  const kept: unknown[] = [];
  let discarded = 0;
  for (const row of rows) {
    if (isQueuedUserInboxRow(row)) {
      const rowMessageId = getEffectiveInboxMessageId(row as Record<string, unknown>);
      if (rowMessageId !== null && targeted.has(rowMessageId)) {
        discarded += 1;
        continue;
      }
    }
    kept.push(row);
  }
  return { kept, discarded };
}
