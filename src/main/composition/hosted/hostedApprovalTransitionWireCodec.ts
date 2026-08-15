import { isAbsolute, normalize } from 'node:path';

export const HEX = /^[0-9a-f]{64}$/u;
export const PREFIXED_HEX = /^sha256:[0-9a-f]{64}$/u;
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
export const PLAN_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const TEAM_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
export const DEPLOYMENT_ID = /^deployment_[A-Za-z0-9][A-Za-z0-9._-]{0,116}$/u;
export const TEAM_ID = /^team_[0-9a-f]{32}$/u;
export const RUN_ID = /^run_[0-9a-f]{32}$/u;
export const MEMBER_ID = /^member_[0-9a-f]{32}$/u;
export const ACTOR_ID = /^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/u;
export const AUTHORITY_GENERATION = /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/u;
export const OWNER_AUTHORITY = /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
export const OWNER_SESSION = /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
export const RUNTIME_INSTANCE = /^runtime_instance_[0-9a-f]{32}$/u;
export const CONFIG_GENERATION = /^config_generation_[0-9a-f]{32}$/u;
export const TRANSITION_ID = /^approval-transition_[0-9a-f]{32}$/u;
export const LEASE_ID = /^approval-transition-lease_[0-9a-f]{32}$/u;
export const PROCESS_START = /^start_[0-9a-f]{64}$/u;
export const DECIMAL_IDENTITY = /^(?:0|[1-9]\d{0,31})$/u;

const SAFE_MAX = Number.MAX_SAFE_INTEGER;

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => typeof key === 'string' && key === expected[index])
  );
}

export function integer(value: unknown, minimum = 0, maximum = SAFE_MAX): value is number {
  return (
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    (value as number) >= minimum &&
    (value as number) <= maximum
  );
}

function hasUnpairedSurrogate(value: string): boolean {
  let index = 0;
  while (index < value.length) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 2;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
    else index += 1;
  }
  return false;
}

export function scalarString(
  value: unknown,
  pattern: RegExp,
  maximumCharacters = Number.POSITIVE_INFINITY
): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maximumCharacters &&
    pattern.test(value) &&
    !hasUnpairedSurrogate(value)
  );
}

export function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalDictionary(
  value: unknown,
  keyPattern: RegExp,
  valuePattern: RegExp
): value is Record<string, string> {
  if (!record(value)) return false;
  const keys = Object.keys(value).sort(compareUtf16);
  if (keys.length < 1 || keys.length > 256 || keys.some((key) => !scalarString(key, keyPattern)))
    return false;
  const values = keys.map((key) => value[key]);
  return (
    values.every((item) => scalarString(item, valuePattern)) &&
    new Set(values).size === values.length
  );
}

export function canonicalJson(value: unknown, dictionary = false): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (!record(value)) {
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    )
      throw new TypeError('hosted-approval-transition-value-not-json');
    return JSON.stringify(value);
  }
  const keys = Object.keys(value);
  if (dictionary) keys.sort(compareUtf16);
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(
          value[key],
          key === 'memberIdsByName' || key === 'actorMembers'
        )}`
    )
    .join(',')}}`;
}

export function validSocketPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    isAbsolute(value) &&
    normalize(value) === value &&
    !value.includes('\0') &&
    !hasUnpairedSurrogate(value) &&
    Buffer.byteLength(value, 'utf8') >= 1 &&
    Buffer.byteLength(value, 'utf8') <= 103
  );
}
