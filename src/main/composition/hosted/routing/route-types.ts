export const ROUTE_CATALOG_DRIFT_DIAGNOSTIC = 'phase1-route-catalog-drift';
export const CAPABILITY_DESCRIPTOR_DRIFT_DIAGNOSTIC = 'phase1-capability-descriptor-drift';
export const TEST_CAPABILITY_PRODUCTION_MOUNT_DIAGNOSTIC =
  'phase1-test-capability-production-mount';

export const ROUTE_METHODS = Object.freeze([
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
] as const);
export type RouteMethod = (typeof ROUTE_METHODS)[number];

export const ROUTE_TRUST_KINDS = Object.freeze([
  'browser',
  'runtime',
  'private',
  'health',
] as const);
export type RouteTrustKind = (typeof ROUTE_TRUST_KINDS)[number];

export interface RouteDescriptor {
  readonly id: string;
  readonly method: RouteMethod;
  readonly path: string;
  readonly owner: string;
  readonly trustKind: RouteTrustKind;
  readonly authPolicyId: string;
  readonly readinessId: string;
  readonly requestSchemaId: string;
  readonly responseSchemaId: string;
  readonly handlerId: string;
  readonly clientId: string;
  readonly semanticTestId: string;
  readonly testOnly: boolean;
  readonly capabilityId?: string;
}

export interface CapabilityDescriptor {
  readonly id: string;
  readonly actionId: string;
  readonly facetId: string;
  readonly owner: string;
  readonly productionSupport: 'absent';
}

export type RouteCatalogScope = 'test' | 'production';

export interface RouteCatalog {
  readonly scope: RouteCatalogScope;
  readonly routes: readonly RouteDescriptor[];
}

export interface CapabilityCatalog {
  readonly capabilities: readonly CapabilityDescriptor[];
}
