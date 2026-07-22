import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildRuntimeDestinationMessageId,
  createRuntimeDeliveryJournalStore,
  hashRuntimeDeliveryEnvelope,
  normalizeRuntimeDeliveryEnvelope,
  resolveRuntimeDeliveryDestination,
} from '../../opencode/delivery/RuntimeDeliveryJournal';
import {
  getOpenCodeLaneScopedRuntimeFilePath,
  writeOpenCodeRuntimeLaneIndex,
} from '../../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import {
  canonicalizeRuntimeDeliveryJournalRecordIdentities,
  createOpenCodeRuntimeDeliveryPorts,
  createOpenCodeRuntimeDeliveryService,
  createTeamProvisioningOpenCodeRuntimeDeliveryBoundary,
  getOpenCodeRuntimeDeliveryStatus,
  getOpenCodeRuntimeRecoveryLaneIds,
  recoverOpenCodeRuntimeDeliveryJournal,
  type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryPorts,
} from '../TeamProvisioningOpenCodeRuntimeDelivery';

import type { OpenCodePromptDeliveryLedgerRecord } from '../../opencode/delivery/OpenCodePromptDeliveryLedger';
import type { OpenCodeRuntimeDeliveryCrossTeamSender } from '../../opencode/delivery/OpenCodeRuntimeDeliveryPorts';
import type {
  RuntimeDeliveryEnvelope,
  RuntimeDeliveryJournalRecord,
} from '../../opencode/delivery/RuntimeDeliveryJournal';
import type { RuntimeDeliveryDestinationPort } from '../../opencode/delivery/RuntimeDeliveryService';
import type { OpenCodeRuntimeCheckinRun } from '../TeamProvisioningOpenCodeRuntimeCheckin';
import type { InboxMessage, PersistedTeamLaunchSnapshot, SendMessageRequest } from '@shared/types';

