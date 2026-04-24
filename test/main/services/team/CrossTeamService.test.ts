import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';

import { CrossTeamService } from '@main/services/team/CrossTeamService';
import {
  CROSS_TEAM_SENT_SOURCE,
  CROSS_TEAM_SOURCE,
  parseCrossTeamPrefix,
} from '@shared/constants/crossTeam';

import type { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import type { TeamDataService } from '@main/services/team/TeamDataService';
import type { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';
import type { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import type { CrossTeamSendRequest, TeamConfig } from '@shared/types';

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => '/tmp/cross-team-test-nonexistent-dir-' + process.pid,
  getClaudeBasePath: () => '/tmp/cross-team-test-nonexistent-dir-' + process.pid,
}));

const MOCK_TEAMS_BASE_PATH = '/tmp/cross-team-test-nonexistent-dir-' + process.pid;

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

describe('CrossTeamService', () => {
  let service: CrossTeamService;
  let configReader: { getConfig: ReturnType<typeof vi.fn> };
  let dataService: { getLeadMemberName: ReturnType<typeof vi.fn> };
  let inboxWriter: { sendMessage: ReturnType<typeof vi.fn> };
  let provisioning: {
    isTeamAlive: ReturnType<typeof vi.fn>;
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
    };
    inboxWriter = {
      sendMessage: vi.fn().mockResolvedValue({ deliveredToInbox: true, messageId: 'mock-id' }),
    };
    provisioning = {
      isTeamAlive: vi.fn().mockReturnValue(false),
      relayLeadInboxMessages: vi.fn().mockResolvedValue(0),
      resolveCrossTeamReplyMetadata: vi.fn().mockReturnValue(null),
      registerPendingCrossTeamReplyExpectation: vi.fn(),
      clearPendingCrossTeamReplyExpectation: vi.fn(),
    };

    service = new CrossTeamService(
      configReader as unknown as TeamConfigReader,
      dataService as unknown as TeamDataService,
      inboxWriter as unknown as TeamInboxWriter,
      provisioning as unknown as TeamProvisioningService
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
      const sentRows = JSON.parse(raw) as Array<Record<string, unknown>>;
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
      inboxWriter.sendMessage.mockImplementation(async (teamName: string) => {
        order.push(`write:${teamName}`);
        return { deliveredToInbox: true, messageId: 'mock-id' };
      });
      provisioning.registerPendingCrossTeamReplyExpectation.mockImplementation(async () => {
        order.push('register:team-a->team-b');
      });
      provisioning.clearPendingCrossTeamReplyExpectation.mockImplementation(async () => {
        order.push('clear:team-a->team-b');
      });
      provisioning.isTeamAlive.mockReturnValue(true);
      provisioning.relayLeadInboxMessages.mockImplementation(async () => {
        order.push('relay:team-b');
        return 0;
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

    it('gracefully handles relay failure', async () => {
      provisioning.isTeamAlive.mockReturnValue(true);
      provisioning.relayLeadInboxMessages.mockRejectedValue(new Error('relay fail'));

      const result = await service.send(makeRequest());
      expect(result.deliveredToInbox).toBe(true);
    });

    it('rejects self-send', async () => {
      await expect(service.send(makeRequest({ fromTeam: 'team-a', toTeam: 'team-a' }))).rejects.toThrow(
        'same team'
      );
    });

    it('rejects invalid team names', async () => {
      await expect(service.send(makeRequest({ fromTeam: '../evil' }))).rejects.toThrow('Invalid fromTeam');
      await expect(service.send(makeRequest({ toTeam: 'UPPER' }))).rejects.toThrow('Invalid toTeam');
    });

    it('rejects empty text', async () => {
      await expect(service.send(makeRequest({ text: '' }))).rejects.toThrow('text is required');
      await expect(service.send(makeRequest({ text: '   ' }))).rejects.toThrow('text is required');
    });

    it('rejects when target not found', async () => {
      configReader.getConfig.mockImplementation(async (teamName: string) =>
        teamName === 'team-b' ? null : makeConfig()
      );
      await expect(service.send(makeRequest())).rejects.toThrow('Target team not found');
    });

    it('rejects when target is deleted', async () => {
      configReader.getConfig.mockImplementation(async (teamName: string) =>
        teamName === 'to-be-deleted'
          ? makeConfig({ name: 'to-be-deleted', deletedAt: '2024-01-01T00:00:00Z' })
          : makeConfig()
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
      configReader.getConfig.mockImplementation(async (teamName: string) =>
        teamName === 'deleted-source'
          ? makeConfig({ name: 'deleted-source', deletedAt: '2024-01-01T00:00:00Z' })
          : makeConfig()
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

    it('uses "team-lead" as fallback when getLeadMemberName returns null', async () => {
      dataService.getLeadMemberName.mockResolvedValue(null);

      await service.send(makeRequest());

      const [, req] = inboxWriter.sendMessage.mock.calls[0];
      expect(req.member).toBe('team-lead');
    });

    it('uses from format "team.member"', async () => {
      configReader.getConfig.mockImplementation(async (teamName: string) =>
        teamName === 'alpha'
          ? makeConfig({ name: 'alpha', members: [{ name: 'researcher' }] })
          : makeConfig()
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
  });

  describe('listAvailableTargets', () => {
    it('returns empty when teams dir read fails', async () => {
      configReader.getConfig.mockRejectedValue(new Error('ENOENT'));
      const result = await service.listAvailableTargets();
      expect(result).toEqual([]);
    });
  });

  describe('getOutbox', () => {
    it('returns empty for non-existent outbox', async () => {
      const result = await service.getOutbox('team-a');
      expect(result).toEqual([]);
    });
  });
});
