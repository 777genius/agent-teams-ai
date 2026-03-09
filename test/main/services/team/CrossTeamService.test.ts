import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CrossTeamService } from '@main/services/team/CrossTeamService';

import type { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import type { TeamDataService } from '@main/services/team/TeamDataService';
import type { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';
import type { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import type { CrossTeamSendRequest, TeamConfig } from '@shared/types';

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => '/tmp/cross-team-test-nonexistent-dir-' + process.pid,
}));

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
  };

  beforeEach(() => {
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
  });

  describe('send', () => {
    it('delivers message to inbox via inboxWriter', async () => {
      const result = await service.send(makeRequest());

      expect(result.deliveredToInbox).toBe(true);
      expect(result.messageId).toBeDefined();
      expect(inboxWriter.sendMessage).toHaveBeenCalledOnce();

      const [teamName, req] = inboxWriter.sendMessage.mock.calls[0];
      expect(teamName).toBe('team-b');
      expect(req.member).toBe('team-lead');
      expect(req.source).toBe('cross_team');
      expect(req.from).toBe('team-a.lead');
      expect(req.text).toContain('[Cross-team from team-a.lead | depth:0]');
    });

    it('calls relayLeadInboxMessages when team is alive', async () => {
      provisioning.isTeamAlive.mockReturnValue(true);

      await service.send(makeRequest());

      expect(provisioning.relayLeadInboxMessages).toHaveBeenCalledWith('team-b');
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
      configReader.getConfig.mockResolvedValue(null);
      await expect(service.send(makeRequest())).rejects.toThrow('Target team not found');
    });

    it('rejects when target is deleted', async () => {
      configReader.getConfig.mockResolvedValue(makeConfig({ deletedAt: '2024-01-01T00:00:00Z' }));
      await expect(service.send(makeRequest())).rejects.toThrow('Target team not found');
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
