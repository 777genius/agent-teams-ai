import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import {
  buildRuntimeDestinationMessageId,
  createRuntimeDeliveryJournalStore,
  normalizeRuntimeDeliveryEnvelope,
  type RuntimeDeliveryDestinationRef,
  type RuntimeDeliveryEnvelope,
  type RuntimeDeliveryJournalBeginInput,
  type RuntimeDeliveryJournalStore,
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

describe('RuntimeDeliveryJournal cross-run recovery identity', () => {
  it('carries an uncommitted local destination id only within the same team and destination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-delivery-journal-'));
    const journal = createRuntimeDeliveryJournalStore({
      filePath: join(directory, 'journal.json'),
    });

    try {
      await journal.begin(
        beginInput({
          destinationMessageId: 'run-1-member-message',
        })
      );

      const recovered = await journal.begin(
        beginInput({
          runId: 'run-2',
          runtimeSessionId: 'session-2',
          payloadHash: 'sha256:run-2',
          destinationMessageId: 'run-2-member-message',
          now: '2026-01-01T00:00:01.000Z',
        })
      );
      const otherTeam = await journal.begin(
        beginInput({
          runId: 'run-2',
          teamName: 'OtherTeam',
          runtimeSessionId: 'session-other-team',
          payloadHash: 'sha256:other-team',
          destination: { kind: 'member_inbox', teamName: 'OtherTeam', memberName: 'Reviewer' },
          destinationMessageId: 'other-team-message',
          now: '2026-01-01T00:00:02.000Z',
        })
      );
      const otherMember = await journal.begin(
        beginInput({
          runId: 'run-3',
          runtimeSessionId: 'session-other-member',
          payloadHash: 'sha256:other-member',
          destination: { kind: 'member_inbox', teamName: 'Team', memberName: 'Architect' },
          destinationMessageId: 'other-member-message',
          now: '2026-01-01T00:00:03.000Z',
        })
      );
      const crossTeam = await journal.begin(
        beginInput({
          runId: 'run-4',
          runtimeSessionId: 'session-cross-team',
          payloadHash: 'sha256:cross-team',
          destination: {
            kind: 'cross_team_outbox',
            fromTeamName: 'Team',
            toTeamName: 'OtherTeam',
            toMemberName: 'Reviewer',
          },
          destinationMessageId: 'cross-team-message',
          now: '2026-01-01T00:00:04.000Z',
        })
      );

      expect(recovered.record.destinationMessageId).toBe('run-1-member-message');
      expect(otherTeam.record.destinationMessageId).toBe('other-team-message');
      expect(otherMember.record.destinationMessageId).toBe('other-member-message');
      expect(crossTeam.record.destinationMessageId).toBe('cross-team-message');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('RuntimeDeliveryJournal retention', () => {
  it('bounds terminal records without pruning recoverable cross-run history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-delivery-journal-'));
    const filePath = join(directory, 'journal.json');
    const journal = createRuntimeDeliveryJournalStore({
      filePath,
      maxTerminalRecords: 2,
    });

    try {
      await journal.begin(
        beginInput({
          idempotencyKey: 'crash-key',
          destinationMessageId: 'crash-run-1-message',
        })
      );
      await journal.begin(
        beginInput({
          idempotencyKey: 'retryable-key',
          destinationMessageId: 'retryable-message',
          now: '2026-01-01T00:00:01.000Z',
        })
      );
      await journal.markFailed({
        idempotencyKey: 'retryable-key',
        runId: 'run-1',
        teamName: 'Team',
        status: 'failed_retryable',
        error: 'temporary failure',
        updatedAt: '2026-01-01T00:00:02.000Z',
      });

      await settleRecord(journal, 'committed-old', 'committed', 3);
      await settleRecord(journal, 'terminal-old', 'failed_terminal', 5);
      await settleRecord(journal, 'committed-new', 'committed', 7);
      await settleRecord(journal, 'terminal-new', 'failed_terminal', 9);

      const relaunched = createRuntimeDeliveryJournalStore({
        filePath,
        maxTerminalRecords: 2,
      });
      const recovered = await relaunched.begin(
        beginInput({
          idempotencyKey: 'crash-key',
          runId: 'run-2',
          runtimeSessionId: 'session-2',
          payloadHash: 'sha256:crash-run-2',
          destinationMessageId: 'crash-run-2-message',
          now: '2026-01-01T00:00:11.000Z',
        })
      );
      const records = await relaunched.list();
      const terminalRecords = records.filter(
        (record) => record.status === 'committed' || record.status === 'failed_terminal'
      );

      expect(recovered.record.destinationMessageId).toBe('crash-run-1-message');
      expect(terminalRecords).toHaveLength(2);
      expect(terminalRecords).toMatchObject([
        { idempotencyKey: 'committed-new', status: 'committed' },
        { idempotencyKey: 'terminal-new', status: 'failed_terminal' },
      ]);
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ idempotencyKey: 'crash-key', status: 'pending' }),
          expect.objectContaining({ idempotencyKey: 'retryable-key', status: 'failed_retryable' }),
        ])
      );
      expect(records.some((record) => record.idempotencyKey === 'committed-old')).toBe(false);
      expect(records.some((record) => record.idempotencyKey === 'terminal-old')).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const NOW = '2026-01-01T00:00:00.000Z';

function beginInput(
  overrides: Partial<RuntimeDeliveryJournalBeginInput> = {}
): RuntimeDeliveryJournalBeginInput {
  const destination: RuntimeDeliveryDestinationRef = {
    kind: 'member_inbox',
    teamName: 'Team',
    memberName: 'Reviewer',
  };
  return {
    idempotencyKey: 'runtime-key-1',
    payloadHash: 'sha256:run-1',
    runId: 'run-1',
    teamName: 'Team',
    fromMemberName: 'Builder',
    providerId: 'opencode',
    runtimeSessionId: 'session-1',
    destination,
    destinationMessageId: 'message-1',
    now: NOW,
    ...overrides,
  };
}

async function settleRecord(
  journal: RuntimeDeliveryJournalStore,
  idempotencyKey: string,
  status: 'committed' | 'failed_terminal',
  second: number
): Promise<void> {
  const createdAt = `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;
  const settledAt = `2026-01-01T00:00:${String(second + 1).padStart(2, '0')}.000Z`;
  await journal.begin(
    beginInput({
      idempotencyKey,
      payloadHash: `sha256:${idempotencyKey}`,
      destinationMessageId: `${idempotencyKey}-message`,
      now: createdAt,
    })
  );
  if (status === 'committed') {
    await journal.markCommitted({
      idempotencyKey,
      runId: 'run-1',
      teamName: 'Team',
      location: {
        kind: 'member_inbox',
        teamName: 'Team',
        memberName: 'Reviewer',
        messageId: `${idempotencyKey}-message`,
      },
      committedAt: settledAt,
    });
    return;
  }
  await journal.markFailed({
    idempotencyKey,
    runId: 'run-1',
    teamName: 'Team',
    status,
    error: 'terminal failure',
    updatedAt: settledAt,
  });
}

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
