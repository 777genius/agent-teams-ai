import {
  type CommittedCoordinationEventAppend,
  type CoordinationEventDraft,
  type CoordinationEventEnvelope,
  CoordinationEventHandoff,
  type CoordinationEventJournal,
  type CoordinationEventPublishDraft,
  type CoordinationJournalReplayRead,
  type CoordinationJsonValue,
  type CoordinationSnapshotRequest,
  encodeReplayCursor,
  type EventJournalWatermark,
  type ExternalCoordinationSnapshotRead,
  MAX_COORDINATION_EVENT_PAYLOAD_UTF8_BYTES,
  type TrustedCoordinationEventContext,
} from '@features/coordination-events';
import { describe, expect, it, vi } from 'vitest';

const REQUEST: CoordinationSnapshotRequest = {
  scopeKind: 'team',
  scopeId: 'team-1',
};

const draft = (revision: number): CoordinationEventDraft => ({
  schemaVersion: 1,
  eventId: `event-${revision}`,
  scope: { kind: 'team', scopeId: 'team-1' },
  workspaceId: 'workspace-1',
  teamId: 'team-1',
  actor: { kind: 'operator', actorRef: 'operator-1' },
  eventType: 'team.updated',
  resourceRevision: {
    resourceKey: 'team:team-1',
    generation: 1,
    revision,
  },
  emittedAt: `2026-07-20T00:00:0${revision}.000Z`,
  payload: { revision },
});

const publishDraft = (revision: number): CoordinationEventPublishDraft => {
  const value = draft(revision);
  return {
    schemaVersion: value.schemaVersion,
    eventId: value.eventId,
    scope: value.scope,
    workspaceId: value.workspaceId,
    teamId: value.teamId,
    eventType: value.eventType,
    resourceRevision: value.resourceRevision,
    emittedAt: value.emittedAt,
    payload: value.payload,
  };
};

const OPERATOR_CONTEXT: TrustedCoordinationEventContext = {
  actor: { kind: 'operator', actorRef: 'operator-1' },
};

class MemoryJournal implements CoordinationEventJournal {
  readonly events: CoordinationEventEnvelope[] = [];
  readonly operations: string[] = [];
  retentionFloorSequence = 0;
  omitSequence: number | null = null;

  async getWatermark(): Promise<EventJournalWatermark> {
    return this.watermark();
  }

  async readCommittedEvents<TPayload extends CoordinationJsonValue = CoordinationJsonValue>(input: {
    readonly afterSequence: number;
    readonly throughSequence: number;
    readonly limit: number;
  }): Promise<CoordinationJournalReplayRead<TPayload>> {
    this.operations.push(`read:${input.afterSequence}:${input.limit}`);
    const events = this.events
      .filter(
        ({ eventSequence }) =>
          eventSequence > input.afterSequence &&
          eventSequence <= input.throughSequence &&
          eventSequence !== this.omitSequence
      )
      .slice(0, input.limit);
    return {
      events: events as unknown as readonly CoordinationEventEnvelope<TPayload>[],
      watermark: this.watermark(),
    };
  }

  async appendCommittedEvent<TPayload extends CoordinationJsonValue>(
    eventDraft: CoordinationEventDraft<TPayload>
  ): Promise<CommittedCoordinationEventAppend<TPayload>> {
    const eventSequence = this.events.length + 1;
    const event: CoordinationEventEnvelope<TPayload> = {
      ...eventDraft,
      deploymentId: 'deployment-1',
      eventEpoch: 'epoch-1',
      eventSequence,
      eventCursor: encodeReplayCursor({
        deploymentId: 'deployment-1',
        eventEpoch: 'epoch-1',
        eventSequence,
      }),
    };
    this.events.push(event);
    this.operations.push(`append:${event.eventId}`);
    return { event, watermark: this.watermark() };
  }

