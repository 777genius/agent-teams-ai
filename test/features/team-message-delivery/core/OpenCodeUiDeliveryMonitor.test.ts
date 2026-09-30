import { describe, expect, it, vi } from 'vitest';

import { RuntimeDeliveryMonitor } from '../../../../src/features/team-message-delivery/core/application/services/RuntimeDeliveryMonitor';

import type {
  DeadlinePort,
  RuntimeDeliveryCompatibilityPort,
} from '../../../../src/features/team-message-delivery/core/application/ports/TeamMessageDeliveryPorts';
import type { RuntimeRelayResult } from '../../../../src/features/team-message-delivery/core/domain/messageDeliveryModels';

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

function compatibility(
  overrides: Partial<RuntimeDeliveryCompatibilityPort> = {}
): RuntimeDeliveryCompatibilityPort {
  return {
    shouldLookupStatusAfterRelay: (relay) =>
      Boolean(
        relay.lastDelivery?.delivered &&
        typeof relay.lastDelivery.accepted !== 'boolean' &&
        typeof relay.lastDelivery.responsePending !== 'boolean'
      ),
    statusToRelayResult: (status) => ({
      relayed: 0,
      attempted: 1,
      delivered: status.delivered && status.responsePending !== true ? 1 : 0,
      failed: status.delivered ? 0 : 1,
      lastDelivery: {
        delivered: status.delivered,
        accepted: status.accepted,
        responsePending: status.responsePending,
      },
    }),
    buildTimeoutRelayResult: () => ({
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
        reason: 'runtime_delivery_pending',
        diagnostics: ['runtime_delivery_pending'],
      },
    }),
    buildMissingDelivery: (relay) => ({ delivered: relay.relayed > 0 }),
    formatWarning: () => null,
    ...overrides,
  };
}

describe('RuntimeDeliveryMonitor', () => {
  it('delegates the pending projection after the UI timeout', async () => {
    const relay = deferred<RuntimeRelayResult>();
    const deadline: DeadlinePort = {
      raceWithTimeout: vi.fn((_promise, _timeoutMs, onTimeout) => {
        onTimeout();
        return Promise.resolve({ kind: 'timeout' as const });
      }),
      withTimeoutValue: vi.fn((_promise, _timeoutMs, timeoutValue) =>
        Promise.resolve(timeoutValue)
      ),
    };
    const monitor = new RuntimeDeliveryMonitor({
      messaging: { getRuntimeDeliveryStatus: vi.fn(() => Promise.resolve(null)) },
      deadline,
      compatibility: compatibility(),
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
        reason: 'runtime_delivery_pending',
        diagnostics: ['runtime_delivery_pending'],
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
    const monitor = new RuntimeDeliveryMonitor({
      messaging: { getRuntimeDeliveryStatus: getStatus },
      deadline,
      compatibility: compatibility(),
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
    const relay = deferred<RuntimeRelayResult>();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const formatWarning = vi.fn(() => 'compatibility warning');
    const monitor = new RuntimeDeliveryMonitor({
      messaging: { getRuntimeDeliveryStatus: vi.fn(() => Promise.resolve(null)) },
      deadline: {
        raceWithTimeout: vi.fn((_promise, _timeoutMs, onTimeout) => {
          onTimeout();
          return Promise.resolve({ kind: 'timeout' as const });
        }),
        withTimeoutValue: vi.fn((_promise, _timeoutMs, timeoutValue) =>
          Promise.resolve(timeoutValue)
        ),
      },
      compatibility: compatibility({ formatWarning }),
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

    expect(formatWarning).toHaveBeenCalledWith({
      kind: 'late-rejection',
      memberName: 'worker',
      error: { message: 'late failure' },
    });
    expect(logger.warn).toHaveBeenCalledWith('compatibility warning');
  });
});
