import {
  HOSTED_READINESS_DIMENSIONS,
  HOSTED_READINESS_PROBE_FAILURE_REASON,
  HOSTED_READINESS_PROBE_MISSING_REASON,
  type HostedDimensionReadinessProbe,
  HostedReadiness,
  type HostedReadinessDimension,
} from '@main/composition/hosted/application';
import {
  createHostedReadinessBudget,
  type HostedReadinessBudget,
  MAX_HOSTED_READINESS_PROBE_TIMEOUT_MS,
} from '@main/composition/hosted/application/HostedReadinessBudget';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface ControlledDeadline {
  active: boolean;
  fire(): void;
}

function controlledBudget(): {
  readonly budget: HostedReadinessBudget;
  readonly deadlines: ControlledDeadline[];
} {
  const deadlines: ControlledDeadline[] = [];
  return {
    budget: {
      scheduleDeadline(onDeadline) {
        const deadline: ControlledDeadline = {
          active: true,
          fire() {
            if (!deadline.active) return;
            deadline.active = false;
            onDeadline();
          },
        };
        deadlines.push(deadline);
        return () => {
          deadline.active = false;
        };
      },
    },
    deadlines,
  };
}

function probe(
  id: string,
  dimension: HostedReadinessDimension,
  readiness: HostedDimensionReadinessProbe['readiness']
): HostedDimensionReadinessProbe {
  return { id, dimension, readiness };
}

