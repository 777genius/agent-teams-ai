import {
  HOSTED_COORDINATION_EVENT_SSE_EVENT,
  HOSTED_COORDINATION_RESYNC_SSE_EVENT,
  type HostedCoordinationEventEnvelope,
  type ReplayCursor,
} from '@features/coordination-events/contracts';
import {
  createHostedCoordinationEventTransport,
  HostedCoordinationEventReconciler,
  type HostedCoordinationEventReconciliationState,
  type HostedCoordinationEventSourceInit,
  type HostedCoordinationEventSourceLike,
  type HostedCoordinationEventSourceListener,
  type HostedCoordinationEventTimingPort,
} from '@features/coordination-events/renderer';
import { describe, expect, it, vi } from 'vitest';

class FakeEventSource implements HostedCoordinationEventSourceLike {
  private readonly listeners = new Map<string, Set<HostedCoordinationEventSourceListener>>();
  readonly close = vi.fn();

  constructor(
    readonly url: string,
    readonly init: HostedCoordinationEventSourceInit
  ) {}

  addEventListener(type: string, listener: HostedCoordinationEventSourceListener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: HostedCoordinationEventSourceListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(
    type: string,
    event: { readonly data?: unknown; readonly lastEventId?: unknown } = {}
  ): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

class FakeTiming implements HostedCoordinationEventTimingPort {
  readonly tasks: Array<{ delayMs: number; callback: () => void; cancelled: boolean }> = [];

  schedule(delayMs: number, callback: () => void): () => void {
    const task = { delayMs, callback, cancelled: false };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  }

  run(index: number): void {
    const task = this.tasks[index];
    if (task && !task.cancelled) task.callback();
  }
}

function cursor(value: string): ReplayCursor {
  return value as ReplayCursor;
}

function event(
  eventCursor = cursor('cursor-1'),
  previousEventCursor = cursor('cursor-0')
): HostedCoordinationEventEnvelope {
  return {
    schemaVersion: 1,
    kind: HOSTED_COORDINATION_EVENT_SSE_EVENT,
    deploymentId: 'deployment-1',
    eventEpoch: 'epoch-1',
    eventSequence: 1,
    eventId: 'event-1',
    previousEventCursor,
    eventCursor,
    scope: { kind: 'team', scopeId: 'team-1' },
    eventType: 'task.updated',
    resourceRevision: { resourceKey: 'task:1', generation: 1, revision: 1 },
    emittedAt: '2026-08-03T00:00:00.000Z',
    payload: { taskId: 'task-1' },
  };
}

function harness(input: { readonly backoffDelay?: number | null } = {}) {
  const sources: FakeEventSource[] = [];
  const EventSourceConstructor = class extends FakeEventSource {
    constructor(url: string, init: HostedCoordinationEventSourceInit) {
      super(url, init);
      sources.push(this);
    }
  };
  const timing = new FakeTiming();
  const backoff = vi.fn(() => input.backoffDelay ?? 25);
  const transport = createHostedCoordinationEventTransport({
    eventSourceConstructor: EventSourceConstructor,
    timing,
    backoff: { nextDelayMs: backoff },
    maximumReconnectDelayMs: 100,
  });
  return { transport, sources, timing, backoff };
}

describe('createHostedCoordinationEventTransport', () => {
  it('uses cookie credentials and the cursor query/Last-Event-ID hint on every connection', () => {
    const { transport, sources, timing } = harness();
    const controller = new AbortController();
    const onEvent = vi.fn(() =>
      Object.freeze({ kind: 'advance' as const, resumeCursor: cursor('cursor-1') })
    );
    const onReconnectScheduled = vi.fn();
    const connection = transport.connect({
      resumeCursor: cursor('cursor-0'),
      signal: controller.signal,
      handlers: {
        onEvent,
        onResyncRequired: vi.fn(),
        onReconnectScheduled,
      },
    });

    expect(sources[0].url).toBe('/api/hosted/v1/events?after=cursor-0');
    expect(sources[0].init).toEqual({ withCredentials: true, lastEventId: 'cursor-0' });

    const nextEvent = event();
    sources[0].emit(HOSTED_COORDINATION_EVENT_SSE_EVENT, {
      data: JSON.stringify(nextEvent),
      lastEventId: nextEvent.eventCursor,
    });
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'event-1', eventCursor: 'cursor-1' })
    );
    expect(connection.cursor).toBe('cursor-1');

    sources[0].emit('error');
    expect(onReconnectScheduled).toHaveBeenCalledWith({ attempt: 1, delayMs: 25 });
    timing.run(0);
    expect(sources[1].url).toBe('/api/hosted/v1/events?after=cursor-1');
    expect(sources[1].init.lastEventId).toBe('cursor-1');
  });

