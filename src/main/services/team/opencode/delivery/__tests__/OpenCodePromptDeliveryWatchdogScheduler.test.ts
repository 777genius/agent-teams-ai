import { describe, expect, it, vi } from 'vitest';

import {
  OpenCodePromptDeliveryWatchdogScheduler,
  type OpenCodePromptDeliveryWatchdogSchedulerDependencies,
} from '../OpenCodePromptDeliveryWatchdogScheduler';

function makeScheduler(
  overrides: Partial<OpenCodePromptDeliveryWatchdogSchedulerDependencies> = {}
): {
  scheduler: OpenCodePromptDeliveryWatchdogScheduler;
  deps: OpenCodePromptDeliveryWatchdogSchedulerDependencies;
} {
  const deps: OpenCodePromptDeliveryWatchdogSchedulerDependencies = {
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
