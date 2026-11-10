import { describe, expect, it, vi } from 'vitest';

import { createIpcWrapper } from '@main/ipc/ipcWrapper';

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('createIpcWrapper', () => {
  it('returns success result on successful handler', async () => {
    const wrap = createIpcWrapper('test');
    const result = await wrap('op', async () => 42);

    expect(result).toEqual({ success: true, data: 42 });
  });

  it('returns success with complex data', async () => {
    const wrap = createIpcWrapper('test');
    const data = { items: [1, 2, 3], meta: { count: 3 } };
    const result = await wrap('op', async () => data);

    expect(result).toEqual({ success: true, data });
  });

  it('returns error result when handler throws Error', async () => {
    const wrap = createIpcWrapper('test');
    const result = await wrap('op', async () => {
      throw new Error('Something went wrong');
    });

    expect(result).toEqual({
      success: false,
      error: 'Something went wrong',
    });
  });

  it('returns error result when handler throws non-Error', async () => {
    const wrap = createIpcWrapper('test');
    const result = await wrap('op', async () => {
      throw 'string error';
    });

    expect(result).toEqual({
      success: false,
      error: 'string error',
    });
  });

  it('handles void return', async () => {
    const wrap = createIpcWrapper('test');
    const result = await wrap('op', async () => {
      // void
    });

    expect(result).toEqual({ success: true, data: undefined });
  });

  it('handles null return', async () => {
    const wrap = createIpcWrapper('test');
    const result = await wrap('op', async () => null);

    expect(result).toEqual({ success: true, data: null });
  });

  it('creates independent wrappers with different prefixes', async () => {
    const wrap1 = createIpcWrapper('prefix1');
    const wrap2 = createIpcWrapper('prefix2');

    const result1 = await wrap1('op', async () => 'a');
    const result2 = await wrap2('op', async () => 'b');

    expect(result1).toEqual({ success: true, data: 'a' });
    expect(result2).toEqual({ success: true, data: 'b' });
  });
});
