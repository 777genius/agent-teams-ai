import {
  createQueryContext,
  createSafeAppError,
  type Cursor,
  HOSTED_SCHEMA_VERSION,
  parseCursor,
  parseHostedSchemaVersion,
  parseRevision,
  parseSyntheticTeamId,
  type QueryContext,
  type Revision,
  type SafeAppError,
  SCHEMA_VERSION_DIAGNOSTIC,
  type TeamId,
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

export interface ListTeamLifecycleRequest {
  readonly schemaVersion: typeof TEAM_LIFECYCLE_READ_SCHEMA_VERSION;
  readonly context: QueryContext;
  readonly cursor: Cursor | null;
  readonly expectedRevision: Revision | null;
}

export interface TeamLifecycleListItem {
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
  'conflict',
  'unsupported',
  'unavailable',
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

const REQUEST_KEYS = Object.freeze([
  'schemaVersion',
  'context',
  'cursor',
  'expectedRevision',
] as const);
const QUERY_CONTEXT_KEYS = Object.freeze([
  'actorId',
  'sessionId',
  'deploymentId',
  'bootId',
  'requestId',
  'authorizedScope',
  'deadlineAtMs',
  'signal',
] as const);
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
    const contextValue = value.context;
    const cursorValue = value.cursor;
    const expectedRevisionValue = value.expectedRevision;
    if (!isRecord(contextValue) || !hasExactKeys(contextValue, QUERY_CONTEXT_KEYS)) {
      return requestInvalid();
    }

    const schemaVersion = parseHostedSchemaVersion(schemaVersionValue);
    const context = createQueryContext(contextValue);
    const cursor = cursorValue === null ? null : parseCursor(cursorValue);
    const expectedRevision =
      expectedRevisionValue === null ? null : parseRevision(expectedRevisionValue);

    return parseSuccess(
      Object.freeze({
        schemaVersion,
        context,
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
  const teamId = parseSyntheticTeamId(value.teamId);
  const displayName = value.displayName;
  const lifecycle = value.lifecycle;
  const revision = parseRevision(value.revision);
  if (
    typeof displayName !== 'string' ||
    displayName.length < 1 ||
    displayName.length > 128 ||
    displayName.trim() !== displayName ||
    !TEAM_LIFECYCLE_STATES.includes(lifecycle as TeamLifecycleState)
  ) {
    throw new TypeError();
  }

  return Object.freeze({
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
