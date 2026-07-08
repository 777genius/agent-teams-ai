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
      relayOpenCodeMemberInboxMessages: vi.fn(async () => undefined),
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
    await deps.relay({ teamName: 'alpha', memberName: 'Builder', messageId: 'message-1' });
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

    deps.info('info');
    deps.warn('warn');
    deps.debug('debug');
    expect(logger.info).toHaveBeenCalledWith('info');
    expect(logger.warn).toHaveBeenCalledWith('warn');
    expect(logger.debug).toHaveBeenCalledWith('debug');
  });

  it('creates the OpenCode prompt delivery watchdog scheduler', () => {
    const scheduler = createOpenCodePromptDeliveryWatchdogSchedulerFromService(
      {
        canDeliverToOpenCodeRuntimeForTeam: () => true,
        tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: async () => true,
        relayOpenCodeMemberInboxMessages: async () => undefined,
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
        },
        getErrorMessage: String,
      }
    );

    expect(scheduler).toBeInstanceOf(OpenCodePromptDeliveryWatchdogScheduler);
  });
});
