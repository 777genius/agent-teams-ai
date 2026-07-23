import { describe, expect, it, vi } from 'vitest';

import { OpenCodeUiDeliveryMonitor } from '../../../../src/features/team-message-delivery/core/application/services/OpenCodeUiDeliveryMonitor';

import type { DeadlinePort } from '../../../../src/features/team-message-delivery/core/application/ports/TeamMessageDeliveryPorts';
import type { OpenCodeRelayResult } from '../../../../src/features/team-message-delivery/core/domain/messageDeliveryModels';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('OpenCodeUiDeliveryMonitor', () => {
  it('preserves the legacy pending projection after the UI timeout', async () => {
    const relay = deferred<OpenCodeRelayResult>();
    const deadline: DeadlinePort = {
      raceWithTimeout: vi.fn((_promise, _timeoutMs, onTimeout) => {
        onTimeout();
        return Promise.resolve({ kind: 'timeout' as const });
      }),
      withTimeoutValue: vi.fn((_promise, _timeoutMs, timeoutValue) =>
        Promise.resolve(timeoutValue)
      ),
    };
    const monitor = new OpenCodeUiDeliveryMonitor({
      messaging: { getOpenCodeRuntimeDeliveryStatus: vi.fn(() => Promise.resolve(null)) },
      deadline,
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(
      monitor.waitForRelay({
        teamName: 'demo-team',
        memberName: 'worker',
        messageId: 'message-1',
        relayPromise: relay.promise,
      })
    ).resolves.toEqual({
      relayed: 0,
      attempted: 1,
      delivered: 0,
      failed: 1,
      lastDelivery: {
        delivered: true,
        accepted: false,
        responsePending: true,
        acceptanceUnknown: true,
        responseState: 'not_observed',
        reason: 'opencode_runtime_delivery_ui_timeout_pending',
        diagnostics: ['opencode_runtime_delivery_ui_timeout_pending'],
      },
    });
  });

  it('hydrates a bare successful relay from runtime status', async () => {
    const getStatus = vi.fn(() =>
      Promise.resolve({
        providerId: 'opencode' as const,
        attempted: true,
        delivered: true,
        accepted: true,
        responsePending: false,
        messageId: 'message-1',
      })
    );
    const deadline: DeadlinePort = {
      raceWithTimeout: (promise) => promise.then((value) => ({ kind: 'value' as const, value })),
      withTimeoutValue: (promise) => promise,
    };
    const monitor = new OpenCodeUiDeliveryMonitor({
      messaging: { getOpenCodeRuntimeDeliveryStatus: getStatus },
      deadline,
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const result = await monitor.waitForRelay({
      teamName: 'demo-team',
      memberName: 'worker',
      messageId: 'message-1',
      relayPromise: Promise.resolve({
        relayed: 1,
        attempted: 1,
        delivered: 1,
        failed: 0,
        lastDelivery: { delivered: true },
      }),
    });

    expect(getStatus).toHaveBeenCalledWith('demo-team', 'message-1');
    expect(result).toMatchObject({
      attempted: 1,
      delivered: 1,
      failed: 0,
      lastDelivery: { delivered: true, accepted: true, responsePending: false },
    });
  });

  it('keeps observing a relay that rejects after the timeout', async () => {
    const relay = deferred<OpenCodeRelayResult>();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const monitor = new OpenCodeUiDeliveryMonitor({
      messaging: { getOpenCodeRuntimeDeliveryStatus: vi.fn(() => Promise.resolve(null)) },
      deadline: {
        raceWithTimeout: vi.fn((_promise, _timeoutMs, onTimeout) => {
          onTimeout();
          return Promise.resolve({ kind: 'timeout' as const });
        }),
        withTimeoutValue: vi.fn((_promise, _timeoutMs, timeoutValue) =>
          Promise.resolve(timeoutValue)
        ),
      },
      logger,
    });

    await monitor.waitForRelay({
      teamName: 'demo-team',
      memberName: 'worker',
      messageId: 'message-1',
      relayPromise: relay.promise,
    });
    relay.reject({ message: 'late failure' });
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.warn).toHaveBeenCalledWith(
      'OpenCode runtime delivery after sendMessage rejected after UI timeout for teammate "worker": late failure'
    );
  });
});
