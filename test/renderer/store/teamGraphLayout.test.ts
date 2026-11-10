import { describe, expect, it } from 'vitest';

import {
  areTeamGraphSlotAssignmentsEqual,
  getDefaultTeamGraphSlotAssignmentsForMembers,
  isTeamGraphSlotPersistenceDisabled,
  migrateStableSlotAssignmentsForMembers,
  normalizeLegacySixRowOrbitAssignments,
  normalizeTeamGraphGridOwnerOrder,
  normalizeTeamGraphSlotAssignmentsForVisibleOwners,
  pruneTeamGraphSlotAssignmentsForVisibleOwners,
  seedStableSlotAssignmentsForMembers,
} from '../../../src/renderer/store/team/teamGraphLayout';

describe('teamGraphLayout', () => {
  it('migrates legacy name-keyed assignments to stable owner ids', () => {
    const migrated = migrateStableSlotAssignmentsForMembers(
      {
        alice: { ringIndex: 0, sectorIndex: 1 },
      },
      [{ name: 'alice', agentId: 'agent-a' }]
    );

    expect(migrated.changed).toBe(true);
    expect(migrated.assignments).toEqual({
      'agent-a': { ringIndex: 0, sectorIndex: 1 },
    });
  });

  it('drops stale name-keyed assignments when stable assignments already exist', () => {
    const migrated = migrateStableSlotAssignmentsForMembers(
      {
        alice: { ringIndex: 0, sectorIndex: 1 },
        'agent-a': { ringIndex: 0, sectorIndex: 2 },
      },
      [{ name: 'alice', agentId: 'agent-a' }]
    );

    expect(migrated.changed).toBe(true);
    expect(migrated.assignments).toEqual({
      'agent-a': { ringIndex: 0, sectorIndex: 2 },
    });
  });

  it('seeds default assignments only when no visible owner has a persisted assignment', () => {
    const seeded = seedStableSlotAssignmentsForMembers(
      { unrelated: { ringIndex: 4, sectorIndex: 0 } },
      [
        { name: 'alice', agentId: 'agent-a' },
        { name: 'bob', agentId: 'agent-b' },
      ]
    );

    expect(seeded.changed).toBe(true);
    expect(Object.keys(seeded.assignments)).toEqual(['unrelated', 'agent-a', 'agent-b']);
    expect(seeded.assignments['agent-a']).toEqual({ ringIndex: 0, sectorIndex: 0 });
    expect(seeded.assignments['agent-b']).toEqual({ ringIndex: 0, sectorIndex: 1 });

    const preserved = seedStableSlotAssignmentsForMembers(seeded.assignments, [
      { name: 'alice', agentId: 'agent-a' },
      { name: 'bob', agentId: 'agent-b' },
    ]);
    expect(preserved.changed).toBe(false);
    expect(preserved.assignments).toBe(seeded.assignments);
  });

  it('normalizes six-owner legacy two-row orbit assignments', () => {
    const ownerIds = ['a', 'b', 'c', 'd', 'e', 'f'];
    const normalized = normalizeLegacySixRowOrbitAssignments(
      {
        a: { ringIndex: 0, sectorIndex: 0 },
        b: { ringIndex: 0, sectorIndex: 4 },
        c: { ringIndex: 1, sectorIndex: 2 },
        d: { ringIndex: 1, sectorIndex: 0 },
      },
      ownerIds
    );

    expect(normalized).toEqual({
      a: { ringIndex: 0, sectorIndex: 0 },
      b: { ringIndex: 2, sectorIndex: 1 },
      c: { ringIndex: 2, sectorIndex: 2 },
      d: { ringIndex: 2, sectorIndex: 0 },
    });
  });

  it('normalizes and prunes assignments to visible owners', () => {
    const normalized = normalizeTeamGraphSlotAssignmentsForVisibleOwners(
      {
        a: { ringIndex: 0, sectorIndex: 0 },
        hidden: { ringIndex: 4, sectorIndex: 4 },
      },
      ['a']
    );

    expect(normalized).toEqual({ a: { ringIndex: 0, sectorIndex: 0 } });
    expect(pruneTeamGraphSlotAssignmentsForVisibleOwners({ hidden: { ringIndex: 4, sectorIndex: 4 } }, ['a']))
      .toBeUndefined();
  });

  it('normalizes grid owner order by filtering stale and duplicate ids then appending missing ids', () => {
    expect(normalizeTeamGraphGridOwnerOrder(['b', 'stale', 'b'], ['a', 'b', 'c'])).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('compares assignments by owner id and slot coordinates', () => {
    expect(
      areTeamGraphSlotAssignmentsEqual(
        { a: { ringIndex: 0, sectorIndex: 0 } },
        { a: { ringIndex: 0, sectorIndex: 0 } }
      )
    ).toBe(true);
    expect(
      areTeamGraphSlotAssignmentsEqual(
        { a: { ringIndex: 0, sectorIndex: 0 } },
        { a: { ringIndex: 0, sectorIndex: 1 } }
      )
    ).toBe(false);
  });

  it('exposes default assignment and persistence guardrail helpers', () => {
    expect(
      getDefaultTeamGraphSlotAssignmentsForMembers([
        { name: 'team-lead', agentId: 'lead-agent' },
        { name: 'alice', agentId: 'agent-a' },
      ])
    ).toEqual({ 'agent-a': { ringIndex: 0, sectorIndex: 0 } });
    expect(isTeamGraphSlotPersistenceDisabled()).toBe(true);
  });
});
