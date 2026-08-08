import {
  createReferenceLoadBudget,
  type OperationalReferenceId,
  parseOperationalReferenceId,
  type ReferenceLoadBudget,
} from '../../contracts';
import { snapshotDenseDataArray, snapshotExactDataRecord } from '../../contracts/exactDataSnapshot';

import { ReferenceLoadError } from './errors';

import type { OperationalReferenceSourcePort, ReferenceSourceResult } from './ports';

export interface LoadedOperationalReference<T> extends ReferenceSourceResult<T> {
  readonly referenceId: OperationalReferenceId;
}

export interface BoundedReferenceLoadResult<T> {
  readonly references: readonly LoadedOperationalReference<T>[];
  readonly totalBytes: number;
}

export interface LoadOperationalReferencesInput {
  readonly referenceIds: readonly OperationalReferenceId[];
  readonly budget: ReferenceLoadBudget;
  readonly signal: AbortSignal;
}

function cancelled(): ReferenceLoadError {
  return new ReferenceLoadError('reference_load_cancelled');
}

function materializeSourceResult<T>(value: ReferenceSourceResult<T>): ReferenceSourceResult<T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReferenceLoadError('reference_source_result_invalid');
  }

  try {
    const byteLength = Object.getOwnPropertyDescriptor(value, 'byteLength');
    const resultValue = Object.getOwnPropertyDescriptor(value, 'value');
    if (
      !byteLength ||
      !('value' in byteLength) ||
      !Number.isSafeInteger(byteLength.value) ||
      (byteLength.value as number) < 0 ||
      !resultValue ||
      !('value' in resultValue)
    ) {
      throw new ReferenceLoadError('reference_source_result_invalid');
    }
    return Object.freeze({
      value: resultValue.value as T,
      byteLength: byteLength.value as number,
    });
  } catch (error) {
    throw error instanceof ReferenceLoadError
      ? error
      : new ReferenceLoadError('reference_source_result_invalid');
  }
}

/** Loads only budgeted references and never exposes reference values to event or metric ports. */
export class BoundedReferenceLoader<T> {
  constructor(private readonly source: OperationalReferenceSourcePort<T>) {}

  async load(input: LoadOperationalReferencesInput): Promise<BoundedReferenceLoadResult<T>> {
    const inputSnapshot = snapshotExactDataRecord(
      input,
      ['referenceIds', 'budget', 'signal'],
      'hosted-operations-reference-load-input-invalid'
    );
    const signal = inputSnapshot.signal;
    if (!(signal instanceof AbortSignal)) {
      throw new TypeError('hosted-operations-reference-load-input-invalid');
    }
    const budget = createReferenceLoadBudget(inputSnapshot.budget as ReferenceLoadBudget);
    const referenceIds = snapshotDenseDataArray(
      inputSnapshot.referenceIds,
      'hosted-operations-reference-load-input-invalid'
    ).map(parseOperationalReferenceId);
    if (referenceIds.length > budget.maxReferences) {
      throw new ReferenceLoadError(
        'reference_count_exceeded',
        budget.maxReferences,
        referenceIds.length
      );
    }

    if (signal.aborted) throw cancelled();
    if (referenceIds.length === 0) {
      return Object.freeze({ references: Object.freeze([]), totalBytes: 0 });
    }

    const controller = new AbortController();
    let terminalError: ReferenceLoadError | undefined;
    let rejectCancellation: ((error: ReferenceLoadError) => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const stop = (error: ReferenceLoadError): ReferenceLoadError => {
      terminalError ??= error;
      controller.abort();
      return terminalError;
    };
    const handleCancellation = (): void => {
      const error = stop(cancelled());
      rejectCancellation?.(error);
    };
    signal.addEventListener('abort', handleCancellation, { once: true });
    if (signal.aborted) handleCancellation();

    let nextIndex = 0;
    let totalBytes = 0;
    const results: LoadedOperationalReference<T>[] = new Array(referenceIds.length);

    const worker = async (): Promise<void> => {
      while (nextIndex < referenceIds.length) {
        if (terminalError) throw terminalError;
        const index = nextIndex;
        nextIndex += 1;
        const referenceId = referenceIds[index];

        let sourceResult: ReferenceSourceResult<T>;
        try {
          sourceResult = await this.source.load(referenceId, { signal: controller.signal });
        } catch {
          if (terminalError) throw stop(terminalError);
          if (signal.aborted) throw stop(cancelled());
          throw stop(new ReferenceLoadError('reference_source_failed'));
        }

        if (terminalError) throw stop(terminalError);
        let loaded: ReferenceSourceResult<T>;
        try {
          loaded = materializeSourceResult(sourceResult);
        } catch (error) {
          throw stop(
            error instanceof ReferenceLoadError
              ? error
              : new ReferenceLoadError('reference_source_result_invalid')
          );
        }
        if (loaded.byteLength > budget.maxBytesPerReference) {
          throw stop(
            new ReferenceLoadError(
              'reference_item_bytes_exceeded',
              budget.maxBytesPerReference,
              loaded.byteLength
            )
          );
        }
        if (loaded.byteLength > budget.maxTotalBytes - totalBytes) {
          throw stop(
            new ReferenceLoadError(
              'reference_total_bytes_exceeded',
              budget.maxTotalBytes,
              loaded.byteLength > Number.MAX_SAFE_INTEGER - totalBytes
                ? Number.MAX_SAFE_INTEGER
                : totalBytes + loaded.byteLength
            )
          );
        }

        totalBytes += loaded.byteLength;
        results[index] = Object.freeze({
          referenceId,
          value: loaded.value,
          byteLength: loaded.byteLength,
        });
      }
    };

    const workerCount = Math.min(budget.maxConcurrentLoads, referenceIds.length);
    const workers = Array.from({ length: workerCount }, worker);
    try {
      await Promise.race([Promise.all(workers), cancellation]);
    } finally {
      signal.removeEventListener('abort', handleCancellation);
    }

    return Object.freeze({
      references: Object.freeze(results),
      totalBytes,
    });
  }
}
