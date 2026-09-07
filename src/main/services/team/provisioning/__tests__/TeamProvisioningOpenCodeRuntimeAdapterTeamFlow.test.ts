import path from 'node:path';

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
        return filePath === path.join('/default', 'teams', 'alpha', 'config.json');
      },
    });

    await expect(
      createOpenCodeTeamThroughRuntimeAdapterFlow(createRequest(), vi.fn(), ports)
    ).rejects.toThrow('Team already exists (found under /default/teams)');

    expect(calls).toEqual([
      `pathExists:${path.join('/configured', 'teams', 'alpha', 'config.json')}`,
      `pathExists:${path.join('/default', 'teams', 'alpha', 'config.json')}`,
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
      `pathExists:${path.join('/configured', 'teams', 'alpha', 'config.json')}`,
      `pathExists:${path.join('/default', 'teams', 'alpha', 'config.json')}`,
      'ensureCwdExists:/repo',
      'prepareOpenCodeRuntimeAdapterLaunch',
      'getTeamsBasePath',
      `mkdir:${path.join('/configured', 'teams', 'alpha')}`,
      'getTasksBasePath',
      `mkdir:${path.join('/configured', 'tasks', 'alpha')}`,
      'writeTeamMeta:123:/repo',
      'writeMembersMeta:alice:adapter',
      'writeOpenCodeTeamConfig:alice',
      'runRuntimeAdapter:team-lead,alice:build it:none',
    ]);
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
    // The lead leads the roster: the planner never names it, so the flow puts it
    // back on the primary lane. Before that, no launch command was sent for the
    // lead at all on this path.
    expect(calls.at(-1)).toBe('runWorktreeRoot:team-lead,alice,bob:build it:none');
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
    // The lead leads the roster: the planner never names it, so the flow puts it
    // back on the primary lane. Before that, no launch command was sent for the
    // lead at all on this path.
    expect(calls.at(-1)).toBe(
      'runWorktreeRoot:team-lead,alice,bob:hydrated prompt:member warning'
    );
  });
});

/**
 * The lead is a member of the primary lane, and on this path it used to be
 * absent from the launch entirely.
 *
 * The roster the planner works with is the TEAMMATE roster - `isLeadMember` is
 * filtered out of it at normalization - so the lead is synthesized back exactly
 * once, in `buildOpenCodeRuntimeAdapterLaunchMembers`, and that result reaches
 * only `runOpenCodeTeamRuntimeAdapterLaunch`. The aggregate path was handed
 * `lanePlan.primaryMembers`, which never contained a lead, so no launch command
 * was ever sent for it - while `config.json` recorded the lead all the same, and
 * every later message to it was answered with "no stored session record".
 *
 * Both assertions matter and they are not the same one: `members` is what the
 * flow passes along, and `lanePlan.primaryMembers` is what the aggregate run
 * model actually turns into the primary lane roster.
 */
