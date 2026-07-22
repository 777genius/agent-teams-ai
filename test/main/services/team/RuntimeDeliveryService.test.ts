import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOpenCodeRuntimeDeliveryPorts } from '../../../../src/main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryPorts';
import {
  canonicalizeRuntimeDeliveryCrossTeamIdentities,
  canonicalizeRuntimeDeliveryJournalRecordIdentities,
} from '../../../../src/main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeDelivery';
import {
  buildRuntimeDestinationMessageId,
  createRuntimeDeliveryJournalStore,
  hashRuntimeDeliveryEnvelope,
  hashRuntimeDeliveryEnvelopeLegacyTransport,
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
  type RuntimeDeliveryRecipientCanonicalizer,
  RuntimeDeliveryReconciler,
  type RuntimeDeliveryRunStateReader,
  RuntimeDeliveryService,
  type RuntimeDeliveryTeamChangeEmitter,
  type RuntimeDeliveryTeamChangeEvent,
  type RuntimeDeliveryVerifyResult,
} from '../../../../src/main/services/team/opencode/delivery/RuntimeDeliveryService';
import { VersionedJsonStore } from '../../../../src/main/services/team/opencode/store/VersionedJsonStore';
import { CROSS_TEAM_SENT_SOURCE } from '../../../../src/shared/constants/crossTeam';

