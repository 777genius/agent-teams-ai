import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOpenCodeRuntimeDeliveryPorts } from '../../../../src/main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryPorts';
import {
  buildRuntimeDestinationMessageId,
  createRuntimeDeliveryJournalStore,
  hashRuntimeDeliveryEnvelope,
  normalizeRuntimeDeliveryEnvelope,
  resolveRuntimeDeliveryDestination,
  type RuntimeDeliveryDestinationRef,
  type RuntimeDeliveryEnvelope,
  type RuntimeDeliveryLocation,
} from '../../../../src/main/services/team/opencode/delivery/RuntimeDeliveryJournal';
import {
  type RuntimeDeliveryDestinationPort,
  RuntimeDeliveryDestinationRegistry,
  type RuntimeDeliveryDiagnosticsSink,
  RuntimeDeliveryReconciler,
  type RuntimeDeliveryRunStateReader,
  RuntimeDeliveryService,
  type RuntimeDeliveryTeamChangeEmitter,
  type RuntimeDeliveryTeamChangeEvent,
  type RuntimeDeliveryVerifyResult,
} from '../../../../src/main/services/team/opencode/delivery/RuntimeDeliveryService';
import { CROSS_TEAM_SENT_SOURCE } from '../../../../src/shared/constants/crossTeam';

import type { InboxMessage } from '../../../../src/shared/types/team';

let tempDir: string;
let now: Date;
let journal: ReturnType<typeof createRuntimeDeliveryJournalStore>;
let destination: FakeDestinationPort;
let diagnostics: FakeDiagnosticsSink;
let emitter: FakeTeamChangeEmitter;
let runState: FakeRunStateReader;

