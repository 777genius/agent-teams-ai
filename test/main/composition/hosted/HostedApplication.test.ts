import {
  createHostedApplication,
  type HostedLifecycleComponent,
} from '@main/composition/hosted/application';
import { describe, expect, it, vi } from 'vitest';

import type { RouteDescriptor } from '@main/composition/hosted/routing';

function route(id: string, path: string, owner: string): RouteDescriptor {
  return Object.freeze({
    id,
    method: 'GET',
    path,
    owner,
    trustKind: 'browser',
    authPolicyId: 'hosted.auth',
    readinessId: 'hosted.ready',
    requestSchemaId: 'hosted.request',
    responseSchemaId: 'hosted.response',
    handlerId: 'hosted.handler',
    clientId: 'hosted.client',
    semanticTestId: 'hosted.semantic',
    testOnly: false,
  });
}

describe('HostedApplication', () => {
  it('exposes deterministic assembly and gates readiness on the full lifecycle', async () => {
    const events: string[] = [];
    let workerReady = true;
    const listener = {
      id: 'listener',
      start: vi.fn(async () => {
        events.push('start:listener');
      }),
      readiness: vi.fn(async () => ({ ready: true, reasons: [] })),
      stop: vi.fn(async () => {
        events.push('stop:listener');
      }),
    } satisfies HostedLifecycleComponent;
    const worker = {
      id: 'worker',
      start: vi.fn(async () => {
        events.push('start:worker');
      }),
      readiness: vi.fn(async () => ({
        ready: workerReady,
        reasons: workerReady ? [] : ['warming'],
      })),
      stop: vi.fn(async () => {
        events.push('stop:worker');
      }),
    } satisfies HostedLifecycleComponent;
    const application = createHostedApplication({
      components: [listener, worker],
      routeContributions: [
        {
          id: 'zeta',
          facade: { name: 'zeta facade' },
          routes: [route('zeta.list', '/zeta', 'zeta')],
        },
        {
          id: 'alpha',
          facade: { name: 'alpha facade' },
          routes: [route('alpha.list', '/alpha', 'alpha')],
        },
      ],
    });

    expect(application.routeCatalog.routes.map(({ id }) => id)).toEqual([
      'alpha.list',
      'zeta.list',
    ]);
    expect(application.facades.map(({ id }) => id)).toEqual(['alpha', 'zeta']);
    await expect(application.readiness()).resolves.toEqual({
      ready: false,
      lifecycleState: 'stopped',
      checks: [],
    });
    expect(listener.readiness).not.toHaveBeenCalled();

    await application.start();
    await application.start();
    await expect(application.readiness()).resolves.toMatchObject({
      ready: true,
      lifecycleState: 'started',
    });

    workerReady = false;
    await expect(application.readiness()).resolves.toEqual({
      ready: false,
      lifecycleState: 'started',
      checks: [
        { componentId: 'listener', ready: true, reasons: [] },
        { componentId: 'worker', ready: false, reasons: ['warming'] },
      ],
    });

    await application.stop();
    await application.stop();
    await expect(application.readiness()).resolves.toEqual({
      ready: false,
      lifecycleState: 'stopped',
      checks: [],
    });
    expect(events).toEqual(['start:listener', 'start:worker', 'stop:worker', 'stop:listener']);
    expect(listener.start).toHaveBeenCalledOnce();
    expect(worker.stop).toHaveBeenCalledOnce();
  });

  it('remains not ready when lifecycle startup rolls back', async () => {
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
      routeContributions: [],
    });

    await expect(application.start()).rejects.toBe(startFailure);
    await expect(application.readiness()).resolves.toEqual({
      ready: false,
      lifecycleState: 'stopped',
      checks: [],
    });
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
      readiness: vi.fn(async () => {
        markReadinessStarted?.();
        await readinessGate;
        return { ready: true, reasons: [] };
      }),
      stop: vi.fn(async () => undefined),
    } satisfies HostedLifecycleComponent;
    const application = createHostedApplication({
      components: [component],
      routeContributions: [],
    });
    await application.start();

    const staleReadiness = application.readiness();
    await readinessStarted;
    await application.stop();
    await application.start();
    releaseReadiness?.();

    await expect(staleReadiness).resolves.toEqual({
      ready: false,
      lifecycleState: 'started',
      checks: [],
    });
    await expect(application.readiness()).resolves.toEqual({
      ready: true,
      lifecycleState: 'started',
      checks: [{ componentId: 'component', ready: true, reasons: [] }],
    });
  });
});