import type {
  CrossTeamOutboxMessage,
  CrossTeamRuntimeDeliveryProofInput,
} from '../../../../src/main/services/team/CrossTeamOutbox';
import type { InboxMessage, TeamConfig } from '../../../../src/shared/types/team';

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
    destination.writeImpl = () => {
      destination.messages.set(canonicalLocation.messageId, canonicalLocation);
      return Promise.resolve(canonicalLocation);
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

  it('rolls a fresh delivery back to pending when destination identity changes during commit', async () => {
    const changedLocation: RuntimeDeliveryLocation = {
      kind: 'member_inbox',
      teamName: 'team-a',
      memberName: 'OtherReviewer',
      messageId: buildRuntimeDestinationMessageId(envelope()),
    };
    const verifyDestination = destination.verify.bind(destination);
    let verificationCount = 0;
    vi.spyOn(destination, 'verify').mockImplementation(async (input) => {
      verificationCount += 1;
      if (verificationCount === 4) {
        return { found: true, location: changedLocation, diagnostics: [] };
      }
      return verifyDestination(input);
    });
    const service = createService();

    await expect(service.deliver(envelope())).rejects.toThrow(
      'Runtime delivery destination changed during journal commit'
    );

    expect(verificationCount).toBe(4);
    await expect(journal.get(journalKey())).resolves.toMatchObject({
      status: 'pending',
      committedLocation: null,
      committedAt: null,
      lastError: null,
    });
    expect(emitter.events).toHaveLength(0);
    expect(diagnostics.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'runtime_delivery_failed',
        data: expect.objectContaining({
          error: expect.stringContaining('journal is not committed'),
        }),
      })
    );
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

  it('rolls back only ordinary duplicate recovery lineage when the destination disappears during commit', async () => {
    const message = envelope({ idempotencyKey: 'ordinary-duplicate-race' });
    const payloadHash = hashRuntimeDeliveryEnvelope(message);
    const destinationRef = resolveRuntimeDeliveryDestination(message);
    const destinationMessageId = buildRuntimeDestinationMessageId(message);
    const location = locationForDestination(destinationRef, destinationMessageId);
    await journal.begin({
      idempotencyKey: message.idempotencyKey,
      payloadHash,
      runId: message.runId,
      teamName: message.teamName,
      fromMemberName: message.fromMemberName,
      providerId: message.providerId,
      runtimeSessionId: message.runtimeSessionId,
      destination: destinationRef,
      destinationMessageId,
      now: now.toISOString(),
    });
    destination.messages.set(destinationMessageId, location);

    const concurrentRecord = {
      idempotencyKey: message.idempotencyKey,
      payloadHash,
      logicalPayloadHash: payloadHash,
      runId: 'unrelated-run',
      teamName: message.teamName,
      fromMemberName: message.fromMemberName,
      providerId: message.providerId,
      runtimeSessionId: 'unrelated-session',
      destination: {
        kind: 'member_inbox' as const,
        teamName: message.teamName,
        memberName: 'UnrelatedRecipient',
      },
      destinationMessageId: 'unrelated-message',
      committedLocation: null,
      status: 'failed_retryable' as const,
      attempts: 7,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      committedAt: null,
      lastError: 'unrelated concurrent mutation',
    };
    const concurrentStore = new VersionedJsonStore<unknown[]>({
      filePath: path.join(tempDir, 'delivery-journal.json'),
      schemaVersion: 1,
      defaultData: () => [],
      validate: (value) => {
        if (!Array.isArray(value)) {
          throw new Error('Runtime delivery journal must be an array');
        }
        return value;
      },
    });
    const verifyDestination = destination.verify.bind(destination);
    let verificationCount = 0;
    vi.spyOn(destination, 'verify').mockImplementation(async (input) => {
      verificationCount += 1;
      if (verificationCount === 3) {
        await concurrentStore.updateLocked((entries) => [...entries, concurrentRecord]);
        destination.messages.delete(destinationMessageId);
        return { found: false, location: null, diagnostics: ['destination disappeared'] };
      }
      return verifyDestination(input);
    });
    let statusBeforeReplacementWrite: string | null = null;
    destination.writeImpl = async (input) => {
      statusBeforeReplacementWrite = (await journal.get(journalKey(message)))?.status ?? null;
      const replacementLocation = locationForDestination(
        resolveRuntimeDeliveryDestination(input.envelope),
        input.destinationMessageId
      );
      destination.messages.set(input.destinationMessageId, replacementLocation);
      return replacementLocation;
    };
    const service = createService();

    await expect(service.deliver(message)).resolves.toMatchObject({
      ok: true,
      delivered: true,
      reason: null,
      location,
    });

    expect(statusBeforeReplacementWrite).toBe('pending');
    expect(destination.writeCalls).toBe(1);
    const records = await journal.list();
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          idempotencyKey: message.idempotencyKey,
          runId: message.runId,
          status: 'committed',
        }),
        expect.objectContaining(concurrentRecord),
      ])
    );
  });

  it('uses the canonical idempotency key for journal identity and destination ids', async () => {
    const message = envelope({ idempotencyKey: ' delivery-1 ' });
    const canonicalMessage = envelope({ idempotencyKey: 'delivery-1' });
    const canonicalDestinationMessageId = buildRuntimeDestinationMessageId(canonicalMessage);
    const service = createService();

    await expect(service.deliver(message)).resolves.toMatchObject({
      ok: true,
      delivered: true,
      reason: null,
      idempotencyKey: 'delivery-1',
    });

    const records = await journal.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      idempotencyKey: 'delivery-1',
      destinationMessageId: canonicalDestinationMessageId,
    });
    expect(destination.messages.has(canonicalDestinationMessageId)).toBe(true);
    await expect(journal.get(journalKey(message))).resolves.toMatchObject({
      idempotencyKey: 'delivery-1',
    });
  });

  it('dedupes whitespace-equivalent delivery retries with a single destination write', async () => {
    const service = createService();

    await expect(
      service.deliver(envelope({ idempotencyKey: ' delivery-1 ' }))
    ).resolves.toMatchObject({
      ok: true,
      delivered: true,
      reason: null,
      idempotencyKey: 'delivery-1',
    });
    await expect(
      service.deliver(envelope({ idempotencyKey: 'delivery-1' }))
    ).resolves.toMatchObject({
      ok: true,
      delivered: false,
      reason: 'duplicate',
      idempotencyKey: 'delivery-1',
    });

    expect(destination.writeCalls).toBe(1);
    await expect(journal.list()).resolves.toHaveLength(1);
  });

  it('canonicalizes direct journal keys before persisting or looking up records', async () => {
    const message = envelope({ idempotencyKey: 'delivery-1' });
    await journal.begin({
      idempotencyKey: ' delivery-1 ',
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

    await expect(journal.list()).resolves.toMatchObject([
      {
        idempotencyKey: 'delivery-1',
      },
    ]);
    await expect(
      journal.get({
        idempotencyKey: ' delivery-1 ',
        runId: 'run-1',
        teamName: 'team-a',
      })
    ).resolves.toMatchObject({
      idempotencyKey: 'delivery-1',
    });
  });

  it.each<{
    name: string;
    kind: RuntimeDeliveryDestinationRef['kind'];
    to: RuntimeDeliveryEnvelope['to'];
  }>([
    {
      name: 'member inbox',
      kind: 'member_inbox',
      to: { memberName: 'Reviewer' },
    },
    {
      name: 'user sent messages',
      kind: 'user_sent_messages',
      to: 'user',
    },
    {
      name: 'cross-team outbox',
      kind: 'cross_team_outbox',
      to: { teamName: 'team-b', memberName: 'Reviewer' },
    },
  ])(
    'recovers a $name write across a process relaunch before markCommitted',
    async ({ kind, to }) => {
      destination = new FakeDestinationPort(kind);
      const firstRunMessage = envelope({ idempotencyKey: 'shared-delivery', to });
      const firstRunDestination = resolveRuntimeDeliveryDestination(firstRunMessage);
      const firstRunMessageId = buildRuntimeDestinationMessageId(firstRunMessage);
      await journal.begin({
        idempotencyKey: firstRunMessage.idempotencyKey,
        payloadHash: hashRuntimeDeliveryEnvelope(firstRunMessage),
        runId: firstRunMessage.runId,
        teamName: firstRunMessage.teamName,
        fromMemberName: firstRunMessage.fromMemberName,
        providerId: firstRunMessage.providerId,
        runtimeSessionId: firstRunMessage.runtimeSessionId,
        destination: firstRunDestination,
        destinationMessageId: firstRunMessageId,
        now: now.toISOString(),
      });
      destination.messages.set(
        firstRunMessageId,
        locationForDestination(firstRunDestination, firstRunMessageId)
      );

      journal = createRuntimeDeliveryJournalStore({
        filePath: path.join(tempDir, 'delivery-journal.json'),
        clock: () => now,
      });
      runState.currentRunId = 'run-2';
      const secondRunMessage = envelope({
        idempotencyKey: 'shared-delivery',
        runId: 'run-2',
        runtimeSessionId: 'session-2',
        to,
      });
      const service = createService();

      await expect(service.deliver(secondRunMessage)).resolves.toMatchObject({
        ok: true,
        delivered: false,
        reason: 'duplicate_destination_found',
        location: expect.objectContaining({ messageId: firstRunMessageId }),
      });
      await expect(
        service.deliver({ ...secondRunMessage, text: 'conflicting same-run payload' })
      ).resolves.toMatchObject({
        ok: false,
        delivered: false,
        reason: 'idempotency_conflict',
      });

      expect(destination.writeCalls).toBe(0);
      expect(destination.messages).toHaveLength(1);
      const sharedRecords = (await journal.list()).filter(
        (record) => record.idempotencyKey === 'shared-delivery'
      );
      expect(sharedRecords).toMatchObject([
        { runId: 'run-1', status: 'committed' },
        { runId: 'run-2', status: 'committed' },
      ]);
      expect(new Set(sharedRecords.map((record) => record.destinationMessageId))).toEqual(
        new Set([firstRunMessageId])
      );
    }
  );

  it.each<{
    name: string;
    kind: RuntimeDeliveryDestinationRef['kind'];
    to: RuntimeDeliveryEnvelope['to'];
  }>([
    { name: 'member inbox', kind: 'member_inbox', to: { memberName: 'Reviewer' } },
    { name: 'user sent messages', kind: 'user_sent_messages', to: 'user' },
    {
      name: 'cross-team outbox',
      kind: 'cross_team_outbox',
      to: { teamName: 'team-b', memberName: 'Reviewer' },
    },
  ])(
    'dedupes committed $name delivery across run/session relaunch and keeps fresh keys live',
    async ({ kind, to }) => {
      destination = new FakeDestinationPort(kind);
      const service = createService();
      const firstMessage = envelope({ idempotencyKey: 'shared-delivery', to });

      const firstAck = await service.deliver(firstMessage);
      expect(firstAck).toMatchObject({ ok: true, delivered: true, reason: null });
      if (!firstAck.ok) {
        throw new Error('Expected initial delivery to commit');
      }
      const originalLocation = firstAck.location;

      runState.currentRunId = 'run-2';
      const relaunchedRetry = envelope({
        idempotencyKey: ' shared-delivery ',
        runId: 'run-2',
        teamName: ' team-a ',
        runtimeSessionId: 'session-2',
        to,
      });
      await expect(service.deliver(relaunchedRetry)).resolves.toEqual({
        ok: true,
        delivered: false,
        reason: 'duplicate',
        idempotencyKey: 'shared-delivery',
        location: originalLocation,
      });
      expect(destination.writeCalls).toBe(1);
      expect(destination.verifyInputs).toHaveLength(4);

      await expect(
        service.deliver({ ...relaunchedRetry, text: 'Changed logical payload' })
      ).resolves.toMatchObject({
        ok: false,
        delivered: false,
        reason: 'idempotency_conflict',
      });
      expect(destination.writeCalls).toBe(1);
      expect(destination.verifyInputs).toHaveLength(4);

      await expect(
        service.deliver({ ...relaunchedRetry, idempotencyKey: 'fresh-delivery' })
      ).resolves.toMatchObject({
        ok: true,
        delivered: true,
        reason: null,
      });
      expect(destination.writeCalls).toBe(2);
    }
  );

  it.each(['pending', 'failed_retryable'] as const)(
    'resumes pre-refactor %s journal hashed with legacy string taskRefs',
    async (status) => {
      const message = envelope();
      const legacyMessage = {
        ...message,
        taskRefs: ['task-1'],
      } as unknown as RuntimeDeliveryEnvelope;
      await writeVersionedJournalEntries(path.join(tempDir, 'delivery-journal.json'), [
        {
          idempotencyKey: message.idempotencyKey,
          payloadHash: hashRuntimeDeliveryEnvelopeLegacyTransport(legacyMessage),
          runId: message.runId,
          teamName: message.teamName,
          fromMemberName: message.fromMemberName,
          providerId: message.providerId,
          runtimeSessionId: message.runtimeSessionId,
          destination: resolveRuntimeDeliveryDestination(message),
          destinationMessageId: buildRuntimeDestinationMessageId(message),
          committedLocation: null,
          status,
          attempts: 1,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          committedAt: null,
          lastError: status === 'failed_retryable' ? 'simulated retryable failure' : null,
        },
      ]);
      journal = createRuntimeDeliveryJournalStore({
        filePath: path.join(tempDir, 'delivery-journal.json'),
        clock: () => now,
      });
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
        logicalPayloadHash: hashRuntimeDeliveryEnvelope(message),
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

  it('fails closed for a legacy committed record without a trustworthy logical hash', async () => {
    const original = envelope({ idempotencyKey: 'legacy-committed-key' });
    const originalDestination = resolveRuntimeDeliveryDestination(original);
    const originalMessageId = buildRuntimeDestinationMessageId(original);
    const originalLocation = locationForDestination(originalDestination, originalMessageId);
    await writeVersionedJournalEntries(path.join(tempDir, 'delivery-journal.json'), [
      {
        idempotencyKey: original.idempotencyKey,
        runId: original.runId,
        teamName: original.teamName,
        fromMemberName: original.fromMemberName,
        providerId: original.providerId,
        runtimeSessionId: original.runtimeSessionId,
        payloadHash: hashRuntimeDeliveryEnvelopeLegacyTransport(original),
        destination: originalDestination,
        destinationMessageId: originalMessageId,
        committedLocation: originalLocation,
        status: 'committed',
        attempts: 1,
        createdAt: original.createdAt,
        updatedAt: original.createdAt,
        committedAt: original.createdAt,
        lastError: null,
      },
    ]);
    journal = createRuntimeDeliveryJournalStore({
      filePath: path.join(tempDir, 'delivery-journal.json'),
      clock: () => now,
    });
    runState.currentRunId = 'run-2';
    const service = createService();

    await expect(
      service.deliver({ ...original, runId: 'run-2', runtimeSessionId: 'session-2' })
    ).resolves.toMatchObject({
      ok: false,
      delivered: false,
      reason: 'idempotency_conflict',
    });

    expect(destination.writeCalls).toBe(0);
    expect(destination.verifyInputs).toHaveLength(0);
    await expect(journal.get(journalKey(original))).resolves.toMatchObject({
      status: 'committed',
      logicalPayloadHash: null,
      committedLocation: originalLocation,
    });
  });

  it.each([
    { label: 'lead alias', memberName: 'lead' },
    { label: 'member-name case', memberName: 'captain' },
  ])(
    'accepts an exact retry of a pre-upgrade committed receipt hashed with raw $label after restart',
    async ({ memberName }) => {
      const original = envelope({
        idempotencyKey: `legacy-${memberName}`,
        to: { teamName: 'team-b', memberName },
      });
      const originalDestination = resolveRuntimeDeliveryDestination(original);
      const originalLocation = locationForDestination(
        originalDestination,
        buildRuntimeDestinationMessageId(original)
      );
      await writeVersionedJournalEntries(path.join(tempDir, 'delivery-journal.json'), [
        {
          kind: 'committed_receipt',
          idempotencyKey: original.idempotencyKey,
          teamName: original.teamName,
          logicalPayloadHash: hashRuntimeDeliveryEnvelope(original),
          committedLocation: originalLocation,
          committedAt: now.toISOString(),
        },
      ]);

      now = new Date('2026-04-21T12:06:00.000Z');
      journal = createRuntimeDeliveryJournalStore({
        filePath: path.join(tempDir, 'delivery-journal.json'),
        clock: () => now,
      });
      destination = new FakeDestinationPort('cross_team_outbox');
      runState.currentRunId = 'run-2';
      const service = createService(createCaptainCanonicalizer());

      await expect(
        service.deliver({ ...original, runId: 'run-2', runtimeSessionId: 'session-2' })
      ).resolves.toEqual({
        ok: true,
        delivered: false,
        reason: 'duplicate',
        idempotencyKey: original.idempotencyKey,
        location: originalLocation,
      });
      expect(destination.writeCalls).toBe(0);
      expect(destination.verifyInputs).toHaveLength(0);
      expect(diagnostics.append).not.toHaveBeenCalled();
    }
  );

  it.each([
    { status: 'pending' as const, memberName: 'lead', verified: true },
    { status: 'failed_retryable' as const, memberName: 'captain', verified: false },
  ])(
    'does not let a prematurely canonicalized $status $memberName row bypass old-message recovery when proof=$verified',
    async ({ status, memberName, verified }) => {
      const original = envelope({
        idempotencyKey: `partial-upgrade-${status}-${memberName}`,
        to: { teamName: 'team-b', memberName },
      });
      const canonical = {
        ...original,
        to: { teamName: 'team-b', memberName: 'Captain' },
      } satisfies RuntimeDeliveryEnvelope;
      const canonicalHash = hashRuntimeDeliveryEnvelope(canonical);
      await writePreCanonicalRuntimeRecord(original, status, {
        payloadHash: canonicalHash,
        logicalPayloadHash: canonicalHash,
      });
      destination = new FakeDestinationPort('cross_team_outbox');
      const oldDestination = resolveRuntimeDeliveryDestination(original);
      const oldMessageId = buildRuntimeDestinationMessageId(original);
      if (verified) {
        destination.messages.set(
          oldMessageId,
          locationForDestination(oldDestination, oldMessageId)
        );
      }
      now = new Date('2026-04-21T12:06:00.000Z');
      journal = createRuntimeDeliveryJournalStore({
        filePath: path.join(tempDir, 'delivery-journal.json'),
        clock: () => now,
      });
      runState.currentRunId = 'run-2';
      const service = createService(createCaptainCanonicalizer());

      await expect(
        service.deliver({ ...original, runId: 'run-2', runtimeSessionId: 'session-2' })
      ).resolves.toMatchObject(
        verified
          ? { ok: true, delivered: false, reason: 'duplicate_destination_found' }
          : { ok: false, delivered: false, reason: 'idempotency_conflict' }
      );
      expect(destination.writeCalls).toBe(0);
      expect(destination.verifyInputs).toHaveLength(verified ? 3 : 1);
    }
  );

  it.each([
    { status: 'pending' as const, memberName: 'lead' },
    { status: 'pending' as const, memberName: 'captain' },
    { status: 'failed_retryable' as const, memberName: 'lead' },
    { status: 'failed_retryable' as const, memberName: 'captain' },
    { status: 'failed_terminal' as const, memberName: 'lead' },
    { status: 'failed_terminal' as const, memberName: 'captain' },
  ])(
    'recovers a verified pre-canonical $status $memberName destination after relaunch without writing',
    async ({ status, memberName }) => {
      const original = envelope({
        idempotencyKey: `recover-${status}-${memberName}`,
        to: { teamName: 'team-b', memberName },
      });
      const originalDestination = resolveRuntimeDeliveryDestination(original);
      const originalMessageId = buildRuntimeDestinationMessageId(original);
      await writePreCanonicalRuntimeRecord(original, status);
      destination = new FakeDestinationPort('cross_team_outbox');
      destination.messages.set(
        originalMessageId,
        locationForDestination(originalDestination, originalMessageId)
      );

      now = new Date('2026-04-21T12:06:00.000Z');
      journal = createRuntimeDeliveryJournalStore({
        filePath: path.join(tempDir, 'delivery-journal.json'),
        clock: () => now,
      });
      runState.currentRunId = 'run-2';
      const retry = {
        ...original,
        runId: 'run-2',
        runtimeSessionId: 'session-2',
      };
      const canonicalRetry = {
        ...retry,
        to: { teamName: 'team-b', memberName: 'Captain' },
      } satisfies RuntimeDeliveryEnvelope;
      const service = createService(createCaptainCanonicalizer());

      await expect(service.deliver(retry)).resolves.toEqual({
        ok: true,
        delivered: false,
        reason: 'duplicate_destination_found',
        idempotencyKey: original.idempotencyKey,
        location: locationForDestination(originalDestination, originalMessageId),
      });
      expect(destination.writeCalls).toBe(0);
      expect(destination.verifyInputs[0]).toMatchObject({
        destination: originalDestination,
        destinationMessageId: originalMessageId,
      });
      const records = await journal.list();
      expect(records).toMatchObject([
        {
          runId: 'run-2',
          status: 'committed',
          payloadHash: hashRuntimeDeliveryEnvelope(canonicalRetry),
          logicalPayloadHash: hashRuntimeDeliveryEnvelope(canonicalRetry),
          destination: {
            kind: 'cross_team_outbox',
            toMemberName: 'Captain',
          },
          destinationMessageId: buildRuntimeDestinationMessageId(canonicalRetry),
          committedLocation: { messageId: originalMessageId },
        },
      ]);

      await expect(service.deliver(retry)).resolves.toMatchObject({
        ok: true,
        delivered: false,
        reason: 'duplicate',
      });
      expect(destination.writeCalls).toBe(0);
    }
  );

  it.each([
    { status: 'pending' as const, memberName: 'lead' },
    { status: 'failed_retryable' as const, memberName: 'captain' },
    { status: 'failed_terminal' as const, memberName: 'lead' },
  ])(
    'fails closed when pre-canonical $status $memberName destination proof is absent after relaunch',
    async ({ status, memberName }) => {
      const original = envelope({
        idempotencyKey: `missing-${status}-${memberName}`,
        to: { teamName: 'team-b', memberName },
      });
      await writePreCanonicalRuntimeRecord(original, status);
      destination = new FakeDestinationPort('cross_team_outbox');
      now = new Date('2026-04-21T12:06:00.000Z');
      journal = createRuntimeDeliveryJournalStore({
        filePath: path.join(tempDir, 'delivery-journal.json'),
        clock: () => now,
      });
      runState.currentRunId = 'run-2';
      const retry = { ...original, runId: 'run-2', runtimeSessionId: 'session-2' };
      const service = createService(createCaptainCanonicalizer());

      await expect(service.deliver(retry)).resolves.toMatchObject({
        ok: false,
        delivered: false,
        reason: 'idempotency_conflict',
      });
      await expect(service.deliver(retry)).resolves.toMatchObject({
        ok: false,
        delivered: false,
        reason: 'idempotency_conflict',
      });
      expect(destination.writeCalls).toBe(0);
      expect(destination.verifyInputs).toHaveLength(2);
      expect(diagnostics.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'runtime_delivery_conflict',
          message:
            'Pre-canonical runtime delivery could not be verified at its persisted destination',
        })
      );
    }
  );

  it.each(['pending', 'failed_retryable', 'failed_terminal'] as const)(
    'rejects changed payload and target for pre-canonical %s records before recovery',
    async (status) => {
      const original = envelope({
        idempotencyKey: `changed-pre-canonical-${status}`,
        to: { teamName: 'team-b', memberName: 'lead' },
      });
      await writePreCanonicalRuntimeRecord(original, status);
      destination = new FakeDestinationPort('cross_team_outbox');
      journal = createRuntimeDeliveryJournalStore({
        filePath: path.join(tempDir, 'delivery-journal.json'),
        clock: () => now,
      });
      runState.currentRunId = 'run-2';
      const service = createService(createCaptainCanonicalizer());

      await expect(
        service.deliver({
          ...original,
          runId: 'run-2',
          runtimeSessionId: 'session-2',
          text: 'changed payload',
        })
      ).resolves.toMatchObject({ ok: false, reason: 'idempotency_conflict' });
      await expect(
        service.deliver({
          ...original,
          runId: 'run-2',
          runtimeSessionId: 'session-2',
          to: { teamName: 'team-b', memberName: 'Reviewer' },
        })
      ).resolves.toMatchObject({ ok: false, reason: 'idempotency_conflict' });
      expect(destination.verifyInputs).toHaveLength(0);
      expect(destination.writeCalls).toBe(0);
    }
  );

  it('rejects a pre-canonical pending record without a trustworthy logical hash', async () => {
    const original = envelope({
      idempotencyKey: 'pre-canonical-missing-logical-proof',
      to: { teamName: 'team-b', memberName: 'lead' },
    });
    await writePreCanonicalRuntimeRecord(original, 'pending', { logicalPayloadHash: null });
    destination = new FakeDestinationPort('cross_team_outbox');
    journal = createRuntimeDeliveryJournalStore({
      filePath: path.join(tempDir, 'delivery-journal.json'),
      clock: () => now,
    });
    runState.currentRunId = 'run-2';

    await expect(
      createService(createCaptainCanonicalizer()).deliver({
        ...original,
        runId: 'run-2',
        runtimeSessionId: 'session-2',
      })
    ).resolves.toMatchObject({ ok: false, reason: 'idempotency_conflict' });
    expect(destination.verifyInputs).toHaveLength(0);
    expect(destination.writeCalls).toBe(0);
  });

  it.each([
    {
      status: 'pending' as const,
      memberName: 'lead',
      senderAvailable: true,
      verified: true,
    },
    {
      status: 'failed_retryable' as const,
      memberName: 'captain',
      senderAvailable: false,
      verified: true,
    },
    {
      status: 'pending' as const,
      memberName: 'captain',
      senderAvailable: true,
      verified: false,
    },
    {
      status: 'failed_retryable' as const,
      memberName: 'lead',
      senderAvailable: false,
      verified: false,
    },
  ])(
    'uses durable old-message proof for $status $memberName with sender available=$senderAvailable and proof=$verified',
    async ({ status, memberName, senderAvailable, verified }) => {
      const original = envelope({
        idempotencyKey: `durable-${status}-${memberName}-${String(senderAvailable)}-${String(verified)}`,
        to: { teamName: 'team-b', memberName },
      });
      const oldMessageId = buildRuntimeDestinationMessageId(original);
      await writePreCanonicalRuntimeRecord(original, status);
      now = new Date('2026-04-21T12:06:00.000Z');
      journal = createRuntimeDeliveryJournalStore({
        filePath: path.join(tempDir, 'delivery-journal.json'),
        clock: () => now,
      });
      runState.currentRunId = 'run-2';
      const crossTeamSender = vi.fn(() =>
        Promise.resolve({
          messageId: oldMessageId,
          deliveredToInbox: true,
          toTeam: 'team-b',
          toMember: 'Captain',
        })
      );
      const acceptedMessage: CrossTeamOutboxMessage = {
        messageId: oldMessageId,
        fromTeam: 'team-a',
        fromMember: original.fromMemberName,
        toTeam: 'team-b',
        toMember: 'Captain',
        conversationId: original.idempotencyKey,
        text: original.text,
        taskRefs: original.taskRefs,
        chainDepth: 0,
        timestamp: original.createdAt,
        runtimeDeliveryAcceptedAt: original.createdAt,
      };
      const findAcceptedRuntimeDelivery = vi.fn(() =>
        Promise.resolve(verified ? acceptedMessage : null)
      );
      const ports = createOpenCodeRuntimeDeliveryPorts({
        sentMessagesStore: {
          appendMessage: vi.fn(),
          readMessages: vi.fn(() => Promise.resolve([])),
        },
        inboxReader: { getMessagesFor: vi.fn(() => Promise.resolve([])) },
        inboxWriter: { sendMessage: vi.fn() },
        getCrossTeamSender: () => (senderAvailable ? crossTeamSender : null),
        crossTeamOutbox: { findAcceptedRuntimeDelivery },
      });
      const service = new RuntimeDeliveryService(
        runState,
        journal,
        new RuntimeDeliveryDestinationRegistry(ports),
        diagnostics,
        emitter,
        () => now,
        createCaptainCanonicalizer()
      );
      const retry = { ...original, runId: 'run-2', runtimeSessionId: 'session-2' };

      await expect(service.deliver(retry)).resolves.toMatchObject(
        verified
          ? {
              ok: true,
              delivered: false,
              reason: 'duplicate_destination_found',
              location: { toMemberName: 'Captain', messageId: oldMessageId },
            }
          : { ok: false, delivered: false, reason: 'idempotency_conflict' }
      );
      expect(findAcceptedRuntimeDelivery).toHaveBeenCalledWith(
        'team-a',
        expect.objectContaining({
          messageId: oldMessageId,
          toMember: 'Captain',
          conversationId: original.idempotencyKey,
        })
      );
      expect(crossTeamSender).not.toHaveBeenCalled();
    }
  );

  it('recovers an accepted pre-canonical sender-case alias without redelivery', async () => {
    const original = envelope({
      idempotencyKey: 'durable-sender-case-alias',
      fromMemberName: 'builder',
      to: { teamName: 'team-b', memberName: 'Captain' },
    });
    const oldMessageId = buildRuntimeDestinationMessageId(original);
    await writePreCanonicalRuntimeRecord(original, 'failed_retryable');
    now = new Date('2026-04-21T12:06:00.000Z');
    journal = createRuntimeDeliveryJournalStore({
      filePath: path.join(tempDir, 'delivery-journal.json'),
      clock: () => now,
    });
    runState.currentRunId = 'run-2';
    const acceptedMessage: CrossTeamOutboxMessage = {
      messageId: oldMessageId,
      fromTeam: 'team-a',
      fromMember: 'Builder',
      toTeam: 'team-b',
      toMember: 'Captain',
      conversationId: original.idempotencyKey,
      text: original.text,
      taskRefs: original.taskRefs,
      chainDepth: 0,
      timestamp: original.createdAt,
      runtimeDeliveryAcceptedAt: original.createdAt,
    };
    const findAcceptedRuntimeDelivery = vi.fn(
      (_teamName: string, expected: CrossTeamRuntimeDeliveryProofInput) =>
        Promise.resolve(
          expected.fromMember === 'Builder' && expected.text === original.text
            ? acceptedMessage
            : null
        )
    );
    const crossTeamSender = vi.fn();
    const ports = createOpenCodeRuntimeDeliveryPorts({
      sentMessagesStore: {
        appendMessage: vi.fn(),
        readMessages: vi.fn(() => Promise.resolve([])),
      },
      inboxReader: { getMessagesFor: vi.fn(() => Promise.resolve([])) },
      inboxWriter: { sendMessage: vi.fn() },
      getCrossTeamSender: () => crossTeamSender,
      crossTeamOutbox: { findAcceptedRuntimeDelivery },
    });
    const service = new RuntimeDeliveryService(
      runState,
      journal,
      new RuntimeDeliveryDestinationRegistry(ports),
      diagnostics,
      emitter,
      () => now,
      createCaptainCanonicalizer()
    );

    await expect(
      service.deliver({
        ...original,
        runId: 'run-2',
        runtimeSessionId: 'session-2',
        fromMemberName: 'BUILDER',
      })
    ).resolves.toMatchObject({
      ok: true,
      delivered: false,
      reason: 'duplicate_destination_found',
      location: { toMemberName: 'Captain', messageId: oldMessageId },
    });
    expect(findAcceptedRuntimeDelivery).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({ fromMember: 'Builder', messageId: oldMessageId })
    );
    expect(crossTeamSender).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'migrates a committed pre-canonical sender alias only with exact destination proof=%s',
    async (verified) => {
      destination = new FakeDestinationPort('cross_team_outbox');
      const original = envelope({
        idempotencyKey: `committed-sender-alias-${verified}`,
        fromMemberName: 'builder',
        to: { teamName: 'team-b', memberName: 'Captain' },
      });
      const originalService = createService();
      await expect(originalService.deliver(original)).resolves.toMatchObject({
        ok: true,
        delivered: true,
      });
      expect(destination.writeCalls).toBe(1);
      if (!verified) {
        destination.messages.clear();
      }

      now = new Date('2026-04-21T12:06:00.000Z');
      journal = createRuntimeDeliveryJournalStore({
        filePath: path.join(tempDir, 'delivery-journal.json'),
        clock: () => now,
      });
      runState.currentRunId = 'run-2';
      const restartedService = createService(createCaptainCanonicalizer());
      const retry = {
        ...original,
        runId: 'run-2',
        runtimeSessionId: 'session-2',
        fromMemberName: 'BUILDER',
      };

      await expect(restartedService.deliver(retry)).resolves.toMatchObject(
        verified
          ? { ok: true, delivered: false, reason: 'duplicate_destination_found' }
          : { ok: false, delivered: false, reason: 'idempotency_conflict' }
      );
      expect(destination.writeCalls).toBe(1);
      if (verified) {
        await expect(journal.get(journalKey(retry))).resolves.toMatchObject({
          status: 'committed',
          fromMemberName: 'Builder',
          logicalPayloadHash: hashRuntimeDeliveryEnvelope({
            ...retry,
            fromMemberName: 'Builder',
          }),
        });
      }
    }
  );

  it('writes canonical logical receipts and reuses them across aliases after restart', async () => {
    destination = new FakeDestinationPort('cross_team_outbox');
    const first = envelope({
      idempotencyKey: 'canonical-recipient',
      to: { teamName: 'team-b', memberName: 'lead' },
    });
    const service = createService(createCaptainCanonicalizer());

    await expect(service.deliver(first)).resolves.toMatchObject({
      ok: true,
      delivered: true,
      reason: null,
      location: { kind: 'cross_team_outbox', toMemberName: 'Captain' },
    });
    await expect(journal.get(journalKey(first))).resolves.toMatchObject({
      logicalPayloadHash: hashRuntimeDeliveryEnvelope({
        ...first,
        to: { teamName: 'team-b', memberName: 'Captain' },
      }),
      destination: { kind: 'cross_team_outbox', toMemberName: 'Captain' },
    });

    now = new Date('2026-04-21T12:06:00.000Z');
    journal = createRuntimeDeliveryJournalStore({
      filePath: path.join(tempDir, 'delivery-journal.json'),
      clock: () => now,
    });
    runState.currentRunId = 'run-2';
    const restartedService = createService(createCaptainCanonicalizer());

    await expect(
      restartedService.deliver({
        ...first,
        runId: 'run-2',
        runtimeSessionId: 'session-2',
        to: { teamName: 'team-b', memberName: 'cApTaIn' },
      })
    ).resolves.toMatchObject({
      ok: true,
      delivered: false,
      reason: 'duplicate',
      location: { kind: 'cross_team_outbox', toMemberName: 'Captain' },
    });
    expect(destination.writeCalls).toBe(1);
    expect(destination.verifyInputs).toHaveLength(4);
  });

  it('rejects a genuinely different payload against a compatible pre-upgrade alias receipt', async () => {
    const original = envelope({
      idempotencyKey: 'legacy-alias-conflict',
      to: { teamName: 'team-b', memberName: 'lead' },
    });
    const originalDestination = resolveRuntimeDeliveryDestination(original);
    await writeVersionedJournalEntries(path.join(tempDir, 'delivery-journal.json'), [
      {
        kind: 'committed_receipt',
        idempotencyKey: original.idempotencyKey,
        teamName: original.teamName,
        logicalPayloadHash: hashRuntimeDeliveryEnvelope(original),
        committedLocation: locationForDestination(
          originalDestination,
          buildRuntimeDestinationMessageId(original)
        ),
        committedAt: now.toISOString(),
      },
    ]);
    journal = createRuntimeDeliveryJournalStore({
      filePath: path.join(tempDir, 'delivery-journal.json'),
      clock: () => now,
    });
    destination = new FakeDestinationPort('cross_team_outbox');
    runState.currentRunId = 'run-2';
    const service = createService(createCaptainCanonicalizer());

    await expect(
      service.deliver({
        ...original,
        runId: 'run-2',
        runtimeSessionId: 'session-2',
        text: 'genuinely different payload',
      })
    ).resolves.toMatchObject({
      ok: false,
      delivered: false,
      reason: 'idempotency_conflict',
    });
    expect(destination.writeCalls).toBe(0);
    expect(destination.verifyInputs).toHaveLength(0);
    expect(diagnostics.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'runtime_delivery_conflict', severity: 'error' })
    );
  });

  it('retains the first committed receipt beyond the 512 full-record boundary', async () => {
    const firstMessage = envelope({ idempotencyKey: 'boundary-key-0' });
    const firstLocation = locationForDestination(
      resolveRuntimeDeliveryDestination(firstMessage),
      buildRuntimeDestinationMessageId(firstMessage)
    );
    const committedRecords = Array.from({ length: 513 }, (_, index) => {
      const message = envelope({ idempotencyKey: `boundary-key-${index}` });
      const destinationRef = resolveRuntimeDeliveryDestination(message);
      const destinationMessageId = buildRuntimeDestinationMessageId(message);
      return {
        idempotencyKey: message.idempotencyKey,
        payloadHash: hashRuntimeDeliveryEnvelope(message),
        logicalPayloadHash: hashRuntimeDeliveryEnvelope(message),
        runId: message.runId,
        teamName: message.teamName,
        fromMemberName: message.fromMemberName,
        providerId: message.providerId,
        runtimeSessionId: message.runtimeSessionId,
        destination: destinationRef,
        destinationMessageId,
        committedLocation: locationForDestination(destinationRef, destinationMessageId),
        status: 'committed',
        attempts: 1,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        committedAt: now.toISOString(),
        lastError: null,
      };
    });
    await writeVersionedJournalEntries(
      path.join(tempDir, 'delivery-journal.json'),
      committedRecords
    );
    journal = createRuntimeDeliveryJournalStore({
      filePath: path.join(tempDir, 'delivery-journal.json'),
      clock: () => now,
    });
    const triggerMessage = envelope({ idempotencyKey: 'boundary-prune-trigger' });
    await journal.begin({
      idempotencyKey: triggerMessage.idempotencyKey,
      payloadHash: hashRuntimeDeliveryEnvelope(triggerMessage),
      runId: triggerMessage.runId,
      teamName: triggerMessage.teamName,
      fromMemberName: triggerMessage.fromMemberName,
      providerId: triggerMessage.providerId,
      runtimeSessionId: triggerMessage.runtimeSessionId,
      destination: resolveRuntimeDeliveryDestination(triggerMessage),
      destinationMessageId: buildRuntimeDestinationMessageId(triggerMessage),
      now: now.toISOString(),
    });

    await expect(journal.get(journalKey(firstMessage))).resolves.toBeNull();
    await expect(journal.list()).resolves.toHaveLength(513);

    journal = createRuntimeDeliveryJournalStore({
      filePath: path.join(tempDir, 'delivery-journal.json'),
      clock: () => now,
    });
    destination = new FakeDestinationPort('member_inbox');
    runState.currentRunId = 'run-2';
    const service = createService();

    await expect(
      service.deliver({ ...firstMessage, runId: 'run-2', runtimeSessionId: 'session-2' })
    ).resolves.toEqual({
      ok: true,
      delivered: false,
      reason: 'duplicate',
      idempotencyKey: 'boundary-key-0',
      location: firstLocation,
    });
    expect(destination.writeCalls).toBe(0);
    expect(destination.verifyInputs).toHaveLength(0);
  });

  it('permits one destination write for concurrent retries from different runtime sessions', async () => {
    const firstService = createService();
    const secondService = createService();

    const acknowledgements = await Promise.all([
      firstService.deliver(envelope({ runtimeSessionId: 'session-a' })),
      secondService.deliver(envelope({ runtimeSessionId: 'session-b' })),
    ]);

    expect(acknowledgements).toEqual([
      expect.objectContaining({ ok: true, delivered: true, reason: null }),
      expect.objectContaining({ ok: true, delivered: false, reason: 'duplicate' }),
    ]);
    expect(destination.writeCalls).toBe(1);
    expect(destination.messages).toHaveLength(1);
    await expect(journal.list()).resolves.toHaveLength(1);
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
    destination.writeImpl = (input) => {
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
      return Promise.resolve(location);
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
    expect(crossTeamSender).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'delivery-1' })
    );
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

  it('keeps cross-team delivery retryable when the sender does not confirm delivery', async () => {
    const crossTeamEnvelope = envelope({
      to: { teamName: 'team-b', memberName: 'Reviewer' },
    });
    const destinationMessageId = buildRuntimeDestinationMessageId(crossTeamEnvelope);
    const crossTeamSender = vi.fn(() =>
      Promise.resolve({
        messageId: destinationMessageId,
        deliveredToInbox: false,
      })
    );
    const service = new RuntimeDeliveryService(
      runState,
      journal,
      new RuntimeDeliveryDestinationRegistry(
        createOpenCodeRuntimeDeliveryPorts({
          sentMessagesStore: {
            appendMessage: vi.fn(),
            readMessages: vi.fn(() => Promise.resolve([])),
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

    await expect(service.deliver(crossTeamEnvelope)).rejects.toThrow(
      'Cross-team runtime sender did not return a confirmed delivery result'
    );

    expect(crossTeamSender).toHaveBeenCalledTimes(1);
    await expect(journal.get(journalKey(crossTeamEnvelope))).resolves.toMatchObject({
      status: 'failed_retryable',
      attempts: 1,
      committedLocation: null,
      lastError: 'Cross-team runtime sender did not return a confirmed delivery result',
    });
  });

  it('requires target-runtime proof even when an exact cross-team sender copy exists', async () => {
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
    expect(crossTeamSender).toHaveBeenCalledOnce();
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
  it('hashes logical delivery fields while excluding run and runtime-session transport identity', () => {
    const original = normalizeRuntimeDeliveryEnvelope(envelope({ summary: 'Review requested' }));
    const relaunched = normalizeRuntimeDeliveryEnvelope({
      ...original,
      runId: 'run-2',
      runtimeSessionId: 'session-2',
    });

    expect(hashRuntimeDeliveryEnvelope(relaunched)).toBe(hashRuntimeDeliveryEnvelope(original));
    for (const changedPayload of [
      { ...original, to: 'user' as const },
      { ...original, fromMemberName: 'Architect' },
      { ...original, text: 'Different content' },
      { ...original, summary: 'Different summary' },
      {
        ...original,
        taskRefs: [{ taskId: 'task-2', displayId: '#2', teamName: 'team-a' }],
      },
      { ...original, createdAt: '2026-04-21T12:00:01.000Z' },
    ]) {
      expect(hashRuntimeDeliveryEnvelope(changedPayload)).not.toBe(
        hashRuntimeDeliveryEnvelope(original)
      );
    }
  });

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
  it('rolls non-canonical reconciliation back when destination visibility disappears during commit', async () => {
    const message = envelope({ idempotencyKey: 'ordinary-reconciliation-race' });
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
    destination.messages.set(
      destinationMessageId,
      locationForDestination(destinationRef, destinationMessageId)
    );
    const verifyDestination = destination.verify.bind(destination);
    let verificationCount = 0;
    vi.spyOn(destination, 'verify').mockImplementation(async (input) => {
      verificationCount += 1;
      if (verificationCount === 3) {
        destination.messages.delete(destinationMessageId);
        return { found: false, location: null, diagnostics: ['destination disappeared'] };
      }
      return verifyDestination(input);
    });
    const reconciler = new RuntimeDeliveryReconciler(
      journal,
      new RuntimeDeliveryDestinationRegistry([destination]),
      diagnostics,
      () => now
    );

    await reconciler.reconcileTeam(message.teamName);

    expect(verificationCount).toBe(3);
    await expect(journal.get(journalKey(message))).resolves.toMatchObject({
      status: 'pending',
      committedLocation: null,
      committedAt: null,
      lastError: null,
    });
    expect(diagnostics.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'runtime_delivery_recovery_needed',
        data: expect.objectContaining({
          diagnostics: expect.arrayContaining([
            expect.stringContaining('journal is not committed'),
          ]),
        }),
      })
    );
  });

  it('persists the canonical sender and hash when recovery resolves semantic lead aliases', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'opencode-runtime-delivery-reconcile-alias-')
    );
    try {
      const recoveryNow = new Date('2026-04-21T12:00:00.000Z');
      const journalPath = path.join(directory, 'delivery-journal.json');
      let recoveryJournal = createRuntimeDeliveryJournalStore({
        filePath: journalPath,
        clock: () => recoveryNow,
      });
      const original = envelope({
        idempotencyKey: 'reconciled-sender-alias',
        teamName: 'Team',
        fromMemberName: 'lead',
        to: 'user',
      });
      const destinationMessageId = buildRuntimeDestinationMessageId(original);
      await recoveryJournal.begin({
        idempotencyKey: original.idempotencyKey,
        payloadHash: hashRuntimeDeliveryEnvelope(original),
        runId: original.runId,
        teamName: original.teamName,
        fromMemberName: original.fromMemberName,
        providerId: original.providerId,
        runtimeSessionId: original.runtimeSessionId,
        destination: resolveRuntimeDeliveryDestination(original),
        destinationMessageId,
        now: recoveryNow.toISOString(),
      });

      const persistedMessages: InboxMessage[] = [
        {
          from: original.fromMemberName,
          to: 'user',
          text: original.text,
          timestamp: original.createdAt,
          read: true,
          messageId: destinationMessageId,
          source: 'lead_process',
          leadSessionId: original.runtimeSessionId,
          taskRefs: original.taskRefs,
        },
      ];
      const appendMessage = vi.fn();
      const ports = createOpenCodeRuntimeDeliveryPorts({
        sentMessagesStore: {
          appendMessage,
          readMessages: vi.fn(() => Promise.resolve(persistedMessages)),
        },
        inboxReader: { getMessagesFor: vi.fn(() => Promise.resolve([])) },
        inboxWriter: { sendMessage: vi.fn() },
        getCrossTeamSender: () => null,
      });
      const readMetaMembers = () => Promise.resolve([]);
      const reconciler = new RuntimeDeliveryReconciler(
        recoveryJournal,
        new RuntimeDeliveryDestinationRegistry(ports),
        new FakeDiagnosticsSink(),
        () => recoveryNow,
        {
          canonicalize: (record) =>
            canonicalizeRuntimeDeliveryJournalRecordIdentities(
              record,
              readBuilderLeadConfig,
              readMetaMembers
            ),
        }
      );

      await reconciler.reconcileTeam(original.teamName);

      const canonicalOriginal = await canonicalizeRuntimeDeliveryCrossTeamIdentities(
        original,
        readBuilderLeadConfig,
        readMetaMembers
      );
      await expect(recoveryJournal.get(journalKey(original))).resolves.toMatchObject({
        status: 'committed',
        fromMemberName: 'Builder',
        payloadHash: hashRuntimeDeliveryEnvelope(canonicalOriginal),
        logicalPayloadHash: hashRuntimeDeliveryEnvelope(canonicalOriginal),
      });

      recoveryJournal = createRuntimeDeliveryJournalStore({
        filePath: journalPath,
        clock: () => recoveryNow,
      });
      const delivery = new RuntimeDeliveryService(
        new FakeRunStateReader(original.runId),
        recoveryJournal,
        new RuntimeDeliveryDestinationRegistry(ports),
        new FakeDiagnosticsSink(),
        new FakeTeamChangeEmitter(),
        () => recoveryNow,
        {
          canonicalize: (message) =>
            canonicalizeRuntimeDeliveryCrossTeamIdentities(
              message,
              readBuilderLeadConfig,
              readMetaMembers
            ),
        }
      );

      await expect(
        delivery.deliver({ ...original, fromMemberName: 'team-lead' })
      ).resolves.toMatchObject({
        ok: true,
        delivered: false,
        reason: 'duplicate',
      });
      expect(appendMessage).not.toHaveBeenCalled();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a verifier-forged canonical hash when persisted payload evidence does not bind', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'opencode-runtime-delivery-reconcile-forged-proof-')
    );
    try {
      const recoveryNow = new Date('2026-04-21T12:00:00.000Z');
      const recoveryJournal = createRuntimeDeliveryJournalStore({
        filePath: path.join(directory, 'delivery-journal.json'),
        clock: () => recoveryNow,
      });
      const original = envelope({
        idempotencyKey: 'reconciled-sender-forged-proof',
        teamName: 'Team',
        fromMemberName: 'lead',
        to: 'user',
      });
      const originalHash = hashRuntimeDeliveryEnvelope(original);
      const destinationMessageId = buildRuntimeDestinationMessageId(original);
      await recoveryJournal.begin({
        idempotencyKey: original.idempotencyKey,
        payloadHash: originalHash,
        runId: original.runId,
        teamName: original.teamName,
        fromMemberName: original.fromMemberName,
        providerId: original.providerId,
        runtimeSessionId: original.runtimeSessionId,
        destination: resolveRuntimeDeliveryDestination(original),
        destinationMessageId,
        now: recoveryNow.toISOString(),
      });

      const canonical = await canonicalizeRuntimeDeliveryCrossTeamIdentities(
        original,
        readBuilderLeadConfig,
        () => Promise.resolve([])
      );
      const forgedVerify = vi.fn(() =>
        Promise.resolve({
          found: true,
          location: {
            kind: 'user_sent_messages' as const,
            teamName: original.teamName,
            messageId: destinationMessageId,
          },
          diagnostics: [],
          recoveryEvidence: {
            fromMemberName: original.fromMemberName,
            runtimeSessionId: original.runtimeSessionId,
            text: 'forged destination payload',
            createdAt: original.createdAt,
            summary: original.summary ?? null,
            taskRefs: original.taskRefs,
          },
          canonicalPayloadHash: hashRuntimeDeliveryEnvelope(canonical),
        })
      );
      const forgedPort: RuntimeDeliveryDestinationPort = {
        kind: 'user_sent_messages',
        write: vi.fn(),
        verify: forgedVerify,
        buildChangeEvent: () => null,
      };
      const diagnostics = new FakeDiagnosticsSink();
      const reconciler = new RuntimeDeliveryReconciler(
        recoveryJournal,
        new RuntimeDeliveryDestinationRegistry([forgedPort]),
        diagnostics,
        () => recoveryNow,
        {
          canonicalize: (record) =>
            canonicalizeRuntimeDeliveryJournalRecordIdentities(record, readBuilderLeadConfig, () =>
              Promise.resolve([])
            ),
        }
      );

      await reconciler.reconcileTeam(original.teamName);

      expect(forgedVerify).toHaveBeenCalledOnce();
      await expect(recoveryJournal.get(journalKey(original))).resolves.toMatchObject({
        status: 'pending',
        fromMemberName: original.fromMemberName,
        payloadHash: originalHash,
        logicalPayloadHash: originalHash,
        committedLocation: null,
      });
      expect(diagnostics.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'runtime_delivery_recovery_needed',
          data: expect.objectContaining({ canonicalRecoveryEvidenceInvalid: true }),
        })
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('rolls back canonical recovery when destination visibility disappears after precommit proof', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'opencode-runtime-delivery-reconcile-disappearance-')
    );
    try {
      const recoveryNow = new Date('2026-04-21T12:00:00.000Z');
      const recoveryJournal = createRuntimeDeliveryJournalStore({
        filePath: path.join(directory, 'delivery-journal.json'),
        clock: () => recoveryNow,
      });
      const original = envelope({
        idempotencyKey: 'reconciled-sender-alias-disappears',
        teamName: 'Team',
        fromMemberName: 'lead',
        to: 'user',
      });
      const originalHash = hashRuntimeDeliveryEnvelope(original);
      const destinationMessageId = buildRuntimeDestinationMessageId(original);
      await recoveryJournal.begin({
        idempotencyKey: original.idempotencyKey,
        payloadHash: originalHash,
        runId: original.runId,
        teamName: original.teamName,
        fromMemberName: original.fromMemberName,
        providerId: original.providerId,
        runtimeSessionId: original.runtimeSessionId,
        destination: resolveRuntimeDeliveryDestination(original),
        destinationMessageId,
        now: recoveryNow.toISOString(),
      });

      const persistedMessages: InboxMessage[] = [
        {
          from: original.fromMemberName,
          to: 'user',
          text: original.text,
          timestamp: original.createdAt,
          read: true,
          messageId: destinationMessageId,
          source: 'lead_process',
          leadSessionId: original.runtimeSessionId,
          taskRefs: original.taskRefs,
        },
      ];
      const readMessages = vi.fn(() => Promise.resolve([...persistedMessages]));
      const ports = createOpenCodeRuntimeDeliveryPorts({
        sentMessagesStore: { appendMessage: vi.fn(), readMessages },
        inboxReader: { getMessagesFor: vi.fn(() => Promise.resolve([])) },
        inboxWriter: { sendMessage: vi.fn() },
        getCrossTeamSender: () => null,
      });
      const userMessagesPort = ports.find((candidate) => candidate.kind === 'user_sent_messages');
      expect(userMessagesPort).toBeDefined();
      if (!userMessagesPort) {
        return;
      }
      let verificationCount = 0;
      const verify = vi.fn(async (input: Parameters<typeof userMessagesPort.verify>[0]) => {
        verificationCount += 1;
        const result = await userMessagesPort.verify(input);
        if (verificationCount === 2) {
          queueMicrotask(() => persistedMessages.splice(0));
        }
        return result;
      });
      const disappearingPort: RuntimeDeliveryDestinationPort = {
        ...userMessagesPort,
        verify,
      };
      const diagnostics = new FakeDiagnosticsSink();
      const reconciler = new RuntimeDeliveryReconciler(
        recoveryJournal,
        new RuntimeDeliveryDestinationRegistry([disappearingPort]),
        diagnostics,
        () => recoveryNow,
        {
          canonicalize: (record) =>
            canonicalizeRuntimeDeliveryJournalRecordIdentities(record, readBuilderLeadConfig, () =>
              Promise.resolve([])
            ),
        }
      );

      await reconciler.reconcileTeam(original.teamName);

      expect(verify).toHaveBeenCalledTimes(3);
      expect(readMessages).toHaveBeenCalledTimes(3);
      await expect(recoveryJournal.get(journalKey(original))).resolves.toMatchObject({
        status: 'pending',
        fromMemberName: 'lead',
        payloadHash: originalHash,
        logicalPayloadHash: originalHash,
        committedLocation: null,
        committedAt: null,
      });
      expect(diagnostics.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'runtime_delivery_recovery_needed',
          data: expect.objectContaining({
            diagnostics: expect.arrayContaining([
              expect.stringContaining('journal is not committed'),
            ]),
          }),
        })
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

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

function createService(
  recipientCanonicalizer?: RuntimeDeliveryRecipientCanonicalizer
): RuntimeDeliveryService {
  return new RuntimeDeliveryService(
    runState,
    journal,
    new RuntimeDeliveryDestinationRegistry([destination]),
    diagnostics,
    emitter,
    () => now,
    recipientCanonicalizer
  );
}

function createCaptainCanonicalizer(): RuntimeDeliveryRecipientCanonicalizer {
  return {
    canonicalize: (message) => {
      const canonicalMessage =
        message.fromMemberName.trim().toLowerCase() === 'builder'
          ? { ...message, fromMemberName: 'Builder' }
          : message;
      if (message.to === 'user' || !('teamName' in message.to)) {
        return Promise.resolve(canonicalMessage);
      }
      const requestedMember = message.to.memberName.trim().toLowerCase();
      if (
        requestedMember !== 'lead' &&
        requestedMember !== 'team-lead' &&
        requestedMember !== 'captain'
      ) {
        return Promise.resolve(canonicalMessage);
      }
      return Promise.resolve({
        ...canonicalMessage,
        to: { teamName: message.to.teamName, memberName: 'Captain' },
      });
    },
  };
}

async function writePreCanonicalRuntimeRecord(
  message: RuntimeDeliveryEnvelope,
  status: 'pending' | 'failed_retryable' | 'failed_terminal',
  options: { payloadHash?: string; logicalPayloadHash?: string | null } = {}
): Promise<void> {
  const payloadHash = options.payloadHash ?? hashRuntimeDeliveryEnvelope(message);
  await writeVersionedJournalEntries(path.join(tempDir, 'delivery-journal.json'), [
    {
      idempotencyKey: message.idempotencyKey,
      payloadHash,
      logicalPayloadHash:
        options.logicalPayloadHash === undefined ? payloadHash : options.logicalPayloadHash,
      runId: message.runId,
      teamName: message.teamName,
      fromMemberName: message.fromMemberName,
      providerId: message.providerId,
      runtimeSessionId: message.runtimeSessionId,
      destination: resolveRuntimeDeliveryDestination(message),
      destinationMessageId: buildRuntimeDestinationMessageId(message),
      committedLocation: null,
      status,
      attempts: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      committedAt: null,
      lastError: status === 'pending' ? null : 'simulated pre-upgrade delivery failure',
    },
  ]);
}

function readBuilderLeadConfig(teamName: string): Promise<TeamConfig> {
  return Promise.resolve({
    name: teamName,
    members: [{ name: 'Builder', agentType: 'team-lead' }],
  });
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

function locationForDestination(
  destinationRef: RuntimeDeliveryDestinationRef,
  messageId: string
): RuntimeDeliveryLocation {
  switch (destinationRef.kind) {
    case 'user_sent_messages':
      return {
        kind: destinationRef.kind,
        teamName: destinationRef.teamName,
        messageId,
      };
    case 'member_inbox':
      return {
        kind: destinationRef.kind,
        teamName: destinationRef.teamName,
        memberName: destinationRef.memberName,
        messageId,
      };
    case 'cross_team_outbox':
      return {
        kind: destinationRef.kind,
        fromTeamName: destinationRef.fromTeamName,
        toTeamName: destinationRef.toTeamName,
        toMemberName: destinationRef.toMemberName,
        messageId,
      };
  }
}

async function writeVersionedJournalEntries(filePath: string, records: unknown[]): Promise<void> {
  const store = new VersionedJsonStore<unknown[]>({
    filePath,
    schemaVersion: 1,
    defaultData: () => [],
    validate: (value) => {
      if (!Array.isArray(value)) {
        throw new Error('Legacy runtime delivery journal must be an array');
      }
      return value;
    },
  });
  await store.updateLocked(() => records);
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
    const location = locationForDestination(
      resolveRuntimeDeliveryDestination(input.envelope),
      input.destinationMessageId
    );
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
