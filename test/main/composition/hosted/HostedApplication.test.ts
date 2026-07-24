import {
  createHostedApplication,
  HOSTED_APPLICATION_INACTIVE_REASON,
  HOSTED_READINESS_DIMENSIONS,
  type HostedDimensionReadinessProbe,
  type HostedLifecycleComponent,
  type HostedReadinessDimension,
} from '@main/composition/hosted/application';
import { describe, expect, it, vi } from 'vitest';

import type { RouteDescriptor } from '@main/composition/hosted/routing';

function route(
  id: string,
  path: string,
  owner: string,
  readiness: readonly HostedReadinessDimension[]
): RouteDescriptor {
  return Object.freeze({
    id,
    method: 'GET',
    path,
    owner,
    trustKind: 'browser',
    authPolicyId: 'hosted.auth',
    readiness: Object.freeze([...readiness]),
    requestSchemaId: 'hosted.request',
    responseSchemaId: 'hosted.response',
    handlerId: 'hosted.handler',
    clientId: 'hosted.client',
    semanticTestId: 'hosted.semantic',
    testOnly: false,
  });
}

function readinessProbe(
  dimension: HostedReadinessDimension,
  ready: () => boolean = () => true
): HostedDimensionReadinessProbe {
  return {
    id: `${dimension}.probe`,
    dimension,
    readiness: vi.fn(async () => ({
      ready: ready(),
      reasons: ready() ? [] : [`${dimension.replace('-', '_')}_unavailable`],
    })),
  };
}

