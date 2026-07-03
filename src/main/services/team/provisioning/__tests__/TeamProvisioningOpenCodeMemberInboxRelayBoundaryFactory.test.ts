import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamTaskReader } from '../../TeamTaskReader';
import {
  type OpenCodeMemberInboxRelayResult,
  type RelayOpenCodeMemberInboxMessagesPorts,
  relayOpenCodeMemberInboxMessagesWithPorts,
} from '../TeamProvisioningOpenCodeMemberInboxRelay';
import {
  createTeamProvisioningOpenCodeMemberInboxRelayBoundary,
  type TeamProvisioningOpenCodeMemberInboxRelayBoundaryDeps,
} from '../TeamProvisioningOpenCodeMemberInboxRelayBoundaryFactory';

import type { OpenCodeMemberIdentityResolution } from '../../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from '../../opencode/delivery/OpenCodePromptDeliveryLedger';
import type { InboxMessage, TeamTask } from '@shared/types';

const getTasksMock = vi.hoisted(() => vi.fn());

vi.mock('../../TeamTaskReader', () => ({
  TeamTaskReader: vi.fn(() => ({
    getTasks: getTasksMock,
  })),
}));

vi.mock('../TeamProvisioningOpenCodeMemberInboxRelay', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../TeamProvisioningOpenCodeMemberInboxRelay')>();
  return {
    ...actual,
    relayOpenCodeMemberInboxMessagesWithPorts: vi.fn(),
  };
});

const relayWithPortsMock = vi.mocked(relayOpenCodeMemberInboxMessagesWithPorts);
const teamTaskReaderMock = vi.mocked(TeamTaskReader);

describe('TeamProvisioningOpenCodeMemberInboxRelayBoundaryFactory', () => {
  beforeEach(() => {
    relayWithPortsMock.mockReset();
    teamTaskReaderMock.mockClear();
    getTasksMock.mockReset();
  });

  it('delegates relay calls through the extracted ports boundary', async () => {
    const result: OpenCodeMemberInboxRelayResult = {
      relayed: 1,
      attempted: 1,
      delivered: 1,
      failed: 0,
    };
    const deps = createDeps();
    const options = {
      onlyMessageId: 'message-1',
      source: 'ui-send' as const,
    };

    relayWithPortsMock.mockImplementationOnce(async (input, ports) => {
      expect(input).toEqual({
        teamName: 'team-a',
        memberName: 'worker',
        relayKey: 'relay/team-a/worker',
        options,
      });

      await ports.readInboxMessages('team-a', 'worker');
      ports.scheduleOpenCodeMemberInboxDeliveryWake({
        teamName: 'team-a',
        memberName: 'worker',
        messageId: 'message-1',
        delayMs: 500,
      });
      await ports.isOpenCodeRuntimeRecipient('team-a', 'worker');
      await ports.resolveOpenCodeMemberDeliveryIdentity('team-a', 'worker');
      ports.createOpenCodePromptDeliveryLedger('team-a', 'lane-worker');
      await ports.requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded({
        ledger: {} as OpenCodePromptDeliveryLedgerStore,
        ledgerRecord: ledgerRecord(),
      });
      await ports.requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded({
        ledger: {} as OpenCodePromptDeliveryLedgerStore,
        ledgerRecord: ledgerRecord(),
      });
      await ports.applyDestinationProof({
        ledger: {} as OpenCodePromptDeliveryLedgerStore,
        ledgerRecord: ledgerRecord(),
        teamName: 'team-a',
        replyRecipient: 'user',
        memberName: 'worker',
      });
      await ports.isOpenCodeDeliveryResponseReadCommitAllowed({
        teamName: 'team-a',
        memberName: 'worker',
        taskRefs: [],
        ledgerRecord: ledgerRecord(),
      });
      await ports.markInboxMessagesRead('team-a', 'worker', [inboxMessage()]);
      ports.logOpenCodePromptDeliveryEvent('event', ledgerRecord(), { extra: true });
      await ports.readTaskRefInferenceTasks('team-a');
      await ports.resolveOpenCodeInboxAttachmentPayloads({
        teamName: 'team-a',
        message: inboxMessage(),
      });
      await ports.resolveCurrentOpenCodeRuntimeRunId('team-a', 'lane-worker');
      await ports.markOpenCodePromptLedgerFailedTerminal({
        ledger: {} as OpenCodePromptDeliveryLedgerStore,
        id: 'record-1',
        reason: 'reason',
        failedAt: '2026-01-01T00:00:00.000Z',
      });
      await ports.deliverOpenCodeMemberMessage('team-a', {} as never);
      ports.suppressRuntimeInactiveWarning('team-a');
      ports.logWarning('warning');
      ports.nowIso();
      ports.getErrorMessage(new Error('boom'));

      return result;
    });

    const boundary = createTeamProvisioningOpenCodeMemberInboxRelayBoundary(deps);

    await expect(
      boundary.relayOpenCodeMemberInboxMessages('team-a', 'worker', options)
    ).resolves.toBe(result);

    expect(deps.host.getOpenCodeMemberRelayKey).toHaveBeenCalledWith('team-a', 'worker');
    expect(deps.getInboxReader().getMessagesFor).toHaveBeenCalledWith('team-a', 'worker');
    expect(deps.host.scheduleOpenCodeMemberInboxDeliveryWake).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'worker',
      messageId: 'message-1',
      delayMs: 500,
    });
    expect(
      deps.openCodeInboxAttachmentPayloadBoundary.resolveOpenCodeInboxAttachmentPayloads
    ).toHaveBeenCalledWith({
      teamName: 'team-a',
      message: inboxMessage(),
    });
    expect(deps.cleanedStoppedTeamOpenCodeRuntimeLanes.has).toHaveBeenCalledWith('team-a');
    expect(deps.logger.warn).toHaveBeenCalledWith('warning');
  });

  it('keeps the task-reader fallback local to the boundary and preserves catch-to-empty behavior', async () => {
    getTasksMock.mockRejectedValueOnce(new Error('read failed'));
    relayWithPortsMock.mockImplementationOnce(async (_input, ports) => {
      await expect(ports.readTaskRefInferenceTasks('team-a')).resolves.toEqual([]);
      return {
        relayed: 0,
        attempted: 0,
        delivered: 0,
        failed: 0,
      };
    });

    const boundary = createTeamProvisioningOpenCodeMemberInboxRelayBoundary(
      createDeps({ readTaskRefInferenceTasks: undefined })
    );

    await boundary.relayOpenCodeMemberInboxMessages('team-a', 'worker');

    expect(teamTaskReaderMock).toHaveBeenCalledTimes(1);
    expect(getTasksMock).toHaveBeenCalledWith('team-a');
  });
});

