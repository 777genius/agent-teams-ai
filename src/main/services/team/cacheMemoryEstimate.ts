export function estimateCachedValueBytes(value: unknown, seen = new WeakSet<object>()): number {
  if (typeof value === 'string') {
    return value.length * 2;
  }
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return 8;
  }
  if (typeof value !== 'object') {
    return 0;
  }
  if (seen.has(value)) {
    return 0;
  }
  seen.add(value);

  let bytes = Array.isArray(value) ? value.length * 8 : 64;
  for (const nested of Object.values(value)) {
    bytes += estimateCachedValueBytes(nested, seen);
  }
  return bytes;
}
