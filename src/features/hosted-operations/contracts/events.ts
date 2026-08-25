import type { OperationCorrelationContext } from './correlation';

export const OPERATION_EVENT_KINDS = Object.freeze([
  'http_request',
  'sse_connection',
  'run_operation',
  'team_operation',
  'reference_load',
  'retention',
] as const);

export type OperationEventKind = (typeof OPERATION_EVENT_KINDS)[number];

export const OPERATION_OUTCOMES = Object.freeze([
  'started',
  'succeeded',
  'failed',
  'cancelled',
  'rejected',
] as const);

export type OperationOutcome = (typeof OPERATION_OUTCOMES)[number];

export const SAFE_OPERATION_ATTRIBUTE_KEYS = Object.freeze([
  'component',
  'operation',
  'reason',
  'state',
] as const);

export type SafeOperationAttributeKey = (typeof SAFE_OPERATION_ATTRIBUTE_KEYS)[number];

export const SAFE_OPERATION_ATTRIBUTE_VALUES = Object.freeze({
  component: Object.freeze([
    'http_server',
    'operations_kernel',
    'reference_loader',
    'retention_policy',
    'run_controller',
    'sse_stream',
    'team_controller',
  ] as const),
  operation: Object.freeze([
    'connect',
    'disconnect',
    'launch',
    'load',
    'prune',
    'publish',
    'replay',
    'request',
    'snapshot',
    'start',
    'stop',
  ] as const),
  reason: Object.freeze([
    'budget_exceeded',
    'cancelled',
    'deadline_exceeded',
    'invalid_input',
    'source_failed',
    'unavailable',
  ] as const),
  state: Object.freeze(['active', 'closed', 'degraded', 'idle', 'ready'] as const),
});

export const REDACTED_OPERATION_ATTRIBUTE_VALUE = 'redacted' as const;

export interface SafeOperationAttributes {
  readonly component?:
    | (typeof SAFE_OPERATION_ATTRIBUTE_VALUES.component)[number]
    | typeof REDACTED_OPERATION_ATTRIBUTE_VALUE;
  readonly operation?:
    | (typeof SAFE_OPERATION_ATTRIBUTE_VALUES.operation)[number]
    | typeof REDACTED_OPERATION_ATTRIBUTE_VALUE;
  readonly reason?:
    | (typeof SAFE_OPERATION_ATTRIBUTE_VALUES.reason)[number]
    | typeof REDACTED_OPERATION_ATTRIBUTE_VALUE;
  readonly state?:
    | (typeof SAFE_OPERATION_ATTRIBUTE_VALUES.state)[number]
    | typeof REDACTED_OPERATION_ATTRIBUTE_VALUE;
}

export const OPERATIONS_EVENT_SCHEMA_VERSION = 1 as const;

export interface SafeOperationsEvent {
  readonly schemaVersion: typeof OPERATIONS_EVENT_SCHEMA_VERSION;
  readonly kind: OperationEventKind;
  readonly outcome: OperationOutcome;
  /** Monotonic process-relative time, never a wall-clock or user-provided timestamp. */
  readonly occurredAtMonotonicMs: number;
  readonly correlation: OperationCorrelationContext;
  readonly attributes: SafeOperationAttributes;
}
