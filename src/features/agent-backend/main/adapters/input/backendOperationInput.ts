export class InvalidBackendOperation extends Error {
  constructor() {
    super('Invalid backend operation');
  }
}

export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new InvalidBackendOperation();
  return value as Record<string, unknown>;
}

export function text(value: unknown, max = 256): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    value.includes('\0')
  ) {
    throw new InvalidBackendOperation();
  }
  return value;
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new InvalidBackendOperation();
  return value.map((entry) => text(entry));
}
