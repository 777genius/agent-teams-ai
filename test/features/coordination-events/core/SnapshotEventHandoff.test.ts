import {
  assertCoordinationEventEnvelope,
  assertCoordinationEventRecoveryPoint,
  assertCoordinationSnapshotMetadata,
  type CoordinationEventDraft,
  type CoordinationEventEnvelope,
  type CoordinationJsonValue,
  createCoordinationEventRecoveryPoint,
  createCoordinationReplayBatch,
  createCoordinationSnapshotMetadata,
  encodeReplayCursor,
  type EventJournalWatermark,
  MAX_COORDINATION_EVENT_PAYLOAD_DEPTH,
  MAX_COORDINATION_EVENT_PAYLOAD_NODES,
  MAX_COORDINATION_EVENT_PAYLOAD_UTF8_BYTES,
  MAX_RECONCILIATION_PROCESSED_EVENT_IDS,
  reconcileCoordinationSnapshotReplay,
  SnapshotEventHandoffError,
} from '@features/coordination-events';
import { describe, expect, it } from 'vitest';

const watermark = (highWatermarkSequence: number): EventJournalWatermark => ({
  schemaVersion: 1,
  deploymentId: 'deployment-1',
  eventEpoch: 'epoch-1',
  retentionFloorSequence: 0,
  highWatermarkSequence,
});

const eventDraft = (
  eventId: string,
  revision: number,
  payload: CoordinationJsonValue = { revision }
): CoordinationEventDraft => ({
  schemaVersion: 1,
  eventId,
  scope: { kind: 'team', scopeId: 'team-1' },
  workspaceId: 'workspace-1',
  teamId: 'team-1',
  actor: { kind: 'operator', actorRef: 'operator-1' },
  eventType: 'team.updated',
  resourceRevision: { resourceKey: 'team:team-1', generation: 1, revision },
  emittedAt: `2026-07-20T00:00:0${revision}.000Z`,
  payload,
});

const event = (
  sequence: number,
  eventId = `event-${sequence}`,
  revision = sequence
): CoordinationEventEnvelope => ({
  ...eventDraft(eventId, revision),
  deploymentId: 'deployment-1',
  eventEpoch: 'epoch-1',
  eventSequence: sequence,
  eventCursor: encodeReplayCursor({
    deploymentId: 'deployment-1',
    eventEpoch: 'epoch-1',
    eventSequence: sequence,
  }),
});

