import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { FileSystemCreateArtifactTransaction } from '../TeamProvisioningCreateArtifactTransaction';
import {
  createOpenCodeTeamThroughRuntimeAdapterFlow,
  launchOpenCodeTeamThroughRuntimeAdapterFlow,
  type OpenCodeRuntimeAdapterTeamFlowPorts,
} from '../TeamProvisioningOpenCodeRuntimeAdapterTeamFlow';
import { RosterLaunchKnownNoStartError } from '../TeamProvisioningRosterLaunchOutcome';

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
    leadRuntimeSelectionProvenance: {
      version: 1,
      providerBackendId: 'explicit',
      model: 'explicit',
      effort: 'explicit',
    },
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

function memberLanePlan(input: {
  primaryMembers: TeamCreateRequest['members'];
  sideMembers: TeamCreateRequest['members'];
}): TeamRuntimeLanePlan {
  return {
    mode: 'pure_opencode_member_lanes',
    primaryMembers: input.primaryMembers,
    allMembers: [...input.primaryMembers, ...input.sideMembers],
    sideLanes: input.sideMembers.map((member) => ({
      laneId: `secondary:opencode:${member.name}`,
      providerId: 'opencode',
      member: { ...member, providerId: 'opencode' },
    })),
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
    beginCreateArtifactTransaction: async () => ({
      ensureDirectory: async (directoryPath) => {
        calls.push(`mkdir:${directoryPath}`);
      },
      recordFileWrite: async () => undefined,
      rollbackIfOwned: async () => ({ status: 'rolled-back', retained: [], errors: [] }),
    }),
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
    const writeTeamMeta = vi.fn(async () => undefined);

    const result = await createOpenCodeTeamThroughRuntimeAdapterFlow(
      createRequest(),
      vi.fn(),
      createPorts(calls, { writeTeamMeta })
    );

    expect(result).toEqual({ runId: 'adapter-run' });
    expect(writeTeamMeta).toHaveBeenCalledWith(
      'alpha',
      expect.objectContaining({
        leadRuntimeSelectionProvenance: {
          version: 1,
          providerBackendId: 'explicit',
          model: 'explicit',
          effort: 'explicit',
        },
      })
    );
    expect(calls).toEqual([
      'pathExists:/configured/teams/alpha/config.json',
      'pathExists:/default/teams/alpha/config.json',
      'ensureCwdExists:/repo',
      'prepareOpenCodeRuntimeAdapterLaunch',
      'getTeamsBasePath',
      'getTasksBasePath',
      'mkdir:/configured/teams/alpha',
      'mkdir:/configured/tasks/alpha',
      'writeMembersMeta:alice:adapter',
      'writeOpenCodeTeamConfig:alice',
      'runRuntimeAdapter:team-lead,alice:build it:none',
    ]);
  });

  it('preserves a transaction-owned canonical roster before adapter spawn', async () => {
    const calls: string[] = [];
    const result = await createOpenCodeTeamThroughRuntimeAdapterFlow(
      createRequest({ rosterTransactionId: '11111111-1111-4111-8111-111111111111' }),
      vi.fn(),
      createPorts(calls)
    );

    expect(result).toEqual({ runId: 'adapter-run' });
    expect(calls.some((call) => call.startsWith('writeMembersMeta:'))).toBe(false);
    expect(calls).toContain('writeOpenCodeTeamConfig:alice');
    expect(calls).toContain('runRuntimeAdapter:team-lead,alice:build it:none');
  });

  it('rolls back OpenCode config and metadata on authoritative no-start', async () => {
    const calls: string[] = [];
    const rollbackIfOwned = vi.fn(async () => ({
      status: 'rolled-back' as const,
      retained: [],
      errors: [],
    }));
    const ports = createPorts(calls, {
      beginCreateArtifactTransaction: async () => ({
        ensureDirectory: async (directoryPath) => {
          calls.push(`mkdir:${directoryPath}`);
        },
        recordFileWrite: async () => undefined,
        rollbackIfOwned,
      }),
      runOpenCodeTeamRuntimeAdapterLaunch: async () => {
        throw new RosterLaunchKnownNoStartError('proof expired before invocation');
      },
    });

    await expect(
      createOpenCodeTeamThroughRuntimeAdapterFlow(
        createRequest({ rosterTransactionId: '11111111-1111-4111-8111-111111111111' }),
        vi.fn(),
        ports
      )
    ).rejects.toThrow('proof expired before invocation');

    expect(rollbackIfOwned).toHaveBeenCalledOnce();
  });

  it('restores exact saved draft files and tasks after OpenCode not-started', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opencode-draft-rollback-'));
    const teamDir = path.join(root, 'teams', 'alpha');
    const tasksDir = path.join(root, 'tasks', 'alpha');
    const metaPath = path.join(teamDir, 'team.meta.json');
    const configPath = path.join(teamDir, 'config.json');
    const taskPath = path.join(tasksDir, 'task.json');
    const savedMeta = '{"version":1,"cwd":"/saved","createdAt":1}\n';
    try {
      await fs.promises.mkdir(teamDir, { recursive: true });
      await fs.promises.mkdir(tasksDir, { recursive: true });
      await fs.promises.writeFile(metaPath, savedMeta);
      await fs.promises.writeFile(taskPath, '{"subject":"saved-task"}\n');
      const ports = createPorts([], {
        getTeamsBasePathsToProbe: () => [
          { location: 'configured', basePath: path.join(root, 'teams') },
        ],
        getTeamsBasePath: () => path.join(root, 'teams'),
        getTasksBasePath: () => path.join(root, 'tasks'),
        pathExists: async () => false,
        beginCreateArtifactTransaction: (input) => FileSystemCreateArtifactTransaction.begin(input),
        writeTeamMeta: async () => {
          await fs.promises.writeFile(metaPath, 'attempt-meta');
        },
        writeOpenCodeTeamConfig: async () => {
          await fs.promises.writeFile(configPath, 'attempt-config');
        },
        runOpenCodeTeamRuntimeAdapterLaunch: async () => ({
          runId: 'not-started',
          launchStatus: 'not_started',
        }),
      });

      await expect(
        createOpenCodeTeamThroughRuntimeAdapterFlow(
          createRequest({ rosterTransactionId: '11111111-1111-4111-8111-111111111111' }),
          vi.fn(),
          ports
        )
      ).resolves.toMatchObject({ launchStatus: 'not_started' });

      await expect(fs.promises.readFile(metaPath, 'utf8')).resolves.toBe(savedMeta);
      await expect(fs.promises.access(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.promises.readFile(taskPath, 'utf8')).resolves.toBe(
        '{"subject":"saved-task"}\n'
      );
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('retains OpenCode artifacts when the launch outcome is transport-unknown', async () => {
    const calls: string[] = [];
    const rollbackIfOwned = vi.fn();
    const ports = createPorts(calls, {
      beginCreateArtifactTransaction: async () => ({
        ensureDirectory: async (directoryPath) => {
          calls.push(`mkdir:${directoryPath}`);
        },
        recordFileWrite: async () => undefined,
        rollbackIfOwned,
      }),
      runOpenCodeTeamRuntimeAdapterLaunch: async () => {
        throw new Error('runtime transport closed after uncertain dispatch');
      },
    });

    await expect(
      createOpenCodeTeamThroughRuntimeAdapterFlow(createRequest(), vi.fn(), ports)
    ).rejects.toThrow('runtime transport closed after uncertain dispatch');
    expect(rollbackIfOwned).not.toHaveBeenCalled();
  });

  it('routes create with a model-distinct member through the aggregate member-lane branch', async () => {
    const calls: string[] = [];
    const primaryMembers = [
      { name: 'alice', role: 'Engineer', providerId: 'opencode', model: 'gpt-5' },
    ] as TeamCreateRequest['members'];
    const sideMembers = [
      {
        name: 'bob',
        role: 'Reviewer',
        providerId: 'opencode',
        model: 'minimax-m2.5-free',
      },
    ] as TeamCreateRequest['members'];
    const effectiveMembers = [...primaryMembers, ...sideMembers];

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
            lanePlan: memberLanePlan({ primaryMembers, sideMembers }),
          });
        },
      })
    );

    expect(result).toEqual({ runId: 'worktree-run' });
    expect(calls.at(-1)).toBe('runWorktreeRoot:alice,bob:build it:none');
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

  it('routes launch with a model-distinct member through the aggregate member-lane branch', async () => {
    const calls: string[] = [];
    const primaryMembers = [
      { name: 'alice', role: 'Engineer', providerId: 'opencode', model: 'gpt-5' },
    ] as TeamCreateRequest['members'];
    const sideMembers = [
      {
        name: 'bob',
        role: 'Reviewer',
        providerId: 'opencode',
        model: 'minimax-m2.5-free',
      },
    ] as TeamCreateRequest['members'];
    const effectiveMembers = [...primaryMembers, ...sideMembers];

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
            lanePlan: memberLanePlan({ primaryMembers, sideMembers }),
          });
        },
      })
    );

    expect(result).toEqual({ runId: 'worktree-run' });
    expect(calls.at(-1)).toBe('runWorktreeRoot:alice,bob:hydrated prompt:member warning');
  });
});
