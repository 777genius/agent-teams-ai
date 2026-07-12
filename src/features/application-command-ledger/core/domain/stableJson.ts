export type ApplicationCommandJsonValue =
  | null
  | boolean
  | number
  | string
  | ApplicationCommandJsonValue[]
  | { [key: string]: ApplicationCommandJsonValue };

// eslint-disable-next-line sonarjs/function-return-type -- Canonicalization returns every JSON value shape.
function normalizeForStableJson(
  value: unknown,
  seen: WeakSet<object>
): ApplicationCommandJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Application command JSON numbers must be finite');
    }
    return value;
  }

  if (
    value === undefined ||
    typeof value === 'bigint' ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    throw new TypeError(`Cannot stable-json serialize ${typeof value} values`);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new TypeError('Cannot stable-json serialize circular arrays');
    }
    seen.add(value);
    try {
      const normalized: ApplicationCommandJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new TypeError('Cannot stable-json serialize sparse arrays');
        }
        normalized.push(normalizeForStableJson(value[index], seen));
      }
      return normalized;
    } finally {
      seen.delete(value);
    }
  }

  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      const typeName = value.constructor?.name ?? 'object';
      throw new TypeError(`Cannot stable-json serialize non-plain object: ${typeName}`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('Cannot stable-json serialize symbol-keyed properties');
    }
    if (seen.has(value)) {
      throw new TypeError('Cannot stable-json serialize circular objects');
    }
    seen.add(value);
    try {
      const normalized: Record<string, ApplicationCommandJsonValue> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort(compareCodeUnit)) {
        normalized[key] = normalizeForStableJson((value as Record<string, unknown>)[key], seen);
      }
      return normalized;
    } finally {
      seen.delete(value);
    }
  }

  throw new TypeError(`Cannot stable-json serialize ${typeof value} values`);
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value, new WeakSet<object>()));
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
