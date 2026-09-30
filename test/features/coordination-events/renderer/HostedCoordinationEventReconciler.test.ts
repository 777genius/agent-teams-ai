import {
  type CoordinationSnapshotEnvelope,
  HOSTED_COORDINATION_EVENT_SSE_EVENT,
  type HostedCoordinationEventEnvelope,
  type ReplayCursor,
} from '@features/coordination-events/contracts';
import { HostedCoordinationEventReconciler } from '@features/coordination-events/renderer';
import { describe, expect, it } from 'vitest';

function cursor(value: string): ReplayCursor {
  return value as ReplayCursor;
}

function snapshot(
  input: {
    deploymentId?: string;
    eventEpoch?: string;
    handoffMode?: 'same_transaction' | 'lower_barrier';
    revision?: number;
  } = {}
): CoordinationSnapshotEnvelope<{ tasks: readonly string[] }> {
  return {
    metadata: {
      schemaVersion: 1,
      deploymentId: input.deploymentId ?? 'deployment-1',
      eventEpoch: input.eventEpoch ?? 'epoch-1',
      handoffMode: input.handoffMode ?? 'same_transaction',
      replayCursor: cursor('cursor-0'),
      revisionVector: [{ resourceKey: 'task:1', generation: 1, revision: input.revision ?? 0 }],
    },
    snapshot: { tasks: [] },
  };
}

function event(
  input: {
    sequence?: number;
    id?: string;
    previousCursor?: string;
    eventCursor?: string;
    deploymentId?: string;
    eventEpoch?: string;
    generation?: number;
    revision?: number;
  } = {}
): HostedCoordinationEventEnvelope {
  const sequence = input.sequence ?? 1;
  return {
    schemaVersion: 1,
    kind: HOSTED_COORDINATION_EVENT_SSE_EVENT,
    deploymentId: input.deploymentId ?? 'deployment-1',
    eventEpoch: input.eventEpoch ?? 'epoch-1',
    eventSequence: sequence,
    eventId: input.id ?? `event-${sequence}`,
    previousEventCursor: cursor(input.previousCursor ?? `cursor-${sequence - 1}`),
    eventCursor: cursor(input.eventCursor ?? `cursor-${sequence}`),
    scope: { kind: 'team', scopeId: 'team-1' },
    eventType: 'task.updated',
    resourceRevision: {
      resourceKey: 'task:1',
      generation: input.generation ?? 1,
      revision: input.revision ?? sequence,
    },
    emittedAt: '2026-08-03T00:00:00.000Z',
    payload: { taskId: 'task-1' },
  };
}

