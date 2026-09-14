import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OpenCodePromptDeliveryWatchdogScheduler,
  type OpenCodePromptDeliveryWatchdogSchedulerDependencies,
} from '../OpenCodePromptDeliveryWatchdogScheduler';

/**
 * The dependency ports as plain function-valued properties. The interface
 * declares them as methods, so asserting on a mock - `expect(deps.warn)` - reads
 * as an unbound method reference. Mapping them to properties says what these
 * stand-ins actually are and keeps the assertions direct.
 */
type SchedulerDeps = {
  [K in keyof OpenCodePromptDeliveryWatchdogSchedulerDependencies]: OpenCodePromptDeliveryWatchdogSchedulerDependencies[K];
};

function makeScheduler(overrides: Partial<SchedulerDeps> = {}): {
  scheduler: OpenCodePromptDeliveryWatchdogScheduler;
  deps: SchedulerDeps;
} {
  const deps: SchedulerDeps = {
    canDeliverToTeamRuntime: vi.fn(() => true),
    recoverBeforeDelivery: vi.fn(async () => false),
    relay: vi.fn(async () => undefined),
    getInboxMessages: vi.fn(async () => []),
    resolveIdentity: vi.fn(async () => ({ ok: true, laneId: 'lane-1' })),
    isLaneActive: vi.fn(async () => true),
    isRecordNotFoundError: vi.fn(
      (error) =>
        error instanceof Error &&
        error.message.startsWith('OpenCode prompt delivery record not found:')
    ),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    diagnostic: vi.fn(),
    getErrorMessage: vi.fn((error) => (error instanceof Error ? error.message : String(error))),
    ...overrides,
  };

  return {
    scheduler: new OpenCodePromptDeliveryWatchdogScheduler(deps),
    deps,
  };
}

describe('OpenCodePromptDeliveryWatchdogScheduler stale error policy', () => {
  it('keeps record-not-found watchdog errors live when the unread target is on an active lane', async () => {
    const { scheduler, deps } = makeScheduler({
      getInboxMessages: vi.fn(async () => [
        {
          messageId: 'opencode-active-watchdog-1',
          read: false,
        },
      ]),
      resolveIdentity: vi.fn(async () => ({ ok: true, laneId: 'secondary:opencode:jack' })),
      isLaneActive: vi.fn(async () => true),
    });

    await expect(
      scheduler.isStaleError({
        teamName: 'my-team',
        memberName: 'jack',
        messageId: 'opencode-active-watchdog-1',
        error: new Error('OpenCode prompt delivery record not found: opencode-prompt:active'),
      })
    ).resolves.toBe(false);
    expect(deps.resolveIdentity).toHaveBeenCalledWith({
      teamName: 'my-team',
      memberName: 'jack',
    });
    expect(deps.isLaneActive).toHaveBeenCalledWith({
      teamName: 'my-team',
      laneId: 'secondary:opencode:jack',
    });
  });
});

/**
 * A wake used to await `relay()` and throw the result away, so the only reader
 * of a relay's own account of a delivery was the inbox file-change path. A lane
 * that was refused on every wake and received no new inbox row therefore
 * explained itself nowhere, for as long as the condition lasted - and a
 * terminal ledger write re-relays the whole lane, so those wakes arrive in
 * bursts of exactly that kind.
 */
