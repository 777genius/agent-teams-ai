import { describe, expect, it, vi } from 'vitest';

import {
  TeamRosterPersistenceRepository,
  type TeamRosterPersistenceRepositoryDependencies,
} from '../../../../src/features/team-roster-mutations/main/adapters/output/TeamRosterPersistenceRepository';

import type { TeamConfig, TeamMember, TeamProcess } from '@shared/types';

const FIXED_NOW = 1_753_200_000_000;

function createMembersPort(initialMembers: TeamMember[]) {
  let members = initialMembers;
  const getMembers = vi.fn(async () => members);
  const updateMembers = vi.fn(
    async (
      _teamName: string,
      update: (currentMembers: readonly TeamMember[]) => TeamMember[] | Promise<TeamMember[]>
    ) => {
      members = await update(members);
    }
  );
  return {
    port: { getMembers, updateMembers },
    getMembers,
    updateMembers,
    snapshot: () => members,
  };
}

function createHarness(
  options: {
    members?: TeamMember[];
    config?: TeamConfig | null;
    inboxNames?: string[];
    leadProviderId?: TeamMember['providerId'];
    processes?: TeamProcess[];
    now?: number;
    membersPort?: ReturnType<typeof createMembersPort>;
  } = {}
) {
  const membersPort = options.membersPort ?? createMembersPort(options.members ?? []);
  const dependencies: TeamRosterPersistenceRepositoryDependencies = {
    members: membersPort.port,
    config: {
      getConfig: vi.fn(async () => options.config ?? null),
    },
    inbox: {
      listInboxNames: vi.fn(async () => options.inboxNames ?? []),
    },
    teamMetadata: {
      getMeta: vi.fn(async () => ({ providerId: options.leadProviderId ?? 'codex' })),
    },
    launchSnapshots: {
      readBootstrap: vi.fn(async () => null),
      readPersisted: vi.fn(async () => null),
    },
    processes: {
      listProcesses: vi.fn(async () => options.processes ?? []),
    },
    now: vi.fn(() => options.now ?? FIXED_NOW),
  };
  return {
    repository: new TeamRosterPersistenceRepository(dependencies),
    dependencies,
    membersPort,
  };
}

