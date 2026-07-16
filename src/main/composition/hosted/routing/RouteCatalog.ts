import {
  CAPABILITY_DESCRIPTOR_DRIFT_DIAGNOSTIC,
  type CapabilityCatalog,
  type CapabilityDescriptor,
  ROUTE_CATALOG_DRIFT_DIAGNOSTIC,
  ROUTE_METHODS,
  ROUTE_TRUST_KINDS,
  type RouteCatalog,
  type RouteCatalogScope,
  type RouteDescriptor,
  TEST_CAPABILITY_PRODUCTION_MOUNT_DIAGNOSTIC,
} from './route-types';

const REQUIRED_ROUTE_KEYS = Object.freeze([
  'id',
  'method',
  'path',
  'owner',
  'trustKind',
  'authPolicyId',
  'readinessId',
  'requestSchemaId',
  'responseSchemaId',
  'handlerId',
  'clientId',
  'semanticTestId',
  'testOnly',
] as const);
const ROUTE_KEYS = new Set<string>([...REQUIRED_ROUTE_KEYS, 'capabilityId']);
const CAPABILITY_KEYS = new Set(['id', 'actionId', 'facetId', 'owner', 'productionSupport']);
const STABLE_REFERENCE = /^[a-z][a-z0-9.-]{1,127}$/;
// Printable ASCII only: control bytes, bidi overrides, and zero-width characters must not
// slip a confusable path through the drift check.
const ROUTE_PATH = /^\/(?!\/)(?!.*(?:\?|#|\/\/))[\x21-\x7E]{1,254}$/;

function routeDrift(): never {
  throw new TypeError(ROUTE_CATALOG_DRIFT_DIAGNOSTIC);
}

function capabilityDrift(): never {
  throw new TypeError(CAPABILITY_DESCRIPTOR_DRIFT_DIAGNOSTIC);
}

function productionMount(): never {
  throw new TypeError(TEST_CAPABILITY_PRODUCTION_MOUNT_DIAGNOSTIC);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStableReference(value: unknown): value is string {
  return typeof value === 'string' && STABLE_REFERENCE.test(value);
}

function assertRouteDescriptor(value: unknown): asserts value is RouteDescriptor {
  if (!isRecord(value) || !Object.isFrozen(value)) routeDrift();
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== 'string' || !ROUTE_KEYS.has(key)) ||
    REQUIRED_ROUTE_KEYS.some((key) => !Object.hasOwn(value, key)) ||
    !isStableReference(value.id) ||
    !ROUTE_METHODS.includes(value.method as (typeof ROUTE_METHODS)[number]) ||
    typeof value.path !== 'string' ||
    !ROUTE_PATH.test(value.path) ||
    !isStableReference(value.owner) ||
    !ROUTE_TRUST_KINDS.includes(value.trustKind as (typeof ROUTE_TRUST_KINDS)[number]) ||
    !isStableReference(value.authPolicyId) ||
    !isStableReference(value.readinessId) ||
    !isStableReference(value.requestSchemaId) ||
    !isStableReference(value.responseSchemaId) ||
    !isStableReference(value.handlerId) ||
    !isStableReference(value.clientId) ||
    !isStableReference(value.semanticTestId) ||
    typeof value.testOnly !== 'boolean' ||
    (value.capabilityId !== undefined && !isStableReference(value.capabilityId))
  ) {
    routeDrift();
  }
}

function assertCapabilityDescriptor(value: unknown): asserts value is CapabilityDescriptor {
  if (!isRecord(value) || !Object.isFrozen(value)) capabilityDrift();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== CAPABILITY_KEYS.size ||
    keys.some((key) => typeof key !== 'string' || !CAPABILITY_KEYS.has(key)) ||
    !isStableReference(value.id) ||
    !isStableReference(value.actionId) ||
    !isStableReference(value.facetId) ||
    !isStableReference(value.owner)
  ) {
    capabilityDrift();
  }
  if (value.productionSupport !== 'absent') productionMount();
}

export function createRouteCatalog(
  routes: readonly RouteDescriptor[],
  scope: RouteCatalogScope = 'test'
): RouteCatalog {
  if (!Array.isArray(routes) || (scope !== 'test' && scope !== 'production')) routeDrift();
  const routeIds = new Set<string>();
  const methodPaths = new Set<string>();

  for (const route of routes) {
    assertRouteDescriptor(route);
    if (scope === 'production' && route.testOnly) productionMount();
    const methodPath = `${route.method} ${route.path}`;
    if (routeIds.has(route.id) || methodPaths.has(methodPath)) routeDrift();
    routeIds.add(route.id);
    methodPaths.add(methodPath);
  }

  return Object.freeze({ scope, routes: Object.freeze([...routes]) });
}

export function createCapabilityCatalog(
  capabilities: readonly CapabilityDescriptor[],
  routeCatalog: RouteCatalog
): CapabilityCatalog {
  if (!Array.isArray(capabilities) || !Object.isFrozen(routeCatalog)) capabilityDrift();
  const capabilityIds = new Set<string>();
  const actionIds = new Set<string>();
  const capabilitiesById = new Map<string, CapabilityDescriptor>();

  for (const capability of capabilities) {
    assertCapabilityDescriptor(capability);
    if (capabilityIds.has(capability.id) || actionIds.has(capability.actionId)) capabilityDrift();
    capabilityIds.add(capability.id);
    actionIds.add(capability.actionId);
    capabilitiesById.set(capability.id, capability);
  }

  for (const route of routeCatalog.routes) {
    assertRouteDescriptor(route);
    if (route.capabilityId === undefined) continue;
    const capability = capabilitiesById.get(route.capabilityId);
    if (capability === undefined || capability.owner !== route.owner) capabilityDrift();
  }

  return Object.freeze({ capabilities: Object.freeze([...capabilities]) });
}
