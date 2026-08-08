import {
  createSafeAppError,
  HOSTED_SCHEMA_VERSION,
  type SafeAppError,
} from '@shared/contracts/hosted';

import { createReferenceLoadBudget, type ReferenceLoadBudget } from './budgets';
import { createOperationCorrelationContext, type OperationCorrelationContext } from './correlation';
import {
  OPERATION_EVENT_KINDS,
  OPERATION_OUTCOMES,
  type OperationEventKind,
  type OperationOutcome,
  REDACTED_OPERATION_ATTRIBUTE_VALUE,
  SAFE_OPERATION_ATTRIBUTE_KEYS,
  SAFE_OPERATION_ATTRIBUTE_VALUES,
  type SafeOperationAttributeKey,
  type SafeOperationAttributes,
} from './events';
import { snapshotExactDataRecord } from './exactDataSnapshot';
import {
  type DiagnosticId,
  type OperationalReferenceId,
  parseDiagnosticId,
  parseOperationalReferenceId,
} from './identifiers';

export const HOSTED_DIAGNOSTICS_SCHEMA_VERSION = HOSTED_SCHEMA_VERSION;
export const HOSTED_DIAGNOSTICS_QUERY_ROUTE = '/api/hosted/v1/operations/diagnostics' as const;

export const HOSTED_DIAGNOSTICS_MAX_REFERENCES = 32;
export const HOSTED_DIAGNOSTICS_MAX_BYTES_PER_REFERENCE = 64 * 1_024;
export const HOSTED_DIAGNOSTICS_MAX_TOTAL_BYTES = 512 * 1_024;
export const HOSTED_DIAGNOSTICS_MAX_CONCURRENT_LOADS = 4;

/** Fixed host policy. A browser request has no field capable of replacing or widening it. */
export const HOSTED_DIAGNOSTICS_REFERENCE_BUDGET: ReferenceLoadBudget = createReferenceLoadBudget({
  maxReferences: HOSTED_DIAGNOSTICS_MAX_REFERENCES,
  maxBytesPerReference: HOSTED_DIAGNOSTICS_MAX_BYTES_PER_REFERENCE,
  maxTotalBytes: HOSTED_DIAGNOSTICS_MAX_TOTAL_BYTES,
  maxConcurrentLoads: HOSTED_DIAGNOSTICS_MAX_CONCURRENT_LOADS,
});

export const HOSTED_DIAGNOSTICS_ERROR_REASONS = Object.freeze([
  'request_invalid',
  'request_cancelled',
  'reference_budget_exceeded',
  'diagnostics_unavailable',
  'response_invalid',
  'transport_unavailable',
] as const);

export type HostedDiagnosticsErrorReason = (typeof HOSTED_DIAGNOSTICS_ERROR_REASONS)[number];

/** Browser input. Principal, scope, deadline, cancellation, and budgets are host-owned. */
export interface HostedDiagnosticsRequest {
  readonly schemaVersion: typeof HOSTED_DIAGNOSTICS_SCHEMA_VERSION;
  readonly referenceIds: readonly OperationalReferenceId[];
}

/**
 * A deliberately narrow structured projection. There is no free-form text, path, command,
 * environment, header, credential, token, or provider-output field.
 */
export interface HostedDiagnosticItem {
  readonly referenceId: OperationalReferenceId;
  readonly kind: OperationEventKind;
  readonly outcome: OperationOutcome;
  readonly occurredAtMonotonicMs: number;
  readonly attributes: SafeOperationAttributes;
  readonly byteLength: number;
}

export interface HostedDiagnosticsSuccess {
  readonly schemaVersion: typeof HOSTED_DIAGNOSTICS_SCHEMA_VERSION;
  readonly kind: 'success';
  readonly correlation: OperationCorrelationContext & {
    readonly diagnosticId: DiagnosticId;
    readonly runId?: never;
    readonly sseConnectionId?: never;
    readonly teamId?: never;
  };
  readonly items: readonly HostedDiagnosticItem[];
  readonly totalBytes: number;
}

export interface HostedDiagnosticsFailure {
  readonly schemaVersion: typeof HOSTED_DIAGNOSTICS_SCHEMA_VERSION;
  readonly kind: 'error';
  readonly error: SafeAppError & { readonly reason: HostedDiagnosticsErrorReason };
  readonly retryable: boolean;
}

export type HostedDiagnosticsResponse = HostedDiagnosticsSuccess | HostedDiagnosticsFailure;

export type HostedDiagnosticsParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false };

