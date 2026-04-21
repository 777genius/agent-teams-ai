import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildRuntimeDestinationMessageId,
  createRuntimeDeliveryJournalStore,
  hashRuntimeDeliveryEnvelope,
  resolveRuntimeDeliveryDestination,
  type RuntimeDeliveryDestinationRef,
  type RuntimeDeliveryEnvelope,
  type RuntimeDeliveryLocation,
} from '../../../../src/main/services/team/opencode/delivery/RuntimeDeliveryJournal';
import {
  RuntimeDeliveryDestinationRegistry,
  RuntimeDeliveryReconciler,
  RuntimeDeliveryService,
  type RuntimeDeliveryDestinationPort,
  type RuntimeDeliveryDiagnosticsSink,
  type RuntimeDeliveryRunStateReader,
  type RuntimeDeliveryTeamChangeEmitter,
  type RuntimeDeliveryTeamChangeEvent,
  type RuntimeDeliveryVerifyResult,
} from '../../../../src/main/services/team/opencode/delivery/RuntimeDeliveryService';

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
    destination.writeImpl = async () => {
      throw new Error('simulated crash before write');
    };
    const service = createService();

    await expect(service.deliver(envelope())).rejects.toThrow('simulated crash before write');
    await expect(journal.get('delivery-1')).resolves.toMatchObject({
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
    await expect(journal.get('delivery-1')).resolves.toMatchObject({
      status: 'committed',
      attempts: 2,
      committedLocation: expect.objectContaining({
        kind: 'member_inbox',
        memberName: 'Reviewer',
      }),
    });
    expect(destination.messages).toHaveLength(1);
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

    await expect(journal.get(message.idempotencyKey)).resolves.toMatchObject({
      status: 'committed',
      committedLocation: expect.objectContaining({
        messageId: destinationMessageId,
      }),
    });
    expect(diagnostics.append).not.toHaveBeenCalled();
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
    await expect(journal.get(message.idempotencyKey)).resolves.toMatchObject({
      status: 'committed',
    });
  });

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
});

describe('RuntimeDeliveryReconciler', () => {
  it('diagnoses pending records that are not visible in destination', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-runtime-delivery-reconcile-'));
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
    taskRefs: ['task-1'],
    ...overrides,
  };
}

class FakeRunStateReader implements RuntimeDeliveryRunStateReader {
  constructor(public currentRunId: string | null) {}

  async getCurrentRunId(): Promise<string | null> {
    return this.currentRunId;
  }
}

class FakeDestinationPort implements RuntimeDeliveryDestinationPort {
  readonly messages = new Map<string, RuntimeDeliveryLocation>();
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

  async verify(input: {
    destination: RuntimeDeliveryDestinationRef;
    destinationMessageId: string;
  }): Promise<RuntimeDeliveryVerifyResult> {
    const location = this.messages.get(input.destinationMessageId) ?? null;
    return {
      found: location !== null,
      location,
      diagnostics: [],
    };
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
  readonly append = vi.fn(async () => {});
}

class FakeTeamChangeEmitter implements RuntimeDeliveryTeamChangeEmitter {
  readonly events: RuntimeDeliveryTeamChangeEvent[] = [];

  emit(event: RuntimeDeliveryTeamChangeEvent): void {
    this.events.push(event);
  }
}
