import {
  createSafeAppError,
  type Cursor,
  HOSTED_SCHEMA_VERSION,
  parseCursor,
  parseHostedSchemaVersion,
  parseRevision,
  parseSyntheticTeamId,
  parseTeamId,
  parseWorkspaceId,
  type Revision,
  type SafeAppError,
  SCHEMA_VERSION_DIAGNOSTIC,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

export const TEAM_LIFECYCLE_READ_SCHEMA_VERSION = HOSTED_SCHEMA_VERSION;
export const TEAM_LIFECYCLE_READ_UNKNOWN_FIELD_POLICY = 'reject' as const;
export const TEAM_LIFECYCLE_READ_REQUEST_DIAGNOSTIC =
  'team-lifecycle-read.request-invalid' as const;
export const TEAM_LIFECYCLE_READ_RESPONSE_DIAGNOSTIC =
  'team-lifecycle-read.response-invalid' as const;

export const TEAM_LIFECYCLE_STATES = Object.freeze([
  'draft',
  'ready',
  'running',
  'degraded',
  'stopped',
  'deleted',
] as const);

export type TeamLifecycleState = (typeof TEAM_LIFECYCLE_STATES)[number];

// Wire DTO: fully JSON-serializable. Caller identity, authorization scope, deadline, and
// cancellation are never parsed from the wire — the host assembles them into a QueryContext
// from the authenticated principal and passes it to the application separately.
export interface ListTeamLifecycleRequest {
  readonly schemaVersion: typeof TEAM_LIFECYCLE_READ_SCHEMA_VERSION;
  readonly cursor: Cursor | null;
  readonly expectedRevision: Revision | null;
}

export interface TeamLifecycleListItem {
  /**
   * Phase 1 fixtures intentionally omit workspace identity. Canonical Phase 2 results require it
   * and are validated with parseCanonicalListTeamLifecycleResult before crossing the API facet.
   */
  readonly workspaceId?: WorkspaceId;
  readonly teamId: TeamId;
  readonly displayName: string;
  readonly lifecycle: TeamLifecycleState;
  readonly revision: Revision;
}

export interface ListTeamLifecycleSuccess {
  readonly schemaVersion: typeof TEAM_LIFECYCLE_READ_SCHEMA_VERSION;
  readonly kind: 'success';
  readonly snapshotRevision: Revision;
  readonly items: readonly TeamLifecycleListItem[];
  readonly nextCursor: Cursor | null;
}

export const TEAM_LIFECYCLE_READ_FAILURE_CODES = Object.freeze([
  'invalid_request',
  'forbidden',
  'conflict',
  'unsupported',
  'unavailable',
  'cancelled',
  'internal',
] as const);

export type TeamLifecycleReadFailureCode = (typeof TEAM_LIFECYCLE_READ_FAILURE_CODES)[number];

export interface ListTeamLifecycleFailure {
  readonly schemaVersion: typeof TEAM_LIFECYCLE_READ_SCHEMA_VERSION;
  readonly kind: 'failure';
  readonly error: SafeAppError & { readonly code: TeamLifecycleReadFailureCode };
  readonly retryable: boolean;
}

export type TeamLifecycleInapplicableCode = 'not_applicable' | 'unsupported';
export type TeamLifecycleInapplicableReason =
  | 'list_not_found_inapplicable'
  | 'unknown_lifecycle_provisioning';

export interface ListTeamLifecycleInapplicable {
  readonly schemaVersion: typeof TEAM_LIFECYCLE_READ_SCHEMA_VERSION;
  readonly kind: 'inapplicable';
  readonly code: TeamLifecycleInapplicableCode;
  readonly reason: TeamLifecycleInapplicableReason;
}

export type ListTeamLifecycleResult =
  | ListTeamLifecycleSuccess
  | ListTeamLifecycleFailure
  | ListTeamLifecycleInapplicable;

export interface TeamLifecycleReadParseSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export interface TeamLifecycleReadParseFailure {
  readonly ok: false;
  readonly error: SafeAppError;
}

export type TeamLifecycleReadParseResult<T> =
  | TeamLifecycleReadParseSuccess<T>
  | TeamLifecycleReadParseFailure;

const REQUEST_KEYS = Object.freeze(['schemaVersion', 'cursor', 'expectedRevision'] as const);
const SUCCESS_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'snapshotRevision',
  'items',
  'nextCursor',
] as const);
const FAILURE_KEYS = Object.freeze(['schemaVersion', 'kind', 'error', 'retryable'] as const);
const INAPPLICABLE_KEYS = Object.freeze(['schemaVersion', 'kind', 'code', 'reason'] as const);
const ITEM_KEYS = Object.freeze(['teamId', 'displayName', 'lifecycle', 'revision'] as const);
const CANONICAL_DISPLAY_NAME_PRIVATE_PATH = /^(?:\/|~\/|[A-Za-z]:\\)/;

function hasDisplayNameControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function hasKnownKeys(value: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key));
}

function parseSuccess<T>(value: T): TeamLifecycleReadParseSuccess<T> {
  return Object.freeze({ ok: true, value });
}

function parseFailure(
  code: 'invalid_request' | 'unsupported' | 'internal',
  reason: 'request_invalid' | 'schema_version_unsupported' | 'source_response_invalid',
  diagnosticId: string
): TeamLifecycleReadParseFailure {
  return Object.freeze({
    ok: false,
    error: createSafeAppError({ code, reason, diagnosticId }),
  });
}

function requestInvalid(): TeamLifecycleReadParseFailure {
  return parseFailure('invalid_request', 'request_invalid', TEAM_LIFECYCLE_READ_REQUEST_DIAGNOSTIC);
}

function responseInvalid(): TeamLifecycleReadParseFailure {
  return parseFailure(
    'internal',
    'source_response_invalid',
    TEAM_LIFECYCLE_READ_RESPONSE_DIAGNOSTIC
  );
}

function unsupportedVersion(): TeamLifecycleReadParseFailure {
  return parseFailure('unsupported', 'schema_version_unsupported', SCHEMA_VERSION_DIAGNOSTIC);
}

export function parseListTeamLifecycleRequest(
  value: unknown
): TeamLifecycleReadParseResult<ListTeamLifecycleRequest> {
  try {
    if (!isRecord(value)) return requestInvalid();
    const hasSchemaVersion = Object.hasOwn(value, 'schemaVersion');
    const schemaVersionValue = hasSchemaVersion ? value.schemaVersion : undefined;
    if (hasSchemaVersion && schemaVersionValue !== TEAM_LIFECYCLE_READ_SCHEMA_VERSION) {
      return unsupportedVersion();
    }
    if (!hasExactKeys(value, REQUEST_KEYS)) {
      return requestInvalid();
    }
    const cursorValue = value.cursor;
    const expectedRevisionValue = value.expectedRevision;

    const schemaVersion = parseHostedSchemaVersion(schemaVersionValue);
    const cursor = cursorValue === null ? null : parseCursor(cursorValue);
    const expectedRevision =
      expectedRevisionValue === null ? null : parseRevision(expectedRevisionValue);

    return parseSuccess(
      Object.freeze({
        schemaVersion,
        cursor,
        expectedRevision,
      }) satisfies ListTeamLifecycleRequest
    );
  } catch {
    return requestInvalid();
  }
}

function compareItems(left: TeamLifecycleListItem, right: TeamLifecycleListItem): number {
  const leftDisplayName = left.displayName.normalize('NFKC').toLowerCase();
  const rightDisplayName = right.displayName.normalize('NFKC').toLowerCase();
  if (leftDisplayName !== rightDisplayName) return leftDisplayName < rightDisplayName ? -1 : 1;
  if (left.teamId === right.teamId) return 0;
  return left.teamId < right.teamId ? -1 : 1;
}

