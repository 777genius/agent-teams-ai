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

/**
 * A wake waits behind the per-member serialization queue and fires after the
 * relay generation it was armed under has rotated. The wake then saw a revoked
 * `isCurrent` and returned without running at all: the unread row it existed
 * for lost its only scheduled pass and no file event would ever re-arm it, so
 * the message was silently lost. A stale wake must therefore re-arm unscoped
 * while its row is still unread - the walk re-derives identity and authority
 * from durable state, exactly like the manual relay path.
 */
describe('OpenCodePromptDeliveryWatchdogScheduler superseded wake recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-arms an unread row whose wake fired under a superseded generation', async () => {
    let current = true;
    const { scheduler, deps } = makeScheduler({
      getInboxMessages: vi.fn(async () => [{ messageId: 'msg-stale-1', read: false }]),
    });

    scheduler.schedule({
      teamName: 'team',
      memberName: 'alice',
      messageId: 'msg-stale-1',
      delayMs: 0,
      isCurrent: () => current,
    });
    current = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(deps.relay).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(31_000);
    expect(deps.relay).toHaveBeenCalledTimes(1);
    expect(deps.relay).toHaveBeenCalledWith(
      expect.objectContaining({ teamName: 'team', memberName: 'alice', messageId: 'msg-stale-1' })
    );
  });

  it('does not re-arm a stale wake for a row that is already read', async () => {
    let current = true;
    const { scheduler, deps } = makeScheduler({
      getInboxMessages: vi.fn(async () => [{ messageId: 'msg-stale-2', read: true }]),
    });

    scheduler.schedule({
      teamName: 'team',
      memberName: 'alice',
      messageId: 'msg-stale-2',
      delayMs: 0,
      isCurrent: () => current,
    });
    current = false;
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(deps.relay).not.toHaveBeenCalled();
    expect(deps.getInboxMessages).toHaveBeenCalled();
  });

  it('drops a stale wake for a row that no longer exists', async () => {
    let current = true;
    const { scheduler, deps } = makeScheduler({
      getInboxMessages: vi.fn(async () => []),
    });

    scheduler.schedule({
      teamName: 'team',
      memberName: 'alice',
      messageId: 'msg-stale-3',
      delayMs: 0,
      isCurrent: () => current,
    });
    current = false;
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(deps.relay).not.toHaveBeenCalled();
  });
});

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

  /**
   * A wake for a teammate whose bootstrap has not checked in yet comes back with
   * the stopped-lane reason and wording. Only the armed-retry flag on the relay's
   * last delivery tells the two apart: the wait stays on the diagnostic channel,
   * a lane that is really not active still warns.
   */
  it.each([
    ['an armed bootstrap deferral on the diagnostic channel', true],
    ['an unarmed opencode_runtime_not_active as a warning', false],
  ])('reports %s', async (_case, deferredUntilBootstrap) => {
    const bootstrapPending = [
      'OpenCode runtime bootstrap is not confirmed for alice. Message was saved and will be retried after runtime check-in.',
    ];
    const { scheduler, deps } = makeScheduler({
      relay: vi.fn(async () => ({
        diagnostics: bootstrapPending,
        lastDelivery: deferredUntilBootstrap ? { deferredUntilBootstrap: true as const } : {},
      })),
    });

    await runWake(scheduler, { teamName: 'team', memberName: 'alice', messageId: 'msg-1' });

    expect(deps.info).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledTimes(deferredUntilBootstrap ? 0 : 1);
    expect(deps.diagnostic).toHaveBeenCalledTimes(deferredUntilBootstrap ? 1 : 0);
    const line = vi.mocked(deferredUntilBootstrap ? deps.diagnostic : deps.warn).mock.calls[0]?.[0];
    expect(line).toContain('alice/msg-1');
    expect(line).toContain(bootstrapPending[0]);
  });
});

describe('OpenCodePromptDeliveryWatchdogScheduler scoped bootstrap wakes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rechecks generation authorization after asynchronous recovery before relaying', async () => {
    let current = true;
    const { scheduler, deps } = makeScheduler({
      canDeliverToTeamRuntime: () => false,
      recoverBeforeDelivery: async () => {
        current = false;
        return true;
      },
    });
    scheduler.schedule({
      teamName: 'team',
      memberName: 'jack',
      messageId: 'queued',
      delayMs: 500,
      isCurrent: () => current,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(deps.relay).not.toHaveBeenCalled();
    scheduler.cancelTeam('team');
  });

  it('replaces a revoked generation wake with its successor on the same message key', async () => {
    const { scheduler, deps } = makeScheduler();
    let firstCurrent = true;
    const successorCurrent = (): boolean => true;
    scheduler.schedule({
      teamName: 'team',
      memberName: 'jack',
      messageId: 'queued',
      delayMs: 500,
      isCurrent: () => firstCurrent,
    });
    firstCurrent = false;
    scheduler.schedule({
      teamName: 'team',
      memberName: 'jack',
      messageId: 'queued',
      delayMs: 3_000,
      isCurrent: successorCurrent,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(deps.relay).toHaveBeenCalledTimes(1);
    expect(deps.relay).toHaveBeenCalledWith(
      expect.objectContaining({ isCurrent: successorCurrent })
    );
    scheduler.cancelTeam('team');
  });

  it('upgrades a scoped timer to an unscoped wake without postponing it', async () => {
    const { scheduler, deps } = makeScheduler();
    let current = true;
    scheduler.schedule({
      teamName: 'team',
      memberName: 'jack',
      messageId: 'queued',
      delayMs: 500,
      isCurrent: () => current,
    });
    scheduler.schedule({
      teamName: 'team',
      memberName: 'jack',
      messageId: 'queued',
      delayMs: 3_000,
    });
    current = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(deps.relay).toHaveBeenCalledTimes(1);
    expect(deps.relay).toHaveBeenCalledWith({
      teamName: 'team',
      memberName: 'jack',
      messageId: 'queued',
    });
    scheduler.cancelTeam('team');
  });

  it('does not narrow an existing unscoped wake when a scoped wake advances its deadline', async () => {
    const { scheduler, deps } = makeScheduler();
    let current = true;
    scheduler.schedule({
      teamName: 'team',
      memberName: 'jack',
      messageId: 'queued',
      delayMs: 3_000,
    });
    scheduler.schedule({
      teamName: 'team',
      memberName: 'jack',
      messageId: 'queued',
      delayMs: 500,
      isCurrent: () => current,
    });
    current = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(deps.relay).toHaveBeenCalledTimes(1);
    expect(deps.relay).toHaveBeenCalledWith({
      teamName: 'team',
      memberName: 'jack',
      messageId: 'queued',
    });
    scheduler.cancelTeam('team');
  });

  it('refuses already revoked wakes at admission', async () => {
    const { scheduler, deps } = makeScheduler();
    scheduler.schedule({
      teamName: 'team',
      memberName: 'jack',
      messageId: 'queued',
      delayMs: 500,
      isCurrent: () => false,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(deps.relay).not.toHaveBeenCalled();
    scheduler.cancelTeam('team');
  });
});
