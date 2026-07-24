import {
  HOSTED_READINESS_DIMENSIONS,
  HOSTED_READINESS_PROBE_FAILURE_REASON,
  HOSTED_READINESS_PROBE_MISSING_REASON,
  type HostedDimensionReadinessProbe,
  HostedReadiness,
  type HostedReadinessDimension,
} from '@main/composition/hosted/application';
import { describe, expect, it, vi } from 'vitest';

function probe(
  id: string,
  dimension: HostedReadinessDimension,
  readiness: HostedDimensionReadinessProbe['readiness']
): HostedDimensionReadinessProbe {
  return { id, dimension, readiness };
}

describe('HostedReadiness', () => {
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

  it('discards an older generation after stop/restart before publishing the newer result', async () => {
    let markOlderProbeStarted: (() => void) | undefined;
    const olderProbeStarted = new Promise<void>((resolve) => {
      markOlderProbeStarted = resolve;
    });
    let releaseOlderProbe: (() => void) | undefined;
    const olderProbeGate = new Promise<void>((resolve) => {
      releaseOlderProbe = resolve;
    });
    let invocation = 0;
    let currentGeneration = 1;
    const readiness = new HostedReadiness([
      probe('live.probe', 'live', async () => {
        invocation += 1;
        if (invocation === 1) {
          markOlderProbeStarted?.();
          await olderProbeGate;
        }
        return { ready: true, reasons: [] };
      }),
    ]);
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
    releaseOlderProbe?.();

    const [discarded, published] = await Promise.all([older, newer]);

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
