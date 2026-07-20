import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

import {
  ApplicationCommandBeginOutcome,
  ApplicationCommandConflictReason,
  ApplicationCommandFailureKind,
  type ApplicationCommandLedgerBeginRequest,
  ApplicationCommandLedgerStatus,
  type ApplicationCommandLedgerStorageGateway,
  COMMAND_IDEMPOTENCY_SCOPE,
  type CommandDescriptor,
  type CommandFingerprintRecord,
  type DurableApplicationCommandAttemptClaim,
  type DurableApplicationCommandAttemptLeaseRequest,
  type DurableApplicationCommandAttemptReference,
  type DurableApplicationCommandClaimRequest,
  type DurableApplicationCommandClaimResult,
  type DurableApplicationCommandClaimStatusRequest,
  type DurableApplicationCommandCommitRequest,
  type DurableApplicationCommandConsumerApplyRequest,
  type DurableApplicationCommandConsumerApplyResult,
  type DurableApplicationCommandConsumerProjectionRecord,
  type DurableApplicationCommandConsumerProjectionRequest,
  type DurableApplicationCommandEffectTransitionRequest,
  type DurableApplicationCommandLedgerStorageGateway,
  type DurableApplicationCommandOutboxClaimRequest,
  type DurableApplicationCommandOutboxDeliveryAcknowledgementRequest,
  type DurableApplicationCommandOutboxListRequest,
  type DurableApplicationCommandOutboxRecord,
  type DurableApplicationCommandPersistClaimRequest,
  type DurableApplicationCommandRecord,
  type DurableApplicationCommandStatusRequest,
  type DurableApplicationCommandTransitionRequest,
  HMAC_SHA256_LD_V1,
} from '@features/application-command-ledger';
import { createCommandDescriptorRegistry } from '@features/application-command-ledger/core/domain';
import { InternalStorageApplicationCommandLedgerStore } from '@features/application-command-ledger/main';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

import { InProcessGateway } from '../../internal-storage/helpers/InProcessGateway';

