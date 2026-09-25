import { serializeChipsWithText } from '@renderer/types/inlineChip';
import {
  composerDraftAddressKey,
  describeComposerDraftTarget,
} from '@renderer/utils/composerDraftIdentity';

import type {
  ComposerDraftAddress,
  ComposerPersistenceStatus,
  ComposerRecoveryRecord,
  ComposerWorkingRecord,
  ComposerWorkingSummary,
} from '@renderer/types/composerDraft';
import type { AttachmentPayload, InboxMessage } from '@shared/types';

export type ComposerOutboxStatus =
  | 'sending'
  | 'syncing'
  | 'delivery-unknown'
  | 'not-sent'
  | 'recovered-draft';

export type ComposerOutboxSource =
  | { readonly kind: 'recovery'; readonly recoveryId: string }
  | { readonly kind: 'working'; readonly summary: ComposerWorkingSummary };

export interface ComposerOutboxItem {
  readonly id: string;
  readonly source: ComposerOutboxSource;
  readonly address: ComposerDraftAddress | null;
  readonly status: ComposerOutboxStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageId?: string;
  readonly displayText: string;
  readonly attachments: readonly AttachmentPayload[];
  readonly attachmentCount: number;
  readonly chipCount: number;
  readonly sourceLabel?: string;
  readonly duplicateRisk: boolean;
  readonly persistenceStatus: ComposerPersistenceStatus;
}

function preparedSummary(record: ComposerRecoveryRecord): string {
  const request = record.preparedRequest?.request;
  return request?.summary?.trim() ?? '';
}

export function composerRecoveryDisplayText(record: ComposerRecoveryRecord): string {
  return (
    preparedSummary(record) ||
    serializeChipsWithText(record.snapshot.content.text, record.snapshot.content.chips).trim()
  );
}

export function composerOutboxStatus(
  record: ComposerRecoveryRecord,
  attemptActive: boolean
): ComposerOutboxStatus {
  switch (record.reason) {
    case 'pending-send':
      return attemptActive ? 'sending' : 'delivery-unknown';
    case 'accepted-awaiting-echo':
      return 'syncing';
    case 'unconfirmed-send':
      return 'delivery-unknown';
    case 'not-sent':
      return 'not-sent';
    case 'displaced-draft':
    case 'legacy-draft':
      return 'recovered-draft';
  }
}

export function composerOutboxItemFromRecovery(
  record: ComposerRecoveryRecord,
  attemptActive: boolean,
  persistenceStatus: ComposerPersistenceStatus
): ComposerOutboxItem {
  const outcome = record.outcome;
  return {
    id: `recovery:${record.id}`,
    source: { kind: 'recovery', recoveryId: record.id },
    address: record.address,
    status: composerOutboxStatus(record, attemptActive),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(outcome?.kind !== 'not-sent' && outcome?.messageId ? { messageId: outcome.messageId } : {}),
    displayText: composerRecoveryDisplayText(record),
    attachments: record.snapshot.content.attachments,
    attachmentCount: record.snapshot.content.attachments.length,
    chipCount: record.snapshot.content.chips.length,
    ...(record.address ? { sourceLabel: describeComposerDraftTarget(record.address.target) } : {}),
    duplicateRisk: record.reason === 'pending-send' || record.reason === 'unconfirmed-send',
    persistenceStatus,
  };
}

export function composerOutboxItemFromUnavailableWorking(
  working: ComposerWorkingRecord,
  summary: ComposerWorkingSummary,
  persistenceStatus: ComposerPersistenceStatus
): ComposerOutboxItem | null {
  if (!working.content) return null;
  return {
    id: `working:${composerDraftAddressKey(summary.address)}:${summary.workingRevision}`,
    source: { kind: 'working', summary },
    address: summary.address,
    status: 'recovered-draft',
    createdAt: summary.updatedAt,
    updatedAt: summary.updatedAt,
    displayText: serializeChipsWithText(working.content.text, working.content.chips).trim(),
    attachments: working.content.attachments,
    attachmentCount: working.content.attachments.length,
    chipCount: working.content.chips.length,
    sourceLabel: describeComposerDraftTarget(summary.address.target),
    duplicateRisk: false,
    persistenceStatus,
  };
}

export function canonicalComposerOutboxReconciliations(
  items: readonly ComposerOutboxItem[],
  messages: readonly InboxMessage[]
): Array<Readonly<{ recoveryId: string; messageId: string }>> {
  const canonicalIds = new Set(
    messages
      .map((message) => message.messageId?.trim())
      .filter((messageId): messageId is string => Boolean(messageId))
  );
  return items.flatMap((item) => {
    if (
      item.source.kind !== 'recovery' ||
      !item.messageId ||
      !canonicalIds.has(item.messageId) ||
      item.status !== 'syncing'
    ) {
      return [];
    }
    return [{ recoveryId: item.source.recoveryId, messageId: item.messageId }];
  });
}
