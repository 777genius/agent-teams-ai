import {
  applyOpenCodeSecondaryEvidenceOverlay,
  classifyOpenCodeSecondaryEvidenceOverlay,
  collectOpenCodeSecondaryOverlayCandidates,
  finalizeMissingRegisteredMembersAsFailed,
  guardCommittedOpenCodeSecondaryLaneEvidence,
  hasCommittedOpenCodeSecondaryEvidenceOverlayDelta,
  needsOpenCodeSecondaryEvidenceOverlay,
} from '@main/services/team/provisioning/TeamProvisioningLaunchStateReconciliation';
import { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import { describe, expect, it, vi } from 'vitest';

import type {
  OpenCodeCommittedBootstrapSessionRecord,
  OpenCodeRuntimeLaneIndexEntry,
} from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import type {
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberLaunchEvidence,
} from '@main/services/team/runtime/TeamRuntimeAdapter';
import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
} from '@shared/types';

const at = '2026-01-01T00:00:00.000Z';

function makeMember(
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name: 'Builder',
    providerId: 'opencode',
    laneId: 'secondary:opencode:Builder',
    laneKind: 'secondary',
    laneOwnerProviderId: 'opencode',
    launchState: 'runtime_pending_bootstrap',
    agentToolAccepted: true,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    firstSpawnAcceptedAt: at,
    lastEvaluatedAt: at,
    ...overrides,
  };
}

function makeSpawnStatus(
  overrides: Partial<MemberSpawnStatusEntry> = {}
): MemberSpawnStatusEntry {
  return {
    status: 'offline',
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    updatedAt: at,
    ...overrides,
  };
}

function makeSnapshot(member: PersistedTeamLaunchMemberState): PersistedTeamLaunchSnapshot {
  return createPersistedLaunchSnapshot({
    teamName: 'demo',
    expectedMembers: [member.name],
    launchPhase: 'active',
    members: { [member.name]: member },
    updatedAt: at,
  });
}

function makeSession(
  overrides: Partial<OpenCodeCommittedBootstrapSessionRecord> = {}
): OpenCodeCommittedBootstrapSessionRecord {
  return {
    id: 'session-1',
    teamName: 'demo',
    memberName: 'Builder',
    laneId: 'secondary:opencode:Builder',
    runId: 'run-1',
    observedAt: '2026-01-01T00:00:03.000Z',
    source: 'app_managed_bootstrap',
    ...overrides,
  };
}

function makeLaneEntry(
  overrides: Partial<OpenCodeRuntimeLaneIndexEntry> = {}
): OpenCodeRuntimeLaneIndexEntry {
  return {
    laneId: 'secondary:opencode:Builder',
    state: 'active',
    updatedAt: at,
    diagnostics: [],
    ...overrides,
  };
}

function makeEvidence(
  overrides: Partial<TeamRuntimeMemberLaunchEvidence> = {}
): TeamRuntimeMemberLaunchEvidence {
  return {
    memberName: 'Builder',
    providerId: 'opencode',
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    sessionId: 'session-1',
    livenessKind: 'confirmed_bootstrap',
    diagnostics: [],
    ...overrides,
  };
}

function makeLaunchResult(
  member: TeamRuntimeMemberLaunchEvidence = makeEvidence(),
  overrides: Partial<TeamRuntimeLaunchResult> = {}
): TeamRuntimeLaunchResult {
  return {
    runId: 'run-1',
    teamName: 'demo',
    launchPhase: 'active',
    teamLaunchState: 'clean_success',
    members: { [member.memberName]: member },
    warnings: [],
    diagnostics: [],
    ...overrides,
  };
}

