import {
  createRouteCatalog,
  ROUTE_CATALOG_DRIFT_DIAGNOSTIC,
  type RouteDescriptor,
} from '@main/composition/hosted/routing';
import { describe, expect, it } from 'vitest';

import { adjacentValidRoute, duplicateRoute, validRoute } from './fixtures/duplicate-route';
import { missingHandlerReference } from './fixtures/missing-reference';

describe('P1.1B RouteCatalog', () => {
  it('collects unique immutable descriptors in a frozen assertion catalog', () => {
    const catalog = createRouteCatalog([validRoute, adjacentValidRoute]);

    expect(catalog.scope).toBe('test');
    expect(catalog.routes).toEqual([validRoute, adjacentValidRoute]);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.routes)).toBe(true);
    expect(catalog.routes.every(Object.isFrozen)).toBe(true);
  });

  it('fails duplicate route IDs and method/path pairs with the route drift diagnostic', () => {
    expect(() => createRouteCatalog([validRoute, duplicateRoute])).toThrowError(
      ROUTE_CATALOG_DRIFT_DIAGNOSTIC
    );

    const duplicateMethodPath = Object.freeze({
      ...adjacentValidRoute,
      id: 'team-lifecycle.another-route.v1',
      method: validRoute.method,
      path: validRoute.path,
    } satisfies RouteDescriptor);
    expect(() => createRouteCatalog([validRoute, duplicateMethodPath])).toThrowError(
      ROUTE_CATALOG_DRIFT_DIAGNOSTIC
    );
  });

  it('fails a missing required reference with the route drift diagnostic', () => {
    expect(() => createRouteCatalog([missingHandlerReference])).toThrowError(
      ROUTE_CATALOG_DRIFT_DIAGNOSTIC
    );
    expect(() => createRouteCatalog([validRoute, adjacentValidRoute])).not.toThrow();
  });

  it.each([
    'owner',
    'authPolicyId',
    'readinessId',
    'requestSchemaId',
    'responseSchemaId',
    'handlerId',
    'clientId',
    'semanticTestId',
  ] as const)('requires a stable %s reference', (field) => {
    const invalid = Object.freeze({ ...validRoute, [field]: '' }) as RouteDescriptor;
    expect(() => createRouteCatalog([invalid])).toThrowError(ROUTE_CATALOG_DRIFT_DIAGNOSTIC);
  });

  it('rejects mutable or structurally widened descriptors', () => {
    const mutable = { ...validRoute } as RouteDescriptor;
    const widened = Object.freeze({
      ...validRoute,
      runtimeResource: 'fixture-team',
    }) as RouteDescriptor;

    expect(() => createRouteCatalog([mutable])).toThrowError(ROUTE_CATALOG_DRIFT_DIAGNOSTIC);
    expect(() => createRouteCatalog([widened])).toThrowError(ROUTE_CATALOG_DRIFT_DIAGNOSTIC);
  });
});
