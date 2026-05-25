import { describe, expect, it } from 'vitest';

import {
  hasWorkSyncActiveRuntime,
  isRuntimeEntryActiveForWorkSync,
} from '../memberWorkSyncTeamActivity';

import type { TeamAgentRuntimeEntry, TeamAgentRuntimeSnapshot } from '@shared/types';

function createRuntimeEntry(overrides: Partial<TeamAgentRuntimeEntry> = {}): TeamAgentRuntimeEntry {
  return {
    memberName: 'alice',
    alive: true,
    restartable: true,
    backendType: 'process',
    providerId: 'codex',
    providerBackendId: 'codex-native',
    livenessKind: 'runtime_process',
    pid: 46773,
    updatedAt: '2026-05-18T19:44:48.000Z',
    ...overrides,
  };
}

function createRuntimeSnapshot(
  members: Record<string, TeamAgentRuntimeEntry>
): TeamAgentRuntimeSnapshot {
  return {
    teamName: 'signal-ops-6',
    updatedAt: '2026-05-18T19:44:48.000Z',
    runId: null,
    members,
  };
}

describe('member work sync team activity', () => {
  it('treats a verified runtime process as active', () => {
    expect(isRuntimeEntryActiveForWorkSync(createRuntimeEntry())).toBe(true);
  });

  it('treats a confirmed bootstrap runtime entry as active', () => {
    expect(
      isRuntimeEntryActiveForWorkSync(
        createRuntimeEntry({
          livenessKind: 'confirmed_bootstrap',
          runtimeLastSeenAt: '2026-05-18T19:44:47.000Z',
        })
      )
    ).toBe(true);
  });

  it('does not treat inactive liveness diagnostics as active by themselves', () => {
    for (const livenessKind of [
      'permission_blocked',
      'runtime_process_candidate',
      'shell_only',
      'registered_only',
      'stale_metadata',
      'not_found',
    ] as const) {
      expect(isRuntimeEntryActiveForWorkSync(createRuntimeEntry({ livenessKind }))).toBe(false);
    }
  });

  it('does not treat a runtime candidate as active until it is alive', () => {
    expect(
      isRuntimeEntryActiveForWorkSync(
        createRuntimeEntry({
          alive: false,
          livenessKind: 'runtime_process_candidate',
        })
      )
    ).toBe(false);
  });

  it('detects an active runtime among stale members', () => {
    expect(
      hasWorkSyncActiveRuntime(
        createRuntimeSnapshot({
          alice: createRuntimeEntry({ alive: false, livenessKind: 'stale_metadata' }),
          bob: createRuntimeEntry({ memberName: 'bob', livenessKind: 'runtime_process' }),
        })
      )
    ).toBe(true);
  });

  it('returns false when no member has active runtime evidence', () => {
    expect(
      hasWorkSyncActiveRuntime(
        createRuntimeSnapshot({
          alice: createRuntimeEntry({ alive: false, livenessKind: 'stale_metadata' }),
          bob: createRuntimeEntry({
            memberName: 'bob',
            alive: false,
            livenessKind: 'registered_only',
          }),
        })
      )
    ).toBe(false);
  });

  it('handles missing snapshots as inactive', () => {
    expect(hasWorkSyncActiveRuntime(null)).toBe(false);
    expect(hasWorkSyncActiveRuntime(undefined)).toBe(false);
  });
});
