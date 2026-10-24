// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { writeReviewSse } from '../../../src/main/http/writeReviewSse';

describe('captured review SSE backpressure', () => {
  it('closes immediately on write(false), retaining no application queue', () => {
    const stream = {
      destroyed: false,
      writableLength: 0,
      write: vi.fn(() => false),
      destroy: vi.fn(),
    };
    expect(writeReviewSse(stream, 'event: review\ndata: TEST\n\n')).toBe(false);
    expect(stream.write).toHaveBeenCalledOnce();
    expect(stream.destroy).toHaveBeenCalledOnce();
  });
  it('counts UTF-8 bytes already pending and refuses an oversized write before buffering it', () => {
    const stream = {
      destroyed: false,
      writableLength: 65535,
      write: vi.fn(() => true),
      destroy: vi.fn(),
    };
    expect(writeReviewSse(stream, 'я')).toBe(false);
    expect(stream.write).not.toHaveBeenCalled();
    expect(stream.destroy).toHaveBeenCalledOnce();
  });
});
