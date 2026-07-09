import { describe, expect, it, vi } from 'vitest';

import { normalizeRuntimeDeliveryEnvelope } from '../../opencode/delivery/RuntimeDeliveryJournal';
import {
  createOpenCodeRuntimeDeliveryPorts,
  createTeamProvisioningOpenCodeRuntimeDeliveryBoundary,
  getOpenCodeRuntimeRecoveryLaneIds,
  type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryPorts,
} from '../TeamProvisioningOpenCodeRuntimeDelivery';

import type { OpenCodeRuntimeDeliveryCrossTeamSender } from '../../opencode/delivery/OpenCodeRuntimeDeliveryPorts';
import type { RuntimeDeliveryEnvelope } from '../../opencode/delivery/RuntimeDeliveryJournal';
import type { OpenCodeRuntimeCheckinRun } from '../TeamProvisioningOpenCodeRuntimeCheckin';
import type { InboxMessage, PersistedTeamLaunchSnapshot, SendMessageRequest } from '@shared/types';

describe('TeamProvisioningOpenCodeRuntimeDelivery', () => {
  describe('createOpenCodeRuntimeDeliveryPorts', () => {
    it('creates the runtime destination ports used by OpenCode delivery', () => {
      const ports = createOpenCodeRuntimeDeliveryPorts({
        sentMessagesStore: {
          appendMessage: vi.fn(),
          readMessages: vi.fn(),
        },
        inboxReader: {
          getMessagesFor: vi.fn(),
        },
        inboxWriter: {
          sendMessage: vi.fn(),
        },
        getCrossTeamSender: () => vi.fn(),
      });

      expect(ports.map((port) => port.kind)).toEqual([
        'user_sent_messages',
        'member_inbox',
        'cross_team_outbox',
      ]);
    });

    it('verifies cross-team delivery against the requested target member', async () => {
      const sentMessages: InboxMessage[] = [
        {
          from: 'Runtime',
          to: 'other-team.team-lead',
          text: 'delivered elsewhere',
          timestamp: '2026-01-01T00:00:00.000Z',
          messageId: 'cross-message-1',
        },
      ];
      const ports = createOpenCodeRuntimeDeliveryPorts({
        sentMessagesStore: {
          appendMessage: vi.fn(),
          readMessages: vi.fn(async () => sentMessages),
        },
        inboxReader: {
          getMessagesFor: vi.fn(async () => []),
        },
        inboxWriter: {
          sendMessage: vi.fn(),
        },
        getCrossTeamSender: () => vi.fn(),
      });
      const crossTeamPort = ports.find((port) => port.kind === 'cross_team_outbox');
      expect(crossTeamPort).toBeDefined();
      if (!crossTeamPort) {
        return;
      }

      const destination = {
        kind: 'cross_team_outbox' as const,
        fromTeamName: 'team-alpha',
        toTeamName: 'other-team',
        toMemberName: 'Reviewer',
        messageId: 'cross-message-1',
      };

      await expect(
        crossTeamPort.verify({ destination, destinationMessageId: 'cross-message-1' })
      ).resolves.toMatchObject({ found: false, location: null });

      sentMessages[0] = { ...sentMessages[0], to: 'other-team.Reviewer' };

      await expect(
        crossTeamPort.verify({ destination, destinationMessageId: 'cross-message-1' })
      ).resolves.toMatchObject({
        found: true,
        location: destination,
      });
    });

    it('preserves structured task refs in sent, inbox, and cross-team messages', async () => {
      const taskRefs = [{ taskId: 'task-1', displayId: '#1', teamName: 'Team' }];
      const sentMessages: InboxMessage[] = [];
      const inboxRequests: SendMessageRequest[] = [];
      const crossTeamRequests: Parameters<OpenCodeRuntimeDeliveryCrossTeamSender>[0][] = [];
      const ports = createOpenCodeRuntimeDeliveryPorts({
        sentMessagesStore: {
          appendMessage: vi.fn(async (_teamName: string, message: InboxMessage) => {
            sentMessages.push(message);
          }),
          readMessages: vi.fn(async () => sentMessages),
        },
        inboxReader: {
          getMessagesFor: vi.fn(async () => []),
        },
        inboxWriter: {
          sendMessage: vi.fn(async (_teamName: string, request: SendMessageRequest) => {
            inboxRequests.push(request);
            return {
              deliveredToInbox: true,
              messageId: request.messageId ?? 'member-message-1',
            };
          }),
        },
        getCrossTeamSender: () => async (request) => {
          crossTeamRequests.push(request);
          return { deliveredToInbox: true, messageId: request.messageId ?? 'cross-message-1' };
        },
      });

      const userPort = ports.find((port) => port.kind === 'user_sent_messages');
      const memberPort = ports.find((port) => port.kind === 'member_inbox');
      const crossTeamPort = ports.find((port) => port.kind === 'cross_team_outbox');
      expect(userPort).toBeDefined();
      expect(memberPort).toBeDefined();
      expect(crossTeamPort).toBeDefined();
      if (!userPort || !memberPort || !crossTeamPort) {
        return;
      }

      await userPort.write({
        envelope: createDeliveryEnvelope({ to: 'user', taskRefs }),
        destinationMessageId: 'user-message-1',
      });
      await memberPort.write({
        envelope: createDeliveryEnvelope({ to: { memberName: 'Reviewer' }, taskRefs }),
        destinationMessageId: 'member-message-1',
      });
      await crossTeamPort.write({
        envelope: createDeliveryEnvelope({
          to: { teamName: 'other-team', memberName: 'Reviewer' },
          taskRefs,
        }),
        destinationMessageId: 'cross-message-1',
      });

      expect(sentMessages[0]?.taskRefs).toEqual(taskRefs);
      expect(inboxRequests[0]?.taskRefs).toEqual(taskRefs);
      expect(crossTeamRequests[0]?.taskRefs).toEqual(taskRefs);
      expect(crossTeamRequests[0]?.toMember).toBe('Reviewer');
    });
  });

  describe('normalizeRuntimeDeliveryEnvelope', () => {
    it('accepts structured task refs and rejects legacy strings after runtime-control ingress', () => {
      expect(
        normalizeRuntimeDeliveryEnvelope({
          ...createDeliveryEnvelope(),
          taskRefs: [{ taskId: ' task-1 ', displayId: ' #1 ', teamName: ' Team ' }],
        }).taskRefs
      ).toEqual([{ taskId: 'task-1', displayId: '#1', teamName: 'Team' }]);

      expect(() =>
        normalizeRuntimeDeliveryEnvelope({
          ...createDeliveryEnvelope(),
          taskRefs: ['task-1'],
        })
      ).toThrow('Runtime delivery envelope taskRefs[0] must be a TaskRef');
    });
  });

  describe('createTeamProvisioningOpenCodeRuntimeDeliveryBoundary', () => {
    it('normalizes member inbox delivery wake scheduling', () => {
      const scheduleOpenCodePromptDeliveryWatchdog = vi.fn();
      const boundary = createBoundary({
        scheduleOpenCodePromptDeliveryWatchdog,
      });

      boundary.scheduleOpenCodeMemberInboxDeliveryWake({
        teamName: ' Team ',
        memberName: ' Builder ',
        messageId: ' message-1 ',
        delayMs: -25,
      });
      boundary.scheduleOpenCodeMemberInboxDeliveryWake({
        teamName: 'Team',
        memberName: 'Builder',
        messageId: 'message-2',
      });

      expect(scheduleOpenCodePromptDeliveryWatchdog).toHaveBeenNthCalledWith(1, {
        teamName: 'Team',
        memberName: 'Builder',
        messageId: 'message-1',
        delayMs: 0,
      });
      expect(scheduleOpenCodePromptDeliveryWatchdog).toHaveBeenNthCalledWith(2, {
        teamName: 'Team',
        memberName: 'Builder',
        messageId: 'message-2',
        delayMs: 500,
      });
    });

    it('does not schedule member inbox delivery wake when disabled or identifiers are blank', () => {
      const scheduleOpenCodePromptDeliveryWatchdog = vi.fn();
      const boundary = createBoundary({
        isOpenCodePromptDeliveryWatchdogEnabled: () => false,
        scheduleOpenCodePromptDeliveryWatchdog,
      });

      boundary.scheduleOpenCodeMemberInboxDeliveryWake({
        teamName: 'Team',
        memberName: 'Builder',
        messageId: 'message-1',
      });
      createBoundary({
        scheduleOpenCodePromptDeliveryWatchdog,
      }).scheduleOpenCodeMemberInboxDeliveryWake({
        teamName: 'Team',
        memberName: ' ',
        messageId: 'message-2',
      });

      expect(scheduleOpenCodePromptDeliveryWatchdog).not.toHaveBeenCalled();
    });
  });

  describe('getOpenCodeRuntimeRecoveryLaneIds', () => {
    it('prefers lane index keys when the runtime lane index has entries', () => {
      expect(
        getOpenCodeRuntimeRecoveryLaneIds({
          laneIndexEntries: {
            primary: { laneId: 'primary' },
            'lane-builder': { laneId: 'secondary-builder' },
          },
          launchSnapshot: snapshotWithMembers({
            builder: {
              laneId: 'snapshot-builder',
              laneOwnerProviderId: 'opencode',
            },
          }),
        })
      ).toEqual(['primary', 'lane-builder']);
    });

    it('falls back to unique OpenCode lane ids from the launch snapshot', () => {
      expect(
        getOpenCodeRuntimeRecoveryLaneIds({
          laneIndexEntries: {},
          launchSnapshot: snapshotWithMembers({
            builder: {
              laneId: ' secondary-builder ',
              laneOwnerProviderId: 'opencode',
            },
            reviewer: {
              laneId: 'secondary-builder',
              laneOwnerProviderId: 'opencode',
            },
            designer: {
              laneId: 'secondary-designer',
              laneOwnerProviderId: 'opencode',
            },
            nativeMember: {
              laneId: 'native-lane',
              laneOwnerProviderId: 'anthropic',
            },
          }),
        })
      ).toEqual(['secondary-builder', 'secondary-designer']);
    });

    it('defaults to the primary lane when no lane evidence exists', () => {
      expect(
        getOpenCodeRuntimeRecoveryLaneIds({
          laneIndexEntries: {},
          launchSnapshot: snapshotWithMembers({}),
        })
      ).toEqual(['primary']);
    });
  });
});

