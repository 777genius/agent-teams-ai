import { describe, expect, it, vi } from 'vitest';

import { TeamArtifactReconciliationCoordinator } from './TeamArtifactReconciliationCoordinator';

import type {
  TeamArtifactReconciliationPorts,
  TeamArtifactReconciliationResult,
} from './ports/TeamArtifactReconciliationPorts';

type ReconciliationResultField = keyof TeamArtifactReconciliationResult;
type ObservedResultValue = number | undefined | Error;
type ClockReading = number | Error;

const RECONCILIATION_RESULT_FIELDS = new Set<ReconciliationResultField>([
  'linkedCommentsCreated',
  'staleKanbanEntriesRemoved',
  'staleColumnOrderRefsRemoved',
]);

function createObservedResult(
  reads: Partial<Record<ReconciliationResultField, readonly ObservedResultValue[]>>,
  events: string[]
): TeamArtifactReconciliationResult {
  const readCounts = new Map<ReconciliationResultField, number>();
  return new Proxy({} as TeamArtifactReconciliationResult, {
    get(target, property, receiver) {
      if (
        typeof property !== 'string' ||
        !RECONCILIATION_RESULT_FIELDS.has(property as ReconciliationResultField)
      ) {
        return Reflect.get(target, property, receiver);
      }
      const field = property as ReconciliationResultField;
      const readCount = readCounts.get(field) ?? 0;
      readCounts.set(field, readCount + 1);
      events.push(`get:${field}`);
      const value = reads[field]?.[readCount];
      if (value instanceof Error) throw value;
      return value;
    },
  });
}

function createSequencedClock(readings: readonly ClockReading[], events: string[]) {
  let readIndex = 0;
  return {
    nowMs: vi.fn(() => {
      const reading = readings[readIndex];
      readIndex += 1;
      if (reading === undefined) throw new Error(`Unexpected clock read ${readIndex}`);
      if (reading instanceof Error) {
        events.push(`clock:${readIndex}:throw:${reading.message}`);
        throw reading;
      }
      events.push(`clock:${readIndex}:${String(reading)}`);
      return reading;
    }),
  };
}

function createHarness(
  reconcileArtifacts: TeamArtifactReconciliationPorts['maintenance']['reconcileArtifacts'] = vi.fn()
) {
  let now = 10_000;
  const events: string[] = [];
  const maintenance = vi.fn((teamName: string, request: { reason: 'file-watch' }) => {
    events.push(`maintenance:${teamName}:${request.reason}`);
    return reconcileArtifacts(teamName, request);
  });
  const warn = vi.fn((message: string) => {
    events.push(`warn:${message}`);
  });
  const nowMs = vi.fn(() => {
    events.push(`clock:${now}`);
    return now;
  });
  const coordinator = new TeamArtifactReconciliationCoordinator({
    maintenance: { reconcileArtifacts: maintenance },
    clock: { nowMs },
    logger: { warn },
  });

  return {
    coordinator,
    events,
    maintenance,
    setNow(value: number) {
      now = value;
    },
    warn,
  };
}

