import { describe, expect, it } from 'vitest';

import {
  buildOpenCodeTeamConfig,
  writeOpenCodeTeamConfig,
  type WriteOpenCodeTeamConfigPorts,
} from '../TeamProvisioningOpenCodeTeamConfigWriter';

import type { TeamCreateRequest } from '@shared/types';

function buildRequest(overrides: Partial<TeamCreateRequest> = {}): TeamCreateRequest {
  return {
    teamName: 'runtime-team',
    displayName: ' Runtime Team ',
    description: 'Build runtime features',
    color: '#336699',
    cwd: '/repo',
    prompt: 'Start work',
    providerId: 'codex',
    model: 'gpt-5.4',
    effort: 'high',
    members: [],
    ...overrides,
  } as TeamCreateRequest;
}

describe('TeamProvisioningOpenCodeTeamConfigWriter', () => {
  it('builds the exact OpenCode team config shape with normalized providers and MCP policy', () => {
    const request = buildRequest({
      providerId: 'not-a-provider' as TeamCreateRequest['providerId'],
    });
    const members: TeamCreateRequest['members'] = [
      {
        name: 'Builder',
        role: 'Implement',
        workflow: 'Build features',
        isolation: 'worktree',
        providerId: 'opencode',
        model: 'opencode/openai/gpt-5.4',
        effort: 'medium',
        mcpPolicy: {
          mode: 'strictAllowlist',
          scopes: { user: false, project: true },
          serverNames: [' github ', 'github', '', 'linear'],
        },
        cwd: ' /repo/builder ',
      },
      {
        name: 'Reviewer',
        role: 'Review',
        workflow: 'Inspect changes',
        isolation: 'none' as unknown as TeamCreateRequest['members'][number]['isolation'],
        providerId: 'bad-provider' as TeamCreateRequest['members'][number]['providerId'],
        model: 'gpt-5.4',
        effort: 'low',
        mcpPolicy: {
          mode: 'inheritLead',
        },
        cwd: '   ',
      },
    ];

    expect(buildOpenCodeTeamConfig(request, members)).toEqual({
      name: 'Runtime Team',
      description: 'Build runtime features',
      color: '#336699',
      projectPath: '/repo',
      members: [
        {
          name: 'team-lead',
          role: 'Team Lead',
          agentType: 'team-lead',
          providerId: undefined,
          model: 'gpt-5.4',
          effort: 'high',
          cwd: '/repo',
        },
        {
          name: 'Builder',
          role: 'Implement',
          workflow: 'Build features',
          isolation: 'worktree',
          providerId: 'opencode',
          model: 'opencode/openai/gpt-5.4',
          effort: 'medium',
          mcpPolicy: {
            mode: 'strictAllowlist',
            scopes: { user: false, project: true },
            serverNames: ['github', 'linear'],
          },
          cwd: '/repo/builder',
        },
        {
          name: 'Reviewer',
          role: 'Review',
          workflow: 'Inspect changes',
          isolation: undefined,
          providerId: undefined,
          model: 'gpt-5.4',
          effort: 'low',
          mcpPolicy: undefined,
          cwd: undefined,
        },
      ],
    });
  });

  it('writes config.json atomically under the teams base path and invalidates the team cache', async () => {
    const calls: string[] = [];
    const writes: Array<{ filePath: string; contents: string }> = [];
    const ports: WriteOpenCodeTeamConfigPorts = {
      getTeamsBasePath: () => '/teams',
      writeFileAtomic: async (filePath, contents) => {
        calls.push(`write:${filePath}`);
        writes.push({ filePath, contents });
      },
      invalidateTeam: (teamName) => {
        calls.push(`invalidate:${teamName}`);
      },
    };

    await writeOpenCodeTeamConfig(
      buildRequest({
        displayName: '   ',
        members: [{ name: 'Builder', role: 'Implement', providerId: 'codex' }],
      }),
      [{ name: 'Builder', role: 'Implement', providerId: 'codex' }],
      ports
    );

    expect(writes).toEqual([
      {
        filePath: '/teams/runtime-team/config.json',
        contents: `${JSON.stringify(
          {
            name: 'runtime-team',
            description: 'Build runtime features',
            color: '#336699',
            projectPath: '/repo',
            members: [
              {
                name: 'team-lead',
                role: 'Team Lead',
                agentType: 'team-lead',
                providerId: 'codex',
                model: 'gpt-5.4',
                effort: 'high',
                cwd: '/repo',
              },
              {
                name: 'Builder',
                role: 'Implement',
                providerId: 'codex',
              },
            ],
          },
          null,
          2
        )}\n`,
      },
    ]);
    expect(calls).toEqual(['write:/teams/runtime-team/config.json', 'invalidate:runtime-team']);
  });
});