describe('TeamProvisioningOpenCodeRuntimeDelivery', () => {
  it('canonicalizes remote lead aliases before payload hashing and journal begin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-delivery-aliases-'));
    const sentMessages: InboxMessage[] = [];
    const crossTeamSender: OpenCodeRuntimeDeliveryCrossTeamSender = vi.fn(
      async (request: Parameters<OpenCodeRuntimeDeliveryCrossTeamSender>[0]) => ({
        deliveredToInbox: true,
        messageId: request.messageId ?? 'cross-message-1',
        toTeam: request.toTeam,
        toMember: 'Captain',
      })
    );
    const destinationPorts = createOpenCodeRuntimeDeliveryPorts({
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
        sendMessage: vi.fn(),
      },
      getCrossTeamSender: () => crossTeamSender,
    });
    const delivery = createOpenCodeRuntimeDeliveryService('Team', 'primary', {
      teamsBasePath: directory,
      resolveCurrentOpenCodeRuntimeRunId: async () => 'run-1',
      readConfigForStrictDecision: async (teamName) =>
        teamName === 'Team'
          ? {
              name: 'Source Team',
              members: [{ name: 'Builder', agentType: 'team-lead' }],
            }
          : teamName === 'other-team'
            ? {
                name: 'Other Team',
                members: [
                  { name: 'Captain', role: 'Lead', agentType: 'team-lead' },
                  { name: 'Reviewer', role: 'Reviewer' },
                ],
              }
            : null,
      readMetaMembers: async () => [],
      createOpenCodeRuntimeDeliveryPorts: () => destinationPorts,
      emitTeamChange: vi.fn(),
      logger: { warn: vi.fn() },
    });

    try {
      const first = await delivery.deliver(
        createDeliveryEnvelope({
          to: { teamName: 'other-team', memberName: 'lead' },
        })
      );
      const teamLeadAlias = await delivery.deliver(
        createDeliveryEnvelope({
          to: { teamName: 'other-team', memberName: 'TEAM-LEAD' },
        })
      );
      const caseAlias = await delivery.deliver(
        createDeliveryEnvelope({
          to: { teamName: 'other-team', memberName: 'cApTaIn' },
        })
      );

      expect(first).toMatchObject({
        ok: true,
        delivered: true,
        location: { toTeamName: 'other-team', toMemberName: 'Captain' },
      });
      expect(teamLeadAlias).toMatchObject({
        ok: true,
        delivered: false,
        reason: 'duplicate',
        location: { toTeamName: 'other-team', toMemberName: 'Captain' },
      });
      expect(caseAlias).toMatchObject({
        ok: true,
        delivered: false,
        reason: 'duplicate',
        location: { toTeamName: 'other-team', toMemberName: 'Captain' },
      });
      expect(crossTeamSender).toHaveBeenCalledOnce();
      expect(crossTeamSender).toHaveBeenCalledWith(
        expect.objectContaining({ toMember: 'Captain' })
      );
      await expectCommittedCaptainJournal(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('filters a removed metadata lead for the actual delivery target and journal location', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-delivery-metadata-lead-'));
    const sentMessages: InboxMessage[] = [];
    const crossTeamSender: OpenCodeRuntimeDeliveryCrossTeamSender = vi.fn(
      async (request: Parameters<OpenCodeRuntimeDeliveryCrossTeamSender>[0]) => ({
        deliveredToInbox: true,
        messageId: request.messageId ?? 'cross-message-1',
        toTeam: request.toTeam,
        toMember: 'Captain',
      })
    );
    const destinationPorts = createOpenCodeRuntimeDeliveryPorts({
      sentMessagesStore: {
        appendMessage: vi.fn(async (_teamName: string, message: InboxMessage) => {
          sentMessages.push(message);
        }),
        readMessages: vi.fn(async () => sentMessages),
      },
      inboxReader: { getMessagesFor: vi.fn(async () => []) },
      inboxWriter: { sendMessage: vi.fn() },
      getCrossTeamSender: () => crossTeamSender,
    });
    const delivery = createOpenCodeRuntimeDeliveryService('Team', 'primary', {
      teamsBasePath: directory,
      resolveCurrentOpenCodeRuntimeRunId: async () => 'run-1',
      readConfigForStrictDecision: async (teamName) => ({
        name: teamName,
        members: teamName === 'Team' ? [{ name: 'Builder', agentType: 'team-lead' }] : [],
      }),
      readMetaMembers: async (teamName) =>
        teamName === 'other-team'
          ? [
              {
                name: 'OldLead',
                agentType: 'team-lead',
                providerId: 'codex',
                removedAt: 1,
              },
              { name: 'Captain', agentType: 'team-lead', providerId: 'codex' },
            ]
          : [],
      createOpenCodeRuntimeDeliveryPorts: () => destinationPorts,
      emitTeamChange: vi.fn(),
      logger: { warn: vi.fn() },
    });

    try {
      const first = await delivery.deliver(
        createDeliveryEnvelope({ to: { teamName: 'other-team', memberName: 'team-lead' } })
      );
      const retry = await delivery.deliver(
        createDeliveryEnvelope({ to: { teamName: 'other-team', memberName: 'lead' } })
      );

      expect(first).toMatchObject({
        ok: true,
        delivered: true,
        location: { toTeamName: 'other-team', toMemberName: 'Captain' },
      });
      expect(retry).toMatchObject({
        ok: true,
        delivered: false,
        reason: 'duplicate',
        location: { toTeamName: 'other-team', toMemberName: 'Captain' },
      });
      expect(crossTeamSender).toHaveBeenCalledOnce();
      expect(crossTeamSender).toHaveBeenCalledWith(
        expect.objectContaining({ toMember: 'Captain' })
      );
      await expectCommittedCaptainJournal(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('resolves an active metadata-only non-lead for the actual delivery target', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-delivery-metadata-member-'));
    const sentMessages: InboxMessage[] = [];
    const crossTeamSender: OpenCodeRuntimeDeliveryCrossTeamSender = vi.fn(async (request) => ({
      deliveredToInbox: true,
      messageId: request.messageId ?? 'cross-message-1',
      toTeam: request.toTeam,
      toMember: request.toMember,
    }));
    const delivery = createOpenCodeRuntimeDeliveryService('Team', 'primary', {
      teamsBasePath: directory,
      resolveCurrentOpenCodeRuntimeRunId: async () => 'run-1',
      readConfigForStrictDecision: async (teamName) => ({
        name: teamName,
        members: teamName === 'Team' ? [{ name: 'Builder', agentType: 'team-lead' }] : [],
      }),
      readMetaMembers: async (teamName) =>
        teamName === 'other-team'
          ? [
              { name: 'Captain', agentType: 'team-lead' },
              { name: 'MetadataWorker', agentType: 'developer' },
            ]
          : [],
      createOpenCodeRuntimeDeliveryPorts: () =>
        createOpenCodeRuntimeDeliveryPorts({
          sentMessagesStore: {
            appendMessage: vi.fn(async (_teamName: string, message: InboxMessage) => {
              sentMessages.push(message);
            }),
            readMessages: vi.fn(async () => sentMessages),
          },
          inboxReader: { getMessagesFor: vi.fn(async () => []) },
          inboxWriter: { sendMessage: vi.fn() },
          getCrossTeamSender: () => crossTeamSender,
        }),
      emitTeamChange: vi.fn(),
      logger: { warn: vi.fn() },
    });

    try {
      await expect(
        delivery.deliver(
          createDeliveryEnvelope({
            to: { teamName: 'other-team', memberName: 'metadataworker' },
          })
        )
      ).resolves.toMatchObject({
        ok: true,
        delivered: true,
        location: { toTeamName: 'other-team', toMemberName: 'MetadataWorker' },
      });
      expect(crossTeamSender).toHaveBeenCalledOnce();
      expect(crossTeamSender).toHaveBeenCalledWith(
        expect.objectContaining({ toMember: 'MetadataWorker' })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('canonicalizes sender aliases before idempotency checks and rejects true mismatches', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-delivery-sender-alias-'));
    const sentMessages: InboxMessage[] = [];
    const crossTeamSender: OpenCodeRuntimeDeliveryCrossTeamSender = vi.fn(async (request) => ({
      deliveredToInbox: true,
      messageId: request.messageId ?? 'cross-message-1',
      toTeam: request.toTeam,
      toMember: request.toMember,
    }));
    const delivery = createOpenCodeRuntimeDeliveryService('Team', 'primary', {
      teamsBasePath: directory,
      resolveCurrentOpenCodeRuntimeRunId: async () => 'run-1',
      readConfigForStrictDecision: async (teamName) => ({
        name: teamName,
        members:
          teamName === 'Team'
            ? [
                { name: 'Builder', agentType: 'team-lead' },
                { name: 'Reviewer', agentType: 'developer' },
              ]
            : [{ name: 'Captain', agentType: 'team-lead' }],
      }),
      readMetaMembers: async () => [],
      createOpenCodeRuntimeDeliveryPorts: () =>
        createOpenCodeRuntimeDeliveryPorts({
          sentMessagesStore: {
            appendMessage: vi.fn(async (_teamName: string, message: InboxMessage) => {
              sentMessages.push(message);
            }),
            readMessages: vi.fn(async () => sentMessages),
          },
          inboxReader: { getMessagesFor: vi.fn(async () => []) },
          inboxWriter: { sendMessage: vi.fn() },
          getCrossTeamSender: () => crossTeamSender,
        }),
      emitTeamChange: vi.fn(),
      logger: { warn: vi.fn() },
    });
    const target = { teamName: 'other-team', memberName: 'Captain' };

    try {
      await expect(delivery.deliver(createDeliveryEnvelope({ to: target }))).resolves.toMatchObject(
        {
          ok: true,
          delivered: true,
        }
      );
      await expect(
        delivery.deliver(createDeliveryEnvelope({ fromMemberName: 'bUiLdEr', to: target }))
      ).resolves.toMatchObject({
        ok: true,
        delivered: false,
        reason: 'duplicate',
      });
      await expect(
        delivery.deliver(createDeliveryEnvelope({ fromMemberName: 'Reviewer', to: target }))
      ).resolves.toMatchObject({
        ok: false,
        delivered: false,
        reason: 'idempotency_conflict',
      });

      expect(crossTeamSender).toHaveBeenCalledOnce();
      expect(crossTeamSender).toHaveBeenCalledWith(
        expect.objectContaining({ fromMember: 'Builder' })
      );
      expect(sentMessages).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a sender identity tombstoned by raw metadata before journal selection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-delivery-removed-sender-'));
    const delivery = createOpenCodeRuntimeDeliveryService('Team', 'primary', {
      teamsBasePath: directory,
      resolveCurrentOpenCodeRuntimeRunId: async () => 'run-1',
      readConfigForStrictDecision: async () => ({
        name: 'Team',
        members: [{ name: 'Builder', agentType: 'team-lead' }],
      }),
      readMetaMembers: async () => [{ name: 'builder', agentType: 'team-lead', removedAt: 1 }],
      createOpenCodeRuntimeDeliveryPorts: () =>
        createOpenCodeRuntimeDeliveryPorts({
          sentMessagesStore: { appendMessage: vi.fn(), readMessages: vi.fn(async () => []) },
          inboxReader: { getMessagesFor: vi.fn(async () => []) },
          inboxWriter: { sendMessage: vi.fn() },
          getCrossTeamSender: () => null,
        }),
      emitTeamChange: vi.fn(),
      logger: { warn: vi.fn() },
    });

    try {
      await expect(delivery.deliver(createDeliveryEnvelope())).rejects.toThrow(
        'Unknown toMember: Builder'
      );
      const journal = createRuntimeDeliveryJournalStore({
        filePath: getOpenCodeLaneScopedRuntimeFilePath({
          teamsBasePath: directory,
          teamName: 'Team',
          laneId: 'primary',
          fileName: 'opencode-delivery-journal.json',
        }),
      });
      await expect(journal.list()).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'unavailable',
      metaMembers: [],
      message: 'Cross-team target lead identity is unavailable',
    },
    {
      label: 'ambiguous',
      metaMembers: [
        { name: 'Captain', agentType: 'team-lead' },
        { name: 'Commander', agentType: 'lead' },
      ],
      message: 'Ambiguous active team lead identity',
    },
  ])('fails closed before delivery when remote lead identity is $label', async (test) => {
    const directory = await mkdtemp(join(tmpdir(), `runtime-delivery-${test.label}-`));
    const crossTeamSender: OpenCodeRuntimeDeliveryCrossTeamSender = vi.fn();
    const delivery = createOpenCodeRuntimeDeliveryService('Team', 'primary', {
      teamsBasePath: directory,
      resolveCurrentOpenCodeRuntimeRunId: async () => 'run-1',
      readConfigForStrictDecision: async (teamName) => ({
        name: teamName,
        members: teamName === 'Team' ? [{ name: 'Builder', agentType: 'team-lead' }] : [],
      }),
      readMetaMembers: async (teamName) => (teamName === 'other-team' ? test.metaMembers : []),
      createOpenCodeRuntimeDeliveryPorts: () =>
        createOpenCodeRuntimeDeliveryPorts({
          sentMessagesStore: {
            appendMessage: vi.fn(),
            readMessages: vi.fn(async () => []),
          },
          inboxReader: { getMessagesFor: vi.fn(async () => []) },
          inboxWriter: { sendMessage: vi.fn() },
          getCrossTeamSender: () => crossTeamSender,
        }),
      emitTeamChange: vi.fn(),
      logger: { warn: vi.fn() },
    });

    try {
      await expect(
        delivery.deliver(
          createDeliveryEnvelope({ to: { teamName: 'other-team', memberName: 'team-lead' } })
        )
      ).rejects.toThrow(test.message);
      expect(crossTeamSender).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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
          read: false,
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
        found: false,
        location: null,
        diagnostics: ['cross-team target runtime proof required'],
      });

      sentMessages[0] = { ...sentMessages[0], to: 'other-team.team-lead' };

      await expect(
        crossTeamPort.verify({
          destination,
          destinationMessageId: 'cross-message-1',
          location: { ...destination, toMemberName: 'team-lead' },
        })
      ).resolves.toMatchObject({
        found: false,
        location: null,
        diagnostics: ['cross-team target runtime proof mismatch'],
      });

      sentMessages[0] = { ...sentMessages[0], to: 'other-team.Reviewer' };

      await expect(
        crossTeamPort.verify({
          destination,
          destinationMessageId: 'cross-message-1',
          location: destination,
        })
      ).resolves.toMatchObject({
        found: true,
        location: destination,
      });
    });

    it('uses explicit target-runtime location instead of a sender copy for another member', async () => {
      const sentMessages: InboxMessage[] = [
        {
          from: 'Runtime',
          to: 'other-team.Captain',
          text: 'deduplicated delivery',
          timestamp: '2026-01-01T00:00:00.000Z',
          messageId: 'existing-cross-message',
          read: false,
        },
      ];
      const crossTeamSender = vi.fn(async () => ({
        deliveredToInbox: true,
        deduplicated: true,
        messageId: 'existing-cross-message',
        toTeam: 'other-team',
        toMember: 'lead',
      }));
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
          sendMessage: vi.fn(),
        },
        getCrossTeamSender: () => crossTeamSender,
      });
      const crossTeamPort = ports.find((port) => port.kind === 'cross_team_outbox');
      expect(crossTeamPort).toBeDefined();
      if (!crossTeamPort) {
        return;
      }

      const location = await crossTeamPort.write({
        envelope: createDeliveryEnvelope({
          to: { teamName: 'other-team', memberName: 'lead' },
        }),
        destinationMessageId: 'new-cross-message',
      });

      expect(location).toEqual({
        kind: 'cross_team_outbox',
        fromTeamName: 'Team',
        toTeamName: 'other-team',
        toMemberName: 'lead',
        messageId: 'existing-cross-message',
      });
      expect(sentMessages).toContainEqual(
        expect.objectContaining({
          to: 'other-team.lead',
          messageId: 'existing-cross-message',
        })
      );
      await expect(
        crossTeamPort.verify({
          destination: {
            kind: 'cross_team_outbox',
            fromTeamName: 'Team',
            toTeamName: 'other-team',
            toMemberName: 'lead',
          },
          destinationMessageId: 'new-cross-message',
          location,
        })
      ).resolves.toMatchObject({
        found: true,
        location,
      });
    });

    it.each([
      {
        kind: 'user_sent_messages' as const,
        destination: { kind: 'user_sent_messages' as const, teamName: 'Team' },
        location: undefined,
        to: 'user',
        source: 'lead_process' as const,
      },
      {
        kind: 'member_inbox' as const,
        destination: { kind: 'member_inbox' as const, teamName: 'Team', memberName: 'Reviewer' },
        location: {
          kind: 'member_inbox' as const,
          teamName: 'Team',
          memberName: 'Reviewer',
          messageId: 'pre-canonical-message-1',
        },
        to: 'Reviewer',
        source: 'inbox' as const,
      },
    ])('requires exact $kind proof when migrating a sender-case alias', async (test) => {
      const message = createDeliveryEnvelope({
        to: test.kind === 'user_sent_messages' ? 'user' : { memberName: 'Reviewer' },
      });
      const destinationMessageId = 'pre-canonical-message-1';
      const persistedMessage: InboxMessage = {
        from: 'builder',
        to: test.to,
        text: message.text,
        timestamp: message.createdAt,
        messageId: destinationMessageId,
        read: true,
        source: test.source,
        leadSessionId: message.runtimeSessionId,
      };
      const ports = createOpenCodeRuntimeDeliveryPorts({
        sentMessagesStore: {
          appendMessage: vi.fn(),
          readMessages: vi.fn(async () => [persistedMessage]),
        },
        inboxReader: { getMessagesFor: vi.fn(async () => [persistedMessage]) },
        inboxWriter: { sendMessage: vi.fn() },
        getCrossTeamSender: () => null,
      });
      const port = ports.find((candidate) => candidate.kind === test.kind);
      expect(port).toBeDefined();
      if (!port) {
        return;
      }
      const verifyInput = {
        destination: test.destination,
        destinationMessageId,
        ...(test.location ? { location: test.location } : {}),
        preCanonicalRecovery: {
          envelope: message,
          canonicalDestination: test.destination,
        },
      };

      await expect(port.verify(verifyInput)).resolves.toMatchObject({ found: true });
      persistedMessage.text = 'different payload';
      await expect(port.verify(verifyInput)).resolves.toMatchObject({ found: false });
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

  describe('getOpenCodeRuntimeDeliveryStatus', () => {
    it('uses the newest cross-lane record when a delivery was retried after lane migration', async () => {
      const teamsBasePath = await mkdtemp(join(tmpdir(), 'opencode-delivery-status-'));
      const staleFailure = createPromptDeliveryRecord({
        id: 'delivery-old',
        laneId: 'lane-old',
        status: 'failed_terminal',
        responseState: 'tool_error',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      const successfulRetry = createPromptDeliveryRecord({
        id: 'delivery-new',
        laneId: 'lane-new',
        status: 'responded',
        responseState: 'responded_visible_message',
        visibleReplyMessageId: 'reply-1',
        updatedAt: '2026-01-01T00:01:00.000Z',
      });
      const decideOpenCodeRuntimeDeliveryUserFacingAdvisory = vi.fn(async (record) => ({
        record,
        decision: { action: 'suppress' as const },
      }));

      try {
        await writeOpenCodeRuntimeLaneIndex(teamsBasePath, 'Team', {
          version: 1,
          updatedAt: '2026-01-01T00:01:00.000Z',
          lanes: {
            'lane-old': {
              laneId: 'lane-old',
              state: 'stopped',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
            'lane-new': {
              laneId: 'lane-new',
              state: 'active',
              updatedAt: '2026-01-01T00:01:00.000Z',
            },
          },
        });

        const status = await getOpenCodeRuntimeDeliveryStatus('Team', 'message-1', {
          teamsBasePath,
          createOpenCodePromptDeliveryLedger: (_teamName, laneId) =>
            ({
              list: vi.fn(async () => (laneId === 'lane-old' ? [staleFailure] : [successfulRetry])),
            }) as never,
          decideOpenCodeRuntimeDeliveryUserFacingAdvisory,
        });

        expect(decideOpenCodeRuntimeDeliveryUserFacingAdvisory).toHaveBeenCalledTimes(1);
        expect(decideOpenCodeRuntimeDeliveryUserFacingAdvisory).toHaveBeenCalledWith(
          successfulRetry
        );
        expect(status).toMatchObject({
          delivered: true,
          ledgerRecordId: 'delivery-new',
          ledgerStatus: 'responded',
          laneId: 'lane-new',
          responsePending: false,
        });
      } finally {
        await rm(teamsBasePath, { recursive: true, force: true });
      }
    });

    it.each([
      {
        name: 'candidate valid updatedAt is later than current valid updatedAt',
        current: {
          updatedAt: '2026-01-01T00:01:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        candidate: {
          updatedAt: '2026-01-01T00:02:00.000Z',
          createdAt: '2026-01-01T00:00:30.000Z',
        },
        expectedRecordId: 'delivery-candidate',
      },
      {
        name: 'candidate valid updatedAt is earlier than current valid updatedAt',
        current: {
          updatedAt: '2026-01-01T00:02:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        candidate: {
          updatedAt: '2026-01-01T00:01:00.000Z',
          createdAt: '2026-01-01T00:03:00.000Z',
        },
        expectedRecordId: 'delivery-current',
      },
      {
        name: 'candidate invalid updatedAt falls back to an earlier createdAt',
        current: {
          updatedAt: '2026-01-01T00:02:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        candidate: {
          updatedAt: 'invalid',
          createdAt: '2026-01-01T00:01:00.000Z',
        },
        expectedRecordId: 'delivery-current',
      },
      {
        name: 'current invalid updatedAt falls back to an earlier createdAt',
        current: {
          updatedAt: 'invalid',
          createdAt: '2026-01-01T00:01:00.000Z',
        },
        candidate: {
          updatedAt: '2026-01-01T00:02:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        expectedRecordId: 'delivery-candidate',
      },
      {
        name: 'candidate empty updatedAt falls back to a later createdAt',
        current: {
          updatedAt: '2026-01-01T00:01:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        candidate: {
          updatedAt: '',
          createdAt: '2026-01-01T00:02:00.000Z',
        },
        expectedRecordId: 'delivery-candidate',
      },
      {
        name: 'candidate omitted timestamps cannot replace a valid current timestamp',
        current: {
          updatedAt: '2026-01-01T00:01:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        candidate: {},
        expectedRecordId: 'delivery-current',
      },
      {
        name: 'candidate valid createdAt replaces current empty and omitted timestamps',
        current: { updatedAt: '' },
        candidate: {
          updatedAt: 'invalid',
          createdAt: '2026-01-01T00:01:00.000Z',
        },
        expectedRecordId: 'delivery-candidate',
      },
      {
        name: 'equal effective timestamps retain the current record',
        current: {
          updatedAt: '2026-01-01T00:01:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        candidate: {
          updatedAt: 'invalid',
          createdAt: '2026-01-01T00:01:00.000Z',
        },
        expectedRecordId: 'delivery-current',
      },
      {
        name: 'entirely invalid timestamps retain the current record',
        current: { updatedAt: 'invalid', createdAt: '' },
        candidate: {},
        expectedRecordId: 'delivery-current',
      },
    ])('$name', async ({ current, candidate, expectedRecordId }) => {
      const teamsBasePath = await mkdtemp(join(tmpdir(), 'opencode-delivery-status-ordering-'));
      const currentRecord = createPromptDeliveryRecordWithTimestamps({
        id: 'delivery-current',
        laneId: 'lane-current',
        timestamps: current,
      });
      const candidateRecord = createPromptDeliveryRecordWithTimestamps({
        id: 'delivery-candidate',
        laneId: 'lane-candidate',
        timestamps: candidate,
      });
      const decideOpenCodeRuntimeDeliveryUserFacingAdvisory = vi.fn(async (record) => ({
        record,
        decision: { action: 'suppress' as const },
      }));

      try {
        await writeOpenCodeRuntimeLaneIndex(teamsBasePath, 'Team', {
          version: 1,
          updatedAt: '2026-01-01T00:03:00.000Z',
          lanes: {
            'lane-current': {
              laneId: 'lane-current',
              state: 'stopped',
              updatedAt: '2026-01-01T00:01:00.000Z',
            },
            'lane-candidate': {
              laneId: 'lane-candidate',
              state: 'active',
              updatedAt: '2026-01-01T00:02:00.000Z',
            },
          },
        });

        const status = await getOpenCodeRuntimeDeliveryStatus('Team', 'message-1', {
          teamsBasePath,
          createOpenCodePromptDeliveryLedger: (_teamName, laneId) =>
            ({
              list: vi.fn(async () =>
                laneId === 'lane-current' ? [currentRecord] : [candidateRecord]
              ),
            }) as never,
          decideOpenCodeRuntimeDeliveryUserFacingAdvisory,
        });

        expect(decideOpenCodeRuntimeDeliveryUserFacingAdvisory).toHaveBeenCalledOnce();
        expect(decideOpenCodeRuntimeDeliveryUserFacingAdvisory).toHaveBeenCalledWith(
          expectedRecordId === currentRecord.id ? currentRecord : candidateRecord
        );
        expect(status?.ledgerRecordId).toBe(expectedRecordId);
      } finally {
        await rm(teamsBasePath, { recursive: true, force: true });
      }
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

  describe('journal identity recovery', () => {
    it.each(['builder', 'BUILDER', 'Builder'])(
      'canonicalizes %s journal sender and recipient identities from config plus raw metadata',
      async (senderAlias) => {
        const record = createJournalRecord({
          fromMemberName: senderAlias,
          destination: {
            kind: 'cross_team_outbox',
            fromTeamName: 'Team',
            toTeamName: 'Other',
            toMemberName: 'captain',
          },
        });

        await expect(
          canonicalizeRuntimeDeliveryJournalRecordIdentities(
            record,
            async (teamName) => ({
              name: teamName,
              members:
                teamName === 'Team'
                  ? [{ name: 'Builder', agentType: 'team-lead' }]
                  : [{ name: 'Captain', agentType: 'team-lead' }],
            }),
            async () => []
          )
        ).resolves.toMatchObject({
          fromMemberName: 'Builder',
          destination: { kind: 'cross_team_outbox', toMemberName: 'Captain' },
        });
      }
    );

    it('wires canonical config and raw metadata into production journal reconciliation', async () => {
      const teamsBasePath = await mkdtemp(join(tmpdir(), 'runtime-delivery-recovery-identity-'));
      const verify = vi.fn(
        async (_input: Parameters<RuntimeDeliveryDestinationPort['verify']>[0]) => ({
          found: false,
          location: null,
          diagnostics: ['not found'],
        })
      );
      const destinationPort: RuntimeDeliveryDestinationPort = {
        kind: 'member_inbox',
        write: vi.fn(),
        verify,
        buildChangeEvent: vi.fn(() => null),
      };
      const readConfigForStrictDecision = vi.fn(async () => ({
        name: 'Team',
        members: [
          { name: 'Builder', agentType: 'team-lead' },
          { name: 'Worker', agentType: 'developer' },
        ],
      }));
      const readMetaMembers = vi.fn(async () => []);

      try {
        const message = createDeliveryEnvelope({
          fromMemberName: 'bUiLdEr',
          to: { memberName: 'worker' },
        });
        const journal = createRuntimeDeliveryJournalStore({
          filePath: getOpenCodeLaneScopedRuntimeFilePath({
            teamsBasePath,
            teamName: 'Team',
            laneId: 'primary',
            fileName: 'opencode-delivery-journal.json',
          }),
        });
        await journal.begin({
          idempotencyKey: message.idempotencyKey,
          payloadHash: hashRuntimeDeliveryEnvelope(message),
          runId: message.runId,
          teamName: message.teamName,
          fromMemberName: message.fromMemberName,
          providerId: message.providerId,
          runtimeSessionId: message.runtimeSessionId,
          destination: resolveRuntimeDeliveryDestination(message),
          destinationMessageId: buildRuntimeDestinationMessageId(message),
          now: message.createdAt,
        });

        await recoverOpenCodeRuntimeDeliveryJournal('Team', {
          teamsBasePath,
          createOpenCodeRuntimeDeliveryPorts: () => [destinationPort],
          readConfigForStrictDecision,
          readMetaMembers,
          readLaunchState: async () => null,
          nowIso: () => '2026-01-01T00:00:00.000Z',
          logger: { warn: vi.fn() },
        });

        const verifyInput = verify.mock.calls[0]?.[0];
        expect(verifyInput).toMatchObject({
          destination: { kind: 'member_inbox', teamName: 'Team', memberName: 'Worker' },
          destinationMessageId: buildRuntimeDestinationMessageId(message),
        });
        expect(verifyInput?.includeRecoveryEvidence).toBe(true);
        expect(readConfigForStrictDecision).toHaveBeenCalledWith('Team');
        expect(readMetaMembers).toHaveBeenCalledWith('Team');
      } finally {
        await rm(teamsBasePath, { recursive: true, force: true });
      }
    });

    it('fails journal recovery closed when config and metadata contain distinct active leads', async () => {
      const teamsBasePath = await mkdtemp(join(tmpdir(), 'runtime-delivery-recovery-ambiguous-'));
      const verify = vi.fn();
      const destinationPort: RuntimeDeliveryDestinationPort = {
        kind: 'user_sent_messages',
        write: vi.fn(),
        verify,
        buildChangeEvent: vi.fn(() => null),
      };

      try {
        const message = createDeliveryEnvelope({ fromMemberName: 'builder' });
        const journal = createRuntimeDeliveryJournalStore({
          filePath: getOpenCodeLaneScopedRuntimeFilePath({
            teamsBasePath,
            teamName: 'Team',
            laneId: 'primary',
            fileName: 'opencode-delivery-journal.json',
          }),
        });
        await journal.begin({
          idempotencyKey: message.idempotencyKey,
          payloadHash: hashRuntimeDeliveryEnvelope(message),
          runId: message.runId,
          teamName: message.teamName,
          fromMemberName: message.fromMemberName,
          providerId: message.providerId,
          runtimeSessionId: message.runtimeSessionId,
          destination: resolveRuntimeDeliveryDestination(message),
          destinationMessageId: buildRuntimeDestinationMessageId(message),
          now: message.createdAt,
        });

        await expect(
          recoverOpenCodeRuntimeDeliveryJournal('Team', {
            teamsBasePath,
            createOpenCodeRuntimeDeliveryPorts: () => [destinationPort],
            readConfigForStrictDecision: async () => ({
              name: 'Team',
              members: [{ name: 'Builder', agentType: 'team-lead' }],
            }),
            readMetaMembers: async () => [{ name: 'Captain', agentType: 'team-lead' }],
            readLaunchState: async () => null,
            nowIso: () => '2026-01-01T00:00:00.000Z',
            logger: { warn: vi.fn() },
          })
        ).rejects.toThrow('Ambiguous active team lead identity: Builder, Captain');
        expect(verify).not.toHaveBeenCalled();
      } finally {
        await rm(teamsBasePath, { recursive: true, force: true });
      }
    });
  });
});

async function expectCommittedCaptainJournal(teamsBasePath: string): Promise<void> {
  const journal = createRuntimeDeliveryJournalStore({
    filePath: getOpenCodeLaneScopedRuntimeFilePath({
      teamsBasePath,
      teamName: 'Team',
      laneId: 'primary',
      fileName: 'opencode-delivery-journal.json',
    }),
  });
  const record = (await journal.list()).find((candidate) => candidate.status === 'committed');
  expect(record).toBeDefined();
  expect(record?.destination).toMatchObject({
    kind: 'cross_team_outbox',
    toMemberName: 'Captain',
  });
  expect(record?.committedLocation).toMatchObject({
    kind: 'cross_team_outbox',
    toMemberName: 'Captain',
  });
}

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

function createJournalRecord(
  overrides: Partial<RuntimeDeliveryJournalRecord> = {}
): RuntimeDeliveryJournalRecord {
  return {
    idempotencyKey: 'message-key-1',
    runId: 'run-1',
    teamName: 'Team',
    fromMemberName: 'Builder',
    providerId: 'opencode',
    runtimeSessionId: 'session-1',
    payloadHash: 'payload-hash',
    logicalPayloadHash: 'payload-hash',
    destination: { kind: 'user_sent_messages', teamName: 'Team' },
    destinationMessageId: 'runtime-delivery-message-key-1',
    committedLocation: null,
    status: 'pending',
    attempts: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    committedAt: null,
    lastError: null,
    ...overrides,
  };
}

function createPromptDeliveryRecord(
  overrides: Partial<OpenCodePromptDeliveryLedgerRecord> = {}
): OpenCodePromptDeliveryLedgerRecord {
  return {
    id: 'delivery-1',
    teamName: 'Team',
    memberName: 'Builder',
    laneId: 'primary',
    inboxMessageId: 'message-1',
    status: 'pending',
    responseState: 'not_observed',
    acceptanceUnknown: false,
    runtimePromptMessageIds: [],
    visibleReplyMessageId: null,
    visibleReplyCorrelation: null,
    acceptedAt: null,
    deliveredUserMessageId: null,
    runtimePromptMessageId: null,
    lastRuntimePromptMessageId: null,
    lastReason: null,
    diagnostics: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as OpenCodePromptDeliveryLedgerRecord;
}

function createPromptDeliveryRecordWithTimestamps(input: {
  id: string;
  laneId: string;
  timestamps: { createdAt?: string; updatedAt?: string };
}): OpenCodePromptDeliveryLedgerRecord {
  const record = createPromptDeliveryRecord({
    id: input.id,
    laneId: input.laneId,
    createdAt: input.timestamps.createdAt ?? '',
    updatedAt: input.timestamps.updatedAt ?? '',
  });
  const persistedRecord = record as unknown as {
    createdAt?: string;
    updatedAt?: string;
  };
  if (input.timestamps.createdAt === undefined) {
    delete persistedRecord.createdAt;
  }
  if (input.timestamps.updatedAt === undefined) {
    delete persistedRecord.updatedAt;
  }
  return record;
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
