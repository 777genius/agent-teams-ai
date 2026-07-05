import { describe, expect, it, vi } from 'vitest';

import {
  createOpenCodeTeamThroughRuntimeAdapterFlow,
  launchOpenCodeTeamThroughRuntimeAdapterFlow,
  type OpenCodeRuntimeAdapterTeamFlowPorts,
} from '../TeamProvisioningOpenCodeRuntimeAdapterTeamFlow';

import type { PreparedOpenCodeRuntimeAdapterLaunch } from '../TeamProvisioningOpenCodeRuntimeAdapterPreparation';
import type { TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import type { TeamCreateRequest, TeamLaunchRequest, TeamTask } from '@shared/types';

function createRequest(overrides: Partial<TeamCreateRequest> = {}): TeamCreateRequest {
  return {
    teamName: 'alpha',
    displayName: 'Alpha',
    description: 'OpenCode team',
    color: 'blue',
    cwd: '/repo',
    prompt: '  build it  ',
    members: [{ name: 'alice', role: 'Engineer', providerId: 'opencode' }],
    providerId: 'opencode',
    providerBackendId: 'adapter',
    model: 'gpt-5',
    effort: 'high',
    skipPermissions: false,
    worktree: 'feature-a',
    extraCliArgs: '--flag',
    limitContext: true,
    ...overrides,
  } as TeamCreateRequest;
}

function launchRequest(overrides: Partial<TeamLaunchRequest> = {}): TeamLaunchRequest {
  return {
    teamName: 'alpha',
    cwd: '/repo',
    providerId: 'opencode',
    providerBackendId: 'adapter',
    model: 'gpt-5',
    effort: 'high',
    ...overrides,
  } as TeamLaunchRequest;
}

function pureOpenCodePlan(members: TeamCreateRequest['members']): TeamRuntimeLanePlan {
  return {
    mode: 'pure_opencode',
    primaryMembers: members,
    allMembers: members,
    sideLanes: [],
  } as TeamRuntimeLanePlan;
}

function worktreeRootPlan(members: TeamCreateRequest['members']): TeamRuntimeLanePlan {
  return {
    mode: 'pure_opencode_worktree_root_lanes',
    primaryMembers: members,
    allMembers: members,
    sideLanes: [],
  } as TeamRuntimeLanePlan;
}

function prepared<TRequest extends TeamCreateRequest | TeamLaunchRequest>(params: {
  request: TRequest;
  effectiveMembers?: TeamCreateRequest['members'];
  runtimeLaunchMembers?: TeamCreateRequest['members'];
  lanePlan?: TeamRuntimeLanePlan;
}): PreparedOpenCodeRuntimeAdapterLaunch<TRequest> {
  const effectiveMembers =
    params.effectiveMembers ??
    ([
      { name: 'alice', role: 'Engineer', providerId: 'opencode', cwd: '/repo/alice' },
    ] as TeamCreateRequest['members']);
  return {
    launchRequest: params.request,
    effectiveMembers,
    lanePlan: params.lanePlan ?? pureOpenCodePlan(effectiveMembers),
    runtimeLaunchMembers:
      params.runtimeLaunchMembers ??
      ([
        { name: 'team-lead', role: 'Team Lead', providerId: 'opencode' },
        ...effectiveMembers,
      ] as TeamCreateRequest['members']),
  };
}

function createPorts(
  calls: string[],
  overrides: Partial<OpenCodeRuntimeAdapterTeamFlowPorts> = {}
): OpenCodeRuntimeAdapterTeamFlowPorts {
  return {
    getTeamsBasePathsToProbe: () => [
      { location: 'configured', basePath: '/configured/teams' },
      { location: 'default', basePath: '/default/teams' },
    ],
    getTeamsBasePath: () => {
      calls.push('getTeamsBasePath');
      return '/configured/teams';
    },
    getTasksBasePath: () => {
      calls.push('getTasksBasePath');
      return '/configured/tasks';
    },
    pathExists: async (filePath) => {
      calls.push(`pathExists:${filePath}`);
      return false;
    },
    ensureCwdExists: async (cwd) => {
      calls.push(`ensureCwdExists:${cwd}`);
    },
    mkdir: async (directoryPath) => {
      calls.push(`mkdir:${directoryPath}`);
    },
    nowMs: () => 123,
    writeTeamMeta: async (_teamName, data) => {
      calls.push(`writeTeamMeta:${data.createdAt}:${data.cwd}`);
    },
    writeMembersMeta: async (_teamName, members, options) => {
      const names = members.map((member) => member.name).join(',');
      calls.push(`writeMembersMeta:${names}:${options?.providerBackendId}`);
    },
    writeOpenCodeTeamConfig: async (_request, members) => {
      calls.push(`writeOpenCodeTeamConfig:${members.map((member) => member.name).join(',')}`);
    },
    prepareOpenCodeRuntimeAdapterLaunch: async <
      TRequest extends TeamCreateRequest | TeamLaunchRequest,
    >({
      request,
    }: {
      request: TRequest;
      members: TeamCreateRequest['members'];
    }) => {
      calls.push('prepareOpenCodeRuntimeAdapterLaunch');
      return prepared({ request });
    },
    readTeamConfigRaw: async () => {
      calls.push('readTeamConfigRaw');
      return '{"name":"Alpha"}';
    },
    resolveLaunchExpectedMembers: async (_teamName, _configRaw, leadProviderId) => {
      calls.push(`resolveLaunchExpectedMembers:${leadProviderId ?? 'none'}`);
      return {
        members: [{ name: 'alice', role: 'Engineer', providerId: 'opencode' }],
        source: 'members-meta',
        warning: 'member warning',
      };
    },
    updateConfigProjectPath: async (_teamName, cwd) => {
      calls.push(`updateConfigProjectPath:${cwd}`);
    },
    readExistingTasks: async () => {
      calls.push('readExistingTasks');
      return [{ id: 'task-1', subject: 'Existing task' } as TeamTask];
    },
    warn: (message) => {
      calls.push(`warn:${message}`);
    },
    buildDeterministicLaunchHydrationPrompt: (_request, _members, tasks, includeLead) => {
      calls.push(`buildPrompt:${tasks.length}:${includeLead}`);
      return 'hydrated prompt';
    },
    runOpenCodeWorktreeRootAggregateLaunch: async (input) => {
      const names = input.members.map((member) => member.name).join(',');
      calls.push(`runWorktreeRoot:${names}:${input.prompt}:${input.sourceWarning ?? 'none'}`);
      return { runId: 'worktree-run' };
    },
    runOpenCodeTeamRuntimeAdapterLaunch: async (input) => {
      const names = input.members.map((member) => member.name).join(',');
      calls.push(`runRuntimeAdapter:${names}:${input.prompt}:${input.sourceWarning ?? 'none'}`);
      return { runId: 'adapter-run' };
    },
    ...overrides,
  };
}

describe('OpenCode runtime adapter team flow', () => {
  it('detects duplicate teams across configured and default team bases before preparing launch', async () => {
    const calls: string[] = [];
    const ports = createPorts(calls, {
      pathExists: async (filePath) => {
        calls.push(`pathExists:${filePath}`);
        return filePath === '/default/teams/alpha/config.json';
      },
    });

    await expect(
      createOpenCodeTeamThroughRuntimeAdapterFlow(createRequest(), vi.fn(), ports)
    ).rejects.toThrow('Team already exists (found under /default/teams)');

    expect(calls).toEqual([
      'pathExists:/configured/teams/alpha/config.json',
      'pathExists:/default/teams/alpha/config.json',
    ]);
  });

  it('creates team directories and metadata before launching the runtime adapter branch', async () => {
    const calls: string[] = [];

    const result = await createOpenCodeTeamThroughRuntimeAdapterFlow(
      createRequest(),
      vi.fn(),
      createPorts(calls)
    );

    expect(result).toEqual({ runId: 'adapter-run' });
    expect(calls).toEqual([
      'pathExists:/configured/teams/alpha/config.json',
      'pathExists:/default/teams/alpha/config.json',
      'ensureCwdExists:/repo',
      'prepareOpenCodeRuntimeAdapterLaunch',
      'getTeamsBasePath',
      'mkdir:/configured/teams/alpha',
      'getTasksBasePath',
      'mkdir:/configured/tasks/alpha',
      'writeTeamMeta:123:/repo',
      'writeMembersMeta:alice:adapter',
      'writeOpenCodeTeamConfig:alice',
      'runRuntimeAdapter:team-lead,alice:build it:none',
    ]);
  });

  it('routes create through the worktree-root aggregate branch with effective members', async () => {
    const calls: string[] = [];
    const effectiveMembers = [
      { name: 'alice', role: 'Engineer', providerId: 'opencode', cwd: '/repo/alice' },
    ] as TeamCreateRequest['members'];

    const result = await createOpenCodeTeamThroughRuntimeAdapterFlow(
      createRequest(),
      vi.fn(),
      createPorts(calls, {
        prepareOpenCodeRuntimeAdapterLaunch: async <
          TRequest extends TeamCreateRequest | TeamLaunchRequest,
        >({
          request,
        }: {
          request: TRequest;
          members: TeamCreateRequest['members'];
        }) => {
          calls.push('prepareOpenCodeRuntimeAdapterLaunch');
          return prepared({
            request,
            effectiveMembers,
            runtimeLaunchMembers: [
              { name: 'team-lead', role: 'Team Lead', providerId: 'opencode' },
              { name: 'runtime-only', role: 'Runtime', providerId: 'opencode' },
            ] as TeamCreateRequest['members'],
            lanePlan: worktreeRootPlan(effectiveMembers),
          });
        },
      })
    );

    expect(result).toEqual({ runId: 'worktree-run' });
    expect(calls.at(-1)).toBe('runWorktreeRoot:alice:build it:none');
  });

  it('hydrates launch prompts, propagates expected-member warnings, and launches runtime adapter members', async () => {
    const calls: string[] = [];

    const result = await launchOpenCodeTeamThroughRuntimeAdapterFlow(
      launchRequest({ cwd: '/new-repo' }),
      vi.fn(),
      createPorts(calls)
    );

    expect(result).toEqual({ runId: 'adapter-run' });
    expect(calls).toEqual([
      'readTeamConfigRaw',
      'ensureCwdExists:/new-repo',
      'resolveLaunchExpectedMembers:opencode',
      'prepareOpenCodeRuntimeAdapterLaunch',
      'updateConfigProjectPath:/new-repo',
      'readExistingTasks',
      'buildPrompt:1:false',
      'runRuntimeAdapter:team-lead,alice:hydrated prompt:member warning',
    ]);
  });

  it('keeps launch going with an empty task list when task hydration reads fail', async () => {
    const calls: string[] = [];

    const result = await launchOpenCodeTeamThroughRuntimeAdapterFlow(
      launchRequest(),
      vi.fn(),
      createPorts(calls, {
        readExistingTasks: async () => {
          calls.push('readExistingTasks');
          throw new Error('task read failed');
        },
      })
    );

    expect(result).toEqual({ runId: 'adapter-run' });
    expect(calls).toContain(
      'warn:[alpha] Failed to read tasks for OpenCode launch prompt: Error: task read failed'
    );
    expect(calls).toContain('buildPrompt:0:false');
  });

  it('routes launch through the worktree-root aggregate branch with expected-member warnings', async () => {
    const calls: string[] = [];
    const effectiveMembers = [
      { name: 'alice', role: 'Engineer', providerId: 'opencode', cwd: '/repo/alice' },
    ] as TeamCreateRequest['members'];

    const result = await launchOpenCodeTeamThroughRuntimeAdapterFlow(
      launchRequest(),
      vi.fn(),
      createPorts(calls, {
        prepareOpenCodeRuntimeAdapterLaunch: async <
          TRequest extends TeamCreateRequest | TeamLaunchRequest,
        >({
          request,
        }: {
          request: TRequest;
          members: TeamCreateRequest['members'];
        }) => {
          calls.push('prepareOpenCodeRuntimeAdapterLaunch');
          return prepared({
            request,
            effectiveMembers,
            runtimeLaunchMembers: [
              { name: 'team-lead', role: 'Team Lead', providerId: 'opencode' },
              { name: 'runtime-only', role: 'Runtime', providerId: 'opencode' },
            ] as TeamCreateRequest['members'],
            lanePlan: worktreeRootPlan(effectiveMembers),
          });
        },
      })
    );

    expect(result).toEqual({ runId: 'worktree-run' });
    expect(calls.at(-1)).toBe('runWorktreeRoot:alice:hydrated prompt:member warning');
  });
});