describe('HostedReadiness', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('models every offered dimension independently and keeps terminal not offered', async () => {
    const probes = HOSTED_READINESS_DIMENSIONS.map((dimension) =>
      probe(`${dimension}.probe`, dimension, async () => ({ ready: true, reasons: [] }))
    );

    const report = await new HostedReadiness(probes).readiness();

    expect(HOSTED_READINESS_DIMENSIONS.map((dimension) => report.dimensions[dimension])).toEqual(
      HOSTED_READINESS_DIMENSIONS.map((dimension) => ({
        dimension,
        status: 'ready',
        reasons: [],
      }))
    );
    expect(report.dimensions.terminal).toEqual({
      dimension: 'terminal',
      status: 'not_offered',
      reasons: [],
    });
    expect(report.revision).toBe(1);
  });

  it('changes only the probed dimension and advances revisions only for semantic changes', async () => {
    let storageReady = false;
    const readiness = new HostedReadiness([
      probe('storage', 'mutation', async () => ({
        ready: storageReady,
        reasons: storageReady ? [] : ['storage_recovering'],
      })),
      probe('reader', 'read', async () => ({ ready: true, reasons: [] })),
    ]);

    const unavailable = await readiness.readiness();
    const equivalent = await readiness.readiness();
    storageReady = true;
    const recovered = await readiness.readiness();

    expect(unavailable.dimensions.mutation).toEqual({
      dimension: 'mutation',
      status: 'not_ready',
      reasons: ['storage_recovering'],
    });
    expect(unavailable.dimensions.read.status).toBe('ready');
    expect(unavailable.dimensions.serve.reasons).toEqual([HOSTED_READINESS_PROBE_MISSING_REASON]);
    expect(equivalent.revision).toBe(unavailable.revision);
    expect(recovered.revision).toBe(unavailable.revision + 1);
    expect(recovered.dimensions.mutation.status).toBe('ready');
  });

  it('fails probe errors and malformed results closed only for their dimensions', async () => {
    const throwing = probe('throwing', 'auth', async () => {
      throw new Error('secret diagnostic must not escape');
    });
    const malformed = probe(
      'malformed',
      'machine-ingress',
      async () => ({ ready: false, reasons: Object.freeze(Array(1)) }) as never
    );
    const healthy = probe('healthy', 'read', async () => ({ ready: true, reasons: [] }));

    const report = await new HostedReadiness([throwing, malformed, healthy]).readiness();

    expect(report.dimensions.auth.reasons).toEqual([HOSTED_READINESS_PROBE_FAILURE_REASON]);
    expect(report.dimensions['machine-ingress'].reasons).toEqual([
      HOSTED_READINESS_PROBE_FAILURE_REASON,
    ]);
    expect(report.dimensions.read.status).toBe('ready');
    expect(report.checks).toEqual([
      {
        probeId: 'throwing',
        dimension: 'auth',
        status: 'not_ready',
        reasons: [HOSTED_READINESS_PROBE_FAILURE_REASON],
      },
      {
        probeId: 'healthy',
        dimension: 'read',
        status: 'ready',
        reasons: [],
      },
      {
        probeId: 'malformed',
        dimension: 'machine-ingress',
        status: 'not_ready',
        reasons: [HOSTED_READINESS_PROBE_FAILURE_REASON],
      },
    ]);
    expect(JSON.stringify(report)).not.toContain('secret diagnostic');
  });

  it('starts probes concurrently and bounds a hung probe without suppressing healthy dimensions', async () => {
    const events: string[] = [];
    const signals: AbortSignal[] = [];
    const { budget, deadlines } = controlledBudget();
    const readiness = new HostedReadiness(
      [
        probe('hung', 'live', (signal) => {
          events.push('start:hung');
          signals.push(signal);
          return new Promise<never>(() => undefined);
        }),
        probe('failed', 'auth', async (signal) => {
          events.push('start:failed');
          signals.push(signal);
          throw new Error('private auth probe details');
        }),
        probe('healthy', 'read', async (signal) => {
          events.push('start:healthy');
          signals.push(signal);
          return { ready: true, reasons: [] };
        }),
      ],
      budget
    );

    const pending = readiness.readiness();
    await vi.waitFor(() => {
      expect(events).toEqual(['start:hung', 'start:failed', 'start:healthy']);
      expect(deadlines).toHaveLength(3);
      expect(deadlines.filter(({ active }) => active)).toHaveLength(1);
    });
    expect(new Set(signals)).toHaveProperty('size', 3);

    deadlines[0]?.fire();
    const report = await pending;

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(true);
    expect(signals[2]?.aborted).toBe(false);
    expect(report.dimensions.live.reasons).toEqual([HOSTED_READINESS_PROBE_FAILURE_REASON]);
    expect(report.dimensions.auth.reasons).toEqual([HOSTED_READINESS_PROBE_FAILURE_REASON]);
    expect(report.dimensions.read.status).toBe('ready');
    expect(JSON.stringify(report)).not.toContain('private auth probe details');
  });

  it('enforces the default wall-clock budget and ignores a late probe result', async () => {
    vi.useFakeTimers();
    let invocation = 0;
    let releaseFirst: ((value: { ready: boolean; reasons: string[] }) => void) | undefined;
    let timedOutSignal: AbortSignal | undefined;
    const readiness = new HostedReadiness(
      [
        probe('reader', 'read', (signal) => {
          invocation += 1;
          if (invocation > 1) return { ready: true, reasons: [] };
          timedOutSignal = signal;
          return new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }),
      ],
      createHostedReadinessBudget(25)
    );

    const pending = readiness.readiness();
    await vi.advanceTimersByTimeAsync(25);
    const timedOut = await pending;

    expect(timedOutSignal?.aborted).toBe(true);
    expect(timedOut.dimensions.read.reasons).toEqual([HOSTED_READINESS_PROBE_FAILURE_REASON]);
    releaseFirst?.({ ready: true, reasons: [] });
    await Promise.resolve();
    expect(timedOut.dimensions.read.status).toBe('not_ready');

    const recovered = await readiness.readiness();
    expect(recovered.dimensions.read.status).toBe('ready');
    expect(recovered.revision).toBe(timedOut.revision + 1);
  });

  it('accepts the Node timer maximum and rejects the next timeout value', () => {
    const onDeadline = vi.fn();
    const cancelDeadline = createHostedReadinessBudget(
      MAX_HOSTED_READINESS_PROBE_TIMEOUT_MS
    ).scheduleDeadline(onDeadline);

    cancelDeadline();
    expect(onDeadline).not.toHaveBeenCalled();
    expect(() =>
      createHostedReadinessBudget(MAX_HOSTED_READINESS_PROBE_TIMEOUT_MS + 1)
    ).toThrowError(
      `Hosted readiness probe timeout must be an integer between 1 and ${MAX_HOSTED_READINESS_PROBE_TIMEOUT_MS}`
    );
  });

  it('does not invoke a probe when its deadline fires synchronously during scheduling', async () => {
    const probeSideEffect = vi.fn();
    const budget: HostedReadinessBudget = {
      scheduleDeadline(onDeadline) {
        onDeadline();
        return vi.fn();
      },
    };
    const readiness = new HostedReadiness(
      [
        probe('reader', 'read', () => {
          probeSideEffect();
          return { ready: true, reasons: [] };
        }),
      ],
      budget
    );

    const report = await readiness.readiness();

    expect(probeSideEffect).not.toHaveBeenCalled();
    expect(report.dimensions.read).toEqual({
      dimension: 'read',
      status: 'not_ready',
      reasons: [HOSTED_READINESS_PROBE_FAILURE_REASON],
    });
  });

  it('canonicalizes equivalent reasons before computing the revision', async () => {
    let reasons = ['writer_paused', 'lease_unavailable', 'writer_paused'];
    const readiness = new HostedReadiness([
      probe('writer', 'mutation', async () => ({ ready: false, reasons })),
    ]);

    const first = await readiness.readiness();
    reasons = ['lease_unavailable', 'writer_paused'];
    const reordered = await readiness.readiness();

    expect(first.dimensions.mutation.reasons).toEqual(['lease_unavailable', 'writer_paused']);
    expect(reordered.revision).toBe(first.revision);
  });

  it('returns deeply immutable snapshots, including unavailable snapshots', async () => {
    const readiness = new HostedReadiness([
      probe('reader', 'read', async () => ({ ready: true, reasons: [] })),
    ]);

    const report = await readiness.readiness();
    const unavailable = await readiness.unavailable('application_lifecycle_inactive');

    for (const snapshot of [report, unavailable]) {
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.checks)).toBe(true);
      expect(Object.isFrozen(snapshot.dimensions)).toBe(true);
      expect(Object.isFrozen(snapshot.dimensions.read)).toBe(true);
      expect(Object.isFrozen(snapshot.dimensions.read.reasons)).toBe(true);
      expect(Object.isFrozen(snapshot.dimensions.terminal)).toBe(true);
      expect(Object.isFrozen(snapshot.dimensions.terminal.reasons)).toBe(true);
      expect(snapshot.checks.every(Object.isFrozen)).toBe(true);
      expect(snapshot.checks.every((check) => Object.isFrozen(check.reasons))).toBe(true);
    }
  });

  it('lets a stale generation override a timed-out probe before publishing the newer result', async () => {
    let markOlderProbeStarted: (() => void) | undefined;
    const olderProbeStarted = new Promise<void>((resolve) => {
      markOlderProbeStarted = resolve;
    });
    let releaseOlderProbe: ((value: { ready: boolean; reasons: string[] }) => void) | undefined;
    const olderProbeGate = new Promise<{ ready: boolean; reasons: string[] }>((resolve) => {
      releaseOlderProbe = resolve;
    });
    let invocation = 0;
    let currentGeneration = 1;
    let olderSignal: AbortSignal | undefined;
    const { budget, deadlines } = controlledBudget();
    const readiness = new HostedReadiness(
      [
        probe('live.probe', 'live', (signal) => {
          invocation += 1;
          if (invocation === 1) {
            olderSignal = signal;
            markOlderProbeStarted?.();
            return olderProbeGate;
          }
          return { ready: true, reasons: [] };
        }),
      ],
      budget
    );
    const generationGuard = (generation: number) => ({
      generation,
      isCurrent: (expectedGeneration: number) => currentGeneration === expectedGeneration,
      staleReason: 'application_lifecycle_inactive',
    });

    const older = readiness.readiness(generationGuard(1));
    await olderProbeStarted;
    currentGeneration = 2;
    currentGeneration = 3;
    const newer = readiness.readiness(generationGuard(3));
    deadlines[0]?.fire();

    const [discarded, published] = await Promise.all([older, newer]);

    expect(olderSignal?.aborted).toBe(true);
    expect(discarded.dimensions.live).toEqual({
      dimension: 'live',
      status: 'not_ready',
      reasons: ['application_lifecycle_inactive'],
    });
    expect(discarded.checks).toEqual([]);
    expect(published.dimensions.live.status).toBe('ready');
    expect(published.revision).toBe(discarded.revision + 1);

    const current = await readiness.readiness(generationGuard(3));
    expect(current.dimensions.live.status).toBe('ready');
    expect(current.revision).toBe(published.revision);

    releaseOlderProbe?.({ ready: false, reasons: ['private_late_failure'] });
    await Promise.resolve();
    expect(discarded.dimensions.live.reasons).toEqual(['application_lifecycle_inactive']);
  });

  it('captures probe identity and dimension immutably at composition time', async () => {
    const mutableProbe = {
      id: 'reader',
      dimension: 'read' as HostedReadinessDimension,
      readiness: vi.fn(async () => ({ ready: true, reasons: [] })),
    };
    const readiness = new HostedReadiness([mutableProbe]);

    mutableProbe.id = 'writer';
    mutableProbe.dimension = 'mutation';
    const report = await readiness.readiness();

    expect(report.checks[0]).toMatchObject({
      probeId: 'reader',
      dimension: 'read',
      status: 'ready',
    });
    expect(report.dimensions.read.status).toBe('ready');
    expect(report.dimensions.mutation.status).toBe('not_ready');
  });

  it('rejects duplicate, unscoped, or invalid probe identities at composition time', () => {
    const duplicate = probe(
      'duplicate',
      'read',
      vi.fn(async () => ({
        ready: true,
        reasons: [],
      }))
    );
    const unscoped = {
      id: 'unscoped',
      readiness: vi.fn(async () => ({ ready: true, reasons: [] })),
    } as unknown as HostedDimensionReadinessProbe;

    expect(() => new HostedReadiness([duplicate, duplicate])).toThrowError(
      'Invalid or duplicate hosted readiness probe id: duplicate'
    );
    expect(() => new HostedReadiness([unscoped])).toThrowError(
      'Invalid or duplicate hosted readiness probe id: unscoped'
    );
  });
});
