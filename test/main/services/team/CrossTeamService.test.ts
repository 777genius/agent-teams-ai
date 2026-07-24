import {
  CrossTeamService,
  type CrossTeamRecipientMetadataReader,
} from '@main/services/team/CrossTeamService';
import { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';
import {
  CROSS_TEAM_SENT_SOURCE,
  CROSS_TEAM_SOURCE,
  parseCrossTeamPrefix,
} from '@shared/constants/crossTeam';
import * as agentTeamsController from 'agent-teams-controller';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import type { TeamDataService } from '@main/services/team/TeamDataService';
import type { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import type { CrossTeamSendRequest, TeamConfig } from '@shared/types';

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => `${process.cwd()}/.cross-team-test-nonexistent-dir-${process.pid}/teams`,
  getClaudeBasePath: () => `${process.cwd()}/.cross-team-test-nonexistent-dir-${process.pid}`,
}));

const MOCK_TEAMS_BASE_PATH = `${process.cwd()}/.cross-team-test-nonexistent-dir-${process.pid}`;

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function makeRequest(overrides: Partial<CrossTeamSendRequest> = {}): CrossTeamSendRequest {
  return {
    fromTeam: 'team-a',
    fromMember: 'lead',
    toTeam: 'team-b',
    text: 'Hello from team-a',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<TeamConfig> = {}): TeamConfig {
  return {
    name: 'team-b',
    members: [{ name: 'team-lead', agentType: 'team-lead' }],
    ...overrides,
  };
}

function writeControllerTeam(teamName: string, config: TeamConfig): void {
  const teamDir = path.join(MOCK_TEAMS_BASE_PATH, 'teams', teamName);
  fs.mkdirSync(path.join(teamDir, 'inboxes'), { recursive: true });
  fs.mkdirSync(path.join(MOCK_TEAMS_BASE_PATH, 'tasks', teamName), { recursive: true });
  fs.writeFileSync(path.join(teamDir, 'config.json'), JSON.stringify(config));
}

function createFilesystemCrossTeamService(
  messaging: TeamProvisioningService | null = null
): CrossTeamService {
  const filesystemConfigReader = {
    getConfig(teamName: string): Promise<TeamConfig | null> {
      const configPath = path.join(MOCK_TEAMS_BASE_PATH, 'teams', teamName, 'config.json');
      try {
        return Promise.resolve(JSON.parse(fs.readFileSync(configPath, 'utf8')) as TeamConfig);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Promise.resolve(null);
        throw error;
      }
    },
  };
  const filesystemDataService = {
    getLeadMemberName: vi.fn().mockResolvedValue(null),
    listTeams: vi.fn().mockResolvedValue([]),
  };

  return new CrossTeamService(
    filesystemConfigReader as TeamConfigReader,
    filesystemDataService as unknown as TeamDataService,
    new TeamInboxWriter(),
    messaging
  );
}

function readFixtureArray(filePath: string): unknown[] {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected fixture array at ${filePath}`);
  }
  return parsed;
}

describe('CrossTeamService', () => {
  let service: CrossTeamService;
  let configReader: { getConfig: ReturnType<typeof vi.fn> };
  let dataService: {
    getLeadMemberName: ReturnType<typeof vi.fn>;
    listTeams: ReturnType<typeof vi.fn>;
  };
  let recipientMetadataReader: {
    getMembers: ReturnType<typeof vi.fn>;
  };
  let inboxWriter: { sendMessage: ReturnType<typeof vi.fn> };
  let provisioning: {
    isTeamAlive: ReturnType<typeof vi.fn>;
    relayInboxFileToLiveRecipient: ReturnType<typeof vi.fn>;
    relayLeadInboxMessages: ReturnType<typeof vi.fn>;
    resolveCrossTeamReplyMetadata: ReturnType<typeof vi.fn>;
    registerPendingCrossTeamReplyExpectation: ReturnType<typeof vi.fn>;
    clearPendingCrossTeamReplyExpectation: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    fs.rmSync(MOCK_TEAMS_BASE_PATH, { recursive: true, force: true });
    configReader = {
      getConfig: vi.fn().mockResolvedValue(makeConfig()),
    };
    dataService = {
      getLeadMemberName: vi.fn().mockResolvedValue('team-lead'),
      listTeams: vi.fn().mockResolvedValue([]),
    };
    recipientMetadataReader = {
      getMembers: vi.fn<CrossTeamRecipientMetadataReader['getMembers']>().mockResolvedValue([]),
    };
    inboxWriter = {
      sendMessage: vi.fn().mockResolvedValue({ deliveredToInbox: true, messageId: 'mock-id' }),
    };
    provisioning = {
      isTeamAlive: vi.fn().mockReturnValue(false),
      relayInboxFileToLiveRecipient: vi.fn().mockResolvedValue({
        kind: 'native_lead',
        relayed: 0,
      }),
      relayLeadInboxMessages: vi.fn().mockResolvedValue(0),
      resolveCrossTeamReplyMetadata: vi.fn().mockReturnValue(null),
      registerPendingCrossTeamReplyExpectation: vi.fn(),
      clearPendingCrossTeamReplyExpectation: vi.fn(),
    };

    service = new CrossTeamService(
      configReader as unknown as TeamConfigReader,
      dataService as unknown as TeamDataService,
      inboxWriter as unknown as TeamInboxWriter,
      provisioning as unknown as TeamProvisioningService,
      recipientMetadataReader
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(MOCK_TEAMS_BASE_PATH, { recursive: true, force: true });
  });

  describe('send', () => {
    it('delivers message to inbox via inboxWriter', async () => {
      const result = await service.send(makeRequest());

      expect(result.deliveredToInbox).toBe(true);
      expect(result.messageId).toBeDefined();

      // Target team delivery goes through inboxWriter.
      const [teamName, req] = inboxWriter.sendMessage.mock.calls[0];
      expect(teamName).toBe('team-b');
      expect(req.member).toBe('team-lead');
      expect(req.source).toBe(CROSS_TEAM_SOURCE);
      expect(req.from).toBe('team-a.team-lead');
      expect(req.text).toContain('Hello from team-a');
      const prefix = parseCrossTeamPrefix(req.text);
      expect(prefix?.from).toBe('team-a.team-lead');
      expect(prefix?.chainDepth).toBe(0);
      expect(prefix?.conversationId).toBeTruthy();
    });

    it('filters a removed metadata lead and resolves the active metadata lead', async () => {
      configReader.getConfig.mockImplementation((teamName: string) =>
        Promise.resolve(teamName === 'team-b' ? makeConfig({ members: [] }) : makeConfig())
      );
      recipientMetadataReader.getMembers.mockResolvedValue([
        { name: 'OldLead', agentType: 'team-lead', removedAt: 1 },
        { name: 'Captain', agentType: 'team-lead' },
      ]);

      await expect(service.send(makeRequest())).resolves.toMatchObject({
        deliveredToInbox: true,
        toMember: 'Captain',
      });
      expect(inboxWriter.sendMessage).toHaveBeenCalledWith(
        'team-b',
        expect.objectContaining({ member: 'Captain' })
      );
      expect(dataService.getLeadMemberName).not.toHaveBeenCalled();
    });

    it('does not resurrect a configured direct member tombstoned by raw metadata', async () => {
      configReader.getConfig.mockImplementation((teamName: string) =>
        Promise.resolve(
          teamName === 'team-b'
            ? makeConfig({
                members: [
                  { name: 'Captain', agentType: 'team-lead' },
                  { name: 'Builder', agentType: 'developer' },
                ],
              })
            : makeConfig()
        )
      );
      recipientMetadataReader.getMembers.mockResolvedValue([
        { name: 'builder', agentType: 'developer', removedAt: 1 },
      ]);

      await expect(service.send(makeRequest({ toMember: 'BUILDER' }))).rejects.toThrow(
        'Unknown toMember: BUILDER'
      );
      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
    });

    it('fails closed before writing when the target lead identity is unavailable', async () => {
      configReader.getConfig.mockImplementation((teamName: string) =>
        Promise.resolve(teamName === 'team-b' ? makeConfig({ members: [] }) : makeConfig())
      );

      await expect(service.send(makeRequest())).rejects.toThrow(
        'Cross-team target lead identity is unavailable'
      );
      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
    });

    it('fails closed before writing when active metadata lead identity is ambiguous', async () => {
      configReader.getConfig.mockImplementation((teamName: string) =>
        Promise.resolve(teamName === 'team-b' ? makeConfig({ members: [] }) : makeConfig())
      );
      recipientMetadataReader.getMembers.mockResolvedValue([
        { name: 'Captain', agentType: 'team-lead' },
        { name: 'Commander', agentType: 'lead' },
      ]);

      await expect(service.send(makeRequest())).rejects.toThrow(
        'Ambiguous active team lead identity'
      );
      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
    });

    it('fails closed when config and metadata identify distinct active leads', async () => {
      configReader.getConfig.mockImplementation((teamName: string) =>
        Promise.resolve(
          teamName === 'team-b'
            ? makeConfig({ members: [{ name: 'Captain', agentType: 'team-lead' }] })
            : makeConfig()
        )
      );
      recipientMetadataReader.getMembers.mockResolvedValue([
        { name: 'Commander', agentType: 'team-lead' },
      ]);

      await expect(service.send(makeRequest())).rejects.toThrow(
        'Ambiguous active team lead identity: Captain, Commander'
      );
      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
    });

    it('resolves an active metadata-only non-lead recipient', async () => {
      configReader.getConfig.mockImplementation((teamName: string) =>
        Promise.resolve(teamName === 'team-b' ? makeConfig({ members: [] }) : makeConfig())
      );
      recipientMetadataReader.getMembers.mockResolvedValue([
        { name: 'Captain', agentType: 'team-lead' },
        { name: 'MetadataWorker', agentType: 'developer' },
      ]);

      await expect(
        service.send(makeRequest({ toMember: 'metadataworker' }))
      ).resolves.toMatchObject({
        deliveredToInbox: true,
        toMember: 'MetadataWorker',
      });
      expect(inboxWriter.sendMessage).toHaveBeenCalledWith(
        'team-b',
        expect.objectContaining({ member: 'MetadataWorker' })
      );
    });

    it('delivers and best-effort relays to an explicit target member when requested', async () => {
      configReader.getConfig.mockImplementation((teamName: string) =>
        Promise.resolve(
          teamName === 'team-b'
            ? makeConfig({
                name: 'team-b',
                members: [
                  { name: 'team-lead', agentType: 'team-lead' },
                  { name: 'worker', agentType: 'developer' },
                ],
              })
            : makeConfig({
                name: teamName,
                members: [{ name: 'team-lead', agentType: 'team-lead' }],
              })
        )
      );
      provisioning.isTeamAlive.mockReturnValue(true);
      provisioning.relayInboxFileToLiveRecipient.mockRejectedValue(new Error('relay fail'));

      const result = await service.send(makeRequest({ toMember: 'worker' }));

      const [teamName, req] = inboxWriter.sendMessage.mock.calls[0];
      expect(teamName).toBe('team-b');
      expect(req.member).toBe('worker');
      expect(result).toMatchObject({ deliveredToInbox: true, toMember: 'worker' });
      expect(provisioning.relayInboxFileToLiveRecipient).toHaveBeenCalledWith('team-b', 'worker', {
        onlyMessageId: result.messageId,
      });
      expect(provisioning.relayLeadInboxMessages).not.toHaveBeenCalled();

      const sentMessagesPath = `${MOCK_TEAMS_BASE_PATH}/teams/team-a/sentMessages.json`;
      const sentRows = JSON.parse(fs.readFileSync(sentMessagesPath, 'utf8')) as Record<
        string,
        unknown
      >[];
      expect(sentRows[0]?.to).toBe('team-b.worker');
    });

    it('injects a hidden action-mode block for the target lead only', async () => {
      await service.send(makeRequest({ actionMode: 'ask', text: 'Can you inspect this?' }));

      const [, req] = inboxWriter.sendMessage.mock.calls[0];
      expect(req.text).toContain('TURN ACTION MODE: ASK');
      expect(req.text).toContain('STRICTLY read-only conversation mode');
    });

    it('writes sender copy to sentMessages.json without touching the lead inbox', async () => {
      await service.send(makeRequest());

      expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);

      const sentMessagesPath = `${MOCK_TEAMS_BASE_PATH}/teams/team-a/sentMessages.json`;
      const raw = fs.readFileSync(sentMessagesPath, 'utf8');
      const sentRows = JSON.parse(raw) as Record<string, unknown>[];
      expect(sentRows).toHaveLength(1);
      expect(sentRows[0]?.from).toBe('team-lead');
      expect(sentRows[0]?.source).toBe(CROSS_TEAM_SENT_SOURCE);
      expect(sentRows[0]?.to).toBe('team-b.team-lead');
      expect(sentRows[0]?.text).toBe('Hello from team-a');
      expect(sentRows[0]?.messageId).toBe(inboxWriter.sendMessage.mock.calls[0][1].messageId);
      expect(sentRows[0]?.timestamp).toBe(inboxWriter.sendMessage.mock.calls[0][1].timestamp);
      expect(sentRows[0]?.conversationId).toBeTruthy();
    });

    it('reuses replyToConversationId as the conversationId for replies', async () => {
      await service.send(
        makeRequest({
          replyToConversationId: 'conv-123',
          text: 'Here is the answer',
        })
      );

      const [, req] = inboxWriter.sendMessage.mock.calls[0];
      expect(req.conversationId).toBe('conv-123');
      expect(req.replyToConversationId).toBe('conv-123');
    });

    it('auto-infers reply conversation metadata from provisioning hint when omitted', async () => {
      provisioning.resolveCrossTeamReplyMetadata.mockReturnValue({
        conversationId: 'conv-auto',
        replyToConversationId: 'conv-auto',
      });

      await service.send(makeRequest({ fromTeam: 'team-a', toTeam: 'team-b' }));

      const [, req] = inboxWriter.sendMessage.mock.calls[0];
      expect(req.conversationId).toBe('conv-auto');
      expect(req.replyToConversationId).toBe('conv-auto');
      expect(provisioning.resolveCrossTeamReplyMetadata).toHaveBeenCalledWith('team-a', 'team-b');
    });

    it('does not ask provisioning for reply metadata when request already carries conversation ids', async () => {
      await service.send(
        makeRequest({
          conversationId: 'conv-explicit',
          replyToConversationId: 'conv-explicit',
        })
      );

      expect(provisioning.resolveCrossTeamReplyMetadata).not.toHaveBeenCalled();
    });

    it('calls relayLeadInboxMessages when team is alive', async () => {
      provisioning.isTeamAlive.mockReturnValue(true);

      await service.send(makeRequest());

      expect(provisioning.relayLeadInboxMessages).toHaveBeenCalledWith('team-b');
    });

    it('writes sender copy before triggering live relay', async () => {
      const order: string[] = [];
      inboxWriter.sendMessage.mockImplementation((teamName: string) => {
        order.push(`write:${teamName}`);
        return Promise.resolve({ deliveredToInbox: true, messageId: 'mock-id' });
      });
      provisioning.registerPendingCrossTeamReplyExpectation.mockImplementation(() => {
        order.push('register:team-a->team-b');
      });
      provisioning.clearPendingCrossTeamReplyExpectation.mockImplementation(() => {
        order.push('clear:team-a->team-b');
      });
      provisioning.isTeamAlive.mockReturnValue(true);
      provisioning.relayLeadInboxMessages.mockImplementation(() => {
        order.push('relay:team-b');
        return Promise.resolve(0);
      });

      await service.send(makeRequest());

      expect(order).toEqual([
        'register:team-a->team-b',
        'write:team-b',
        'clear:team-a->team-b',
        'relay:team-b',
      ]);
      const sentMessagesPath = `${MOCK_TEAMS_BASE_PATH}/teams/team-a/sentMessages.json`;
      expect(fs.existsSync(sentMessagesPath)).toBe(true);
    });

    it('does not relay when team is offline', async () => {
      provisioning.isTeamAlive.mockReturnValue(false);

      await service.send(makeRequest());

      expect(provisioning.relayLeadInboxMessages).not.toHaveBeenCalled();
    });

    it('requires live runtime proof when requested by runtime delivery', async () => {
      provisioning.relayInboxFileToLiveRecipient.mockImplementation((_team, _member, options) => {
        return Promise.resolve({
          kind: 'native_lead',
          relayed: 1,
          recentlyDeliveredMessageId: options?.onlyMessageId,
        });
      });

      const result = await service.send(makeRequest({ requireRuntimeDelivery: true }));

      expect(result.deliveredToInbox).toBe(true);
      expect(result.toTeam).toBe('team-b');
      expect(result.toMember).toBe('team-lead');
      expect(provisioning.relayInboxFileToLiveRecipient).toHaveBeenCalledWith(
        'team-b',
        'team-lead',
        { onlyMessageId: result.messageId }
      );
      expect(provisioning.relayLeadInboxMessages).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', undefined],
      ['corrupt', 'not-an-iso-timestamp'],
    ])(
      'rejects a typed payload conflict when its durable runtime receipt is %s',
      async (_receiptKind, runtimeDeliveryAcceptedAt) => {
        provisioning.relayInboxFileToLiveRecipient.mockImplementation((_team, _member, options) =>
          Promise.resolve({
            kind: 'native_lead',
            relayed: 1,
            recentlyDeliveredMessageId: options?.onlyMessageId,
          })
        );
        const request = makeRequest({
          requireRuntimeDelivery: true,
          messageId: 'runtime-conflict-receipt-1',
          conversationId: 'runtime-conflict-conversation-1',
          timestamp: '2026-07-23T00:00:00.000Z',
          text: 'Original accepted payload',
        });
        await service.send(request);

        const outboxPath = path.join(
          MOCK_TEAMS_BASE_PATH,
          'teams',
          'team-a',
          'sent-cross-team.json'
        );
        const rows = readFixtureArray(outboxPath) as Record<string, unknown>[];
        if (runtimeDeliveryAcceptedAt === undefined) {
          delete rows[0]?.runtimeDeliveryAcceptedAt;
        } else if (rows[0]) {
          rows[0].runtimeDeliveryAcceptedAt = runtimeDeliveryAcceptedAt;
        }
        fs.writeFileSync(outboxPath, JSON.stringify(rows, null, 2));

        const error: unknown = await service
          .send({ ...request, text: 'Divergent retry payload' })
          .catch((candidate: unknown) => candidate);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          'runtime delivery receipt proof is missing or corrupt'
        );
        expect(error).not.toMatchObject({ code: 'idempotency_conflict' });
      }
    );

    it('classifies a divergent stable retry only after validating its durable runtime receipt', async () => {
      provisioning.relayInboxFileToLiveRecipient.mockImplementation((_team, _member, options) =>
        Promise.resolve({
          kind: 'native_lead',
          relayed: 1,
          recentlyDeliveredMessageId: options?.onlyMessageId,
        })
      );
      const request = makeRequest({
        requireRuntimeDelivery: true,
        messageId: 'runtime-conflict-receipt-valid-1',
        conversationId: 'runtime-conflict-conversation-valid-1',
        timestamp: '2026-07-23T00:00:00.000Z',
        text: 'Original accepted payload',
      });
      await service.send(request);

      await expect(
        service.send({ ...request, text: 'Divergent retry payload' })
      ).rejects.toMatchObject({
        code: 'idempotency_conflict',
      });
    });

    it('does not reuse an older row receipt when the exact conflicting outbox row has no receipt', async () => {
      provisioning.relayInboxFileToLiveRecipient.mockImplementation((_team, _member, options) =>
        Promise.resolve({
          kind: 'native_lead',
          relayed: 1,
          recentlyDeliveredMessageId: options?.onlyMessageId,
        })
      );
      const request = makeRequest({
        requireRuntimeDelivery: true,
        messageId: 'runtime-conflict-exact-row-1',
        conversationId: 'runtime-conflict-exact-row-conversation-1',
        timestamp: '2026-07-23T00:00:00.000Z',
        text: 'Original accepted payload',
      });
      await service.send(request);

      const outboxPath = path.join(MOCK_TEAMS_BASE_PATH, 'teams', 'team-a', 'sent-cross-team.json');
      const rows = readFixtureArray(outboxPath) as Record<string, unknown>[];
      rows.push({ ...rows[0] });
      delete rows[1]?.runtimeDeliveryAcceptedAt;
      fs.writeFileSync(outboxPath, JSON.stringify(rows, null, 2));

      const error: unknown = await service
        .send({ ...request, text: 'Divergent retry payload' })
        .catch((candidate: unknown) => candidate);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('(missing)');
      expect(error).not.toMatchObject({ code: 'idempotency_conflict' });
    });

    it('rejects a receipt timestamp that causally predates its exact outbox row', async () => {
      provisioning.relayInboxFileToLiveRecipient.mockImplementation((_team, _member, options) =>
        Promise.resolve({
          kind: 'native_lead',
          relayed: 1,
          recentlyDeliveredMessageId: options?.onlyMessageId,
        })
      );
      const request = makeRequest({
        requireRuntimeDelivery: true,
        messageId: 'runtime-conflict-stale-receipt-1',
        conversationId: 'runtime-conflict-stale-receipt-conversation-1',
        timestamp: '2026-07-23T00:00:00.000Z',
        text: 'Original accepted payload',
      });
      await service.send(request);

      const outboxPath = path.join(MOCK_TEAMS_BASE_PATH, 'teams', 'team-a', 'sent-cross-team.json');
      const rows = readFixtureArray(outboxPath) as Record<string, unknown>[];
      if (rows[0]) {
        rows[0].runtimeDeliveryAcceptedAt = '2020-01-01T00:00:00.000Z';
      }
      fs.writeFileSync(outboxPath, JSON.stringify(rows, null, 2));

      const error: unknown = await service
        .send({ ...request, text: 'Divergent retry payload' })
        .catch((candidate: unknown) => candidate);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('(causally_stale)');
      expect(error).not.toMatchObject({ code: 'idempotency_conflict' });
    });

    it('rejects superseded receipt evidence without accepting divergent identity history', async () => {
      provisioning.relayInboxFileToLiveRecipient.mockImplementation((_team, _member, options) =>
        Promise.resolve({
          kind: 'native_lead',
          relayed: 1,
          recentlyDeliveredMessageId: options?.onlyMessageId,
        })
      );
      const original = makeRequest({
        requireRuntimeDelivery: true,
        messageId: 'runtime-conflict-superseded-receipt-1',
        conversationId: 'runtime-conflict-superseded-receipt-conversation-1',
        timestamp: '2026-07-23T00:00:00.000Z',
        text: 'Original accepted payload',
      });
      await service.send(original);

      const outboxPath = path.join(MOCK_TEAMS_BASE_PATH, 'teams', 'team-a', 'sent-cross-team.json');
      const rows = readFixtureArray(outboxPath) as Record<string, unknown>[];
      rows.push({
        ...rows[0],
        text: 'Newest retry payload',
        runtimeDeliveryAcceptedAt: '2026-07-23T00:00:02.000Z',
      });
      fs.writeFileSync(outboxPath, JSON.stringify(rows, null, 2));

      const error: unknown = await service
        .send({ ...original, text: 'Newest retry payload' })
        .catch((candidate: unknown) => candidate);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('(superseded)');
      expect(error).not.toMatchObject({ code: 'idempotency_conflict' });
    });

    it('rejects runtime-required delivery when live relay does not prove delivery', async () => {
      provisioning.relayInboxFileToLiveRecipient.mockResolvedValue({
        kind: 'native_lead',
        relayed: 0,
      });

      await expect(service.send(makeRequest({ requireRuntimeDelivery: true }))).rejects.toThrow(
        'Cross-team runtime delivery was not confirmed for team-b.team-lead'
      );
      expect(fs.existsSync(`${MOCK_TEAMS_BASE_PATH}/teams/team-a/sentMessages.json`)).toBe(false);
    });

    it('accepts recent native lead delivery proof for the requested message', async () => {
      provisioning.relayInboxFileToLiveRecipient.mockResolvedValue({
        kind: 'native_lead',
        relayed: 0,
        recentlyDeliveredMessageId: 'cross-runtime-race-1',
      });

      await expect(
        service.send(
          makeRequest({
            requireRuntimeDelivery: true,
            messageId: 'cross-runtime-race-1',
          })
        )
      ).resolves.toMatchObject({
        deliveredToInbox: true,
        messageId: 'cross-runtime-race-1',
      });
    });

    it('rejects recent native lead delivery proof for a different message', async () => {
      provisioning.relayInboxFileToLiveRecipient.mockResolvedValue({
        kind: 'native_lead',
        relayed: 1,
        recentlyDeliveredMessageId: 'cross-runtime-race-1',
      });

      await expect(
        service.send(
          makeRequest({
            requireRuntimeDelivery: true,
            messageId: 'cross-runtime-race-2',
          })
        )
      ).rejects.toThrow('Cross-team runtime delivery was not confirmed for team-b.team-lead');
    });

    it('writes sender copy and clears pending reply when retry deduplicates after runtime proof failure', async () => {
      const request = makeRequest({
        requireRuntimeDelivery: true,
        messageId: 'cross-runtime-retry-1',
        conversationId: 'conv-runtime-retry-1',
        text: 'Please verify runtime retry',
      });
      provisioning.relayInboxFileToLiveRecipient
        .mockResolvedValueOnce({
          kind: 'native_lead',
          relayed: 0,
          diagnostics: ['target runtime not ready'],
        })
        .mockResolvedValueOnce({
          kind: 'native_lead',
          relayed: 1,
          recentlyDeliveredMessageId: 'cross-runtime-retry-1',
        })
        .mockResolvedValueOnce({
          kind: 'native_lead',
          relayed: 1,
          recentlyDeliveredMessageId: 'cross-runtime-retry-1',
        });

      await expect(service.send(request)).rejects.toThrow('target runtime not ready');

      const sentMessagesPath = `${MOCK_TEAMS_BASE_PATH}/teams/team-a/sentMessages.json`;
      expect(fs.existsSync(sentMessagesPath)).toBe(false);
      expect(provisioning.registerPendingCrossTeamReplyExpectation).toHaveBeenCalledWith(
        'team-a',
        'team-b',
        'conv-runtime-retry-1'
      );
      expect(provisioning.clearPendingCrossTeamReplyExpectation).not.toHaveBeenCalled();

      const retry = await service.send(request);

      expect(retry).toMatchObject({
        deliveredToInbox: true,
        deduplicated: true,
        messageId: 'cross-runtime-retry-1',
        toTeam: 'team-b',
        toMember: 'team-lead',
      });
      expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);
      expect(provisioning.relayInboxFileToLiveRecipient).toHaveBeenNthCalledWith(
        1,
        'team-b',
        'team-lead',
        { onlyMessageId: 'cross-runtime-retry-1' }
      );
      expect(provisioning.relayInboxFileToLiveRecipient).toHaveBeenNthCalledWith(
        2,
        'team-b',
        'team-lead',
        { onlyMessageId: 'cross-runtime-retry-1' }
      );

      const sentRows = JSON.parse(fs.readFileSync(sentMessagesPath, 'utf8')) as Record<
        string,
        unknown
      >[];
      expect(sentRows).toHaveLength(1);
      expect(sentRows[0]).toMatchObject({
        from: 'team-lead',
        to: 'team-b.team-lead',
        text: 'Please verify runtime retry',
        messageId: 'cross-runtime-retry-1',
        source: CROSS_TEAM_SENT_SOURCE,
        conversationId: 'conv-runtime-retry-1',
      });
      expect(provisioning.clearPendingCrossTeamReplyExpectation).toHaveBeenCalledTimes(1);
      expect(provisioning.clearPendingCrossTeamReplyExpectation).toHaveBeenCalledWith(
        'team-a',
        'team-b',
        'conv-runtime-retry-1'
      );

      const secondRetry = await service.send(request);

      expect(secondRetry).toMatchObject({
        deliveredToInbox: true,
        deduplicated: true,
        messageId: 'cross-runtime-retry-1',
      });
      expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);
      expect(provisioning.relayInboxFileToLiveRecipient).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fs.readFileSync(sentMessagesPath, 'utf8'))).toHaveLength(1);
      expect(provisioning.clearPendingCrossTeamReplyExpectation).toHaveBeenCalledTimes(2);
    });

    it('writes runtime-required sender copy only after live runtime proof', async () => {
      const sentMessagesPath = `${MOCK_TEAMS_BASE_PATH}/teams/team-a/sentMessages.json`;
      provisioning.relayInboxFileToLiveRecipient.mockImplementation((_team, _member, options) => {
        expect(fs.existsSync(sentMessagesPath)).toBe(false);
        return Promise.resolve({
          kind: 'native_lead',
          relayed: 1,
          recentlyDeliveredMessageId: options?.onlyMessageId,
        });
      });

      const result = await service.send(makeRequest({ requireRuntimeDelivery: true }));

      expect(result.deliveredToInbox).toBe(true);
      expect(fs.existsSync(sentMessagesPath)).toBe(true);
    });

    it('accepts OpenCode runtime proof when the target runtime accepted the prompt', async () => {
      provisioning.relayInboxFileToLiveRecipient.mockResolvedValue({
        kind: 'opencode_member',
        relayed: 0,
        lastDelivery: {
          delivered: true,
          accepted: true,
          responsePending: true,
          reason: 'opencode_delivery_response_pending',
        },
      });

      await expect(
        service.send(makeRequest({ requireRuntimeDelivery: true }))
      ).resolves.toMatchObject({
        deliveredToInbox: true,
      });
    });

    it('rejects OpenCode runtime-required delivery while prompt acceptance is unproven', async () => {
      provisioning.relayInboxFileToLiveRecipient.mockResolvedValue({
        kind: 'opencode_member',
        relayed: 0,
        lastDelivery: {
          delivered: true,
          accepted: false,
          responsePending: true,
          reason: 'opencode_delivery_response_pending',
        },
      });

      await expect(service.send(makeRequest({ requireRuntimeDelivery: true }))).rejects.toThrow(
        'opencode_delivery_response_pending'
      );
    });

    it('gracefully handles relay failure', async () => {
      provisioning.isTeamAlive.mockReturnValue(true);
      provisioning.relayLeadInboxMessages.mockRejectedValue(new Error('relay fail'));

      const result = await service.send(makeRequest());
      expect(result.deliveredToInbox).toBe(true);
    });

    it('rejects self-send', async () => {
      await expect(
        service.send(makeRequest({ fromTeam: 'team-a', toTeam: 'team-a' }))
      ).rejects.toThrow('same team');
    });

    it('rejects invalid team names', async () => {
      await expect(service.send(makeRequest({ fromTeam: '../evil' }))).rejects.toThrow(
        'Invalid fromTeam'
      );
      await expect(service.send(makeRequest({ toTeam: 'UPPER' }))).rejects.toThrow(
        'Invalid toTeam'
      );
    });

    it('rejects empty text', async () => {
      await expect(service.send(makeRequest({ text: '' }))).rejects.toThrow('text is required');
      await expect(service.send(makeRequest({ text: '   ' }))).rejects.toThrow('text is required');
    });

    it('rejects when target not found', async () => {
      configReader.getConfig.mockImplementation((teamName: string) =>
        Promise.resolve(teamName === 'team-b' ? null : makeConfig())
      );
      await expect(service.send(makeRequest())).rejects.toThrow('Target team not found');
    });

    it('rejects when target is deleted', async () => {
      configReader.getConfig.mockImplementation((teamName: string) =>
        Promise.resolve(
          teamName === 'to-be-deleted'
            ? makeConfig({ name: 'to-be-deleted', deletedAt: '2024-01-01T00:00:00Z' })
            : makeConfig()
        )
      );
      await expect(service.send(makeRequest({ toTeam: 'to-be-deleted' }))).rejects.toThrow(
        'Target team not found'
      );
    });

    it('rejects unknown source fromMember', async () => {
      await expect(service.send(makeRequest({ fromMember: 'researcher' }))).rejects.toThrow(
        'Unknown fromMember'
      );
    });

    it('rejects when source is deleted', async () => {
      configReader.getConfig.mockImplementation((teamName: string) =>
        Promise.resolve(
          teamName === 'deleted-source'
            ? makeConfig({ name: 'deleted-source', deletedAt: '2024-01-01T00:00:00Z' })
            : makeConfig()
        )
      );
      await expect(service.send(makeRequest({ fromTeam: 'deleted-source' }))).rejects.toThrow(
        'Source team not found'
      );
    });

    it('rejects excessive chain depth', async () => {
      await expect(service.send(makeRequest({ chainDepth: 5 }))).rejects.toThrow('chain depth');
    });

    it('rejects rate limit exceeded', async () => {
      for (let i = 0; i < 10; i++) {
        await service.send(makeRequest({ toTeam: `team-${String.fromCharCode(98 + i)}` }));
        configReader.getConfig.mockResolvedValue(
          makeConfig({ name: `team-${String.fromCharCode(99 + i)}` })
        );
      }
      configReader.getConfig.mockResolvedValue(makeConfig({ name: 'team-z' }));
      await expect(service.send(makeRequest({ toTeam: 'team-z' }))).rejects.toThrow('rate limit');
    });

    it('uses the configured lead when raw metadata is empty', async () => {
      await service.send(makeRequest());

      const [, req] = inboxWriter.sendMessage.mock.calls[0];
      expect(req.member).toBe('team-lead');
      expect(recipientMetadataReader.getMembers).toHaveBeenCalledWith('team-b');
      expect(dataService.getLeadMemberName).not.toHaveBeenCalled();
    });

    it('uses from format "team.member"', async () => {
      configReader.getConfig.mockImplementation((teamName: string) =>
        Promise.resolve(
          teamName === 'alpha'
            ? makeConfig({ name: 'alpha', members: [{ name: 'researcher' }] })
            : makeConfig()
        )
      );
      await service.send(makeRequest({ fromTeam: 'alpha', fromMember: 'researcher' }));

      const [, req] = inboxWriter.sendMessage.mock.calls[0];
      expect(req.from).toBe('alpha.researcher');
    });

    it('works with null provisioning', async () => {
      const svc = new CrossTeamService(
        configReader as unknown as TeamConfigReader,
        dataService as unknown as TeamDataService,
        inboxWriter as unknown as TeamInboxWriter,
        null
      );

      const result = await svc.send(makeRequest());
      expect(result.deliveredToInbox).toBe(true);
    });

    it('deduplicates recent equivalent requests and reuses messageId', async () => {
      const request = makeRequest({
        fromTeam: 'team-a-dedupe',
        toTeam: 'team-b-dedupe',
        text: 'Please   review this contract',
        summary: ' Review request ',
      });
      configReader.getConfig.mockResolvedValue(makeConfig({ name: 'team-b-dedupe' }));

      const first = await service.send(request);
      const second = await service.send({
        ...request,
        text: 'please review this contract',
        summary: 'review request',
      });

      expect(second.deduplicated).toBe(true);
      expect(second.messageId).toBe(first.messageId);
      expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);
    });

    describe('real filesystem transport interoperability', () => {
      it('keeps route and recipient dedupe shared in both JS/TS orders and reverse direction', async () => {
        const sourceTeam = 'fixture-source';
        const targetTeam = 'fixture-target';
        writeControllerTeam(
          sourceTeam,
          makeConfig({ name: sourceTeam, members: [{ name: 'team-lead', agentType: 'team-lead' }] })
        );
        writeControllerTeam(
          targetTeam,
          makeConfig({
            name: targetTeam,
            members: [
              { name: 'Captain', agentType: 'team-lead' },
              { name: 'worker', agentType: 'developer' },
            ],
          })
        );
        const filesystemService = createFilesystemCrossTeamService();
        const sourceController = agentTeamsController.createController({
          teamName: sourceTeam,
          claudeDir: MOCK_TEAMS_BASE_PATH,
        });
        const targetController = agentTeamsController.createController({
          teamName: targetTeam,
          claudeDir: MOCK_TEAMS_BASE_PATH,
        });
        const taskRefs = [{ taskId: 'task-1', displayId: '#1', teamName: sourceTeam }];
        const sharedRequest = {
          fromTeam: sourceTeam,
          fromMember: 'team-lead',
          toTeam: targetTeam,
          text: 'Coordinate the shared delivery',
          summary: 'Cross-path recipient parity',
          taskRefs,
        } satisfies CrossTeamSendRequest;

        const jsFirst = sourceController.crossTeam.sendCrossTeamMessage(sharedRequest) as {
          messageId: string;
        };
        const tsLeadRetry = await filesystemService.send({
          ...sharedRequest,
          toMember: 'Captain',
        });
        const tsWorker = await filesystemService.send({ ...sharedRequest, toMember: 'worker' });
        const tsWorkerRetry = await filesystemService.send({
          ...sharedRequest,
          toMember: 'worker',
        });

        expect(tsLeadRetry).toMatchObject({
          messageId: jsFirst.messageId,
          deduplicated: true,
          toMember: 'Captain',
        });
        expect(tsWorker).toMatchObject({ deliveredToInbox: true, toMember: 'worker' });
        expect(tsWorker.messageId).not.toBe(jsFirst.messageId);
        expect(tsWorkerRetry).toMatchObject({
          messageId: tsWorker.messageId,
          deduplicated: true,
          toMember: 'worker',
        });

        const tsFirst = await createFilesystemCrossTeamService().send({
          ...sharedRequest,
          toMember: 'Captain',
          text: 'TypeScript writes this shared row first',
        });
        const jsLeadRetry = sourceController.crossTeam.sendCrossTeamMessage({
          ...sharedRequest,
          text: 'TypeScript writes this shared row first',
        }) as { messageId: string; deduplicated?: boolean };
        expect(jsLeadRetry).toMatchObject({
          messageId: tsFirst.messageId,
          deduplicated: true,
        });

        const reverseRequest = {
          fromTeam: targetTeam,
          fromMember: 'Captain',
          toTeam: sourceTeam,
          toMember: 'team-lead',
          text: sharedRequest.text,
          summary: sharedRequest.summary,
        } satisfies CrossTeamSendRequest;
        const reverseFirst = await filesystemService.send(reverseRequest);
        const reverseRetry = targetController.crossTeam.sendCrossTeamMessage(reverseRequest) as {
          messageId: string;
          deduplicated?: boolean;
        };
        expect(reverseFirst).toMatchObject({ deliveredToInbox: true, toMember: 'team-lead' });
        expect(reverseRetry).toMatchObject({
          messageId: reverseFirst.messageId,
          deduplicated: true,
        });

        const captainInbox = readFixtureArray(
          path.join(MOCK_TEAMS_BASE_PATH, 'teams', targetTeam, 'inboxes', 'Captain.json')
        );
        const workerInbox = readFixtureArray(
          path.join(MOCK_TEAMS_BASE_PATH, 'teams', targetTeam, 'inboxes', 'worker.json')
        );
        const reverseInbox = readFixtureArray(
          path.join(MOCK_TEAMS_BASE_PATH, 'teams', sourceTeam, 'inboxes', 'team-lead.json')
        );
        expect(captainInbox).toHaveLength(2);
        expect(workerInbox).toHaveLength(1);
        expect(reverseInbox).toHaveLength(1);

        const sourceOutbox = readFixtureArray(
          path.join(MOCK_TEAMS_BASE_PATH, 'teams', sourceTeam, 'sent-cross-team.json')
        ) as { toMember?: string }[];
        const targetOutbox = readFixtureArray(
          path.join(MOCK_TEAMS_BASE_PATH, 'teams', targetTeam, 'sent-cross-team.json')
        );
        expect(sourceOutbox.map((message) => message.toMember)).toEqual([
          'Captain',
          'worker',
          'Captain',
        ]);
        expect(targetOutbox).toHaveLength(1);
      });

      it('deduplicates exactly at five minutes and delivers immediately after the boundary', async () => {
        const sourceTeam = 'fixture-boundary-source';
        const targetTeam = 'fixture-boundary-target';
        writeControllerTeam(sourceTeam, makeConfig({ name: sourceTeam }));
        writeControllerTeam(targetTeam, makeConfig({ name: targetTeam }));
        const filesystemService = createFilesystemCrossTeamService();
        const firstTimestamp = Date.parse('2026-07-16T12:00:00.000Z');
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(firstTimestamp);
        const request = {
          fromTeam: sourceTeam,
          fromMember: 'team-lead',
          toTeam: targetTeam,
          text: 'Boundary fixture delivery',
          summary: 'Five minute edge',
        } satisfies CrossTeamSendRequest;

        const first = await filesystemService.send({
          ...request,
          messageId: 'boundary-first',
          timestamp: new Date(firstTimestamp).toISOString(),
        });
        nowSpy.mockReturnValue(firstTimestamp + 5 * 60 * 1_000);
        const atBoundary = await filesystemService.send({
          ...request,
          messageId: 'boundary-retry',
          timestamp: new Date(firstTimestamp + 5 * 60 * 1_000).toISOString(),
        });
        nowSpy.mockReturnValue(firstTimestamp + 5 * 60 * 1_000 + 1);
        const afterBoundary = await filesystemService.send({
          ...request,
          messageId: 'boundary-after',
          timestamp: new Date(firstTimestamp + 5 * 60 * 1_000 + 1).toISOString(),
        });

        expect(atBoundary).toMatchObject({ messageId: first.messageId, deduplicated: true });
        expect(afterBoundary).toMatchObject({ messageId: 'boundary-after' });
        expect(afterBoundary.deduplicated).toBeUndefined();
        expect(
          readFixtureArray(
            path.join(MOCK_TEAMS_BASE_PATH, 'teams', targetTeam, 'inboxes', 'team-lead.json')
          )
        ).toHaveLength(2);
        expect(
          readFixtureArray(
            path.join(MOCK_TEAMS_BASE_PATH, 'teams', sourceTeam, 'sent-cross-team.json')
          )
        ).toHaveLength(2);
      });

      it('maps legacy rows to the lead while preserving corrupt and partial shared state', async () => {
        const sourceTeam = 'fixture-corrupt-source';
        const targetTeam = 'fixture-corrupt-target';
        writeControllerTeam(sourceTeam, makeConfig({ name: sourceTeam }));
        writeControllerTeam(
          targetTeam,
          makeConfig({
            name: targetTeam,
            members: [
              { name: 'Captain', agentType: 'team-lead' },
              { name: 'worker', agentType: 'developer' },
            ],
          })
        );
        const now = Date.parse('2026-07-16T12:00:00.000Z');
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const outboxPath = path.join(
          MOCK_TEAMS_BASE_PATH,
          'teams',
          sourceTeam,
          'sent-cross-team.json'
        );
        const legacyRow = {
          messageId: 'legacy-lead-row',
          fromTeam: sourceTeam,
          fromMember: 'team-lead',
          toTeam: targetTeam,
          text: 'Legacy fixture route',
          timestamp: new Date(now - 1_000).toISOString(),
        };
        const seededRows: unknown[] = [
          legacyRow,
          {
            ...legacyRow,
            messageId: 'stale-row',
            timestamp: new Date(now - 6 * 60 * 1_000).toISOString(),
          },
          { ...legacyRow, messageId: 'timestamp-less-row', timestamp: undefined },
          null,
          'malformed-row',
          { timestamp: new Date(now - 500).toISOString() },
        ];
        fs.writeFileSync(outboxPath, JSON.stringify(seededRows, null, 2));
        const filesystemService = createFilesystemCrossTeamService();
        const request = {
          fromTeam: sourceTeam,
          fromMember: 'team-lead',
          toTeam: targetTeam,
          text: legacyRow.text,
        } satisfies CrossTeamSendRequest;

        const leadRetry = await filesystemService.send({ ...request, toMember: 'Captain' });
        const workerDelivery = await filesystemService.send({ ...request, toMember: 'worker' });

        expect(leadRetry).toMatchObject({
          messageId: legacyRow.messageId,
          deduplicated: true,
          toMember: 'Captain',
        });
        expect(workerDelivery).toMatchObject({ deliveredToInbox: true, toMember: 'worker' });
        expect(
          fs.existsSync(
            path.join(MOCK_TEAMS_BASE_PATH, 'teams', targetTeam, 'inboxes', 'Captain.json')
          )
        ).toBe(false);
        expect(
          readFixtureArray(
            path.join(MOCK_TEAMS_BASE_PATH, 'teams', targetTeam, 'inboxes', 'worker.json')
          )
        ).toHaveLength(1);
        const persistedRows = readFixtureArray(outboxPath);
        expect(persistedRows.slice(0, seededRows.length)).toEqual(
          JSON.parse(JSON.stringify(seededRows))
        );
        expect(persistedRows).toHaveLength(seededRows.length + 1);
      });

      it('keeps successful inbox and outbox delivery when the sender copy is corrupt', async () => {
        const sourceTeam = 'fixture-sender-copy-source';
        const targetTeam = 'fixture-sender-copy-target';
        writeControllerTeam(sourceTeam, makeConfig({ name: sourceTeam }));
        writeControllerTeam(targetTeam, makeConfig({ name: targetTeam }));
        const sentMessagesPath = path.join(
          MOCK_TEAMS_BASE_PATH,
          'teams',
          sourceTeam,
          'sentMessages.json'
        );
        const corruptSenderState = '{not valid json';
        fs.writeFileSync(sentMessagesPath, corruptSenderState);
        const filesystemService = createFilesystemCrossTeamService(
          provisioning as unknown as TeamProvisioningService
        );

        const result = await filesystemService.send({
          fromTeam: sourceTeam,
          fromMember: 'team-lead',
          toTeam: targetTeam,
          text: 'Receiver delivery survives sender-copy failure',
          conversationId: 'sender-copy-failure-conversation',
        });

        expect(result).toMatchObject({ deliveredToInbox: true, toMember: 'team-lead' });
        expect(
          readFixtureArray(
            path.join(MOCK_TEAMS_BASE_PATH, 'teams', targetTeam, 'inboxes', 'team-lead.json')
          )
        ).toHaveLength(1);
        expect(
          readFixtureArray(
            path.join(MOCK_TEAMS_BASE_PATH, 'teams', sourceTeam, 'sent-cross-team.json')
          )
        ).toHaveLength(1);
        expect(fs.readFileSync(sentMessagesPath, 'utf8')).toBe(corruptSenderState);
        expect(provisioning.clearPendingCrossTeamReplyExpectation).toHaveBeenCalledWith(
          sourceTeam,
          targetTeam,
          'sender-copy-failure-conversation'
        );
      });
    });
  });

  describe('listAvailableTargets', () => {
    it('returns empty when team summary listing fails', async () => {
      dataService.listTeams.mockRejectedValue(new Error('ENOENT'));
      const result = await service.listAvailableTargets();
      expect(result).toEqual([]);
    });

    it('uses team summaries instead of verified config reads for target discovery', async () => {
      dataService.listTeams.mockResolvedValue([
        {
          teamName: 'team-a',
          displayName: 'Team A',
          description: '',
          memberCount: 1,
          members: [],
        },
        {
          teamName: 'team-b',
          displayName: 'Team B',
          description: 'Target team',
          color: 'blue',
          memberCount: 1,
          members: [{ name: 'alice', color: '#abcdef' }],
          leadName: 'captain',
          leadColor: '#123456',
        },
        {
          teamName: 'deleted-team',
          displayName: 'Deleted',
          description: '',
          memberCount: 0,
          members: [],
          deletedAt: '2026-05-01T00:00:00.000Z',
        },
        {
          teamName: 'draft-team',
          displayName: 'Draft',
          description: '',
          memberCount: 0,
          members: [],
          pendingCreate: true,
        },
      ]);
      provisioning.isTeamAlive.mockImplementation((teamName: string) => teamName === 'team-b');

      const result = await service.listAvailableTargets('team-a');

      expect(configReader.getConfig).not.toHaveBeenCalled();
      expect(result).toEqual([
        {
          teamName: 'team-b',
          displayName: 'Team B',
          description: 'Target team',
          color: 'blue',
          leadName: 'captain',
          leadColor: '#123456',
          isOnline: true,
        },
      ]);
    });
  });

  describe('getOutbox', () => {
    it('returns empty for non-existent outbox', async () => {
      const result = await service.getOutbox('team-a');
      expect(result).toEqual([]);
    });
  });
});
