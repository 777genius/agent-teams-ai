import { beforeEach, describe, expect, it, vi } from 'vitest';

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