function parseItem(value: unknown): TeamLifecycleListItem {
  if (!isRecord(value) || !hasKnownKeys(value, ITEM_KEYS)) throw new TypeError();
  const hasWorkspaceId = Object.hasOwn(value, 'workspaceId');
  const workspaceId = hasWorkspaceId ? parseWorkspaceId(value.workspaceId) : null;
  // Synthetic IDs remain accepted only for the immutable Phase 1 corpus. Every canonical Phase 2
  // item carries workspaceId and therefore takes the strict canonical parser branch.
  const teamId = hasWorkspaceId ? parseTeamId(value.teamId) : parseSyntheticTeamId(value.teamId);
  const displayName = value.displayName;
  const lifecycle = value.lifecycle;
  const revision = parseRevision(value.revision);
  if (
    typeof displayName !== 'string' ||
    displayName.length < 1 ||
    displayName.length > 128 ||
    displayName.trim() !== displayName ||
    (hasWorkspaceId &&
      (CANONICAL_DISPLAY_NAME_PRIVATE_PATH.test(displayName) ||
        hasDisplayNameControlCharacter(displayName))) ||
    !TEAM_LIFECYCLE_STATES.includes(lifecycle as TeamLifecycleState)
  ) {
    throw new TypeError();
  }

  return workspaceId === null
    ? Object.freeze({
        teamId,
        displayName,
        lifecycle: lifecycle as TeamLifecycleState,
        revision,
      })
    : Object.freeze({
        workspaceId,
        teamId,
        displayName,
        lifecycle: lifecycle as TeamLifecycleState,
        revision,
      });
}

function parseSuccessResult(
  value: Record<PropertyKey, unknown>,
  schemaVersion: typeof TEAM_LIFECYCLE_READ_SCHEMA_VERSION
): ListTeamLifecycleSuccess {
  if (!hasKnownKeys(value, SUCCESS_KEYS)) throw new TypeError();
  const snapshotRevisionValue = value.snapshotRevision;
  const itemsValue = value.items;
  const nextCursorValue = value.nextCursor;
  if (!Array.isArray(itemsValue)) {
    throw new TypeError();
  }
  const itemCount = itemsValue.length;
  if (!Number.isSafeInteger(itemCount) || itemCount < 0 || itemCount > 1_000) {
    throw new TypeError();
  }

  const snapshotRevision = parseRevision(snapshotRevisionValue);
  const nextCursor = nextCursorValue === null ? null : parseCursor(nextCursorValue);
  const items: TeamLifecycleListItem[] = [];
  items.length = itemCount;
  for (let index = 0; index < itemCount; index += 1) {
    if (!Object.hasOwn(itemsValue, index)) throw new TypeError();
    const itemValue = itemsValue[index];
    Object.defineProperty(items, index, {
      configurable: true,
      enumerable: true,
      value: parseItem(itemValue),
      writable: true,
    });
  }

  const teamIds = new Set<TeamId>();
  for (let index = 0; index < itemCount; index += 1) {
    const teamId = items[index].teamId;
    if (teamIds.has(teamId)) throw new TypeError();
    teamIds.add(teamId);
  }
  items.sort(compareItems);

  return Object.freeze({
    schemaVersion,
    kind: 'success',
    snapshotRevision,
    items: Object.freeze(items),
    nextCursor,
  });
}

function parseResponseSafeError(value: unknown): SafeAppError {
  if (!isRecord(value) || !hasKnownKeys(value, ['code', 'reason'])) throw new TypeError();

  const candidate: Record<string, unknown> = {
    code: value.code,
    reason: value.reason,
  };
  if (Object.hasOwn(value, 'diagnosticId')) {
    if (value.diagnosticId === undefined) throw new TypeError();
    candidate.diagnosticId = value.diagnosticId;
  }
  if (Object.hasOwn(value, 'retryAfterMs')) {
    if (value.retryAfterMs === undefined) throw new TypeError();
    candidate.retryAfterMs = value.retryAfterMs;
  }
  return createSafeAppError(candidate);
}

function parseFailureResult(
  value: Record<PropertyKey, unknown>,
  schemaVersion: typeof TEAM_LIFECYCLE_READ_SCHEMA_VERSION
): ListTeamLifecycleFailure {
  if (!hasKnownKeys(value, FAILURE_KEYS)) throw new TypeError();
  const errorValue = value.error;
  const retryable = value.retryable;
  if (typeof retryable !== 'boolean') {
    throw new TypeError();
  }

  const error = parseResponseSafeError(errorValue);
  if (
    !TEAM_LIFECYCLE_READ_FAILURE_CODES.includes(error.code as TeamLifecycleReadFailureCode) ||
    retryable !== (error.code === 'unavailable') ||
    (error.code === 'internal' && error.diagnosticId === undefined)
  ) {
    throw new TypeError();
  }

  return Object.freeze({
    schemaVersion,
    kind: 'failure',
    error: error as ListTeamLifecycleFailure['error'],
    retryable,
  });
}

