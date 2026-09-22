import {
  REDACTED_OPERATION_ATTRIBUTE_VALUE,
  SAFE_OPERATION_ATTRIBUTE_KEYS,
  SAFE_OPERATION_ATTRIBUTE_VALUES,
  type SafeOperationAttributeKey,
  type SafeOperationAttributes,
} from '../../contracts';

export const REDACTED_OPERATION_ATTRIBUTE = REDACTED_OPERATION_ATTRIBUTE_VALUE;

function isSafeAttributeKey(value: string): value is SafeOperationAttributeKey {
  return SAFE_OPERATION_ATTRIBUTE_KEYS.includes(value as SafeOperationAttributeKey);
}

function isSafeAttributeValue(key: SafeOperationAttributeKey, value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SAFE_OPERATION_ATTRIBUTE_VALUES[key].some((candidate) => candidate === value)
  );
}

/**
 * Keeps only a fixed operational allowlist. Values that are not short machine tokens are replaced
 * wholesale, so prompts, message bodies, filesystem paths, credentials, and error text cannot be
 * recovered from a structured event.
 */
export function redactOperationAttributes(value: unknown): SafeOperationAttributes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return Object.freeze({});
  }

  const redacted: Partial<Record<SafeOperationAttributeKey, string>> = {};
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return Object.freeze({});
  }

  for (const key of keys) {
    if (typeof key !== 'string' || !isSafeAttributeKey(key)) continue;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) continue;
      const candidate = descriptor.value;
      redacted[key] = isSafeAttributeValue(key, candidate)
        ? candidate
        : REDACTED_OPERATION_ATTRIBUTE;
    } catch {
      // Proxy/accessor failures are untrusted detail, so they are omitted rather than surfaced.
    }
  }

  return Object.freeze(redacted) as SafeOperationAttributes;
}