const REQUEST_KEYS = Object.freeze(['schemaVersion', 'referenceIds'] as const);
const SUCCESS_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'correlation',
  'items',
  'totalBytes',
] as const);
const FAILURE_KEYS = Object.freeze(['schemaVersion', 'kind', 'error', 'retryable'] as const);
const ITEM_KEYS = Object.freeze([
  'referenceId',
  'kind',
  'outcome',
  'occurredAtMonotonicMs',
  'attributes',
  'byteLength',
] as const);

const PARSE_FAILURE: HostedDiagnosticsParseResult<never> = Object.freeze({ ok: false });

function success<T>(value: T): HostedDiagnosticsParseResult<T> {
  return Object.freeze({ ok: true, value });
}

function snapshotBoundedDenseArray(value: unknown, maximumLength: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError('hosted-diagnostics-array-invalid');

  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor?.value;
    if (
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maximumLength
    ) {
      throw new TypeError('hosted-diagnostics-array-invalid');
    }

    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1) throw new TypeError('hosted-diagnostics-array-invalid');

    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) {
        throw new TypeError('hosted-diagnostics-array-invalid');
      }
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch {
    throw new TypeError('hosted-diagnostics-array-invalid');
  }
}

export function parseHostedDiagnosticsRequest(
  value: unknown
): HostedDiagnosticsParseResult<HostedDiagnosticsRequest> {
  try {
    const input = snapshotExactDataRecord(
      value,
      REQUEST_KEYS,
      'hosted-diagnostics-request-invalid'
    );
    if (input.schemaVersion !== HOSTED_DIAGNOSTICS_SCHEMA_VERSION) return PARSE_FAILURE;

    const referenceIds = snapshotBoundedDenseArray(
      input.referenceIds,
      HOSTED_DIAGNOSTICS_MAX_REFERENCES
    ).map(parseOperationalReferenceId);
    if (new Set(referenceIds).size !== referenceIds.length) return PARSE_FAILURE;

    return success(
      Object.freeze({
        schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
        referenceIds: Object.freeze(referenceIds),
      })
    );
  } catch {
    return PARSE_FAILURE;
  }
}

function parseSafeAttributes(value: unknown): SafeOperationAttributes {
  const input = snapshotExactDataRecord(value, [], 'hosted-diagnostics-attributes-invalid', {
    optionalKeys: SAFE_OPERATION_ATTRIBUTE_KEYS,
  });
  const attributes: Partial<Record<SafeOperationAttributeKey, string>> = {};

  for (const key of SAFE_OPERATION_ATTRIBUTE_KEYS) {
    if (!Object.hasOwn(input, key)) continue;
    const candidate = input[key];
    if (
      typeof candidate !== 'string' ||
      (candidate !== REDACTED_OPERATION_ATTRIBUTE_VALUE &&
        !SAFE_OPERATION_ATTRIBUTE_VALUES[key].some((allowed) => allowed === candidate))
    ) {
      throw new TypeError('hosted-diagnostics-attributes-invalid');
    }
    attributes[key] = candidate;
  }

  return Object.freeze(attributes) as SafeOperationAttributes;
}

function parseItem(value: unknown): HostedDiagnosticItem {
  const input = snapshotExactDataRecord(value, ITEM_KEYS, 'hosted-diagnostics-item-invalid');
  const kind = input.kind;
  const outcome = input.outcome;
  const occurredAtMonotonicMs = input.occurredAtMonotonicMs;
  const byteLength = input.byteLength;

  if (
    !OPERATION_EVENT_KINDS.includes(kind as OperationEventKind) ||
    !OPERATION_OUTCOMES.includes(outcome as OperationOutcome) ||
    !Number.isSafeInteger(occurredAtMonotonicMs) ||
    (occurredAtMonotonicMs as number) < 0 ||
    !Number.isSafeInteger(byteLength) ||
    (byteLength as number) < 0 ||
    (byteLength as number) > HOSTED_DIAGNOSTICS_MAX_BYTES_PER_REFERENCE
  ) {
    throw new TypeError('hosted-diagnostics-item-invalid');
  }

  return Object.freeze({
    referenceId: parseOperationalReferenceId(input.referenceId),
    kind: kind as OperationEventKind,
    outcome: outcome as OperationOutcome,
    occurredAtMonotonicMs: occurredAtMonotonicMs as number,
    attributes: parseSafeAttributes(input.attributes),
    byteLength: byteLength as number,
  });
}

function parseCorrelation(value: unknown): HostedDiagnosticsSuccess['correlation'] {
  const input = snapshotExactDataRecord(
    value,
    ['requestId', 'diagnosticId'],
    'hosted-diagnostics-correlation-invalid'
  );
  const correlation = createOperationCorrelationContext(input);
  if (correlation.diagnosticId === undefined) {
    throw new TypeError('hosted-diagnostics-correlation-invalid');
  }
  return correlation as HostedDiagnosticsSuccess['correlation'];
}

