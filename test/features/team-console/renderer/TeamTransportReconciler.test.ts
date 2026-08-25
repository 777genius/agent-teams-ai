import {
  type TeamTransportBootstrapSnapshot,
  type TeamTransportEventApplicationInput,
  TeamTransportReconciler,
  type TeamTransportReconcilerFailure,
  type TeamTransportSnapshotCommit,
  type TeamTransportStreamRequest,
} from '@features/team-console/renderer';
import { describe, expect, it, vi } from 'vitest';

import type {
  CoordinationResourceRevision,
  HostedCoordinationEventEnvelope,
  ReplayCursor,
} from '@features/coordination-events/contracts';

interface Projection {
  readonly value: string;
}

const opaqueCursor = (value: string): ReplayCursor => value as ReplayCursor;
const SCOPE = Object.freeze({ kind: 'team', scopeId: 'team-1' } as const);

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function snapshot(input: {
  readonly cursor: string;
  readonly value: string;
  readonly deploymentId?: string;
  readonly eventEpoch?: string;
  readonly scopeId?: string;
  readonly scopeGeneration?: number;
  readonly revisions?: readonly CoordinationResourceRevision[];
}): TeamTransportBootstrapSnapshot<Projection> {
  return {
    scope: { ...SCOPE, ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }) },
    scopeGeneration: input.scopeGeneration ?? 7,
    envelope: {
      metadata: {
        schemaVersion: 1,
        deploymentId: input.deploymentId ?? 'deployment-1',
        eventEpoch: input.eventEpoch ?? 'epoch-1',
        handoffMode: 'lower_barrier',
        replayCursor: opaqueCursor(input.cursor),
        revisionVector: input.revisions ?? [
          { resourceKey: 'team:team-1', generation: 2, revision: 4 },
        ],
      },
      snapshot: { value: input.value },
    },
  };
}

function event(input: {
  readonly id: string;
  readonly previous: string;
  readonly cursor: string;
  readonly deploymentId?: string;
  readonly eventEpoch?: string;
  readonly scopeId?: string;
  readonly generation?: number;
  readonly revision?: number;
}): HostedCoordinationEventEnvelope {
  return {
    schemaVersion: 1,
    kind: 'coordination_event',
    deploymentId: input.deploymentId ?? 'deployment-1',
    eventEpoch: input.eventEpoch ?? 'epoch-1',
    eventSequence: Number(input.cursor.replace(/\D/g, '')) || 1,
    eventId: input.id,
    previousEventCursor: opaqueCursor(input.previous),
    eventCursor: opaqueCursor(input.cursor),
    scope: { ...SCOPE, ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }) },
    eventType: 'team.changed',
    resourceRevision: {
      resourceKey: 'team:team-1',
      generation: input.generation ?? 2,
      revision: input.revision ?? 5,
    },
    emittedAt: '2026-08-02T00:00:00.000Z',
    payload: { value: input.id },
  };
}

function harness(
  snapshots: TeamTransportBootstrapSnapshot<Projection>[],
  options: { readonly maxPendingMessages?: number } = {}
) {
  const streamRequests: TeamTransportStreamRequest[] = [];
  const subscriptionCloses: Array<ReturnType<typeof vi.fn>> = [];
  const failures: TeamTransportReconcilerFailure[] = [];
  const replaceSnapshot = vi.fn(
    async (_commit: TeamTransportSnapshotCommit<Projection>) => undefined
  );
  const applyEvent = vi.fn(
    async (_input: TeamTransportEventApplicationInput) => 'applied' as const
  );
  const loadSnapshot = vi.fn(async () => {
    const next = snapshots.shift();
    if (!next) throw new Error('no snapshot fixture');
    return next;
  });
  const reconciler = new TeamTransportReconciler<Projection>({
    scope: SCOPE,
    scopeGeneration: 7,
    ...(options.maxPendingMessages === undefined
      ? {}
      : { maxPendingMessages: options.maxPendingMessages }),
    ports: {
      bootstrap: { loadSnapshot },
      stream: {
        subscribe: vi.fn((request: TeamTransportStreamRequest) => {
          streamRequests.push(request);
          const close = vi.fn();
          subscriptionCloses.push(close);
          return { close };
        }),
      },
      projection: { replaceSnapshot, applyEvent },
      observer: { onFailure: (failure) => failures.push(failure) },
    },
  });
  return {
    reconciler,
    loadSnapshot,
    replaceSnapshot,
    applyEvent,
    streamRequests,
    subscriptionCloses,
    failures,
  };
}