describe('InternalStorageApplicationCommandLedgerStore', () => {
  let tmpDir: string | null = null;
  const cores: InternalStorageWorkerCore[] = [];
  const workers: TestWorkerRpc[] = [];

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.close()));
    for (const core of cores.splice(0)) {
      core.close();
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('stores completed command results and returns duplicate-completed on replay', async () => {
    const store = await makeStore();

    const begin = await store.begin(makeBeginRequest());
    expect(begin.outcome).toBe(ApplicationCommandBeginOutcome.Started);
    await store.markCompleted({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      attemptCount: 1,
      resultHash: 'hash:result',
      resultJson: '{"ok":true}',
      completedAtIso: '2026-07-09T10:01:00.000Z',
    });

    const replay = await store.begin(makeBeginRequest({ nowIso: '2026-07-09T10:02:00.000Z' }));
    expect(replay.outcome).toBe(ApplicationCommandBeginOutcome.DuplicateCompleted);
    if (replay.outcome !== ApplicationCommandBeginOutcome.DuplicateCompleted) {
      throw new Error(`unexpected begin outcome: ${replay.outcome}`);
    }
    expect(replay.record.resultJson).toBe('{"ok":true}');
    expect(replay.record.status).toBe(ApplicationCommandLedgerStatus.Completed);
  });

  it('replays idempotency key reuse by a different command id when payload matches', async () => {
    const store = await makeStore();

    await store.begin(makeBeginRequest());
    await store.markCompleted({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      attemptCount: 1,
      resultHash: 'hash:result',
      resultJson: '{"ok":true}',
      completedAtIso: '2026-07-09T10:01:00.000Z',
    });

    const replay = await store.begin(
      makeBeginRequest({ commandId: 'cmd-2', nowIso: '2026-07-09T10:02:00.000Z' })
    );

    expect(replay).toMatchObject({
      outcome: ApplicationCommandBeginOutcome.DuplicateCompleted,
      record: {
        commandId: 'cmd-1',
        idempotencyKey: 'idem-1',
        resultJson: '{"ok":true}',
      },
    });
  });

  it('rejects idempotency key reuse when payload changes', async () => {
    const store = await makeStore();

    await store.begin(makeBeginRequest());
    const conflict = await store.begin(
      makeBeginRequest({ commandId: 'cmd-2', payloadHash: 'hash:payload-2' })
    );

    expect(conflict).toMatchObject({
      outcome: ApplicationCommandBeginOutcome.Conflict,
      reason: ApplicationCommandConflictReason.PayloadHashMismatch,
    });
  });

  it('restarts retryable failures and increments attempts without changing command identity', async () => {
    const store = await makeStore();

    await store.begin(makeBeginRequest());
    await store.markFailed({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      attemptCount: 1,
      failureKind: ApplicationCommandFailureKind.Retryable,
      errorMessage: 'temporary',
      completedAtIso: '2026-07-09T10:01:00.000Z',
    });

    const retry = await store.begin(makeBeginRequest({ nowIso: '2026-07-09T10:02:00.000Z' }));

    expect(retry.outcome).toBe(ApplicationCommandBeginOutcome.RetryStarted);
    if (retry.outcome !== ApplicationCommandBeginOutcome.RetryStarted) {
      throw new Error(`unexpected begin outcome: ${retry.outcome}`);
    }
    expect(retry.record.attemptCount).toBe(2);
    expect(retry.record.status).toBe(ApplicationCommandLedgerStatus.Started);
  });

  it('blocks unknown outcomes until reconciliation', async () => {
    const store = await makeStore();

    await store.begin(makeBeginRequest());
    await store.markFailed({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      attemptCount: 1,
      failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout,
      errorMessage: 'timeout',
      completedAtIso: '2026-07-09T10:01:00.000Z',
    });

    const blocked = await store.begin(makeBeginRequest({ nowIso: '2026-07-09T10:02:00.000Z' }));

    expect(blocked.outcome).toBe(ApplicationCommandBeginOutcome.UnknownAfterTimeout);
    if (blocked.outcome !== ApplicationCommandBeginOutcome.UnknownAfterTimeout) {
      throw new Error(`unexpected begin outcome: ${blocked.outcome}`);
    }
    expect(blocked.record.completedAt).toBeNull();
  });

  it('reconciles an unknown outcome to completed and replays the result', async () => {
    const store = await makeStore();

    await store.begin(makeBeginRequest());
    await store.markFailed({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      attemptCount: 1,
      failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout,
      errorMessage: 'timeout',
      completedAtIso: '2026-07-09T10:01:00.000Z',
    });
    await store.markCompleted({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      attemptCount: 1,
      resultHash: 'hash:result',
      resultJson: '{"ok":true}',
      completedAtIso: '2026-07-09T10:02:00.000Z',
    });

    await expect(store.begin(makeBeginRequest())).resolves.toMatchObject({
      outcome: ApplicationCommandBeginOutcome.DuplicateCompleted,
      record: { status: ApplicationCommandLedgerStatus.Completed, resultJson: '{"ok":true}' },
    });
  });

  it('reconciles an unknown outcome to retryable and starts a new attempt', async () => {
    const store = await makeStore();

    await store.begin(makeBeginRequest());
    await store.markFailed({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      attemptCount: 1,
      failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout,
      errorMessage: 'timeout',
      completedAtIso: '2026-07-09T10:01:00.000Z',
    });
    await store.markFailed({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      attemptCount: 1,
      failureKind: ApplicationCommandFailureKind.Retryable,
      errorMessage: 'destination not changed',
      completedAtIso: '2026-07-09T10:02:00.000Z',
    });

    await expect(store.begin(makeBeginRequest())).resolves.toMatchObject({
      outcome: ApplicationCommandBeginOutcome.RetryStarted,
      record: { status: ApplicationCommandLedgerStatus.Started, attemptCount: 2 },
    });
  });

  it('moves a stale started attempt to unknown before any retry', async () => {
    const store = await makeStore();

    await store.begin(makeBeginRequest());
    const stale = await store.begin(
      makeBeginRequest({
        nowIso: '2026-07-09T10:01:00.000Z',
        startedStaleAfterMs: 60_000,
      })
    );

    expect(stale).toMatchObject({
      outcome: ApplicationCommandBeginOutcome.UnknownAfterTimeout,
      record: {
        status: ApplicationCommandLedgerStatus.UnknownAfterTimeout,
        attemptCount: 1,
      },
    });
  });

  it('rejects completion from a fenced attempt after a retry starts', async () => {
    const store = await makeStore();

    await store.begin(makeBeginRequest());
    await store.markFailed({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      attemptCount: 1,
      failureKind: ApplicationCommandFailureKind.Retryable,
      errorMessage: 'not applied',
      completedAtIso: '2026-07-09T10:01:00.000Z',
    });
    await store.begin(makeBeginRequest({ nowIso: '2026-07-09T10:02:00.000Z' }));

    await expect(
      Promise.resolve().then(() =>
        store.markCompleted({
          namespace: 'task-board',
          scopeKey: 'team-a',
          commandId: 'cmd-1',
          attemptCount: 1,
          resultHash: 'hash:stale',
          resultJson: '{"stale":true}',
          completedAtIso: '2026-07-09T10:03:00.000Z',
        })
      )
    ).rejects.toThrow('attempt is stale');
  });

  it('persists a versioned claim, ordered effect evidence, status, and outbox commit', async () => {
    const store = await makeDurableStore();

    const claimed = await store.claimDurable(makeDurableClaim());
    expect(claimed.resolution.outcome).toBe('claimed');
    expect(claimed.command).toMatchObject({
      commandId: 'durable-cmd-1',
      state: 'prepared',
      effects: [
        { ordinal: 0, effectId: 'write-local-state', state: 'not_started' },
        { ordinal: 1, effectId: 'notify-provider', state: 'not_started' },
      ],
    });

    await store.transitionDurableCommand({
      deploymentId: 'deployment-a',
      commandId: 'durable-cmd-1',
      attempt: DEFAULT_ATTEMPT_REFERENCE,
      expectedState: 'prepared',
      nextState: 'running',
      errorCode: null,
      errorJson: null,
      transitionedAtIso: '2026-07-20T10:00:01.000Z',
    });
    await succeedEffect(store, 0, '2026-07-20T10:00:02.000Z');
    await succeedEffect(store, 1, '2026-07-20T10:00:03.000Z');

    const committed = await store.commitDurable({
      deploymentId: 'deployment-a',
      commandId: 'durable-cmd-1',
      attempt: DEFAULT_ATTEMPT_REFERENCE,
      expectedState: 'running',
      outcomeJson: '{"accepted":true}',
      committedAtIso: '2026-07-20T10:00:04.000Z',
      outbox: {
        eventId: 'event-1',
        eventType: 'task.created',
        scopeKind: 'team',
        scopeId: 'team-a',
        schemaVersion: 1,
        semanticRevision: 1,
        payloadJson: '{"taskId":"task-a"}',
        createdAtIso: '2026-07-20T10:00:04.000Z',
      },
    });

    expect(committed.state).toBe('committed');
    expect(committed.effects.map((effect) => effect.state)).toEqual([
      'observed_succeeded',
      'observed_succeeded',
    ]);
    expect(committed.effects[0]?.evidence).toEqual([
      expect.objectContaining({
        sequence: 1,
        outcome: 'observed_succeeded',
        evidenceJson: '{"proof":"effect-0"}',
      }),
    ]);
    await expect(
      store.getDurableStatus({
        deploymentId: 'deployment-a',
        commandId: 'durable-cmd-1',
      })
    ).resolves.toEqual(committed);
    await expect(store.listDurableOutbox({ afterSequence: 0, limit: 10 })).resolves.toEqual([
      expect.objectContaining({
        sequence: 1,
        eventId: 'event-1',
        commandId: 'durable-cmd-1',
        semanticRevision: 1,
        payloadJson: '{"taskId":"task-a"}',
        deliveryAcknowledgedAt: null,
      }),
    ]);
    const claimedOutbox = await store.claimDurableOutbox({
      ownerId: 'delivery-worker-a',
      leaseToken: 'delivery-lease-a',
      claimedAtIso: '2026-07-20T10:00:05.000Z',
      leaseExpiresAtIso: '2026-07-20T10:01:05.000Z',
      limit: 10,
    });
    expect(claimedOutbox).toEqual([
      expect.objectContaining({
        eventId: 'event-1',
        deliveryLease: expect.objectContaining({ generation: 1, ownerId: 'delivery-worker-a' }),
      }),
    ]);
    await store.acknowledgeDurableOutboxDelivery({
      eventId: 'event-1',
      deliveryGeneration: 1,
      ownerId: 'delivery-worker-a',
      leaseToken: 'delivery-lease-a',
      acknowledgedAtIso: '2026-07-20T10:00:06.000Z',
    });
    await expect(store.listDurableOutbox({ afterSequence: 0, limit: 10 })).resolves.toEqual([
      expect.objectContaining({
        eventId: 'event-1',
        deliveryAcknowledgedAt: '2026-07-20T10:00:06.000Z',
      }),
    ]);
  });

  it('converges overlapping claims across independent worker threads and rejects changed intent', async () => {
    const { first, second } = await makeConcurrentDurableStores();
    const [left, right] = await Promise.all([
      first.claimDurable(makeDurableClaim()),
      second.claimDurable(
        makeDurableClaim({
          commandId: 'durable-cmd-2',
          attempt: {
            attemptId: 'attempt-b',
            ownerId: 'worker-b',
            leaseToken: 'command-lease-b',
            claimedAtIso: '2026-07-20T10:00:00.000Z',
            leaseExpiresAtIso: '2026-07-20T10:10:00.000Z',
          },
        })
      ),
    ]);

    expect(
      [left.resolution.outcome, right.resolution.outcome].sort((first, second) =>
        first.localeCompare(second)
      )
    ).toEqual(['claimed', 'same_intent']);
    expect(
      [left.attemptAcquired, right.attemptAcquired].sort(
        (first, second) => Number(first) - Number(second)
      )
    ).toEqual([false, true]);
    expect(left.command.commandId).toBe(right.command.commandId);
    expect(left.command.attempt).toEqual(right.command.attempt);
    await expect(
      second.getDurableByClaim({
        scope: makeDurableClaim().scope,
      })
    ).resolves.toMatchObject({
      commandId: left.command.commandId,
      state: 'prepared',
    });
    const losingCommandId =
      left.command.commandId === 'durable-cmd-1' ? 'durable-cmd-2' : 'durable-cmd-1';
    await expect(
      first.getDurableStatus({
        deploymentId: 'deployment-a',
        commandId: losingCommandId,
      })
    ).resolves.toBeNull();

    const conflict = await second.claimDurable(
      makeDurableClaim({
        commandId: 'durable-cmd-3',
        fingerprint: makeFingerprint({ digest: 'b'.repeat(64) }),
      })
    );
    expect(conflict.resolution).toMatchObject({
      outcome: 'idempotency_mismatch',
      claimAction: 'reject',
      effectAction: 'none',
      mismatch: { code: 'idempotency_mismatch' },
    });
    expect(conflict.attemptAcquired).toBe(false);
    expect(conflict.command.commandId).toBe(left.command.commandId);
    await expect(
      first.getDurableStatus({
        deploymentId: 'deployment-a',
        commandId: 'durable-cmd-3',
      })
    ).resolves.toBeNull();
  });

  it('fences an expired execution generation so attempt A cannot report success after B begins', async () => {
    const store = await makeDurableStore();
    const claimed = await store.claimDurable(makeDurableClaim());
    expect(claimed).toMatchObject({
      attemptAcquired: true,
      command: { attempt: DEFAULT_ATTEMPT_REFERENCE },
    });
    await store.transitionDurableCommand({
      deploymentId: 'deployment-a',
      commandId: 'durable-cmd-1',
      attempt: DEFAULT_ATTEMPT_REFERENCE,
      expectedState: 'prepared',
      nextState: 'running',
      errorCode: null,
      errorJson: null,
      transitionedAtIso: '2026-07-20T10:00:01.000Z',
    });
    await store.transitionDurableEffect({
      deploymentId: 'deployment-a',
      commandId: 'durable-cmd-1',
      attempt: DEFAULT_ATTEMPT_REFERENCE,
      ordinal: 0,
      expectedState: 'not_started',
      nextState: 'attempting',
      evidence: null,
      evidenceJson: null,
      transitionedAtIso: '2026-07-20T10:00:02.000Z',
    });
    await store.renewDurableAttemptLease({
      deploymentId: 'deployment-a',
      commandId: 'durable-cmd-1',
      attempt: DEFAULT_ATTEMPT_REFERENCE,
      renewedAtIso: '2026-07-20T10:05:00.000Z',
      leaseExpiresAtIso: '2026-07-20T10:15:00.000Z',
    });

    const earlyAttemptB = await store.claimDurable(
      makeDurableClaim({
        commandId: 'durable-cmd-2',
        attempt: {
          attemptId: 'attempt-b',
          ownerId: 'worker-b',
          leaseToken: 'command-lease-b',
          claimedAtIso: '2026-07-20T10:10:00.000Z',
          leaseExpiresAtIso: '2026-07-20T10:20:00.000Z',
        },
      })
    );
    expect(earlyAttemptB).toMatchObject({
      attemptAcquired: false,
      command: { attempt: { generation: 1, ownerId: 'worker-a' } },
    });

    const takeover = await store.claimDurable(
      makeDurableClaim({
        commandId: 'durable-cmd-2',
        attempt: {
          attemptId: 'attempt-b',
          ownerId: 'worker-b',
          leaseToken: 'command-lease-b',
          claimedAtIso: '2026-07-20T10:15:00.000Z',
          leaseExpiresAtIso: '2026-07-20T10:25:00.000Z',
        },
      })
    );
    expect(takeover).toMatchObject({
      resolution: { outcome: 'same_intent' },
      attemptAcquired: true,
      command: {
        state: 'recovering',
        attempt: { generation: 2, attemptId: 'attempt-b', ownerId: 'worker-b' },
      },
    });
    expect(takeover.command.effects[0]).toMatchObject({ ordinal: 0, state: 'ambiguous' });

    await expect(
      store.transitionDurableEffect({
        deploymentId: 'deployment-a',
        commandId: 'durable-cmd-1',
        attempt: DEFAULT_ATTEMPT_REFERENCE,
        ordinal: 0,
        expectedState: 'attempting',
        nextState: 'observed_succeeded',
        evidence: {
          effectId: 'write-local-state',
          effectVersion: 1,
          recoveryClass: 'transactional_local',
          evidenceSchemaVersion: 1,
          outcome: 'observed_succeeded',
        },
        evidenceJson: '{"proof":"stale-attempt-a"}',
        transitionedAtIso: '2026-07-20T10:06:00.000Z',
      })
    ).rejects.toThrow('attempt fence is stale');

    const reconciled = await store.transitionDurableEffect({
      deploymentId: 'deployment-a',
      commandId: 'durable-cmd-1',
      attempt: {
        generation: 2,
        attemptId: 'attempt-b',
        ownerId: 'worker-b',
        leaseToken: 'command-lease-b',
      },
      ordinal: 0,
      expectedState: 'ambiguous',
      nextState: 'observed_succeeded',
      evidence: {
        effectId: 'write-local-state',
        effectVersion: 1,
        recoveryClass: 'transactional_local',
        evidenceSchemaVersion: 1,
        outcome: 'observed_succeeded',
      },
      evidenceJson: '{"proof":"attempt-b-reconciliation"}',
      transitionedAtIso: '2026-07-20T10:16:00.000Z',
    });
    expect(reconciled.effects[0]).toMatchObject({ state: 'observed_succeeded' });
  });

  it('claims one globally ordered outbox batch and fences concurrent and stale delivery owners', async () => {
    const { first, second } = await makeConcurrentDurableStores();
    for (const ordinal of [1, 2]) {
      const commandId = `durable-outbox-${ordinal}`;
      await first.claimDurable(
        makeDurableClaim({
          commandId,
          scope: {
            ...makeDurableClaim().scope,
            idempotencyKey: `durable-outbox-idem-${ordinal}`,
          },
          fingerprint: makeFingerprint({ digest: String(ordinal).repeat(64) }),
        })
      );
      await first.transitionDurableCommand({
        deploymentId: 'deployment-a',
        commandId,
        attempt: DEFAULT_ATTEMPT_REFERENCE,
        expectedState: 'prepared',
        nextState: 'running',
        errorCode: null,
        errorJson: null,
        transitionedAtIso: '2026-07-20T10:00:01.000Z',
      });
      await succeedEffect(first, 0, '2026-07-20T10:00:02.000Z', { commandId });
      await succeedEffect(first, 1, '2026-07-20T10:00:03.000Z', { commandId });
      await first.commitDurable({
        deploymentId: 'deployment-a',
        commandId,
        attempt: DEFAULT_ATTEMPT_REFERENCE,
        expectedState: 'running',
        outcomeJson: `{"ordinal":${ordinal}}`,
        committedAtIso: '2026-07-20T10:00:04.000Z',
        outbox: {
          eventId: `event-${ordinal}`,
          eventType: 'task.created',
          scopeKind: 'team',
          scopeId: 'team-a',
          schemaVersion: 1,
          semanticRevision: ordinal,
          payloadJson: `{"ordinal":${ordinal}}`,
          createdAtIso: '2026-07-20T10:00:04.000Z',
        },
      });
    }

    const concurrentConsumerRequest = {
      consumerId: 'task-list-projection-v1',
      projectionKey: 'team-a/tasks',
      eventId: 'event-1',
      semanticRevision: 1,
      stateJson: '{"taskIds":["task-1"]}',
      appliedAtIso: '2026-07-20T10:00:05.000Z',
    } satisfies DurableApplicationCommandConsumerApplyRequest;
    const concurrentApplications = await Promise.all([
      first.applyDurableConsumerEvent(concurrentConsumerRequest),
      second.applyDurableConsumerEvent(concurrentConsumerRequest),
    ]);
    expect(
      concurrentApplications
        .map(({ outcome }) => outcome)
        .sort((left, right) => left.localeCompare(right))
    ).toEqual(['applied', 'duplicate']);
    await expect(
      first.getDurableConsumerProjection({
        consumerId: concurrentConsumerRequest.consumerId,
        projectionKey: concurrentConsumerRequest.projectionKey,
      })
    ).resolves.toMatchObject({ semanticRevision: 1, applicationCount: 1 });

    const deliveryOwnerA: DurableApplicationCommandOutboxClaimRequest = {
      ownerId: 'delivery-worker-a',
      leaseToken: 'delivery-lease-a',
      claimedAtIso: '2026-07-20T10:01:00.000Z',
      leaseExpiresAtIso: '2026-07-20T10:02:00.000Z',
      limit: 10,
    };
    const deliveryOwnerB: DurableApplicationCommandOutboxClaimRequest = {
      ownerId: 'delivery-worker-b',
      leaseToken: 'delivery-lease-b',
      claimedAtIso: '2026-07-20T10:01:00.000Z',
      leaseExpiresAtIso: '2026-07-20T10:02:00.000Z',
      limit: 10,
    };
    const [claimedA, claimedB] = await Promise.all([
      first.claimDurableOutbox(deliveryOwnerA),
      second.claimDurableOutbox(deliveryOwnerB),
    ]);
    expect([claimedA.length, claimedB.length].sort((left, right) => left - right)).toEqual([0, 2]);

    const winner =
      claimedA.length > 0
        ? { store: first, claim: deliveryOwnerA, records: claimedA }
        : { store: second, claim: deliveryOwnerB, records: claimedB };
    const loser =
      claimedA.length > 0
        ? { store: second, ownerId: 'delivery-worker-b', leaseToken: 'delivery-lease-b' }
        : { store: first, ownerId: 'delivery-worker-a', leaseToken: 'delivery-lease-a' };
    await expect(
      winner.store.acknowledgeDurableOutboxDelivery({
        eventId: 'event-2',
        deliveryGeneration: 1,
        ownerId: winner.claim.ownerId,
        leaseToken: winner.claim.leaseToken,
        acknowledgedAtIso: '2026-07-20T10:01:30.000Z',
      })
    ).rejects.toThrow('acknowledge delivery in sequence order');

    const takeover = await loser.store.claimDurableOutbox({
      ownerId: loser.ownerId,
      leaseToken: loser.leaseToken,
      claimedAtIso: '2026-07-20T10:02:00.000Z',
      leaseExpiresAtIso: '2026-07-20T10:03:00.000Z',
      limit: 10,
    });
    expect(takeover).toEqual([
      expect.objectContaining({
        eventId: 'event-1',
        deliveryLease: {
          generation: 2,
          ownerId: loser.ownerId,
          leaseToken: loser.leaseToken,
          claimedAt: '2026-07-20T10:02:00.000Z',
          leaseExpiresAt: '2026-07-20T10:03:00.000Z',
        },
      }),
      expect.objectContaining({
        eventId: 'event-2',
        deliveryLease: {
          generation: 2,
          ownerId: loser.ownerId,
          leaseToken: loser.leaseToken,
          claimedAt: '2026-07-20T10:02:00.000Z',
          leaseExpiresAt: '2026-07-20T10:03:00.000Z',
        },
      }),
    ]);
    await expect(
      winner.store.acknowledgeDurableOutboxDelivery({
        eventId: 'event-1',
        deliveryGeneration: 1,
        ownerId: winner.claim.ownerId,
        leaseToken: winner.claim.leaseToken,
        acknowledgedAtIso: '2026-07-20T10:01:40.000Z',
      })
    ).rejects.toThrow('delivery fence is stale');

    for (const [index, eventId] of ['event-1', 'event-2'].entries()) {
      await loser.store.acknowledgeDurableOutboxDelivery({
        eventId,
        deliveryGeneration: 2,
        ownerId: loser.ownerId,
        leaseToken: loser.leaseToken,
        acknowledgedAtIso: `2026-07-20T10:02:${String(10 + index).padStart(2, '0')}.000Z`,
      });
    }
    await expect(first.listDurableOutbox({ afterSequence: 0, limit: 10 })).resolves.toEqual([
      expect.objectContaining({ eventId: 'event-1', deliveryAcknowledgedAt: expect.any(String) }),
      expect.objectContaining({ eventId: 'event-2', deliveryAcknowledgedAt: expect.any(String) }),
    ]);
    expect(winner.records.map((record) => record.eventId)).toEqual(['event-1', 'event-2']);
  });

  it('durably deduplicates consumer application after close, reopen, and pre-ack crash', async () => {
    const first = await makeDurableStore();
    for (const revision of [1, 2]) {
      const commandId = `durable-crash-outbox-${revision}`;
      await first.claimDurable(
        makeDurableClaim({
          commandId,
          scope: {
            ...makeDurableClaim().scope,
            idempotencyKey: `durable-crash-outbox-idem-${revision}`,
          },
          fingerprint: makeFingerprint({ digest: String(revision).repeat(64) }),
        })
      );
      await first.transitionDurableCommand({
        deploymentId: 'deployment-a',
        commandId,
        attempt: DEFAULT_ATTEMPT_REFERENCE,
        expectedState: 'prepared',
        nextState: 'running',
        errorCode: null,
        errorJson: null,
        transitionedAtIso: '2026-07-20T10:00:01.000Z',
      });
      await succeedEffect(first, 0, '2026-07-20T10:00:02.000Z', { commandId });
      await succeedEffect(first, 1, '2026-07-20T10:00:03.000Z', { commandId });
      await first.commitDurable({
        deploymentId: 'deployment-a',
        commandId,
        attempt: DEFAULT_ATTEMPT_REFERENCE,
        expectedState: 'running',
        outcomeJson: `{"revision":${revision}}`,
        committedAtIso: '2026-07-20T10:00:04.000Z',
        outbox: {
          eventId: `e${revision}`,
          eventType: 'task.changed',
          scopeKind: 'team',
          scopeId: 'team-a',
          schemaVersion: 1,
          semanticRevision: revision,
          payloadJson: `{"revision":${revision},"taskId":"task-a"}`,
          createdAtIso: '2026-07-20T10:00:04.000Z',
        },
      });
    }

    const firstLease = {
      ownerId: 'delivery-worker-a',
      leaseToken: 'delivery-lease-a',
      claimedAtIso: '2026-07-20T10:01:00.000Z',
      leaseExpiresAtIso: '2026-07-20T10:02:00.000Z',
      limit: 10,
    } satisfies DurableApplicationCommandOutboxClaimRequest;
    const firstBatch = await first.claimDurableOutbox(firstLease);
    expect(firstBatch.map((record) => record.eventId)).toEqual(['e1', 'e2']);

    const stableEnvelopeBytes = (record: DurableApplicationCommandOutboxRecord): Buffer =>
      Buffer.from(
        JSON.stringify({
          eventId: record.eventId,
          sequence: record.sequence,
          semanticRevision: record.semanticRevision,
          payloadJson: record.payloadJson,
        }),
        'utf8'
      );

    // Consumer projection application commits, then delivery crashes before its acknowledgement.
    await expect(
      first.applyDurableConsumerEvent({
        consumerId: 'task-projection-v1',
        projectionKey: 'team-a/task-a',
        eventId: 'e1',
        semanticRevision: 1,
        stateJson: '{"revision":1,"taskId":"task-a"}',
        appliedAtIso: '2026-07-20T10:01:01.000Z',
      })
    ).resolves.toMatchObject({
      outcome: 'applied',
      projection: { semanticRevision: 1, applicationCount: 1, lastEventId: 'e1' },
    });
    const firstBatchBytes = firstBatch.map(stableEnvelopeBytes);
    cores.splice(0).forEach((core) => core.close());

    const reopened = makeDurableStoreAt(path.join(tmpDir!, 'storage', 'app.db'));
    const reclaimedLease = {
      ownerId: 'delivery-worker-b',
      leaseToken: 'delivery-lease-b',
      claimedAtIso: '2026-07-20T10:02:00.000Z',
      leaseExpiresAtIso: '2026-07-20T10:03:00.000Z',
      limit: 10,
    } satisfies DurableApplicationCommandOutboxClaimRequest;
    const reclaimedBatch = await reopened.claimDurableOutbox(reclaimedLease);
    expect(reclaimedBatch.map((record) => record.deliveryLease?.generation)).toEqual([2, 2]);
    expect(reclaimedBatch.map(stableEnvelopeBytes)).toEqual(firstBatchBytes);

    await expect(
      Promise.resolve().then(() =>
        reopened.applyDurableConsumerEvent({
          consumerId: 'task-projection-v1',
          projectionKey: 'team-a/task-a',
          eventId: 'e1',
          semanticRevision: 2,
          stateJson: '{"revision":2,"taskId":"task-a"}',
          appliedAtIso: '2026-07-20T10:02:01.000Z',
        })
      )
    ).rejects.toThrow('semantic revision mismatch');
    await expect(
      reopened.applyDurableConsumerEvent({
        consumerId: 'task-projection-v1',
        projectionKey: 'team-a/task-a',
        eventId: 'e1',
        semanticRevision: 1,
        stateJson: '{"revision":1,"taskId":"task-a"}',
        appliedAtIso: '2026-07-20T10:02:02.000Z',
      })
    ).resolves.toMatchObject({
      outcome: 'duplicate',
      projection: {
        semanticRevision: 1,
        applicationCount: 1,
        lastEventId: 'e1',
        updatedAt: '2026-07-20T10:01:01.000Z',
      },
    });

    await expect(
      Promise.resolve().then(() =>
        reopened.acknowledgeDurableOutboxDelivery({
          eventId: 'e2',
          deliveryGeneration: 2,
          ownerId: reclaimedLease.ownerId,
          leaseToken: reclaimedLease.leaseToken,
          acknowledgedAtIso: '2026-07-20T10:02:01.000Z',
        })
      )
    ).rejects.toThrow('acknowledge delivery in sequence order');
    await expect(
      Promise.resolve().then(() =>
        reopened.acknowledgeDurableOutboxDelivery({
          eventId: 'e1',
          deliveryGeneration: 1,
          ownerId: firstLease.ownerId,
          leaseToken: firstLease.leaseToken,
          acknowledgedAtIso: '2026-07-20T10:02:01.000Z',
        })
      )
    ).rejects.toThrow('delivery fence is stale');

    for (const [index, record] of reclaimedBatch.entries()) {
      const applied = await reopened.applyDurableConsumerEvent({
        consumerId: 'task-projection-v1',
        projectionKey: 'team-a/task-a',
        eventId: record.eventId,
        semanticRevision: record.semanticRevision,
        stateJson: `{"revision":${record.semanticRevision},"taskId":"task-a"}`,
        appliedAtIso: `2026-07-20T10:02:${String(5 + index).padStart(2, '0')}.000Z`,
      });
      expect(applied.outcome).toBe(record.eventId === 'e1' ? 'duplicate' : 'applied');
      await reopened.acknowledgeDurableOutboxDelivery({
        eventId: record.eventId,
        deliveryGeneration: 2,
        ownerId: reclaimedLease.ownerId,
        leaseToken: reclaimedLease.leaseToken,
        acknowledgedAtIso: `2026-07-20T10:02:${String(10 + index).padStart(2, '0')}.000Z`,
      });
    }

    await expect(
      reopened.getDurableConsumerProjection({
        consumerId: 'task-projection-v1',
        projectionKey: 'team-a/task-a',
      })
    ).resolves.toEqual({
      consumerId: 'task-projection-v1',
      projectionKey: 'team-a/task-a',
      semanticRevision: 2,
      lastEventId: 'e2',
      stateJson: '{"revision":2,"taskId":"task-a"}',
      applicationCount: 2,
      updatedAt: '2026-07-20T10:02:06.000Z',
    });
    await expect(reopened.listDurableOutbox({ afterSequence: 0, limit: 10 })).resolves.toEqual([
      expect.objectContaining({ eventId: 'e1', deliveryAcknowledgedAt: expect.any(String) }),
      expect.objectContaining({ eventId: 'e2', deliveryAcknowledgedAt: expect.any(String) }),
    ]);
  });

  it('reads command, effects, and evidence inside one SQLite snapshot transaction', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'durable-app-command-snapshot-'));
    const statements: string[] = [];
    const core = new InternalStorageWorkerCore({
      databasePath: path.join(tmpDir, 'storage', 'app.db'),
      createDatabase: (file) =>
        new Database(file, { verbose: (sql) => statements.push(String(sql)) }),
    });
    cores.push(core);
    const store = new InternalStorageApplicationCommandLedgerStore(
      makeDurableGateway(core),
      createCommandDescriptorRegistry(DURABLE_DESCRIPTORS)
    );
    await store.claimDurable(makeDurableClaim());
    await store.transitionDurableCommand({
      deploymentId: 'deployment-a',
      commandId: 'durable-cmd-1',
      attempt: DEFAULT_ATTEMPT_REFERENCE,
      expectedState: 'prepared',
      nextState: 'running',
      errorCode: null,
      errorJson: null,
      transitionedAtIso: '2026-07-20T10:00:01.000Z',
    });
    await succeedEffect(store, 0, '2026-07-20T10:00:02.000Z');

    statements.length = 0;
    await store.getDurableStatus({
      deploymentId: 'deployment-a',
      commandId: 'durable-cmd-1',
    });
    const begin = statements.findIndex((statement) => /^begin\b/i.test(statement));
    const commit = statements.findIndex((statement) => /^commit\b/i.test(statement));
    const selects = statements
      .map((statement, index) => ({ statement, index }))
      .filter(({ statement }) => /^select\b/i.test(statement));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(selects.length).toBeGreaterThanOrEqual(4);
    expect(selects.every(({ index }) => index > begin && index < commit)).toBe(true);
  });

  it('survives reopen with an attempting effect and requires evidence before commit', async () => {
    const first = await makeDurableStore();
    await first.claimDurable(makeDurableClaim());
    await first.transitionDurableCommand({
      deploymentId: 'deployment-a',
      commandId: 'durable-cmd-1',
      attempt: DEFAULT_ATTEMPT_REFERENCE,
      expectedState: 'prepared',
      nextState: 'running',
      errorCode: null,
      errorJson: null,
      transitionedAtIso: '2026-07-20T10:00:01.000Z',
    });
    await first.transitionDurableEffect({
      deploymentId: 'deployment-a',
      commandId: 'durable-cmd-1',
      attempt: DEFAULT_ATTEMPT_REFERENCE,
      ordinal: 0,
      expectedState: 'not_started',
      nextState: 'attempting',
      evidence: null,
      evidenceJson: null,
      transitionedAtIso: '2026-07-20T10:00:02.000Z',
    });
    cores.splice(0).forEach((core) => core.close());

    const reopened = makeDurableStoreAt(path.join(tmpDir!, 'storage', 'app.db'));
    await expect(
      reopened.getDurableStatus({
        deploymentId: 'deployment-a',
        commandId: 'durable-cmd-1',
      })
    ).resolves.toMatchObject({
      state: 'running',
      effects: [
        { state: 'attempting', evidence: [] },
        { state: 'not_started', evidence: [] },
      ],
    });
    await expect(
      reopened.commitDurable({
        deploymentId: 'deployment-a',
        commandId: 'durable-cmd-1',
        attempt: DEFAULT_ATTEMPT_REFERENCE,
        expectedState: 'running',
        outcomeJson: '{"accepted":true}',
        committedAtIso: '2026-07-20T10:00:03.000Z',
        outbox: {
          eventId: 'event-before-proof',
          eventType: 'task.created',
          scopeKind: 'team',
          scopeId: 'team-a',
          schemaVersion: 1,
          semanticRevision: 1,
          payloadJson: '{}',
          createdAtIso: '2026-07-20T10:00:03.000Z',
        },
      })
    ).rejects.toThrow('observed_succeeded');
    await expect(reopened.listDurableOutbox({ afterSequence: 0, limit: 10 })).resolves.toEqual([]);
  });

  it('moves an ambiguous non-reconcilable effect to operator_required', async () => {
    const store = await makeDurableStore();
    await store.claimDurable(
      makeDurableClaim({
        fingerprint: makeFingerprint({ descriptorId: 'task.deliver', digest: 'c'.repeat(64) }),
      })
    );
    await store.transitionDurableCommand({
      deploymentId: 'deployment-a',
      commandId: 'durable-cmd-1',
      attempt: DEFAULT_ATTEMPT_REFERENCE,
      expectedState: 'prepared',
      nextState: 'running',
      errorCode: null,
      errorJson: null,
      transitionedAtIso: '2026-07-20T10:00:01.000Z',
    });
    await store.transitionDurableEffect({
      deploymentId: 'deployment-a',
      commandId: 'durable-cmd-1',
      attempt: DEFAULT_ATTEMPT_REFERENCE,
      ordinal: 0,
      expectedState: 'not_started',
      nextState: 'attempting',
      evidence: null,
      evidenceJson: null,
      transitionedAtIso: '2026-07-20T10:00:02.000Z',
    });
    const ambiguous = await store.transitionDurableEffect({
      deploymentId: 'deployment-a',
      commandId: 'durable-cmd-1',
      attempt: DEFAULT_ATTEMPT_REFERENCE,
      ordinal: 0,
      expectedState: 'attempting',
      nextState: 'ambiguous',
      evidence: null,
      evidenceJson: null,
      transitionedAtIso: '2026-07-20T10:00:03.000Z',
    });

    expect(ambiguous).toMatchObject({
      state: 'operator_required',
      errorCode: 'ambiguous_non_reconcilable_effect',
      effects: [{ state: 'ambiguous' }],
    });
  });

  it('fails closed for unknown registered and persisted descriptor versions', async () => {
    const store = await makeDurableStore();
    await expect(
      store.claimDurable(
        makeDurableClaim({
          fingerprint: makeFingerprint({ descriptorVersion: 99, digest: 'd'.repeat(64) }),
        })
      )
    ).rejects.toThrow('No exact command descriptor version is registered');

    await store.claimDurable(makeDurableClaim());
    const db = new Database(path.join(tmpDir!, 'storage', 'app.db'));
    try {
      db.prepare(
        `UPDATE durable_application_commands
         SET descriptor_version = 99
         WHERE command_id = 'durable-cmd-1'`
      ).run();
      await expect(
        store.transitionDurableCommand({
          deploymentId: 'deployment-a',
          commandId: 'durable-cmd-1',
          attempt: DEFAULT_ATTEMPT_REFERENCE,
          expectedState: 'prepared',
          nextState: 'running',
          errorCode: null,
          errorJson: null,
          transitionedAtIso: '2026-07-20T10:00:01.000Z',
        })
      ).rejects.toThrow('No exact command descriptor version is registered');
      expect(
        db
          .prepare(
            `SELECT state FROM durable_application_commands WHERE command_id = 'durable-cmd-1'`
          )
          .pluck()
          .get()
      ).toBe('prepared');
      db.prepare(
        `UPDATE durable_application_commands
         SET fingerprint_version = 'hmac-sha256-ld-v99'
         WHERE command_id = 'durable-cmd-1'`
      ).run();
    } finally {
      db.close();
    }
    await expect(
      store.getDurableStatus({
        deploymentId: 'deployment-a',
        commandId: 'durable-cmd-1',
      })
    ).rejects.toThrow('Unsupported durable application command fingerprint version');
  });

  async function makeStore(): Promise<InternalStorageApplicationCommandLedgerStore> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-command-ledger-'));
    const core = new InternalStorageWorkerCore({
      databasePath: path.join(tmpDir, 'storage', 'app.db'),
      createDatabase: (file) => new Database(file),
    });
    cores.push(core);
    return new InternalStorageApplicationCommandLedgerStore(new InProcessGateway(core));
  }

  async function makeDurableStore(): Promise<InternalStorageApplicationCommandLedgerStore> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'durable-app-command-ledger-'));
    return makeDurableStoreAt(path.join(tmpDir, 'storage', 'app.db'));
  }

  async function makeConcurrentDurableStores(): Promise<{
    first: InternalStorageApplicationCommandLedgerStore;
    second: InternalStorageApplicationCommandLedgerStore;
  }> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'durable-app-command-concurrent-'));
    const databasePath = path.join(tmpDir, 'storage', 'app.db');
    const bootstrap = new InternalStorageWorkerCore({
      databasePath,
      createDatabase: (file) => new Database(file),
    });
    bootstrap.handle('ping', {});
    bootstrap.close();

    const workerPath = path.join(tmpDir, 'internal-storage-test-worker.cjs');
    // Test-only output is confined to the fresh mkdtemp directory above.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(workerPath, internalStorageTestWorkerSource(), 'utf8');
    const firstWorker = new TestWorkerRpc(workerPath, databasePath);
    const secondWorker = new TestWorkerRpc(workerPath, databasePath);
    workers.push(firstWorker, secondWorker);
    await Promise.all([firstWorker.call('ping', {}), secondWorker.call('ping', {})]);
    const firstCore = new InternalStorageWorkerCore({
      databasePath,
      createDatabase: (file) => new Database(file),
    });
    const secondCore = new InternalStorageWorkerCore({
      databasePath,
      createDatabase: (file) => new Database(file),
    });
    cores.push(firstCore, secondCore);
    return {
      first: new InternalStorageApplicationCommandLedgerStore(
        makeDurableGateway(firstCore, firstWorker.call.bind(firstWorker)),
        createCommandDescriptorRegistry(DURABLE_DESCRIPTORS)
      ),
      second: new InternalStorageApplicationCommandLedgerStore(
        makeDurableGateway(secondCore, secondWorker.call.bind(secondWorker)),
        createCommandDescriptorRegistry(DURABLE_DESCRIPTORS)
      ),
    };
  }

  function makeDurableStoreAt(databasePath: string): InternalStorageApplicationCommandLedgerStore {
    const core = new InternalStorageWorkerCore({
      databasePath,
      createDatabase: (file) => new Database(file),
    });
    cores.push(core);
    return new InternalStorageApplicationCommandLedgerStore(
      makeDurableGateway(core),
      createCommandDescriptorRegistry(DURABLE_DESCRIPTORS)
    );
  }
});

