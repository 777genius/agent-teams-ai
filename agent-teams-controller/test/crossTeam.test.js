const fs = require('fs');
const os = require('os');
const path = require('path');

const { createController } = require('../src/index.js');
const { CROSS_TEAM_SOURCE, CROSS_TEAM_PREFIX_TAG } = require('../src/internal/crossTeamProtocol.js');

describe('crossTeam module', () => {
  function makeClaudeDir(teams = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossteam-test-'));

    for (const [teamName, config] of Object.entries(teams)) {
      const teamDir = path.join(dir, 'teams', teamName);
      const taskDir = path.join(dir, 'tasks', teamName);
      fs.mkdirSync(teamDir, { recursive: true });
      fs.mkdirSync(taskDir, { recursive: true });
      fs.mkdirSync(path.join(teamDir, 'inboxes'), { recursive: true });
      fs.writeFileSync(
        path.join(teamDir, 'config.json'),
        JSON.stringify(config, null, 2)
      );
    }

    return dir;
  }

  afterEach(() => {
    // Reset cascade guard between tests
    const cascadeGuard = require('../src/internal/cascadeGuard.js');
    cascadeGuard.reset();
  });

  describe('sendCrossTeamMessage', () => {
    it('delivers message to target team inbox', () => {
      const claudeDir = makeClaudeDir({
        'team-a': {
          name: 'team-a',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
        'team-b': {
          name: 'team-b',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
      });

      const controller = createController({ teamName: 'team-a', claudeDir });
      const result = controller.crossTeam.sendCrossTeamMessage({
        toTeam: 'team-b',
        fromMember: 'lead',
        text: 'Hello from team-a',
        summary: 'Test message',
      });

      expect(result.deliveredToInbox).toBe(true);
      expect(result.messageId).toBeDefined();

      // Verify inbox was written
      const inboxPath = path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'team-lead.json');
      const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      expect(inbox).toHaveLength(1);
      expect(inbox[0].source).toBe(CROSS_TEAM_SOURCE);
      expect(inbox[0].from).toBe('team-a.lead');
      expect(inbox[0].text).toContain(`[${CROSS_TEAM_PREFIX_TAG} team-a.lead | depth:0`);
      expect(inbox[0].conversationId).toBeTruthy();
      expect(inbox[0].text).toContain(`conversation:${inbox[0].conversationId}`);
    });

    it('records outbox entry', () => {
      const claudeDir = makeClaudeDir({
        'team-a': {
          name: 'team-a',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
        'team-b': {
          name: 'team-b',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
      });

      const controller = createController({ teamName: 'team-a', claudeDir });
      controller.crossTeam.sendCrossTeamMessage({
        toTeam: 'team-b',
        text: 'Hello',
      });

      const outbox = controller.crossTeam.getCrossTeamOutbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0].toTeam).toBe('team-b');
      expect(outbox[0].conversationId).toBeTruthy();
    });

    it('preserves reply conversation metadata for explicit replies', () => {
      const claudeDir = makeClaudeDir({
        'team-a': {
          name: 'team-a',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
        'team-b': {
          name: 'team-b',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
      });

      const controller = createController({ teamName: 'team-a', claudeDir });
      controller.crossTeam.sendCrossTeamMessage({
        toTeam: 'team-b',
        text: 'Answering the open question',
        replyToConversationId: 'conv-123',
      });

      const inboxPath = path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'team-lead.json');
      const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      expect(inbox[0].conversationId).toBe('conv-123');
      expect(inbox[0].replyToConversationId).toBe('conv-123');
      expect(inbox[0].text).toContain('conversation:conv-123');
      expect(inbox[0].text).toContain('replyTo:conv-123');
    });

    it('deduplicates the same recent cross-team request', () => {
      const claudeDir = makeClaudeDir({
        'team-a': {
          name: 'team-a',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
        'team-b': {
          name: 'team-b',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
      });

      const controller = createController({ teamName: 'team-a', claudeDir });
      const first = controller.crossTeam.sendCrossTeamMessage({
        toTeam: 'team-b',
        fromMember: 'lead',
        text: 'Please review the API contract',
        summary: 'Review request',
      });
      const second = controller.crossTeam.sendCrossTeamMessage({
        toTeam: 'team-b',
        fromMember: 'lead',
        text: 'Please   review the API contract',
        summary: '  Review request  ',
      });

      expect(second.deliveredToInbox).toBe(true);
      expect(second.deduplicated).toBe(true);
      expect(second.messageId).toBe(first.messageId);

      const inboxPath = path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'team-lead.json');
      const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      expect(inbox).toHaveLength(1);

      const outbox = controller.crossTeam.getCrossTeamOutbox();
      expect(outbox).toHaveLength(1);
    });

    it('allows resending after dedupe window expires', () => {
      const claudeDir = makeClaudeDir({
        'team-a': {
          name: 'team-a',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
        'team-b': {
          name: 'team-b',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
      });

      const controller = createController({ teamName: 'team-a', claudeDir });
      const originalNow = Date.now;
      let now = originalNow();
      Date.now = () => now;
      try {
        const first = controller.crossTeam.sendCrossTeamMessage({
          toTeam: 'team-b',
          text: 'Need a decision on the schema',
          summary: 'Schema decision',
        });

        now += 6 * 60 * 1000;

        const second = controller.crossTeam.sendCrossTeamMessage({
          toTeam: 'team-b',
          text: 'Need a decision on the schema',
          summary: 'Schema decision',
        });

        expect(second.deduplicated).toBeUndefined();
        expect(second.messageId).not.toBe(first.messageId);

        const inboxPath = path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'team-lead.json');
        const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
        expect(inbox).toHaveLength(2);

        const updatedOutbox = controller.crossTeam.getCrossTeamOutbox();
        expect(updatedOutbox).toHaveLength(2);
      } finally {
        Date.now = originalNow;
      }
    });

    it('rejects self-send', () => {
      const claudeDir = makeClaudeDir({
        'team-a': {
          name: 'team-a',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
      });

      const controller = createController({ teamName: 'team-a', claudeDir });
      expect(() =>
        controller.crossTeam.sendCrossTeamMessage({
          toTeam: 'team-a',
          text: 'Self',
        })
      ).toThrow('same team');
    });

    it('rejects when target not found', () => {
      const claudeDir = makeClaudeDir({
        'team-a': {
          name: 'team-a',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
      });

      const controller = createController({ teamName: 'team-a', claudeDir });
      expect(() =>
        controller.crossTeam.sendCrossTeamMessage({
          toTeam: 'team-nonexistent',
          text: 'Hello',
        })
      ).toThrow('Target team not found');
    });

    it('rejects when target is deleted', () => {
      const claudeDir = makeClaudeDir({
        'team-a': {
          name: 'team-a',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
        'team-b': {
          name: 'team-b',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
          deletedAt: '2024-01-01T00:00:00Z',
        },
      });

      const controller = createController({ teamName: 'team-a', claudeDir });
      expect(() =>
        controller.crossTeam.sendCrossTeamMessage({
          toTeam: 'team-b',
          text: 'Hello',
        })
      ).toThrow('Target team not found');
    });

    it('rejects excessive chain depth', () => {
      const claudeDir = makeClaudeDir({
        'team-a': {
          name: 'team-a',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
        'team-b': {
          name: 'team-b',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
      });

      const controller = createController({ teamName: 'team-a', claudeDir });
      expect(() =>
        controller.crossTeam.sendCrossTeamMessage({
          toTeam: 'team-b',
          text: 'Hello',
          chainDepth: 5,
        })
      ).toThrow('chain depth');
    });
  });

  describe('resolveTargetLead', () => {
    it('resolves lead by agentType', () => {
      const claudeDir = makeClaudeDir({
        'team-a': {
          name: 'team-a',
          members: [{ name: 'alpha-lead', agentType: 'team-lead' }],
        },
        'team-b': {
          name: 'team-b',
          members: [{ name: 'beta-lead', agentType: 'team-lead' }],
        },
      });

      const controller = createController({ teamName: 'team-a', claudeDir });
      controller.crossTeam.sendCrossTeamMessage({
        toTeam: 'team-b',
        text: 'Hello',
      });

      const inboxPath = path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'beta-lead.json');
      expect(fs.existsSync(inboxPath)).toBe(true);
    });

    it('resolves lead by name fallback', () => {
      const claudeDir = makeClaudeDir({
        'team-a': {
          name: 'team-a',
          members: [{ name: 'team-lead' }],
        },
        'team-b': {
          name: 'team-b',
          members: [{ name: 'team-lead' }],
        },
      });

      const controller = createController({ teamName: 'team-a', claudeDir });
      controller.crossTeam.sendCrossTeamMessage({
        toTeam: 'team-b',
        text: 'Hello',
      });

      const inboxPath = path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'team-lead.json');
      expect(fs.existsSync(inboxPath)).toBe(true);
    });

    it('resolves lead from members.meta.json with normalization', () => {
      const claudeDir = makeClaudeDir({
        'team-a': {
          name: 'team-a',
          members: [{ name: 'team-lead' }],
        },
        'team-b': {
          name: 'team-b',
          members: [],
        },
      });

      // Write meta with dirty data (leading spaces, duplicates)
      const metaPath = path.join(claudeDir, 'teams', 'team-b', 'members.meta.json');
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          members: [
            { name: '  meta-lead  ', agentType: 'team-lead' },
            { name: '  meta-lead  ', agentType: 'team-lead' },
            { name: 'worker', agentType: 'worker' },
          ],
        })
      );

      const controller = createController({ teamName: 'team-a', claudeDir });
      controller.crossTeam.sendCrossTeamMessage({
        toTeam: 'team-b',
        text: 'Hello',
      });

      const inboxPath = path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'meta-lead.json');
      expect(fs.existsSync(inboxPath)).toBe(true);
    });
  });

  describe('listCrossTeamTargets', () => {
    it('lists valid teams excluding current', () => {
      const claudeDir = makeClaudeDir({
        'team-a': { name: 'Team A' },
        'team-b': { name: 'Team B', description: 'B desc' },
        'team-c': { name: 'Team C', deletedAt: '2024-01-01' },
      });

      const controller = createController({ teamName: 'team-a', claudeDir });
      const targets = controller.crossTeam.listCrossTeamTargets();

      expect(targets).toHaveLength(1);
      expect(targets[0].teamName).toBe('team-b');
      expect(targets[0].displayName).toBe('Team B');
      expect(targets[0].description).toBe('B desc');
    });
  });

  describe('getCrossTeamOutbox', () => {
    it('returns empty for non-existent outbox', () => {
      const claudeDir = makeClaudeDir({
        'team-a': { name: 'Team A' },
      });

      const controller = createController({ teamName: 'team-a', claudeDir });
      const outbox = controller.crossTeam.getCrossTeamOutbox();
      expect(outbox).toEqual([]);
    });
  });
});