  private watermark(): EventJournalWatermark {
    return {
      schemaVersion: 1,
      deploymentId: 'deployment-1',
      eventEpoch: 'epoch-1',
      retentionFloorSequence: this.retentionFloorSequence,
      highWatermarkSequence: this.events.length,
    };
  }
}

const cursorAt = (sequence: number) =>
  encodeReplayCursor({
    deploymentId: 'deployment-1',
    eventEpoch: 'epoch-1',
    eventSequence: sequence,
  });

describe('CoordinationEventHandoff', () => {
  it('uses a same-transaction snapshot barrier so a later mutation replays once', async () => {
    const journal = new MemoryJournal();
    const handoff = new CoordinationEventHandoff({ journal });

    const snapshot = await handoff.captureSameTransactionSnapshot({
      request: REQUEST,
      source: {
        async readSnapshotWithEventBarrier() {
          return {
            snapshot: { revision: 0 },
            revisionVector: [{ resourceKey: 'team:team-1', generation: 1, revision: 0 }],
            watermark: await journal.getWatermark(),
          };
        },
      },
    });
    await journal.appendCommittedEvent(draft(1));
    const replay = await handoff.replay({ cursor: snapshot.metadata.replayCursor });

    expect(snapshot.metadata.handoffMode).toBe('same_transaction');
    expect(snapshot.snapshot).toEqual({ revision: 0 });
    expect(replay.events.map(({ eventId }) => eventId)).toEqual(['event-1']);
    expect(replay.hasMore).toBe(false);
  });

  it('returns fresh deeply immutable snapshot data without retaining source accessors', async () => {
    const journal = new MemoryJournal();
    const handoff = new CoordinationEventHandoff({ journal });
    const sourceSnapshot = {
      nested: { label: 'captured' },
      rows: [{ revision: 1 }],
    };
    const source = {
      async readSnapshotWithEventBarrier() {
        return {
          snapshot: sourceSnapshot,
          revisionVector: [],
          watermark: await journal.getWatermark(),
        };
      },
    };

    const first = await handoff.captureSameTransactionSnapshot({ request: REQUEST, source });
    const second = await handoff.captureSameTransactionSnapshot({ request: REQUEST, source });

    expect(first.snapshot).not.toBe(sourceSnapshot);
    expect(second.snapshot).not.toBe(first.snapshot);
    expect(Object.isFrozen(first.snapshot)).toBe(true);
    expect(Object.isFrozen(first.snapshot.nested)).toBe(true);
    expect(Object.isFrozen(first.snapshot.rows)).toBe(true);
    sourceSnapshot.nested.label = 'mutated';
    sourceSnapshot.rows[0].revision = 99;
    expect(first.snapshot).toEqual({
      nested: { label: 'captured' },
      rows: [{ revision: 1 }],
    });

    let accessorInvoked = false;
    const accessorSnapshot = Object.defineProperty({}, 'derived', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        return { mutable: true };
      },
    });
    await expect(
      handoff.captureSameTransactionSnapshot({
        request: REQUEST,
        source: {
          async readSnapshotWithEventBarrier() {
            return {
              snapshot: accessorSnapshot,
              revisionVector: [],
              watermark: await journal.getWatermark(),
            };
          },
        },
      })
    ).rejects.toMatchObject({ code: 'invalid_snapshot_data' });
    expect(accessorInvoked).toBe(false);
  });

  it('captures lower C0 before an external scan and replays overlap after the snapshot', async () => {
    const journal = new MemoryJournal();
    const handoff = new CoordinationEventHandoff({ journal });

    const snapshot = await handoff.captureExternalSnapshot({
      request: REQUEST,
      source: {
        async readStableSnapshot(_request, context) {
          expect(context.signal.aborted).toBe(false);
          expect(context.deadlineAtMs).toBeGreaterThan(Date.now());
          await journal.appendCommittedEvent(draft(1));
          return {
            snapshot: { revision: 1 },
            revisionVector: [{ resourceKey: 'team:team-1', generation: 1, revision: 1 }],
            sourceGenerationBefore: 'generation-1',
            sourceGenerationAfter: 'generation-1',
          };
        },
      },
    });
    const replay = await handoff.replay({ cursor: snapshot.metadata.replayCursor });

    expect(snapshot.metadata.handoffMode).toBe('lower_barrier');
    expect(snapshot.snapshot).toEqual({ revision: 1 });
    expect(replay.events.map(({ eventId }) => eventId)).toEqual(['event-1']);
  });

  it('requests a fresh snapshot when an external source changes generation', async () => {
    const handoff = new CoordinationEventHandoff({ journal: new MemoryJournal() });

    await expect(
      handoff.captureExternalSnapshot({
        request: REQUEST,
        source: {
          async readStableSnapshot() {
            return {
              snapshot: {},
              revisionVector: [],
              sourceGenerationBefore: 'generation-1',
              sourceGenerationAfter: 'generation-2',
            };
          },
        },
      })
    ).rejects.toMatchObject({ code: 'snapshot_retry' });
  });

  it('requests a fresh snapshot when pruning overtakes the lower barrier during the scan', async () => {
    const journal = new MemoryJournal();
    await journal.appendCommittedEvent(draft(1));
    const handoff = new CoordinationEventHandoff({ journal });

    await expect(
      handoff.captureExternalSnapshot({
        request: REQUEST,
        source: {
          async readStableSnapshot() {
            await journal.appendCommittedEvent(draft(2));
            journal.retentionFloorSequence = 2;
            return {
              snapshot: {},
              revisionVector: [],
              sourceGenerationBefore: 'generation-1',
              sourceGenerationAfter: 'generation-1',
            };
          },
        },
      })
    ).rejects.toMatchObject({
      code: 'snapshot_retry',
      details: { replayBarrierSequence: 1, retentionFloorSequence: 2 },
    });
  });

  it('bounds an external read that ignores AbortSignal', async () => {
    const handoff = new CoordinationEventHandoff({
      journal: new MemoryJournal(),
      externalSnapshotTimeoutMs: 20,
    });
    let ignoredSignal: AbortSignal | undefined;

    await expect(
      handoff.captureExternalSnapshot({
        request: REQUEST,
        source: {
          async readStableSnapshot(_request, context) {
            ignoredSignal = context.signal;
            return new Promise<ExternalCoordinationSnapshotRead<never>>(() => undefined);
          },
        },
      })
    ).rejects.toMatchObject({ code: 'snapshot_retry', details: { phase: 'read' } });

    expect(ignoredSignal?.aborted).toBe(true);
  });

  it('rejects a source result that arrives after the external snapshot deadline', async () => {
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const handoff = new CoordinationEventHandoff({
      journal: new MemoryJournal(),
      externalSnapshotTimeoutMs: 20,
    });

    try {
      await expect(
        handoff.captureExternalSnapshot({
          request: REQUEST,
          source: {
            async readStableSnapshot() {
              now += 21;
              return {
                snapshot: { revision: 1 },
                revisionVector: [],
                sourceGenerationBefore: 'generation-1',
                sourceGenerationAfter: 'generation-1',
              };
            },
          },
        })
      ).rejects.toMatchObject({ code: 'snapshot_retry', details: { phase: 'read' } });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('rejects snapshot materialization that consumes the remaining deadline budget', async () => {
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const handoff = new CoordinationEventHandoff({
      journal: new MemoryJournal(),
      externalSnapshotTimeoutMs: 20,
    });
    const snapshot = new Proxy(
      { revision: 1 },
      {
        ownKeys(target) {
          now += 21;
          return Reflect.ownKeys(target);
        },
      }
    );

    try {
      await expect(
        handoff.captureExternalSnapshot({
          request: REQUEST,
          source: {
            async readStableSnapshot() {
              return {
                snapshot,
                revisionVector: [],
                sourceGenerationBefore: 'generation-1',
                sourceGenerationAfter: 'generation-1',
              };
            },
          },
        })
      ).rejects.toMatchObject({ code: 'snapshot_retry', details: { phase: 'read' } });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('returns a bounded replay across smaller durable query pages', async () => {
    const journal = new MemoryJournal();
    for (let revision = 1; revision <= 5; revision += 1) {
      await journal.appendCommittedEvent(draft(revision));
    }
    const handoff = new CoordinationEventHandoff({
      journal,
      replayBatchSize: 2,
    });

    const replay = await handoff.replay({ cursor: cursorAt(0), maxEvents: 3 });

    expect(replay.events.map(({ eventSequence }) => eventSequence)).toEqual([1, 2, 3]);
    expect(replay.nextCursor).toBe(cursorAt(3));
    expect(replay.hasMore).toBe(true);
    expect(journal.operations.filter((operation) => operation.startsWith('read:'))).toEqual([
      'read:0:2',
      'read:2:1',
    ]);
  });

  it('fails closed when retention overtakes a cursor or the journal has a discontinuity', async () => {
    const staleJournal = new MemoryJournal();
    await staleJournal.appendCommittedEvent(draft(1));
    await staleJournal.appendCommittedEvent(draft(2));
    staleJournal.retentionFloorSequence = 2;
    const staleHandoff = new CoordinationEventHandoff({
      journal: staleJournal,
    });
    await expect(staleHandoff.replay({ cursor: cursorAt(1) })).rejects.toMatchObject({
      code: 'replay_cursor_stale',
    });

    const gapJournal = new MemoryJournal();
    await gapJournal.appendCommittedEvent(draft(1));
    await gapJournal.appendCommittedEvent(draft(2));
    await gapJournal.appendCommittedEvent(draft(3));
    gapJournal.omitSequence = 2;
    const gapHandoff = new CoordinationEventHandoff({
      journal: gapJournal,
      replayBatchSize: 3,
    });
    await expect(gapHandoff.replay({ cursor: cursorAt(0) })).rejects.toMatchObject({
      code: 'event_sequence_discontinuity',
    });
  });

  it('persists the event before live fanout and leaves wake-up failure replayable', async () => {
    const journal = new MemoryJournal();
    const operations = journal.operations;
    const handoff = new CoordinationEventHandoff({
      journal,
      wakeup: {
        async notifyCommittedEvent(event) {
          operations.push(`wakeup:${event.eventId}`);
          throw new Error('simulated fanout crash');
        },
      },
    });

    const published = await handoff.publishCommittedEvent({
      trustedContext: OPERATOR_CONTEXT,
      draft: publishDraft(1),
    });
    const replay = await handoff.replay({ cursor: cursorAt(0) });

    expect(published.liveWakeup).toBe('failed');
    expect(operations.slice(0, 2)).toEqual(['append:event-1', 'wakeup:event-1']);
    expect(replay.events.map(({ eventId }) => eventId)).toEqual(['event-1']);
  });

  it('validates an event draft before any durable append', async () => {
    const journal = new MemoryJournal();
    const handoff = new CoordinationEventHandoff({
      journal,
    });

    await expect(
      handoff.publishCommittedEvent({
        trustedContext: OPERATOR_CONTEXT,
        draft: {
          ...publishDraft(1),
          schemaVersion: 2,
        } as unknown as CoordinationEventPublishDraft,
      })
    ).rejects.toMatchObject({
      code: 'unsupported_event_version',
    });
    expect(journal.events).toHaveLength(0);
    expect(journal.operations).toEqual([]);
  });

  it('rejects an accessor payload without invoking it or reaching durable append', async () => {
    const journal = new MemoryJournal();
    const handoff = new CoordinationEventHandoff({
      journal,
    });
    let reads = 0;
    const payload = Object.defineProperty({}, 'text', {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? 'ok' : 'x'.repeat(MAX_COORDINATION_EVENT_PAYLOAD_UTF8_BYTES + 1);
      },
    });

    await expect(
      handoff.publishCommittedEvent({
        trustedContext: OPERATOR_CONTEXT,
        draft: {
          ...publishDraft(1),
          payload,
        } as CoordinationEventPublishDraft,
      })
    ).rejects.toMatchObject({ code: 'invalid_coordination_event' });

    expect(reads).toBe(0);
    expect(journal.events).toHaveLength(0);
    expect(journal.operations).toEqual([]);
  });

  it('appends only an accessor-free deeply immutable payload materialization', async () => {
    const sourcePayload = { nested: { text: 'ok' } };
    class InspectingJournal extends MemoryJournal {
      override async appendCommittedEvent<TPayload extends CoordinationJsonValue>(
        eventDraft: CoordinationEventDraft<TPayload>
      ): Promise<CommittedCoordinationEventAppend<TPayload>> {
        expect(eventDraft.payload).not.toBe(sourcePayload);
        expect(Object.isFrozen(eventDraft.payload)).toBe(true);
        const materialized = eventDraft.payload as {
          readonly nested: { readonly text: string };
        };
        expect(Object.isFrozen(materialized.nested)).toBe(true);
        expect(Object.getOwnPropertyDescriptor(materialized, 'nested')).not.toHaveProperty('get');
        expect(Object.getOwnPropertyDescriptor(materialized.nested, 'text')).not.toHaveProperty(
          'get'
        );
        sourcePayload.nested.text = 'x'.repeat(MAX_COORDINATION_EVENT_PAYLOAD_UTF8_BYTES + 1);
        expect(materialized.nested.text).toBe('ok');
        return super.appendCommittedEvent(eventDraft);
      }
    }
    const journal = new InspectingJournal();
    const handoff = new CoordinationEventHandoff({
      journal,
    });

    const published = await handoff.publishCommittedEvent({
      trustedContext: OPERATOR_CONTEXT,
      draft: { ...publishDraft(1), payload: sourcePayload },
    });

    expect(published.event.payload).toEqual({ nested: { text: 'ok' } });
  });

  it('detaches every nested durable append value before caller mutation after append begins', async () => {
    let continueAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      continueAppend = resolve;
    });
    let appendedDraft: CoordinationEventDraft | undefined;
    class DeferredAppendJournal extends MemoryJournal {
      override async appendCommittedEvent<TPayload extends CoordinationJsonValue>(
        eventDraft: CoordinationEventDraft<TPayload>
      ): Promise<CommittedCoordinationEventAppend<TPayload>> {
        appendedDraft = eventDraft;
        await appendGate;
        return super.appendCommittedEvent(eventDraft);
      }
    }
    const journal = new DeferredAppendJournal();
    const handoff = new CoordinationEventHandoff({
      journal,
    });
    const callerScope = { kind: 'team' as const, scopeId: 'team-1' };
    const callerRevision = { resourceKey: 'team:team-1', generation: 1, revision: 1 };
    const callerPayload = { nested: { text: 'captured' } };
    const callerActor = { kind: 'operator' as const, actorRef: 'operator-1' };

    const publishing = handoff.publishCommittedEvent({
      trustedContext: { actor: callerActor },
      draft: {
        ...publishDraft(1),
        scope: callerScope,
        resourceRevision: callerRevision,
        payload: callerPayload,
      },
    });

    expect(appendedDraft).toBeDefined();
    expect(appendedDraft!.scope).not.toBe(callerScope);
    expect(appendedDraft!.resourceRevision).not.toBe(callerRevision);
    expect(appendedDraft!.actor).not.toBe(callerActor);
    expect(appendedDraft!.payload).not.toBe(callerPayload);
    expect(Object.isFrozen(appendedDraft)).toBe(true);
    expect(Object.isFrozen(appendedDraft!.scope)).toBe(true);
    expect(Object.isFrozen(appendedDraft!.resourceRevision)).toBe(true);
    expect(Object.isFrozen(appendedDraft!.actor)).toBe(true);
    expect(Object.isFrozen(appendedDraft!.payload)).toBe(true);
    expect(Object.isFrozen((appendedDraft!.payload as { nested: object }).nested)).toBe(true);

    callerScope.scopeId = 'mutated-team';
    callerRevision.resourceKey = 'team:mutated-team';
    callerRevision.revision = 999;
    callerPayload.nested.text = 'mutated';
    callerActor.actorRef = 'mutated-operator';
    continueAppend();
    const published = await publishing;

    expect(appendedDraft).toMatchObject({
      scope: { kind: 'team', scopeId: 'team-1' },
      resourceRevision: { resourceKey: 'team:team-1', generation: 1, revision: 1 },
      actor: { kind: 'operator', actorRef: 'operator-1' },
      payload: { nested: { text: 'captured' } },
    });
    expect(published.event).toMatchObject({
      scope: { kind: 'team', scopeId: 'team-1' },
      resourceRevision: { resourceKey: 'team:team-1', generation: 1, revision: 1 },
      actor: { kind: 'operator', actorRef: 'operator-1' },
      payload: { nested: { text: 'captured' } },
    });
  });

  it('rematerializes a mutable journal append before wake-up or caller delivery', async () => {
    class MutableReturnJournal extends MemoryJournal {
      returnedEvent: CoordinationEventEnvelope | undefined;

      override async appendCommittedEvent<TPayload extends CoordinationJsonValue>(
        eventDraft: CoordinationEventDraft<TPayload>
      ): Promise<CommittedCoordinationEventAppend<TPayload>> {
        const committed = await super.appendCommittedEvent(eventDraft);
        const returnedEvent = {
          ...committed.event,
          scope: { ...committed.event.scope },
          actor: { ...committed.event.actor },
          resourceRevision: committed.event.resourceRevision
            ? { ...committed.event.resourceRevision }
            : undefined,
          payload: { nested: { text: 'ok' } },
        } as unknown as CoordinationEventEnvelope<TPayload>;
        this.returnedEvent = returnedEvent;
        return { event: returnedEvent, watermark: committed.watermark };
      }
    }
    const journal = new MutableReturnJournal();
    const handoff = new CoordinationEventHandoff({
      journal,
    });

    const published = await handoff.publishCommittedEvent({
      trustedContext: OPERATOR_CONTEXT,
      draft: { ...publishDraft(1), payload: { nested: { text: 'ok' } } },
    });
    const journalPayload = journal.returnedEvent!.payload as {
      nested: { text: string };
    };
    journalPayload.nested.text = 'mutated-after-return';

    expect(published.event).not.toBe(journal.returnedEvent);
    expect(published.event.payload).not.toBe(journal.returnedEvent!.payload);
    expect(published.event.payload).toEqual({ nested: { text: 'ok' } });
    expect(Object.isFrozen(published.event)).toBe(true);
    expect(Object.isFrozen(published.event.scope)).toBe(true);
    expect(Object.isFrozen(published.event.actor)).toBe(true);
    expect(Object.isFrozen(published.event.resourceRevision)).toBe(true);
    expect(Object.isFrozen(published.event.payload)).toBe(true);
    expect(Object.isFrozen((published.event.payload as { nested: object }).nested)).toBe(true);
  });

  it('rejects accessor-bearing journal envelopes without invoking their getters', async () => {
    let payloadReads = 0;
    class AccessorReturnJournal extends MemoryJournal {
      override async appendCommittedEvent<TPayload extends CoordinationJsonValue>(
        eventDraft: CoordinationEventDraft<TPayload>
      ): Promise<CommittedCoordinationEventAppend<TPayload>> {
        const committed = await super.appendCommittedEvent(eventDraft);
        const accessorEvent = Object.defineProperty({ ...committed.event }, 'payload', {
          enumerable: true,
          get() {
            payloadReads += 1;
            return eventDraft.payload;
          },
        });
        return {
          event: accessorEvent as unknown as CoordinationEventEnvelope<TPayload>,
          watermark: committed.watermark,
        };
      }
    }
    const journal = new AccessorReturnJournal();
    const handoff = new CoordinationEventHandoff({
      journal,
    });

    await expect(
      handoff.publishCommittedEvent({ trustedContext: OPERATOR_CONTEXT, draft: publishDraft(1) })
    ).rejects.toMatchObject({ code: 'invalid_coordination_event' });
    expect(payloadReads).toBe(0);
  });

  it('rematerializes each replay page so later journal mutation cannot escape', async () => {
    const journal = new MemoryJournal();
    await journal.appendCommittedEvent({
      ...draft(1),
      payload: { nested: { text: 'journal-value' } },
    });
    const handoff = new CoordinationEventHandoff({
      journal,
    });

    const replay = await handoff.replay({ cursor: cursorAt(0) });
    const journalPayload = journal.events[0].payload as { nested: { text: string } };
    journalPayload.nested.text = 'mutated-after-replay';

    expect(replay.events[0]).not.toBe(journal.events[0]);
    expect(replay.events[0].payload).toEqual({ nested: { text: 'journal-value' } });
    expect(Object.isFrozen(replay.events[0])).toBe(true);
    expect(Object.isFrozen(replay.events[0].payload)).toBe(true);
    expect(Object.isFrozen((replay.events[0].payload as { nested: object }).nested)).toBe(true);
  });

  it('binds actor, run, and member attribution only from trusted server context', async () => {
    const journal = new MemoryJournal();
    const handoff = new CoordinationEventHandoff({
      journal,
    });

    const published = await handoff.publishCommittedEvent({
      trustedContext: {
        actor: {
          kind: 'verified_runtime',
          actorRef: 'trusted-runtime',
          runId: 'trusted-run',
          memberId: 'trusted-member',
        },
        runId: 'trusted-run',
      },
      draft: {
        ...publishDraft(1),
        actor: {
          kind: 'verified_runtime',
          actorRef: 'forged-runtime',
          runId: 'forged-run',
          memberId: 'forged-member',
        },
        runId: 'forged-run',
      } as unknown as CoordinationEventPublishDraft,
    });

    expect(published.event.runId).toBe('trusted-run');
    expect(published.event.actor).toEqual({
      kind: 'verified_runtime',
      actorRef: 'trusted-runtime',
      runId: 'trusted-run',
      memberId: 'trusted-member',
    });
  });

  it('rejects high-watermark and retention-floor regression across replay calls', async () => {
    const highJournal = new MemoryJournal();
    await highJournal.appendCommittedEvent(draft(1));
    await highJournal.appendCommittedEvent(draft(2));
    const highHandoff = new CoordinationEventHandoff({
      journal: highJournal,
    });
    await highHandoff.replay({ cursor: cursorAt(0) });
    highJournal.events.pop();
    await expect(highHandoff.replay({ cursor: cursorAt(0) })).rejects.toMatchObject({
      code: 'journal_protocol_error',
    });

    const floorJournal = new MemoryJournal();
    await floorJournal.appendCommittedEvent(draft(1));
    floorJournal.retentionFloorSequence = 1;
    const floorHandoff = new CoordinationEventHandoff({
      journal: floorJournal,
    });
    await floorHandoff.replay({ cursor: cursorAt(1) });
    floorJournal.retentionFloorSequence = 0;
    await expect(floorHandoff.replay({ cursor: cursorAt(1) })).rejects.toMatchObject({
      code: 'journal_protocol_error',
    });
  });
});
