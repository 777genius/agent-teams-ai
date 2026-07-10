import { describe, expect, it, vi } from 'vitest';

import {
  type RuntimeDeliveryDestinationPort,
  RuntimeDeliveryDestinationRegistry,
  type RuntimeDeliveryDiagnosticsSink,
  type RuntimeDeliveryRunStateReader,
  RuntimeDeliveryService,
  type RuntimeDeliveryVerifyResult,
} from '../RuntimeDeliveryService';

import type {
  RuntimeDeliveryDestinationRef,
  RuntimeDeliveryEnvelope,
  RuntimeDeliveryJournalBeginInput,
  RuntimeDeliveryJournalBeginResult,
  RuntimeDeliveryJournalRecord,
  RuntimeDeliveryJournalStore,
  RuntimeDeliveryLocation,
} from '../RuntimeDeliveryJournal';

const NOW = '2026-01-01T00:00:00.000Z';

describe('RuntimeDeliveryService stale run guard', () => {
  const staleWriteScenarios: Array<{
    name: string;
    kind: RuntimeDeliveryDestinationRef['kind'];
    to: RuntimeDeliveryEnvelope['to'];
    location: RuntimeDeliveryLocation;
  }> = [
    {
      name: 'user sent messages',
      kind: 'user_sent_messages',
      to: 'user',
      location: { kind: 'user_sent_messages', teamName: 'Team', messageId: 'message-1' },
    },
    {
      name: 'member inbox',
      kind: 'member_inbox',
      to: { memberName: 'Reviewer' },
      location: {
        kind: 'member_inbox',
        teamName: 'Team',
        memberName: 'Reviewer',
        messageId: 'message-1',
      },
    },
    {
      name: 'cross-team outbox',
      kind: 'cross_team_outbox',
      to: { teamName: 'OtherTeam', memberName: 'Reviewer' },
      location: {
        kind: 'cross_team_outbox',
        fromTeamName: 'Team',
        toTeamName: 'OtherTeam',
        toMemberName: 'Reviewer',
        messageId: 'message-1',
      },
    },
  ];

  for (const scenario of staleWriteScenarios) {
    it(`skips ${scenario.name} writes when the run changes after journal acceptance`, async () => {
      const { runState, getCurrentRunId } = createRunState(['run-1', 'run-2']);
      const journal = createJournal();
      const destination = createDestinationPort(scenario.kind, scenario.location);
      const service = createService({
        runState,
        journal: journal.store,
        port: destination.port,
      });

      const ack = await service.deliver(envelope({ to: scenario.to }));

      expect(ack).toEqual({
        ok: false,
        delivered: false,
        reason: 'stale_run',
        idempotencyKey: 'runtime-key-1',
      });
      expect(getCurrentRunId).toHaveBeenCalledTimes(2);
      expect(journal.begin).toHaveBeenCalledOnce();
      expect(journal.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: 'runtime-key-1',
          runId: 'run-1',
          teamName: 'Team',
          status: 'failed_terminal',
          error: 'stale_run',
        })
      );
      expect(destination.verify).not.toHaveBeenCalled();
      expect(destination.write).not.toHaveBeenCalled();
      expect(journal.markCommitted).not.toHaveBeenCalled();
    });
  }

  it('does not commit a duplicate destination when the run changes after destination verify', async () => {
    const location: RuntimeDeliveryLocation = {
      kind: 'member_inbox',
      teamName: 'Team',
      memberName: 'Reviewer',
      messageId: 'message-1',
    };
    const { runState } = createRunState(['run-1', 'run-1', 'run-2']);
    const journal = createJournal();
    const destination = createDestinationPort('member_inbox', location, {
      found: true,
      location,
      diagnostics: [],
    });
    const service = createService({
      runState,
      journal: journal.store,
      port: destination.port,
    });

    const ack = await service.deliver(envelope({ to: { memberName: 'Reviewer' } }));

    expect(ack).toEqual({
      ok: false,
      delivered: false,
      reason: 'stale_run',
      idempotencyKey: 'runtime-key-1',
    });
    expect(destination.verify).toHaveBeenCalledOnce();
    expect(destination.write).not.toHaveBeenCalled();
    expect(journal.markCommitted).not.toHaveBeenCalled();
    expect(journal.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed_terminal',
        error: 'stale_run',
      })
    );
  });

  it('does not mark committed or emit after a destination write if the run changed before commit', async () => {
    const location: RuntimeDeliveryLocation = {
      kind: 'user_sent_messages',
      teamName: 'Team',
      messageId: 'message-1',
    };
    const { runState } = createRunState(['run-1', 'run-1', 'run-1', 'run-2']);
    const journal = createJournal();
    const destination = createDestinationPort('user_sent_messages', location, {
      found: false,
      location: null,
      diagnostics: [],
    });
    destination.verify
      .mockResolvedValueOnce({ found: false, location: null, diagnostics: [] })
      .mockResolvedValueOnce({ found: true, location, diagnostics: [] });
    const emit = vi.fn();
    const service = createService({
      runState,
      journal: journal.store,
      port: destination.port,
      emit,
    });

    const ack = await service.deliver(envelope({ to: 'user' }));

    expect(ack).toEqual({
      ok: false,
      delivered: false,
      reason: 'stale_run',
      idempotencyKey: 'runtime-key-1',
    });
    expect(destination.write).toHaveBeenCalledOnce();
    expect(journal.markCommitted).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(journal.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed_terminal',
        error: 'stale_run',
      })
    );
  });

  it('does not publish retryable failure diagnostics when a destination failure races with a stale run', async () => {
    const location: RuntimeDeliveryLocation = {
      kind: 'member_inbox',
      teamName: 'Team',
      memberName: 'Reviewer',
      messageId: 'message-1',
    };
    const { runState } = createRunState(['run-1', 'run-1', 'run-1', 'run-2']);
    const journal = createJournal();
    const destination = createDestinationPort('member_inbox', location);
    const diagnostics: RuntimeDeliveryDiagnosticsSink = {
      append: vi.fn(async () => {}),
    };
    destination.write.mockRejectedValueOnce(new Error('destination unavailable'));
    const service = createService({
      runState,
      journal: journal.store,
      port: destination.port,
      diagnostics,
    });

    const ack = await service.deliver(envelope({ to: { memberName: 'Reviewer' } }));

    expect(ack).toEqual({
      ok: false,
      delivered: false,
      reason: 'stale_run',
      idempotencyKey: 'runtime-key-1',
    });
    expect(destination.write).toHaveBeenCalledOnce();
    expect(journal.markCommitted).not.toHaveBeenCalled();
    expect(journal.markFailed).toHaveBeenCalledTimes(1);
    expect(journal.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed_terminal',
        error: 'stale_run',
      })
    );
    expect(journal.markFailed).not.toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed_retryable',
      })
    );
    expect(diagnostics.append).not.toHaveBeenCalled();
  });

  it('preserves retryable failure semantics while the run remains current', async () => {
    const location: RuntimeDeliveryLocation = {
      kind: 'member_inbox',
      teamName: 'Team',
      memberName: 'Reviewer',
      messageId: 'message-1',
    };
    const { runState } = createRunState(['run-1']);
    const journal = createJournal();
    const destination = createDestinationPort('member_inbox', location);
    const diagnostics: RuntimeDeliveryDiagnosticsSink = {
      append: vi.fn(async () => {}),
    };
    destination.write.mockRejectedValueOnce(new Error('destination unavailable'));
    const service = createService({
      runState,
      journal: journal.store,
      port: destination.port,
      diagnostics,
    });

    await expect(service.deliver(envelope({ to: { memberName: 'Reviewer' } }))).rejects.toThrow(
      'destination unavailable'
    );

    expect(destination.write).toHaveBeenCalledOnce();
    expect(journal.markCommitted).not.toHaveBeenCalled();
    expect(journal.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed_retryable',
        error: 'destination unavailable',
      })
    );
    expect(diagnostics.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'runtime_delivery_failed',
        severity: 'warning',
      })
    );
  });

  it('marks an existing recoverable payload-conflict journal terminal when the run is stale', async () => {
    const { runState } = createRunState(['run-1', 'run-2']);
    const journal = createJournal({
      begin: (input) => ({
        state: 'payload_conflict',
        record: {
          ...recordFromBegin(input),
          payloadHash: 'sha256:existing-payload',
          status: 'pending',
        },
      }),
    });
    const location: RuntimeDeliveryLocation = {
      kind: 'user_sent_messages',
      teamName: 'Team',
      messageId: 'message-1',
    };
    const destination = createDestinationPort('user_sent_messages', location);
    const diagnostics: RuntimeDeliveryDiagnosticsSink = {
      append: vi.fn(async () => {}),
    };
    const service = createService({
      runState,
      journal: journal.store,
      port: destination.port,
      diagnostics,
    });

    const ack = await service.deliver(envelope({ to: 'user' }));

    expect(ack).toEqual({
      ok: false,
      delivered: false,
      reason: 'stale_run',
      idempotencyKey: 'runtime-key-1',
    });
    expect(journal.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed_terminal',
        error: 'stale_run',
      })
    );
    expect(diagnostics.append).not.toHaveBeenCalled();
    expect(destination.verify).not.toHaveBeenCalled();
    expect(journal.markCommitted).not.toHaveBeenCalled();
  });
});

