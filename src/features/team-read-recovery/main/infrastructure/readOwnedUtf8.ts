import { FileReadTimeoutError } from '@main/utils/fsRead';

import { normalizePhysicalFault } from '../../core/application/physicalFault';

import { type DescriptorAcquisition, type OwnedReadDescriptors } from './OwnedReadDescriptors';

import type { RawReadTask } from '../../core/application/PhysicalReadScope';

export interface OwnedUtf8ReadOptions {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly headOnly?: boolean;
}

/** Retains physical acquisition and close after an early logical timeout. */
export function readOwnedUtf8(
  path: string,
  options: OwnedUtf8ReadOptions,
  owner: OwnedReadDescriptors
): RawReadTask<string> {
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 0 ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs < 0 ||
    options.timeoutMs > 2_147_483_647
  ) {
    throw new Error('Invalid owned read limits');
  }
  const { maxBytes, timeoutMs, headOnly } = options;
  let acquisition: DescriptorAcquisition | undefined;
  let settleResult!: (value: string) => void;
  let failResult!: (error: unknown) => void;
  let settlePhysical!: (outcome: Awaited<ReturnType<typeof owner.retire>>) => void;
  let timedOut = false;
  const chunks: Uint8Array[] = [];
  let text: string | undefined;
  const result = new Promise<string>((resolve, reject) => {
    settleResult = resolve;
    failResult = reject;
  });
  void result.catch(() => undefined);
  const physical = new Promise<Awaited<ReturnType<typeof owner.retire>>>((resolve) => {
    settlePhysical = resolve;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    chunks.length = 0;
    text = undefined;
    failResult(new FileReadTimeoutError(path, timeoutMs));
    void acquisition?.close();
  }, timeoutMs);

  const run = async (): Promise<void> => {
    let total = 0;
    let failure: unknown;
    let failed = false;
    try {
      acquisition = owner.open(path);
      const descriptor = await acquisition.result;
      while (!timedOut) {
        if (headOnly && total === maxBytes) break;
        // One extra byte detects overflow rather than returning a silently truncated file.
        const bytes = Math.min(1024 * 1024, maxBytes - total + (headOnly ? 0 : 1));
        const chunk = await descriptor.read(total, bytes).result;
        if (timedOut || chunk.byteLength === 0) break;
        total += chunk.byteLength;
        if (total > maxBytes) throw new Error('Owned UTF-8 read exceeds byte limit');
        chunks.push(chunk);
      }
      if (!timedOut) text = Buffer.concat(chunks, total).toString('utf8');
      chunks.length = 0;
    } catch (error) {
      failure = error;
      failed = true;
    } finally {
      const outcome = acquisition
        ? await acquisition.close()
        : { kind: 'unknown' as const, fault: 'Acquisition did not return its physical port' };
      clearTimeout(timer);
      // No new scheduling or payload publication after the timer's early result.
      if (!timedOut) {
        if (failed) failResult(failure);
        else if (outcome.kind === 'unknown') failResult(new Error(outcome.fault));
        else settleResult(text ?? '');
      }
      settlePhysical(outcome);
    }
  };
  void run().catch((error: unknown) => {
    clearTimeout(timer);
    failResult(error);
    settlePhysical({
      kind: 'unknown',
      fault: normalizePhysicalFault(error),
    });
  });
  return { result, physical };
}
