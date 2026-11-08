import { describe, expect, it } from 'vitest';

import { preserveReliableTaskBoardSnapshot } from '../../../src/renderer/store/team/teamSnapshotReadFallback';

import type { TeamViewSnapshot } from '../../../src/shared/types';

function snapshot(overrides: Partial<TeamViewSnapshot> = {}): TeamViewSnapshot {
  return {
    teamName: 'test-team',
    config: { name: 'Test team' },
    tasks: [],
    members: [],
    processes: [],
    kanbanState: { teamName: 'test-team', reviewers: [], tasks: {} },
    ...overrides,
  };
}

describe('preserveReliableTaskBoardSnapshot', () => {
  const previous = snapshot({
    tasks: [{ id: 'task-1', subject: 'Keep this task', status: 'in_progress' }],
    kanbanState: {
      teamName: 'test-team',
      reviewers: [],
      tasks: { 'task-1': { column: 'review', movedAt: '2026-11-07T10:00:00Z' } },
    },
  });

  it('keeps old tasks on a failed task read but accepts unrelated fresh fields', () => {
    const incoming = snapshot({
      warnings: ['Tasks failed to load'],
      config: { name: 'Renamed team' },
    });
    const result = preserveReliableTaskBoardSnapshot(previous, incoming);
    expect(result.tasks).toBe(previous.tasks);
    expect(result.kanbanState).toBe(incoming.kanbanState);
    expect(result.config).toBe(incoming.config);
    expect(result.warnings).toEqual(['Tasks failed to load']);
  });

  it('keeps authoritative review state if the kanban file failed to load', () => {
    const incoming = snapshot({ warnings: ['Kanban state failed to load'] });
    const result = preserveReliableTaskBoardSnapshot(previous, incoming);
    expect(result.kanbanState).toBe(previous.kanbanState);
    expect(result.tasks).toBe(incoming.tasks);
  });

  it('retains both branches if both reads failed', () => {
    const incoming = snapshot({ warnings: ['Tasks failed to load', 'Kanban state failed to load'] });
    const result = preserveReliableTaskBoardSnapshot(previous, incoming);
    expect(result.tasks).toBe(previous.tasks);
    expect(result.kanbanState).toBe(previous.kanbanState);
  });

  it('accepts a real deletion and fresh tasks after successful reads', () => {
    const empty = snapshot();
    expect(preserveReliableTaskBoardSnapshot(previous, empty)).toBe(empty);
    const restored = snapshot({ tasks: [{ id: 'task-2', subject: 'New task', status: 'pending' }] });
    expect(preserveReliableTaskBoardSnapshot(previous, restored)).toBe(restored);
  });

  it('does not leak tasks across teams or invent previous data', () => {
    const incoming = snapshot({ teamName: 'another-team', warnings: ['Tasks failed to load'] });
    expect(preserveReliableTaskBoardSnapshot(previous, incoming)).toBe(incoming);
    expect(preserveReliableTaskBoardSnapshot(null, incoming)).toBe(incoming);
  });

  it('does not hide empty tasks when only an unrelated read failed', () => {
    const incoming = snapshot({ warnings: ['Inboxes failed to load'] });
    expect(preserveReliableTaskBoardSnapshot(previous, incoming)).toBe(incoming);
  });
});