function createDeliveryEnvelope(
  overrides: Partial<RuntimeDeliveryEnvelope> = {}
): RuntimeDeliveryEnvelope {
  return {
    idempotencyKey: 'message-key-1',
    runId: 'run-1',
    teamName: 'Team',
    fromMemberName: 'Builder',
    providerId: 'opencode',
    runtimeSessionId: 'session-1',
    to: 'user',
    text: 'Delivered text',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createBoundary(
  overrides: Partial<
    TeamProvisioningOpenCodeRuntimeDeliveryBoundaryPorts<OpenCodeRuntimeCheckinRun>
  > = {}
): ReturnType<typeof createTeamProvisioningOpenCodeRuntimeDeliveryBoundary> {
  const ports: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryPorts<OpenCodeRuntimeCheckinRun> = {
    getTeamsBasePath: () => '/workspace/teams',
    resolveOpenCodeRuntimeLaneId: async () => 'primary',
    resolveCurrentOpenCodeRuntimeRunId: async () => 'run-1',
    readLaunchState: async () => null,
    writeLaunchState: async () => {},
    readConfigForStrictDecision: async () => null,
    readMetaMembers: async () => [],
    readPersistedRuntimeMembers: () => [],
    getTrackedRun: () => null,
    persistTrackedRunLaunchState: async () => {},
    invalidateRuntimeSnapshotCaches: () => {},
    emitMemberSpawnChange: () => {},
    emitTeamChange: () => {},
    createOpenCodeRuntimeBootstrapEvidencePorts: () => {
      throw new Error('unused');
    },
    upsertOpenCodeTaskRecord: async () => {
      throw new Error('unused');
    },
    syncMemberTaskActivityForRuntimeTransition: () => {},
    syncMemberLaunchGraceCheck: () => {},
    sentMessagesStore: {
      appendMessage: vi.fn(),
      readMessages: vi.fn(),
    },
    inboxReader: {
      getMessagesFor: vi.fn(),
    },
    inboxWriter: {
      sendMessage: vi.fn(),
    },
    getCrossTeamSender: () => null,
    logger: {
      warn: vi.fn(),
    },
    isOpenCodeRuntimeRecipient: async () => true,
    getOpenCodeAgendaSyncRecoveryBypassMessageIds: async () => new Set(),
    resolveOpenCodeMemberDeliveryIdentity: async () => ({
      ok: true,
      canonicalMemberName: 'Builder',
      laneId: 'primary',
    }),
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: async () => true,
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: async () => true,
    decideOpenCodeRuntimeDeliveryUserFacingAdvisory: async (record) => ({
      record,
      decision: { action: 'defer' },
    }),
    isOpenCodePromptDeliveryWatchdogEnabled: () => true,
    scheduleOpenCodePromptDeliveryWatchdog: vi.fn(),
    readLaunchStateForDeliveryRecovery: async () => null,
    nowIso: () => '2026-01-01T00:00:00.000Z',
    ...overrides,
  };

  return createTeamProvisioningOpenCodeRuntimeDeliveryBoundary(ports);
}

function snapshotWithMembers(
  members: Record<string, Partial<Pick<PersistedTeamLaunchSnapshot, 'members'>['members'][string]>>
): Pick<PersistedTeamLaunchSnapshot, 'members'> {
  return {
    members: members as Pick<PersistedTeamLaunchSnapshot, 'members'>['members'],
  };
}