function internalStorageTestWorkerSource(): string {
  return [
    "const path = require('node:path');",
    "const { createRequire } = require('node:module');",
    "const { parentPort, workerData } = require('node:worker_threads');",
    "const requireFromRepo = createRequire(path.join(process.cwd(), 'package.json'));",
    "const { register } = requireFromRepo('tsx/cjs/api');",
    "register({ tsconfigPath: path.join(process.cwd(), 'tsconfig.json') });",
    "const { InternalStorageWorkerCore } = require(path.join(process.cwd(), 'src', 'features', 'internal-storage', 'main', 'infrastructure', 'worker', 'InternalStorageWorkerCore.ts'));",
    "const databaseModule = requireFromRepo('better-sqlite3-node');",
    'const Database = databaseModule.default || databaseModule;',
    'const core = new InternalStorageWorkerCore({',
    '  databasePath: workerData.databasePath,',
    '  createDatabase: (databasePath) => new Database(databasePath),',
    '});',
    "parentPort.on('message', (message) => {",
    '  try {',
    '    const result = core.handle(message.op, message.payload);',
    '    parentPort.postMessage({ id: message.id, ok: true, result });',
    '  } catch (error) {',
    '    parentPort.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });',
    '  }',
    '});',
    "process.on('exit', () => core.close());",
    '',
  ].join('\n');
}

