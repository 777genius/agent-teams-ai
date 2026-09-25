import { describe, expect, it } from 'vitest';

import {
  canonicalComposerOutboxReconciliations,
  composerOutboxItemFromRecovery,
  composerOutboxStatus,
  composerRecoveryDisplayText,
} from './composerOutbox';

import type { ComposerRecoveryRecord } from '@renderer/types/composerDraft';
import type { InboxMessage } from '@shared/types';

const address = {
  contextId: 'context-a',
  teamName: 'team-a',
  target: { kind: 'direct' as const, participant: 'alice' },
};

function recovery(
  reason: ComposerRecoveryRecord['reason'],
  outcome?: ComposerRecoveryRecord['outcome']
): ComposerRecoveryRecord {
  return {
    version: 2,
    id: `recovery-${reason}`,
    address,
    snapshot: {
      content: { text: 'visible body', chips: [], attachments: [], actionMode: 'do' },
      editorContext: { kind: 'plain' },
    },
    preparedRequest: {
      kind: 'local',
      teamName: 'team-a',
      request: {
        member: 'alice',
        text: '<revision>raw protocol</revision>',
        summary: 'visible summary',
      },
    },
    reason,
    createdAt: 10,
    updatedAt: 20,
    ...(outcome ? { outcome } : {}),
  };
}

describe('composer outbox projection', () => {
  it.each([
    ['pending-send', true, 'sending'],
    ['pending-send', false, 'delivery-unknown'],
    ['accepted-awaiting-echo', false, 'syncing'],
    ['unconfirmed-send', false, 'delivery-unknown'],
    ['not-sent', false, 'not-sent'],
    ['displaced-draft', false, 'recovered-draft'],
    ['legacy-draft', false, 'recovered-draft'],
  ] as const)('maps %s with active=%s to %s', (reason, active, expected) => {
    expect(composerOutboxStatus(recovery(reason), active)).toBe(expected);
  });

  it('shows the prepared user summary instead of raw transport wrappers', () => {
    expect(composerRecoveryDisplayText(recovery('not-sent'))).toBe('visible summary');
  });

  it('reconciles only accepted recoveries with an exact non-empty id', () => {
    const syncing = composerOutboxItemFromRecovery(
      recovery('accepted-awaiting-echo', { kind: 'accepted', messageId: 'message-1' }),
      false,
      'durable'
    );
    const failed = composerOutboxItemFromRecovery(
      recovery('not-sent', { kind: 'not-sent', detail: 'offline' }),
      false,
      'durable'
    );
    const unconfirmed = composerOutboxItemFromRecovery(
      recovery('unconfirmed-send', { kind: 'unconfirmed', messageId: 'message-1' }),
      false,
      'durable'
    );
    const sameTextWrongId = {
      messageId: 'message-2',
      text: syncing.displayText,
    } as InboxMessage;
    const exact = { messageId: 'message-1', text: 'different text is allowed' } as InboxMessage;

    expect(
      canonicalComposerOutboxReconciliations([syncing, failed, unconfirmed], [sameTextWrongId])
    ).toEqual([]);
    expect(
      canonicalComposerOutboxReconciliations(
        [syncing, failed, unconfirmed],
        [sameTextWrongId, exact]
      )
    ).toEqual([
      {
        recoveryId: syncing.source.kind === 'recovery' ? syncing.source.recoveryId : '',
        messageId: 'message-1',
      },
    ]);
  });
});