function parseInapplicableResult(
  value: Record<PropertyKey, unknown>,
  schemaVersion: typeof TEAM_LIFECYCLE_READ_SCHEMA_VERSION
): ListTeamLifecycleInapplicable {
  if (!hasKnownKeys(value, INAPPLICABLE_KEYS)) throw new TypeError();
  const code = value.code;
  const reason = value.reason;
  const validNotFound = code === 'not_applicable' && reason === 'list_not_found_inapplicable';
  const validProvisioning = code === 'unsupported' && reason === 'unknown_lifecycle_provisioning';
  if (!validNotFound && !validProvisioning) throw new TypeError();

  return Object.freeze({
    schemaVersion,
    kind: 'inapplicable',
    code: code as TeamLifecycleInapplicableCode,
    reason: reason as TeamLifecycleInapplicableReason,
  });
}

export function parseListTeamLifecycleResult(
  value: unknown
): TeamLifecycleReadParseResult<ListTeamLifecycleResult> {
  try {
    if (!isRecord(value)) return responseInvalid();
    const hasSchemaVersion = Object.hasOwn(value, 'schemaVersion');
    const schemaVersionValue = hasSchemaVersion ? value.schemaVersion : undefined;
    if (hasSchemaVersion && schemaVersionValue !== TEAM_LIFECYCLE_READ_SCHEMA_VERSION) {
      return unsupportedVersion();
    }
    if (!hasSchemaVersion) return responseInvalid();

    const schemaVersion = parseHostedSchemaVersion(schemaVersionValue);
    const kind = value.kind;
    if (kind === 'success') return parseSuccess(parseSuccessResult(value, schemaVersion));
    if (kind === 'failure') return parseSuccess(parseFailureResult(value, schemaVersion));
    if (kind === 'inapplicable') {
      return parseSuccess(parseInapplicableResult(value, schemaVersion));
    }
    return responseInvalid();
  } catch {
    return responseInvalid();
  }
}

export interface CanonicalTeamLifecycleListItem extends TeamLifecycleListItem {
  readonly workspaceId: WorkspaceId;
}

export interface CanonicalListTeamLifecycleSuccess extends Omit<ListTeamLifecycleSuccess, 'items'> {
  readonly items: readonly CanonicalTeamLifecycleListItem[];
}

export type CanonicalListTeamLifecycleResult =
  | CanonicalListTeamLifecycleSuccess
  | ListTeamLifecycleFailure
  | ListTeamLifecycleInapplicable;

export function parseCanonicalListTeamLifecycleResult(
  value: unknown
): TeamLifecycleReadParseResult<CanonicalListTeamLifecycleResult> {
  const parsed = parseListTeamLifecycleResult(value);
  if (!parsed.ok) return parsed;
  if (parsed.value.kind !== 'success') return parseSuccess(parsed.value);

  for (let index = 0; index < parsed.value.items.length; index += 1) {
    const item = parsed.value.items[index];
    if (!Object.hasOwn(item, 'workspaceId')) return responseInvalid();
    try {
      parseWorkspaceId(item.workspaceId);
      parseTeamId(item.teamId);
    } catch {
      return responseInvalid();
    }
  }

  return parseSuccess(parsed.value as CanonicalListTeamLifecycleSuccess);
}

export interface TeamLifecycleEntityRequest {
  readonly schemaVersion: typeof TEAM_LIFECYCLE_READ_SCHEMA_VERSION;
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly expectedRevision: Revision | null;
}

export type GetTeamLifecycleSnapshotRequest = TeamLifecycleEntityRequest;
export type GetRuntimeStateProjectionRequest = TeamLifecycleEntityRequest;

export interface ListAliveTeamProjectionsRequest {
  readonly schemaVersion: typeof TEAM_LIFECYCLE_READ_SCHEMA_VERSION;
  readonly cursor: Cursor | null;
  readonly expectedRevision: Revision | null;
}

