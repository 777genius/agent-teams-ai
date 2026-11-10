import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearResolvedMemberSelectorCaches,
  getResolvedMemberSelectorCacheSnapshotForTeam,
  selectResolvedMemberForTeamName,
  selectResolvedMembersForTeamName,
  shouldPreserveSelectedTeamSnapshot,
} from '../../../src/renderer/store/team/teamResolvedMembers';

import type {
  TeamMemberActivityMeta,
  TeamMemberSnapshot,
  TeamSummary,
  TeamTask,
  TeamViewSnapshot,
} from '../../../src/shared/types';

function createTask(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 'task-1',
    subject: 'Task',
    owner: 'alice',
    status: 'in_progress',
    ...overrides,
  };
}

function createSnapshot(overrides: Partial<TeamViewSnapshot> = {}): TeamViewSnapshot {
  return {
    teamName: 'my-team',
    config: { name: 'My Team' },
    tasks: [],
    members: [],
    kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
    processes: [],
    ...overrides,
  } as TeamViewSnapshot;
}

function createState(
  snapshot: TeamViewSnapshot,
  options: {
    summary?: TeamSummary;
    meta?: TeamMemberActivityMeta;
  } = {}
) {
  return {
    selectedTeamName: snapshot.teamName,
    selectedTeamData: snapshot,
    teamDataCacheByName: { [snapshot.teamName]: snapshot },
    memberActivityMetaByTeam: options.meta ? { [snapshot.teamName]: options.meta } : {},
    teamByName: options.summary ? { [snapshot.teamName]: options.summary } : {},
  };
}

describe('teamResolvedMembers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T12:00:00.000Z'));
    clearResolvedMemberSelectorCaches();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearResolvedMemberSelectorCaches();
  });

  it('builds config fallback members when runtime snapshots are empty', () => {
    const snapshot = createSnapshot({
      config: {
        name: 'My Team',
        members: [
          { name: 'team-lead', role: 'Lead' },
          { name: 'alice', agentId: 'agent-a', role: 'Engineer' },
          { name: 'Alice', agentId: 'duplicate' },
        ],
      },
      tasks: [
        createTask({ id: 'task-active', owner: 'alice', status: 'in_progress' }),
        createTask({ id: 'task-done', owner: 'alice', status: 'completed' }),
      ],
    });

    const members = selectResolvedMembersForTeamName(createState(snapshot), 'my-team');

    expect(members.map((member) => member.name)).toEqual(['team-lead', 'alice']);
    expect(members[1]).toMatchObject({
      name: 'alice',
      agentId: 'agent-a',
      currentTaskId: 'task-active',
      taskCount: 2,
      role: 'Engineer',
      status: 'active',
      messageCount: 0,
      lastActiveAt: null,
    });
  });

  it('builds summary fallback members with a lead when config and runtime snapshots are empty', () => {
    const snapshot = createSnapshot();
    const summary = {
      teamName: 'my-team',
      displayName: 'My Team',
      memberCount: 2,
      taskCount: 0,
      lastActivity: null,
      leadName: 'lead-one',
      leadColor: '#fff',
      members: [
        { name: 'lead-one', role: 'Lead' },
        { name: 'bob', agentId: 'agent-b', role: 'Reviewer', color: '#123456' },
        { name: 'Bob', agentId: 'duplicate' },
      ],
    } as TeamSummary;

    const members = selectResolvedMembersForTeamName(createState(snapshot, { summary }), 'my-team');

    expect(members.map((member) => member.name)).toEqual(['lead-one', 'bob']);
    expect(members[0]).toMatchObject({ agentType: 'team-lead', role: 'Team Lead' });
    expect(members[1]).toMatchObject({
      agentId: 'agent-b',
      role: 'Reviewer',
      color: '#123456',
    });
  });

  it('memoizes selector results until resolved-member cache is cleared', () => {
    const snapshot = createSnapshot({
      members: [{ name: 'alice', currentTaskId: null, taskCount: 0 } as TeamMemberSnapshot],
    });
    const state = createState(snapshot);

    const firstMembers = selectResolvedMembersForTeamName(state, 'my-team');
    const secondMembers = selectResolvedMembersForTeamName(state, 'my-team');
    const firstAlice = selectResolvedMemberForTeamName(state, 'my-team', 'alice');
    const secondAlice = selectResolvedMemberForTeamName(state, 'my-team', 'alice');

    expect(secondMembers).toBe(firstMembers);
    expect(secondAlice).toBe(firstAlice);
    expect(getResolvedMemberSelectorCacheSnapshotForTeam('my-team')).toEqual({
      hasResolvedMembersSelector: true,
      resolvedMemberSelectorCount: 1,
    });

    clearResolvedMemberSelectorCaches();

    expect(selectResolvedMembersForTeamName(state, 'my-team')).not.toBe(firstMembers);
    expect(getResolvedMemberSelectorCacheSnapshotForTeam('my-team')).toEqual({
      hasResolvedMembersSelector: true,
      resolvedMemberSelectorCount: 0,
    });
  });

  it('derives activity status from member activity metadata', () => {
    const snapshot = createSnapshot({
      members: [{ name: 'alice', currentTaskId: null, taskCount: 0 } as TeamMemberSnapshot],
    });
    const meta = {
      teamName: 'my-team',
      feedRevision: 'rev-1',
      computedAt: '2026-04-17T12:00:00.000Z',
      members: {
        alice: {
          memberName: 'alice',
          lastAuthoredMessageAt: '2026-04-17T11:57:00.000Z',
          messageCountExact: 3,
          latestAuthoredMessageSignalsTermination: false,
        },
      },
    } as TeamMemberActivityMeta;

    expect(selectResolvedMemberForTeamName(createState(snapshot, { meta }), 'my-team', 'alice'))
      .toMatchObject({
        status: 'active',
        messageCount: 3,
        lastActiveAt: '2026-04-17T11:57:00.000Z',
      });
  });

  it('preserves the selected snapshot when an incoming empty snapshot is confirmed by summary', () => {
    const current = createSnapshot({
      members: [{ name: 'alice', currentTaskId: null, taskCount: 0 } as TeamMemberSnapshot],
    });
    const incoming = createSnapshot({ members: [], config: { name: 'My Team' } });
    const summary = {
      teamName: 'my-team',
      displayName: 'My Team',
      memberCount: 1,
      expectedMemberCount: 1,
      taskCount: 0,
      lastActivity: null,
      members: [{ name: 'alice' }],
    } as TeamSummary;

    expect(shouldPreserveSelectedTeamSnapshot(current, current, incoming, summary)).toBe(true);
  });

  it('does not preserve the selected snapshot when incoming data has a config roster', () => {
    const current = createSnapshot({
      members: [{ name: 'alice', currentTaskId: null, taskCount: 0 } as TeamMemberSnapshot],
    });
    const incoming = createSnapshot({
      members: [],
      config: { name: 'My Team', members: [{ name: 'bob' }] },
    });

    expect(shouldPreserveSelectedTeamSnapshot(current, current, incoming, undefined)).toBe(false);
  });
});
