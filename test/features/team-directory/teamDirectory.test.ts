import { describe, expect, it } from 'vitest';

import {
  buildTeamDirectoryRows,
  type DesktopTeamDirectoryRow,
  type HostedTeamDirectoryRow,
  resolveTeamDirectoryOpenIntent,
} from '../../../src/features/team-directory/renderer';

const all = { query: '', selectedStatuses: new Set<'running' | 'offline'>() };

function desktop(
  targetKey: string,
  facts: Partial<DesktopTeamDirectoryRow> = {}
): DesktopTeamDirectoryRow {
  return {
    source: 'desktop',
    scopeKey: 'local',
    targetKey,
    teamName: targetKey,
    displayName: targetKey,
    description: '',
    runtime: 'offline',
    matchesCurrentProject: false,
    lastActivityMs: null,
    ...facts,
  };
}

function hosted(
  scopeKey: string,
  targetKey: string,
  facts: Partial<HostedTeamDirectoryRow> = {}
): HostedTeamDirectoryRow {
  return {
    source: 'hosted',
    scopeKey,
    targetKey,
    displayName: 'Same team',
    runtime: 'unknown',
    ...facts,
  };
}

describe('team directory projection', () => {
  it('searches only source-provided fields with the existing trim/case/substr behavior', () => {
    const rows = [
      desktop('alpha', { displayName: 'Display Alpha', description: 'Bug triage' }),
      desktop('beta', { teamName: 'Night Shift' }),
      hosted('w1', 'opaque-1', { displayName: 'Operations', safeSearchTokens: ['East'] }),
    ];
    expect(buildTeamDirectoryRows(rows, { ...all, query: '  TRIAGE  ' }).map((r) => r.targetKey))
      .toEqual(['alpha']);
    expect(buildTeamDirectoryRows(rows, { ...all, query: 'night' }).map((r) => r.targetKey))
      .toEqual(['beta']);
    expect(buildTeamDirectoryRows(rows, { ...all, query: 'east' }).map((r) => r.targetKey))
      .toEqual(['opaque-1']);
    expect(buildTeamDirectoryRows([hosted('w1', 'opaque-1')], { ...all, query: 'opaque' }))
      .toEqual([]);
  });

  it('treats selected statuses as a union and excludes unknown from both filters', () => {
    const rows = [
      hosted('w', 'running', { runtime: 'running' }),
      hosted('w', 'offline', { runtime: 'offline' }),
      hosted('w', 'unknown'),
    ];
    expect(buildTeamDirectoryRows(rows, all)).toHaveLength(3);
    expect(buildTeamDirectoryRows(rows, { ...all, selectedStatuses: new Set(['running']) })
      .map((r) => r.targetKey)).toEqual(['running']);
    expect(buildTeamDirectoryRows(rows, { ...all, selectedStatuses: new Set(['offline']) })
      .map((r) => r.targetKey)).toEqual(['offline']);
    expect(buildTeamDirectoryRows(rows, { ...all, selectedStatuses: new Set(['running', 'offline']) })
      .map((r) => r.targetKey)).toEqual(['running', 'offline']);
  });

  it('keeps Desktop running, project, activity, teamName priority with identity tie-break', () => {
    const rows = [
      desktop('last', { teamName: 'Zed', runtime: 'offline', matchesCurrentProject: true, lastActivityMs: 90 }),
      desktop('project', { teamName: 'B', runtime: 'running', matchesCurrentProject: true, lastActivityMs: 10 }),
      desktop('recent', { teamName: 'C', runtime: 'running', lastActivityMs: 100 }),
      desktop('older', { teamName: 'A', runtime: 'running', lastActivityMs: 5 }),
      desktop('a2', { teamName: 'Same', runtime: 'running', matchesCurrentProject: true, lastActivityMs: 5 }),
      desktop('a1', { teamName: 'Same', runtime: 'running', matchesCurrentProject: true, lastActivityMs: 5 }),
    ];
    expect(buildTeamDirectoryRows(rows, all).map((r) => r.targetKey)).toEqual([
      'project', 'a1', 'a2', 'recent', 'older', 'last',
    ]);
    expect(rows.map((r) => r.targetKey)[0]).toBe('last');
  });

  it('orders Hosted by running, displayName and opaque identity without invented metadata', () => {
    const rows = [
      hosted('w', 'z', { displayName: 'Zeta' }),
      hosted('w', 'b', { displayName: 'Alpha' }),
      hosted('w', 'a', { displayName: 'Alpha' }),
      hosted('w', 'r', { displayName: 'Running', runtime: 'running' }),
    ];
    expect(buildTeamDirectoryRows(rows, all).map((r) => r.targetKey)).toEqual(['r', 'a', 'b', 'z']);
  });

  it('resolves a same-name selection only in the current scope and read epoch', () => {
    const a = hosted('workspace-a', 'team-1');
    const b = hosted('workspace-b', 'team-2');
    const intent = { scopeKey: a.scopeKey, targetKey: a.targetKey, readEpoch: 4 };
    expect(resolveTeamDirectoryOpenIntent(intent, { scopeKey: 'workspace-a', readEpoch: 4, rows: [a] }))
      .toBe(a);
    expect(resolveTeamDirectoryOpenIntent(intent, { scopeKey: 'workspace-b', readEpoch: 4, rows: [b] }))
      .toBeNull();
    expect(resolveTeamDirectoryOpenIntent(intent, { scopeKey: 'workspace-a', readEpoch: 5, rows: [a] }))
      .toBeNull();
    expect(resolveTeamDirectoryOpenIntent(intent, { scopeKey: 'workspace-a', readEpoch: 4, rows: [] }))
      .toBeNull();
  });
});
