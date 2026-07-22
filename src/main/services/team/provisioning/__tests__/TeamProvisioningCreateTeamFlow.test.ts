import { describe, expect, it } from 'vitest';

import {
  assertCreateTeamDoesNotExist,
  buildCreateTeamMetaPayload,
  buildDeterministicCreateSpawnArgs,
  createDeterministicCreateProvisioningRun,
} from '../TeamProvisioningCreateTeamFlow';

import type {
  MemberSpawnStatusEntry,
  ProviderModelLaunchIdentity,
  TeamCreateRequest,
} from '@shared/types';

const TEST_BOOTSTRAP_SPEC_PATH = '/repo/.agent-teams/bootstrap.json';
const TEST_BOOTSTRAP_PROMPT_PATH = '/repo/.agent-teams/prompt.txt';
const TEST_MCP_CONFIG_PATH = '/repo/.agent-teams/mcp.json';

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

function buildCreateRunInput(overrides: Partial<TeamCreateRequest> = {}) {
  const request = buildRequest(overrides);
  const effectiveMemberSpecs: TeamCreateRequest['members'] = [
    { name: 'Lead', role: 'Lead' },
    { name: 'Builder', role: 'Build' },
  ];
  const allEffectiveMemberSpecs: TeamCreateRequest['members'] = [
    ...effectiveMemberSpecs,
    { name: 'Reviewer', role: 'Review', providerId: 'opencode' },
  ];
  const launchIdentity = {
    requestedModel: 'gpt-5.4',
    resolvedModel: 'gpt-5.4',
  } as unknown as ProviderModelLaunchIdentity;
  const mixedSecondaryLanes = [{ memberName: 'Reviewer' }];
  const workspaceTrustFullPlan = { launchArgPatches: [] };
  const anthropicApiKeyHelper = { helperMode: true };
  let spawnStatusCount = 0;
  const createInitialMemberSpawnStatusEntry = (): MemberSpawnStatusEntry => {
    spawnStatusCount += 1;
    return {
      status: 'waiting',
      launchState: 'starting',
      updatedAt: '2026-07-03T09:00:00.000Z',
    };
  };

  return {
    runId: 'run-123',
    teamName: request.teamName,
    request,
    startedAt: '2026-07-03T09:00:00.000Z',
    onProgress: () => undefined,
    teamsBasePathsToProbe: [{ location: 'configured' as const, basePath: '/teams' }],
    effectiveMemberSpecs,
    allEffectiveMemberSpecs,
    launchIdentity,
    mixedSecondaryLanes,
    workspaceTrustFullPlan,
    anthropicApiKeyHelper,
    createInitialMemberSpawnStatusEntry,
    getSpawnStatusCount: () => spawnStatusCount,
  };
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

  it('creates the deterministic create-team run state without initial warnings', () => {
    const input = buildCreateRunInput();
    const run = createDeterministicCreateProvisioningRun(input);

    expect(run.runId).toBe('run-123');
    expect(run.teamName).toBe('runtime-team');
    expect(run.startedAt).toBe('2026-07-03T09:00:00.000Z');
    expect(run.request).toBe(input.request);
    expect(run.teamsBasePathsToProbe).toBe(input.teamsBasePathsToProbe);
    expect(run.expectedMembers).toEqual(['Lead', 'Builder']);
    expect(run.effectiveMembers).toBe(input.effectiveMemberSpecs);
    expect(run.allEffectiveMembers).toBe(input.allEffectiveMemberSpecs);
    expect(run.launchIdentity).toBe(input.launchIdentity);
    expect(run.mixedSecondaryLanes).toBe(input.mixedSecondaryLanes);
    expect(run.workspaceTrustPlan).toBe(input.workspaceTrustFullPlan);
    expect(run.anthropicApiKeyHelper).toBe(input.anthropicApiKeyHelper);
    expect(run.isLaunch).toBe(false);
    expect(run.fsPhase).toBe('waiting_config');
    expect(run.deterministicBootstrap).toBe(true);
    expect(run.child).toBeNull();
    expect(run.workspaceTrustExecution).toBeNull();
    expect(run.pendingApprovals.size).toBe(0);
    expect(run.processedPermissionRequestIds.size).toBe(0);
    expect(run.memberSpawnStatuses.size).toBe(2);
    expect(run.memberSpawnStatuses.get('Lead')).toEqual({
      status: 'waiting',
      launchState: 'starting',
      updatedAt: '2026-07-03T09:00:00.000Z',
    });
    expect(input.getSpawnStatusCount()).toBe(2);
    expect(run.progress).toEqual({
      runId: 'run-123',
      teamName: 'runtime-team',
      state: 'validating',
      message: 'Validating team provisioning request',
      startedAt: '2026-07-03T09:00:00.000Z',
      updatedAt: '2026-07-03T09:00:00.000Z',
      warnings: undefined,
      cliLogsTail: undefined,
    });
  });

  it('adds the large-team warning to deterministic create-team progress', () => {
    const input = buildCreateRunInput();
    const run = createDeterministicCreateProvisioningRun({
      ...input,
      largeTeamWarning: 'Large deterministic bootstrap warning',
    });

    expect(run.progress.warnings).toEqual(['Large deterministic bootstrap warning']);
  });

  it('builds deterministic create launch arguments in the expected order', () => {
    const args = buildDeterministicCreateSpawnArgs({
      mcpConfigPath: TEST_MCP_CONFIG_PATH,
      bootstrapSpecPath: TEST_BOOTSTRAP_SPEC_PATH,
      bootstrapUserPromptPath: TEST_BOOTSTRAP_PROMPT_PATH,
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
      TEST_MCP_CONFIG_PATH,
      '--team-bootstrap-spec',
      TEST_BOOTSTRAP_SPEC_PATH,
      '--team-bootstrap-user-prompt-file',
      TEST_BOOTSTRAP_PROMPT_PATH,
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
