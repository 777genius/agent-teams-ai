import {
  BoundedReferenceLoader,
  type OperationalReferenceId,
  type OperationalReferenceSourcePort,
  ReferenceLoadError,
} from '@features/hosted-operations';
import { describe, expect, it, vi } from 'vitest';

const referenceId = (digit: number): OperationalReferenceId =>
  `reference_${String(digit).repeat(32)}` as OperationalReferenceId;

const DEFAULT_BUDGET = {
  maxReferences: 4,
  maxBytesPerReference: 10,
  maxTotalBytes: 30,
  maxConcurrentLoads: 2,
} as const;

describe('BoundedReferenceLoader', () => {
  it('rejects reference-count overflow before calling the source', async () => {
    const load = vi.fn();
    const loader = new BoundedReferenceLoader({ load });

    await expect(
      loader.load({
        referenceIds: [referenceId(1), referenceId(2)],
        budget: { ...DEFAULT_BUDGET, maxReferences: 1 },
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({
      code: 'reference_count_exceeded',
      limit: 1,
      observed: 2,
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('bounds concurrent source work and preserves request ordering', async () => {
    let active = 0;
    let maxActive = 0;
    const source: OperationalReferenceSourcePort<string> = {
      async load(id) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return { value: `value-${id.slice(-1)}`, byteLength: 3 };
      },
    };
    const loader = new BoundedReferenceLoader(source);

    const result = await loader.load({
      referenceIds: [referenceId(3), referenceId(1), referenceId(2)],
      budget: DEFAULT_BUDGET,
      signal: new AbortController().signal,
    });

    expect(maxActive).toBe(2);
    expect(result.references.map(({ referenceId: id }) => id)).toEqual([
      referenceId(3),
      referenceId(1),
      referenceId(2),
    ]);
    expect(result.totalBytes).toBe(9);
  });

  it('stops scheduling after a per-reference budget failure', async () => {
    const load = vi.fn(async () => ({ value: 'oversized-content', byteLength: 11 }));
    const loader = new BoundedReferenceLoader({ load });

    await expect(
      loader.load({
        referenceIds: [referenceId(1), referenceId(2), referenceId(3)],
        budget: { ...DEFAULT_BUDGET, maxConcurrentLoads: 1 },
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({
      code: 'reference_item_bytes_exceeded',
      limit: 10,
      observed: 11,
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('fails when cumulative reference bytes exceed the total budget', async () => {
    const loader = new BoundedReferenceLoader({
      async load() {
        return { value: 'bounded', byteLength: 6 };
      },
    });

    await expect(
      loader.load({
        referenceIds: [referenceId(1), referenceId(2)],
        budget: { ...DEFAULT_BUDGET, maxTotalBytes: 10, maxConcurrentLoads: 1 },
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({
      code: 'reference_total_bytes_exceeded',
      limit: 10,
      observed: 12,
    });
  });

  it('rejects promptly and aborts in-flight work when the caller cancels', async () => {
    let sourceSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const loader = new BoundedReferenceLoader({
      load(_id, context) {
        sourceSignal = context.signal;
        markStarted?.();
        return new Promise<never>(() => undefined);
      },
    });
    const controller = new AbortController();
    const loading = loader.load({
      referenceIds: [referenceId(1)],
      budget: DEFAULT_BUDGET,
      signal: controller.signal,
    });

    await started;
    controller.abort();

    await expect(loading).rejects.toEqual(new ReferenceLoadError('reference_load_cancelled'));
    expect(sourceSignal?.aborted).toBe(true);
  });
});
