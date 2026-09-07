import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type OpenCodeMemberInboxRelayResult,
  relayOpenCodeMemberInboxMessagesWithPorts,
} from '../TeamProvisioningOpenCodeMemberInboxRelay';
import {
  TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityService,
  type TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityServiceDeps,
} from '../TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityFacade';

import type { OpenCodeTeamRuntimeMessageResult } from '../../runtime';
import type { TeamProvisioningOpenCodeMemberMessageDeliveryHost } from '../TeamProvisioningOpenCodeMemberMessageDeliveryServiceFactory';
import type { TeamProvisioningSendMessageToRunRun } from '../TeamProvisioningSendMessageToRunBoundaryFactory';
import type { InboxMessage } from '@shared/types';

vi.mock('../TeamProvisioningOpenCodeMemberInboxRelay', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../TeamProvisioningOpenCodeMemberInboxRelay')>();
  return {
    ...actual,
    relayOpenCodeMemberInboxMessagesWithPorts: vi.fn(),
  };
});

vi.mock('../../opencode/store/OpenCodeRuntimeManifestEvidenceReader', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../opencode/store/OpenCodeRuntimeManifestEvidenceReader')
    >();
  return {
    ...actual,
    // Only the disk probe is faked: the lane exists, holds state and holds no
    // runtime evidence - the one shape the self-heal ladder may act on. The
    // switch itself stays real, which is the point of these tests.
    inspectOpenCodeRuntimeLaneStorage: vi.fn(async () => ({
      laneDirectoryExists: true,
      hasStateOnDisk: true,
      hasRuntimeEvidenceOnDisk: false,
      manifestEntryCount: 0,
      manifestUpdatedAt: null,
      fileNames: ['opencode-prompt-delivery-ledger.json'],
    })),
  };
});

const relayWithPortsMock = vi.mocked(relayOpenCodeMemberInboxMessagesWithPorts);
type TestSendRun = TeamProvisioningSendMessageToRunRun;
type TestDeps = TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityServiceDeps<TestSendRun>;

