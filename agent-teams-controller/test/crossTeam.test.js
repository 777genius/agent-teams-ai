const fs = require('fs');
const os = require('os');
const path = require('path');

const { createController } = require('../src/index.js');
const { CROSS_TEAM_SOURCE, CROSS_TEAM_TAG_NAME } = require('../src/internal/crossTeamProtocol.js');

describe('crossTeam module', () => {
  const tempDirs = [];

  function makeClaudeDir(teams = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossteam-test-'));
    tempDirs.push(dir);

    for (const [teamName, config] of Object.entries(teams)) {
      const teamDir = path.join(dir, 'teams', teamName);
      const taskDir = path.join(dir, 'tasks', teamName);
      fs.mkdirSync(teamDir, { recursive: true });
      fs.mkdirSync(taskDir, { recursive: true });
      fs.mkdirSync(path.join(teamDir, 'inboxes'), { recursive: true });
      fs.writeFileSync(path.join(teamDir, 'config.json'), JSON.stringify(config, null, 2));
    }

    return dir;
  }

  afterEach(() => {
    // Reset cascade guard between tests
    const cascadeGuard = require('../src/internal/cascadeGuard.js');
    cascadeGuard.reset();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
      expect(result.toMember).toBeUndefined();

      // Verify inbox was written
      const inboxPath = path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'team-lead.json');
      const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      expect(inbox).toHaveLength(1);
      expect(inbox[0].source).toBe(CROSS_TEAM_SOURCE);
      expect(inbox[0].from).toBe('team-a.team-lead');
      expect(inbox[0].text).toContain(`<${CROSS_TEAM_TAG_NAME} from="team-a.team-lead" depth="0"`);
      expect(inbox[0].conversationId).toBeTruthy();
      expect(inbox[0].text).toContain(`conversationId="${inbox[0].conversationId}"`);
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
      expect(outbox[0].toMember).toBe('team-lead');
      expect(outbox[0].conversationId).toBeTruthy();

      const sentMessagesPath = path.join(claudeDir, 'teams', 'team-a', 'sentMessages.json');
      const sentMessages = JSON.parse(fs.readFileSync(sentMessagesPath, 'utf8'));
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].from).toBe('team-lead');
      expect(sentMessages[0].to).toBe('team-b.team-lead');
      expect(sentMessages[0].text).toBe('Hello');
      expect(sentMessages[0].source).toBe('cross_team_sent');
      expect(sentMessages[0].messageId).toBe(outbox[0].messageId);
    });

    it('preserves taskRefs in target inbox, sender copy and outbox', () => {
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
      const taskRefs = [{ taskId: 'task-1', displayId: 'abcd1234', teamName: 'team-a' }];

      const controller = createController({ teamName: 'team-a', claudeDir });
      controller.crossTeam.sendCrossTeamMessage({
        toTeam: 'team-b',
        text: 'Please review the linked task',
        taskRefs,
      });

      const inboxPath = path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'team-lead.json');
      const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      expect(inbox[0].taskRefs).toEqual(taskRefs);

      const sentMessagesPath = path.join(claudeDir, 'teams', 'team-a', 'sentMessages.json');
      const sentMessages = JSON.parse(fs.readFileSync(sentMessagesPath, 'utf8'));
      expect(sentMessages[0].taskRefs).toEqual(taskRefs);

      const outbox = controller.crossTeam.getCrossTeamOutbox();
      expect(outbox[0].taskRefs).toEqual(taskRefs);
    });

    it('rejects unknown source fromMember', () => {
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
          fromMember: 'ghost',
          text: 'Hello from nowhere',
        })
      ).toThrow('Unknown cross-team sender');
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
      expect(inbox[0].text).toContain('conversationId="conv-123"');
      expect(inbox[0].text).toContain('replyToConversationId="conv-123"');
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

      const sentMessagesPath = path.join(claudeDir, 'teams', 'team-a', 'sentMessages.json');
      const sentMessages = JSON.parse(fs.readFileSync(sentMessagesPath, 'utf8'));
      expect(sentMessages).toHaveLength(1);
    });

    it('does not treat a member-targeted outbox entry as a duplicate of a lead delivery', () => {
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

      // Pre-seed the shared outbox with a member-aware (TypeScript-transport)
      // entry addressed to a specific non-lead member, same text/summary.
      const outboxPath = path.join(claudeDir, 'teams', 'team-a', 'sent-cross-team.json');
      fs.writeFileSync(
        outboxPath,
        JSON.stringify(
          [
            {
              messageId: 'ts-member-entry',
              fromTeam: 'team-a',
              fromMember: 'lead',
              toTeam: 'team-b',
              toMember: 'alice',
              text: 'Please review the API contract',
              summary: 'Review request',
              timestamp: new Date().toISOString(),
            },
          ],
          null,
          2
        )
      );

      const controller = createController({ teamName: 'team-a', claudeDir });
      const result = controller.crossTeam.sendCrossTeamMessage({
        toTeam: 'team-b',
        fromMember: 'lead',
        text: 'Please review the API contract',
        summary: 'Review request',
      });

      // Lead delivery must NOT be suppressed by the member-targeted entry.
      expect(result.deduplicated).toBeUndefined();
      const inboxPath = path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'team-lead.json');
      const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      expect(inbox).toHaveLength(1);
    });

    it('deduplicates a lead delivery already recorded by the member-aware transport', () => {
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
      const outboxPath = path.join(claudeDir, 'teams', 'team-a', 'sent-cross-team.json');
      fs.writeFileSync(
        outboxPath,
        JSON.stringify([
          {
            messageId: 'typescript-lead-entry',
            fromTeam: 'team-a',
            fromMember: 'team-lead',
            toTeam: 'team-b',
            toMember: 'team-lead',
            text: 'Please review the API contract',
            summary: 'Review request',
            timestamp: new Date().toISOString(),
          },
        ])
      );

      const controller = createController({ teamName: 'team-a', claudeDir });
      const result = controller.crossTeam.sendCrossTeamMessage({
        toTeam: 'team-b',
        fromMember: 'lead',
        text: 'Please review the API contract',
        summary: 'Review request',
      });

      expect(result).toMatchObject({
        messageId: 'typescript-lead-entry',
        deliveredToInbox: true,
        deduplicated: true,
      });
      expect(
        fs.existsSync(path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'team-lead.json'))
      ).toBe(false);
      expect(controller.crossTeam.getCrossTeamOutbox()).toHaveLength(1);
    });

    it('deduplicates a legacy member-blind lead entry', () => {
      const claudeDir = makeClaudeDir({
        'team-a': {
          name: 'team-a',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
        'team-b': {
          name: 'team-b',
          members: [{ name: 'Captain', agentType: 'team-lead' }],
        },
      });
      const outboxPath = path.join(claudeDir, 'teams', 'team-a', 'sent-cross-team.json');
      fs.writeFileSync(
        outboxPath,
        JSON.stringify([
          {
            messageId: 'legacy-controller-entry',
            fromTeam: 'team-a',
            fromMember: 'team-lead',
            toTeam: 'team-b',
            text: 'Legacy lead request',
            timestamp: new Date().toISOString(),
          },
        ])
      );

      const controller = createController({ teamName: 'team-a', claudeDir });
      const result = controller.crossTeam.sendCrossTeamMessage({
        toTeam: 'team-b',
        text: 'Legacy lead request',
      });

      expect(result).toMatchObject({
        messageId: 'legacy-controller-entry',
        deduplicated: true,
      });
      expect(
        fs.existsSync(path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'Captain.json'))
      ).toBe(false);
    });

    it('scans past stale, timestamp-less, null, array, and malformed outbox rows', () => {
      const claudeDir = makeClaudeDir({
        'team-a': {
          name: 'team-a',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
        'team-b': {
          name: 'team-b',
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'worker', agentType: 'developer' },
          ],
        },
      });
      const now = Date.now();
      const outboxPath = path.join(claudeDir, 'teams', 'team-a', 'sent-cross-team.json');
      const matchingEntry = {
        messageId: 'recent-lead-entry',
        fromTeam: 'team-a',
        fromMember: 'team-lead',
        toTeam: 'team-b',
        toMember: 'team-lead',
        text: 'Find the valid row behind corruption',
        timestamp: new Date(now - 1_000).toISOString(),
      };
      const seededRows = [
        matchingEntry,
        {
          ...matchingEntry,
          messageId: 'stale-lead-entry',
          timestamp: new Date(now - 6 * 60 * 1_000).toISOString(),
        },
        { ...matchingEntry, messageId: 'timestamp-less-entry', timestamp: undefined },
        null,
        [],
        'malformed-row',
        { timestamp: new Date(now - 500).toISOString() },
        {
          ...matchingEntry,
          messageId: 'recent-worker-entry',
          toMember: 'worker',
          timestamp: new Date(now - 250).toISOString(),
        },
      ];
      fs.writeFileSync(outboxPath, JSON.stringify(seededRows));

      const controller = createController({ teamName: 'team-a', claudeDir });
      const result = controller.crossTeam.sendCrossTeamMessage({
        toTeam: 'team-b',
        text: 'Find the valid row behind corruption',
      });

      expect(result).toMatchObject({
        messageId: matchingEntry.messageId,
        deliveredToInbox: true,
        deduplicated: true,
      });
      expect(controller.crossTeam.getCrossTeamOutbox()).toEqual(seededRows);
      expect(
        fs.existsSync(path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'team-lead.json'))
      ).toBe(false);
    });

    it('skips a matching partial row without messageId and finds an earlier valid duplicate', () => {
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
      const now = Date.now();
      const outboxPath = path.join(claudeDir, 'teams', 'team-a', 'sent-cross-team.json');
      const matchingFields = {
        fromTeam: 'team-a',
        fromMember: 'team-lead',
        toTeam: 'team-b',
        toMember: 'team-lead',
        text: 'Find the valid persisted delivery',
      };
      fs.writeFileSync(
        outboxPath,
        JSON.stringify([
          {
            ...matchingFields,
            messageId: 'valid-earlier-message',
            timestamp: new Date(now - 1_000).toISOString(),
          },
          {
            ...matchingFields,
            timestamp: new Date(now - 500).toISOString(),
          },
        ])
      );

      const controller = createController({ teamName: 'team-a', claudeDir });
      const result = controller.crossTeam.sendCrossTeamMessage({
        toTeam: 'team-b',
        text: matchingFields.text,
      });

      expect(result).toMatchObject({
        messageId: 'valid-earlier-message',
        deliveredToInbox: true,
        deduplicated: true,
      });
      expect(controller.crossTeam.getCrossTeamOutbox()).toHaveLength(2);
      expect(
        fs.existsSync(path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'team-lead.json'))
      ).toBe(false);
    });

    it('writes a new delivery when the only matching persisted row has no messageId', () => {
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
      const text = 'Do not dedupe against a partial persisted row';
      const outboxPath = path.join(claudeDir, 'teams', 'team-a', 'sent-cross-team.json');
      fs.writeFileSync(
        outboxPath,
        JSON.stringify([
          {
            fromTeam: 'team-a',
            fromMember: 'team-lead',
            toTeam: 'team-b',
            toMember: 'team-lead',
            text,
            timestamp: new Date().toISOString(),
          },
        ])
      );

      const controller = createController({ teamName: 'team-a', claudeDir });
      const result = controller.crossTeam.sendCrossTeamMessage({ toTeam: 'team-b', text });

      expect(result.deduplicated).toBeUndefined();
      expect(result.messageId).toBeTruthy();
      const outbox = controller.crossTeam.getCrossTeamOutbox();
      expect(outbox).toHaveLength(2);
      expect(outbox[1].messageId).toBe(result.messageId);
      const inboxPath = path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'team-lead.json');
      expect(JSON.parse(fs.readFileSync(inboxPath, 'utf8'))).toHaveLength(1);
    });

    it('deduplicates at the five-minute boundary and resends immediately after it', () => {
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
        const firstTimestamp = Date.parse(controller.crossTeam.getCrossTeamOutbox()[0].timestamp);

        now = firstTimestamp + 5 * 60 * 1000;

        const boundaryRetry = controller.crossTeam.sendCrossTeamMessage({
          toTeam: 'team-b',
          text: 'Need a decision on the schema',
          summary: 'Schema decision',
        });
        expect(boundaryRetry).toMatchObject({
          messageId: first.messageId,
          deduplicated: true,
        });

        now += 1;

        const afterBoundary = controller.crossTeam.sendCrossTeamMessage({
          toTeam: 'team-b',
          text: 'Need a decision on the schema',
          summary: 'Schema decision',
        });

        expect(afterBoundary.deduplicated).toBeUndefined();
        expect(afterBoundary.messageId).not.toBe(first.messageId);

        const inboxPath = path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'team-lead.json');
        const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
        expect(inbox).toHaveLength(2);

        const updatedOutbox = controller.crossTeam.getCrossTeamOutbox();
        expect(updatedOutbox).toHaveLength(2);
      } finally {
        Date.now = originalNow;
      }
    });

    it('leaves the verified inbox write intact when the sender-copy write fails', () => {
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
      const messageStore = require('../src/internal/messageStore.js');
      const originalAppendSentMessage = messageStore.appendSentMessage;
      messageStore.appendSentMessage = () => {
        throw new Error('sender copy failed');
      };

      try {
        const controller = createController({ teamName: 'team-a', claudeDir });
        expect(() =>
          controller.crossTeam.sendCrossTeamMessage({
            toTeam: 'team-b',
            text: 'Preserve partial-write semantics',
          })
        ).toThrow('sender copy failed');
      } finally {
        messageStore.appendSentMessage = originalAppendSentMessage;
      }

      const inboxPath = path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'team-lead.json');
      expect(JSON.parse(fs.readFileSync(inboxPath, 'utf8'))).toHaveLength(1);
      expect(fs.existsSync(path.join(claudeDir, 'teams', 'team-a', 'sentMessages.json'))).toBe(
        false
      );
      expect(fs.existsSync(path.join(claudeDir, 'teams', 'team-a', 'sent-cross-team.json'))).toBe(
        false
      );
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

    it('rejects unsafe target lead names before inbox writes', () => {
      const claudeDir = makeClaudeDir({
        'team-a': {
          name: 'team-a',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
        'team-b': {
          name: 'team-b',
          members: [{ name: '../config', agentType: 'team-lead' }],
        },
      });
      const targetConfigPath = path.join(claudeDir, 'teams', 'team-b', 'config.json');
      const originalConfig = fs.readFileSync(targetConfigPath, 'utf8');

      const controller = createController({ teamName: 'team-a', claudeDir });
      expect(() =>
        controller.crossTeam.sendCrossTeamMessage({
          toTeam: 'team-b',
          text: 'Hello',
        })
      ).toThrow('Invalid target lead name');
      expect(fs.readFileSync(targetConfigPath, 'utf8')).toBe(originalConfig);
      expect(fs.existsSync(path.join(claudeDir, 'teams', 'team-a', 'sent-cross-team.json'))).toBe(
        false
      );
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

    it('resolves supported lead agent types before tech-lead role text', () => {
      const claudeDir = makeClaudeDir({
        'team-a': {
          name: 'team-a',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
        'team-b': {
          name: 'team-b',
          members: [
            { name: 'alice', role: 'tech lead' },
            { name: 'olivia', agentType: 'lead' },
          ],
        },
      });

      const controller = createController({ teamName: 'team-a', claudeDir });
      controller.crossTeam.sendCrossTeamMessage({
        toTeam: 'team-b',
        text: 'Hello',
      });

      expect(fs.existsSync(path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'olivia.json'))).toBe(
        true
      );
      expect(fs.existsSync(path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'alice.json'))).toBe(
        false
      );
    });

    it('resolves orchestrator lead from members.meta.json', () => {
      const claudeDir = makeClaudeDir({
        'team-a': {
          name: 'team-a',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
        'team-b': {
          name: 'team-b',
          members: [],
        },
      });

      const metaPath = path.join(claudeDir, 'teams', 'team-b', 'members.meta.json');
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          members: [
            { name: 'alice', role: 'tech lead' },
            { name: 'orla', agentType: 'orchestrator' },
          ],
        })
      );

      const controller = createController({ teamName: 'team-a', claudeDir });
      controller.crossTeam.sendCrossTeamMessage({
        toTeam: 'team-b',
        text: 'Hello',
      });

      expect(fs.existsSync(path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'orla.json'))).toBe(
        true
      );
      expect(fs.existsSync(path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'alice.json'))).toBe(
        false
      );
    });

    it('rejects phantom source teams before delivery or outbox writes', () => {
      const claudeDir = makeClaudeDir({
        'team-b': {
          name: 'team-b',
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
      });

      const controller = createController({ teamName: 'team-a', claudeDir });

      expect(() =>
        controller.crossTeam.sendCrossTeamMessage({
          toTeam: 'team-b',
          text: 'Hello from nowhere',
        })
      ).toThrow('Source team not found: team-a');
      expect(fs.existsSync(path.join(claudeDir, 'teams', 'team-a'))).toBe(false);
      expect(
        fs.existsSync(path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'team-lead.json'))
      ).toBe(false);
    });

    it('rejects unknown cross-team senders', () => {
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
          fromMember: 'alicce',
          text: 'Hello',
        })
      ).toThrow('Unknown cross-team sender: alicce');
      expect(
        fs.existsSync(path.join(claudeDir, 'teams', 'team-b', 'inboxes', 'team-lead.json'))
      ).toBe(false);
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