function createService(input: {
  runState: RuntimeDeliveryRunStateReader;
  journal: RuntimeDeliveryJournalStore;
  port: RuntimeDeliveryDestinationPort;
  diagnostics?: RuntimeDeliveryDiagnosticsSink;
  emit?: (event: { type: string; teamName: string; data?: Record<string, unknown> }) => void;
}): RuntimeDeliveryService {
  return new RuntimeDeliveryService(
    input.runState,
    input.journal,
    new RuntimeDeliveryDestinationRegistry([input.port]),
    input.diagnostics ?? { append: vi.fn(async () => {}) },
    { emit: input.emit ?? vi.fn() },
    () => new Date(NOW)
  );
}

function createRunState(runIds: Array<string | null>): {
  runState: RuntimeDeliveryRunStateReader;
  getCurrentRunId: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const getCurrentRunId = vi.fn(async () => {
    const runId = runIds[Math.min(index, runIds.length - 1)];
    index += 1;
    return runId;
  });
  return { runState: { getCurrentRunId }, getCurrentRunId };
}

function createDestinationPort(
  kind: RuntimeDeliveryDestinationRef['kind'],
  location: RuntimeDeliveryLocation,
  verifyResult: RuntimeDeliveryVerifyResult = { found: false, location: null, diagnostics: [] }
): {
  port: RuntimeDeliveryDestinationPort;
  write: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
} {
  const write = vi.fn(async () => location);
  const verify = vi.fn(async () => verifyResult);
  return {
    port: {
      kind,
      write,
      verify,
      buildChangeEvent: ({ teamName }) => ({
        type: 'runtime-delivery-test',
        teamName,
      }),
    },
    write,
    verify,
  };
}