interface TestWorkerResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

class TestWorkerRpc {
  private readonly worker: Worker;
  private nextId = 0;

  constructor(workerPath: string, databasePath: string) {
    // The path is a test-owned bundle created under this test's fresh mkdtemp directory.
    this.worker = new Worker(workerPath, { workerData: { databasePath } });
  }

  call(op: string, payload: unknown): Promise<unknown> {
    const id = `request-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for test worker op: ${op}`));
      }, 10_000);
      const cleanup = () => {
        clearTimeout(timeout);
        this.worker.off('message', onMessage);
        this.worker.off('error', onError);
      };
      const onMessage = (message: TestWorkerResponse) => {
        if (message.id !== id) return;
        cleanup();
        if (message.ok) {
          resolve(message.result);
        } else {
          reject(new Error(message.error ?? `Test worker op failed: ${op}`));
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      this.worker.on('message', onMessage);
      this.worker.on('error', onError);
      this.worker.postMessage({ id, op, payload });
    });
  }

  async close(): Promise<void> {
    await this.worker.terminate();
  }
}

function makeBeginRequest(
  overrides: Partial<ApplicationCommandLedgerBeginRequest<string>> = {}
): ApplicationCommandLedgerBeginRequest<string> {
  return {
    namespace: 'task-board',
    scopeKey: 'team-a',
    commandId: 'cmd-1',
    idempotencyKey: 'idem-1',
    operation: 'task.create',
    payloadHash: 'hash:payload',
    metadataJson: null,
    nowIso: '2026-07-09T10:00:00.000Z',
    startedStaleAfterMs: 60_000,
    ...overrides,
  };
}

