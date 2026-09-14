import { createHash } from 'node:crypto';

// Exact pure algorithms from ../contracts.ts. Importing that module at runtime reads
// a schema relative to process.cwd(), which cannot work inside the private supervisor
// namespace. Shared files are outside this writer's scope. Tests compare these bytes
// with the existing Product implementation; this is not a different canonical codec.
export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('p3c_non_canonical_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError('p3c_non_json_value');
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}
export function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`p3c_${label}`);
  const item = value as Record<string, unknown>, actual = Object.keys(item).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new TypeError(`p3c_${label}_keys`);
  return item;
}
