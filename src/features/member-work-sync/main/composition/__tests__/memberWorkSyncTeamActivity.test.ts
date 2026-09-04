import { describe, expect, it } from 'vitest';

import {
  buildWorkSyncHardFailedMembers,
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
    for (const pidSource of [
      'agent_process_table',
      'opencode_bridge',
      'runtime_bootstrap',
    ] as const) {
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
    for (const pidSource of [undefined, 'persisted_metadata', 'tmux_child', 'tmux_pane'] as const) {
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
      'not_found',
    ] as const) {
      expect(isRuntimeEntryActiveForWorkSync(createRuntimeEntry({ livenessKind }))).toBe(false);
    }
  });

  it('keeps alive between-turn on-demand lanes active despite degraded liveness kinds', () => {
    for (const livenessKind of ['registered_only', 'stale_metadata'] as const) {
      expect(isRuntimeEntryActiveForWorkSync(createRuntimeEntry({ livenessKind }))).toBe(true);
      // Negative control: the alive check still runs first, so a dead entry
      // with the same degraded kind stays inactive.
      expect(
        isRuntimeEntryActiveForWorkSync(createRuntimeEntry({ alive: false, livenessKind }))
      ).toBe(false);
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

  it('does not treat a hard-failed member as active even when the runtime resolver reports alive', () => {
    // A member whose launch grace timed out has no pid ever recorded, so the
    // runtime liveness resolver cannot disprove it and reports alive: true -
    // correct for the "alive between turns" on-demand-lane case, but a hard
    // failure means it is not coming back on its own. Without the hard-failure
    // check this stays "active" forever and can be handed assignment nudges.
    const entry = createRuntimeEntry();
    const hardFailedMembers = buildWorkSyncHardFailedMembers({ alice: { hardFailure: true } });

    expect(isRuntimeEntryActiveForWorkSync(entry)).toBe(true);
    expect(isRuntimeEntryActiveForWorkSync(entry, hardFailedMembers)).toBe(false);

    const snapshot = createRuntimeSnapshot({ alice: entry });
    expect(hasWorkSyncReachableRuntime(snapshot, hardFailedMembers)).toBe(false);
    expect(isRuntimeMemberActiveForWorkSync(snapshot, 'alice', hardFailedMembers)).toBe(false);
  });

  it('leaves other members active when only one hard-failed', () => {
    const snapshot = createRuntimeSnapshot({
      alice: createRuntimeEntry({ memberName: 'alice' }),
      bob: createRuntimeEntry({ memberName: 'bob' }),
    });
    const hardFailedMembers = buildWorkSyncHardFailedMembers({ alice: { hardFailure: true } });

    expect(hasWorkSyncReachableRuntime(snapshot, hardFailedMembers)).toBe(true);
    expect(isRuntimeMemberActiveForWorkSync(snapshot, 'alice', hardFailedMembers)).toBe(false);
    expect(isRuntimeMemberActiveForWorkSync(snapshot, 'bob', hardFailedMembers)).toBe(true);
  });

  it('buildWorkSyncHardFailedMembers only includes members whose hardFailure is true', () => {
    const hardFailedMembers = buildWorkSyncHardFailedMembers({
      alice: { hardFailure: true },
      bob: { hardFailure: false },
      carol: {},
    });

    expect(hardFailedMembers.has('alice')).toBe(true);
    expect(hardFailedMembers.has('bob')).toBe(false);
    expect(hardFailedMembers.has('carol')).toBe(false);
    expect(buildWorkSyncHardFailedMembers(null).size).toBe(0);
  });
});
