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
    cwd: '/workspace/old',
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

  it('detects renderer-facing runtime entry metadata and default freshness changes', () => {
    expect(
      areTeamAgentRuntimeEntriesEqual(
        createRuntimeEntry({ cwd: '/workspace/old' }),
        createRuntimeEntry({ cwd: '/workspace/new' })
      )
    ).toBe(false);
    expect(
      areTeamAgentRuntimeEntriesEqual(
        createRuntimeEntry({ runtimeLeaseExpiresAt: '2026-05-22T10:10:00.000Z' }),
        createRuntimeEntry({ runtimeLeaseExpiresAt: '2026-05-22T10:20:00.000Z' })
      )
    ).toBe(false);
    expect(
      areTeamAgentRuntimeEntriesEqual(
        createRuntimeEntry({ updatedAt: '2026-05-22T10:00:00.000Z' }),
        createRuntimeEntry({ updatedAt: '2026-05-22T10:05:00.000Z' })
      )
    ).toBe(false);
    expect(
      areTeamAgentRuntimeEntriesEqual(
        createRuntimeEntry({ runtimeLastSeenAt: '2026-05-22T10:00:00.000Z' }),
        createRuntimeEntry({ runtimeLastSeenAt: '2026-05-22T10:00:05.000Z' })
      )
    ).toBe(false);
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

  it('returns true for unchanged snapshots and compares structural snapshot fields', () => {
    expect(
      areTeamAgentRuntimeSnapshotsEqual(createRuntimeSnapshot(), createRuntimeSnapshot())
    ).toBe(true);
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

  it('detects renderer-facing snapshot metadata changes', () => {
    expect(
      areTeamAgentRuntimeSnapshotsEqual(
        createRuntimeSnapshot({ providerBackendId: 'codex-native' }),
        createRuntimeSnapshot({ providerBackendId: 'api' })
      )
    ).toBe(false);
    expect(
      areTeamAgentRuntimeSnapshotsEqual(
        createRuntimeSnapshot({ fastMode: 'inherit' }),
        createRuntimeSnapshot({ fastMode: 'on' })
      )
    ).toBe(false);
  });

  it('uses a bounded freshness cadence with the default production options', () => {
    const left = createRuntimeSnapshot({
      updatedAt: '2026-05-22T10:00:00.000Z',
      members: {
        alice: createRuntimeEntry({
          updatedAt: '2026-05-22T10:00:00.000Z',
          runtimeLastSeenAt: '2026-05-22T10:00:00.000Z',
        }),
      },
    });
    const subCadence = createRuntimeSnapshot({
      updatedAt: '2026-05-22T10:00:04.999Z',
      members: {
        alice: createRuntimeEntry({
          updatedAt: '2026-05-22T10:00:04.999Z',
          runtimeLastSeenAt: '2026-05-22T10:00:04.999Z',
        }),
      },
    });
    const nextCadence = createRuntimeSnapshot({
      updatedAt: '2026-05-22T10:00:05.000Z',
      members: {
        alice: createRuntimeEntry({
          updatedAt: '2026-05-22T10:00:05.000Z',
          runtimeLastSeenAt: '2026-05-22T10:00:05.000Z',
        }),
      },
    });

    expect(areTeamAgentRuntimeSnapshotsEqual(left, subCadence)).toBe(true);
    expect(areTeamAgentRuntimeSnapshotsEqual(left, nextCadence)).toBe(false);
  });

  it('surfaces a heartbeat-only refresh without explicit production options', () => {
    const left = createRuntimeSnapshot({
      updatedAt: '2026-05-22T10:00:00.000Z',
      members: {
        alice: createRuntimeEntry({
          updatedAt: '2026-05-22T10:00:00.000Z',
          runtimeLastSeenAt: '2026-05-22T10:00:00.000Z',
        }),
      },
    });
    const right = createRuntimeSnapshot({
      updatedAt: '2026-05-22T10:00:10.000Z',
      members: {
        alice: createRuntimeEntry({
          updatedAt: '2026-05-22T10:00:10.000Z',
          runtimeLastSeenAt: '2026-05-22T10:00:10.000Z',
        }),
      },
    });

    expect(areTeamAgentRuntimeSnapshotsEqual(left, right)).toBe(false);
  });

  it('keeps timestamp-only comparisons monotonic', () => {
    const newer = createRuntimeSnapshot({
      updatedAt: '2026-05-22T10:00:10.000Z',
      members: {
        alice: createRuntimeEntry({
          updatedAt: '2026-05-22T10:00:10.000Z',
          runtimeLastSeenAt: '2026-05-22T10:00:10.000Z',
        }),
      },
    });
    const older = createRuntimeSnapshot({
      updatedAt: '2026-05-22T10:00:00.000Z',
      members: {
        alice: createRuntimeEntry({
          updatedAt: '2026-05-22T10:00:00.000Z',
          runtimeLastSeenAt: '2026-05-22T10:00:00.000Z',
        }),
      },
    });

    expect(areTeamAgentRuntimeSnapshotsEqual(newer, older)).toBe(true);
  });

  it('supports exact freshness checks and an explicit freshness opt-out', () => {
    const left = createRuntimeSnapshot();
    const right = createRuntimeSnapshot({ updatedAt: '2026-05-22T10:00:00.001Z' });

    expect(areTeamAgentRuntimeSnapshotsEqual(left, right)).toBe(true);
    expect(
      areTeamAgentRuntimeSnapshotsEqual(left, right, { compareFreshnessTimestamps: true })
    ).toBe(false);
    expect(
      areTeamAgentRuntimeSnapshotsEqual(left, right, { compareFreshnessTimestamps: false })
    ).toBe(true);
  });

  it('does not let regressive freshness hide structural changes', () => {
    const newer = createRuntimeSnapshot({
      updatedAt: '2026-05-22T10:00:10.000Z',
      members: {
        alice: createRuntimeEntry({
          alive: true,
          updatedAt: '2026-05-22T10:00:10.000Z',
          runtimeLastSeenAt: '2026-05-22T10:00:10.000Z',
        }),
      },
    });
    const structurallyChangedOlder = createRuntimeSnapshot({
      updatedAt: '2026-05-22T10:00:00.000Z',
      members: {
        alice: createRuntimeEntry({
          alive: false,
          updatedAt: '2026-05-22T10:00:00.000Z',
          runtimeLastSeenAt: '2026-05-22T10:00:00.000Z',
        }),
      },
    });

    expect(areTeamAgentRuntimeSnapshotsEqual(newer, structurallyChangedOlder)).toBe(false);
  });

  it('returns false when there is no previous runtime snapshot', () => {
    expect(areTeamAgentRuntimeSnapshotsEqual(undefined, createRuntimeSnapshot())).toBe(false);
  });
});
