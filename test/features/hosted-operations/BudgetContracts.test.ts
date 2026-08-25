import { createReferenceLoadBudget, createRetentionBudget } from '@features/hosted-operations';
import { describe, expect, it } from 'vitest';

const BUDGET_SECRET = ['sk', 'budget', 'secret'].join('-');

describe('hosted operations budget contracts', () => {
  it('returns immutable retention values from one exact data snapshot', () => {
    const input = { maxEntries: 2, maxAgeMs: 100, maxTotalBytes: 20 };
    const budget = createRetentionBudget(input);

    input.maxEntries = 100;
    input.maxAgeMs = 0;
    input.maxTotalBytes = 0;

    expect(budget).toEqual({ maxEntries: 2, maxAgeMs: 100, maxTotalBytes: 20 });
    expect(Object.isFrozen(budget)).toBe(true);
  });

  it('returns immutable reference-load values from one exact data snapshot', () => {
    const input = {
      maxReferences: 2,
      maxBytesPerReference: 10,
      maxTotalBytes: 20,
      maxConcurrentLoads: 1,
    };
    const budget = createReferenceLoadBudget(input);

    input.maxReferences = 100;
    input.maxConcurrentLoads = 100;

    expect(budget).toEqual({
      maxReferences: 2,
      maxBytesPerReference: 10,
      maxTotalBytes: 20,
      maxConcurrentLoads: 1,
    });
    expect(Object.isFrozen(budget)).toBe(true);
  });

  it.each([
    {
      create: createRetentionBudget,
      value: { maxEntries: 2, maxAgeMs: 100, maxTotalBytes: 20 },
      accessorKey: 'maxEntries',
    },
    {
      create: createReferenceLoadBudget,
      value: {
        maxReferences: 2,
        maxBytesPerReference: 10,
        maxTotalBytes: 20,
        maxConcurrentLoads: 1,
      },
      accessorKey: 'maxReferences',
    },
  ])('rejects accessor, proxy, and extra fields for $accessorKey budgets', (fixture) => {
    let getterReads = 0;
    const accessor = Object.defineProperty({ ...fixture.value }, fixture.accessorKey, {
      enumerable: true,
      get() {
        getterReads += 1;
        return 2;
      },
    });
    const extra = { ...fixture.value, secret: BUDGET_SECRET };
    const proxy = new Proxy({ ...fixture.value }, {});

    expect(() => fixture.create(accessor as never)).toThrow('hosted-operations-budget-invalid');
    expect(getterReads).toBe(0);
    expect(() => fixture.create(extra as never)).toThrow('hosted-operations-budget-invalid');
    expect(() => fixture.create(proxy as never)).toThrow('hosted-operations-budget-invalid');
  });
});