describe('the lead reaches the aggregate primary lane', () => {
  const LEAD = { name: 'team-lead', role: 'Team Lead', providerId: 'opencode' };

  function aggregatePorts(
    seen: { members: string[]; primaryMembers: string[] },
    lanePlan: TeamRuntimeLanePlan,
    effectiveMembers: TeamCreateRequest['members']
  ): Partial<OpenCodeRuntimeAdapterTeamFlowPorts> {
    return {
      prepareOpenCodeRuntimeAdapterLaunch: async <
        TRequest extends TeamCreateRequest | TeamLaunchRequest,
      >({
        request,
      }: {
        request: TRequest;
        members: TeamCreateRequest['members'];
      }) =>
        prepared({
          request,
          effectiveMembers,
          runtimeLaunchMembers: [
            LEAD,
            ...effectiveMembers,
          ] as TeamCreateRequest['members'],
          lanePlan,
        }),
      runOpenCodeWorktreeRootAggregateLaunch: async (input) => {
        seen.members = input.members.map((member) => member.name);
        seen.primaryMembers = input.lanePlan.primaryMembers.map((member) => member.name);
        return { runId: 'worktree-run' };
      },
    };
  }

  it('includes the lead when a teammate is split onto a side lane', async () => {
    const seen = { members: [] as string[], primaryMembers: [] as string[] };
    const primaryMembers = [
      { name: 'alice', role: 'Engineer', providerId: 'opencode' },
    ] as TeamCreateRequest['members'];
    const sideMembers = [
      { name: 'bob', role: 'Engineer', providerId: 'opencode', model: 'other-model' },
    ] as TeamCreateRequest['members'];

    await createOpenCodeTeamThroughRuntimeAdapterFlow(
      createRequest(),
      vi.fn(),
      createPorts(
        [],
        aggregatePorts(seen, memberLanePlan({ primaryMembers, sideMembers }), primaryMembers)
      )
    );

    expect(seen.members).toContain('team-lead');
    expect(seen.primaryMembers).toContain('team-lead');
    // The teammate that stayed on the primary lane is still there.
    expect(seen.primaryMembers).toContain('alice');
    // The side-lane teammate is launched by its own lane, not by this one.
    expect(seen.primaryMembers).not.toContain('bob');
  });

  /**
   * The shape that produced the worst artifacts: every teammate qualified for a
   * side lane, so `primaryMembers` was empty and
   * `launchOpenCodeAggregatePrimaryLane` returned `null` at its very first line
   * (`if (effectiveMembers.length === 0) return null`). No `launchTeam
   * lane=primary` command was sent at all, for any run of that team.
   */
  it('launches the primary lane for the lead even when every teammate is on a side lane', async () => {
    const seen = { members: [] as string[], primaryMembers: [] as string[] };
    const sideMembers = [
      { name: 'bob', role: 'Engineer', providerId: 'opencode', model: 'other-model' },
      { name: 'jack', role: 'Engineer', providerId: 'opencode', cwd: '/repo/jack' },
    ] as TeamCreateRequest['members'];

    await createOpenCodeTeamThroughRuntimeAdapterFlow(
      createRequest(),
      vi.fn(),
      createPorts(
        [],
        aggregatePorts(seen, memberLanePlan({ primaryMembers: [], sideMembers }), [])
      )
    );

    expect(seen.primaryMembers).toEqual(['team-lead']);
  });

  it('does not add a second lead when the roster already names one', async () => {
    const seen = { members: [] as string[], primaryMembers: [] as string[] };
    const primaryMembers = [LEAD] as TeamCreateRequest['members'];
    const sideMembers = [
      { name: 'bob', role: 'Engineer', providerId: 'opencode', model: 'other-model' },
    ] as TeamCreateRequest['members'];

    await createOpenCodeTeamThroughRuntimeAdapterFlow(
      createRequest(),
      vi.fn(),
      createPorts(
        [],
        aggregatePorts(seen, memberLanePlan({ primaryMembers, sideMembers }), primaryMembers)
      )
    );

    expect(seen.primaryMembers.filter((name) => name === 'team-lead')).toHaveLength(1);
  });

  /**
   * The two filters that decide what a lead is disagree: `isLeadMember` matches a
   * name case-insensitively, while the inbox compatibility filter drops only the
   * exact string `team-lead`. So a roster recovered from inboxes can carry a
   * `Team-Lead` that the planner treats as an ordinary teammate and sends to a
   * side lane. Adding a synthesized lead on top of that would launch two sessions
   * for one identity, and only one of them would be tracked.
   */
  it('does not add a lead when one is already running on a side lane', async () => {
    const seen = { members: [] as string[], primaryMembers: [] as string[] };
    const primaryMembers = [
      { name: 'alice', role: 'Engineer', providerId: 'opencode' },
    ] as TeamCreateRequest['members'];
    const sideMembers = [
      { name: 'Team-Lead', role: 'Team Lead', providerId: 'opencode', model: 'other-model' },
    ] as TeamCreateRequest['members'];

    await createOpenCodeTeamThroughRuntimeAdapterFlow(
      createRequest(),
      vi.fn(),
      createPorts(
        [],
        aggregatePorts(seen, memberLanePlan({ primaryMembers, sideMembers }), primaryMembers)
      )
    );

    expect(seen.primaryMembers).toEqual(['alice']);
    expect(seen.members).not.toContain('team-lead');
  });

  it('does the same on the launch path, not only on create', async () => {
    const seen = { members: [] as string[], primaryMembers: [] as string[] };
    const primaryMembers = [
      { name: 'alice', role: 'Engineer', providerId: 'opencode' },
    ] as TeamCreateRequest['members'];
    const sideMembers = [
      { name: 'bob', role: 'Engineer', providerId: 'opencode', model: 'other-model' },
    ] as TeamCreateRequest['members'];

    await launchOpenCodeTeamThroughRuntimeAdapterFlow(
      launchRequest(),
      vi.fn(),
      createPorts(
        [],
        aggregatePorts(seen, memberLanePlan({ primaryMembers, sideMembers }), primaryMembers)
      )
    );

    expect(seen.primaryMembers).toContain('team-lead');
  });
});
