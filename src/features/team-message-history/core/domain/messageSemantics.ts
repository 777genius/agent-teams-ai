import type { InboxMessage } from '@shared/types';

// Required keys make additions to the normalized message contract a review decision.
const semanticFields: Record<keyof InboxMessage, true> = {
  from: true,
  to: true,
  text: true,
  timestamp: true,
  read: true,
  taskRefs: true,
  actionMode: true,
  commentId: true,
  summary: true,
  color: true,
  messageId: true,
  relayOfMessageId: true,
  source: true,
  attachments: true,
  leadSessionId: true,
  conversationId: true,
  replyToConversationId: true,
  toolSummary: true,
  toolCalls: true,
  messageKind: true,
  agentError: true,
  runtimeRecovery: true,
  workSyncIntent: true,
  workSyncIntentKey: true,
  workSyncReviewRequestEventIds: true,
  workSyncRuntimeTicketId: true,
  workSyncRuntimeGeneration: true,
  workSyncRuntimeInstanceId: true,
  workSyncAdmissionPayloadHash: true,
  workSyncTeamIncarnation: true,
  workSyncControlRevision: true,
  workSyncPayloadHash: true,
  slashCommand: true,
  commandOutput: true,
};

export function canonicalSemanticValue(value: unknown): string {
  if (value == null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalSemanticValue).join(',')}]`;
  if (typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalSemanticValue(row[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function messageSemanticEntry(message: InboxMessage): string {
  return canonicalSemanticValue(
    Object.fromEntries(
      (Object.keys(semanticFields) as (keyof InboxMessage)[]).map((key) => [key, message[key]])
    )
  );
}

export interface SourceSemanticEntry {
  identity: string;
  semantic: string;
  orderSensitive: boolean;
}

export function sourceSemanticEntry(message: InboxMessage): SourceSemanticEntry {
  return {
    identity: message.messageId ?? '',
    semantic: messageSemanticEntry(message),
    // Lead-copy selection and slash/session annotation can depend on source order.
    orderSensitive:
      !!message.leadSessionId ||
      !!message.slashCommand ||
      message.source === 'lead_session' ||
      message.source === 'lead_process' ||
      (message.source === 'user_sent' && message.text.trim().startsWith('/')),
  };
}

export function orderedSourceSemantics(entries: readonly SourceSemanticEntry[]): string[] {
  if (entries.some((entry) => entry.orderSensitive)) return entries.map((entry) => entry.semantic);
  // Stable sort preserves first-winner provenance inside each conflicting identity.
  return [...entries]
    .sort((a, b) => a.identity.localeCompare(b.identity))
    .map((entry) => entry.semantic);
}
