import {
  type BootId,
  type DeploymentId,
  parseBootId,
  parseDeploymentId,
} from '@shared/contracts/hosted';

export const HOSTED_READINESS_ROUTE = '/api/hosted/v1/meta/readiness' as const;
export const HOSTED_READINESS_SCHEMA_VERSION = 1 as const;
export const MAX_HOSTED_READINESS_RESPONSE_BYTES = 64 * 1024;
export const MAX_HOSTED_READINESS_FACETS = 32;
export const MAX_HOSTED_READINESS_ACTIONS = 128;
export const MAX_HOSTED_READINESS_REASONS = 8;

export const HOSTED_READINESS_DIMENSIONS = Object.freeze([
  'live',
  'serve',
  'auth',
  'read',
  'mutation',
  'runtime-control',
  'machine-ingress',
  'recovery-point',
] as const);
export type HostedReadinessDimension = (typeof HOSTED_READINESS_DIMENSIONS)[number];

export const HOSTED_READINESS_REASON_CODES = Object.freeze([
  'startup_in_progress',
  'dependency_unavailable',
  'serve_unavailable',
  'authentication_required',
  'authentication_unavailable',
  'read_unavailable',
  'mutation_unavailable',
  'runtime_control_unavailable',
  'machine_ingress_unavailable',
  'recovery_point_unavailable',
  'read_only',
  'provider_unavailable',
  'provider_auth_required',
  'workspace_unavailable',
  'workspace_read_only',
  'recovery_required',
  'stale_generation',
  'stale_revision',
  'resource_busy',
  'policy_denied',
  'temporarily_unavailable',
  'not_offered',
  'not_implemented',
  'request_cancelled',
  'deadline_exceeded',
  'source_unavailable',
] as const);
export type HostedReadinessReasonCode = (typeof HOSTED_READINESS_REASON_CODES)[number];

export type HostedReadinessStatus = 'ready' | 'not_ready';
export type HostedFacetAvailability = 'available' | 'temporarily_unavailable' | 'not_offered';
export type HostedActionImplementation = 'implemented' | 'not_implemented';

export interface HostedReadinessDimensionProjection {
  readonly dimension: HostedReadinessDimension;
  readonly status: HostedReadinessStatus;
  readonly reasons: readonly HostedReadinessReasonCode[];
}

export interface HostedTerminalProjection {
  readonly dimension: 'terminal';
  readonly status: 'not_offered';
  readonly reasons: readonly [];
}

export interface HostedReadinessFacetProjection {
  readonly facetId: string;
  readonly availability: HostedFacetAvailability;
  readonly requiredReadiness: readonly HostedReadinessDimension[];
  readonly reasons: readonly HostedReadinessReasonCode[];
}

export interface HostedReadinessActionProjection {
  readonly actionId: string;
  readonly facetId: string;
  readonly implementation: HostedActionImplementation;
  readonly availability: HostedFacetAvailability;
  readonly requiredReadiness: readonly HostedReadinessDimension[];
  readonly reasons: readonly HostedReadinessReasonCode[];
}

export interface HostedReadinessProjection {
  readonly schemaVersion: typeof HOSTED_READINESS_SCHEMA_VERSION;
  readonly kind: 'success';
  readonly deploymentId: DeploymentId;
  readonly bootId: BootId;
  readonly revision: number;
  readonly requiredReadiness: readonly HostedReadinessDimension[];
  readonly dimensions: readonly HostedReadinessDimensionProjection[];
  readonly terminal: HostedTerminalProjection;
  readonly facets: readonly HostedReadinessFacetProjection[];
  readonly actions: readonly HostedReadinessActionProjection[];
}

export type HostedReadinessFailureReason =
  | 'request_cancelled'
  | 'deadline_exceeded'
  | 'readiness_unavailable'
  | 'response_invalid';

export interface HostedReadinessFailure {
  readonly schemaVersion: typeof HOSTED_READINESS_SCHEMA_VERSION;
  readonly kind: 'failure';
  readonly reason: HostedReadinessFailureReason;
}

export type HostedReadinessResponse = HostedReadinessProjection | HostedReadinessFailure;

export type HostedReadinessProjectionParseResult =
  | { readonly ok: true; readonly value: HostedReadinessProjection }
  | { readonly ok: false; readonly error: 'hosted_readiness_projection_invalid' };