describe('OpenCodePromptDeliveryWatchdogScheduler relay diagnostics', () => {
  const blockedDiagnostics = ['opencode_prompt_delivery_dispatch_refused: lane busy'];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runWake(
    scheduler: OpenCodePromptDeliveryWatchdogScheduler,
    input: { teamName: string; memberName: string; messageId: string }
  ): Promise<void> {
    scheduler.schedule({ ...input, delayMs: 0 });
    await vi.advanceTimersByTimeAsync(500);
  }

  it('logs the diagnostics of a refused wake instead of dropping them', async () => {
    const { scheduler, deps } = makeScheduler({
      relay: vi.fn(async () => ({ diagnostics: blockedDiagnostics })),
    });

    await runWake(scheduler, { teamName: 'team', memberName: 'alice', messageId: 'msg-1' });

    expect(deps.relay).toHaveBeenCalledTimes(1);
    expect(deps.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.warn).mock.calls[0]?.[0]).toContain(blockedDiagnostics[0]);
    expect(vi.mocked(deps.warn).mock.calls[0]?.[0]).toContain('alice/msg-1');
  });

  /**
   * Negative control: repeated wakes on a blocked lane must stay one line. The
   * dedup key is the lane and the signature is the diagnostics alone, so a
   * queue of rows cannot walk past the window one message id at a time - which
   * is what would happen if the rendered line, message id included, were the
   * key.
   */
  it('rate-limits an unchanged diagnostic across wakes for different messages', async () => {
    const { scheduler, deps } = makeScheduler({
      relay: vi.fn(async () => ({ diagnostics: blockedDiagnostics })),
    });

    for (const messageId of ['msg-1', 'msg-2', 'msg-3']) {
      await runWake(scheduler, { teamName: 'team', memberName: 'alice', messageId });
    }

    expect(deps.relay).toHaveBeenCalledTimes(3);
    expect(deps.warn).toHaveBeenCalledTimes(1);
    expect(deps.info).not.toHaveBeenCalled();
    expect(deps.diagnostic).not.toHaveBeenCalled();
  });

  it('reports a changed condition immediately', async () => {
    const relay = vi
      .fn<() => Promise<{ diagnostics: readonly string[] }>>()
      .mockResolvedValueOnce({ diagnostics: blockedDiagnostics })
      .mockResolvedValue({ diagnostics: ['opencode_prompt_delivery_dispatch_refused: no lane'] });
    const { scheduler, deps } = makeScheduler({ relay });

    await runWake(scheduler, { teamName: 'team', memberName: 'alice', messageId: 'msg-1' });
    await runWake(scheduler, { teamName: 'team', memberName: 'alice', messageId: 'msg-2' });

    expect(deps.warn).toHaveBeenCalledTimes(2);
  });

  it('stays silent when the relay reports nothing', async () => {
    const { scheduler, deps } = makeScheduler({ relay: vi.fn(async () => undefined) });

    await runWake(scheduler, { teamName: 'team', memberName: 'alice', messageId: 'msg-1' });

    expect(deps.relay).toHaveBeenCalledTimes(1);
    expect(deps.warn).not.toHaveBeenCalled();
    expect(deps.info).not.toHaveBeenCalled();
    expect(deps.diagnostic).not.toHaveBeenCalled();
  });

  /**
   * A wake fires per inbox row, and the row is often in an expected waiting
   * state by the time it does. Making that path speak must not make it shout -
   * and must not route it to `info`, which reaches neither the durable sink nor
   * the console at either default level, and so would only look logged.
   */
  it('reports an expected waiting state on the diagnostic channel, never at info', async () => {
    const { scheduler, deps } = makeScheduler({
      relay: vi.fn(async () => ({ diagnostics: ['opencode_delivery_response_pending'] })),
    });

    await runWake(scheduler, { teamName: 'team', memberName: 'alice', messageId: 'msg-1' });

    expect(deps.warn).not.toHaveBeenCalled();
    expect(deps.info).not.toHaveBeenCalled();
    expect(deps.diagnostic).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.diagnostic).mock.calls[0]?.[0]).toContain(
      'opencode_delivery_response_pending'
    );
  });

  it('warns when an expected diagnostic arrives beside one that is not', async () => {
    const { scheduler, deps } = makeScheduler({
      relay: vi.fn(async () => ({
        diagnostics: ['opencode_delivery_response_pending', ...blockedDiagnostics],
      })),
    });

    await runWake(scheduler, { teamName: 'team', memberName: 'alice', messageId: 'msg-1' });

    expect(deps.diagnostic).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledTimes(1);
  });

  it('keeps one lane report from hiding another lane', async () => {
    const { scheduler, deps } = makeScheduler({
      relay: vi.fn(async () => ({ diagnostics: blockedDiagnostics })),
    });

    await runWake(scheduler, { teamName: 'team', memberName: 'alice', messageId: 'msg-1' });
    await runWake(scheduler, { teamName: 'team', memberName: 'bob', messageId: 'msg-2' });

    expect(deps.warn).toHaveBeenCalledTimes(2);
  });
});
