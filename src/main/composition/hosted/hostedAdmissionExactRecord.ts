export function readHostedAdmissionExactRecord(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('hosted-lifecycle-owner-admission-record-invalid');
  }
  const source = value as Record<string, unknown>;
  const actualKeys = Reflect.ownKeys(source);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(source, key))
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-record-invalid');
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new TypeError('hosted-lifecycle-owner-admission-record-invalid');
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}
