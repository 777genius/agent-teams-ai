import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const { createController } = require('../src/index.js') as {
  createController(options: { teamName: string; claudeDir: string }): {
    tasks: { memberBriefing(name: string): Promise<string> };
  };
};

describe('member briefing team roster', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it.each(['anthropic', 'codex', 'opencode'])(
    'includes colleagues and excludes removed members for %s',
    async (providerId) => {
      const claudeDir = mkdtempSync(join(tmpdir(), 'member-roster-test-'));
      directories.push(claudeDir);
      const teamDir = join(claudeDir, 'teams', 'sandbox-team');
      mkdirSync(join(teamDir, 'inboxes'), { recursive: true });
      mkdirSync(join(claudeDir, 'tasks', 'sandbox-team'), { recursive: true });
      writeFileSync(
        join(teamDir, 'config.json'),
        JSON.stringify({
          name: 'sandbox-team',
          members: [
            { name: 'lead', role: 'team-lead' },
            { name: 'developer', role: 'backend', providerId },
            { name: 'reviewer', role: 'old role' },
            { name: 'removed-reviewer', role: 'obsolete role' },
          ],
        })
      );
      writeFileSync(
        join(teamDir, 'members.meta.json'),
        JSON.stringify({
          version: 1,
          members: [
            { name: 'reviewer', role: 'security review', workflow: 'Private reviewer workflow' },
            { name: 'removed-reviewer', removedAt: Date.now() },
            { name: 'helper', agentType: 'researcher' },
          ],
        })
      );
      for (const name of ['removed-reviewer', 'user', 'cross-team:external', 'external.alice']) {
        writeFileSync(join(teamDir, 'inboxes', `${name}.json`), '[]');
      }
      const controller = createController({ teamName: 'sandbox-team', claudeDir });
      const briefing = await controller.tasks.memberBriefing('developer');
      expect(briefing).toContain('Current team roster (names and roles):');
      expect(briefing).toContain('- lead (role: team-lead) [team lead]');
      expect(briefing).toContain('- developer (role: backend) [you]');
      expect(briefing).toContain('- reviewer (role: security review)');
      expect(briefing).toContain('- helper (role: researcher)');
      expect(briefing).not.toContain('removed-reviewer');
      expect(briefing).not.toContain('external.alice');
      expect(briefing).not.toContain('cross-team:external');
      expect(briefing).not.toContain('- user (role:');
      expect(briefing).not.toContain('Private reviewer workflow');

      // Re-fetching a briefing must reflect removals without restarting the controller.
      writeFileSync(
        join(teamDir, 'members.meta.json'),
        JSON.stringify({
          version: 1,
          members: [{ name: 'reviewer', removedAt: Date.now() }],
        })
      );
      const refreshed = await controller.tasks.memberBriefing('developer');
      expect(refreshed).not.toContain('- reviewer (role:');
    }
  );
});