describe('TeamProvisioningLaunchStateReconciliation', () => {
  it('finalizes missing registered members through explicit service ports', async () => {
    const run = {
      teamName: 'demo',
      expectedMembers: ['Builder', 'Reviewer', 'Restarting', 'Online'],
      memberSpawnStatuses: new Map<string, MemberSpawnStatusEntry>([
        ['Builder', makeSpawnStatus()],
        ['Reviewer', makeSpawnStatus()],
        ['Restarting', makeSpawnStatus()],
        ['Online', makeSpawnStatus({ launchState: 'confirmed_alive', bootstrapConfirmed: true })],
      ]),
      pendingMemberRestarts: new Map([['Restarting', { requestedAt: at }]]),
    };
    const setMemberSpawnStatus = vi.fn();

    await finalizeMissingRegisteredMembersAsFailed(run, {
      getRegisteredTeamMemberNames: vi.fn().mockResolvedValue(new Set(['Builder'])),
      isMemberLifecycleOperationActive: vi.fn(
        (_teamName: string, memberName: string) => memberName === 'Reviewer'
      ),
      setMemberSpawnStatus,
    });

    expect(setMemberSpawnStatus).not.toHaveBeenCalledWith(
      run,
      'Builder',
      'error',
      expect.any(String)
    );
    expect(setMemberSpawnStatus).not.toHaveBeenCalledWith(
      run,
      'Reviewer',
      'error',
      expect.any(String)
    );
    expect(setMemberSpawnStatus).not.toHaveBeenCalledWith(
      run,
      'Restarting',
      'error',
      expect.any(String)
    );
    expect(setMemberSpawnStatus).not.toHaveBeenCalledWith(
      run,
      'Online',
      'error',
      expect.any(String)
    );

    await finalizeMissingRegisteredMembersAsFailed(
      { ...run, pendingMemberRestarts: new Map() },
      {
        getRegisteredTeamMemberNames: vi.fn().mockResolvedValue(new Set()),
        isMemberLifecycleOperationActive: vi.fn().mockReturnValue(false),
        setMemberSpawnStatus,
      }
    );

    expect(setMemberSpawnStatus).toHaveBeenCalledWith(
      expect.objectContaining({ teamName: 'demo' }),
      'Builder',
      'error',
      'Teammate was not registered in config.json during launch. Persistent spawn failed.'
    );
  });

  it('classifies committed OpenCode secondary evidence with conflict guards', async () => {
    const current = makeMember({ runtimeSessionId: 'session-1' });
    const hasBootstrapCheckinTombstone = vi.fn().mockResolvedValue(false);

    await expect(
      classifyOpenCodeSecondaryEvidenceOverlay(
        {
          teamName: 'demo',
          memberName: 'Builder',
          current,
          previous: null,
          laneEntry: makeLaneEntry(),
          metaMembers: [],
          activeRunId: 'run-1',
          sessions: [makeSession()],
          diagnostics: [],
        },
        { hasBootstrapCheckinTombstone }
      )
    ).resolves.toEqual({ kind: 'confirmed_bootstrap', session: makeSession() });

    await expect(
      classifyOpenCodeSecondaryEvidenceOverlay(
        {
          teamName: 'demo',
          memberName: 'Builder',
          current,
          previous: null,
          laneEntry: makeLaneEntry(),
          metaMembers: [{ name: 'builder', removedAt: at }],
          activeRunId: 'run-1',
          sessions: [makeSession()],
          diagnostics: [],
        },
        { hasBootstrapCheckinTombstone }
      )
    ).resolves.toEqual({
      kind: 'blocked',
      diagnostics: ['opencode_overlay_member_removed'],
    });

    await expect(
      classifyOpenCodeSecondaryEvidenceOverlay(
        {
          teamName: 'demo',
          memberName: 'Builder',
          current: makeMember({ runtimeSessionId: undefined }),
          previous: null,
          laneEntry: makeLaneEntry(),
          metaMembers: [],
          activeRunId: 'run-1',
          sessions: [makeSession({ id: 'session-a' }), makeSession({ id: 'session-b' })],
          diagnostics: [],
        },
        { hasBootstrapCheckinTombstone }
      )
    ).resolves.toEqual({
      kind: 'ambiguous',
      diagnostics: ['opencode_overlay_ambiguous_sessions'],
    });

    hasBootstrapCheckinTombstone.mockResolvedValueOnce(true);
    await expect(
      classifyOpenCodeSecondaryEvidenceOverlay(
        {
          teamName: 'demo',
          memberName: 'Builder',
          current,
          previous: null,
          laneEntry: makeLaneEntry(),
          metaMembers: [],
          activeRunId: 'run-1',
          sessions: [makeSession()],
          diagnostics: [],
        },
        { hasBootstrapCheckinTombstone }
      )
    ).resolves.toEqual({
      kind: 'blocked',
      diagnostics: ['opencode_overlay_run_tombstoned'],
    });

    await expect(
      classifyOpenCodeSecondaryEvidenceOverlay(
        {
          teamName: 'demo',
          memberName: 'Builder',
          current: makeMember({
            runtimeRunId: 'run-current',
            runtimeSessionId: undefined,
          }),
          previous: makeMember({
            launchState: 'confirmed_alive',
            bootstrapConfirmed: true,
            runtimeAlive: true,
            runtimeRunId: 'run-previous',
            runtimeSessionId: 'session-previous',
            livenessKind: 'confirmed_bootstrap',
          }),
          laneEntry: makeLaneEntry(),
          metaMembers: [],
          activeRunId: 'run-previous',
          sessions: [
            makeSession({
              id: 'session-previous',
              runId: 'run-previous',
            }),
          ],
          diagnostics: [],
        },
        { hasBootstrapCheckinTombstone }
      )
    ).resolves.toEqual({
      kind: 'conflict',
      diagnostics: ['opencode_overlay_current_run_mismatch'],
    });
  });

  it('requires previous-session fallback evidence to match the active OpenCode run', async () => {
    const hasBootstrapCheckinTombstone = vi.fn().mockResolvedValue(false);
    const current = makeMember({
      runtimeRunId: undefined,
      runtimeSessionId: undefined,
    });
    const previous = makeMember({
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      runtimeAlive: true,
      runtimeRunId: 'run-previous',
      runtimeSessionId: 'session-previous',
      livenessKind: 'confirmed_bootstrap',
    });

    await expect(
      classifyOpenCodeSecondaryEvidenceOverlay(
        {
          teamName: 'demo',
          memberName: 'Builder',
          current,
          previous,
          laneEntry: makeLaneEntry(),
          metaMembers: [],
          activeRunId: 'run-current',
          sessions: [
            makeSession({
              id: 'session-previous',
              runId: null,
            }),
          ],
          diagnostics: [],
        },
        { hasBootstrapCheckinTombstone }
      )
    ).resolves.toEqual({
      kind: 'conflict',
      diagnostics: ['opencode_overlay_session_run_missing'],
    });

    await expect(
      classifyOpenCodeSecondaryEvidenceOverlay(
        {
          teamName: 'demo',
          memberName: 'Builder',
          current,
          previous,
          laneEntry: makeLaneEntry(),
          metaMembers: [],
          activeRunId: 'run-current',
          sessions: [
            makeSession({
              id: 'session-previous',
              runId: '',
            }),
          ],
          diagnostics: [],
        },
        { hasBootstrapCheckinTombstone }
      )
    ).resolves.toEqual({
      kind: 'conflict',
      diagnostics: ['opencode_overlay_session_run_missing'],
    });

    const currentRunSession = makeSession({
      id: 'session-previous',
      runId: 'run-current',
    });
    await expect(
      classifyOpenCodeSecondaryEvidenceOverlay(
        {
          teamName: 'demo',
          memberName: 'Builder',
          current,
          previous,
          laneEntry: makeLaneEntry(),
          metaMembers: [],
          activeRunId: 'run-current',
          sessions: [currentRunSession],
          diagnostics: [],
        },
        { hasBootstrapCheckinTombstone }
      )
    ).resolves.toEqual({ kind: 'confirmed_bootstrap', session: currentRunSession });
  });

  it('promotes committed bootstrap evidence into the launch snapshot', async () => {
    const snapshot = makeSnapshot(
      makeMember({
        runtimeSessionId: 'session-1',
        diagnostics: ['OpenCode bridge reported member launch failure'],
      })
    );
    const overlaid = await applyOpenCodeSecondaryEvidenceOverlay(
      {
        teamName: 'demo',
        snapshot,
        previousSnapshot: null,
        metaMembers: [],
      },
      {
        readLaneIndex: vi.fn().mockResolvedValue({
          lanes: { 'secondary:opencode:Builder': makeLaneEntry() },
        }),
        readCommittedBootstrapSessionEvidence: vi.fn().mockResolvedValue({
          committed: true,
          activeRunId: 'run-1',
          sessions: [makeSession()],
          diagnostics: [],
        }),
        hasBootstrapCheckinTombstone: vi.fn().mockResolvedValue(false),
        nowIso: () => '2026-01-01T00:00:04.000Z',
      }
    );

    expect(overlaid.members.Builder.launchState).toBe('confirmed_alive');
    expect(overlaid.members.Builder.bootstrapConfirmed).toBe(true);
    expect(overlaid.members.Builder.runtimeAlive).toBe(true);
    expect(overlaid.members.Builder.runtimeDiagnostic).toBe(
      'OpenCode app-managed bootstrap evidence committed.'
    );
    expect(overlaid.members.Builder.diagnostics).toEqual([
      'opencode_bootstrap_evidence_committed',
    ]);
    expect(hasCommittedOpenCodeSecondaryEvidenceOverlayDelta(overlaid, snapshot)).toBe(true);
    expect(collectOpenCodeSecondaryOverlayCandidates(snapshot, null)).toEqual(['Builder']);
    expect(needsOpenCodeSecondaryEvidenceOverlay(snapshot.members.Builder, null)).toBe(true);
  });

  it('does not promote previous-run OpenCode bootstrap evidence over a current pending run', async () => {
    const previousSnapshot = makeSnapshot(
      makeMember({
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        runtimeAlive: true,
        runtimeRunId: 'run-previous',
        runtimeSessionId: 'session-previous',
        livenessKind: 'confirmed_bootstrap',
      })
    );
    const snapshot = makeSnapshot(
      makeMember({
        runtimeRunId: 'run-current',
        runtimeSessionId: undefined,
      })
    );

    const overlaid = await applyOpenCodeSecondaryEvidenceOverlay(
      {
        teamName: 'demo',
        snapshot,
        previousSnapshot,
        metaMembers: [{ name: 'Builder' }],
      },
      {
        readLaneIndex: vi.fn().mockResolvedValue({
          lanes: { 'secondary:opencode:Builder': makeLaneEntry() },
        }),
        readCommittedBootstrapSessionEvidence: vi.fn().mockResolvedValue({
          committed: true,
          activeRunId: 'run-previous',
          sessions: [
            makeSession({
              id: 'session-previous',
              runId: 'run-previous',
            }),
          ],
          diagnostics: [],
        }),
        hasBootstrapCheckinTombstone: vi.fn().mockResolvedValue(false),
        nowIso: () => '2026-01-01T00:00:04.000Z',
      }
    );

    expect(overlaid).toBe(snapshot);
    expect(overlaid.members.Builder).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      runtimeAlive: false,
      runtimeRunId: 'run-current',
    });
    expect(overlaid.members.Builder.runtimeSessionId).toBeUndefined();
  });

  it('does not promote previous-session OpenCode evidence without a run id', async () => {
    const previousSnapshot = makeSnapshot(
      makeMember({
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        runtimeAlive: true,
        runtimeRunId: 'run-previous',
        runtimeSessionId: 'session-previous',
        livenessKind: 'confirmed_bootstrap',
      })
    );
    const snapshot = makeSnapshot(
      makeMember({
        runtimeRunId: undefined,
        runtimeSessionId: undefined,
      })
    );

    const overlaid = await applyOpenCodeSecondaryEvidenceOverlay(
      {
        teamName: 'demo',
        snapshot,
        previousSnapshot,
        metaMembers: [{ name: 'Builder' }],
      },
      {
        readLaneIndex: vi.fn().mockResolvedValue({
          lanes: { 'secondary:opencode:Builder': makeLaneEntry() },
        }),
        readCommittedBootstrapSessionEvidence: vi.fn().mockResolvedValue({
          committed: true,
          activeRunId: 'run-current',
          sessions: [
            makeSession({
              id: 'session-previous',
              runId: null,
            }),
          ],
          diagnostics: [],
        }),
        hasBootstrapCheckinTombstone: vi.fn().mockResolvedValue(false),
        nowIso: () => '2026-01-01T00:00:04.000Z',
      }
    );

    expect(overlaid).toBe(snapshot);
    expect(overlaid.members.Builder).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      runtimeAlive: false,
    });
    expect(overlaid.members.Builder.runtimeRunId).toBeUndefined();
    expect(overlaid.members.Builder.runtimeSessionId).toBeUndefined();
  });

  it('does not resurrect previous-only OpenCode secondary members absent from current metadata', async () => {
    const previousSnapshot = makeSnapshot(makeMember({ runtimeSessionId: 'session-1' }));
    const currentSnapshot = createPersistedLaunchSnapshot({
      teamName: 'demo',
      expectedMembers: ['Reviewer'],
      launchPhase: 'active',
      members: {
        Reviewer: {
          name: 'Reviewer',
          providerId: 'anthropic',
          laneKind: 'primary',
          laneOwnerProviderId: 'anthropic',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          lastEvaluatedAt: at,
        },
      },
      updatedAt: at,
    });
    const readCommittedBootstrapSessionEvidence = vi.fn().mockResolvedValue({
      committed: true,
      activeRunId: 'run-1',
      sessions: [makeSession()],
      diagnostics: [],
    });

    const overlaid = await applyOpenCodeSecondaryEvidenceOverlay(
      {
        teamName: 'demo',
        snapshot: currentSnapshot,
        previousSnapshot,
        metaMembers: [{ name: 'Reviewer' }],
      },
      {
        readLaneIndex: vi.fn().mockResolvedValue({
          lanes: { 'secondary:opencode:Builder': makeLaneEntry() },
        }),
        readCommittedBootstrapSessionEvidence,
        hasBootstrapCheckinTombstone: vi.fn().mockResolvedValue(false),
        nowIso: () => '2026-01-01T00:00:04.000Z',
      }
    );

    expect(overlaid.members.Builder).toBeUndefined();
    expect(overlaid.expectedMembers).toEqual(['Reviewer']);
    expect(readCommittedBootstrapSessionEvidence).not.toHaveBeenCalled();
  });

  it('downgrades claimed OpenCode bootstrap when durable lane evidence is missing', async () => {
    const committed = makeLaunchResult(makeEvidence({ diagnostics: ['committed diagnostic'] }), {
      diagnostics: ['result diagnostic'],
    });
    const upsertOpenCodeRuntimeLaneIndexEntry = vi.fn().mockResolvedValue(undefined);
    const guarded = await guardCommittedOpenCodeSecondaryLaneEvidence(
      {
        teamName: 'demo',
        laneId: 'secondary:opencode:Builder',
        memberName: 'Builder',
        result: makeLaunchResult(),
      },
      {
        commitOpenCodeRuntimeAdapterLaunchSessionEvidence: vi.fn().mockResolvedValue(committed),
        inspectOpenCodeRuntimeLaneStorage: vi.fn().mockResolvedValue({
          hasRuntimeEvidenceOnDisk: false,
          manifestEntryCount: 0,
          manifestUpdatedAt: null,
          fileNames: [],
        }),
        upsertOpenCodeRuntimeLaneIndexEntry,
        logWarn: vi.fn(),
      }
    );

    expect(guarded.members.Builder.launchState).toBe('runtime_pending_bootstrap');
    expect(guarded.members.Builder.bootstrapConfirmed).toBe(false);
    expect(guarded.members.Builder.runtimeAlive).toBe(false);
    expect(guarded.teamLaunchState).toBe('partial_pending');
    expect(guarded.diagnostics).toContain(
      'OpenCode bridge reported bootstrap confirmation, but no lane runtime evidence was committed.'
    );
    expect(upsertOpenCodeRuntimeLaneIndexEntry).toHaveBeenCalledWith({
      teamName: 'demo',
      laneId: 'secondary:opencode:Builder',
      state: 'active',
      diagnostics: expect.arrayContaining([
        'OpenCode bridge reported bootstrap confirmation, but no lane runtime evidence was committed.',
      ]),
    });
  });
});
