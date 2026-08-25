import {
  createHostedOperatorSurfaceController,
  type HostedOperatorSurfaceController,
} from '@renderer/hosted/createHostedOperatorSurfaceController';
import { describe, expect, it, vi } from 'vitest';

import type { HostedReadinessProjection } from '@features/hosted-readiness/contracts';
import type { HostedReadinessRendererTransport } from '@features/hosted-readiness/renderer';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const readiness = Object.freeze({
  schemaVersion: 1,
  state: 'ready',
  dimensions: Object.freeze([]),
}) as unknown as HostedReadinessProjection;

function controllerWith(
  load: HostedReadinessRendererTransport['load']
): HostedOperatorSurfaceController {
  return createHostedOperatorSurfaceController({
    readinessTransport: { load },
    pollIntervalMs: 10_000,
    staleAfterMs: 20_000,
  });
}

describe('createHostedOperatorSurfaceController', () => {
  it('loads readiness on first mount and publishes a safe ready snapshot', async () => {
    const load = vi.fn(async () => readiness);
    const controller = controllerWith(load);
    const listener = vi.fn();
    controller.subscribe(listener);

    const unmount = controller.mount();
    expect(controller.getSnapshot().status).toBe('loading');
    await controller.reload();

    expect(load).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      readiness,
      error: null,
    });
    expect(listener).toHaveBeenCalled();
    unmount();
    expect(controller.getSnapshot().status).toBe('idle');
  });

  it('deduplicates overlapping readiness reloads', async () => {
    const first = deferred<HostedReadinessProjection>();
    const signals: AbortSignal[] = [];
    const load = vi
      .fn<HostedReadinessRendererTransport['load']>()
      .mockImplementation((signal) => {
        signals.push(signal as AbortSignal);
        return first.promise;
      });
    const controller = controllerWith(load);
    const unmount = controller.mount();

    const reloading = controller.reload();
    expect(signals[0]?.aborted).toBe(false);
    expect(load).toHaveBeenCalledOnce();
    first.resolve(readiness);
    await reloading;

    expect(controller.getSnapshot().readiness).toBe(readiness);
    unmount();
    expect(controller.getSnapshot().status).toBe('idle');
  });

  it('retains last-good readiness while a background refresh is pending', async () => {
    const refresh = deferred<HostedReadinessProjection>();
    const load = vi.fn<HostedReadinessRendererTransport['load']>()
      .mockResolvedValueOnce(readiness)
      .mockReturnValueOnce(refresh.promise);
    const controller = controllerWith(load);
    const unmount = controller.mount();
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'));
    const reloading = controller.reload();
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      refreshing: true,
      readiness,
    });
    refresh.resolve(readiness);
    await reloading;
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', refreshing: false });
    unmount();
  });

  it('fails closed after the last successful readiness becomes stale', async () => {
    vi.useFakeTimers();
    const hanging = deferred<HostedReadinessProjection>();
    const load = vi.fn<HostedReadinessRendererTransport['load']>()
      .mockResolvedValueOnce(readiness)
      .mockReturnValue(hanging.promise);
    const controller = createHostedOperatorSurfaceController({
      readinessTransport: { load },
      pollIntervalMs: 1_000,
      staleAfterMs: 2_000,
    });
    const unmount = controller.mount();
    await vi.runAllTicks();
    expect(controller.getSnapshot().status).toBe('ready');
    await vi.advanceTimersByTimeAsync(2_001);
    expect(controller.getSnapshot().status).toBe('error');
    unmount();
    vi.useRealTimers();
  });

  it('maps failures to a fixed renderer-safe message and supports retry', async () => {
    const load = vi
      .fn<HostedReadinessRendererTransport['load']>()
      .mockRejectedValueOnce(new Error('private upstream detail'))
      .mockResolvedValueOnce(readiness);
    const controller = controllerWith(load);
    const unmount = controller.mount();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      readiness: null,
      error: 'Hosted operator readiness is temporarily unavailable.',
    });
    await Promise.resolve();
    await controller.reload();
    expect(controller.getSnapshot().status).toBe('ready');
    unmount();
  });
});
