import { describe, expect, it } from 'vitest';

import {
  structurallySharePlainValue,
  structurallyShareTeamSnapshot,
} from '../../../src/renderer/store/team/teamSnapshotStructuralSharing';

import type { TeamViewSnapshot } from '../../../src/shared/types';

function createSnapshot(overrides: Partial<TeamViewSnapshot> = {}): TeamViewSnapshot {
  return {
    teamName: 'my-team',
    config: { name: 'My Team' },
    members: [],
    tasks: [],
    kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
    processes: [],
    ...overrides,
  };
}

describe('teamSnapshotStructuralSharing', () => {
  it('returns the next snapshot when there is no previous snapshot', () => {
    const next = createSnapshot();

    expect(structurallyShareTeamSnapshot(null, next)).toBe(next);
    expect(structurallyShareTeamSnapshot(undefined, next)).toBe(next);
  });

  it('preserves the previous snapshot reference when values are deeply equal', () => {
    const previous = createSnapshot({
      config: { name: 'My Team', description: 'Same description' },
      warnings: ['same warning'],
      isAlive: true,
    });
    const next = createSnapshot({
      config: { name: 'My Team', description: 'Same description' },
      warnings: ['same warning'],
      isAlive: true,
    });

    expect(structurallyShareTeamSnapshot(previous, next)).toBe(previous);
  });

  it('replaces only changed snapshot branches while sharing unchanged branches', () => {
    const previousWarnings = ['same warning'];
    const previous = createSnapshot({
      config: { name: 'My Team', description: 'Old description' },
      warnings: previousWarnings,
      isAlive: true,
    });
    const next = createSnapshot({
      config: { name: 'My Team', description: 'New description' },
      warnings: ['same warning'],
      isAlive: true,
    });

    const shared = structurallyShareTeamSnapshot(previous, next);

    expect(shared).not.toBe(previous);
    expect(shared).toEqual(next);
    expect(shared.config).not.toBe(previous.config);
    expect(shared.warnings).toBe(previousWarnings);
    expect(shared.members).toBe(previous.members);
    expect(shared.tasks).toBe(previous.tasks);
    expect(shared.kanbanState).toBe(previous.kanbanState);
    expect(shared.processes).toBe(previous.processes);
  });

  it('shares unchanged array entries and replaces changed entries', () => {
    const previous = [
      { id: 'task-1', title: 'Keep' },
      { id: 'task-2', title: 'Old' },
    ];
    const next = [
      { id: 'task-1', title: 'Keep' },
      { id: 'task-2', title: 'New' },
    ];

    const shared = structurallySharePlainValue(previous, next);

    expect(shared).not.toBe(previous);
    expect(shared).toEqual(next);
    expect(shared[0]).toBe(previous[0]);
    expect(shared[1]).not.toBe(previous[1]);
  });

  it('replaces objects when keys are added or removed', () => {
    const previous = { id: 'task-1', title: 'Same', extra: true };
    const next = { id: 'task-1', title: 'Same' };

    const shared = structurallySharePlainValue(previous, next);

    expect(shared).not.toBe(previous);
    expect(shared).toEqual(next);
  });

  it('treats null-prototype objects as plain values', () => {
    const previous = Object.assign(Object.create(null) as Record<string, unknown>, {
      id: 'task-1',
      title: 'Same',
    });
    const next = Object.assign(Object.create(null) as Record<string, unknown>, {
      id: 'task-1',
      title: 'Same',
    });

    expect(structurallySharePlainValue(previous, next)).toBe(previous);
  });

  it('replaces non-plain objects instead of traversing them', () => {
    const previous = new Date('2026-05-22T10:00:00.000Z');
    const next = new Date('2026-05-22T10:00:00.000Z');

    expect(structurallySharePlainValue(previous, next)).toBe(next);
  });
});
