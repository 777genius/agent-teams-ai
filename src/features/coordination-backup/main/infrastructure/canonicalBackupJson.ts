const OBJECT_PROTOTYPE = Object.prototype;

export class CanonicalBackupJsonError extends TypeError {
  constructor(readonly reason: string) {
    super(`coordination-backup-canonical-json-${reason}`);
    this.name = 'CanonicalBackupJsonError';
  }
}

/**
 * Serializes the JSON data model with object keys recursively ordered by UTF-16 code unit.
 * Values which JSON.stringify would silently discard or coerce are rejected instead.
 */
export function canonicalBackupJson(value: unknown): string {
  const ancestors = new Set<object>();
  return serialize(value, ancestors);
}

export function canonicalBackupJsonBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalBackupJson(value), 'utf8');
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalBackupJsonError('non-finite-number');
      return JSON.stringify(value);
    case 'object':
      return serializeObject(value, ancestors);
    case 'bigint':
      throw new CanonicalBackupJsonError('bigint');
    case 'undefined':
      throw new CanonicalBackupJsonError('undefined');
    case 'function':
      throw new CanonicalBackupJsonError('function');
    case 'symbol':
      throw new CanonicalBackupJsonError('symbol');
  }
  throw new CanonicalBackupJsonError('unsupported-value');
}

function serializeObject(value: object, ancestors: Set<object>): string {
  if (ancestors.has(value)) throw new CanonicalBackupJsonError('cycle');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.some(
          (key) =>
            typeof key !== 'string' ||
            (key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
        )
      ) {
        throw new CanonicalBackupJsonError('array-property');
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!OBJECT_PROTOTYPE.hasOwnProperty.call(value, index)) {
          throw new CanonicalBackupJsonError('sparse-array');
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new CanonicalBackupJsonError('array-accessor');
        }
        items.push(serialize(value[index], ancestors));
      }
      return `[${items.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== OBJECT_PROTOTYPE && prototype !== null) {
      throw new CanonicalBackupJsonError('non-plain-object');
    }

    const record = value as Record<string, unknown>;
    const ownKeys = Reflect.ownKeys(record);
    if (ownKeys.some((key) => typeof key !== 'string')) {
      throw new CanonicalBackupJsonError('symbol-key');
    }
    const keys = Object.keys(record).sort();
    if (ownKeys.length !== keys.length) {
      throw new CanonicalBackupJsonError('non-enumerable-property');
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new CanonicalBackupJsonError('object-accessor');
      }
    }
    const properties = keys.map(
      (key) => `${JSON.stringify(key)}:${serialize(record[key], ancestors)}`
    );
    return `{${properties.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}