describe('HostedCoordinationEventReconciler', () => {
  it('deterministically advances cursor and aggregate revision state', () => {
    const reconciler = new HostedCoordinationEventReconciler();
    const initial = reconciler.fromSnapshot({ snapshot: snapshot(), generation: 7 });
    const first = reconciler.reconcile({ state: initial, event: event(), generation: 7 });

    expect(first.kind).toBe('applied');
    expect(first.state).toMatchObject({
      generation: 7,
      cursor: 'cursor-1',
      lastEventSequence: 1,
      processedEvents: [{ eventId: 'event-1', eventCursor: 'cursor-1' }],
    });
    expect(first.state.revisionVector).toEqual([
      { resourceKey: 'task:1', generation: 1, revision: 1 },
    ]);
    expect(Object.isFrozen(first.state)).toBe(true);
    expect(Object.isFrozen(first.state.revisionVector)).toBe(true);

    const repeated = reconciler.reconcile({ state: initial, event: event(), generation: 7 });
    expect(repeated).toEqual(first);
  });

  it('suppresses exact redelivery and bounds its deterministic duplicate window', () => {
    const reconciler = new HostedCoordinationEventReconciler({ processedEventWindow: 2 });
    const initial = reconciler.fromSnapshot({ snapshot: snapshot(), generation: 1 });
    const first = reconciler.reconcile({ state: initial, event: event(), generation: 1 });
    const duplicate = reconciler.reconcile({
      state: first.state,
      event: event(),
      generation: 1,
    });
    expect(duplicate.kind).toBe('duplicate');
    expect(duplicate.state).toBe(first.state);

    const second = reconciler.reconcile({
      state: first.state,
      event: event({ sequence: 2 }),
      generation: 1,
    });
    const third = reconciler.reconcile({
      state: second.state,
      event: event({ sequence: 3 }),
      generation: 1,
    });
    expect(third.state.processedEvents).toEqual([
      { eventId: 'event-2', eventCursor: 'cursor-2' },
      { eventId: 'event-3', eventCursor: 'cursor-3' },
    ]);
  });

  it('fails closed when previously processed event IDs and cursors are cross-paired', () => {
    const reconciler = new HostedCoordinationEventReconciler();
    const initial = reconciler.fromSnapshot({ snapshot: snapshot(), generation: 1 });
    const first = reconciler.reconcile({ state: initial, event: event(), generation: 1 });
    const second = reconciler.reconcile({
      state: first.state,
      event: event({ sequence: 2 }),
      generation: 1,
    });

    expect(
      reconciler.reconcile({
        state: second.state,
        event: event({ sequence: 1, id: 'event-1', eventCursor: 'cursor-2' }),
        generation: 1,
      })
    ).toMatchObject({ kind: 'resync_required', reason: 'event_gap', state: second.state });
  });

  it('fails closed on cursor gaps and deployment or epoch changes', () => {
    const reconciler = new HostedCoordinationEventReconciler();
    const initial = reconciler.fromSnapshot({ snapshot: snapshot(), generation: 1 });

    expect(
      reconciler.reconcile({
        state: initial,
        event: event({ sequence: 2, previousCursor: 'cursor-missing' }),
        generation: 1,
      })
    ).toMatchObject({ kind: 'resync_required', reason: 'event_gap', state: initial });
    expect(
      reconciler.reconcile({
        state: initial,
        event: event({ deploymentId: 'deployment-2' }),
        generation: 1,
      })
    ).toMatchObject({ kind: 'resync_required', reason: 'foreign_deployment' });
    expect(
      reconciler.reconcile({
        state: initial,
        event: event({ eventEpoch: 'epoch-2' }),
        generation: 1,
      })
    ).toMatchObject({ kind: 'resync_required', reason: 'foreign_epoch' });
  });

  it('fences stale selection generations without mutating current state', () => {
    const reconciler = new HostedCoordinationEventReconciler();
    const current = reconciler.fromSnapshot({ snapshot: snapshot(), generation: 4 });
    const result = reconciler.reconcile({ state: current, event: event(), generation: 3 });

    expect(result).toEqual({ kind: 'stale_generation', state: current });
    expect(result.state).toBe(current);
  });

  it('uses snapshot handoff and resource generations as aggregate fences', () => {
    const reconciler = new HostedCoordinationEventReconciler();
    const lowerBarrier = reconciler.fromSnapshot({
      snapshot: snapshot({ handoffMode: 'lower_barrier', revision: 2 }),
      generation: 1,
    });
    const overlap = reconciler.reconcile({
      state: lowerBarrier,
      event: event({ revision: 1 }),
      generation: 1,
    });
    expect(overlap.kind).toBe('duplicate');
    expect(overlap.state.cursor).toBe('cursor-1');

    const sameTransaction = reconciler.fromSnapshot({
      snapshot: snapshot({ handoffMode: 'same_transaction', revision: 2 }),
      generation: 1,
    });
    expect(
      reconciler.reconcile({
        state: sameTransaction,
        event: event({ revision: 1 }),
        generation: 1,
      })
    ).toMatchObject({ kind: 'resync_required', reason: 'event_gap' });
    expect(
      reconciler.reconcile({
        state: sameTransaction,
        event: event({ generation: 3, revision: 1 }),
        generation: 1,
      })
    ).toMatchObject({ kind: 'resync_required', reason: 'event_gap' });
  });
});