describe('RuntimeDeliveryService', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-runtime-delivery-'));
    now = new Date('2026-04-21T12:00:00.000Z');
    journal = createRuntimeDeliveryJournalStore({
      filePath: path.join(tempDir, 'delivery-journal.json'),
      clock: () => now,
    });
    destination = new FakeDestinationPort('member_inbox');
    diagnostics = new FakeDiagnosticsSink();
    emitter = new FakeTeamChangeEmitter();
    runState = new FakeRunStateReader('run-1');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('does not poison idempotency when crash happens before destination write', async () => {
    destination.writeImpl = () => Promise.reject(new Error('simulated crash before write'));
    const service = createService();

    await expect(service.deliver(envelope())).rejects.toThrow('simulated crash before write');
    await expect(journal.get(journalKey())).resolves.toMatchObject({
      status: 'failed_retryable',
      attempts: 1,
    });

    destination.writeImpl = undefined;
    const retry = await service.deliver(envelope());

    expect(retry).toMatchObject({
      ok: true,
      delivered: true,
      reason: null,
    });
    await expect(journal.get(journalKey())).resolves.toMatchObject({
      status: 'committed',
      attempts: 2,
      committedLocation: expect.objectContaining({
        kind: 'member_inbox',
        memberName: 'Reviewer',
      }),
    });
    expect(destination.messages).toHaveLength(1);
  });


  it('keeps committed delivery successful when change event emission fails', async () => {
    vi.spyOn(emitter, 'emit').mockImplementation(() => {
      throw new Error('emitter unavailable after commit');
    });
    const service = createService();

    await expect(service.deliver(envelope())).resolves.toMatchObject({
      ok: true,
      delivered: true,
      reason: null,
    });

    await expect(journal.get(journalKey())).resolves.toMatchObject({
      status: 'committed',
      attempts: 1,
      committedLocation: expect.objectContaining({
        kind: 'member_inbox',
        memberName: 'Reviewer',
      }),
    });
    expect(diagnostics.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'runtime_delivery_change_emit_failed',
        severity: 'warning',
        data: expect.objectContaining({
          idempotencyKey: 'delivery-1',
          error: 'emitter unavailable after commit',
        }),
      })
    );
  });

  it('commits pending journal when destination already contains deterministic message id', async () => {
    const message = envelope();
    const destinationRef = resolveRuntimeDeliveryDestination(message);
    const destinationMessageId = buildRuntimeDestinationMessageId(message);
    await journal.begin({
      idempotencyKey: message.idempotencyKey,
      payloadHash: hashRuntimeDeliveryEnvelope(message),
      runId: message.runId,
      teamName: message.teamName,
      fromMemberName: message.fromMemberName,
      providerId: message.providerId,
      runtimeSessionId: message.runtimeSessionId,
      destination: destinationRef,
      destinationMessageId,
      now: now.toISOString(),
    });
    destination.messages.set(destinationMessageId, {
      kind: 'member_inbox',
      teamName: 'team-a',
      memberName: 'Reviewer',
      messageId: destinationMessageId,
    });

    const reconciler = new RuntimeDeliveryReconciler(
      journal,
      new RuntimeDeliveryDestinationRegistry([destination]),
      diagnostics,
      () => now
    );
    await reconciler.reconcileTeam('team-a');

    await expect(journal.get(journalKey(message))).resolves.toMatchObject({
      status: 'committed',
      committedLocation: expect.objectContaining({
        messageId: destinationMessageId,
      }),
    });
    expect(diagnostics.append).not.toHaveBeenCalled();
  });

  it('verifies the canonical location returned by destination write', async () => {
    const canonicalLocation: RuntimeDeliveryLocation = {
      kind: 'member_inbox',
      teamName: 'team-a',
      memberName: 'CanonicalReviewer',
      messageId: 'canonical-message',
    };
    destination.writeImpl = async () => {
      destination.messages.set(canonicalLocation.messageId, canonicalLocation);
      return canonicalLocation;
    };
    const service = createService();

    const ack = await service.deliver(envelope());

    expect(ack).toMatchObject({
      ok: true,
      delivered: true,
      location: canonicalLocation,
    });
    expect(destination.verifyInputs.at(-1)?.location).toEqual(canonicalLocation);
    await expect(journal.get(journalKey())).resolves.toMatchObject({
      status: 'committed',
      committedLocation: canonicalLocation,
    });
  });

  it('commits duplicate destination found without writing a second message', async () => {
    const message = envelope();
    const destinationMessageId = buildRuntimeDestinationMessageId(message);
    destination.messages.set(destinationMessageId, {
      kind: 'member_inbox',
      teamName: 'team-a',
      memberName: 'Reviewer',
      messageId: destinationMessageId,
    });
    const service = createService();

    const ack = await service.deliver(message);

    expect(ack).toMatchObject({
      ok: true,
      delivered: false,
      reason: 'duplicate_destination_found',
    });
    expect(destination.writeCalls).toBe(0);
    await expect(journal.get(journalKey(message))).resolves.toMatchObject({
      status: 'committed',
    });
  });

  it('scopes idempotency records to the current run while preserving same-run retry dedupe', async () => {
    const service = createService();

    await expect(
      service.deliver(envelope({ idempotencyKey: 'shared-delivery', runId: 'run-1' }))
    ).resolves.toMatchObject({
      ok: true,
      delivered: true,
      reason: null,
    });

    runState.currentRunId = 'run-2';
    const secondRunMessage = envelope({
      idempotencyKey: 'shared-delivery',
      runId: 'run-2',
    });
    await expect(service.deliver(secondRunMessage)).resolves.toMatchObject({
      ok: true,
      delivered: true,
      reason: null,
    });
    await expect(service.deliver(secondRunMessage)).resolves.toMatchObject({
      ok: true,
      delivered: false,
      reason: 'duplicate',
    });

    expect(destination.writeCalls).toBe(2);
    const records = await journal.list();
    const sharedRecords = records.filter((record) => record.idempotencyKey === 'shared-delivery');
    expect(sharedRecords).toMatchObject([
      { runId: 'run-1', status: 'committed' },
      { runId: 'run-2', status: 'committed' },
    ]);
    expect(new Set(sharedRecords.map((record) => record.destinationMessageId)).size).toBe(2);
  });

  it.each(['pending', 'failed_retryable'] as const)(
    'resumes pre-refactor %s journal hashed with legacy string taskRefs',
    async (status) => {
      const message = envelope();
      const legacyMessage = {
        ...message,
        taskRefs: ['task-1'],
      } as unknown as RuntimeDeliveryEnvelope;
      await journal.begin({
        idempotencyKey: message.idempotencyKey,
        payloadHash: hashRuntimeDeliveryEnvelope(legacyMessage),
        runId: message.runId,
        teamName: message.teamName,
        fromMemberName: message.fromMemberName,
        providerId: message.providerId,
        runtimeSessionId: message.runtimeSessionId,
        destination: resolveRuntimeDeliveryDestination(message),
        destinationMessageId: buildRuntimeDestinationMessageId(message),
        now: now.toISOString(),
      });
      if (status === 'failed_retryable') {
        await journal.markFailed({
          idempotencyKey: message.idempotencyKey,
          runId: message.runId,
          teamName: message.teamName,
          status,
          error: 'simulated retryable failure',
          updatedAt: now.toISOString(),
        });
      }
      const service = createService();

      await expect(service.deliver(message)).resolves.toMatchObject({
        ok: true,
        delivered: true,
        reason: null,
      });

      await expect(journal.get(journalKey(message))).resolves.toMatchObject({
        status: 'committed',
        attempts: 2,
        payloadHash: hashRuntimeDeliveryEnvelope(message),
      });
      expect(destination.messages).toHaveLength(1);
      expect(diagnostics.append).not.toHaveBeenCalled();
    }
  );

  it('rejects same idempotency key with different payload hash', async () => {
    const service = createService();
    await expect(service.deliver(envelope())).resolves.toMatchObject({
      ok: true,
      delivered: true,
    });

    await expect(
      service.deliver({
        ...envelope(),
        text: 'different text',
      })
    ).resolves.toMatchObject({
      ok: false,
      delivered: false,
      reason: 'idempotency_conflict',
    });
    expect(diagnostics.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'runtime_delivery_conflict',
        severity: 'error',
      })
    );
    expect(destination.messages).toHaveLength(1);
  });

  it('rejects stale run before journal reservation', async () => {
    runState.currentRunId = 'new-run';
    const service = createService();

    await expect(service.deliver(envelope())).resolves.toEqual({
      ok: false,
      delivered: false,
      reason: 'stale_run',
      idempotencyKey: 'delivery-1',
    });
    await expect(journal.list()).resolves.toEqual([]);
    expect(destination.writeCalls).toBe(0);
  });

  it('commits verified output when the run changes after destination write', async () => {
    destination.writeImpl = async (input) => {
      const location: RuntimeDeliveryLocation = {
        kind: 'member_inbox',
        teamName: input.envelope.teamName,
        memberName:
          typeof input.envelope.to === 'object' && 'memberName' in input.envelope.to
            ? input.envelope.to.memberName
            : 'unknown',
        messageId: input.destinationMessageId,
      };
      destination.messages.set(input.destinationMessageId, location);
      runState.currentRunId = 'run-2';
      return location;
    };
    const service = createService();

    const ack = await service.deliver(envelope());

    expect(ack).toMatchObject({
      ok: true,
      delivered: true,
      reason: null,
    });
    await expect(journal.get(journalKey())).resolves.toMatchObject({
      status: 'committed',
      committedLocation: expect.objectContaining({
        kind: 'member_inbox',
        memberName: 'Reviewer',
      }),
      lastError: null,
    });
    expect(emitter.events).toEqual([
      {
        type: 'runtime-delivery',
        teamName: 'team-a',
        data: {
          kind: 'member_inbox',
        },
      },
    ]);
    expect(diagnostics.append).not.toHaveBeenCalled();
  });

  it('emits a bounded change event after verified commit', async () => {
    const service = createService();

    await service.deliver(envelope());

    expect(emitter.events).toEqual([
      {
        type: 'runtime-delivery',
        teamName: 'team-a',
        data: {
          kind: 'member_inbox',
        },
      },
    ]);
  });

  it('commits cross-team delivery after repairing missing sender-copy proof', async () => {
    const sentMessages: InboxMessage[] = [];
    const crossTeamEnvelope = envelope({
      to: { teamName: 'team-b', memberName: 'Reviewer' },
    });
    const deliveredMessageId = 'deduplicated-runtime-cross-team-message';
    const crossTeamSender = vi.fn(() =>
      Promise.resolve({
        messageId: deliveredMessageId,
        deliveredToInbox: true,
        deduplicated: true,
        toTeam: 'team-b',
        toMember: 'Reviewer',
      })
    );
    const service = new RuntimeDeliveryService(
      runState,
      journal,
      new RuntimeDeliveryDestinationRegistry(
        createOpenCodeRuntimeDeliveryPorts({
          sentMessagesStore: {
            appendMessage: vi.fn((_teamName: string, message: InboxMessage) => {
              sentMessages.push(message);
              return Promise.resolve();
            }),
            readMessages: vi.fn(() => Promise.resolve(sentMessages)),
          },
          inboxReader: {
            getMessagesFor: vi.fn(() => Promise.resolve([])),
          },
          inboxWriter: {
            sendMessage: vi.fn(),
          },
          getCrossTeamSender: () => crossTeamSender,
        })
      ),
      diagnostics,
      emitter,
      () => now
    );

    const ack = await service.deliver(crossTeamEnvelope);

    expect(ack).toMatchObject({
      ok: true,
      delivered: true,
      location: {
        kind: 'cross_team_outbox',
        fromTeamName: 'team-a',
        toTeamName: 'team-b',
        toMemberName: 'Reviewer',
        messageId: deliveredMessageId,
      },
    });
    expect(sentMessages).toEqual([
      expect.objectContaining({
        from: 'Builder',
        to: 'team-b.Reviewer',
        messageId: deliveredMessageId,
        source: CROSS_TEAM_SENT_SOURCE,
      }),
    ]);
    await expect(journal.get(journalKey(crossTeamEnvelope))).resolves.toMatchObject({
      status: 'committed',
      committedLocation: expect.objectContaining({
        kind: 'cross_team_outbox',
        messageId: deliveredMessageId,
      }),
    });
    expect(diagnostics.append).not.toHaveBeenCalled();
  });

  it('does not commit cross-team retry from sender-copy proof without target runtime proof', async () => {
    const crossTeamEnvelope = envelope({
      to: { teamName: 'team-b', memberName: 'Reviewer' },
    });
    const destinationMessageId = buildRuntimeDestinationMessageId(crossTeamEnvelope);
    const sentMessages: InboxMessage[] = [
      {
        from: 'Builder',
        to: 'team-b.Reviewer',
        text: 'Please review this',
        timestamp: '2026-04-21T12:00:00.000Z',
        read: true,
        messageId: destinationMessageId,
        source: CROSS_TEAM_SENT_SOURCE,
      },
    ];
    const crossTeamSender = vi.fn(() =>
      Promise.resolve({
        messageId: destinationMessageId,
        deliveredToInbox: true,
        toTeam: 'team-b',
        toMember: 'Reviewer',
      })
    );
    const service = new RuntimeDeliveryService(
      runState,
      journal,
      new RuntimeDeliveryDestinationRegistry(
        createOpenCodeRuntimeDeliveryPorts({
          sentMessagesStore: {
            appendMessage: vi.fn(),
            readMessages: vi.fn(() => Promise.resolve(sentMessages)),
          },
          inboxReader: {
            getMessagesFor: vi.fn(() => Promise.resolve([])),
          },
          inboxWriter: {
            sendMessage: vi.fn(),
          },
          getCrossTeamSender: () => crossTeamSender,
        })
      ),
      diagnostics,
      emitter,
      () => now
    );

    const ack = await service.deliver(crossTeamEnvelope);

    expect(ack).toMatchObject({
      ok: true,
      delivered: true,
      reason: null,
    });
    expect(crossTeamSender).toHaveBeenCalledTimes(1);
    await expect(journal.get(journalKey(crossTeamEnvelope))).resolves.toMatchObject({
      status: 'committed',
      committedLocation: expect.objectContaining({
        kind: 'cross_team_outbox',
        messageId: destinationMessageId,
      }),
    });
  });
});

