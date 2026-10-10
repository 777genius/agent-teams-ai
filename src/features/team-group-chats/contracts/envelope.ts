import type { GroupDeliverySummary } from './api';

export interface GroupChatEnvelope {
  groupChatId?: string;
  groupChatName?: string;
  groupMessageId?: string;
  groupChatProtocolVersion?: 1;
  /** Actual runtime identity allowed to consume this physical row. */
  groupRunKey?: string;
  groupRecipientNames?: string[];
  groupRecipientRunKeys?: Record<string, string>;
  groupDeliverySummary?: GroupDeliverySummary;
  groupHandoffStartedAt?: string;
}

export const GROUP_CHAT_CHANNELS = {
  list: 'team-group-chats:list',
  create: 'team-group-chats:create',
  setArchived: 'team-group-chats:set-archived',
  send: 'team-group-chats:send',
} as const;

const GROUP_PROTOCOL_FIELDS = [
  'groupChatId',
  'groupChatName',
  'groupMessageId',
  'groupChatProtocolVersion',
  'groupRunKey',
  'groupRecipientNames',
  'groupRecipientRunKeys',
  'groupDeliverySummary',
  'groupHandoffStartedAt',
] as const;

/** Known group fields reserve the row for the group consumer, including partial envelopes. */
export function hasGroupChatEnvelopeMarker(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    GROUP_PROTOCOL_FIELDS.some((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

/** Preserve marker presence through normalization without inventing fields on ordinary DMs. */
export function copyGroupChatEnvelope(row: GroupChatEnvelope): GroupChatEnvelope {
  return Object.fromEntries(
    GROUP_PROTOCOL_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(row, key)).map(
      (key) => [key, row[key]]
    )
  ) as GroupChatEnvelope;
}

/** Check raw rows before any normalizer can discard malformed group messages. */
export function assertValidGroupInboxRows(rows: unknown): asserts rows is unknown[] {
  if (!Array.isArray(rows)) throw new Error('Inbox storage unavailable: expected array');
  const canonicalIds = new Set<string>();
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (!hasGroupChatEnvelopeMarker(row)) continue;
    if (
      typeof row.groupChatId !== 'string' ||
      !row.groupChatId ||
      typeof row.groupMessageId !== 'string' ||
      !row.groupMessageId ||
      typeof row.messageId !== 'string' ||
      !row.messageId ||
      row.groupChatProtocolVersion !== 1 ||
      typeof row.from !== 'string' ||
      typeof row.text !== 'string' ||
      typeof row.timestamp !== 'string' ||
      typeof row.read !== 'boolean' ||
      !Number.isFinite(Date.parse(row.timestamp))
    )
      throw new Error('Inbox storage unavailable: malformed group envelope');
    if (row.groupMessageId === row.messageId) {
      if (row.to !== 'user' || canonicalIds.has(row.messageId))
        throw new Error('Inbox storage unavailable: duplicate or misplaced canonical group row');
      if (
        !Array.isArray(row.groupRecipientNames) ||
        row.groupRecipientNames.some((name) => typeof name !== 'string' || !name) ||
        new Set(row.groupRecipientNames).size !== row.groupRecipientNames.length ||
        !row.groupRecipientRunKeys ||
        typeof row.groupRecipientRunKeys !== 'object' ||
        Array.isArray(row.groupRecipientRunKeys) ||
        row.groupRecipientNames.some(
          (name) =>
            typeof (row.groupRecipientRunKeys as Record<string, unknown>)[name as string] !==
              'string' || !(row.groupRecipientRunKeys as Record<string, unknown>)[name as string]
        )
      )
        throw new Error('Inbox storage unavailable: invalid frozen recipients');
      canonicalIds.add(row.messageId);
    } else if (
      typeof row.to !== 'string' ||
      typeof row.groupRunKey !== 'string' ||
      !row.groupRunKey
    ) {
      throw new Error('Inbox storage unavailable: invalid group physical destination');
    }
    if (row.groupChatName !== undefined && typeof row.groupChatName !== 'string')
      throw new Error('Inbox storage unavailable: invalid group name');
    if (row.groupDeliverySummary !== undefined) {
      const summary = row.groupDeliverySummary as { recordedAt?: unknown; recipients?: unknown };
      if (
        !summary ||
        typeof summary.recordedAt !== 'string' ||
        !Number.isFinite(Date.parse(summary.recordedAt)) ||
        !Array.isArray(summary.recipients)
      )
        throw new Error('Inbox storage unavailable: invalid delivery summary');
      const seen = new Set<string>();
      for (const entry of summary.recipients) {
        if (!entry || typeof entry !== 'object')
          throw new Error('Inbox storage unavailable: invalid delivery outcome');
        const outcome = entry as Record<string, unknown>;
        if (
          typeof outcome.memberName !== 'string' ||
          typeof outcome.physicalMessageId !== 'string' ||
          !['queued', 'accepted', 'failed', 'unknown', 'skipped'].includes(
            String(outcome.status)
          ) ||
          seen.has(outcome.memberName) ||
          (outcome.reason !== undefined && typeof outcome.reason !== 'string')
        )
          throw new Error('Inbox storage unavailable: invalid delivery outcome');
        seen.add(outcome.memberName);
      }
    }
    if (row.groupHandoffStartedAt !== undefined && typeof row.groupHandoffStartedAt !== 'string')
      throw new Error('Inbox storage unavailable: invalid handoff marker');
  }
}
