import { buildOpenCodeSecondaryAppManagedLaunchPromptWithPorts } from '@main/services/team/provisioning/TeamProvisioningOpenCodeSecondaryBriefingBuilder';
import { createController, protocols } from 'agent-teams-controller';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('bounded OpenCode startup visualization briefing', () => {
  it('keeps operating rules and workflow context within12k using an atomic display refresh for a long real briefing', async () => {
    const claudeDir = await mkdtemp(join(tmpdir(), 'opencode-visualization-briefing-'));
    const teamName = 'visualization-test-team';
    try {
      const teamDir = join(claudeDir, 'teams', teamName);
      await mkdir(teamDir, { recursive: true });
      await writeFile(
        join(teamDir, 'config.json'),
        JSON.stringify({
          name: teamName,
          projectPath: join(claudeDir, 'sandbox-project'),
          members: [
            { name: 'lead', agentType: 'team-lead' },
            {
              name: 'Builder',
              agentType: 'team-member',
              role: 'Visualization reviewer',
              workflow: 'Ordinary task context. '.repeat(1500),
            },
          ],
        })
      );
      const controller = createController({ teamName, claudeDir, allowUserMessageSender: false });
      const rawBriefing = await controller.taskBoard.memberBriefing('Builder', {
        runtimeProvider: 'opencode',
        includeActiveProcesses: false,
        includeChatVisualizationProtocol: false,
      });
      const protocol = protocols.buildChatVisualizationProtocolText();
      expect(rawBriefing.length).toBeGreaterThan(12_000);
      expect(rawBriefing).not.toContain(protocol);
      const prompt = await buildOpenCodeSecondaryAppManagedLaunchPromptWithPorts(
        { teamName, memberName: 'Builder' },
        { createController, getClaudeBasePath: () => claudeDir }
      );
      expect(prompt.length).toBeLessThanOrEqual(12_000);
      expect(prompt).not.toContain(protocol);
      expect(prompt).not.toContain('AVAILABLE DISPLAY LIBRARY SPEC');
      expect(prompt).toContain(protocols.buildChatVisualizationRefreshInstruction());
      expect(prompt.match(/CHAT VISUALIZATION REFRESH REQUIRED/g)).toHaveLength(1);
      expect(prompt).toContain('Role: Visualization reviewer.');
      expect(prompt).toContain('task_add_comment BEFORE calling task_complete');
      expect(prompt).toContain('OpenCode bootstrap silence rule');
      expect(prompt).toContain('Ordinary task context.');
      expect(prompt).toContain('not as a request to prove launch readiness.');
      expect(prompt.endsWith('</agent_teams_app_managed_briefing_source>')).toBe(true);
    } finally {
      await rm(claudeDir, { recursive: true, force: true });
    }
  });
});
