// @vitest-environment node
import { runShutdownStep, SHUTDOWN_STEP_TIMEOUT_MS } from '@main/utils/shutdownStep';
import { addLogSink, type LogSinkEntry } from '@shared/utils/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
});

describe('shutdown step lifetime', () => {
  it('keeps the captured finite drain pending when its outer budget is null', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const drain = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const step = runShutdownStep('captured backend', () => drain, null).then(() => {
      finished = true;
    });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_STEP_TIMEOUT_MS * 2);
    expect(finished).toBe(false);
    release();
    await step;
    expect(finished).toBe(true);
  });

  it('bounds ordinary steps while retaining settlement of the original work', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const drain = new Promise<void>((resolve) => {
      release = resolve;
    });
    const step = runShutdownStep('ordinary cleanup', () => drain);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_STEP_TIMEOUT_MS);
    await step;
    expect(vi.getTimerCount()).toBe(0);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      '[App]',
      'Shutdown step timed out after 5000ms: ordinary cleanup'
    );
    vi.mocked(console.warn).mockClear();
    release();
    await drain;
  });

  it.each([null, 100])('records failure and releases timers with budget %s', async (budget) => {
    vi.useFakeTimers();
    const entries: LogSinkEntry[] = [];
    const remove = addLogSink((entry) => entries.push(entry));
    try {
      await runShutdownStep(
        'failed cleanup',
        () => {
          throw new Error('owned failure');
        },
        budget
      );
      expect(vi.getTimerCount()).toBe(0);
      expect(entries.filter((entry) => entry.level === 'warn')).toMatchObject([
        { namespace: 'App', args: ['Shutdown step failed (failed cleanup): owned failure'] },
      ]);
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(
        '[App]',
        'Shutdown step failed (failed cleanup): owned failure'
      );
      vi.mocked(console.warn).mockClear();
      expect(entries.at(-1)?.args).toEqual([
        'Shutdown step wait finished',
        { label: 'failed cleanup' },
      ]);
    } finally {
      remove();
    }
  });
});
