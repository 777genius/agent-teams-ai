import { describe, expect, it } from 'vitest';

import {
  assertCreateTeamDoesNotExist,
  buildCreateTeamMetaPayload,
  buildDeterministicCreateSpawnArgs,
} from '../TeamProvisioningCreateTeamFlow';

import type { TeamCreateRequest } from '@shared/types';

function buildRequest(overrides: Partial<TeamCreateRequest> = {}): TeamCreateRequest {
  return {
    teamName: 'runtime-team',
    displayName: 'Runtime Team',
    description: 'Build runtime features',
    color: '#336699',
    cwd: '/repo',
    prompt: 'Start work',
    providerId: 'codex',
    providerBackendId: 'codex-native',
    model: 'gpt-5.4',
    effort: 'high',
    fastMode: 'on',
    skipPermissions: true,
    worktree: '/repo/worktree',
    extraCliArgs: '--flag',
    limitContext: true,
    members: [],
    ...overrides,
  } as TeamCreateRequest;
}

describe('TeamProvisioningCreateTeamFlow', () => {
  it('rejects an existing team from any configured base path', async () => {
    await expect(
      assertCreateTeamDoesNotExist(
        'runtime-team',
        [
          { location: 'configured', basePath: '/teams' },
          { location: 'default', basePath: '/detected-teams' },
        ],
        async (filePath) => filePath === '/detected-teams/runtime-team/config.json'
      )
    ).rejects.toThrow('Team already exists (found under /detected-teams)');
  });

  it('preserves create request fields in the pre-spawn metadata payload', () => {
    const payload = buildCreateTeamMetaPayload(buildRequest(), null, 12345);

    expect(payload).toEqual({
      displayName: 'Runtime Team',
      description: 'Build runtime features',
      color: '#336699',
      cwd: '/repo',
      prompt: 'Start work',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
      effort: 'high',
      fastMode: 'on',
      skipPermissions: true,
      worktree: '/repo/worktree',
      extraCliArgs: '--flag',
      limitContext: true,
      launchIdentity: null,
      createdAt: 12345,
    });
  });

  it('builds deterministic create launch arguments in the expected order', () => {
    const args = buildDeterministicCreateSpawnArgs({
      mcpConfigPath: '/tmp/mcp.json',
      bootstrapSpecPath: '/tmp/bootstrap.json',
      bootstrapUserPromptPath: '/tmp/prompt.txt',
      skipPermissions: false,
      launchModelArg: 'gpt-5.4',
      resolvedEffort: 'high',
      providerArgs: ['--provider-arg'],
      fastModeArgs: ['--fast'],
      runtimeTurnSettledHookArgs: ['--runtime-hook'],
      runtimeExtraArgs: ['--extra'],
      settingsArgs: ['--settings-json', '{"x":true}'],
      inheritedProviderArgs: ['--inherited'],
      worktree: '/repo/worktree',
      teammateModeDecision: { injectedTeammateMode: 'tmux' },
      disallowedTools: 'TeamDelete',
    });

    expect(args).toEqual([
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      'user,project,local',
      '--mcp-config',
      '/tmp/mcp.json',
      '--team-bootstrap-spec',
      '/tmp/bootstrap.json',
      '--team-bootstrap-user-prompt-file',
      '/tmp/prompt.txt',
      '--disallowedTools',
      'TeamDelete',
      '--permission-prompt-tool',
      'stdio',
      '--permission-mode',
      'default',
      '--model',
      'gpt-5.4',
      '--effort',
      'high',
      '--provider-arg',
      '--fast',
      '--runtime-hook',
      '--worktree',
      '/repo/worktree',
      '--teammate-mode',
      'tmux',
      '--extra',
      '--settings-json',
      '{"x":true}',
      '--inherited',
    ]);
  });
});
