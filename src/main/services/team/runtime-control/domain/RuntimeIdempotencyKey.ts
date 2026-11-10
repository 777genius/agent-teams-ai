export function canonicalizeRuntimeIdempotencyKey(
  value: unknown,
  options: {
    fieldName?: string;
    errorPrefix?: string;
  } = {}
): string {
  const fieldName = options.fieldName ?? 'idempotencyKey';
  const errorPrefix = options.errorPrefix ?? 'Runtime idempotency key';
  if (typeof value !== 'string') {
    throw new Error(`${errorPrefix} missing ${fieldName}`);
  }
  const canonical = value.trim();
  if (!canonical) {
    throw new Error(`${errorPrefix} missing ${fieldName}`);
  }
  return canonical;
}