describe('RuntimeDeliveryJournal', () => {
  it('normalizes createdAt before delivery payload hashing', () => {
    const normalized = normalizeRuntimeDeliveryEnvelope({
      ...envelope(),
      createdAt: '2026-04-21T12:00:00Z',
    });

    expect(normalized.createdAt).toBe('2026-04-21T12:00:00.000Z');
    expect(hashRuntimeDeliveryEnvelope(normalized)).toBe(hashRuntimeDeliveryEnvelope(envelope()));
  });

  it('rejects missing or invalid createdAt instead of hashing a fallback timestamp', () => {
    const missingCreatedAt: Partial<RuntimeDeliveryEnvelope> = { ...envelope() };
    delete missingCreatedAt.createdAt;

    expect(() => normalizeRuntimeDeliveryEnvelope(missingCreatedAt)).toThrow(
      'Runtime delivery envelope missing createdAt'
    );
    expect(() =>
      normalizeRuntimeDeliveryEnvelope({
        ...envelope(),
        createdAt: 'not-a-date',
      })
    ).toThrow('Runtime delivery envelope invalid createdAt');
  });
});

describe('RuntimeDeliveryReconciler', () => {
  it('diagnoses pending records that are not visible in destination', async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'opencode-runtime-delivery-reconcile-')
    );
    try {
      const now = new Date('2026-04-21T12:00:00.000Z');
      const journal = createRuntimeDeliveryJournalStore({
        filePath: path.join(tempDir, 'delivery-journal.json'),
        clock: () => now,
      });
      const message = envelope();
      await journal.begin({
        idempotencyKey: message.idempotencyKey,
        payloadHash: hashRuntimeDeliveryEnvelope(message),
        runId: message.runId,
        teamName: message.teamName,
        fromMemberName: message.fromMemberName,
        providerId: message.providerId,
        runtimeSessionId: message.runtimeSessionId,
        destination: resolveRuntimeDeliveryDestination(message),
        destinationMessageId: buildRuntimeDestinationMessageId(message),
        now: now.toISOString(),
      });
      const diagnostics = new FakeDiagnosticsSink();
      const reconciler = new RuntimeDeliveryReconciler(
        journal,
        new RuntimeDeliveryDestinationRegistry([new FakeDestinationPort('member_inbox')]),
        diagnostics,
        () => now
      );

      await reconciler.reconcileTeam('team-a');

      expect(diagnostics.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'runtime_delivery_recovery_needed',
          teamName: 'team-a',
          runId: 'run-1',
          severity: 'warning',
        })
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createService(): RuntimeDeliveryService {
  return new RuntimeDeliveryService(
    runState,
    journal,
    new RuntimeDeliveryDestinationRegistry([destination]),
    diagnostics,
    emitter,
    () => now
  );
}

function envelope(overrides: Partial<RuntimeDeliveryEnvelope> = {}): RuntimeDeliveryEnvelope {
  return {
    idempotencyKey: 'delivery-1',
    runId: 'run-1',
    teamName: 'team-a',
    fromMemberName: 'Builder',
    providerId: 'opencode',
    runtimeSessionId: 'session-1',
    to: { memberName: 'Reviewer' },
    text: 'Please review this',
    createdAt: '2026-04-21T12:00:00.000Z',
    taskRefs: [{ taskId: 'task-1', displayId: '#1', teamName: 'team-a' }],
    ...overrides,
  };
}

function journalKey(message: RuntimeDeliveryEnvelope = envelope()) {
  return {
    idempotencyKey: message.idempotencyKey,
    runId: message.runId,
    teamName: message.teamName,
  };
}

class FakeRunStateReader implements RuntimeDeliveryRunStateReader {
  constructor(public currentRunId: string | null) {}

  getCurrentRunId(): Promise<string | null> {
    return Promise.resolve(this.currentRunId);
  }
}

class FakeDestinationPort implements RuntimeDeliveryDestinationPort {
  readonly messages = new Map<string, RuntimeDeliveryLocation>();
  readonly verifyInputs: {
    destination: RuntimeDeliveryDestinationRef;
    destinationMessageId: string;
    location?: RuntimeDeliveryLocation;
  }[] = [];
  writeCalls = 0;
  writeImpl:
    | ((input: {
        envelope: RuntimeDeliveryEnvelope;
        destinationMessageId: string;
      }) => Promise<RuntimeDeliveryLocation>)
    | undefined;

  constructor(readonly kind: RuntimeDeliveryDestinationRef['kind']) {}

  async write(input: {
    envelope: RuntimeDeliveryEnvelope;
    destinationMessageId: string;
  }): Promise<RuntimeDeliveryLocation> {
    this.writeCalls += 1;
    if (this.writeImpl) {
      return this.writeImpl(input);
    }
    const location: RuntimeDeliveryLocation = {
      kind: 'member_inbox',
      teamName: input.envelope.teamName,
      memberName:
        typeof input.envelope.to === 'object' && 'memberName' in input.envelope.to
          ? input.envelope.to.memberName
          : 'unknown',
      messageId: input.destinationMessageId,
    };
    this.messages.set(input.destinationMessageId, location);
    return location;
  }

  verify(input: {
    destination: RuntimeDeliveryDestinationRef;
    destinationMessageId: string;
    location?: RuntimeDeliveryLocation;
  }): Promise<RuntimeDeliveryVerifyResult> {
    this.verifyInputs.push(input);
    const location =
      this.messages.get(input.location?.messageId ?? input.destinationMessageId) ?? null;
    return Promise.resolve({
      found: location !== null,
      location,
      diagnostics: [],
    });
  }

  buildChangeEvent(input: {
    teamName: string;
    location: RuntimeDeliveryLocation;
  }): RuntimeDeliveryTeamChangeEvent {
    return {
      type: 'runtime-delivery',
      teamName: input.teamName,
      data: {
        kind: input.location.kind,
      },
    };
  }
}

class FakeDiagnosticsSink implements RuntimeDeliveryDiagnosticsSink {
  readonly append = vi.fn(() => Promise.resolve());
}

class FakeTeamChangeEmitter implements RuntimeDeliveryTeamChangeEmitter {
  readonly events: RuntimeDeliveryTeamChangeEvent[] = [];

  emit(event: RuntimeDeliveryTeamChangeEvent): void {
    this.events.push(event);
  }
}