function createDeps(
  overrides: Partial<TeamProvisioningOpenCodeMemberInboxRelayBoundaryDeps> = {}
): TeamProvisioningOpenCodeMemberInboxRelayBoundaryDeps {
  const inboxReader = {
    getMessagesFor: vi.fn(async () => [inboxMessage()]),
  };

  return {
    host: {
      getOpenCodeMemberRelayKey: vi.fn((teamName, memberName) => `relay/${teamName}/${memberName}`),
      scheduleOpenCodeMemberInboxDeliveryWake: vi.fn(),
      isOpenCodeRuntimeRecipient: vi.fn(async () => true),
      createOpenCodePromptDeliveryLedger: vi.fn(() => ({}) as OpenCodePromptDeliveryLedgerStore),
      requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: vi
        .fn<
          RelayOpenCodeMemberInboxMessagesPorts['requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded']
        >()
        .mockImplementation(async ({ ledgerRecord }) => ledgerRecord),
      requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded: vi
        .fn<
          RelayOpenCodeMemberInboxMessagesPorts['requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded']
        >()
        .mockImplementation(async ({ ledgerRecord }) => ledgerRecord),
      isOpenCodeDeliveryResponseReadCommitAllowed: vi.fn(async () => true),
      markInboxMessagesRead: vi.fn(async () => undefined),
      logOpenCodePromptDeliveryEvent: vi.fn(),
      markOpenCodePromptLedgerFailedTerminal: vi.fn(async () => ledgerRecord()),
      deliverOpenCodeMemberMessage: vi.fn(async () => ({
        delivered: true,
      })),
    },
    inFlight: new Map(),
    getInboxReader: vi.fn(() => inboxReader),
    openCodeRuntimeRecoveryIdentity: {
      resolveOpenCodeMemberDeliveryIdentity: vi.fn(async () => identityResolution()),
      resolveCurrentOpenCodeRuntimeRunId: vi.fn(async () => 'run-1'),
    },
    getOpenCodeVisibleReplyProofService: vi.fn(() => ({
      applyDestinationProof: vi.fn(async ({ ledgerRecord }) => ({
        ledgerRecord,
        visibleReply: null,
      })),
    })),
    openCodeInboxAttachmentPayloadBoundary: {
      resolveOpenCodeInboxAttachmentPayloads: vi.fn(async () => ({
        ok: true,
        attachments: [],
      })),
    },
    cleanedStoppedTeamOpenCodeRuntimeLanes: {
      has: vi.fn(() => false),
    },
    readTaskRefInferenceTasks: vi.fn(async () => [teamTask()]),
    logger: {
      warn: vi.fn(),
    },
    nowIso: vi.fn(() => '2026-01-01T00:00:00.000Z'),
    getErrorMessage: vi.fn((error) => (error instanceof Error ? error.message : String(error))),
    ...overrides,
  };
}

function inboxMessage(): InboxMessage & { messageId: string } {
  return {
    from: 'user',
    to: 'worker',
    text: 'hello',
    timestamp: '2026-01-01T00:00:00.000Z',
    read: false,
    messageId: 'message-1',
  };
}

function identityResolution(): OpenCodeMemberIdentityResolution {
  return {
    ok: true,
    canonicalMemberName: 'worker',
    laneId: 'lane-worker',
    laneIdentity: { laneId: 'lane-worker', laneKind: 'secondary' },
  };
}

function ledgerRecord(): OpenCodePromptDeliveryLedgerRecord {
  return {
    id: 'record-1',
    teamName: 'team-a',
    memberName: 'worker',
    laneId: 'lane-worker',
    runId: null,
    inboxMessageId: 'message-1',
    inboxTimestamp: '2026-01-01T00:00:00.000Z',
    source: 'watcher',
    replyRecipient: 'user',
    actionMode: null,
    messageKind: null,
    workSyncIntent: null,
    taskRefs: [],
    payloadHash: 'sha256:payload',
    status: 'pending',
    attempts: 0,
    diagnostics: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as OpenCodePromptDeliveryLedgerRecord;
}

function teamTask(): TeamTask {
  return {
    id: 'task-1',
    title: 'Task',
    description: '',
    status: 'todo',
    priority: 'medium',
    assignee: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as TeamTask;
}
