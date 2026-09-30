export interface ExactDataSnapshotOptions {
  readonly optionalKeys?: readonly string[];
  readonly rejectProxy?: boolean;
}

function invalid(errorCode: string): TypeError {
  return new TypeError(errorCode);
}

/**
 * Copies each exact own data-property value once. Accessor getters are never invoked, and extra or
 * missing keys are rejected; callers validate and use only the returned frozen record.
 */
export function snapshotExactDataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  errorCode: string,
  options: ExactDataSnapshotOptions = {}
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(errorCode);
  }

  const optionalKeys = options.optionalKeys ?? [];
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);

  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalid(errorCode);

    const snapshot: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowedKeys.has(key)) throw invalid(errorCode);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw invalid(errorCode);
      snapshot[key] = descriptor.value;
    }
    if (requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(snapshot, key))) {
      throw invalid(errorCode);
    }

    if (options.rejectProxy) {
      // Budgets contain primitives only. A structured-clone probe therefore rejects Proxy input
      // without changing which descriptor values become the authoritative snapshot.
      structuredClone(value);
    }

    return Object.freeze(snapshot);
  } catch {
    throw invalid(errorCode);
  }
}

/** Copies a dense array through exact own data descriptors, never through index accessors. */
export function snapshotDenseDataArray(value: unknown, errorCode: string): readonly unknown[] {
  if (!Array.isArray(value)) throw invalid(errorCode);

  try {
    const descriptors = new Map<PropertyKey, PropertyDescriptor>();
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw invalid(errorCode);
      descriptors.set(key, descriptor);
    }

    const length = descriptors.get('length')?.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
      throw invalid(errorCode);
    }
    if (descriptors.size !== length + 1) throw invalid(errorCode);

    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors.get(String(index));
      if (!descriptor) throw invalid(errorCode);
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch {
    throw invalid(errorCode);
  }
}