export interface TeamLifecycleSnapshot {
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly displayName: string;
  readonly lifecycle: TeamLifecycleState;
  readonly revision: Revision;
}

export interface RuntimeStateProjection {
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly isAlive: boolean;
  readonly revision: Revision;
}

export interface GetTeamLifecycleSnapshotSuccess {
  readonly schemaVersion: typeof TEAM_LIFECYCLE_READ_SCHEMA_VERSION;
  readonly kind: 'success';
  readonly snapshotRevision: Revision;
  readonly snapshot: TeamLifecycleSnapshot;
}

export interface GetRuntimeStateProjectionSuccess {
  readonly schemaVersion: typeof TEAM_LIFECYCLE_READ_SCHEMA_VERSION;
  readonly kind: 'success';
  readonly snapshotRevision: Revision;
  readonly projection: RuntimeStateProjection;
}

export interface ListAliveTeamProjectionsSuccess {
  readonly schemaVersion: typeof TEAM_LIFECYCLE_READ_SCHEMA_VERSION;
  readonly kind: 'success';
  readonly snapshotRevision: Revision;
  readonly items: readonly RuntimeStateProjection[];
  readonly nextCursor: Cursor | null;
}

export type TeamLifecycleReadFailure = ListTeamLifecycleFailure;

export type TeamLifecycleEntityInapplicableReason =
  | 'team_not_found'
  | 'unknown_lifecycle_provisioning';

export interface TeamLifecycleEntityInapplicable {
  readonly schemaVersion: typeof TEAM_LIFECYCLE_READ_SCHEMA_VERSION;
  readonly kind: 'inapplicable';
  readonly code: TeamLifecycleInapplicableCode;
  readonly reason: TeamLifecycleEntityInapplicableReason;
}

export type GetTeamLifecycleSnapshotResult =
  | GetTeamLifecycleSnapshotSuccess
  | TeamLifecycleReadFailure
  | TeamLifecycleEntityInapplicable;

export type GetRuntimeStateProjectionResult =
  | GetRuntimeStateProjectionSuccess
  | TeamLifecycleReadFailure
  | TeamLifecycleEntityInapplicable;

export type ListAliveTeamProjectionsResult =
  | ListAliveTeamProjectionsSuccess
  | TeamLifecycleReadFailure;

const ENTITY_REQUEST_KEYS = Object.freeze([
  'schemaVersion',
  'workspaceId',
  'teamId',
  'expectedRevision',
] as const);
const SNAPSHOT_SUCCESS_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'snapshotRevision',
  'snapshot',
] as const);
const SNAPSHOT_KEYS = Object.freeze([
  'workspaceId',
  'teamId',
  'displayName',
  'lifecycle',
  'revision',
] as const);
const RUNTIME_SUCCESS_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'snapshotRevision',
  'projection',
] as const);
const RUNTIME_PROJECTION_KEYS = Object.freeze([
  'workspaceId',
  'teamId',
  'isAlive',
  'revision',
] as const);
const ALIVE_SUCCESS_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'snapshotRevision',
  'items',
  'nextCursor',
] as const);

function parseEntityRequest(
  value: unknown
): TeamLifecycleReadParseResult<TeamLifecycleEntityRequest> {
  try {
    if (!isRecord(value)) return requestInvalid();
    const hasSchemaVersion = Object.hasOwn(value, 'schemaVersion');
    const schemaVersionValue = hasSchemaVersion ? value.schemaVersion : undefined;
    if (hasSchemaVersion && schemaVersionValue !== TEAM_LIFECYCLE_READ_SCHEMA_VERSION) {
      return unsupportedVersion();
    }
    if (!hasExactKeys(value, ENTITY_REQUEST_KEYS)) return requestInvalid();

    const expectedRevisionValue = value.expectedRevision;
    return parseSuccess(
      Object.freeze({
        schemaVersion: parseHostedSchemaVersion(schemaVersionValue),
        workspaceId: parseWorkspaceId(value.workspaceId),
        teamId: parseTeamId(value.teamId),
        expectedRevision:
          expectedRevisionValue === null ? null : parseRevision(expectedRevisionValue),
      })
    );
  } catch {
    return requestInvalid();
  }
}

