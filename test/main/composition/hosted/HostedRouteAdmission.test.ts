import {
  HOSTED_READINESS_DIMENSIONS,
  HOSTED_ROUTE_NOT_FOUND_DIAGNOSTIC,
  HOSTED_ROUTE_UNAVAILABLE_REASON,
  type HostedDimensionReadinessProbe,
  HostedReadiness,
  type HostedReadinessDimension,
  HostedRouteAdmission,
} from '@main/composition/hosted/application';
import { createRouteCatalog, type RouteDescriptor } from '@main/composition/hosted/routing';
import { describe, expect, it, vi } from 'vitest';

function route(
  id: string,
  path: string,
  readiness: readonly HostedReadinessDimension[]
): RouteDescriptor {
  return Object.freeze({
    id,
    method: 'POST',
    path,
    owner: 'hosted-kernel',
    trustKind: 'private',
    authPolicyId: 'private.operator',
    readiness: Object.freeze([...readiness]),
    requestSchemaId: 'hosted.request',
    responseSchemaId: 'hosted.response',
    handlerId: 'hosted.handler',
    clientId: 'hosted.client',
    semanticTestId: 'hosted.semantic',
    testOnly: false,
  });
}

function readinessHarness(): {
  readonly admission: HostedRouteAdmission;
  readonly states: Record<HostedReadinessDimension, boolean>;
  readonly failures: Set<HostedReadinessDimension>;
} {
  const states = Object.fromEntries(
    HOSTED_READINESS_DIMENSIONS.map((dimension) => [dimension, true])
  ) as Record<HostedReadinessDimension, boolean>;
  const failures = new Set<HostedReadinessDimension>();
  const probes = HOSTED_READINESS_DIMENSIONS.map(
    (dimension) =>
      ({
        id: `${dimension}.probe`,
        dimension,
        readiness: vi.fn(async () => {
          if (failures.has(dimension)) throw new Error('private probe diagnostic');
          return {
            ready: states[dimension],
            reasons: states[dimension] ? [] : [`${dimension.replace('-', '_')}_unavailable`],
          };
        }),
      }) satisfies HostedDimensionReadinessProbe
  );
  const catalog = createRouteCatalog(
    [
      route('teams.read', '/teams/read', ['serve', 'read']),
      route('teams.mutate', '/teams/mutate', ['serve', 'mutation']),
      route('teams.drain', '/teams/drain', ['serve', 'runtime-control']),
      route('backup.create', '/backup/create', ['serve', 'recovery-point']),
      route('runtime.callback', '/runtime/callback', ['machine-ingress']),
    ],
    'production'
  );
  const readiness = new HostedReadiness(probes);
  return {
    admission: new HostedRouteAdmission(catalog, readiness),
    states,
    failures,
  };
}

describe('HostedRouteAdmission', () => {
  it('blocks only dependent routes while read, drain, and recovery remain independent', async () => {
    const { admission, states } = readinessHarness();
    states.mutation = false;

    const mutationHandler = vi.fn(async () => 'mutated');
    const readHandler = vi.fn(async () => 'read');
    const drainHandler = vi.fn(async () => 'drained');
    const recoveryHandler = vi.fn(async () => 'recovered');

    const mutation = await admission.invoke('teams.mutate', mutationHandler);
    const read = await admission.invoke('teams.read', readHandler);
    const drain = await admission.invoke('teams.drain', drainHandler);
    const recovery = await admission.invoke('backup.create', recoveryHandler);

    expect(mutation).toEqual({
      admitted: false,
      routeId: 'teams.mutate',
      revision: 1,
      statusCode: 503,
      reason: {
        code: HOSTED_ROUTE_UNAVAILABLE_REASON,
        dimensions: ['mutation'],
      },
    });
    expect(mutationHandler).not.toHaveBeenCalled();
    expect(read).toMatchObject({ admitted: true, value: 'read' });
    expect(drain).toMatchObject({ admitted: true, value: 'drained' });
    expect(recovery).toMatchObject({ admitted: true, value: 'recovered' });
    expect(readHandler).toHaveBeenCalledOnce();
    expect(drainHandler).toHaveBeenCalledOnce();
    expect(recoveryHandler).toHaveBeenCalledOnce();
  });

  it('fails a probe error closed only for the route requiring that dimension', async () => {
    const { admission, failures } = readinessHarness();
    failures.add('machine-ingress');
    const callback = vi.fn(async () => 'accepted');
    const reader = vi.fn(async () => 'read');

    const rejected = await admission.invoke('runtime.callback', callback);
    const admitted = await admission.invoke('teams.read', reader);

    expect(rejected).toMatchObject({
      admitted: false,
      reason: {
        code: HOSTED_ROUTE_UNAVAILABLE_REASON,
        dimensions: ['machine-ingress'],
      },
    });
    expect(JSON.stringify(rejected)).not.toContain('private probe diagnostic');
    expect(callback).not.toHaveBeenCalled();
    expect(admitted).toMatchObject({ admitted: true, value: 'read' });
    expect(reader).toHaveBeenCalledOnce();
  });

  it('returns the current stable revision and advances it after semantic recovery', async () => {
    const { admission, states } = readinessHarness();
    states['recovery-point'] = false;

    const first = await admission.admit('backup.create');
    const equivalent = await admission.admit('backup.create');
    states['recovery-point'] = true;
    const recovered = await admission.admit('backup.create');

    expect(first.admitted).toBe(false);
    expect(equivalent.revision).toBe(first.revision);
    expect(recovered).toEqual({
      admitted: true,
      routeId: 'backup.create',
      revision: first.revision + 1,
    });
  });

  it('deeply freezes safe decisions and rejects unknown route identities', async () => {
    const { admission, states } = readinessHarness();
    states.read = false;

    const decision = await admission.admit('teams.read');

    expect(decision.admitted).toBe(false);
    expect(Object.isFrozen(decision)).toBe(true);
    if (!decision.admitted) {
      expect(Object.isFrozen(decision.reason)).toBe(true);
      expect(Object.isFrozen(decision.reason.dimensions)).toBe(true);
    }
    await expect(admission.admit('missing.route')).rejects.toMatchObject({
      message: HOSTED_ROUTE_NOT_FOUND_DIAGNOSTIC,
      routeId: 'missing.route',
    });
  });
});