describe('snapshot-to-event handoff domain', () => {
  it.each(['same_transaction', 'lower_barrier'] as const)(
    'creates versioned %s metadata at the captured lower replay barrier',
    (handoffMode) => {
      const captured = watermark(4);
      const metadata = createCoordinationSnapshotMetadata({
        watermark: captured,
        handoffMode,
        revisionVector: [
          { resourceKey: 'team:team-1', generation: 2, revision: 7 },
          { resourceKey: 'roster:team-1', generation: 1, revision: 3 },
        ],
      });

      expect(metadata).toMatchObject({
        schemaVersion: 1,
        deploymentId: captured.deploymentId,
        eventEpoch: captured.eventEpoch,
        handoffMode,
      });
      expect(() => assertCoordinationSnapshotMetadata(metadata, captured)).not.toThrow();
    }
  );

  it('fails closed on unknown snapshot versions and ambiguous revision vectors', () => {
    const metadata = createCoordinationSnapshotMetadata({
      watermark: watermark(0),
      handoffMode: 'lower_barrier',
      revisionVector: [],
    });
    expect(() =>
      assertCoordinationSnapshotMetadata({
        ...metadata,
        schemaVersion: 2,
      } as unknown as typeof metadata)
    ).toThrowError(
      expect.objectContaining<Partial<SnapshotEventHandoffError>>({
        code: 'unsupported_snapshot_version',
      })
    );

    expect(() =>
      createCoordinationSnapshotMetadata({
        watermark: watermark(0),
        handoffMode: 'lower_barrier',
        revisionVector: [
          { resourceKey: 'team:team-1', generation: 1, revision: 1 },
          { resourceKey: 'team:team-1', generation: 1, revision: 2 },
        ],
      })
    ).toThrowError(
      expect.objectContaining<Partial<SnapshotEventHandoffError>>({
        code: 'invalid_snapshot_metadata',
      })
    );
  });

  it('admits at-least-once overlap between a lower-barrier snapshot and replay', () => {
    const metadata = createCoordinationSnapshotMetadata({
      watermark: watermark(0),
      handoffMode: 'lower_barrier',
      revisionVector: [{ resourceKey: 'team:team-1', generation: 1, revision: 1 }],
    });
    const batch = createCoordinationReplayBatch({
      fromCursor: metadata.replayCursor,
      events: [event(1, 'event-1', 1)],
      watermark: watermark(1),
      maxEvents: 10,
    });

    expect(metadata.revisionVector[0].revision).toBe(1);
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0].resourceRevision?.revision).toBe(1);
    expect(batch.hasMore).toBe(false);
  });

  it('deduplicates snapshot overlap and applies only the next contiguous resource revision', () => {
    const metadata = createCoordinationSnapshotMetadata({
      watermark: watermark(0),
      handoffMode: 'lower_barrier',
      revisionVector: [{ resourceKey: 'team:team-1', generation: 1, revision: 1 }],
    });
    const result = reconcileCoordinationSnapshotReplay({
      metadata,
      events: [event(1, 'already-in-snapshot', 1), event(2, 'next-revision', 2)],
      watermark: watermark(2),
    });

    expect(result.duplicateEventIds).toEqual(['already-in-snapshot']);
    expect(result.applicableEvents.map(({ eventId }) => eventId)).toEqual(['next-revision']);
    expect(result.revisionVector).toEqual([
      { resourceKey: 'team:team-1', generation: 1, revision: 2 },
    ]);
  });

  it('deduplicates an older revision represented by a lower-barrier snapshot', () => {
    const metadata = createCoordinationSnapshotMetadata({
      watermark: watermark(0),
      handoffMode: 'lower_barrier',
      revisionVector: [{ resourceKey: 'team:team-1', generation: 1, revision: 2 }],
    });
    const result = reconcileCoordinationSnapshotReplay({
      metadata,
      events: [event(1, 'older-overlap', 1)],
      watermark: watermark(1),
    });

    expect(result.applicableEvents).toEqual([]);
    expect(result.duplicateEventIds).toEqual(['older-overlap']);
    expect(result.revisionVector).toEqual([
      { resourceKey: 'team:team-1', generation: 1, revision: 2 },
    ]);
    expect(result.state.nextEventSequence).toBe(2);
  });

  it('fails closed on a non-contiguous aggregate revision', () => {
    const metadata = createCoordinationSnapshotMetadata({
      watermark: watermark(0),
      handoffMode: 'lower_barrier',
      revisionVector: [{ resourceKey: 'team:team-1', generation: 1, revision: 1 }],
    });
    expect(() =>
      reconcileCoordinationSnapshotReplay({
        metadata,
        events: [event(1, 'skipped-revision', 3)],
        watermark: watermark(1),
      })
    ).toThrowError(
      expect.objectContaining<Partial<SnapshotEventHandoffError>>({
        code: 'resource_revision_discontinuity',
      })
    );
  });

  it('fails closed while reconciling new keys beyond a 10,000-entry revision vector', () => {
    const metadata = createCoordinationSnapshotMetadata({
      watermark: watermark(0),
      handoffMode: 'lower_barrier',
      revisionVector: Array.from({ length: 10_000 }, (_, index) => ({
        resourceKey: `snapshot-resource:${index}`,
        generation: 1,
        revision: 1,
      })),
    });
    const newResourceEvent = (sequence: number): CoordinationEventEnvelope => ({
      ...event(sequence, `new-resource-event-${sequence}`, 1),
      resourceRevision: {
        resourceKey: `new-resource:${sequence}`,
        generation: 1,
        revision: 1,
      },
    });

    expect(() =>
      reconcileCoordinationSnapshotReplay({
        metadata,
        events: [newResourceEvent(1), newResourceEvent(2)],
        watermark: watermark(2),
      })
    ).toThrowError(
      expect.objectContaining<Partial<SnapshotEventHandoffError>>({
        code: 'invalid_snapshot_metadata',
        details: expect.objectContaining({
          eventId: 'new-resource-event-1',
          resourceKey: 'new-resource:1',
          revisionCount: 10_001,
          maximumRevisionCount: 10_000,
        }),
      })
    );
  });

  it('snapshots an accessor-changing metadata revision vector exactly once', () => {
    const metadata = createCoordinationSnapshotMetadata({
      watermark: watermark(0),
      handoffMode: 'lower_barrier',
      revisionVector: [],
    });
    const oversizedVector = Array.from({ length: 10_001 }, (_, index) => ({
      resourceKey: `metadata-resource:${index}`,
      generation: 1,
      revision: 1,
    }));
    let revisionVectorReads = 0;
    const accessorMetadata = Object.defineProperty({ ...metadata }, 'revisionVector', {
      configurable: true,
      enumerable: true,
      get() {
        revisionVectorReads += 1;
        return revisionVectorReads === 1 ? [] : oversizedVector;
      },
    }) as typeof metadata;

    const result = reconcileCoordinationSnapshotReplay({
      metadata: accessorMetadata,
      events: [],
      watermark: watermark(0),
    });

    expect(revisionVectorReads).toBe(1);
    expect(result.revisionVector).toEqual([]);
    expect(result.state.revisionVector).toEqual([]);
  });

  it('detaches accessor-changing revision entries before validating them', () => {
    const metadata = createCoordinationSnapshotMetadata({
      watermark: watermark(0),
      handoffMode: 'lower_barrier',
      revisionVector: [],
    });
    let resourceKeyReads = 0;
    const accessorRevision = Object.defineProperty({ generation: 1, revision: 1 }, 'resourceKey', {
      configurable: true,
      enumerable: true,
      get() {
        resourceKeyReads += 1;
        return resourceKeyReads === 1 ? 'team:stable' : '';
      },
    });
    const accessorMetadata = {
      ...metadata,
      revisionVector: [accessorRevision],
    } as unknown as typeof metadata;

    const result = reconcileCoordinationSnapshotReplay({
      metadata: accessorMetadata,
      events: [],
      watermark: watermark(0),
    });

    expect(resourceKeyReads).toBe(1);
    expect(result.revisionVector).toEqual([
      { resourceKey: 'team:stable', generation: 1, revision: 1 },
    ]);
    expect(Object.getPrototypeOf(result.revisionVector[0])).toBe(Object.prototype);
    expect(Object.isFrozen(result.revisionVector[0])).toBe(true);
  });

  it('snapshots an accessor-changing previous-state revision vector exactly once', () => {
    const metadata = createCoordinationSnapshotMetadata({
      watermark: watermark(0),
      handoffMode: 'lower_barrier',
      revisionVector: [],
    });
    const initial = reconcileCoordinationSnapshotReplay({
      metadata,
      events: [],
      watermark: watermark(0),
    });
    const oversizedVector = Array.from({ length: 10_001 }, (_, index) => ({
      resourceKey: `previous-state-resource:${index}`,
      generation: 1,
      revision: 1,
    }));
    let revisionVectorReads = 0;
    const accessorState = Object.defineProperty({ ...initial.state }, 'revisionVector', {
      configurable: true,
      enumerable: true,
      get() {
        revisionVectorReads += 1;
        return revisionVectorReads === 1 ? [] : oversizedVector;
      },
    }) as typeof initial.state;

    const result = reconcileCoordinationSnapshotReplay({
      metadata,
      events: [],
      watermark: watermark(0),
      previousState: accessorState,
    });

    expect(revisionVectorReads).toBe(1);
    expect(result.revisionVector).toEqual([]);
    expect(result.state.revisionVector).toEqual([]);
  });

  it('deduplicates event IDs within and across bounded reconciliation calls', () => {
    const metadata = createCoordinationSnapshotMetadata({
      watermark: watermark(0),
      handoffMode: 'lower_barrier',
      revisionVector: [],
    });
    const withoutRevision = (sequence: number, eventId: string): CoordinationEventEnvelope => ({
      ...event(sequence, eventId),
      resourceRevision: undefined,
    });

    const first = reconcileCoordinationSnapshotReplay({
      metadata,
      events: [withoutRevision(1, 'revisionless'), withoutRevision(2, 'revisionless')],
      watermark: watermark(2),
    });
    const second = reconcileCoordinationSnapshotReplay({
      metadata,
      events: [withoutRevision(2, 'revisionless'), withoutRevision(3, 'next-revisionless')],
      watermark: watermark(3),
      previousState: first.state,
    });

    expect(first.applicableEvents.map(({ eventId }) => eventId)).toEqual(['revisionless']);
    expect(first.duplicateEventIds).toEqual(['revisionless']);
    expect(second.applicableEvents.map(({ eventId }) => eventId)).toEqual(['next-revisionless']);
    expect(second.duplicateEventIds).toEqual(['revisionless']);
    expect(second.state.nextEventSequence).toBe(4);
  });

  it('bounds IDs and rejects adversarial replay below the monotonic floor after eviction', () => {
    const metadata = createCoordinationSnapshotMetadata({
      watermark: watermark(0),
      handoffMode: 'lower_barrier',
      revisionVector: [],
    });
    const revisionlessEvent = (
      sequence: number,
      eventId = `window-event-${sequence}`
    ): CoordinationEventEnvelope => ({
      ...event(1, eventId, 1),
      resourceRevision: undefined,
      emittedAt: '2026-07-20T00:00:00.000Z',
      eventSequence: sequence,
      eventCursor: encodeReplayCursor({
        deploymentId: 'deployment-1',
        eventEpoch: 'epoch-1',
        eventSequence: sequence,
      }),
    });
    const firstEvents = Array.from({ length: MAX_RECONCILIATION_PROCESSED_EVENT_IDS }, (_, index) =>
      revisionlessEvent(index + 1)
    );
    const first = reconcileCoordinationSnapshotReplay({
      metadata,
      events: firstEvents,
      watermark: watermark(MAX_RECONCILIATION_PROCESSED_EVENT_IDS),
    });
    const aboveWindow = reconcileCoordinationSnapshotReplay({
      metadata,
      events: [revisionlessEvent(10_001), revisionlessEvent(10_002)],
      watermark: watermark(10_002),
      previousState: first.state,
    });

    expect(aboveWindow.state.processedEventIds).toHaveLength(
      MAX_RECONCILIATION_PROCESSED_EVENT_IDS
    );
    expect(aboveWindow.state.processedEventIds[0]).toBe('window-event-3');
    expect(aboveWindow.state.processedEventIds.at(-1)).toBe('window-event-10002');

    const windowSemantics = reconcileCoordinationSnapshotReplay({
      metadata,
      events: [
        revisionlessEvent(1, 'window-event-1'),
        revisionlessEvent(10_003, 'next-after-window'),
        revisionlessEvent(10_004, 'window-event-10002'),
      ],
      watermark: watermark(10_004),
      previousState: aboveWindow.state,
    });

    expect(windowSemantics.applicableEvents.map(({ eventId }) => eventId)).toEqual([
      'next-after-window',
    ]);
    expect(windowSemantics.duplicateEventIds).toEqual(['window-event-1', 'window-event-10002']);
    expect(windowSemantics.state.processedThroughSequence).toBe(10_004);
    expect(windowSemantics.state.nextEventSequence).toBe(10_005);
    expect(windowSemantics.state.processedEventIds).toHaveLength(
      MAX_RECONCILIATION_PROCESSED_EVENT_IDS
    );
    expect(windowSemantics.state.processedEventIds[0]).toBe('window-event-4');
    expect(windowSemantics.state.processedEventIds.at(-1)).toBe('next-after-window');

    expect(() =>
      reconcileCoordinationSnapshotReplay({
        metadata,
        events: [],
        watermark: watermark(10_004),
        previousState: {
          ...windowSemantics.state,
          processedEventIds: Array.from({ length: 10_001 }, (_, index) => `state-${index}`),
        },
      })
    ).toThrowError(
      expect.objectContaining<Partial<SnapshotEventHandoffError>>({ code: 'duplicate_event' })
    );

    expect(() =>
      reconcileCoordinationSnapshotReplay({
        metadata,
        events: [],
        watermark: watermark(10_005),
        previousState: {
          ...windowSemantics.state,
          processedThroughSequence: 10_005,
          nextEventSequence: 10_006,
        },
      })
    ).toThrowError(
      expect.objectContaining<Partial<SnapshotEventHandoffError>>({
        code: 'event_sequence_discontinuity',
      })
    );
  });

  it('rejects resource revision and watermark regressions across reconciliation calls', () => {
    const metadata = createCoordinationSnapshotMetadata({
      watermark: watermark(0),
      handoffMode: 'same_transaction',
      revisionVector: [{ resourceKey: 'team:team-1', generation: 1, revision: 1 }],
    });
    const first = reconcileCoordinationSnapshotReplay({
      metadata,
      events: [event(1, 'revision-2', 2)],
      watermark: watermark(1),
    });

    expect(() =>
      reconcileCoordinationSnapshotReplay({
        metadata,
        events: [event(2, 'revision-regression', 1)],
        watermark: watermark(2),
        previousState: first.state,
      })
    ).toThrowError(
      expect.objectContaining<Partial<SnapshotEventHandoffError>>({
        code: 'resource_revision_regression',
      })
    );

    expect(() =>
      reconcileCoordinationSnapshotReplay({
        metadata,
        events: [],
        watermark: watermark(0),
        previousState: first.state,
      })
    ).toThrowError(
      expect.objectContaining<Partial<SnapshotEventHandoffError>>({
        code: 'journal_watermark_regression',
      })
    );

    const floorMetadata = createCoordinationSnapshotMetadata({
      watermark: watermark(2),
      handoffMode: 'lower_barrier',
      revisionVector: [],
    });
    const floorState = reconcileCoordinationSnapshotReplay({
      metadata: floorMetadata,
      events: [],
      watermark: { ...watermark(2), retentionFloorSequence: 1 },
    });
    expect(() =>
      reconcileCoordinationSnapshotReplay({
        metadata: floorMetadata,
        events: [],
        watermark: watermark(2),
        previousState: floorState.state,
      })
    ).toThrowError(
      expect.objectContaining<Partial<SnapshotEventHandoffError>>({
        code: 'journal_watermark_regression',
      })
    );
  });

  it('returns one contiguous bounded page with an opaque next cursor', () => {
    const batch = createCoordinationReplayBatch({
      fromCursor: encodeReplayCursor({
        deploymentId: 'deployment-1',
        eventEpoch: 'epoch-1',
        eventSequence: 0,
      }),
      events: [event(1), event(2)],
      watermark: watermark(3),
      maxEvents: 2,
    });

    expect(batch.events.map(({ eventSequence }) => eventSequence)).toEqual([1, 2]);
    expect(batch.nextCursor).toBe(event(2).eventCursor);
    expect(batch.hasMore).toBe(true);
  });

  it('returns fresh accessor-free deeply frozen events at replay and reconciliation boundaries', () => {
    const source = {
      ...event(1),
      resourceRevision: undefined,
      payload: { nested: { text: 'stable' } },
    } as CoordinationEventEnvelope;
    const metadata = createCoordinationSnapshotMetadata({
      watermark: watermark(0),
      handoffMode: 'lower_barrier',
      revisionVector: [],
    });
    const batch = createCoordinationReplayBatch({
      fromCursor: metadata.replayCursor,
      events: [source],
      watermark: watermark(1),
      maxEvents: 1,
    });
    const reconciled = reconcileCoordinationSnapshotReplay({
      metadata,
      events: batch.events,
      watermark: watermark(1),
    });
    (source.payload as { nested: { text: string } }).nested.text = 'mutated';

    expect(batch.events[0]).not.toBe(source);
    expect(reconciled.applicableEvents[0]).not.toBe(batch.events[0]);
    expect(reconciled.applicableEvents[0].payload).toEqual({ nested: { text: 'stable' } });
    expect(Object.isFrozen(reconciled.applicableEvents[0])).toBe(true);
    expect(Object.isFrozen(reconciled.applicableEvents[0].scope)).toBe(true);
    expect(Object.isFrozen(reconciled.applicableEvents[0].actor)).toBe(true);
    expect(Object.isFrozen(reconciled.applicableEvents[0].payload)).toBe(true);
    expect(
      Object.isFrozen((reconciled.applicableEvents[0].payload as { nested: object }).nested)
    ).toBe(true);
  });

  it('rejects accessor-bearing replay events without invoking the accessor', () => {
    let payloadReads = 0;
    const accessorEvent = Object.defineProperty({ ...event(1) }, 'payload', {
      enumerable: true,
      get() {
        payloadReads += 1;
        return { unsafe: true };
      },
    }) as CoordinationEventEnvelope;

    expect(() =>
      createCoordinationReplayBatch({
        fromCursor: encodeReplayCursor({
          deploymentId: 'deployment-1',
          eventEpoch: 'epoch-1',
          eventSequence: 0,
        }),
        events: [accessorEvent],
        watermark: watermark(1),
        maxEvents: 1,
      })
    ).toThrowError(
      expect.objectContaining<Partial<SnapshotEventHandoffError>>({
        code: 'invalid_coordination_event',
      })
    );
    expect(payloadReads).toBe(0);
  });

  it('rejects gaps, duplicate IDs, and mismatched event cursors', () => {
    const fromCursor = encodeReplayCursor({
      deploymentId: 'deployment-1',
      eventEpoch: 'epoch-1',
      eventSequence: 0,
    });
    expect(() =>
      createCoordinationReplayBatch({
        fromCursor,
        events: [event(2)],
        watermark: watermark(2),
        maxEvents: 1,
      })
    ).toThrowError(
      expect.objectContaining<Partial<SnapshotEventHandoffError>>({
        code: 'event_sequence_discontinuity',
      })
    );

    expect(() =>
      createCoordinationReplayBatch({
        fromCursor,
        events: [event(1, 'same'), event(2, 'same')],
        watermark: watermark(2),
        maxEvents: 2,
      })
    ).toThrowError(
      expect.objectContaining<Partial<SnapshotEventHandoffError>>({
        code: 'duplicate_event',
      })
    );

    expect(() =>
      assertCoordinationEventEnvelope({
        ...event(1),
        eventCursor: encodeReplayCursor({
          deploymentId: 'deployment-1',
          eventEpoch: 'epoch-1',
          eventSequence: 2,
        }),
      })
    ).toThrowError(
      expect.objectContaining<Partial<SnapshotEventHandoffError>>({
        code: 'event_cursor_mismatch',
      })
    );
  });

  it('rejects incomplete journal pages instead of silently skipping retained events', () => {
    expect(() =>
      createCoordinationReplayBatch({
        fromCursor: encodeReplayCursor({
          deploymentId: 'deployment-1',
          eventEpoch: 'epoch-1',
          eventSequence: 0,
        }),
        events: [event(1)],
        watermark: watermark(3),
        maxEvents: 2,
      })
    ).toThrowError(
      expect.objectContaining<Partial<SnapshotEventHandoffError>>({
        code: 'event_sequence_discontinuity',
      })
    );
  });

  it('rejects unknown event versions, invalid run attribution, and non-JSON payloads', () => {
    expect(() =>
      assertCoordinationEventEnvelope({
        ...event(1),
        payload: { progress: 0.5 },
      })
    ).not.toThrow();

    expect(() =>
      assertCoordinationEventEnvelope({
        ...event(1),
        schemaVersion: 2,
      } as unknown as CoordinationEventEnvelope)
    ).toThrowError(
      expect.objectContaining<Partial<SnapshotEventHandoffError>>({
        code: 'unsupported_event_version',
      })
    );

    expect(() =>
      assertCoordinationEventEnvelope({
        ...event(1),
        runId: 'claimed-run',
        actor: {
          kind: 'verified_runtime',
          actorRef: 'runtime-1',
          runId: 'different-run',
        },
      })
    ).toThrowError(
      expect.objectContaining<Partial<SnapshotEventHandoffError>>({
        code: 'invalid_coordination_event',
      })
    );

    expect(() =>
      assertCoordinationEventEnvelope({
        ...event(1),
        payload: { unsafe: Number.NaN },
      } as unknown as CoordinationEventEnvelope)
    ).toThrowError(
      expect.objectContaining<Partial<SnapshotEventHandoffError>>({
        code: 'invalid_coordination_event',
      })
    );
  });

  it('rejects payloads over byte, nesting-depth, and total-node budgets', () => {
    const overDepth: Record<string, unknown> = {};
    let cursor = overDepth;
    for (let depth = 0; depth <= MAX_COORDINATION_EVENT_PAYLOAD_DEPTH; depth += 1) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }
    const invalidPayloads = [
      { text: 'x'.repeat(MAX_COORDINATION_EVENT_PAYLOAD_UTF8_BYTES) },
      overDepth,
      Array.from({ length: MAX_COORDINATION_EVENT_PAYLOAD_NODES }, () => null),
    ];

    for (const payload of invalidPayloads) {
      expect(() =>
        assertCoordinationEventEnvelope({
          ...event(1),
          payload,
        } as unknown as CoordinationEventEnvelope)
      ).toThrowError(
        expect.objectContaining<Partial<SnapshotEventHandoffError>>({
          code: 'invalid_coordination_event',
        })
      );
    }
  });

  it('models a versioned event-journal recovery-point barrier', () => {
    const recoveryPoint = createCoordinationEventRecoveryPoint({
      participantId: 'coordination-events',
      watermark: {
        ...watermark(7),
        retentionFloorSequence: 2,
      },
    });

    expect(recoveryPoint).toMatchObject({
      schemaVersion: 1,
      participantId: 'coordination-events',
      retentionFloorSequence: 2,
      highWatermarkSequence: 7,
    });
    expect(() => assertCoordinationEventRecoveryPoint(recoveryPoint)).not.toThrow();
    expect(() =>
      assertCoordinationEventRecoveryPoint({
        ...recoveryPoint,
        schemaVersion: 99,
      } as unknown as typeof recoveryPoint)
    ).toThrowError(
      expect.objectContaining<Partial<SnapshotEventHandoffError>>({
        code: 'unsupported_recovery_point_version',
      })
    );
  });
});