describe('TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityService', () => {
  beforeEach(() => {
    relayWithPortsMock.mockReset();
  });

  it('owns OpenCode member send serialization and delegates delivery through a lazy host', async () => {
    const createDeliveryHost = vi.fn(() => deliveryHostWithUnavailableBridge());
    const service = createService({ createDeliveryHost });
    const send = vi.fn(async () => runtimeResult('worker'));

    await expect(
      service.sendOpenCodeMemberMessageToRuntimeSerialized({
        teamName: 'team-a',
        laneId: 'lane-worker',
        send,
      })
    ).resolves.toEqual(runtimeResult('worker'));
    await expect(
      service.deliverOpenCodeMemberMessage('team-a', {
        memberName: 'worker',
        text: 'hello',
      })
    ).resolves.toEqual({
      delivered: false,
      reason: 'opencode_runtime_message_bridge_unavailable',
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(createDeliveryHost).toHaveBeenCalledTimes(1);
    expect(service.openCodeMemberSendInFlightByLane.size).toBe(0);
    expect(service.openCodeMemberSendSerializer.getMemberRelayKey('team-a', ' worker ')).toBe(
      'team-a:worker'
    );
  });

  it('wires the OpenCode member inbox relay through owned in-flight and attachment boundaries', async () => {
    const attachmentStore = {
      getAttachments: vi.fn(async () => [
        {
          id: 'attachment-1',
          data: 'SGVsbG8=',
          mimeType: 'text/plain',
        },
      ]),
    };
    const deps = createDeps({
      getAttachmentStore: vi.fn(() => attachmentStore),
    });
    const service = new TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityService(deps);
    const result: OpenCodeMemberInboxRelayResult = {
      relayed: 1,
      attempted: 1,
      delivered: 1,
      failed: 0,
    };

    relayWithPortsMock.mockImplementationOnce(async (input, ports) => {
      expect(input).toEqual({
        teamName: 'team-a',
        memberName: 'worker',
        relayKey: 'relay/team-a/worker',
        options: { onlyMessageId: 'message-1' },
      });
      expect(ports.inFlight).toBe(service.openCodeMemberInboxRelayInFlight);

      await expect(
        ports.resolveOpenCodeInboxAttachmentPayloads({
          teamName: 'team-a',
          message: inboxMessageWithStoredAttachment(),
        })
      ).resolves.toEqual({
        ok: true,
        attachments: [
          {
            id: 'attachment-1',
            filename: 'note.txt',
            mimeType: 'text/plain',
            size: 5,
            data: 'SGVsbG8=',
          },
        ],
      });
      await ports.resolveOpenCodeMemberDeliveryIdentity('team-a', 'worker');
      await ports.applyDestinationProof({
        ledger: {} as never,
        ledgerRecord: {} as never,
        teamName: 'team-a',
        replyRecipient: 'user',
        memberName: 'worker',
      });
      expect(ports.suppressRuntimeInactiveWarning('team-a')).toBe(false);

      return result;
    });

    await expect(
      service.openCodeMemberInboxRelayBoundary.relayOpenCodeMemberInboxMessages(
        'team-a',
        'worker',
        { onlyMessageId: 'message-1' }
      )
    ).resolves.toBe(result);

    expect(attachmentStore.getAttachments).toHaveBeenCalledWith('team-a', 'message-1');
    expect(deps.getOpenCodeRuntimeRecoveryIdentity).toHaveBeenCalled();
    expect(deps.getOpenCodeVisibleReplyProofService).toHaveBeenCalled();
    expect(deps.getCleanedStoppedTeamOpenCodeRuntimeLanes).toHaveBeenCalled();
  });

  it('ignores an old turn that finishes after a replacement run starts', async () => {
    let releaseDirectory!: (
      directory: Awaited<ReturnType<TestDeps['readLeadActivityDirectory']>>
    ) => void;
    const directory = new Promise<Awaited<ReturnType<TestDeps['readLeadActivityDirectory']>>>(
      (resolve) => {
        releaseDirectory = resolve;
      }
    );
    let run: TestSendRun = {
      teamName: 'team-a',
      runId: 'old-run',
      processKilled: false,
      cancelRequested: false,
      request: {},
      child: null,
    };
    const setLeadActivity = vi.fn();
    const service = createService({
      setLeadActivity,
      resolveLeadActivityRun: () => run,
      readLeadActivityDirectory: () => directory,
    });
    const notification = service.notifyOpenCodeLeadTurnActivity({
      teamName: 'team-a',
      memberName: 'team-lead',
      laneId: 'primary',
      runId: 'old-run',
      state: 'idle',
    });
    run = { ...run, runId: 'new-run' };
    releaseDirectory({ config: null, teamMeta: null, metaMembers: [] });
    await notification;
    expect(setLeadActivity).not.toHaveBeenCalled();
  });

  it('forwards OpenCode lead turn activity to setLeadActivity for the tracked run only', async () => {
    const run = {
      teamName: 'team-a',
      runId: 'run-1',
      processKilled: false,
      cancelRequested: false,
      request: {},
      child: null,
    } satisfies TestSendRun;
    const setLeadActivity = vi.fn();
    const resolveLeadActivityRun = vi.fn((teamName: string) =>
      teamName === 'team-a' ? run : null
    );
    const service = createService({ setLeadActivity, resolveLeadActivityRun });

    await service.notifyOpenCodeLeadTurnActivity({
      teamName: 'team-a',
      memberName: 'team-lead',
      laneId: 'primary',
      runId: 'run-1',
      state: 'active',
    });
    await service.notifyOpenCodeLeadTurnActivity({
      teamName: 'team-a',
      memberName: 'team-lead',
      laneId: 'primary',
      runId: 'run-1',
      state: 'idle',
    });
    await service.notifyOpenCodeLeadTurnActivity({
      teamName: 'team-b',
      memberName: 'team-lead',
      laneId: 'primary',
      runId: 'run-1',
      state: 'active',
    });

    for (const input of [
      { memberName: 'builder', runId: 'run-1', laneId: 'primary' },
      { memberName: 'team-lead', runId: 'old-run', laneId: 'primary' },
      { memberName: 'team-lead', runId: 'run-1', laneId: 'secondary:opencode:builder' },
    ]) {
      await service.notifyOpenCodeLeadTurnActivity({ teamName: 'team-a', state: 'idle', ...input });
    }
    expect(setLeadActivity.mock.calls).toEqual([
      [run, 'active'],
      [run, 'idle'],
    ]);
  });
});

/**
 * The self-heal switch has to work on the wiring the app actually runs.
 *
 * This service always supplies `isOpenCodePrimaryLaneSelfHealEnabled` to the
 * tracker, so the tracker never reaches its own default. While that port fell
 * back to the module CONSTANT instead of the env reader, setting
 * CLAUDE_TEAM_OPENCODE_PRIMARY_LANE_SELF_HEAL_ENABLED changed nothing in the
 * running app - the switch worked only in tests that built a tracker by hand.
 *
 * So this goes through the real service and the real tracker: it takes the
 * `requestOpenCodePrimaryLaneRebootstrap` port the service hands to the delivery
 * factory, and asks it. Restoring the constant makes these fail.
 */
describe('the self-heal switch on the production wiring', () => {
  const ENV_NAME = 'CLAUDE_TEAM_OPENCODE_PRIMARY_LANE_SELF_HEAL_ENABLED';
  const request = {
    teamName: 'team-a',
    laneId: 'primary',
    memberName: 'team-lead',
    runId: 'run-wiring',
    reason: 'opencode_primary_lane_bootstrap_missing',
  };

  afterEach(() => {
    delete process.env[ENV_NAME];
  });

  function selfHealPortOf(service: ReturnType<typeof createService>) {
    let port:
      | ((input: typeof request) => Promise<{ action: string }>)
      | undefined;
    const withCapture = service as unknown as {
      createOpenCodeMemberMessageDeliveryService(): unknown;
      deps: { createDeliveryHost(): Record<string, unknown> };
    };
    const originalCreateHost = withCapture.deps.createDeliveryHost.bind(withCapture.deps);
    withCapture.deps.createDeliveryHost = () => originalCreateHost();
    const created = withCapture.createOpenCodeMemberMessageDeliveryService() as unknown as {
      deps?: { requestOpenCodePrimaryLaneRebootstrap?: typeof port };
    };
    port = created.deps?.requestOpenCodePrimaryLaneRebootstrap;
    return port;
  }

  it('stays off when the environment says nothing', async () => {
    const port = selfHealPortOf(createService());
    expect(port).toBeTypeOf('function');

    await expect(port?.(request)).resolves.toMatchObject({ action: 'give_up' });
  });

  it('turns on when the environment says so', async () => {
    process.env[ENV_NAME] = '1';
    const port = selfHealPortOf(createService());

    // Enabled: the ladder proceeds into its grace window instead of giving up.
    await expect(port?.(request)).resolves.toMatchObject({ action: 'wait' });
  });

  it('lets an explicit dependency override the environment', async () => {
    process.env[ENV_NAME] = '1';
    const port = selfHealPortOf(
      createService({
        isOpenCodePrimaryLaneSelfHealEnabled: () => false,
      } as Partial<TestDeps>)
    );

    await expect(port?.(request)).resolves.toMatchObject({ action: 'give_up' });
  });
});

function createService(
  overrides: Partial<TestDeps> = {}
): TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityService<TestSendRun> {
  return new TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityService(
    createDeps(overrides)
  );
}

function createDeps(overrides: Partial<TestDeps> = {}): TestDeps {
  return {
    createDeliveryHost: vi.fn(() => deliveryHostWithUnavailableBridge()),
    inboxRelayHost: {
      getOpenCodeMemberRelayKey: vi.fn((teamName, memberName) => `relay/${teamName}/${memberName}`),
      scheduleOpenCodeMemberInboxDeliveryWake: vi.fn(),
      isOpenCodeRuntimeRecipient: vi.fn(async () => true),
      createOpenCodePromptDeliveryLedger: vi.fn(() => ({})),
      requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: vi.fn(
        async ({ ledgerRecord }) => ledgerRecord
      ),
      requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded: vi.fn(
        async ({ ledgerRecord }) => ledgerRecord
      ),
      isOpenCodeDeliveryResponseReadCommitAllowed: vi.fn(async () => true),
      markInboxMessagesRead: vi.fn(async () => undefined),
      logOpenCodePromptDeliveryEvent: vi.fn(),
      markOpenCodePromptLedgerFailedTerminal: vi.fn(async () => ({}) as never),
      deliverOpenCodeMemberMessage: vi.fn(async () => ({ delivered: true })),
    } as unknown as TestDeps['inboxRelayHost'],
    getInboxReader: vi.fn(() => ({
      getMessagesFor: vi.fn(async () => []),
    })),
    getAttachmentStore: vi.fn(() => ({
      getAttachments: vi.fn(async () => []),
    })),
    getOpenCodeRuntimeRecoveryIdentity: vi.fn(() => ({
      resolveOpenCodeMemberDeliveryIdentity: vi.fn(async () => ({
        ok: true as const,
        canonicalMemberName: 'worker',
        laneId: 'lane-worker',
        laneIdentity: {
          laneId: 'lane-worker',
          laneKind: 'secondary' as const,
        },
      })),
      resolveCurrentOpenCodeRuntimeRunId: vi.fn(async () => 'runtime-run-1'),
    })),
    getOpenCodeVisibleReplyProofService: vi.fn(() => ({
      applyDestinationProof: vi.fn(async ({ ledgerRecord }) => ({
        ledgerRecord,
        visibleReply: null,
      })),
    })),
    getCleanedStoppedTeamOpenCodeRuntimeLanes: vi.fn(() => ({
      has: vi.fn(() => false),
    })),
    isCurrentTrackedRun: vi.fn(() => true),
    setLeadActivity: vi.fn(),
    resolveLeadActivityRun: vi.fn(() => null),
    readLeadActivityDirectory: vi.fn(async () => ({
      config: null,
      teamMeta: null,
      metaMembers: [],
    })),
    logger: {
      warn: vi.fn(),
    },
    nowIso: vi.fn(() => '2026-01-01T00:00:00.000Z'),
    getErrorMessage: vi.fn((error) => (error instanceof Error ? error.message : String(error))),
    ...overrides,
  };
}

function deliveryHostWithUnavailableBridge(): TeamProvisioningOpenCodeMemberMessageDeliveryHost {
  return {
    getOpenCodeRuntimeMessageAdapter: vi.fn(() => null),
    createOpenCodeRuntimeBootstrapEvidencePorts: vi.fn(),
  } as unknown as TeamProvisioningOpenCodeMemberMessageDeliveryHost;
}

function runtimeResult(memberName: string): OpenCodeTeamRuntimeMessageResult {
  return {
    ok: true,
    providerId: 'opencode',
    memberName,
    diagnostics: [],
  };
}

function inboxMessageWithStoredAttachment(): InboxMessage & { messageId: string } {
  return {
    from: 'user',
    to: 'worker',
    text: 'hello',
    timestamp: '2026-01-01T00:00:00.000Z',
    read: false,
    messageId: 'message-1',
    attachments: [
      {
        id: 'attachment-1',
        filename: 'note.txt',
        mimeType: '',
        size: 5,
      },
    ],
  };
}
