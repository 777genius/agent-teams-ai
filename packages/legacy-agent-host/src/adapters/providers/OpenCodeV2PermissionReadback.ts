import { types as nodeUtilTypes } from 'node:util';

export type NativePermissionReadback = Readonly<{
  nativeSessionId: string;
  directory: string;
  modelProviderId: string;
  modelId: string;
  modelVariant: string | null;
  pid: number;
  startIdentity: string;
  rules: unknown;
  /** Exact owned 2.1.4 native inventories, checked afresh before admission. */
  policyIsolation?: 'builtin-only-empty-saved';
}>;

/**
 * Snapshot the TEST owner's native permission envelope as JSON data, not
 * getters or a Proxy. Reading an identity getter could replace a later
 * ALLOW ruleset with DENY before Host validation. This does not replace
 * effective native permission enforcement or PID custody qualification.
 */
export function snapshotOpenCodeV2PermissionReadback(
  receipt: NativePermissionReadback | undefined
): NativePermissionReadback | undefined {
  try {
    if (!receipt || typeof receipt !== 'object' || nodeUtilTypes.isProxy(receipt))
      return undefined;
    const prototype = Object.getPrototypeOf(receipt);
    const ownKeys = Reflect.ownKeys(receipt);
    if ((prototype !== Object.prototype && prototype !== null) ||
        (ownKeys.length !== 8 && ownKeys.length !== 9))
      return undefined;
    const isolation = Object.getOwnPropertyDescriptor(receipt, 'policyIsolation');
    if (ownKeys.length === 9 && (!isolation || !('value' in isolation) ||
        !isolation.enumerable || isolation.value !== 'builtin-only-empty-saved')) return undefined;
    const keys = ['nativeSessionId', 'directory', 'modelProviderId', 'modelId',
      'modelVariant', 'pid', 'startIdentity', 'rules'] as const;
    const fields = keys.map(key => Object.getOwnPropertyDescriptor(receipt, key));
    if (fields.some(field => !field || !('value' in field) || !field.enumerable))
      return undefined;
    return Object.freeze({
      nativeSessionId: fields[0]!.value as string,
      directory: fields[1]!.value as string,
      modelProviderId: fields[2]!.value as string,
      modelId: fields[3]!.value as string,
      modelVariant: fields[4]!.value as string | null,
      pid: fields[5]!.value as number,
      startIdentity: fields[6]!.value as string,
      rules: fields[7]!.value as unknown,
      ...(isolation ? { policyIsolation: 'builtin-only-empty-saved' as const } : {}),
    });
  } catch {
    return undefined;
  }
}