describe('TeamTransportReconciler', () => {
  it('commits the fenced snapshot before subscribing from its lower cursor', async () => {
    const test = harness([snapshot({ cursor: 'cursor-0', value: 'initial' })]);

    await test.reconciler.start();

    expect(test.reconciler.status).toBe('live');
    expect(test.replaceSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: SCOPE,
        scopeGeneration: 7,
        deploymentId: 'deployment-1',
        eventEpoch: 'epoch-1',
        eventCursor: 'cursor-0',
        snapshot: { value: 'initial' },
      })
    );
    expect(test.streamRequests).toHaveLength(1);
    expect(test.streamRequests[0]).toMatchObject({
      scope: SCOPE,
      scopeGeneration: 7,
      deploymentId: 'deployment-1',
      eventEpoch: 'epoch-1',
      after: 'cursor-0',
    });
  });

  it('applies sequential revisions and ignores duplicate or stale generations while advancing the cursor', async () => {
    const test = harness([snapshot({ cursor: 'cursor-0', value: 'initial' })]);
    await test.reconciler.start();
    const deliver = test.streamRequests[0].onMessage;
    const first = event({
      id: 'event-1',
      previous: 'cursor-0',
      cursor: 'cursor-1',
      revision: 5,
    });

    await deliver(first);
    await deliver(first);
    await deliver(
      event({
        id: 'event-old-generation',
        previous: 'cursor-1',
        cursor: 'cursor-2',
        generation: 1,
        revision: 99,
      })
    );
    await deliver(
      event({
        id: 'event-2',
        previous: 'cursor-2',
        cursor: 'cursor-3',
        revision: 6,
      })
    );

    expect(test.applyEvent).toHaveBeenCalledTimes(2);
    expect(test.applyEvent.mock.calls.map(([input]) => input.event.eventId)).toEqual([
      'event-1',
      'event-2',
    ]);
    expect(test.reconciler.status).toBe('live');
  });

  it('performs one bounded rebootstrap for a cursor gap and fences callbacks from the old stream', async () => {
    const test = harness([
      snapshot({ cursor: 'cursor-0', value: 'initial' }),
      snapshot({ cursor: 'cursor-20', value: 'recovered', revisions: [] }),
    ]);
    await test.reconciler.start();
    const oldStream = test.streamRequests[0];

    await oldStream.onMessage(
      event({ id: 'gap', previous: 'cursor-missing', cursor: 'cursor-10' })
    );

    expect(test.loadSnapshot).toHaveBeenCalledTimes(2);
    expect(test.replaceSnapshot).toHaveBeenCalledTimes(2);
    expect(test.subscriptionCloses[0]).toHaveBeenCalledTimes(1);
    expect(test.streamRequests[1].after).toBe('cursor-20');
    expect(test.reconciler.status).toBe('live');

    await oldStream.onMessage(
      event({ id: 'stale-cycle', previous: 'cursor-0', cursor: 'cursor-1' })
    );
    expect(test.applyEvent).not.toHaveBeenCalled();

    await test.streamRequests[1].onMessage(
      event({
        id: 'foreign-after-recovery',
        previous: 'cursor-20',
        cursor: 'cursor-21',
        deploymentId: 'deployment-foreign',
      })
    );
    expect(test.loadSnapshot).toHaveBeenCalledTimes(2);
    expect(test.reconciler.status).toBe('failed');
    expect(test.failures).toEqual([expect.objectContaining({ reason: 'deployment_mismatch' })]);
  });

  it('retries a stale scope generation once and then opens only the valid stream', async () => {
    const test = harness([
      snapshot({ cursor: 'cursor-stale', value: 'stale', scopeGeneration: 6 }),
      snapshot({ cursor: 'cursor-current', value: 'current', scopeGeneration: 7 }),
    ]);

    await test.reconciler.start();

    expect(test.loadSnapshot).toHaveBeenCalledTimes(2);
    expect(test.replaceSnapshot).toHaveBeenCalledTimes(1);
    expect(test.streamRequests).toHaveLength(1);
    expect(test.streamRequests[0].after).toBe('cursor-current');
    expect(test.reconciler.status).toBe('live');
  });

  it('rebootstraps on a resource revision gap instead of applying it', async () => {
    const test = harness([
      snapshot({ cursor: 'cursor-0', value: 'initial' }),
      snapshot({ cursor: 'cursor-9', value: 'recovered' }),
    ]);
    await test.reconciler.start();

    await test.streamRequests[0].onMessage(
      event({
        id: 'revision-gap',
        previous: 'cursor-0',
        cursor: 'cursor-1',
        revision: 8,
      })
    );

    expect(test.applyEvent).not.toHaveBeenCalled();
    expect(test.loadSnapshot).toHaveBeenCalledTimes(2);
    expect(test.streamRequests[1].after).toBe('cursor-9');
  });

  it('fences delayed projection commits across bounded queue overflow and recovery', async () => {
    const firstProjection = deferred<void>();
    const secondProjection = deferred<void>();
    const projectionCommits: boolean[] = [];
    let visibleProjection = 'unset';
    const test = harness(
      [
        snapshot({ cursor: 'cursor-0', value: 'initial' }),
        snapshot({ cursor: 'cursor-10', value: 'recovered' }),
      ],
      { maxPendingMessages: 1 }
    );
    test.replaceSnapshot.mockImplementation(async ({ snapshot: replacement }) => {
      visibleProjection = replacement.value;
    });
    test.applyEvent
      .mockImplementationOnce(async (input) => {
        await firstProjection.promise;
        projectionCommits.push(
          input.projectionToken.commitIfCurrent(() => {
            visibleProjection = input.event.eventId;
          })
        );
        return 'applied';
      })
      .mockImplementationOnce(async (input) => {
        await secondProjection.promise;
        projectionCommits.push(
          input.projectionToken.commitIfCurrent(() => {
            visibleProjection = input.event.eventId;
          })
        );
        return 'applied';
      });
    await test.reconciler.start();
    const firstStream = test.streamRequests[0];

    const firstProjectionHandling = firstStream.onMessage(
      event({ id: 'slow-first', previous: 'cursor-0', cursor: 'cursor-1', revision: 5 })
    );
    await vi.waitFor(() => expect(test.applyEvent).toHaveBeenCalledTimes(1));
    await firstStream.onMessage(
      event({ id: 'overflow-first', previous: 'cursor-1', cursor: 'cursor-2', revision: 6 })
    );

    expect(test.loadSnapshot).toHaveBeenCalledTimes(2);
    expect(test.subscriptionCloses[0]).toHaveBeenCalledTimes(1);
    expect(test.reconciler.status).toBe('live');
    expect(visibleProjection).toBe('recovered');

    firstProjection.resolve(undefined);
    await firstProjectionHandling;
    expect(projectionCommits).toEqual([false]);
    expect(visibleProjection).toBe('recovered');

    const secondStream = test.streamRequests[1];

    const secondProjectionHandling = secondStream.onMessage(
      event({ id: 'slow-second', previous: 'cursor-10', cursor: 'cursor-11', revision: 5 })
    );
    await vi.waitFor(() => expect(test.applyEvent).toHaveBeenCalledTimes(2));
    await secondStream.onMessage(
      event({ id: 'overflow-second', previous: 'cursor-11', cursor: 'cursor-12', revision: 6 })
    );

    expect(test.reconciler.status).toBe('failed');
    expect(test.subscriptionCloses[1]).toHaveBeenCalledTimes(1);
    expect(test.failures).toEqual([expect.objectContaining({ reason: 'pending_queue_overflow' })]);

    secondProjection.resolve(undefined);
    await secondProjectionHandling;
    expect(projectionCommits).toEqual([false, false]);
    expect(visibleProjection).toBe('recovered');
  });

  it('aborts and closes its injected transport exactly once', async () => {
    const test = harness([snapshot({ cursor: 'cursor-0', value: 'initial' })]);
    await test.reconciler.start();
    const signal = test.streamRequests[0].signal;

    test.reconciler.close();
    test.reconciler.close();

    expect(signal.aborted).toBe(true);
    expect(test.subscriptionCloses[0]).toHaveBeenCalledTimes(1);
    expect(test.reconciler.status).toBe('closed');
    await test.streamRequests[0].onMessage(
      event({ id: 'after-close', previous: 'cursor-0', cursor: 'cursor-1' })
    );
    expect(test.applyEvent).not.toHaveBeenCalled();
  });
});
