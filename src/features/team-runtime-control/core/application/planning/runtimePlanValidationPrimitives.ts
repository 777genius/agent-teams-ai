import {
  RUNTIME_TOPOLOGY_MODES,
  type RuntimePlanMemberBinding,
  type RuntimeTopologyMode,
  type Sha256Hash,
} from '../../../contracts';

import {
  type CompositeRuntimePlanErrorCode,
  CompositeRuntimePlanValidationError,
} from './CompositeRuntimePlanValidationError';

type TeamProviderId = RuntimePlanMemberBinding['providerId'];

const TEAM_PROVIDER_IDS = Object.freeze([
  'anthropic',
  'codex',
  'gemini',
  'opencode',
] as const satisfies readonly TeamProviderId[]);
const SHA256_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function validateTopologyMode(value: unknown): RuntimeTopologyMode {
  if (!(RUNTIME_TOPOLOGY_MODES as readonly unknown[]).includes(value)) {
    fail('unsupported_topology', 'runtime-plan-topology-mode-unsupported');
  }
  return value as RuntimeTopologyMode;
}

export function validateProvider(value: unknown, field: string): asserts value is TeamProviderId {
  if (!(TEAM_PROVIDER_IDS as readonly unknown[]).includes(value)) {
    fail('invalid_field', `runtime-plan-${field}-invalid`);
  }
}

export function validateSha256Hash(value: unknown, field: string): Sha256Hash {
  if (typeof value !== 'string' || !SHA256_HASH_PATTERN.test(value)) {
    fail('invalid_field', `runtime-plan-${field}-invalid`);
  }
  return value as Sha256Hash;
}

export function validatePositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail('invalid_field', `runtime-plan-${field}-invalid`);
  }
}

export function validateDenseArray(
  value: unknown,
  field: string
): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    fail('invalid_field', `runtime-plan-${field}-invalid`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      fail('unstable_ordering', `runtime-plan-${field}-sparse`);
    }
  }
}

export function validateDenseNonEmptyArray(
  value: unknown,
  field: string
): asserts value is readonly unknown[] {
  validateDenseArray(value, field);
  if (value.length === 0) {
    fail('invalid_field', `runtime-plan-${field}-empty`);
  }
}

export function validateIdentifier(run: () => unknown, field: string): void {
  try {
    run();
  } catch {
    fail('invalid_field', `runtime-plan-${field}-invalid`);
  }
}

export function validateIdentifierValue<T>(run: () => T, field: string): T {
  try {
    return run();
  } catch {
    fail('invalid_field', `runtime-plan-${field}-invalid`);
  }
}

export function foldLegacyMemberKey(value: string): string {
  return value.toLowerCase();
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertPlainRecord(
  value: unknown,
  field: string
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    fail('invalid_field', `runtime-plan-${field}-record-invalid`);
  }
}

export function assertExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
  code: CompositeRuntimePlanErrorCode = 'invalid_field'
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    fail(code, `runtime-plan-${field}-record-invalid`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (!sameStringArray(actual, expected)) {
    fail(code, `runtime-plan-${field}-shape-invalid`);
  }
}

export function assertAllowedRecordKeys(
  value: unknown,
  allowedKeys: readonly string[],
  field: string
): asserts value is Record<string, unknown> {
  assertPlainRecord(value, field);
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail('lane_plan_mismatch', `runtime-plan-${field}-shape-invalid`);
  }
}

export function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function fail(code: CompositeRuntimePlanErrorCode, message: string): never {
  throw new CompositeRuntimePlanValidationError(code, message);
}
