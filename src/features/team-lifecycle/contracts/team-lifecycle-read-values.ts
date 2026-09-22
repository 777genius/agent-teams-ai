export const TEAM_LIFECYCLE_STATES = Object.freeze([
  'draft',
  'ready',
  'running',
  'degraded',
  'stopped',
  'deleted',
] as const);

export type TeamLifecycleState = (typeof TEAM_LIFECYCLE_STATES)[number];

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

export type TeamLifecycleInapplicableCode = 'not_applicable' | 'unsupported';
export type TeamLifecycleInapplicableReason =
  | 'list_not_found_inapplicable'
  | 'unknown_lifecycle_provisioning';

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
import type { SafeAppError } from '@shared/contracts/hosted';
