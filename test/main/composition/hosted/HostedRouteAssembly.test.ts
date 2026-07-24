import {
  assembleHostedRoutes,
  HostedRouteConflictError,
  type HostedRouteContribution,
} from '@main/composition/hosted/application';
import { describe, expect, it } from 'vitest';

import type { RouteDescriptor } from '@main/composition/hosted/routing';

function route(
  id: string,
  method: RouteDescriptor['method'],
  path: string,
  owner: string
): RouteDescriptor {
  return Object.freeze({
    id,
    method,
    path,
    owner,
    trustKind: 'browser',
    authPolicyId: 'hosted.auth',
    readiness: Object.freeze(['serve', 'read'] as const),
    requestSchemaId: 'hosted.request',
    responseSchemaId: 'hosted.response',
    handlerId: 'hosted.handler',
    clientId: 'hosted.client',
    semanticTestId: 'hosted.semantic',
    testOnly: false,
  });
}

describe('HostedRouteAssembly', () => {
  it('assembles immutable routes and facades in stable identity order', () => {
    const laterRoute = route('zeta.list', 'GET', '/zeta', 'zeta');
    const earlierRoute = route('alpha.create', 'POST', '/alpha', 'alpha');
    const middleRoute = route('alpha.read', 'GET', '/alpha', 'alpha');
    const contributions: readonly HostedRouteContribution<{ readonly name: string }>[] = [
      { id: 'zeta', facade: { name: 'zeta facade' }, routes: [laterRoute] },
      {
        id: 'alpha',
        facade: { name: 'alpha facade' },
        routes: [middleRoute, earlierRoute],
      },
    ];

    const assembly = assembleHostedRoutes(contributions);

    expect(assembly.catalog.scope).toBe('production');
    expect(assembly.catalog.routes.map(({ id }) => id)).toEqual([
      'alpha.create',
      'alpha.read',
      'zeta.list',
    ]);
    expect(assembly.facades.map(({ id }) => id)).toEqual(['alpha', 'zeta']);
    expect(Object.isFrozen(assembly)).toBe(true);
    expect(Object.isFrozen(assembly.facades)).toBe(true);
    expect(assembly.facades.every(Object.isFrozen)).toBe(true);
  });

  it('rejects duplicate route identities before catalog creation', () => {
    const first = route('teams.list', 'GET', '/teams', 'teams');
    const duplicateId = route('teams.list', 'POST', '/teams', 'teams');

    expect(() =>
      assembleHostedRoutes([
        { id: 'first', facade: {}, routes: [first] },
        { id: 'second', facade: {}, routes: [duplicateId] },
      ])
    ).toThrowError(
      expect.objectContaining<Partial<HostedRouteConflictError>>({
        kind: 'route-id',
        key: 'teams.list',
      })
    );
  });

  it('rejects duplicate method/path pairs and facade identities', () => {
    const first = route('teams.list', 'GET', '/teams', 'teams');
    const sameEndpoint = route('teams.read-all', 'GET', '/teams', 'teams');

    expect(() =>
      assembleHostedRoutes([
        { id: 'first', facade: {}, routes: [first] },
        { id: 'second', facade: {}, routes: [sameEndpoint] },
      ])
    ).toThrowError(
      expect.objectContaining<Partial<HostedRouteConflictError>>({
        kind: 'method-path',
        key: 'GET /teams',
      })
    );

    expect(() =>
      assembleHostedRoutes([
        { id: 'teams', facade: { revision: 1 }, routes: [first] },
        { id: 'teams', facade: { revision: 2 }, routes: [] },
      ])
    ).toThrowError(
      expect.objectContaining<Partial<HostedRouteConflictError>>({
        kind: 'facade-id',
        key: 'teams',
      })
    );
  });

  it('produces the same ordering when contribution order changes', () => {
    const alpha = { id: 'alpha', facade: {}, routes: [route('alpha.list', 'GET', '/a', 'alpha')] };
    const beta = { id: 'beta', facade: {}, routes: [route('beta.list', 'GET', '/b', 'beta')] };

    const forward = assembleHostedRoutes([alpha, beta]);
    const reverse = assembleHostedRoutes([beta, alpha]);

    expect(reverse.catalog.routes).toEqual(forward.catalog.routes);
    expect(reverse.facades.map(({ id }) => id)).toEqual(forward.facades.map(({ id }) => id));
  });
});
