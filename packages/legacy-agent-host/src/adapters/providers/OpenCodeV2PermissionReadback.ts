import { types as nodeUtilTypes } from 'node:util';

type NativePermissionReadback = Readonly<{
  nativeSessionId: string;
  pid: number;
  startIdentity: string;
  rules: unknown;
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
    if ((prototype !== Object.prototype && prototype !== null) ||
        Reflect.ownKeys(receipt).length !== 4)
      return undefined;
    const keys = ['nativeSessionId', 'pid', 'startIdentity', 'rules'] as const;
    const fields = keys.map(key => Object.getOwnPropertyDescriptor(receipt, key));
    if (fields.some(field => !field || !('value' in field) || !field.enumerable))
      return undefined;
    return Object.freeze({
      nativeSessionId: fields[0]!.value as string,
      pid: fields[1]!.value as number,
      startIdentity: fields[2]!.value as string,
      rules: fields[3]!.value as unknown,
    });
  } catch {
    return undefined;
  }
}
