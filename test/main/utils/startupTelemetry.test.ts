import { describe, expect, it } from 'vitest';

import {
  captureStartupMemorySnapshot,
  formatCurrentProcessMemorySnapshot,
  formatProcessMemorySnapshot,
  formatStartupMemorySnapshot,
} from '../../../src/main/utils/startupTelemetry';

describe('startupTelemetry', () => {
  it('captures only stable numeric memory fields', () => {
    const snapshot = captureStartupMemorySnapshot(() => ({
      rss: 128 * 1024 * 1024,
      heapTotal: 64 * 1024 * 1024,
      heapUsed: 32 * 1024 * 1024,
      external: 8 * 1024 * 1024,
      arrayBuffers: 4 * 1024 * 1024,
    }));

    expect(snapshot).toEqual({
      rssBytes: 134217728,
      heapUsedBytes: 33554432,
      heapTotalBytes: 67108864,
      externalBytes: 8388608,
      arrayBuffersBytes: 4194304,
    });
  });

  it('formats rss and heap values for startup logs', () => {
    expect(
      formatStartupMemorySnapshot({
        rssBytes: 128 * 1024 * 1024,
        heapUsedBytes: 32 * 1024 * 1024,
        heapTotalBytes: 64 * 1024 * 1024,
        externalBytes: 8 * 1024 * 1024,
        arrayBuffersBytes: 4 * 1024 * 1024,
      })
    ).toBe('rss=128.0MiB heap=32.0MiB/64.0MiB external=8.0MiB');
  });

  it('formats process memory values with pid and array buffer usage', () => {
    expect(
      formatProcessMemorySnapshot(
        {
          rssBytes: 128 * 1024 * 1024,
          heapUsedBytes: 32 * 1024 * 1024,
          heapTotalBytes: 64 * 1024 * 1024,
          externalBytes: 8 * 1024 * 1024,
          arrayBuffersBytes: 4 * 1024 * 1024,
        },
        1234
      )
    ).toBe('pid=1234 rss=128.0MiB heap=32.0MiB/64.0MiB external=8.0MiB arrayBuffers=4.0MiB');
  });

  it('formats the current process memory snapshot from an injected reader', () => {
    expect(
      formatCurrentProcessMemorySnapshot(
        () => ({
          rss: 256 * 1024 * 1024,
          heapTotal: 96 * 1024 * 1024,
          heapUsed: 48 * 1024 * 1024,
          external: 12 * 1024 * 1024,
          arrayBuffers: 6 * 1024 * 1024,
        }),
        4321
      )
    ).toBe('pid=4321 rss=256.0MiB heap=48.0MiB/96.0MiB external=12.0MiB arrayBuffers=6.0MiB');
  });
});
