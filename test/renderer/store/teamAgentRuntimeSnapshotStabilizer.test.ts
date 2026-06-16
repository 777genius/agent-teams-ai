import { describe, expect, it } from 'vitest';

import { stabilizeTeamAgentRuntimeSnapshot } from '../../../src/renderer/store/team/teamAgentRuntimeSnapshotStabilizer';

import type { TeamAgentRuntimeEntry, TeamAgentRuntimeSnapshot } from '../../../src/shared/types';

const BASE_TIME = '2026-05-31T10:00:00.000Z';
const BASE_TIME_MS = Date.parse(BASE_TIME);

function createRuntimeEntry(overrides: Partial<TeamAgentRuntimeEntry> = {}): TeamAgentRuntimeEntry {
  return {
    memberName: 'alice',
    alive: true,
    restartable: true,
    backendType: 'process',
    providerId: 'codex',
    providerBackendId: 'codex-native',
    pid: 12345,
    runtimeModel: 'gpt-5.5-codex',
    livenessKind: 'runtime_process',
    pidSource: 'agent_process_table',
    runtimeDiagnostic: 'verified runtime process detected',
    runtimeDiagnosticSeverity: 'info',
    diagnostics: ['matched process table by team-name and agent-id'],
    updatedAt: BASE_TIME,
    ...overrides,
  };
}

function createRuntimeSnapshot(
  overrides: Partial<TeamAgentRuntimeSnapshot> = {}
): TeamAgentRuntimeSnapshot {
  return {
    teamName: 'beacon-desk-14',
    updatedAt: BASE_TIME,
    runId: 'run-1',
    providerBackendId: 'codex-native',
    members: {
      alice: createRuntimeEntry(),
    },
    ...overrides,
  };
}

describe('teamAgentRuntimeSnapshotStabilizer', () => {
  it('keeps a recent live runtime entry through a transient registered-only snapshot', () => {
    const previous = createRuntimeSnapshot();
    const next = createRuntimeSnapshot({
      updatedAt: '2026-05-31T10:00:10.000Z',
      members: {
        alice: createRuntimeEntry({
          alive: false,
          livenessKind: 'registered_only',
          pidSource: 'persisted_metadata',
          runtimeDiagnostic: 'registered runtime metadata without live process',
          runtimeDiagnosticSeverity: 'warning',
          updatedAt: '2026-05-31T10:00:10.000Z',
        }),
      },
    });

    const stabilized = stabilizeTeamAgentRuntimeSnapshot(previous, next, BASE_TIME_MS + 10_000);

    expect(stabilized.members.alice).toBe(previous.members.alice);
    expect(stabilized.members.alice.alive).toBe(true);
    expect(stabilized.members.alice.livenessKind).toBe('runtime_process');
  });

  it('accepts the offline snapshot after the short stability grace expires', () => {
    const previous = createRuntimeSnapshot();
    const offlineEntry = createRuntimeEntry({
      alive: false,
      livenessKind: 'stale_metadata',
      pidSource: 'persisted_metadata',
      runtimeDiagnostic: 'persisted runtime pid is not alive',
      runtimeDiagnosticSeverity: 'warning',
      updatedAt: '2026-05-31T10:00:20.000Z',
    });
    const next = createRuntimeSnapshot({
      updatedAt: '2026-05-31T10:00:20.000Z',
      members: {
        alice: offlineEntry,
      },
    });

    const stabilized = stabilizeTeamAgentRuntimeSnapshot(previous, next, BASE_TIME_MS + 20_000);

    expect(stabilized.members.alice).toBe(offlineEntry);
    expect(stabilized.members.alice.alive).toBe(false);
    expect(stabilized.members.alice.livenessKind).toBe('stale_metadata');
  });

  it('does not mask explicit runtime errors', () => {
    const previous = createRuntimeSnapshot();
    const errorEntry = createRuntimeEntry({
      alive: false,
      livenessKind: 'registered_only',
      runtimeDiagnostic: 'runtime failed',
      runtimeDiagnosticSeverity: 'error',
      updatedAt: '2026-05-31T10:00:05.000Z',
    });
    const next = createRuntimeSnapshot({
      updatedAt: '2026-05-31T10:00:05.000Z',
      members: {
        alice: errorEntry,
      },
    });

    const stabilized = stabilizeTeamAgentRuntimeSnapshot(previous, next, BASE_TIME_MS + 5_000);

    expect(stabilized.members.alice).toBe(errorEntry);
    expect(stabilized.members.alice.runtimeDiagnosticSeverity).toBe('error');
  });

  it('does not carry live state across different runtime runs', () => {
    const previous = createRuntimeSnapshot({ runId: 'run-1' });
    const next = createRuntimeSnapshot({
      runId: 'run-2',
      members: {
        alice: createRuntimeEntry({
          alive: false,
          livenessKind: 'registered_only',
          updatedAt: '2026-05-31T10:00:05.000Z',
        }),
      },
    });

    const stabilized = stabilizeTeamAgentRuntimeSnapshot(previous, next, BASE_TIME_MS + 5_000);

    expect(stabilized).toBe(next);
    expect(stabilized.members.alice.alive).toBe(false);
  });
});
