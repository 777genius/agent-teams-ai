import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import {
  buildRuntimeDestinationMessageId,
  createRuntimeDeliveryJournalStore,
  normalizeRuntimeDeliveryEnvelope,
  type RuntimeDeliveryEnvelope,
} from '../RuntimeDeliveryJournal';

describe('RuntimeDeliveryJournal runtime identity', () => {
  it('derives destination message ids from the runtime idempotency key, not the body', () => {
    const first = envelope({
      idempotencyKey: 'runtime-key-1',
      text: 'Same body',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const retry = envelope({
      idempotencyKey: 'runtime-key-1',
      text: 'Retry body changed after the key was already recorded',
      createdAt: '2026-01-01T00:00:05.000Z',
    });
    const distinct = envelope({
      idempotencyKey: 'runtime-key-2',
      text: 'Same body',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    expect(buildRuntimeDestinationMessageId(retry)).toBe(buildRuntimeDestinationMessageId(first));
    expect(buildRuntimeDestinationMessageId(distinct)).not.toBe(
      buildRuntimeDestinationMessageId(first)
    );
  });

  it('canonicalizes idempotency keys before hashing destination message ids', () => {
    const padded = normalizeRuntimeDeliveryEnvelope(
      envelope({
        idempotencyKey: ' runtime-key-1 ',
      })
    );
    const canonical = normalizeRuntimeDeliveryEnvelope(
      envelope({
        idempotencyKey: 'runtime-key-1',
      })
    );

    expect(padded.idempotencyKey).toBe('runtime-key-1');
    expect(buildRuntimeDestinationMessageId(padded)).toBe(
      buildRuntimeDestinationMessageId(canonical)
    );
    expect(
      buildRuntimeDestinationMessageId(
        envelope({
          idempotencyKey: ' runtime-key-1 ',
        })
      )
    ).toBe(buildRuntimeDestinationMessageId(canonical));
  });
});

describe('RuntimeDeliveryJournal settlement ordering', () => {
  it('does not let a stale failure settlement regress a committed delivery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-delivery-journal-'));
    const journal = createRuntimeDeliveryJournalStore({
      filePath: join(directory, 'journal.json'),
    });

    try {
      const delivery = envelope({ to: 'user' });
      await journal.begin({
        idempotencyKey: delivery.idempotencyKey,
        payloadHash: 'sha256:payload',
        runId: delivery.runId,
        teamName: delivery.teamName,
        fromMemberName: delivery.fromMemberName,
        providerId: delivery.providerId,
        runtimeSessionId: delivery.runtimeSessionId,
        destination: { kind: 'user_sent_messages', teamName: delivery.teamName },
        destinationMessageId: 'message-1',
        now: NOW,
      });
      await journal.markCommitted({
        idempotencyKey: delivery.idempotencyKey,
        runId: delivery.runId,
        teamName: delivery.teamName,
        location: {
          kind: 'user_sent_messages',
          teamName: delivery.teamName,
          messageId: 'message-1',
        },
        committedAt: NOW,
      });

      await journal.markFailed({
        idempotencyKey: delivery.idempotencyKey,
        runId: delivery.runId,
        teamName: delivery.teamName,
        status: 'failed_retryable',
        error: 'stale delivery attempt failed after another attempt committed',
        updatedAt: '2026-01-01T00:00:01.000Z',
      });

      await expect(
        journal.get({
          idempotencyKey: delivery.idempotencyKey,
          runId: delivery.runId,
          teamName: delivery.teamName,
        })
      ).resolves.toEqual(
        expect.objectContaining({
          status: 'committed',
          committedAt: NOW,
          lastError: null,
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const NOW = '2026-01-01T00:00:00.000Z';

function envelope(overrides: Partial<RuntimeDeliveryEnvelope> = {}): RuntimeDeliveryEnvelope {
  return {
    idempotencyKey: 'runtime-key-1',
    runId: 'run-1',
    teamName: 'Team',
    fromMemberName: 'Builder',
    providerId: 'opencode',
    runtimeSessionId: 'session-1',
    to: { teamName: 'other-team', memberName: 'Reviewer' },
    text: 'Delivered text',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