function parseSuccessResponse(input: Readonly<Record<string, unknown>>): HostedDiagnosticsSuccess {
  const items = snapshotBoundedDenseArray(input.items, HOSTED_DIAGNOSTICS_MAX_REFERENCES).map(
    parseItem
  );
  if (new Set(items.map(({ referenceId }) => referenceId)).size !== items.length) {
    throw new TypeError('hosted-diagnostics-response-invalid');
  }

  let totalBytes = 0;
  for (const item of items) {
    if (item.byteLength > HOSTED_DIAGNOSTICS_MAX_TOTAL_BYTES - totalBytes) {
      throw new TypeError('hosted-diagnostics-response-invalid');
    }
    totalBytes += item.byteLength;
  }
  if (input.totalBytes !== totalBytes) {
    throw new TypeError('hosted-diagnostics-response-invalid');
  }

  return Object.freeze({
    schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
    kind: 'success',
    correlation: parseCorrelation(input.correlation),
    items: Object.freeze(items),
    totalBytes,
  });
}

function errorPropertiesFor(reason: HostedDiagnosticsErrorReason): {
  readonly code: SafeAppError['code'];
  readonly retryable: boolean;
} {
  switch (reason) {
    case 'request_invalid':
    case 'reference_budget_exceeded':
      return { code: 'invalid_request', retryable: false };
    case 'request_cancelled':
      return { code: 'cancelled', retryable: false };
    case 'diagnostics_unavailable':
    case 'transport_unavailable':
      return { code: 'unavailable', retryable: true };
    case 'response_invalid':
      return { code: 'internal', retryable: false };
  }
}

export function createHostedDiagnosticsFailure(
  reason: HostedDiagnosticsErrorReason,
  diagnosticId?: DiagnosticId
): HostedDiagnosticsFailure {
  if (!HOSTED_DIAGNOSTICS_ERROR_REASONS.includes(reason)) {
    throw new TypeError('hosted-diagnostics-error-reason-invalid');
  }
  const properties = errorPropertiesFor(reason);
  const parsedDiagnosticId =
    diagnosticId === undefined ? undefined : parseDiagnosticId(diagnosticId);
  const error = createSafeAppError({
    code: properties.code,
    reason,
    ...(parsedDiagnosticId === undefined ? {} : { diagnosticId: parsedDiagnosticId }),
  });
  return Object.freeze({
    schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
    kind: 'error',
    error: error as HostedDiagnosticsFailure['error'],
    retryable: properties.retryable,
  });
}

function parseFailureResponse(input: Readonly<Record<string, unknown>>): HostedDiagnosticsFailure {
  const errorInput = snapshotExactDataRecord(
    input.error,
    ['code', 'reason'],
    'hosted-diagnostics-error-invalid',
    { optionalKeys: ['diagnosticId'] }
  );
  const reason = errorInput.reason;
  if (
    typeof reason !== 'string' ||
    !HOSTED_DIAGNOSTICS_ERROR_REASONS.includes(reason as HostedDiagnosticsErrorReason)
  ) {
    throw new TypeError('hosted-diagnostics-error-invalid');
  }
  const parsed = createHostedDiagnosticsFailure(
    reason as HostedDiagnosticsErrorReason,
    errorInput.diagnosticId === undefined ? undefined : parseDiagnosticId(errorInput.diagnosticId)
  );
  if (input.retryable !== parsed.retryable || errorInput.code !== parsed.error.code) {
    throw new TypeError('hosted-diagnostics-error-invalid');
  }
  return parsed;
}

export function parseHostedDiagnosticsResponse(
  value: unknown
): HostedDiagnosticsParseResult<HostedDiagnosticsResponse> {
  try {
    const discriminant = snapshotExactDataRecord(
      value,
      ['schemaVersion', 'kind'],
      'hosted-diagnostics-response-invalid',
      { optionalKeys: ['correlation', 'items', 'totalBytes', 'error', 'retryable'] }
    );
    if (discriminant.schemaVersion !== HOSTED_DIAGNOSTICS_SCHEMA_VERSION) return PARSE_FAILURE;
    if (discriminant.kind === 'success') {
      return success(
        parseSuccessResponse(
          snapshotExactDataRecord(value, SUCCESS_KEYS, 'hosted-diagnostics-response-invalid')
        )
      );
    }
    if (discriminant.kind === 'error') {
      return success(
        parseFailureResponse(
          snapshotExactDataRecord(value, FAILURE_KEYS, 'hosted-diagnostics-response-invalid')
        )
      );
    }
    return PARSE_FAILURE;
  } catch {
    return PARSE_FAILURE;
  }
}