function createJournal(
  options: {
    begin?: (
      input: RuntimeDeliveryJournalBeginInput
    ) => Promise<RuntimeDeliveryJournalBeginResult> | RuntimeDeliveryJournalBeginResult;
  } = {}
): {
  store: RuntimeDeliveryJournalStore;
  begin: ReturnType<typeof vi.fn>;
  markCommitted: ReturnType<typeof vi.fn>;
  markFailed: ReturnType<typeof vi.fn>;
} {
  const begin = vi.fn(
    async (input: RuntimeDeliveryJournalBeginInput): Promise<RuntimeDeliveryJournalBeginResult> =>
      options.begin?.(input) ?? {
        state: 'new',
        record: recordFromBegin(input),
      }
  );
  const markCommitted = vi.fn(async () => {});
  const markFailed = vi.fn(async () => {});
  return {
    store: {
      begin,
      markCommitted,
      markFailed,
    } as unknown as RuntimeDeliveryJournalStore,
    begin,
    markCommitted,
    markFailed,
  };
}

function recordFromBegin(input: RuntimeDeliveryJournalBeginInput): RuntimeDeliveryJournalRecord {
  return {
    idempotencyKey: input.idempotencyKey,
    runId: input.runId,
    teamName: input.teamName,
    fromMemberName: input.fromMemberName,
    providerId: input.providerId,
    runtimeSessionId: input.runtimeSessionId,
    payloadHash: input.payloadHash,
    destination: input.destination,
    destinationMessageId: input.destinationMessageId,
    committedLocation: null,
    status: 'pending',
    attempts: 1,
    createdAt: input.now,
    updatedAt: input.now,
    committedAt: null,
    lastError: null,
  };
}

function envelope(overrides: Partial<RuntimeDeliveryEnvelope> = {}): RuntimeDeliveryEnvelope {
  return {
    idempotencyKey: 'runtime-key-1',
    runId: 'run-1',
    teamName: 'Team',
    fromMemberName: 'Builder',
    providerId: 'opencode',
    runtimeSessionId: 'session-1',
    to: 'user',
    text: 'Delivered text',
    createdAt: NOW,
    ...overrides,
  };
}