describe('HostedApplication', () => {
  it('separates lifecycle ports from readiness probes and exposes route admission', async () => {
    const events: string[] = [];
    let mutationReady = true;
    const listener = {
      id: 'listener',
      start: vi.fn(async () => {
        events.push('start:listener');
      }),
      readiness: vi.fn(async () => ({ ready: false, reasons: ['not_a_lattice_probe'] })),
      stop: vi.fn(async () => {
        events.push('stop:listener');
      }),
    } satisfies HostedLifecycleComponent;
    const worker = {
      id: 'worker',
      start: vi.fn(async () => {
        events.push('start:worker');
      }),
      readiness: vi.fn(async () => ({ ready: false, reasons: ['not_a_lattice_probe'] })),
      stop: vi.fn(async () => {
        events.push('stop:worker');
      }),
    } satisfies HostedLifecycleComponent;
    const readinessProbes = HOSTED_READINESS_DIMENSIONS.map((dimension) =>
      readinessProbe(dimension, dimension === 'mutation' ? () => mutationReady : undefined)
    );
    const application = createHostedApplication({
      components: [listener, worker],
      readinessProbes,
      routeContributions: [
        {
          id: 'zeta',
          facade: { name: 'zeta facade' },
          routes: [route('zeta.list', '/zeta', 'zeta', ['serve', 'read'])],
        },
        {
          id: 'alpha',
          facade: { name: 'alpha facade' },
          routes: [route('alpha.create', '/alpha', 'alpha', ['serve', 'mutation'])],
        },
      ],
    });

    expect(application.routeCatalog.routes.map(({ id }) => id)).toEqual([
      'alpha.create',
      'zeta.list',
    ]);
    expect(application.facades.map(({ id }) => id)).toEqual(['alpha', 'zeta']);

    const stopped = await application.readiness();
    expect(stopped.lifecycleState).toBe('stopped');
    expect(stopped.dimensions.read.reasons).toEqual([HOSTED_APPLICATION_INACTIVE_REASON]);
    expect(stopped.dimensions.terminal.status).toBe('not_offered');
    expect(listener.readiness).not.toHaveBeenCalled();

    await application.start();
    await application.start();
    const started = await application.readiness();
    expect(started.lifecycleState).toBe('started');
    expect(started.dimensions.read.status).toBe('ready');
    expect(started.revision).toBe(stopped.revision + 1);

    mutationReady = false;
    const mutationUnavailable = await application.readiness();
    expect(mutationUnavailable.dimensions.mutation.status).toBe('not_ready');
    expect(mutationUnavailable.dimensions.read.status).toBe('ready');

    const createHandler = vi.fn(async () => 'created');
    const createResult = await application.routeAdmission.invoke('alpha.create', createHandler);
    expect(createResult).toMatchObject({
      admitted: false,
      revision: mutationUnavailable.revision,
    });
    expect(createHandler).not.toHaveBeenCalled();

    const readHandler = vi.fn(async () => 'listed');
    await expect(
      application.routeAdmission.invoke('zeta.list', readHandler)
    ).resolves.toMatchObject({
      admitted: true,
      value: 'listed',
    });
    expect(readHandler).toHaveBeenCalledOnce();

    await application.stop();
    await application.stop();
    const stoppedAgain = await application.readiness();
    expect(stoppedAgain.lifecycleState).toBe('stopped');
    expect(stoppedAgain.dimensions.read.status).toBe('not_ready');
    expect(events).toEqual(['start:listener', 'start:worker', 'stop:worker', 'stop:listener']);
    expect(listener.start).toHaveBeenCalledOnce();
    expect(worker.stop).toHaveBeenCalledOnce();
    expect(listener.readiness).not.toHaveBeenCalled();
  });

  it('remains unavailable when lifecycle startup rolls back', async () => {
    const first = {
      id: 'first',
      start: vi.fn(async () => undefined),
      readiness: vi.fn(async () => ({ ready: true, reasons: [] })),
      stop: vi.fn(async () => undefined),
    } satisfies HostedLifecycleComponent;
    const startFailure = new Error('startup failed');
    const failing = {
      id: 'failing',
      start: vi.fn(async () => {
        throw startFailure;
      }),
      readiness: vi.fn(async () => ({ ready: true, reasons: [] })),
      stop: vi.fn(async () => undefined),
    } satisfies HostedLifecycleComponent;
    const application = createHostedApplication({
      components: [first, failing],
      readinessProbes: [readinessProbe('live')],
      routeContributions: [],
    });

    await expect(application.start()).rejects.toBe(startFailure);
    const report = await application.readiness();
    expect(report.lifecycleState).toBe('stopped');
    expect(report.dimensions.live.reasons).toEqual([HOSTED_APPLICATION_INACTIVE_REASON]);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(first.readiness).not.toHaveBeenCalled();
  });

  it('rejects a stale readiness result after a stop and start ABA transition', async () => {
    let markReadinessStarted: (() => void) | undefined;
    const readinessStarted = new Promise<void>((resolve) => {
      markReadinessStarted = resolve;
    });
    let releaseReadiness: (() => void) | undefined;
    const readinessGate = new Promise<void>((resolve) => {
      releaseReadiness = resolve;
    });
    const component = {
      id: 'component',
      start: vi.fn(async () => undefined),
      readiness: vi.fn(async () => ({ ready: true, reasons: [] })),
      stop: vi.fn(async () => undefined),
    } satisfies HostedLifecycleComponent;
    const liveProbe = {
      id: 'live.probe',
      dimension: 'live',
      readiness: vi.fn(async () => {
        markReadinessStarted?.();
        await readinessGate;
        return { ready: true, reasons: [] };
      }),
    } satisfies HostedDimensionReadinessProbe;
    const application = createHostedApplication({
      components: [component],
      readinessProbes: [liveProbe],
      routeContributions: [],
    });
    await application.start();

    const staleReadiness = application.readiness();
    await readinessStarted;
    await application.stop();
    await application.start();
    releaseReadiness?.();

    const stale = await staleReadiness;
    expect(stale.lifecycleState).toBe('started');
    expect(stale.dimensions.live).toEqual({
      dimension: 'live',
      status: 'not_ready',
      reasons: [HOSTED_APPLICATION_INACTIVE_REASON],
    });

    const current = await application.readiness();
    expect(current.lifecycleState).toBe('started');
    expect(current.dimensions.live.status).toBe('ready');
    expect(current.revision).toBeGreaterThan(stale.revision);
  });
});
