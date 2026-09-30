import {
  CAPABILITY_DESCRIPTOR_DRIFT_DIAGNOSTIC,
  type CapabilityDescriptor,
  createCapabilityCatalog,
  createRouteCatalog,
  type RouteDescriptor,
  TEST_CAPABILITY_PRODUCTION_MOUNT_DIAGNOSTIC,
} from '@main/composition/hosted/routing';
import { describe, expect, it } from 'vitest';

import { adjacentValidRoute, validRoute } from './fixtures/duplicate-route';
import {
  productionSupportedCapability,
  testOnlyRoute,
  validCapability,
} from './fixtures/test-only-production-route';

describe('P1.1B capability descriptors', () => {
  it('keeps feature-owned capability/action assertions separate from route presence', () => {
    const routes = createRouteCatalog([validRoute, adjacentValidRoute]);
    const capabilities = createCapabilityCatalog([validCapability], routes);

    expect(capabilities.capabilities).toEqual([validCapability]);
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(Object.isFrozen(capabilities.capabilities)).toBe(true);
    expect(validCapability.productionSupport).toBe('absent');
    expect(validCapability).not.toHaveProperty('routeIds');
    expect(validCapability).not.toHaveProperty('dynamicResourceAllowance');
  });

  it('requires unique capability and action IDs', () => {
    const routes = createRouteCatalog([validRoute]);
    const duplicateCapabilityId = Object.freeze({
      ...validCapability,
      actionId: 'team.lifecycle.inspect',
    } satisfies CapabilityDescriptor);
    const duplicateActionId = Object.freeze({
      ...validCapability,
      id: 'team-lifecycle.inspect.capability.v1',
    } satisfies CapabilityDescriptor);

    expect(() =>
      createCapabilityCatalog([validCapability, duplicateCapabilityId], routes)
    ).toThrowError(CAPABILITY_DESCRIPTOR_DRIFT_DIAGNOSTIC);
    expect(() =>
      createCapabilityCatalog([validCapability, duplicateActionId], routes)
    ).toThrowError(CAPABILITY_DESCRIPTOR_DRIFT_DIAGNOSTIC);
  });

  it('requires complete feature ownership and exact route cross-references', () => {
    const routes = createRouteCatalog([validRoute]);
    const missingOwner = Object.freeze({ ...validCapability, owner: '' }) as CapabilityDescriptor;
    const unmatchedRoute = Object.freeze({
      ...validRoute,
      capabilityId: 'team-lifecycle.missing.capability.v1',
    } satisfies RouteDescriptor);

    expect(() => createCapabilityCatalog([missingOwner], routes)).toThrowError(
      CAPABILITY_DESCRIPTOR_DRIFT_DIAGNOSTIC
    );
    expect(() =>
      createCapabilityCatalog([validCapability], createRouteCatalog([unmatchedRoute]))
    ).toThrowError(CAPABILITY_DESCRIPTOR_DRIFT_DIAGNOSTIC);
  });

  it('fails production support or a production-mounted test route with the mount diagnostic', () => {
    const testCatalog = createRouteCatalog([testOnlyRoute]);

    expect(() =>
      createCapabilityCatalog([productionSupportedCapability], testCatalog)
    ).toThrowError(TEST_CAPABILITY_PRODUCTION_MOUNT_DIAGNOSTIC);
    expect(() => createRouteCatalog([testOnlyRoute], 'production')).toThrowError(
      TEST_CAPABILITY_PRODUCTION_MOUNT_DIAGNOSTIC
    );
    expect(() => createCapabilityCatalog([validCapability], testCatalog)).not.toThrow();
  });
});
