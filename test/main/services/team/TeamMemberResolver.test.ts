import { describe, expect, it } from 'vitest';

import { TeamMemberResolver } from '../../../../src/main/services/team/TeamMemberResolver';

import type {
  TeamConfig,
  TeamTask,
  TeamTaskWithKanban,
} from '../../../../src/shared/types/team';

describe('TeamMemberResolver', () => {
  it('builds roster from config + meta + inbox only', () => {
    const resolver = new TeamMemberResolver();
    const config: TeamConfig = {
      name: 'My Team',
      members: [{ name: 'team-lead', agentType: 'team-lead', role: 'lead' }],
    };
    const metaMembers: TeamConfig['members'] = [
      { name: 'alice', role: 'developer', agentType: 'general-purpose', color: 'blue' },
    ];
    const inboxNames = ['bob'];
    const tasks: TeamTask[] = [
      { id: '1', subject: 'Visible task', status: 'pending', owner: 'alice' },
      { id: '2', subject: 'Ghost task', status: 'pending', owner: 'stranger' },
    ];

    const members = resolver.resolveMembers(config, metaMembers, inboxNames, tasks);
    const names = members.map((member) => member.name);

    expect(names).toHaveLength(3);
    expect(names).toEqual(expect.arrayContaining(['alice', 'bob', 'team-lead']));
    expect(names).not.toContain('stranger');
    expect(names).not.toContain('user');

    const alice = members.find((member) => member.name === 'alice');
    expect(alice?.role).toBe('developer');
    expect(alice?.color).toBe('blue');

    const lead = members.find((member) => member.name === 'team-lead');
    expect(lead?.role).toBe('lead');
    expect(lead?.agentType).toBe('team-lead');
  });

  it('filters out "user" pseudo-member even when present in config, meta, or inboxNames', () => {
    const resolver = new TeamMemberResolver();
    const config: TeamConfig = {
      name: 'Team',
      members: [
        { name: 'team-lead', agentType: 'team-lead', role: 'lead' },
        { name: 'user', agentType: 'general-purpose' },
      ],
    };
    const metaMembers: TeamConfig['members'] = [
      { name: 'user', agentType: 'general-purpose' },
      { name: 'alice', role: 'dev', agentType: 'general-purpose' },
    ];
    const inboxNames = ['user', 'alice'];
    const tasks: TeamTask[] = [];

    const members = resolver.resolveMembers(config, metaMembers, inboxNames, tasks);
    const names = members.map((m) => m.name);

    expect(names).not.toContain('user');
    expect(names).toContain('team-lead');
    expect(names).toContain('alice');
  });

  it('ignores qualified external inbox names unless explicitly configured', () => {
    const resolver = new TeamMemberResolver();
    const config: TeamConfig = {
      name: 'Team',
      members: [{ name: 'team-lead', agentType: 'team-lead', role: 'lead' }],
    };
    const metaMembers: TeamConfig['members'] = [{ name: 'alice', agentType: 'general-purpose' }];
    const inboxNames = ['alice', 'team-best.user', 'dream-team.team-lead'];
    const tasks: TeamTask[] = [];

    const members = resolver.resolveMembers(config, metaMembers, inboxNames, tasks);
    const names = members.map((m) => m.name);

    expect(names).toContain('alice');
    expect(names).toContain('team-lead');
    expect(names).not.toContain('team-best.user');
    expect(names).not.toContain('dream-team.team-lead');
  });

  it('ignores leaked generated agent ids from inbox file names', () => {
    const resolver = new TeamMemberResolver();
    const config: TeamConfig = {
      name: 'Team',
      members: [{ name: 'team-lead', agentType: 'team-lead', role: 'lead' }],
    };
    const metaMembers: TeamConfig['members'] = [
      { name: 'alice', agentType: 'general-purpose' },
      { name: 'bob', agentType: 'general-purpose' },
    ];
    const inboxNames = ['a3975f80d37fbcea1', 'alice', 'a68a8f6a643e59bfd'];

    const members = resolver.resolveMembers(config, metaMembers, inboxNames, []);
    const names = members.map((m) => m.name);

    expect(names).toContain('alice');
    expect(names).toContain('bob');
    expect(names).toContain('team-lead');
    expect(names).not.toContain('a3975f80d37fbcea1');
    expect(names).not.toContain('a68a8f6a643e59bfd');
  });

  it('keeps dotted names when they are explicitly configured members', () => {
    const resolver = new TeamMemberResolver();
    const config: TeamConfig = {
      name: 'Team',
      members: [
        { name: 'team-lead', agentType: 'team-lead', role: 'lead' },
        { name: 'ops.bot', agentType: 'general-purpose' },
      ],
    };

    const members = resolver.resolveMembers(config, [], ['ops.bot'], []);
    const names = members.map((m) => m.name);

    expect(names).toContain('ops.bot');
  });

  it('ignores pseudo cross-team inbox names', () => {
    const resolver = new TeamMemberResolver();
    const config: TeamConfig = {
      name: 'Team',
      members: [{ name: 'team-lead', agentType: 'team-lead', role: 'lead' }],
    };

    const members = resolver.resolveMembers(
      config,
      [],
      ['cross-team:team-alpha-super', 'cross-team-team-alpha-super', 'alice'],
      []
    );
    const names = members.map((m) => m.name);

    expect(names).toContain('alice');
    expect(names).toContain('team-lead');
    expect(names).not.toContain('cross-team:team-alpha-super');
    expect(names).not.toContain('cross-team-team-alpha-super');
  });

  it('ignores tool-like cross-team inbox names', () => {
    const resolver = new TeamMemberResolver();
    const config: TeamConfig = {
      name: 'Team',
      members: [{ name: 'team-lead', agentType: 'team-lead', role: 'lead' }],
    };

    const members = resolver.resolveMembers(
      config,
      [],
      ['cross_team_send', 'cross_team_list_targets', 'alice'],
      []
    );
    const names = members.map((m) => m.name);

    expect(names).toContain('alice');
    expect(names).toContain('team-lead');
    expect(names).not.toContain('cross_team_send');
    expect(names).not.toContain('cross_team_list_targets');
  });

  it('ignores malformed underscore-style pseudo cross-team inbox names', () => {
    const resolver = new TeamMemberResolver();
    const config: TeamConfig = {
      name: 'Team',
      members: [{ name: 'team-lead', agentType: 'team-lead', role: 'lead' }],
    };

    const members = resolver.resolveMembers(
      config,
      [],
      ['cross_team::team-alpha-super', 'cross_team--team-alpha-super', 'alice'],
      []
    );
    const names = members.map((m) => m.name);

    expect(names).toContain('alice');
    expect(names).toContain('team-lead');
    expect(names).not.toContain('cross_team::team-alpha-super');
    expect(names).not.toContain('cross_team--team-alpha-super');
  });

  it('keeps dotted names when config casing differs from inbox casing', () => {
    const resolver = new TeamMemberResolver();
    const config: TeamConfig = {
      name: 'Team',
      members: [
        { name: 'team-lead', agentType: 'team-lead', role: 'lead' },
        { name: 'Ops.Bot', agentType: 'general-purpose' },
      ],
    };

    const members = resolver.resolveMembers(config, [], ['ops.bot'], []);
    const names = members.map((m) => m.name);

    expect(names).toContain('Ops.Bot');
    expect(names).not.toContain('ops.bot');
  });

  it('does not let a removed base member hide an active suffixed teammate', () => {
    const resolver = new TeamMemberResolver();
    const config: TeamConfig = {
      name: 'Team',
      members: [
        { name: 'team-lead', agentType: 'team-lead', role: 'lead' },
        { name: 'alice-2', agentType: 'general-purpose' },
      ],
    };
    const metaMembers: TeamConfig['members'] = [
      {
        name: 'alice',
        agentType: 'general-purpose',
        removedAt: 1715000000000,
      },
    ];

    const members = resolver.resolveMembers(config, metaMembers, [], []);
    const names = members.map((member) => member.name);

    expect(names).toContain('alice-2');
    expect(names).toContain('alice');
  });

  it('sets currentTaskId for in_progress task', () => {
    const resolver = new TeamMemberResolver();
    const config: TeamConfig = {
      name: 'Team',
      members: [{ name: 'bob', agentType: 'general-purpose' }],
    };
    const tasks: TeamTaskWithKanban[] = [
      { id: 't1', subject: 'Work', status: 'in_progress', owner: 'bob' },
    ];
    const members = resolver.resolveMembers(config, [], [], tasks);
    const bob = members.find((m) => m.name === 'bob');
    expect(bob?.currentTaskId).toBe('t1');
  });

  it('clears currentTaskId when task is approved via kanbanColumn', () => {
    const resolver = new TeamMemberResolver();
    const config: TeamConfig = {
      name: 'Team',
      members: [{ name: 'bob', agentType: 'general-purpose' }],
    };
    const tasks: TeamTaskWithKanban[] = [
      {
        id: 't1',
        subject: 'Work',
        status: 'in_progress',
        owner: 'bob',
        reviewState: 'approved',
        kanbanColumn: 'approved',
      },
    ];
    const members = resolver.resolveMembers(config, [], [], tasks);
    const bob = members.find((m) => m.name === 'bob');
    expect(bob?.currentTaskId).toBeNull();
  });

  it('clears currentTaskId when task reviewState is approved even without kanbanColumn', () => {
    const resolver = new TeamMemberResolver();
    const config: TeamConfig = {
      name: 'Team',
      members: [{ name: 'bob', agentType: 'general-purpose' }],
    };
    const tasks: TeamTaskWithKanban[] = [
      {
        id: 't1',
        subject: 'Work',
        status: 'in_progress',
        owner: 'bob',
        reviewState: 'approved',
        // kanbanColumn not set — stale data scenario
      },
    ];
    const members = resolver.resolveMembers(config, [], [], tasks);
    const bob = members.find((m) => m.name === 'bob');
    expect(bob?.currentTaskId).toBeNull();
  });

  it('merges inbox-derived "lead" alias into canonical "team-lead"', () => {
    const resolver = new TeamMemberResolver();
    const config: TeamConfig = {
      name: 'Team',
      members: [
        { name: 'team-lead', agentType: 'team-lead', role: 'lead' },
        { name: 'alice', agentType: 'general-purpose' },
      ],
    };
    // Teammates sometimes send messages to "lead" instead of "team-lead",
    // creating a separate inbox file that the resolver picks up.
    const inboxNames = ['team-lead', 'lead', 'alice'];
    const members = resolver.resolveMembers(config, [], inboxNames, []);
    const names = members.map((m) => m.name);

    expect(names).toContain('team-lead');
    expect(names).not.toContain('lead');
    expect(names).toContain('alice');
  });

  it('keeps "lead" as a member when "team-lead" is not present', () => {
    const resolver = new TeamMemberResolver();
    const config: TeamConfig = {
      name: 'Team',
      members: [{ name: 'lead', agentType: 'team-lead', role: 'lead' }],
    };
    const members = resolver.resolveMembers(config, [], ['lead'], []);
    const names = members.map((m) => m.name);

    expect(names).toContain('lead');
  });

  it('clears currentTaskId when task status is completed', () => {
    const resolver = new TeamMemberResolver();
    const config: TeamConfig = {
      name: 'Team',
      members: [{ name: 'bob', agentType: 'general-purpose' }],
    };
    const tasks: TeamTaskWithKanban[] = [
      { id: 't1', subject: 'Work', status: 'completed', owner: 'bob' },
    ];
    const members = resolver.resolveMembers(config, [], [], tasks);
    const bob = members.find((m) => m.name === 'bob');
    expect(bob?.currentTaskId).toBeNull();
  });
});