describe('TeamRosterPersistenceRepository', () => {
  it('adds normalized provider fields and enforces case-insensitive durable-name uniqueness', async () => {
    const { repository, membersPort } = createHarness();

    await repository.addMember('runtime-team', {
      name: ' Alice ',
      role: ' Reviewer ',
      workflow: ' Review carefully ',
      isolation: 'worktree',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: ' gpt-5.4 ',
      effort: 'high',
      fastMode: 'on',
      mcpPolicy: {
        mode: 'strictAllowlist',
        scopes: { user: true, project: false, local: false },
        serverNames: ['github'],
      },
    });

    expect(membersPort.snapshot()).toEqual([
      expect.objectContaining({
        name: 'Alice',
        role: 'Reviewer',
        workflow: 'Review carefully',
        isolation: 'worktree',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'high',
        fastMode: 'on',
        mcpPolicy: {
          mode: 'strictAllowlist',
          scopes: { user: true, project: false, local: false },
          serverNames: ['github'],
        },
        agentType: 'general-purpose',
        joinedAt: FIXED_NOW,
      }),
    ]);
    await expect(
      repository.addMember('runtime-team', { name: 'alice', role: 'Duplicate' })
    ).rejects.toThrow('Member "alice" already exists');
    expect(membersPort.snapshot()).toHaveLength(1);
  });

  it('rejects empty, invalid, reserved, lead, numeric-suffix, and duplicate replacement names', async () => {
    const { repository, membersPort } = createHarness();
    const invalidRequests = [
      {
        members: [{ name: ' ', role: 'Reviewer' }],
        error: 'Member name cannot be empty',
      },
      {
        members: [{ name: 'bad/name', role: 'Reviewer' }],
        error: 'Member name "bad/name" is invalid',
      },
      {
        members: [{ name: 'user', role: 'Reviewer' }],
        error: 'Member name "user" is reserved',
      },
      {
        members: [{ name: 'team-lead', role: 'Reviewer' }],
        error: 'Member name "team-lead" is reserved',
      },
      {
        members: [{ name: 'alice-2', role: 'Reviewer' }],
        error: 'reserved for runtime-managed numeric suffixes',
      },
      {
        members: [
          { name: 'Alice', role: 'Reviewer' },
          { name: 'alice', role: 'Developer' },
        ],
        error: 'Member "alice" already exists',
      },
    ];

    for (const invalidRequest of invalidRequests) {
      await expect(
        repository.replaceMembers('runtime-team', { members: invalidRequest.members })
      ).rejects.toThrow(invalidRequest.error);
    }
    expect(membersPort.snapshot()).toEqual([]);
  });

  it('preserves active identity, durable tombstones, and all replacement fields', async () => {
    const removedAt = FIXED_NOW - 5_000;
    const { repository, membersPort } = createHarness({
      members: [
        {
          name: 'team-lead',
          role: 'Lead',
          agentType: 'team-lead',
          agentId: 'lead@runtime-team',
          color: 'purple',
          joinedAt: FIXED_NOW - 50_000,
        },
        {
          name: 'Alice',
          role: 'Developer',
          agentId: 'alice@runtime-team',
          agentType: 'general-purpose',
          color: 'blue',
          joinedAt: FIXED_NOW - 40_000,
        },
        {
          name: 'Charlie',
          role: 'Former reviewer',
          agentId: 'charlie@old-runtime-team',
          color: 'orange',
          joinedAt: FIXED_NOW - 30_000,
          removedAt,
        },
      ],
    });

    await repository.replaceMembers('runtime-team', {
      members: [
        {
          name: 'alice',
          role: ' Reviewer ',
          workflow: ' Review ',
          isolation: 'worktree',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: ' gpt-5.4 ',
          effort: 'high',
          fastMode: 'off',
          mcpPolicy: { mode: 'appOnly' },
        },
        {
          name: 'charlie',
          role: 'Restored reviewer',
          providerId: 'codex',
        },
      ],
    });

    expect(membersPort.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'team-lead',
          agentId: 'lead@runtime-team',
          joinedAt: FIXED_NOW - 50_000,
          removedAt: undefined,
        }),
        expect.objectContaining({
          name: 'alice',
          role: 'Reviewer',
          workflow: 'Review',
          isolation: 'worktree',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'high',
          fastMode: 'off',
          mcpPolicy: { mode: 'appOnly' },
          agentId: 'alice@runtime-team',
          joinedAt: FIXED_NOW - 40_000,
        }),
        expect.objectContaining({
          name: 'charlie',
          role: 'Restored reviewer',
          agentId: undefined,
          joinedAt: FIXED_NOW - 30_000,
          removedAt: undefined,
        }),
      ])
    );
  });

  it('migrates legacy config and inbox members through the same atomic removal', async () => {
    const { repository, membersPort } = createHarness({
      config: {
        name: 'Legacy team',
        members: [
          { name: 'team-lead', agentType: 'team-lead', role: 'Lead' },
          { name: 'user', role: 'Reserved recipient' },
          {
            name: 'Alice',
            role: 'Developer',
            workflow: 'Ship',
            isolation: 'worktree',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.4',
            effort: 'high',
            fastMode: 'on',
            mcpPolicy: { mode: 'appOnly' },
            agentType: 'general-purpose',
            color: 'blue',
            joinedAt: FIXED_NOW - 10_000,
            agentId: 'alice@legacy-team',
            cwd: '/test/project',
          },
          { name: 'Bob', role: 'Reviewer' },
        ],
      } as TeamConfig,
      inboxNames: [
        'Alice',
        'carol',
        'team-lead',
        'user',
        'carol-provisioner',
        'carol-2',
        'cross_team::other-team',
        'cross_team_send',
        'other-team.external',
        'a0123456789abcdef',
      ],
    });

    await repository.removeMember('legacy-team', 'alice');
    const firstRemovedAt = membersPort
      .snapshot()
      .find((member) => member.name === 'Alice')?.removedAt;
    await repository.removeMember('legacy-team', 'ALICE');

    expect(firstRemovedAt).toBe(FIXED_NOW);
    expect(membersPort.snapshot()).toHaveLength(3);
    expect(membersPort.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Alice',
          role: 'Developer',
          workflow: 'Ship',
          isolation: 'worktree',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'high',
          fastMode: 'on',
          mcpPolicy: { mode: 'appOnly' },
          agentId: 'alice@legacy-team',
          color: expect.any(String),
          joinedAt: FIXED_NOW - 10_000,
          cwd: '/test/project',
          removedAt: firstRemovedAt,
        }),
        expect.objectContaining({ name: 'Bob', role: 'Reviewer' }),
        expect.objectContaining({ name: 'carol', agentType: 'general-purpose' }),
      ])
    );
  });

  it('updates migrated roles and restores identity fields without reviving a stale agent id', async () => {
    const migratedHarness = createHarness({
      config: {
        name: 'Legacy team',
        members: [{ name: 'Alice', role: 'Builder', joinedAt: FIXED_NOW - 2_000 }],
      } as TeamConfig,
    });

    await expect(
      migratedHarness.repository.updateMemberRole('legacy-team', 'alice', ' Lead builder ')
    ).resolves.toEqual({ oldRole: 'Builder', changed: true });
    expect(migratedHarness.membersPort.snapshot()).toEqual([
      expect.objectContaining({
        name: 'Alice',
        role: 'Lead builder',
        joinedAt: FIXED_NOW - 2_000,
      }),
    ]);

    const restoreHarness = createHarness({
      members: [
        {
          name: 'Alice',
          role: 'Reviewer',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'high',
          fastMode: 'on',
          mcpPolicy: { mode: 'appOnly' },
          isolation: 'worktree',
          agentId: 'alice@old-runtime-team',
          color: 'blue',
          joinedAt: FIXED_NOW - 5_000,
          removedAt: FIXED_NOW - 1_000,
        },
      ],
    });

    await expect(restoreHarness.repository.restoreMember('runtime-team', 'alice')).resolves.toEqual(
      expect.objectContaining({
        name: 'Alice',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'high',
        fastMode: 'on',
        mcpPolicy: { mode: 'appOnly' },
        isolation: 'worktree',
        agentId: undefined,
        joinedAt: FIXED_NOW - 5_000,
        removedAt: undefined,
      })
    );
  });

  it('admits only supported live mutations for running mixed-provider rosters', async () => {
    const runningProcess = {
      id: 'run-1',
      label: 'mixed-team',
      pid: 123,
      registeredAt: new Date(FIXED_NOW).toISOString(),
    } as TeamProcess;
    const blockedHarness = createHarness({
      members: [
        {
          name: 'Alice',
          role: 'Reviewer',
          providerId: 'opencode',
          model: 'minimax-m2.5-free',
        },
      ],
      processes: [runningProcess],
    });

    await expect(
      blockedHarness.repository.addMember('mixed-team', {
        name: 'bob',
        providerId: 'codex',
        model: 'gpt-5.4',
      })
    ).rejects.toThrow(
      'Live roster mutation on a running mixed team is not supported in V1. Stop the team, edit the roster, then relaunch.'
    );
    expect(blockedHarness.membersPort.snapshot()).toHaveLength(1);

    const allowedHarness = createHarness({
      members: [
        {
          name: 'Alice',
          role: 'Reviewer',
          providerId: 'opencode',
          model: 'minimax-m2.5-free',
        },
      ],
      processes: [runningProcess],
    });
    await expect(
      allowedHarness.repository.removeMember('mixed-team', 'alice')
    ).resolves.toBeUndefined();
    expect(allowedHarness.membersPort.snapshot()[0]).toEqual(
      expect.objectContaining({ name: 'Alice', removedAt: FIXED_NOW })
    );
  });

  it('fails closed on invalid lane plans and storage update errors', async () => {
    const invalidPlanHarness = createHarness({
      leadProviderId: 'opencode',
      members: [{ name: 'Alice', providerId: 'opencode', model: 'minimax-m2.5-free' }],
    });
    await expect(
      invalidPlanHarness.repository.addMember('runtime-team', {
        name: 'bob',
        providerId: 'codex',
        model: 'gpt-5.4',
      })
    ).rejects.toThrow('Mixed teams with an OpenCode lead are not supported');
    expect(invalidPlanHarness.membersPort.snapshot()).toHaveLength(1);

    const failingMembersPort = createMembersPort([{ name: 'Alice', role: 'Builder' }]);
    failingMembersPort.port.updateMembers = vi.fn(async () => {
      throw new Error('members metadata disk full');
    });
    const storageFailureHarness = createHarness({ membersPort: failingMembersPort });

    await expect(
      storageFailureHarness.repository.addMember('runtime-team', {
        name: 'bob',
        role: 'Reviewer',
      })
    ).rejects.toThrow('members metadata disk full');
    await expect(
      storageFailureHarness.repository.updateMemberRole('runtime-team', 'alice', 'Lead builder')
    ).rejects.toThrow('members metadata disk full');
  });
});