const DURABLE_DESCRIPTORS: readonly CommandDescriptor[] = [
  {
    descriptorId: 'task.create',
    descriptorVersion: 1,
    commandKind: 'task.create',
    inputSchemaVersion: 1,
    fingerprintVersion: HMAC_SHA256_LD_V1,
    effectPlanVersion: 1,
    idempotencyScope: COMMAND_IDEMPOTENCY_SCOPE,
    retentionClass: 'operator-command',
    normalizedIntentProjection: () => ({ taskId: 'task-a' }),
    effects: [
      {
        effectId: 'write-local-state',
        effectVersion: 1,
        recoveryClass: 'transactional_local',
        evidenceSchemaVersion: 1,
      },
      {
        effectId: 'notify-provider',
        effectVersion: 1,
        recoveryClass: 'idempotent_by_operation_id',
        evidenceSchemaVersion: 1,
      },
    ],
  },
  {
    descriptorId: 'task.deliver',
    descriptorVersion: 1,
    commandKind: 'task.create',
    inputSchemaVersion: 1,
    fingerprintVersion: HMAC_SHA256_LD_V1,
    effectPlanVersion: 1,
    idempotencyScope: COMMAND_IDEMPOTENCY_SCOPE,
    retentionClass: 'operator-command',
    normalizedIntentProjection: () => ({ taskId: 'task-a' }),
    effects: [
      {
        effectId: 'unmarked-delivery',
        effectVersion: 1,
        recoveryClass: 'non_reconcilable',
        evidenceSchemaVersion: 1,
      },
    ],
  },
];

