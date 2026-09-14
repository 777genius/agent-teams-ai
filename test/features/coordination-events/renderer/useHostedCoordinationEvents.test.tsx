import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  type CoordinationEventScope,
  type CoordinationSnapshotEnvelope,
  HOSTED_COORDINATION_EVENT_SSE_EVENT,
  type HostedCoordinationEventEnvelope,
  type ReplayCursor,
} from '@features/coordination-events/contracts';
import {
  type HostedCoordinationEventConnection,
  type HostedCoordinationEventTransport,
  type HostedCoordinationEventTransportConnectInput,
  type HostedCoordinationSnapshotResyncPort,
  useHostedCoordinationEvents,
  type UseHostedCoordinationEventsResult,
} from '@features/coordination-events/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Projection {
  readonly tasks: readonly string[];
}

function cursor(value: string): ReplayCursor {
  return value as ReplayCursor;
}

function snapshot(scopeId: string): CoordinationSnapshotEnvelope<Projection> {
  return {
    metadata: {
      schemaVersion: 1,
      deploymentId: 'deployment-1',
      eventEpoch: 'epoch-1',
      handoffMode: 'same_transaction',
      replayCursor: cursor(`${scopeId}-cursor-0`),
      revisionVector: [{ resourceKey: `team:${scopeId}`, generation: 1, revision: 0 }],
    },
    snapshot: { tasks: [] },
  };
}

