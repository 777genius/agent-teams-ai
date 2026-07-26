import { describe, expect, it, vi } from 'vitest';

import { readResponseTextWithLimit } from './boundedResponseBody';

describe('readResponseTextWithLimit', () => {
  it('reads a chunked response while it remains within the byte limit', async () => {
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('hello '));
          controller.enqueue(encoder.encode('world'));
          controller.close();
        },
      })
    );

    await expect(readResponseTextWithLimit(response, 11)).resolves.toBe('hello world');
  });

  it('cancels a chunked response as soon as its actual byte size exceeds the limit', async () => {
    const cancel = vi.fn();
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('1234'));
          controller.enqueue(encoder.encode('5'));
        },
        cancel,
      })
    );

    await expect(readResponseTextWithLimit(response, 4)).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized declared body without reading it', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { 'content-length': '1025' },
    });

    await expect(readResponseTextWithLimit(response, 1024)).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
