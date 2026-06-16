import { describe, expect, it } from 'vitest';

import {
  hasUncertainWorkSyncRuntimeActivity,
  hasWorkSyncActiveRuntime,
  hasWorkSyncReachableRuntime,
  isRuntimeEntryActiveForWorkSync,
  isRuntimeMemberActiveForWorkSync,
  isRuntimeMemberActivityUncertainForWorkSync,
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
    for (const pidSource of ['agent_process_table', 'opencode_bridge'] as const) {
      expect(
        isRuntimeEntryActiveForWorkSync(
          createRuntimeEntry({
            livenessKind: 'confirmed_bootstrap',
            pidSource,
            runtimeLastSeenAt: '2026-05-18T19:44:47.000Z',
          })
        )
      ).toBe(true);
    }
  });

  it('does not treat bootstrap-only confirmation as active runtime evidence', () => {
    for (const pidSource of [
      undefined,
      'runtime_bootstrap',
      'persisted_metadata',
      'tmux_child',
      'tmux_pane',
    ] as const) {
      expect(
        isRuntimeEntryActiveForWorkSync(
          createRuntimeEntry({
            livenessKind: 'confirmed_bootstrap',
            ...(pidSource ? { pidSource } : {}),
          })
        )
      ).toBe(false);
    }
  });

  it('does not count lead runtime entries as work-sync active teammates', () => {
    expect(
      isRuntimeEntryActiveForWorkSync(
        createRuntimeEntry({
          memberName: 'team-lead',
          backendType: 'lead',
          livenessKind: undefined,
          pidSource: 'lead_process',
        })
      )
    ).toBe(false);
  });

  it('does not treat lead process evidence as active for ordinary teammates', () => {
    for (const livenessKind of [undefined, 'runtime_process', 'confirmed_bootstrap'] as const) {
      const snapshot = createRuntimeSnapshot({
        alice: createRuntimeEntry({
          memberName: 'alice',
          backendType: 'process',
          livenessKind,
          pidSource: 'lead_process',
        }),
      });

      expect(isRuntimeEntryActiveForWorkSync(snapshot.members.alice)).toBe(false);
      expect(hasWorkSyncActiveRuntime(snapshot)).toBe(false);
      expect(hasWorkSyncReachableRuntime(snapshot)).toBe(false);
      expect(isRuntimeMemberActiveForWorkSync(snapshot, 'alice')).toBe(false);
    }
  });

  it('keeps active lead processes reachable for targeted lead work-sync', () => {
    const snapshot = createRuntimeSnapshot({
      'team-lead': createRuntimeEntry({
        memberName: 'team-lead',
        backendType: 'lead',
        livenessKind: undefined,
        pidSource: 'lead_process',
      }),
      alice: createRuntimeEntry({
        memberName: 'alice',
        alive: false,
        livenessKind: 'stale_metadata',
      }),
    });

    expect(hasWorkSyncActiveRuntime(snapshot)).toBe(false);
    expect(hasWorkSyncReachableRuntime(snapshot)).toBe(true);
    expect(isRuntimeMemberActiveForWorkSync(snapshot, 'team-lead')).toBe(true);
    expect(isRuntimeMemberActiveForWorkSync(snapshot, 'alice')).toBe(false);
  });

  it('keeps ordinary teammates named lead active from normal agent process evidence', () => {
    const snapshot = createRuntimeSnapshot({
      lead: createRuntimeEntry({
        memberName: 'lead',
        backendType: 'process',
        livenessKind: 'confirmed_bootstrap',
        pidSource: 'agent_process_table',
      }),
    });

    expect(hasWorkSyncActiveRuntime(snapshot)).toBe(true);
    expect(hasWorkSyncReachableRuntime(snapshot)).toBe(true);
    expect(isRuntimeMemberActiveForWorkSync(snapshot, 'lead')).toBe(true);
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
          'team-lead': createRuntimeEntry({
            memberName: 'team-lead',
            backendType: 'lead',
            livenessKind: undefined,
            pidSource: 'lead_process',
          }),
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
          'team-lead': createRuntimeEntry({
            memberName: 'team-lead',
            backendType: 'lead',
            livenessKind: undefined,
            pidSource: 'lead_process',
          }),
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

  it('checks active runtime evidence for a specific teammate', () => {
    const snapshot = createRuntimeSnapshot({
      alice: createRuntimeEntry({ memberName: 'alice', livenessKind: 'runtime_process' }),
      bob: createRuntimeEntry({ memberName: 'bob', alive: false, livenessKind: 'stale_metadata' }),
    });

    expect(isRuntimeMemberActiveForWorkSync(snapshot, 'ALICE')).toBe(true);
    expect(isRuntimeMemberActiveForWorkSync(snapshot, 'bob')).toBe(false);
    expect(isRuntimeMemberActiveForWorkSync(snapshot, 'team-lead')).toBe(false);
  });

  it('treats process table unavailability as uncertain runtime activity', () => {
    const snapshot = createRuntimeSnapshot({
      alice: createRuntimeEntry({
        memberName: 'alice',
        alive: false,
        livenessKind: 'registered_only',
        runtimeDiagnostic: 'runtime pid could not be verified because process table unavailable',
      }),
      bob: createRuntimeEntry({ memberName: 'bob', alive: false, livenessKind: 'stale_metadata' }),
    });

    expect(hasWorkSyncActiveRuntime(snapshot)).toBe(false);
    expect(hasUncertainWorkSyncRuntimeActivity(snapshot)).toBe(true);
    expect(isRuntimeMemberActivityUncertainForWorkSync(snapshot, 'alice')).toBe(true);
    expect(isRuntimeMemberActivityUncertainForWorkSync(snapshot, 'bob')).toBe(false);
  });

  it('recognizes process table is unavailable diagnostics as uncertain runtime activity', () => {
    const snapshot = createRuntimeSnapshot({
      alice: createRuntimeEntry({
        memberName: 'alice',
        alive: false,
        livenessKind: 'confirmed_bootstrap',
        pidSource: 'runtime_bootstrap',
        runtimeDiagnostic: 'runtime pid could not be verified because process table is unavailable',
      }),
    });

    expect(hasWorkSyncActiveRuntime(snapshot)).toBe(false);
    expect(hasUncertainWorkSyncRuntimeActivity(snapshot)).toBe(true);
    expect(isRuntimeMemberActivityUncertainForWorkSync(snapshot, 'alice')).toBe(true);
  });

  it('handles missing snapshots as inactive', () => {
    expect(hasWorkSyncActiveRuntime(null)).toBe(false);
    expect(hasWorkSyncActiveRuntime(undefined)).toBe(false);
  });
});