const PROJECTION_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'deploymentId',
  'bootId',
  'revision',
  'requiredReadiness',
  'dimensions',
  'terminal',
  'facets',
  'actions',
] as const);
const DIMENSION_KEYS = Object.freeze(['dimension', 'status', 'reasons'] as const);
const FACET_KEYS = Object.freeze([
  'facetId',
  'availability',
  'requiredReadiness',
  'reasons',
] as const);
const ACTION_KEYS = Object.freeze([
  'actionId',
  'facetId',
  'implementation',
  'availability',
  'requiredReadiness',
  'reasons',
] as const);
const FAILURE_KEYS = Object.freeze(['schemaVersion', 'kind', 'reason'] as const);
const DIMENSION_SET = new Set<string>(HOSTED_READINESS_DIMENSIONS);
const REASON_SET = new Set<string>(HOSTED_READINESS_REASON_CODES);
const FACET_AVAILABILITY_SET = new Set<string>([
  'available',
  'temporarily_unavailable',
  'not_offered',
]);
const IMPLEMENTATION_SET = new Set<string>(['implemented', 'not_implemented']);
const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const MAX_CAPABILITY_ID_LENGTH = 96;

function invalid(): never {
  throw new TypeError('hosted_readiness_projection_invalid');
}

function snapshotExactRecord(
  value: unknown,
  expectedKeys: readonly string[]
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) invalid();
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
    ) {
      invalid();
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) invalid();
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return invalid();
  }
}

function snapshotDenseArray(value: unknown, maximumLength: number): readonly unknown[] {
  if (!Array.isArray(value)) invalid();
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) invalid();
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : -1;
    if (
      !Number.isSafeInteger(length) ||
      (length as number) < 0 ||
      (length as number) > maximumLength
    ) {
      invalid();
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== (length as number) + 1) invalid();
    const values: unknown[] = [];
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) invalid();
      values.push(descriptor.value);
    }
    return Object.freeze(values);
  } catch {
    return invalid();
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseCapabilityId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_CAPABILITY_ID_LENGTH ||
    !ID_PATTERN.test(value)
  ) {
    invalid();
  }
  return value;
}

function parseDimensions(value: unknown): readonly HostedReadinessDimension[] {
  const values = snapshotDenseArray(value, HOSTED_READINESS_DIMENSIONS.length);
  const unique = new Set<HostedReadinessDimension>();
  for (const item of values) {
    if (typeof item !== 'string' || !DIMENSION_SET.has(item)) invalid();
    unique.add(item as HostedReadinessDimension);
  }
  return Object.freeze(HOSTED_READINESS_DIMENSIONS.filter((dimension) => unique.has(dimension)));
}

function parseReasons(value: unknown): readonly HostedReadinessReasonCode[] {
  const values = snapshotDenseArray(value, MAX_HOSTED_READINESS_REASONS);
  const unique = new Set<HostedReadinessReasonCode>();
  for (const item of values) {
    if (typeof item !== 'string' || !REASON_SET.has(item)) invalid();
    unique.add(item as HostedReadinessReasonCode);
  }
  return Object.freeze([...unique].sort(compareText));
}

function assertAvailabilityReasons(
  availability: HostedFacetAvailability,
  reasons: readonly HostedReadinessReasonCode[]
): void {
  if (availability === 'available' && reasons.length !== 0) invalid();
  if (availability === 'temporarily_unavailable') {
    if (
      reasons.length === 0 ||
      reasons.includes('not_offered') ||
      reasons.includes('not_implemented')
    ) {
      invalid();
    }
  }
  if (availability === 'not_offered' && (reasons.length !== 1 || reasons[0] !== 'not_offered')) {
    invalid();
  }
}

function parseDimensionProjection(value: unknown): HostedReadinessDimensionProjection {
  const record = snapshotExactRecord(value, DIMENSION_KEYS);
  if (typeof record.dimension !== 'string' || !DIMENSION_SET.has(record.dimension)) invalid();
  if (record.status !== 'ready' && record.status !== 'not_ready') invalid();
  const reasons = parseReasons(record.reasons);
  if ((record.status === 'ready') !== (reasons.length === 0)) invalid();
  return Object.freeze({
    dimension: record.dimension as HostedReadinessDimension,
    status: record.status,
    reasons,
  });
}