const DEFAULT_ATTEMPT_CLAIM: DurableApplicationCommandAttemptClaim = {
  attemptId: 'attempt-a',
  ownerId: 'worker-a',
  leaseToken: 'command-lease-a',
  claimedAtIso: '2026-07-20T10:00:00.000Z',
  leaseExpiresAtIso: '2026-07-20T10:10:00.000Z',
};

const DEFAULT_ATTEMPT_REFERENCE: DurableApplicationCommandAttemptReference = {
  generation: 1,
  attemptId: DEFAULT_ATTEMPT_CLAIM.attemptId,
  ownerId: DEFAULT_ATTEMPT_CLAIM.ownerId,
  leaseToken: DEFAULT_ATTEMPT_CLAIM.leaseToken,
};

function makeFingerprint(
  overrides: Partial<CommandFingerprintRecord> = {}
): CommandFingerprintRecord {
  return {
    descriptorId: 'task.create',
    descriptorVersion: 1,
    schemaVersion: 1,
    fingerprintVersion: HMAC_SHA256_LD_V1,
    effectPlanVersion: 1,
    keyVersion: 'key-v1',
    digest: 'a'.repeat(64),
    ...overrides,
  };
}

function makeDurableClaim(
  overrides: Partial<DurableApplicationCommandClaimRequest> = {}
): DurableApplicationCommandClaimRequest {
  return {
    commandId: 'durable-cmd-1',
    scope: {
      deploymentId: 'deployment-a',
      stableActorId: 'operator-a',
      commandKind: 'task.create',
      idempotencyKey: 'durable-idem-1',
    },
    fingerprint: makeFingerprint(),
    attempt: DEFAULT_ATTEMPT_CLAIM,
    auditSessionId: 'session-a',
    createdAtIso: '2026-07-20T10:00:00.000Z',
    ...overrides,
  };
}