describe('team artifact reconciliation coordinator', () => {
  it('preserves mutation order, trigger formatting, and normalized completion diagnostics', async () => {
    const times = [10_000, 10_001, 10_101, 10_102];
    const events: string[] = [];
    const warn = vi.fn((message: string) => {
      events.push(`warn:${message}`);
    });
    const reconcileArtifacts = vi.fn(() => {
      events.push('maintenance');
      return {
        linkedCommentsCreated: 2,
        staleKanbanEntriesRemoved: undefined,
        staleColumnOrderRefsRemoved: 1,
      };
    });
    const coordinator = new TeamArtifactReconciliationCoordinator({
      maintenance: {
        reconcileArtifacts: (_teamName, request) => {
          expect(request).toEqual({ reason: 'file-watch' });
          return reconcileArtifacts();
        },
      },
      clock: {
        nowMs: () => {
          const value = times.shift();
          expect(value).toBeDefined();
          events.push(`clock:${value}`);
          return value!;
        },
      },
      logger: { warn },
    });

    await coordinator.reconcile('team-a', { source: 'task', detail: '  1.json  ' });

    expect(events).toEqual([
      'clock:10000',
      'warn:[reconcileTeamArtifacts] team=team-a reason=file-watch source=task detail=1.json inFlight=1 burst=1',
      'clock:10001',
      'maintenance',
      'clock:10101',
      'warn:[reconcileTeamArtifacts] completed team=team-a reason=file-watch source=task detail=1.json durationMs=100 inFlightAtStart=1 burst=1 linkedCommentsCreated=2 staleKanbanEntriesRemoved=0 staleColumnOrderRefsRemoved=1',
      'clock:10102',
    ]);
    expect(times).toEqual([]);
  });

  it('throttles pressure warnings while retaining burst completion diagnostics', async () => {
    const { coordinator, setNow, warn } = createHarness();

    for (let index = 0; index < 8; index += 1) {
      await coordinator.reconcile('team-a', { source: 'inbox' });
    }
    setNow(12_000);
    await coordinator.reconcile('team-a', { source: 'inbox' });

    const messages = warn.mock.calls.map(([message]) => message);
    expect(messages.filter((message) => !message.includes('completed'))).toEqual([
      '[reconcileTeamArtifacts] team=team-a reason=file-watch source=inbox inFlight=1 burst=1',
      '[reconcileTeamArtifacts] team=team-a reason=file-watch source=inbox inFlight=1 burst=9',
    ]);
    expect(messages.filter((message) => message.includes('completed'))).toEqual([
      '[reconcileTeamArtifacts] completed team=team-a reason=file-watch source=inbox durationMs=0 inFlightAtStart=1 burst=8 linkedCommentsCreated=0 staleKanbanEntriesRemoved=0 staleColumnOrderRefsRemoved=0',
      '[reconcileTeamArtifacts] completed team=team-a reason=file-watch source=inbox durationMs=0 inFlightAtStart=1 burst=9 linkedCommentsCreated=0 staleKanbanEntriesRemoved=0 staleColumnOrderRefsRemoved=0',
    ]);
  });

  it('uses a strict burst window and resets the next call after the window expires', async () => {
    const { coordinator, setNow, warn } = createHarness();

    await coordinator.reconcile('team-a');
    setNow(15_000);
    await coordinator.reconcile('team-a');
    setNow(15_001);
    await coordinator.reconcile('team-a');

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      '[reconcileTeamArtifacts] team=team-a reason=file-watch source=unknown inFlight=1 burst=1',
      '[reconcileTeamArtifacts] team=team-a reason=file-watch source=unknown inFlight=1 burst=1',
    ]);
  });

  it('preserves lazy getter short-circuiting, repeated formatting reads, and emitted bytes', async () => {
    const scenarios = [
      {
        name: 'slow duration',
        times: [0, 0, 100, 100],
        reads: {
          linkedCommentsCreated: [2],
          staleKanbanEntriesRemoved: [undefined],
          staleColumnOrderRefsRemoved: [1],
        },
        accesses: [
          'get:linkedCommentsCreated',
          'get:staleKanbanEntriesRemoved',
          'get:staleColumnOrderRefsRemoved',
        ],
        message:
          '[reconcileTeamArtifacts] completed team=team-a reason=file-watch source=unknown durationMs=100 inFlightAtStart=1 burst=1 linkedCommentsCreated=2 staleKanbanEntriesRemoved=0 staleColumnOrderRefsRemoved=1',
      },
      {
        name: 'linked comments',
        times: [0, 0, 0, 0],
        reads: {
          linkedCommentsCreated: [1, 7],
          staleKanbanEntriesRemoved: [undefined],
          staleColumnOrderRefsRemoved: [2],
        },
        accesses: [
          'get:linkedCommentsCreated',
          'get:linkedCommentsCreated',
          'get:staleKanbanEntriesRemoved',
          'get:staleColumnOrderRefsRemoved',
        ],
        message:
          '[reconcileTeamArtifacts] completed team=team-a reason=file-watch source=unknown durationMs=0 inFlightAtStart=1 burst=1 linkedCommentsCreated=7 staleKanbanEntriesRemoved=0 staleColumnOrderRefsRemoved=2',
      },
      {
        name: 'stale kanban',
        times: [0, 0, 0, 0],
        reads: {
          linkedCommentsCreated: [0, 9],
          staleKanbanEntriesRemoved: [1, 5],
          staleColumnOrderRefsRemoved: [2],
        },
        accesses: [
          'get:linkedCommentsCreated',
          'get:staleKanbanEntriesRemoved',
          'get:linkedCommentsCreated',
          'get:staleKanbanEntriesRemoved',
          'get:staleColumnOrderRefsRemoved',
        ],
        message:
          '[reconcileTeamArtifacts] completed team=team-a reason=file-watch source=unknown durationMs=0 inFlightAtStart=1 burst=1 linkedCommentsCreated=9 staleKanbanEntriesRemoved=5 staleColumnOrderRefsRemoved=2',
      },
      {
        name: 'stale column order',
        times: [0, 0, 0, 0],
        reads: {
          linkedCommentsCreated: [0, 9],
          staleKanbanEntriesRemoved: [0, 5],
          staleColumnOrderRefsRemoved: [1, 6],
        },
        accesses: [
          'get:linkedCommentsCreated',
          'get:staleKanbanEntriesRemoved',
          'get:staleColumnOrderRefsRemoved',
          'get:linkedCommentsCreated',
          'get:staleKanbanEntriesRemoved',
          'get:staleColumnOrderRefsRemoved',
        ],
        message:
          '[reconcileTeamArtifacts] completed team=team-a reason=file-watch source=unknown durationMs=0 inFlightAtStart=1 burst=1 linkedCommentsCreated=9 staleKanbanEntriesRemoved=5 staleColumnOrderRefsRemoved=6',
      },
      {
        name: 'no changes',
        times: [0, 0, 0, 0],
        reads: {
          linkedCommentsCreated: [0],
          staleKanbanEntriesRemoved: [0],
          staleColumnOrderRefsRemoved: [0],
        },
        accesses: [
          'get:linkedCommentsCreated',
          'get:staleKanbanEntriesRemoved',
          'get:staleColumnOrderRefsRemoved',
        ],
        message: null,
      },
    ] as const;
    const observations: Array<{
      name: string;
      accesses: string[];
      messages: string[];
      durationBeforeFirstGetter: boolean;
    }> = [];

    for (const scenario of scenarios) {
      const events: string[] = [];
      const result = createObservedResult(scenario.reads, events);
      const warn = vi.fn((message: string) => events.push(`warn:${message}`));
      const coordinator = new TeamArtifactReconciliationCoordinator({
        maintenance: {
          reconcileArtifacts: () => {
            events.push('maintenance');
            return result;
          },
        },
        clock: createSequencedClock(scenario.times, events),
        logger: { warn },
      });

      await coordinator.reconcile('team-a');

      const firstGetterIndex = events.findIndex((event) => event.startsWith('get:'));
      observations.push({
        name: scenario.name,
        accesses: events.filter((event) => event.startsWith('get:')),
        messages: warn.mock.calls.map(([message]) => message),
        durationBeforeFirstGetter:
          firstGetterIndex >= 0 &&
          events.indexOf(`clock:3:${String(scenario.times[2])}`) < firstGetterIndex,
      });
    }

    expect(observations).toEqual(
      scenarios.map((scenario) => ({
        name: scenario.name,
        accesses: [...scenario.accesses],
        messages: scenario.message === null ? [] : [scenario.message],
        durationBeforeFirstGetter: true,
      }))
    );
  });

  it('gives duration failures precedence over lazy result getter failures', async () => {
    const events: string[] = [];
    const result = createObservedResult(
      {
        linkedCommentsCreated: [new Error('linked getter failed')],
        staleKanbanEntriesRemoved: [new Error('stale kanban getter failed')],
        staleColumnOrderRefsRemoved: [new Error('stale column getter failed')],
      },
      events
    );
    const coordinator = new TeamArtifactReconciliationCoordinator({
      maintenance: {
        reconcileArtifacts: () => {
          events.push('maintenance');
          return result;
        },
      },
      clock: createSequencedClock([0, 0, new Error('duration failed'), 0], events),
      logger: { warn: vi.fn() },
    });

    await expect(coordinator.reconcile('team-a')).rejects.toThrow('duration failed');
    expect(events).toEqual([
      'clock:1:0',
      'clock:2:0',
      'maintenance',
      'clock:3:throw:duration failed',
      'clock:4:0',
    ]);
  });

  it('preserves linked-before-stale getter failure precedence', async () => {
    const events: string[] = [];
    const result = createObservedResult(
      {
        linkedCommentsCreated: [0],
        staleKanbanEntriesRemoved: [new Error('stale kanban getter failed')],
        staleColumnOrderRefsRemoved: [new Error('stale column getter failed')],
      },
      events
    );
    const coordinator = new TeamArtifactReconciliationCoordinator({
      maintenance: {
        reconcileArtifacts: () => {
          events.push('maintenance');
          return result;
        },
      },
      clock: createSequencedClock([0, 0, 0, 0], events),
      logger: { warn: vi.fn() },
    });

    await expect(coordinator.reconcile('team-a')).rejects.toThrow('stale kanban getter failed');
    expect(events).toEqual([
      'clock:1:0',
      'clock:2:0',
      'maintenance',
      'clock:3:0',
      'get:linkedCommentsCreated',
      'get:staleKanbanEntriesRemoved',
      'clock:4:0',
    ]);
  });

  it('preserves finally-error replacement after a result getter failure', async () => {
    const events: string[] = [];
    const result = createObservedResult(
      { linkedCommentsCreated: [new Error('linked getter failed')] },
      events
    );
    const coordinator = new TeamArtifactReconciliationCoordinator({
      maintenance: {
        reconcileArtifacts: () => {
          events.push('maintenance');
          return result;
        },
      },
      clock: createSequencedClock([0, 0, 0, new Error('retention failed')], events),
      logger: { warn: vi.fn() },
    });

    await expect(coordinator.reconcile('team-a')).rejects.toThrow('retention failed');
    expect(events).toEqual([
      'clock:1:0',
      'clock:2:0',
      'maintenance',
      'clock:3:0',
      'get:linkedCommentsCreated',
      'clock:4:throw:retention failed',
    ]);
  });

  it('preserves backward clock values across burst, throttle, duration, and retention policy', async () => {
    const events: string[] = [];
    const readings = Array.from({ length: 8 }, (_, index) =>
      index === 0 ? [10_000, 10_000, 9_000, 0] : [9_999, 9_999, 8_999, 0]
    ).flat();
    let reconciliationCount = 0;
    const warn = vi.fn();
    const coordinator = new TeamArtifactReconciliationCoordinator({
      maintenance: {
        reconcileArtifacts: () => {
          reconciliationCount += 1;
          return reconciliationCount === 1 ? { linkedCommentsCreated: 1 } : {};
        },
      },
      clock: createSequencedClock(readings, events),
      logger: { warn },
    });

    for (let index = 0; index < 8; index += 1) {
      await coordinator.reconcile('team-a');
    }

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      '[reconcileTeamArtifacts] team=team-a reason=file-watch source=unknown inFlight=1 burst=1',
      '[reconcileTeamArtifacts] completed team=team-a reason=file-watch source=unknown durationMs=-1000 inFlightAtStart=1 burst=1 linkedCommentsCreated=1 staleKanbanEntriesRemoved=0 staleColumnOrderRefsRemoved=0',
      '[reconcileTeamArtifacts] completed team=team-a reason=file-watch source=unknown durationMs=-1000 inFlightAtStart=1 burst=8 linkedCommentsCreated=0 staleKanbanEntriesRemoved=0 staleColumnOrderRefsRemoved=0',
    ]);
    expect(events).toHaveLength(32);
  });

  it('preserves NaN clock behavior across burst, throttle, duration, and retention policy', async () => {
    const events: string[] = [];
    const warn = vi.fn();
    const coordinator = new TeamArtifactReconciliationCoordinator({
      maintenance: { reconcileArtifacts: () => ({}) },
      clock: createSequencedClock(
        Array.from({ length: 32 }, () => Number.NaN),
        events
      ),
      logger: { warn },
    });

    for (let index = 0; index < 8; index += 1) {
      await coordinator.reconcile('team-a');
    }

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      '[reconcileTeamArtifacts] completed team=team-a reason=file-watch source=unknown durationMs=NaN inFlightAtStart=1 burst=8 linkedCommentsCreated=0 staleKanbanEntriesRemoved=0 staleColumnOrderRefsRemoved=0',
    ]);
    expect(events).toEqual(Array.from({ length: 32 }, (_, index) => `clock:${index + 1}:NaN`));
  });

  it('accounts for reentrant concurrency before decrementing in-flight state', async () => {
    let reentered = false;
    const harness = createHarness(() => {
      if (!reentered) {
        reentered = true;
        void harness.coordinator.reconcile('team-a', {
          source: 'inbox',
          detail: 'member.json',
        });
      }
    });

    await harness.coordinator.reconcile('team-a', { source: 'task' });

    expect(harness.warn.mock.calls.map(([message]) => message)).toEqual([
      '[reconcileTeamArtifacts] team=team-a reason=file-watch source=task inFlight=1 burst=1',
      '[reconcileTeamArtifacts] completed team=team-a reason=file-watch source=inbox detail=member.json durationMs=0 inFlightAtStart=2 burst=2 linkedCommentsCreated=0 staleKanbanEntriesRemoved=0 staleColumnOrderRefsRemoved=0',
    ]);
  });

  it('propagates maintenance failures after restoring in-flight accounting', async () => {
    const reconcileArtifacts = vi
      .fn<TeamArtifactReconciliationPorts['maintenance']['reconcileArtifacts']>()
      .mockImplementationOnce(() => {
        throw new Error('reconcile failed');
      });
    const { coordinator, setNow, warn } = createHarness(reconcileArtifacts);

    await expect(coordinator.reconcile('team-a', { source: 'task' })).rejects.toThrow(
      'reconcile failed'
    );
    setNow(12_001);
    await expect(coordinator.reconcile('team-a', { source: 'task' })).resolves.toBeUndefined();

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      '[reconcileTeamArtifacts] team=team-a reason=file-watch source=task inFlight=1 burst=1',
    ]);
  });
});