function parseAllDimensionProjections(
  value: unknown
): readonly HostedReadinessDimensionProjection[] {
  const values = snapshotDenseArray(value, HOSTED_READINESS_DIMENSIONS.length);
  if (values.length !== HOSTED_READINESS_DIMENSIONS.length) invalid();
  const byDimension = new Map<HostedReadinessDimension, HostedReadinessDimensionProjection>();
  for (const item of values) {
    const dimension = parseDimensionProjection(item);
    if (byDimension.has(dimension.dimension)) invalid();
    byDimension.set(dimension.dimension, dimension);
  }
  if (byDimension.size !== HOSTED_READINESS_DIMENSIONS.length) invalid();
  return Object.freeze(HOSTED_READINESS_DIMENSIONS.map((dimension) => byDimension.get(dimension)!));
}

function parseTerminal(value: unknown): HostedTerminalProjection {
  const record = snapshotExactRecord(value, DIMENSION_KEYS);
  if (record.dimension !== 'terminal' || record.status !== 'not_offered') invalid();
  const reasons = snapshotDenseArray(record.reasons, 0);
  if (reasons.length !== 0) invalid();
  return Object.freeze({
    dimension: 'terminal',
    status: 'not_offered',
    reasons: Object.freeze([] as const),
  });
}

function parseFacet(value: unknown): HostedReadinessFacetProjection {
  const record = snapshotExactRecord(value, FACET_KEYS);
  const facetId = parseCapabilityId(record.facetId);
  if (typeof record.availability !== 'string' || !FACET_AVAILABILITY_SET.has(record.availability)) {
    invalid();
  }
  const availability = record.availability as HostedFacetAvailability;
  const requiredReadiness = parseDimensions(record.requiredReadiness);
  const reasons = parseReasons(record.reasons);
  assertAvailabilityReasons(availability, reasons);
  return Object.freeze({ facetId, availability, requiredReadiness, reasons });
}

function parseFacets(value: unknown): readonly HostedReadinessFacetProjection[] {
  const values = snapshotDenseArray(value, MAX_HOSTED_READINESS_FACETS);
  const byId = new Map<string, HostedReadinessFacetProjection>();
  for (const item of values) {
    const facet = parseFacet(item);
    if (byId.has(facet.facetId)) invalid();
    byId.set(facet.facetId, facet);
  }
  return Object.freeze(
    [...byId.values()].sort((left, right) => compareText(left.facetId, right.facetId))
  );
}

function parseAction(
  value: unknown,
  availableFacetIds: ReadonlySet<string>
): HostedReadinessActionProjection {
  const record = snapshotExactRecord(value, ACTION_KEYS);
  const actionId = parseCapabilityId(record.actionId);
  const facetId = parseCapabilityId(record.facetId);
  if (!availableFacetIds.has(facetId)) invalid();
  if (typeof record.implementation !== 'string' || !IMPLEMENTATION_SET.has(record.implementation)) {
    invalid();
  }
  if (typeof record.availability !== 'string' || !FACET_AVAILABILITY_SET.has(record.availability)) {
    invalid();
  }
  const implementation = record.implementation as HostedActionImplementation;
  const availability = record.availability as HostedFacetAvailability;
  const requiredReadiness = parseDimensions(record.requiredReadiness);
  const reasons = parseReasons(record.reasons);
  if (implementation === 'not_implemented') {
    if (
      availability !== 'not_offered' ||
      reasons.length !== 1 ||
      reasons[0] !== 'not_implemented'
    ) {
      invalid();
    }
  } else {
    assertAvailabilityReasons(availability, reasons);
  }
  return Object.freeze({
    actionId,
    facetId,
    implementation,
    availability,
    requiredReadiness,
    reasons,
  });
}

function parseActions(
  value: unknown,
  facets: readonly HostedReadinessFacetProjection[]
): readonly HostedReadinessActionProjection[] {
  const values = snapshotDenseArray(value, MAX_HOSTED_READINESS_ACTIONS);
  const facetIds = new Set(facets.map((facet) => facet.facetId));
  const byId = new Map<string, HostedReadinessActionProjection>();
  for (const item of values) {
    const action = parseAction(item, facetIds);
    if (byId.has(action.actionId)) invalid();
    byId.set(action.actionId, action);
  }
  return Object.freeze(
    [...byId.values()].sort((left, right) => compareText(left.actionId, right.actionId))
  );
}

