import { describe, expect, it } from 'vitest';

import {
  areTeamAgentRuntimeEntriesEqual,
  areTeamAgentRuntimeResourceSamplesEqual,
  areTeamAgentRuntimeSnapshotsEqual,
} from '../../../src/renderer/store/team/teamAgentRuntimeSnapshotEquality';

import type {
  TeamAgentRuntimeEntry,
  TeamAgentRuntimeResourceSample,
  TeamAgentRuntimeSnapshot,
} from '../../../src/shared/types';

function createResourceSample(
  overrides: Partial<TeamAgentRuntimeResourceSample> = {}
): TeamAgentRuntimeResourceSample {
  return {
    timestamp: '2026-05-22T10:00:00.000Z',
    cpuPercent: 4,
    rssBytes: 1024,
    primaryCpuPercent: 3,
    primaryRssBytes: 768,
    childCpuPercent: 1,
    childRssBytes: 256,
    processCount: 2,
    runtimeLoadScope: 'process-tree',
    runtimeLoadTruncated: false,
    pidSource: 'agent_process_table',
    pid: 111,
    runtimePid: 222,
    ...overrides,
  };
}

function createRuntimeEntry(overrides: Partial<TeamAgentRuntimeEntry> = {}): TeamAgentRuntimeEntry {
  return {
    memberName: 'alice',
    alive: true,
    restartable: true,
    backendType: 'process',
    providerId: 'codex',
    providerBackendId: 'codex-native',
    laneId: 'lane-1',
    laneKind: 'primary',
    pid: 111,
    runtimeModel: 'gpt-5.3-codex',
    cwd: '/tmp/old',
    rssBytes: 1024,
    cpuPercent: 4,
    primaryCpuPercent: 3,
    primaryRssBytes: 768,
    childCpuPercent: 1,
    childRssBytes: 256,
    processCount: 2,
    runtimeLoadScope: 'process-tree',
    runtimeLoadTruncated: false,
    resourceHistory: [createResourceSample()],
    livenessKind: 'confirmed_bootstrap',
    pidSource: 'agent_process_table',
    processCommand: 'codex',
    paneId: '%1',
    panePid: 333,
    paneCurrentCommand: 'node',
    runtimePid: 222,
    runtimeSessionId: 'runtime-session-1',
    runtimeLeaseExpiresAt: '2026-05-22T10:10:00.000Z',
    runtimeLastSeenAt: '2026-05-22T10:00:00.000Z',
    historicalBootstrapConfirmed: true,
    runtimeDiagnostic: 'Ready',
    runtimeDiagnosticSeverity: 'info',
    diagnostics: ['healthy'],
    updatedAt: '2026-05-22T10:00:00.000Z',
    ...overrides,
  };
}

function createRuntimeSnapshot(
  overrides: Partial<TeamAgentRuntimeSnapshot> = {}
): TeamAgentRuntimeSnapshot {
  return {
    teamName: 'my-team',
    updatedAt: '2026-05-22T10:00:00.000Z',
    runId: 'run-1',
    providerBackendId: 'codex-native',
    fastMode: 'inherit',
    members: {
      alice: createRuntimeEntry(),
    },
    ...overrides,
  };
}

describe('teamAgentRuntimeSnapshotEquality', () => {
  it('compares runtime resource samples by visible process metrics', () => {
    expect(
      areTeamAgentRuntimeResourceSamplesEqual(createResourceSample(), createResourceSample())
    ).toBe(true);
    expect(
      areTeamAgentRuntimeResourceSamplesEqual(
        createResourceSample(),
        createResourceSample({ cpuPercent: 5 })
      )
    ).toBe(false);
    expect(areTeamAgentRuntimeResourceSamplesEqual(null, createResourceSample())).toBe(false);
  });

  it('ignores runtime entry fields that do not currently affect equality', () => {
    const left = createRuntimeEntry({
      cwd: '/tmp/old',
      runtimeLeaseExpiresAt: '2026-05-22T10:10:00.000Z',
      updatedAt: '2026-05-22T10:00:00.000Z',
    });
    const right = createRuntimeEntry({
      cwd: '/tmp/new',
      runtimeLeaseExpiresAt: '2026-05-22T10:20:00.000Z',
      updatedAt: '2026-05-22T10:05:00.000Z',
    });

    expect(areTeamAgentRuntimeEntriesEqual(left, right)).toBe(true);
  });

  it('detects visible runtime entry field changes', () => {
    expect(
      areTeamAgentRuntimeEntriesEqual(
        createRuntimeEntry(),
        createRuntimeEntry({ runtimeDiagnosticSeverity: 'warning' })
      )
    ).toBe(false);
    expect(
      areTeamAgentRuntimeEntriesEqual(
        createRuntimeEntry(),
        createRuntimeEntry({ resourceHistory: [createResourceSample({ rssBytes: 2048 })] })
      )
    ).toBe(false);
  });

  it('compares diagnostics and resource history arrays in stable order', () => {
    expect(
      areTeamAgentRuntimeEntriesEqual(
        createRuntimeEntry({ diagnostics: ['a', 'b'] }),
        createRuntimeEntry({ diagnostics: ['b', 'a'] })
      )
    ).toBe(false);
    expect(
      areTeamAgentRuntimeEntriesEqual(
        createRuntimeEntry({
          resourceHistory: [
            createResourceSample({ timestamp: '2026-05-22T10:00:00.000Z' }),
            createResourceSample({ timestamp: '2026-05-22T10:01:00.000Z' }),
          ],
        }),
        createRuntimeEntry({
          resourceHistory: [
            createResourceSample({ timestamp: '2026-05-22T10:01:00.000Z' }),
            createResourceSample({ timestamp: '2026-05-22T10:00:00.000Z' }),
          ],
        })
      )
    ).toBe(false);
  });

  it('compares runtime snapshots by team, run id, and semantic member entries', () => {
    expect(areTeamAgentRuntimeSnapshotsEqual(createRuntimeSnapshot(), createRuntimeSnapshot())).toBe(
      true
    );
    expect(
      areTeamAgentRuntimeSnapshotsEqual(
        createRuntimeSnapshot(),
        createRuntimeSnapshot({ runId: 'run-2' })
      )
    ).toBe(false);
    expect(
      areTeamAgentRuntimeSnapshotsEqual(
        createRuntimeSnapshot(),
        createRuntimeSnapshot({
          members: {
            alice: createRuntimeEntry(),
            bob: createRuntimeEntry({ memberName: 'bob' }),
          },
        })
      )
    ).toBe(false);
  });

  it('ignores snapshot metadata fields that do not currently affect equality', () => {
    const left = createRuntimeSnapshot({
      updatedAt: '2026-05-22T10:00:00.000Z',
      providerBackendId: 'codex-native',
      fastMode: 'inherit',
    });
    const right = createRuntimeSnapshot({
      updatedAt: '2026-05-22T10:05:00.000Z',
      providerBackendId: 'api',
      fastMode: 'on',
    });

    expect(areTeamAgentRuntimeSnapshotsEqual(left, right)).toBe(true);
  });

  it('returns false when there is no previous runtime snapshot', () => {
    expect(areTeamAgentRuntimeSnapshotsEqual(undefined, createRuntimeSnapshot())).toBe(false);
  });
});
