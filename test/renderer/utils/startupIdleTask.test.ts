import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  scheduleStartupIdleTask,
  type StartupIdleTaskScheduler,
} from '../../../src/renderer/utils/startupIdleTask';

describe('scheduleStartupIdleTask', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('binds native browser timers before scheduling the default task', async () => {
    type WindowSetTimeout = typeof window.setTimeout;
    type WindowClearTimeout = typeof window.clearTimeout;
    const windowSetTimeoutDescriptor = Object.getOwnPropertyDescriptor(window, 'setTimeout');
    const windowClearTimeoutDescriptor = Object.getOwnPropertyDescriptor(window, 'clearTimeout');
    const globalSetTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
    const globalClearTimeoutDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'clearTimeout'
    );
    const nativeWindowSetTimeout = window.setTimeout.bind(window);
    const nativeWindowClearTimeout = window.clearTimeout.bind(window);
    const strictSetTimeout = function (
      this: unknown,
      ...args: Parameters<WindowSetTimeout>
    ): ReturnType<WindowSetTimeout> {
      if (this !== window && this !== globalThis) {
        throw new TypeError('Illegal invocation');
      }
      return nativeWindowSetTimeout(...args) as unknown as ReturnType<WindowSetTimeout>;
    } as WindowSetTimeout;
    const strictClearTimeout = function (
      this: unknown,
      ...args: Parameters<WindowClearTimeout>
    ): ReturnType<WindowClearTimeout> {
      if (this !== window && this !== globalThis) {
        throw new TypeError('Illegal invocation');
      }
      return nativeWindowClearTimeout(...args) as ReturnType<WindowClearTimeout>;
    } as WindowClearTimeout;

    try {
      Object.defineProperty(window, 'setTimeout', {
        configurable: true,
        value: strictSetTimeout,
      });
      Object.defineProperty(window, 'clearTimeout', {
        configurable: true,
        value: strictClearTimeout,
      });
      Object.defineProperty(globalThis, 'setTimeout', {
        configurable: true,
        value: strictSetTimeout as typeof setTimeout,
      });
      Object.defineProperty(globalThis, 'clearTimeout', {
        configurable: true,
        value: strictClearTimeout as typeof clearTimeout,
      });

      const task = vi.fn();
      scheduleStartupIdleTask(task, { minDelayMs: 0, maxDelayMs: 0 });

      await new Promise<void>((resolve) => nativeWindowSetTimeout(resolve, 0));

      expect(task).toHaveBeenCalledTimes(1);
    } finally {
      if (windowSetTimeoutDescriptor) {
        Object.defineProperty(window, 'setTimeout', windowSetTimeoutDescriptor);
      }
      if (windowClearTimeoutDescriptor) {
        Object.defineProperty(window, 'clearTimeout', windowClearTimeoutDescriptor);
      }
      if (globalSetTimeoutDescriptor) {
        Object.defineProperty(globalThis, 'setTimeout', globalSetTimeoutDescriptor);
      }
      if (globalClearTimeoutDescriptor) {
        Object.defineProperty(globalThis, 'clearTimeout', globalClearTimeoutDescriptor);
      }
    }
  });

  it('runs after the minimum delay when idle scheduling is unavailable', () => {
    vi.useFakeTimers();
    const task = vi.fn();

    scheduleStartupIdleTask(task, {
      minDelayMs: 2_000,
      maxDelayMs: 30_000,
      scheduler: {
        setTimeout,
        clearTimeout,
      },
    });

    vi.advanceTimersByTime(1_999);
    expect(task).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('uses requestIdleCallback after the minimum delay and before the max cap', () => {
    vi.useFakeTimers();
    const task = vi.fn();
    let idleCallback: Parameters<
      NonNullable<StartupIdleTaskScheduler['requestIdleCallback']>
    >[0] = () => undefined;
    const requestIdleCallback = vi.fn((callback, options) => {
      idleCallback = callback;
      expect(options).toEqual({ timeout: 28_000 });
      return 42;
    });

    scheduleStartupIdleTask(task, {
      minDelayMs: 2_000,
      maxDelayMs: 30_000,
      scheduler: {
        setTimeout,
        clearTimeout,
        requestIdleCallback,
      },
    });

    vi.advanceTimersByTime(2_000);
    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(task).not.toHaveBeenCalled();

    idleCallback({ didTimeout: false, timeRemaining: () => 10 });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('keeps the max delay as a safety cap for busy renderers', () => {
    vi.useFakeTimers();
    const task = vi.fn();

    scheduleStartupIdleTask(task, {
      minDelayMs: 2_000,
      maxDelayMs: 30_000,
      scheduler: {
        setTimeout,
        clearTimeout,
        requestIdleCallback: (callback, options) =>
          setTimeout(
            () => callback({ didTimeout: true, timeRemaining: () => 0 }),
            options?.timeout ?? 0
          ) as unknown as number,
        cancelIdleCallback: (handle) => clearTimeout(handle),
      },
    });

    vi.advanceTimersByTime(29_999);
    expect(task).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('cancels both pending delay and idle callbacks', () => {
    vi.useFakeTimers();
    const task = vi.fn();
    const cancelIdleCallback = vi.fn();
    const cleanup = scheduleStartupIdleTask(task, {
      minDelayMs: 2_000,
      maxDelayMs: 30_000,
      scheduler: {
        setTimeout,
        clearTimeout,
        requestIdleCallback: () => 42,
        cancelIdleCallback,
      },
    });

    vi.advanceTimersByTime(2_000);
    cleanup();
    expect(cancelIdleCallback).toHaveBeenCalledWith(42);

    vi.advanceTimersByTime(30_000);
    expect(task).not.toHaveBeenCalled();
  });
});