function readinessAllowsAvailable(
  requiredReadiness: readonly HostedReadinessDimension[],
  dimensionsById: ReadonlyMap<HostedReadinessDimension, HostedReadinessDimensionProjection>
): boolean {
  return requiredReadiness.every((dimension) => dimensionsById.get(dimension)?.status === 'ready');
}

function availabilityDoesNotExceed(
  availability: HostedFacetAvailability,
  ownerAvailability: HostedFacetAvailability
): boolean {
  if (ownerAvailability === 'available') return true;
  if (ownerAvailability === 'temporarily_unavailable') return availability !== 'available';
  return availability === 'not_offered';
}

function assertReadinessLattice(
  dimensions: readonly HostedReadinessDimensionProjection[],
  facets: readonly HostedReadinessFacetProjection[],
  actions: readonly HostedReadinessActionProjection[]
): void {
  const dimensionsById = new Map(dimensions.map((dimension) => [dimension.dimension, dimension]));
  const facetsById = new Map(facets.map((facet) => [facet.facetId, facet]));

  for (const facet of facets) {
    if (
      facet.availability === 'available' &&
      !readinessAllowsAvailable(facet.requiredReadiness, dimensionsById)
    ) {
      invalid();
    }
  }

  for (const action of actions) {
    const owningFacet = facetsById.get(action.facetId);
    if (!owningFacet || !availabilityDoesNotExceed(action.availability, owningFacet.availability)) {
      invalid();
    }
    if (
      action.availability === 'available' &&
      !readinessAllowsAvailable(action.requiredReadiness, dimensionsById)
    ) {
      invalid();
    }
  }
}

function parseProjection(value: unknown): HostedReadinessProjection {
  const record = snapshotExactRecord(value, PROJECTION_KEYS);
  if (record.schemaVersion !== HOSTED_READINESS_SCHEMA_VERSION || record.kind !== 'success')
    invalid();
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0) invalid();
  const requiredReadiness = parseDimensions(record.requiredReadiness);
  const dimensions = parseAllDimensionProjections(record.dimensions);
  const terminal = parseTerminal(record.terminal);
  const facets = parseFacets(record.facets);
  const actions = parseActions(record.actions, facets);
  assertReadinessLattice(dimensions, facets, actions);
  const projection = Object.freeze({
    schemaVersion: HOSTED_READINESS_SCHEMA_VERSION,
    kind: 'success' as const,
    deploymentId: parseDeploymentId(record.deploymentId),
    bootId: parseBootId(record.bootId),
    revision: record.revision as number,
    requiredReadiness,
    dimensions,
    terminal,
    facets,
    actions,
  });
  if (
    new TextEncoder().encode(JSON.stringify(projection)).byteLength >
    MAX_HOSTED_READINESS_RESPONSE_BYTES
  ) {
    invalid();
  }
  return projection;
}

export function parseHostedReadinessProjection(
  value: unknown
): HostedReadinessProjectionParseResult {
  try {
    return Object.freeze({ ok: true, value: parseProjection(value) });
  } catch {
    return Object.freeze({ ok: false, error: 'hosted_readiness_projection_invalid' });
  }
}

export function createHostedReadinessFailure(
  reason: HostedReadinessFailureReason
): HostedReadinessFailure {
  return Object.freeze({
    schemaVersion: HOSTED_READINESS_SCHEMA_VERSION,
    kind: 'failure',
    reason,
  });
}

export function parseHostedReadinessResponse(value: unknown): HostedReadinessResponse | null {
  const projection = parseHostedReadinessProjection(value);
  if (projection.ok) return projection.value;
  try {
    const record = snapshotExactRecord(value, FAILURE_KEYS);
    if (
      record.schemaVersion !== HOSTED_READINESS_SCHEMA_VERSION ||
      record.kind !== 'failure' ||
      ![
        'request_cancelled',
        'deadline_exceeded',
        'readiness_unavailable',
        'response_invalid',
      ].includes(record.reason as string)
    ) {
      return null;
    }
    return createHostedReadinessFailure(record.reason as HostedReadinessFailureReason);
  } catch {
    return null;
  }
}
