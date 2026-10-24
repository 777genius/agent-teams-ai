import { describe, expect, it, vi } from 'vitest';

import {
  runStartupStage,
  StartupCancelledError,
} from '../../../src/main/utils/startupCancellation';

describe('runStartupStage', () => {
  it('does not admit work when shutdown has already begun', async () => {
    const stage = vi.fn(async () => 'resource');
    await expect(runStartupStage(() => true, stage)).rejects.toBeInstanceOf(StartupCancelledError);
    expect(stage).not.toHaveBeenCalled();
  });

  it('disposes a late resource and prevents its publication and subsequent stages', async () => {
    let shuttingDown = false;
    let complete!: (value: { dispose: () => Promise<void> }) => void;
    const dispose = vi.fn(async () => undefined);
    const publish = vi.fn();
    const nextStage = vi.fn(async () => undefined);
    const pending = new Promise<{ dispose: () => Promise<void> }>((resolve) => {
      complete = resolve;
    });
    const startup = (async () => {
      const resource = await runStartupStage(
        () => shuttingDown,
        () => pending,
        (value) => value.dispose()
      );
      publish(resource);
      await runStartupStage(() => shuttingDown, nextStage);
    })();
    const rejection = expect(startup).rejects.toBeInstanceOf(StartupCancelledError);
    shuttingDown = true;
    complete({ dispose });
    await rejection;
    expect(dispose).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(nextStage).not.toHaveBeenCalled();
  });

  it('turns a stage rejection during shutdown into typed cancellation', async () => {
    let shuttingDown = false;
    let fail!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    const stage = runStartupStage(
      () => shuttingDown,
      () => pending
    );
    const rejection = expect(stage).rejects.toBeInstanceOf(StartupCancelledError);
    shuttingDown = true;
    fail(new Error('resource shut down'));
    await rejection;
  });

  it('preserves real failures and successful results while startup is active', async () => {
    const failure = new Error('invalid configuration');
    await expect(
      runStartupStage(
        () => false,
        async () => {
          throw failure;
        }
      )
    ).rejects.toBe(failure);
    const resource = {};
    const dispose = vi.fn();
    await expect(
      runStartupStage(
        () => false,
        async () => resource,
        dispose
      )
    ).resolves.toBe(resource);
    expect(dispose).not.toHaveBeenCalled();
  });
});
