import { describe, expect, it, vi } from 'vitest';

import { OpenCodePromptDeliveryWatchdogScheduler } from '../../opencode/delivery/OpenCodePromptDeliveryWatchdogScheduler';
import {
  createOpenCodePromptDeliveryWatchdogSchedulerDepsFromService,
  createOpenCodePromptDeliveryWatchdogSchedulerFromService,
  type TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerServiceHost,
} from '../TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerFactory';

describe('TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerFactory', () => {
  it('builds watchdog scheduler deps from service-shaped host wiring', async () => {
    const service = {
      canDeliverToOpenCodeRuntimeForTeam: vi.fn(() => true),
      tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: vi.fn(async () => true),
      relayOpenCodeMemberInboxMessages: vi.fn(async () => ({
        attempted: 0,
        delivered: 0,
        relayed: 0,
        failed: 0,
        skipped: 0,
        diagnostics: ['refused'],
      })),
      inboxReader: {
        getMessagesFor: vi.fn(async () => [{ messageId: 'message-1', read: false }]),
      },
      openCodeRuntimeRecoveryIdentity: {
        resolveOpenCodeMemberDeliveryIdentity: vi.fn(async () => ({
          ok: true,
          laneId: 'lane-builder',
        })),
        isOpenCodeRuntimeLaneIndexActive: vi.fn(async () => true),
      },
    } satisfies TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerServiceHost;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      diagnostic: vi.fn(),
    };
    const getErrorMessage = vi.fn((error: unknown) =>
      error instanceof Error ? error.message : String(error)
    );

    const deps = createOpenCodePromptDeliveryWatchdogSchedulerDepsFromService(service, {
      logger,
      getErrorMessage,
    });

    expect(deps.canDeliverToTeamRuntime('alpha')).toBe(true);
    await expect(
      deps.recoverBeforeDelivery({ teamName: 'alpha', memberName: 'Builder' })
    ).resolves.toBe(true);
    // The relay's own account has to survive the hop, or a refused wake has
    // nothing to report.
    await expect(
      deps.relay({ teamName: 'alpha', memberName: 'Builder', messageId: 'message-1' })
    ).resolves.toMatchObject({ diagnostics: ['refused'] });
    await expect(
      deps.getInboxMessages({ teamName: 'alpha', memberName: 'Builder' })
    ).resolves.toEqual([{ messageId: 'message-1', read: false }]);
    await expect(
      deps.resolveIdentity({ teamName: 'alpha', memberName: 'Builder' })
    ).resolves.toEqual({ ok: true, laneId: 'lane-builder' });
    await expect(deps.isLaneActive({ teamName: 'alpha', laneId: 'lane-builder' })).resolves.toBe(
      true
    );

    expect(
      deps.isRecordNotFoundError(new Error('OpenCode prompt delivery record not found: message-1'))
    ).toBe(true);
    expect(service.relayOpenCodeMemberInboxMessages).toHaveBeenCalledWith('alpha', 'Builder', {
      onlyMessageId: 'message-1',
      source: 'watchdog',
    });
    expect(service.inboxReader.getMessagesFor).toHaveBeenCalledWith('alpha', 'Builder');
    expect(
      service.openCodeRuntimeRecoveryIdentity.resolveOpenCodeMemberDeliveryIdentity
    ).toHaveBeenCalledWith('alpha', 'Builder');
    expect(
      service.openCodeRuntimeRecoveryIdentity.isOpenCodeRuntimeLaneIndexActive
    ).toHaveBeenCalledWith('alpha', 'lane-builder');

    service.relayOpenCodeMemberInboxMessages.mockClear();
    service.relayOpenCodeMemberInboxMessages.mockResolvedValueOnce({
      attempted: 1,
      delivered: 0,
      relayed: 0,
      failed: 1,
      skipped: 0,
      lastDelivery: {
        delivered: false,
        accepted: true,
        ledgerStatus: 'failed_terminal',
        reason: 'opencode_stale_pending_observe_window_exhausted',
      },
    } as never);
    await deps.relay({ teamName: 'alpha', memberName: 'Builder', messageId: 'message-1' });
    expect(service.relayOpenCodeMemberInboxMessages.mock.calls).toEqual([
      ['alpha', 'Builder', { onlyMessageId: 'message-1', source: 'watchdog' }],
      ['alpha', 'Builder', { source: 'watchdog' }],
    ]);

    for (const reason of ['opencode_prompt_delivery_cancelled', 'force_stop_requested']) {
      service.relayOpenCodeMemberInboxMessages.mockClear();
      service.relayOpenCodeMemberInboxMessages.mockResolvedValueOnce({
        attempted: 0,
        delivered: 0,
        relayed: 0,
        failed: 1,
        skipped: 0,
        lastDelivery: { delivered: false, ledgerStatus: 'failed_terminal', reason },
      } as never);
      await deps.relay({ teamName: 'alpha', memberName: 'Builder', messageId: 'old-run-message' });
      expect(service.relayOpenCodeMemberInboxMessages).toHaveBeenCalledOnce();
    }

    deps.info('info');
    deps.warn('warn');
    deps.debug('debug');
    deps.diagnostic('diagnostic');
    expect(logger.info).toHaveBeenCalledWith('info');
    expect(logger.warn).toHaveBeenCalledWith('warn');
    expect(logger.debug).toHaveBeenCalledWith('debug');
    expect(logger.diagnostic).toHaveBeenCalledWith('diagnostic');
  });

  it('wakes the rows queued behind a terminal record exactly once', async () => {
    // A terminal ledger write emits no inbox event, so the rows queued behind
    // the failed one need a wake of their own. Exactly one path issues it: the
    // lane-wide re-relay below. Any second source of that wake - a periodic
    // ledger sweep, a re-arm on the next observe - relays the same lane twice
    // for one terminal record, which is why there is only one.
    const relayOpenCodeMemberInboxMessages = vi.fn(
      async (
        _teamName: string,
        _memberName: string,
        _options: { onlyMessageId?: string; source: 'watchdog' }
      ) => ({
        attempted: 1,
        delivered: 0,
        relayed: 0,
        failed: 1,
        skipped: 0,
        lastDelivery: {
          delivered: false,
          accepted: true,
          ledgerStatus: 'failed_terminal',
          reason: 'opencode_stale_pending_observe_window_exhausted',
        },
      })
    );
    const deps = createOpenCodePromptDeliveryWatchdogSchedulerDepsFromService(
      {
        canDeliverToOpenCodeRuntimeForTeam: () => true,
        tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: async () => true,
        relayOpenCodeMemberInboxMessages,
        inboxReader: { getMessagesFor: async () => [] },
        openCodeRuntimeRecoveryIdentity: {
          resolveOpenCodeMemberDeliveryIdentity: async () => null,
          isOpenCodeRuntimeLaneIndexActive: async () => false,
        },
      } as unknown as TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerServiceHost,
      {
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), diagnostic: vi.fn() },
        getErrorMessage: String,
      }
    );

    const outcome = await deps.relay({
      teamName: 'alpha',
      memberName: 'Builder',
      messageId: 'message-1',
    });

    const laneWakes = relayOpenCodeMemberInboxMessages.mock.calls.filter(
      ([, , options]) => options.onlyMessageId === undefined
    );
    expect(laneWakes).toHaveLength(1);
    expect(relayOpenCodeMemberInboxMessages.mock.calls).toEqual([
      ['alpha', 'Builder', { onlyMessageId: 'message-1', source: 'watchdog' }],
      ['alpha', 'Builder', { source: 'watchdog' }],
    ]);
    // What comes back is this row's own relay, not the lane wake's: the wake
    // reports the row it was scheduled for.
    expect(outcome).toMatchObject({
      lastDelivery: { ledgerStatus: 'failed_terminal' },
    });
  });

  it('creates the OpenCode prompt delivery watchdog scheduler', () => {
    const scheduler = createOpenCodePromptDeliveryWatchdogSchedulerFromService(
      {
        canDeliverToOpenCodeRuntimeForTeam: () => true,
        tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: async () => true,
        relayOpenCodeMemberInboxMessages: async () => ({
          attempted: 0,
          delivered: 0,
          relayed: 0,
          failed: 0,
          skipped: 0,
        }),
        inboxReader: {
          getMessagesFor: async () => [],
        },
        openCodeRuntimeRecoveryIdentity: {
          resolveOpenCodeMemberDeliveryIdentity: async () => null,
          isOpenCodeRuntimeLaneIndexActive: async () => false,
        },
      },
      {
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          debug: vi.fn(),
          diagnostic: vi.fn(),
        },
        getErrorMessage: String,
      }
    );

    expect(scheduler).toBeInstanceOf(OpenCodePromptDeliveryWatchdogScheduler);
  });
});
