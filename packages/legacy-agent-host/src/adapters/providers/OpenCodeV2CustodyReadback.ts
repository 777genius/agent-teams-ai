import { types as nodeUtilTypes } from 'node:util';

type NativeCustodyReadback = Readonly<{
  executablePath: string;
  executableSha256: string;
  pid: number;
  startIdentity: string;
  version: string;
}>;

/**
 * Capture the actual native process identity as stable JSON data. A getter
 * could replace an unqualified executable digest/PID before Host reads the
 * next field, falsely admitting another engine. This is only a readback
 * guard; physical PID/start identity and binary custody need native proof.
 */
export function snapshotOpenCodeV2CustodyReadback(
  receipt: NativeCustodyReadback | undefined
): NativeCustodyReadback | undefined {
  try {
    if (!receipt || typeof receipt !== 'object' || nodeUtilTypes.isProxy(receipt))
      return undefined;
    const prototype = Object.getPrototypeOf(receipt);
    if ((prototype !== Object.prototype && prototype !== null) ||
        Reflect.ownKeys(receipt).length !== 5)
      return undefined;
    const keys = ['executablePath', 'executableSha256', 'pid', 'startIdentity', 'version'] as const;
    const fields = keys.map(key => Object.getOwnPropertyDescriptor(receipt, key));
    if (fields.some(field => !field || !('value' in field) || !field.enumerable))
      return undefined;
    return Object.freeze({
      executablePath: fields[0]!.value as string,
      executableSha256: fields[1]!.value as string,
      pid: fields[2]!.value as number,
      startIdentity: fields[3]!.value as string,
      version: fields[4]!.value as string,
    });
  } catch {
    return undefined;
  }
}
