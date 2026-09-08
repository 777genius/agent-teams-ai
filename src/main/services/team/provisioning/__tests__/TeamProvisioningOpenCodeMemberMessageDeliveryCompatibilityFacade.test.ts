import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type OpenCodeMemberInboxRelayResult,
  relayOpenCodeMemberInboxMessagesWithPorts,
} from '../TeamProvisioningOpenCodeMemberInboxRelay';
import {
  OPENCODE_LEAD_ACTIVE_FALLBACK_MS,
  TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityService,
  type TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityServiceDeps,
} from '../TeamProvisioningOpenCodeMemberMessageDeliveryCompatibilityFacade';

import type { OpenCodeLeadTurnActivityNotification } from '../../opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
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
    const run = trackedRun();
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

  describe('lead active fallback', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('drops a lead turn back to idle when no settle signal ever arrives', async () => {
      const run = trackedRun();
      const setLeadActivity = vi.fn();
      const service = createService({
        setLeadActivity,
        resolveLeadActivityRun: () => run,
      });

      await service.notifyOpenCodeLeadTurnActivity(leadTurnActivity('active'));
      vi.advanceTimersByTime(OPENCODE_LEAD_ACTIVE_FALLBACK_MS - 1);
      expect(setLeadActivity.mock.calls).toEqual([[run, 'active']]);

      vi.advanceTimersByTime(1);
      expect(setLeadActivity.mock.calls).toEqual([
        [run, 'active'],
        [run, 'idle'],
      ]);
    });

    it('unrefs the fallback timer so it cannot hold the process open', async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const service = createService({ resolveLeadActivityRun: () => trackedRun() });

      await service.notifyOpenCodeLeadTurnActivity(leadTurnActivity('active'));

      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      const timer = setTimeoutSpy.mock.results[0]?.value as { hasRef(): boolean };
      expect(timer.hasRef()).toBe(false);
      setTimeoutSpy.mockRestore();
    });

    it('restarts a single fallback timer instead of accumulating one per active report', async () => {
      const run = trackedRun();
      const setLeadActivity = vi.fn();
      const service = createService({
        setLeadActivity,
        resolveLeadActivityRun: () => run,
      });

      await service.notifyOpenCodeLeadTurnActivity(leadTurnActivity('active'));
      vi.advanceTimersByTime(OPENCODE_LEAD_ACTIVE_FALLBACK_MS - 1);
      await service.notifyOpenCodeLeadTurnActivity(leadTurnActivity('active'));
      expect(vi.getTimerCount()).toBe(1);

      // The first timer would have fired here if it had not been cleared.
      vi.advanceTimersByTime(1);
      expect(setLeadActivity.mock.calls).toEqual([
        [run, 'active'],
        [run, 'active'],
      ]);

      vi.advanceTimersByTime(OPENCODE_LEAD_ACTIVE_FALLBACK_MS);
      expect(setLeadActivity.mock.calls).toEqual([
        [run, 'active'],
        [run, 'active'],
        [run, 'idle'],
      ]);
    });

    it('never writes idle twice when a real settle signal beats the fallback', async () => {
      const run = trackedRun();
      const setLeadActivity = vi.fn();
      const service = createService({
        setLeadActivity,
        resolveLeadActivityRun: () => run,
      });

      await service.notifyOpenCodeLeadTurnActivity(leadTurnActivity('active'));
      await service.notifyOpenCodeLeadTurnActivity(leadTurnActivity('idle'));
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(OPENCODE_LEAD_ACTIVE_FALLBACK_MS * 2);

      expect(setLeadActivity.mock.calls).toEqual([
        [run, 'active'],
        [run, 'idle'],
      ]);
      expect(setLeadActivity.mock.calls.filter(([, state]) => state === 'idle')).toHaveLength(1);
    });

    it('arms nothing for a team with no tracked run, and no-ops when the run disappears', async () => {
      const setLeadActivity = vi.fn();
      const serviceWithoutRun = createService({
        setLeadActivity,
        resolveLeadActivityRun: () => null,
      });

      await expect(
        serviceWithoutRun.notifyOpenCodeLeadTurnActivity(leadTurnActivity('active'))
      ).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      expect(setLeadActivity).not.toHaveBeenCalled();

      let trackedRunOrNull: TestSendRun | null = trackedRun();
      const serviceLosingRun = createService({
        setLeadActivity,
        resolveLeadActivityRun: () => trackedRunOrNull,
      });

      await serviceLosingRun.notifyOpenCodeLeadTurnActivity(leadTurnActivity('active'));
      trackedRunOrNull = null;

      expect(() => vi.advanceTimersByTime(OPENCODE_LEAD_ACTIVE_FALLBACK_MS)).not.toThrow();
      expect(setLeadActivity.mock.calls).toEqual([[expect.anything(), 'active']]);
    });

    it('never arms the fallback for a notification the lead activity guards drop', async () => {
      const run = trackedRun();
      const setLeadActivity = vi.fn();
      const service = createService({
        setLeadActivity,
        resolveLeadActivityRun: () => run,
      });

      for (const dropped of [
        { ...leadTurnActivity('active'), laneId: 'secondary:opencode:builder' },
        { ...leadTurnActivity('active'), runId: null },
        { ...leadTurnActivity('active'), memberName: 'builder' },
        { ...leadTurnActivity('active'), runId: 'replacement-run' },
      ]) {
        await service.notifyOpenCodeLeadTurnActivity(dropped);
        expect(vi.getTimerCount()).toBe(0);
      }

      vi.advanceTimersByTime(OPENCODE_LEAD_ACTIVE_FALLBACK_MS * 2);
      expect(setLeadActivity).not.toHaveBeenCalled();
    });

    it('keeps a live turn fallback armed when a dropped notification arrives behind it', async () => {
      const run = trackedRun();
      const setLeadActivity = vi.fn();
      const service = createService({
        setLeadActivity,
        resolveLeadActivityRun: () => run,
      });

      await service.notifyOpenCodeLeadTurnActivity(leadTurnActivity('active'));
      await service.notifyOpenCodeLeadTurnActivity({
        ...leadTurnActivity('idle'),
        runId: 'replacement-run',
      });
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(OPENCODE_LEAD_ACTIVE_FALLBACK_MS);
      expect(setLeadActivity.mock.calls).toEqual([
        [run, 'active'],
        [run, 'idle'],
      ]);
    });
  });
});

function trackedRun(): TestSendRun {
  return {
    teamName: 'team-a',
    runId: 'run-1',
    processKilled: false,
    cancelRequested: false,
    request: {},
    child: null,
  } satisfies TestSendRun;
}

function leadTurnActivity(state: 'active' | 'idle'): OpenCodeLeadTurnActivityNotification {
  return {
    teamName: 'team-a',
    memberName: 'team-lead',
    laneId: 'primary',
    runId: 'run-1',
    state,
  };
}

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