async function succeedEffect(
  store: InternalStorageApplicationCommandLedgerStore,
  ordinal: number,
  transitionedAtIso: string,
  options: {
    commandId?: string;
    attempt?: DurableApplicationCommandAttemptReference;
  } = {}
): Promise<void> {
  const commandId = options.commandId ?? 'durable-cmd-1';
  const attempt = options.attempt ?? DEFAULT_ATTEMPT_REFERENCE;
  const effectId = ordinal === 0 ? 'write-local-state' : 'notify-provider';
  const recoveryClass =
    ordinal === 0 ? ('transactional_local' as const) : ('idempotent_by_operation_id' as const);
  await store.transitionDurableEffect({
    deploymentId: 'deployment-a',
    commandId,
    attempt,
    ordinal,
    expectedState: 'not_started',
    nextState: 'attempting',
    evidence: null,
    evidenceJson: null,
    transitionedAtIso,
  });
  await store.transitionDurableEffect({
    deploymentId: 'deployment-a',
    commandId,
    attempt,
    ordinal,
    expectedState: 'attempting',
    nextState: 'observed_succeeded',
    evidence: {
      effectId,
      effectVersion: 1,
      recoveryClass,
      evidenceSchemaVersion: 1,
      outcome: 'observed_succeeded',
    },
    evidenceJson: `{"proof":"effect-${ordinal}"}`,
    transitionedAtIso,
  });
}

