import {
  createRouteCatalog,
  ROUTE_CATALOG_DRIFT_DIAGNOSTIC,
  type RouteDescriptor,
} from '@main/composition/hosted/routing';
import { describe, expect, it } from 'vitest';

import { adjacentValidRoute, duplicateRoute, validRoute } from './fixtures/duplicate-route';
import { missingHandlerReference } from './fixtures/missing-reference';

describe('RouteCatalog', () => {
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
    'requestSchemaId',
    'responseSchemaId',
    'handlerId',
    'clientId',
    'semanticTestId',
  ] as const)('requires a stable %s reference', (field) => {
    const invalid = Object.freeze({ ...validRoute, [field]: '' }) as RouteDescriptor;
    expect(() => createRouteCatalog([invalid])).toThrowError(ROUTE_CATALOG_DRIFT_DIAGNOSTIC);
  });

  it('requires frozen, known, unique readiness requirements and excludes terminal', () => {
    const mutableRequirements = Object.freeze({
      ...validRoute,
      readiness: ['serve', 'read'],
    }) as RouteDescriptor;
    const duplicateRequirement = Object.freeze({
      ...validRoute,
      readiness: Object.freeze(['read', 'read']),
    }) as RouteDescriptor;
    const unknownRequirement = Object.freeze({
      ...validRoute,
      readiness: Object.freeze(['serve', 'provider-bootstrap']),
    }) as unknown as RouteDescriptor;
    const terminalRequirement = Object.freeze({
      ...validRoute,
      readiness: Object.freeze(['terminal']),
    }) as unknown as RouteDescriptor;
    const sparseRequirement = Object.freeze({
      ...validRoute,
      readiness: Object.freeze(Array(1)),
    }) as unknown as RouteDescriptor;

    for (const route of [
      mutableRequirements,
      duplicateRequirement,
      unknownRequirement,
      terminalRequirement,
      sparseRequirement,
    ]) {
      expect(() => createRouteCatalog([route])).toThrowError(ROUTE_CATALOG_DRIFT_DIAGNOSTIC);
    }
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