export function parseGetTeamLifecycleSnapshotRequest(
  value: unknown
): TeamLifecycleReadParseResult<GetTeamLifecycleSnapshotRequest> {
  return parseEntityRequest(value);
}

export function parseGetRuntimeStateProjectionRequest(
  value: unknown
): TeamLifecycleReadParseResult<GetRuntimeStateProjectionRequest> {
  return parseEntityRequest(value);
}

export function parseListAliveTeamProjectionsRequest(
  value: unknown
): TeamLifecycleReadParseResult<ListAliveTeamProjectionsRequest> {
  return parseListTeamLifecycleRequest(value);
}

function parseCanonicalIdentity(value: Record<PropertyKey, unknown>): {
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
} {
  return {
    workspaceId: parseWorkspaceId(value.workspaceId),
    teamId: parseTeamId(value.teamId),
  };
}

function parseDisplayName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    CANONICAL_DISPLAY_NAME_PRIVATE_PATH.test(value) ||
    hasDisplayNameControlCharacter(value)
  ) {
    throw new TypeError();
  }
  return value;
}

function parseTeamLifecycleSnapshot(value: unknown): TeamLifecycleSnapshot {
  if (!isRecord(value) || !hasKnownKeys(value, SNAPSHOT_KEYS)) throw new TypeError();
  const identity = parseCanonicalIdentity(value);
  const lifecycle = value.lifecycle;
  if (!TEAM_LIFECYCLE_STATES.includes(lifecycle as TeamLifecycleState)) throw new TypeError();
  return Object.freeze({
    ...identity,
    displayName: parseDisplayName(value.displayName),
    lifecycle: lifecycle as TeamLifecycleState,
    revision: parseRevision(value.revision),
  });
}

function parseRuntimeStateProjection(value: unknown): RuntimeStateProjection {
  if (!isRecord(value) || !hasKnownKeys(value, RUNTIME_PROJECTION_KEYS)) {
    throw new TypeError();
  }
  const identity = parseCanonicalIdentity(value);
  const isAlive = value.isAlive;
  if (typeof isAlive !== 'boolean') throw new TypeError();
  return Object.freeze({
    ...identity,
    isAlive,
    revision: parseRevision(value.revision),
  });
}

function parseEntityInapplicable(
  value: Record<PropertyKey, unknown>,
  schemaVersion: typeof TEAM_LIFECYCLE_READ_SCHEMA_VERSION
): TeamLifecycleEntityInapplicable {
  if (!hasKnownKeys(value, INAPPLICABLE_KEYS)) throw new TypeError();
  const code = value.code;
  const reason = value.reason;
  const validNotFound = code === 'not_applicable' && reason === 'team_not_found';
  const validProvisioning = code === 'unsupported' && reason === 'unknown_lifecycle_provisioning';
  if (!validNotFound && !validProvisioning) throw new TypeError();
  return Object.freeze({
    schemaVersion,
    kind: 'inapplicable',
    code: code as TeamLifecycleInapplicableCode,
    reason: reason as TeamLifecycleEntityInapplicableReason,
  });
}

function parseResponseVersion(
  value: Record<PropertyKey, unknown>
):
  | TeamLifecycleReadParseFailure
  | TeamLifecycleReadParseSuccess<typeof TEAM_LIFECYCLE_READ_SCHEMA_VERSION> {
  const hasSchemaVersion = Object.hasOwn(value, 'schemaVersion');
  const schemaVersionValue = hasSchemaVersion ? value.schemaVersion : undefined;
  if (hasSchemaVersion && schemaVersionValue !== TEAM_LIFECYCLE_READ_SCHEMA_VERSION) {
    return unsupportedVersion();
  }
  if (!hasSchemaVersion) return responseInvalid();
  try {
    return parseSuccess(parseHostedSchemaVersion(schemaVersionValue));
  } catch {
    return responseInvalid();
  }
}