function makeDurableGateway(
  core: InternalStorageWorkerCore,
  workerCall?: (op: string, payload: unknown) => Promise<unknown>
): ApplicationCommandLedgerStorageGateway & DurableApplicationCommandLedgerStorageGateway {
  const call =
    workerCall ??
    ((op: string, payload: unknown) => Promise.resolve(core.handle(op as never, payload as never)));
  const durable = {
    applicationCommandLedgerDurableClaim: (
      request: DurableApplicationCommandPersistClaimRequest
    ): Promise<DurableApplicationCommandClaimResult> =>
      call(
        'appCommandLedger.durable.claim',
        request
      ) as Promise<DurableApplicationCommandClaimResult>,
    applicationCommandLedgerDurableGetStatus: (
      request: DurableApplicationCommandStatusRequest
    ): Promise<DurableApplicationCommandRecord | null> =>
      call(
        'appCommandLedger.durable.getStatus',
        request
      ) as Promise<DurableApplicationCommandRecord | null>,
    applicationCommandLedgerDurableGetByClaim: (
      request: DurableApplicationCommandClaimStatusRequest
    ): Promise<DurableApplicationCommandRecord | null> =>
      call(
        'appCommandLedger.durable.getByClaim',
        request
      ) as Promise<DurableApplicationCommandRecord | null>,
    applicationCommandLedgerDurableRenewAttemptLease: (
      request: DurableApplicationCommandAttemptLeaseRequest
    ): Promise<DurableApplicationCommandRecord> =>
      call(
        'appCommandLedger.durable.renewAttemptLease',
        request
      ) as Promise<DurableApplicationCommandRecord>,
    applicationCommandLedgerDurableTransitionCommand: (
      request: DurableApplicationCommandTransitionRequest
    ): Promise<DurableApplicationCommandRecord> =>
      call(
        'appCommandLedger.durable.transitionCommand',
        request
      ) as Promise<DurableApplicationCommandRecord>,
    applicationCommandLedgerDurableTransitionEffect: (
      request: DurableApplicationCommandEffectTransitionRequest
    ): Promise<DurableApplicationCommandRecord> =>
      call(
        'appCommandLedger.durable.transitionEffect',
        request
      ) as Promise<DurableApplicationCommandRecord>,
    applicationCommandLedgerDurableCommit: (
      request: DurableApplicationCommandCommitRequest
    ): Promise<DurableApplicationCommandRecord> =>
      call('appCommandLedger.durable.commit', request) as Promise<DurableApplicationCommandRecord>,
    applicationCommandLedgerDurableListOutbox: (
      request: DurableApplicationCommandOutboxListRequest
    ): Promise<DurableApplicationCommandOutboxRecord[]> =>
      call('appCommandLedger.durable.listOutbox', request) as Promise<
        DurableApplicationCommandOutboxRecord[]
      >,
    applicationCommandLedgerDurableClaimOutbox: (
      request: DurableApplicationCommandOutboxClaimRequest
    ): Promise<DurableApplicationCommandOutboxRecord[]> =>
      call('appCommandLedger.durable.claimOutbox', request) as Promise<
        DurableApplicationCommandOutboxRecord[]
      >,
    applicationCommandLedgerDurableAcknowledgeOutboxDelivery: (
      request: DurableApplicationCommandOutboxDeliveryAcknowledgementRequest
    ): Promise<void> =>
      call('appCommandLedger.durable.acknowledgeOutboxDelivery', request) as Promise<void>,
    applicationCommandLedgerDurableApplyConsumerEvent: (
      request: DurableApplicationCommandConsumerApplyRequest
    ): Promise<DurableApplicationCommandConsumerApplyResult> =>
      call(
        'appCommandLedger.durable.applyConsumerEvent',
        request
      ) as Promise<DurableApplicationCommandConsumerApplyResult>,
    applicationCommandLedgerDurableGetConsumerProjection: (
      request: DurableApplicationCommandConsumerProjectionRequest
    ): Promise<DurableApplicationCommandConsumerProjectionRecord | null> =>
      call(
        'appCommandLedger.durable.getConsumerProjection',
        request
      ) as Promise<DurableApplicationCommandConsumerProjectionRecord | null>,
  };
  return Object.assign(
    new InProcessGateway(core),
    durable
  ) as ApplicationCommandLedgerStorageGateway & DurableApplicationCommandLedgerStorageGateway;
}