function event(input: {
  scopeId: string;
  sequence?: number;
  previousCursor?: string;
  eventCursor?: string;
  eventId?: string;
}): HostedCoordinationEventEnvelope {
  const sequence = input.sequence ?? 1;
  return {
    schemaVersion: 1,
    kind: HOSTED_COORDINATION_EVENT_SSE_EVENT,
    deploymentId: 'deployment-1',
    eventEpoch: 'epoch-1',
    eventSequence: sequence,
    eventId: input.eventId ?? `${input.scopeId}-event-${sequence}`,
    previousEventCursor: cursor(input.previousCursor ?? `${input.scopeId}-cursor-${sequence - 1}`),
    eventCursor: cursor(input.eventCursor ?? `${input.scopeId}-cursor-${sequence}`),
    scope: { kind: 'team', scopeId: input.scopeId },
    eventType: 'task.updated',
    resourceRevision: {
      resourceKey: `team:${input.scopeId}`,
      generation: 1,
      revision: sequence,
    },
    emittedAt: '2026-08-03T00:00:00.000Z',
    payload: { taskId: `${input.scopeId}-task-1` },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

interface FakeConnectionRecord {
  readonly input: HostedCoordinationEventTransportConnectInput;
  readonly connection: HostedCoordinationEventConnection;
  readonly close: ReturnType<typeof vi.fn>;
}

function createTransport(): HostedCoordinationEventTransport & {
  readonly connections: FakeConnectionRecord[];
} {
  const connections: FakeConnectionRecord[] = [];
  return {
    connections,
    connect(input) {
      const close = vi.fn();
      const connection: HostedCoordinationEventConnection = {
        cursor: input.resumeCursor,
        close,
      };
      connections.push({
        input: input as unknown as HostedCoordinationEventTransportConnectInput,
        connection,
        close,
      });
      return connection;
    },
  };
}

let latest: UseHostedCoordinationEventsResult<Projection> | null = null;

function Probe(props: {
  readonly authenticated: boolean;
  readonly scope: CoordinationEventScope | null;
  readonly transport: HostedCoordinationEventTransport;
  readonly snapshotResync: HostedCoordinationSnapshotResyncPort<Projection>;
  readonly applyEvent: (
    current: Projection,
    nextEvent: HostedCoordinationEventEnvelope
  ) => Projection;
}): React.JSX.Element | null {
  latest = useHostedCoordinationEvents(props);
  return null;
}

async function renderAndFlush(
  root: ReturnType<typeof createRoot>,
  props: React.ComponentProps<typeof Probe>
): Promise<void> {
  await act(async () => {
    root.render(<Probe {...props} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useHostedCoordinationEvents', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    latest = null;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('loads a snapshot, resumes from its cursor, and applies live events', async () => {
    const transport = createTransport();
    const snapshotResync: HostedCoordinationSnapshotResyncPort<Projection> = {
      loadSnapshot: vi.fn().mockResolvedValue(snapshot('alpha')),
    };
    const applyEvent = vi.fn((current: Projection) => ({
      tasks: [...current.tasks, 'alpha-task-1'],
    }));
    const host = document.createElement('div');
    const root = createRoot(host);
    const props = {
      authenticated: true,
      scope: { kind: 'team', scopeId: 'alpha' } as const,
      transport,
      snapshotResync,
      applyEvent,
    };

    await renderAndFlush(root, props);
    expect(transport.connections[0].input.resumeCursor).toBe('alpha-cursor-0');
    expect(latest).toMatchObject({ status: 'connecting', snapshot: { tasks: [] } });

    act(() => transport.connections[0].input.handlers.onOpen?.());
    expect(latest?.status).toBe('live');
    act(() => {
      expect(transport.connections[0].input.handlers.onEvent(event({ scopeId: 'alpha' }))).toEqual({
        kind: 'advance',
        resumeCursor: 'alpha-cursor-1',
      });
    });
    expect(latest).toMatchObject({
      status: 'live',
      snapshot: { tasks: ['alpha-task-1'] },
      cursor: 'alpha-cursor-1',
    });
    expect(applyEvent).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it('closes a gapped stream and performs snapshot resync before reconnecting', async () => {
    const transport = createTransport();
    const loadSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot('alpha'))
      .mockResolvedValueOnce({
        ...snapshot('alpha'),
        metadata: { ...snapshot('alpha').metadata, replayCursor: cursor('alpha-cursor-9') },
      });
    const snapshotResync = { loadSnapshot };
    const host = document.createElement('div');
    const root = createRoot(host);

    await renderAndFlush(root, {
      authenticated: true,
      scope: { kind: 'team', scopeId: 'alpha' },
      transport,
      snapshotResync,
      applyEvent: (current) => current,
    });
    await act(async () => {
      expect(
        transport.connections[0].input.handlers.onEvent(
          event({ scopeId: 'alpha', previousCursor: 'missing-cursor' })
        )
      ).toEqual({ kind: 'stop' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(transport.connections[0].close).toHaveBeenCalled();
    expect(loadSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ cause: 'event_gap', scope: { kind: 'team', scopeId: 'alpha' } })
    );
    expect(transport.connections[1].input.resumeCursor).toBe('alpha-cursor-9');
    await act(async () => root.unmount());
  });

  it('returns the current resume cursor when an exact historical event is redelivered', async () => {
    const transport = createTransport();
    const applyEvent = vi.fn((current: Projection) => current);
    const host = document.createElement('div');
    const root = createRoot(host);

    await renderAndFlush(root, {
      authenticated: true,
      scope: { kind: 'team', scopeId: 'alpha' },
      transport,
      snapshotResync: { loadSnapshot: vi.fn().mockResolvedValue(snapshot('alpha')) },
      applyEvent,
    });
    const { onEvent } = transport.connections[0].input.handlers;
    act(() => {
      expect(onEvent(event({ scopeId: 'alpha', sequence: 1 }))).toEqual({
        kind: 'advance',
        resumeCursor: 'alpha-cursor-1',
      });
      expect(onEvent(event({ scopeId: 'alpha', sequence: 2 }))).toEqual({
        kind: 'advance',
        resumeCursor: 'alpha-cursor-2',
      });
      expect(onEvent(event({ scopeId: 'alpha', sequence: 3 }))).toEqual({
        kind: 'advance',
        resumeCursor: 'alpha-cursor-3',
      });
      expect(onEvent(event({ scopeId: 'alpha', sequence: 1 }))).toEqual({
        kind: 'advance',
        resumeCursor: 'alpha-cursor-3',
      });
    });

    expect(latest?.cursor).toBe('alpha-cursor-3');
    expect(applyEvent).toHaveBeenCalledTimes(3);
    await act(async () => root.unmount());
  });

  it('uses retention resync messages to replace the projection', async () => {
    const transport = createTransport();
    const replacement = snapshot('alpha');
    const loadSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot('alpha'))
      .mockResolvedValueOnce({ ...replacement, snapshot: { tasks: ['from-resync'] } });
    const host = document.createElement('div');
    const root = createRoot(host);

    await renderAndFlush(root, {
      authenticated: true,
      scope: { kind: 'team', scopeId: 'alpha' },
      transport,
      snapshotResync: { loadSnapshot },
      applyEvent: (current) => current,
    });
    await act(async () => {
      transport.connections[0].input.handlers.onResyncRequired('cursor_expired');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ cause: 'cursor_expired' })
    );
    expect(latest?.snapshot).toEqual({ tasks: ['from-resync'] });
    await act(async () => root.unmount());
  });

  it('aborts and fences stale streams across scope changes and logout', async () => {
    const transport = createTransport();
    const betaSnapshot = deferred<CoordinationSnapshotEnvelope<Projection>>();
    const loadSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot('alpha'))
      .mockReturnValueOnce(betaSnapshot.promise);
    const snapshotResync = { loadSnapshot };
    const applyEvent = vi.fn((current: Projection) => ({
      tasks: [...current.tasks, 'stale-mutation'],
    }));
    const host = document.createElement('div');
    const root = createRoot(host);
    const alphaProps = {
      authenticated: true,
      scope: { kind: 'team', scopeId: 'alpha' } as const,
      transport,
      snapshotResync,
      applyEvent,
    };
    await renderAndFlush(root, alphaProps);
    const alphaConnection = transport.connections[0];

    await renderAndFlush(root, {
      ...alphaProps,
      scope: { kind: 'team', scopeId: 'beta' },
    });
    expect(alphaConnection.input.signal.aborted).toBe(true);
    expect(alphaConnection.close).toHaveBeenCalled();
    expect(latest).toMatchObject({ status: 'resyncing', snapshot: null });

    act(() => {
      expect(alphaConnection.input.handlers.onEvent(event({ scopeId: 'alpha' }))).toEqual({
        kind: 'stop',
      });
    });
    expect(applyEvent).not.toHaveBeenCalled();

    await act(async () => {
      betaSnapshot.resolve(snapshot('beta'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest?.snapshot).toEqual({ tasks: [] });
    expect(transport.connections[1].input.resumeCursor).toBe('beta-cursor-0');

    await renderAndFlush(root, { ...alphaProps, authenticated: false, scope: null });
    expect(transport.connections[1].input.signal.aborted).toBe(true);
    expect(transport.connections[1].close).toHaveBeenCalled();
    expect(latest).toMatchObject({ status: 'idle', snapshot: null });
    await act(async () => root.unmount());
  });

  it('aborts an in-flight snapshot on unmount', async () => {
    const transport = createTransport();
    const pending = deferred<CoordinationSnapshotEnvelope<Projection>>();
    const snapshotSignals: AbortSignal[] = [];
    const snapshotResync: HostedCoordinationSnapshotResyncPort<Projection> = {
      loadSnapshot: vi.fn((input) => {
        snapshotSignals.push(input.signal);
        return pending.promise;
      }),
    };
    const host = document.createElement('div');
    const root = createRoot(host);

    await renderAndFlush(root, {
      authenticated: true,
      scope: { kind: 'team', scopeId: 'alpha' },
      transport,
      snapshotResync,
      applyEvent: (current) => current,
    });
    await act(async () => root.unmount());
    expect(snapshotSignals[0]?.aborted).toBe(true);
    expect(transport.connections).toHaveLength(0);
  });
});