  it('retains the authoritative current cursor when a historical duplicate is redelivered', () => {
    const { transport, sources, timing } = harness();
    const reconciler = new HostedCoordinationEventReconciler();
    let state: HostedCoordinationEventReconciliationState = Object.freeze({
      generation: 1,
      deploymentId: 'deployment-1',
      eventEpoch: 'epoch-1',
      handoffMode: 'same_transaction',
      cursor: cursor('cursor-3'),
      lastEventSequence: 3,
      revisionVector: Object.freeze([
        Object.freeze({ resourceKey: 'task:1', generation: 1, revision: 3 }),
      ]),
      processedEvents: Object.freeze([
        Object.freeze({ eventId: 'event-1', eventCursor: cursor('cursor-1') }),
        Object.freeze({ eventId: 'event-2', eventCursor: cursor('cursor-2') }),
        Object.freeze({ eventId: 'event-3', eventCursor: cursor('cursor-3') }),
      ]),
    });
    const onEvent = vi.fn((nextEvent: HostedCoordinationEventEnvelope) => {
      const result = reconciler.reconcile({ state, event: nextEvent, generation: 1 });
      if (result.kind === 'applied' || result.kind === 'duplicate') {
        state = result.state;
        return Object.freeze({ kind: 'advance' as const, resumeCursor: result.state.cursor });
      }
      return Object.freeze({ kind: 'stop' as const });
    });
    const connection = transport.connect({
      resumeCursor: cursor('cursor-3'),
      signal: new AbortController().signal,
      handlers: { onEvent, onResyncRequired: vi.fn() },
    });

    sources[0].emit(HOSTED_COORDINATION_EVENT_SSE_EVENT, {
      data: JSON.stringify(event(cursor('cursor-1'), cursor('cursor-0'))),
      lastEventId: 'cursor-1',
    });
    expect(onEvent).toHaveReturnedWith({ kind: 'advance', resumeCursor: 'cursor-3' });
    expect(connection.cursor).toBe('cursor-3');

    sources[0].emit('error');
    timing.run(0);
    expect(sources[1].url).toBe('/api/hosted/v1/events?after=cursor-3');
    expect(sources[1].init.lastEventId).toBe('cursor-3');
  });

  it('bounds injected backoff and ignores detached stale sources', () => {
    const { transport, sources, timing } = harness({ backoffDelay: 10_000 });
    const onEvent = vi.fn(() =>
      Object.freeze({ kind: 'advance' as const, resumeCursor: cursor('cursor-1') })
    );
    const onReconnectScheduled = vi.fn();
    transport.connect({
      resumeCursor: cursor('cursor-0'),
      signal: new AbortController().signal,
      handlers: { onEvent, onResyncRequired: vi.fn(), onReconnectScheduled },
    });

    const staleSource = sources[0];
    staleSource.emit('error');
    expect(onReconnectScheduled).toHaveBeenCalledWith({ attempt: 1, delayMs: 100 });
    timing.run(0);
    staleSource.emit(HOSTED_COORDINATION_EVENT_SSE_EVENT, {
      data: JSON.stringify(event()),
      lastEventId: 'cursor-1',
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('fails closed to snapshot resync for malformed payloads and Last-Event-ID mismatches', () => {
    const { transport, sources } = harness();
    const onEvent = vi.fn(() =>
      Object.freeze({ kind: 'advance' as const, resumeCursor: cursor('cursor-1') })
    );
    const onResyncRequired = vi.fn();
    const onError = vi.fn();
    transport.connect({
      resumeCursor: cursor('cursor-0'),
      signal: new AbortController().signal,
      handlers: { onEvent, onResyncRequired, onError },
    });

    sources[0].emit(HOSTED_COORDINATION_EVENT_SSE_EVENT, {
      data: JSON.stringify(event()),
      lastEventId: 'different-cursor',
    });
    expect(onEvent).not.toHaveBeenCalled();
    expect(onResyncRequired).toHaveBeenCalledWith('projection_invalid');
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'hosted_coordination_event_message_invalid' })
    );
    expect(sources[0].close).toHaveBeenCalledTimes(1);
  });

  it('honors terminal server resync and cancels pending reconnect on abort', () => {
    const serverResync = harness();
    const onResyncRequired = vi.fn();
    serverResync.transport.connect({
      resumeCursor: cursor('cursor-0'),
      signal: new AbortController().signal,
      handlers: {
        onEvent: () => Object.freeze({ kind: 'advance', resumeCursor: cursor('cursor-1') }),
        onResyncRequired,
      },
    });
    serverResync.sources[0].emit(HOSTED_COORDINATION_RESYNC_SSE_EVENT, {
      data: JSON.stringify({
        schemaVersion: 1,
        kind: HOSTED_COORDINATION_RESYNC_SSE_EVENT,
        reason: 'cursor_expired',
      }),
    });
    expect(onResyncRequired).toHaveBeenCalledWith('cursor_expired');
    expect(serverResync.sources[0].close).toHaveBeenCalledTimes(1);

    const aborted = harness();
    const controller = new AbortController();
    aborted.transport.connect({
      resumeCursor: cursor('cursor-0'),
      signal: controller.signal,
      handlers: {
        onEvent: () => Object.freeze({ kind: 'advance', resumeCursor: cursor('cursor-1') }),
        onResyncRequired: vi.fn(),
      },
    });
    aborted.sources[0].emit('error');
    controller.abort();
    aborted.timing.run(0);
    expect(aborted.sources).toHaveLength(1);
    expect(aborted.timing.tasks[0].cancelled).toBe(true);
  });
});
