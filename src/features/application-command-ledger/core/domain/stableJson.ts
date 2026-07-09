function normalizeForStableJson(value: unknown, seen: WeakSet<object>): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return Number.isNaN(value) ? null : value;
  }

  if (typeof value === 'bigint') {
    throw new TypeError('Cannot stable-json serialize bigint values');
  }

  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return null;
  }

  if (value instanceof Date) {
    return value.toJSON();
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new TypeError('Cannot stable-json serialize circular arrays');
    }
    seen.add(value);
    try {
      return value.map((item) => normalizeForStableJson(item, seen));
    } finally {
      seen.delete(value);
    }
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new TypeError('Cannot stable-json serialize circular objects');
    }
    seen.add(value);
    try {
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort(compareCodeUnit)) {
        const raw = (value as Record<string, unknown>)[key];
        if (raw === undefined || typeof raw === 'function' || typeof raw === 'symbol') {
          continue;
        }
        normalized[key] = normalizeForStableJson(raw, seen);
      }
      return normalized;
    } finally {
      seen.delete(value);
    }
  }

  return null;
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value, new WeakSet<object>()));
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
