import { createHash } from 'node:crypto';

export function canonicalManagementValue(value: unknown): string {
  const canonical = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonical);
    if (entry && typeof entry === 'object')
      return Object.fromEntries(
        Object.entries(entry)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, canonical(item)])
      );
    return entry;
  };
  const serialized = JSON.stringify(canonical(value));
  if (typeof serialized !== 'string') throw new TypeError('Unsupported management value');
  return serialized;
}

/** Compare private captured values without creating a fingerprint of their credentials. */
export function managementValuesEqual(left: unknown, right: unknown): boolean {
  return canonicalManagementValue(left) === canonicalManagementValue(right);
}

/** Stable matching for private management intents. Raw auth inputs are never journaled. */
export function managementDigest(value: unknown): string {
  return createHash('sha256').update(canonicalManagementValue(value)).digest('hex');
}
