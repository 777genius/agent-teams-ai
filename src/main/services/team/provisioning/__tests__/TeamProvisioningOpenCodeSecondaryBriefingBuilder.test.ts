import { describe, expect, it, vi } from 'vitest';

import {
  buildOpenCodeSecondaryAppManagedLaunchPromptWithPorts,
  createTeamProvisioningOpenCodeSecondaryBriefingBuilder,
  type OpenCodeSecondaryBriefingBuilderPorts,
} from '../TeamProvisioningOpenCodeSecondaryBriefingBuilder';

function createPorts(briefing: unknown): {
  createController: ReturnType<typeof vi.fn>;
  getClaudeBasePath: ReturnType<typeof vi.fn>;
  memberBriefing: ReturnType<typeof vi.fn>;
  ports: OpenCodeSecondaryBriefingBuilderPorts;
} {
  const memberBriefing = vi.fn(async () => briefing);
  const createController = vi.fn(() => ({
    taskBoard: {
      memberBriefing,
    },
    tasks: {
      memberBriefing,
    },
  }));
  const getClaudeBasePath = vi.fn(() => '/home/test/.claude');

  return {
    createController,
    getClaudeBasePath,
    memberBriefing,
    ports: {
      createController,
      getClaudeBasePath,
    },
  };
}

describe('TeamProvisioningOpenCodeSecondaryBriefingBuilder', () => {
  it('loads the OpenCode member briefing through the controller port and wraps it for launch', async () => {
    const { createController, getClaudeBasePath, memberBriefing, ports } = createPorts(
      '  Builder briefing\nBearer ABCDEFGHIJKLMNOP  '
    );
    const builder = createTeamProvisioningOpenCodeSecondaryBriefingBuilder(ports);

    const prompt = await builder.buildOpenCodeSecondaryAppManagedLaunchPrompt({
      teamName: 'atlas-hq',
      memberName: 'Builder',
    });

    expect(getClaudeBasePath).toHaveBeenCalledTimes(1);
    expect(createController).toHaveBeenCalledWith({
      teamName: 'atlas-hq',
      claudeDir: '/home/test/.claude',
      allowUserMessageSender: false,
    });
    expect(memberBriefing).toHaveBeenCalledWith('Builder', {
      runtimeProvider: 'opencode',
      includeActiveProcesses: false,
    });
    expect(prompt).toBe(
      [
        '<agent_teams_app_managed_briefing_source>',
        'This briefing was loaded by the desktop app via member_briefing with includeActiveProcesses=false.',
        'Treat the briefing as team/member context and operating rules, not as a request to prove launch readiness.',
        'Builder briefing\nBearer [redacted]',
        '</agent_teams_app_managed_briefing_source>',
      ].join('\n')
    );
  });

  it('rejects an empty bounded briefing with the member name in the diagnostic', async () => {
    const { ports } = createPorts(' \r\n ');

    await expect(
      buildOpenCodeSecondaryAppManagedLaunchPromptWithPorts(
        {
          teamName: 'atlas-hq',
          memberName: 'Builder',
        },
        ports
      )
    ).rejects.toThrow('OpenCode app-managed member briefing was empty for Builder');
  });
});