export function parseGetTeamLifecycleSnapshotResult(
  value: unknown
): TeamLifecycleReadParseResult<GetTeamLifecycleSnapshotResult> {
  try {
    if (!isRecord(value)) return responseInvalid();
    const version = parseResponseVersion(value);
    if (!version.ok) return version;
    const kind = value.kind;
    if (kind === 'failure') {
      return parseSuccess(parseFailureResult(value, version.value));
    }
    if (kind === 'inapplicable') {
      return parseSuccess(parseEntityInapplicable(value, version.value));
    }
    if (kind !== 'success' || !hasKnownKeys(value, SNAPSHOT_SUCCESS_KEYS)) {
      return responseInvalid();
    }
    return parseSuccess(
      Object.freeze({
        schemaVersion: version.value,
        kind: 'success',
        snapshotRevision: parseRevision(value.snapshotRevision),
        snapshot: parseTeamLifecycleSnapshot(value.snapshot),
      })
    );
  } catch {
    return responseInvalid();
  }
}

export function parseGetRuntimeStateProjectionResult(
  value: unknown
): TeamLifecycleReadParseResult<GetRuntimeStateProjectionResult> {
  try {
    if (!isRecord(value)) return responseInvalid();
    const version = parseResponseVersion(value);
    if (!version.ok) return version;
    const kind = value.kind;
    if (kind === 'failure') {
      return parseSuccess(parseFailureResult(value, version.value));
    }
    if (kind === 'inapplicable') {
      return parseSuccess(parseEntityInapplicable(value, version.value));
    }
    if (kind !== 'success' || !hasKnownKeys(value, RUNTIME_SUCCESS_KEYS)) {
      return responseInvalid();
    }
    return parseSuccess(
      Object.freeze({
        schemaVersion: version.value,
        kind: 'success',
        snapshotRevision: parseRevision(value.snapshotRevision),
        projection: parseRuntimeStateProjection(value.projection),
      })
    );
  } catch {
    return responseInvalid();
  }
}

function compareRuntimeProjections(
  left: RuntimeStateProjection,
  right: RuntimeStateProjection
): number {
  if (left.workspaceId !== right.workspaceId) {
    return left.workspaceId < right.workspaceId ? -1 : 1;
  }
  if (left.teamId === right.teamId) return 0;
  return left.teamId < right.teamId ? -1 : 1;
}

function parseAliveSuccess(
  value: Record<PropertyKey, unknown>,
  schemaVersion: typeof TEAM_LIFECYCLE_READ_SCHEMA_VERSION
): ListAliveTeamProjectionsSuccess {
  if (!hasKnownKeys(value, ALIVE_SUCCESS_KEYS)) {
    throw new TypeError();
  }
  const sourceItems = value.items;
  if (!Array.isArray(sourceItems)) throw new TypeError();
  const itemCount = sourceItems.length;
  if (!Number.isSafeInteger(itemCount) || itemCount > 1_000) throw new TypeError();

  const items: RuntimeStateProjection[] = [];
  items.length = itemCount;
  for (let index = 0; index < itemCount; index += 1) {
    if (!Object.hasOwn(sourceItems, index)) throw new TypeError();
    Object.defineProperty(items, index, {
      configurable: true,
      enumerable: true,
      value: parseRuntimeStateProjection(sourceItems[index]),
      writable: true,
    });
  }

  const identities = new Set<string>();
  for (let index = 0; index < itemCount; index += 1) {
    const item = items[index];
    const identity = `${item.workspaceId}:${item.teamId}`;
    if (identities.has(identity) || !item.isAlive) throw new TypeError();
    identities.add(identity);
  }
  items.sort(compareRuntimeProjections);

  const nextCursorValue = value.nextCursor;
  return Object.freeze({
    schemaVersion,
    kind: 'success',
    snapshotRevision: parseRevision(value.snapshotRevision),
    items: Object.freeze(items),
    nextCursor: nextCursorValue === null ? null : parseCursor(nextCursorValue),
  });
}

export function parseListAliveTeamProjectionsResult(
  value: unknown
): TeamLifecycleReadParseResult<ListAliveTeamProjectionsResult> {
  try {
    if (!isRecord(value)) return responseInvalid();
    const version = parseResponseVersion(value);
    if (!version.ok) return version;
    const kind = value.kind;
    if (kind === 'failure') {
      return parseSuccess(parseFailureResult(value, version.value));
    }
    if (kind !== 'success') return responseInvalid();
    return parseSuccess(parseAliveSuccess(value, version.value));
  } catch {
    return responseInvalid();
  }
}
