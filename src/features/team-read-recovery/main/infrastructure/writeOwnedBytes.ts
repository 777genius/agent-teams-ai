import { normalizePhysicalFault } from '../../core/application/physicalFault';

import { intrinsicByteLength } from './intrinsicByteLength';

import type { PhysicalOutcome, RawReadTask } from '../../core/application/PhysicalReadScope';
import type { DescriptorAcquisition, OwnedReadDescriptors } from './OwnedReadDescriptors';

export interface OwnedWriteOptions {
  readonly flags: number;
  readonly mode?: number;
  readonly maxBytes: number;
  readonly sync: boolean;
}

/** A captured write loop; publication/atomic rename and source authority belong to its caller. */
export function writeOwnedBytes(
  path: string,
  data: Uint8Array,
  options: OwnedWriteOptions,
  owner: OwnedReadDescriptors
): RawReadTask<void> {
  const { flags, mode, maxBytes, sync } = options;
  const byteLength = intrinsicByteLength(data);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || byteLength > maxBytes)
    throw new Error('Invalid owned write byte limit');
  if (typeof sync !== 'boolean') throw new Error('Invalid owned write sync policy');
  let payload: Buffer | undefined;
  let acquisition: DescriptorAcquisition | undefined;
  let resolveResult!: () => void;
  let rejectResult!: (error: unknown) => void;
  let resolvePhysical!: (outcome: PhysicalOutcome) => void;
  const result = new Promise<void>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  void result.catch(() => undefined);
  const physical = new Promise<PhysicalOutcome>((resolve) => {
    resolvePhysical = resolve;
  });

  const run = async (): Promise<void> => {
    let failure: unknown;
    let failed = false;
    try {
      acquisition = owner.open(path, flags, mode);
      // Admission precedes allocation; capture every chunk before the first await.
      payload = Buffer.copyBytesFrom(data, 0, byteLength);
      const descriptor = await acquisition.result;
      let position = 0;
      while (payload && position < payload.byteLength) {
        const chunk = payload.subarray(
          position,
          Math.min(payload.byteLength, position + 1024 * 1024)
        );
        const count = await descriptor.write(position, chunk).result;
        if (!Number.isSafeInteger(count) || count <= 0 || count > chunk.byteLength)
          throw new Error('Owned write did not make valid progress');
        position += count;
      }
      payload = undefined;
      if (sync) await descriptor.sync().result;
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      payload = undefined;
      const outcome = acquisition ? await acquisition.close() : { kind: 'closed' as const };
      if (failed) rejectResult(failure);
      else if (outcome.kind === 'unknown') rejectResult(new Error(outcome.fault));
      else resolveResult();
      resolvePhysical(outcome);
    }
  };
  void run().catch((error: unknown) => {
    payload = undefined;
    rejectResult(error);
    resolvePhysical({ kind: 'unknown', fault: normalizePhysicalFault(error) });
  });
  return { result, physical };
}
