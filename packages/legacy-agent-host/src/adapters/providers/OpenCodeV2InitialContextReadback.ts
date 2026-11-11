import { types as nodeUtilTypes } from 'node:util';

type NativeInitialContextReadback = Readonly<{
  nativeSessionId: string;
  contextDigest: string;
  generation: string;
  configRevision: string;
}>;

/**
 * Capture the native instruction acknowledgement without running accessors.
 * A mutable getter can replace a foreign digest with the expected one during
 * Host admission even though the native context was never attested.
 * This is a JSON shape guard, not proof that a real V2 engine applied context.
 */
export function snapshotOpenCodeV2InitialContextReadback(
  receipt: NativeInitialContextReadback | undefined,
): NativeInitialContextReadback | undefined {
  try {
    if (!receipt || typeof receipt !== 'object' || nodeUtilTypes.isProxy(receipt))
      return undefined;
    const prototype = Object.getPrototypeOf(receipt);
    if ((prototype !== Object.prototype && prototype !== null) ||
        Reflect.ownKeys(receipt).length !== 4)
      return undefined;
    const keys = ['nativeSessionId', 'contextDigest', 'generation', 'configRevision'] as const;
    const fields = keys.map(key => Object.getOwnPropertyDescriptor(receipt, key));
    if (fields.some(field => !field || !('value' in field) || !field.enumerable))
      return undefined;
    const values = fields.map(field => field!.value as unknown);
    if (values.some(value => typeof value !== 'string'))
      return undefined;
    return Object.freeze({
      nativeSessionId: values[0] as string,
      contextDigest: values[1] as string,
      generation: values[2] as string,
      configRevision: values[3] as string,
    });
  } catch {
    return undefined;
  }
}

/** Compare a JSON-safe native instruction receipt with the captured identity.
 * Reuse the same descriptor guard for the original PUT and each read-only GET. */
export function matchesOpenCodeV2InitialContextReadback(
  receipt: NativeInitialContextReadback | undefined,
  expected: NativeInitialContextReadback,
): boolean {
  const snapshot = snapshotOpenCodeV2InitialContextReadback(receipt);
  return snapshot !== undefined &&
    snapshot.nativeSessionId === expected.nativeSessionId &&
    snapshot.contextDigest === expected.contextDigest &&
    snapshot.generation === expected.generation &&
    snapshot.configRevision === expected.configRevision;
}
