import {
  HostedLifecycle,
  type HostedLifecycleComponent,
  HostedLifecycleStartError,
  HostedLifecycleStopError,
} from '@main/composition/hosted/application';
import { describe, expect, it, vi } from 'vitest';

function component(
  id: string,
  start: () => void | Promise<void>,
  stop: () => void | Promise<void>
) {
  return {
    id,
    readiness: vi.fn(async () => ({ ready: true, reasons: [] })),
    start: vi.fn(start),
    stop: vi.fn(stop),
  } satisfies HostedLifecycleComponent;
}

describe('HostedLifecycle', () => {
  it('starts in declaration order, stops in reverse order, and ignores repeated calls', async () => {
    const events: string[] = [];
    const first = component(
      'first',
      () => {
        events.push('start:first');
      },
      () => {
        events.push('stop:first');
      }
    );
    const second = component(
      'second',
      () => {
        events.push('start:second');
      },
      () => {
        events.push('stop:second');
      }
    );
    const lifecycle = new HostedLifecycle([first, second]);

    await lifecycle.start();
    await lifecycle.start();
    expect(lifecycle.snapshot()).toEqual({
      generation: 1,
      state: 'started',
      startedComponentIds: ['first', 'second'],
    });

    await lifecycle.stop();
    await lifecycle.stop();

    expect(events).toEqual(['start:first', 'start:second', 'stop:second', 'stop:first']);
    expect(first.start).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
    expect(lifecycle.snapshot()).toEqual({
      generation: 2,
      state: 'stopped',
      startedComponentIds: [],
    });
  });

  it('shares concurrent start and stop operations', async () => {
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const service = component(
      'service',
      () => startGate,
      () => undefined
    );
    const lifecycle = new HostedLifecycle([service]);

    const firstStart = lifecycle.start();
    const secondStart = lifecycle.start();
    expect(secondStart).toBe(firstStart);
    releaseStart?.();
    await Promise.all([firstStart, secondStart]);

    const firstStop = lifecycle.stop();
    const secondStop = lifecycle.stop();
    expect(secondStop).toBe(firstStop);
    await Promise.all([firstStop, secondStop]);

    expect(service.start).toHaveBeenCalledOnce();
    expect(service.stop).toHaveBeenCalledOnce();
  });

  it('preserves a restart requested behind an in-flight start and queued stop', async () => {
    const events: string[] = [];
    let releaseFirstStart: (() => void) | undefined;
    const firstStartGate = new Promise<void>((resolve) => {
      releaseFirstStart = resolve;
    });
    const service = component(
      'service',
      async () => {
        events.push('start');
        if (service.start.mock.calls.length === 1) await firstStartGate;
      },
      () => {
        events.push('stop');
      }
    );
    const lifecycle = new HostedLifecycle([service]);

    const firstStart = lifecycle.start();
    await Promise.resolve();
    const stop = lifecycle.stop();
    const restart = lifecycle.start();

    expect(restart).not.toBe(firstStart);
    expect(lifecycle.snapshot()).toMatchObject({ generation: 1, state: 'starting' });

    releaseFirstStart?.();
    await Promise.all([firstStart, stop, restart]);

    expect(events).toEqual(['start', 'stop', 'start']);
    expect(lifecycle.snapshot()).toEqual({
      generation: 3,
      state: 'started',
      startedComponentIds: ['service'],
    });
  });

  it('preserves a final stop requested behind an in-flight stop and queued restart', async () => {
    const events: string[] = [];
    let releaseFirstStop: (() => void) | undefined;
    const firstStopGate = new Promise<void>((resolve) => {
      releaseFirstStop = resolve;
    });
    const service = component(
      'service',
      () => {
        events.push('start');
      },
      async () => {
        events.push('stop');
        if (service.stop.mock.calls.length === 1) await firstStopGate;
      }
    );
    const lifecycle = new HostedLifecycle([service]);
    await lifecycle.start();

    const firstStop = lifecycle.stop();
    await Promise.resolve();
    const restart = lifecycle.start();
    const finalStop = lifecycle.stop();

    expect(finalStop).not.toBe(firstStop);
    expect(lifecycle.snapshot()).toMatchObject({ generation: 2, state: 'stopping' });

    releaseFirstStop?.();
    await Promise.all([firstStop, restart, finalStop]);

    expect(events).toEqual(['start', 'stop', 'start', 'stop']);
    expect(lifecycle.snapshot()).toEqual({
      generation: 4,
      state: 'stopped',
      startedComponentIds: [],
    });
  });

  it('rolls back already-started components in reverse order after partial startup', async () => {
    const events: string[] = [];
    const startFailure = new Error('start failed');
    const first = component(
      'first',
      () => {
        events.push('start:first');
      },
      () => {
        events.push('stop:first');
      }
    );
    const second = component(
      'second',
      () => {
        events.push('start:second');
      },
      () => {
        events.push('stop:second');
      }
    );
    const failing = component(
      'failing',
      () => {
        events.push('start:failing');
        throw startFailure;
      },
      () => {
        events.push('stop:failing');
      }
    );
    const neverStarted = component(
      'never-started',
      () => {
        events.push('start:never');
      },
      () => undefined
    );
    const lifecycle = new HostedLifecycle([first, second, failing, neverStarted]);

    await expect(lifecycle.start()).rejects.toBe(startFailure);

    expect(events).toEqual([
      'start:first',
      'start:second',
      'start:failing',
      'stop:second',
      'stop:first',
    ]);
    expect(failing.stop).not.toHaveBeenCalled();
    expect(neverStarted.start).not.toHaveBeenCalled();
    expect(lifecycle.snapshot()).toEqual({
      generation: 1,
      state: 'stopped',
      startedComponentIds: [],
    });
  });

  it('reports an incomplete startup rollback and permits stop to retry its residual', async () => {
    const startFailure = new Error('start failed');
    const rollbackFailure = new Error('rollback failed');
    const first = component(
      'first',
      () => undefined,
      vi.fn().mockRejectedValueOnce(rollbackFailure)
    );
    const failing = component(
      'failing',
      () => {
        throw startFailure;
      },
      () => undefined
    );
    const lifecycle = new HostedLifecycle([first, failing]);

    const error = await lifecycle.start().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HostedLifecycleStartError);
    expect(error).toMatchObject({
      startFailure: { componentId: 'failing', error: startFailure },
      rollbackFailures: [{ componentId: 'first', error: rollbackFailure }],
    });
    expect(lifecycle.snapshot()).toEqual({
      generation: 1,
      state: 'failed',
      startedComponentIds: ['first'],
    });

    await lifecycle.stop();
    expect(first.stop).toHaveBeenCalledTimes(2);
    expect(lifecycle.state).toBe('stopped');
  });

  it('aggregates shutdown failures without skipping cleanup and retries only residuals', async () => {
    const events: string[] = [];
    const firstFailure = new Error('first stop failed');
    const secondFailure = new Error('second stop failed');
    const first = component(
      'first',
      () => undefined,
      async () => {
        events.push('stop:first');
        if (first.stop.mock.calls.length === 1) throw firstFailure;
      }
    );
    const second = component(
      'second',
      () => undefined,
      async () => {
        events.push('stop:second');
        if (second.stop.mock.calls.length === 1) throw secondFailure;
      }
    );
    const third = component(
      'third',
      () => undefined,
      () => {
        events.push('stop:third');
      }
    );
    const lifecycle = new HostedLifecycle([first, second, third]);
    await lifecycle.start();

    const error = await lifecycle.stop().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HostedLifecycleStopError);
    expect(error).toMatchObject({
      failures: [
        { componentId: 'second', error: secondFailure },
        { componentId: 'first', error: firstFailure },
      ],
    });
    expect(events).toEqual(['stop:third', 'stop:second', 'stop:first']);
    expect(lifecycle.snapshot()).toEqual({
      generation: 2,
      state: 'failed',
      startedComponentIds: ['first', 'second'],
    });

    await lifecycle.stop();
    expect(events).toEqual([
      'stop:third',
      'stop:second',
      'stop:first',
      'stop:second',
      'stop:first',
    ]);
    expect(third.stop).toHaveBeenCalledOnce();
    expect(lifecycle.state).toBe('stopped');
  });
});
