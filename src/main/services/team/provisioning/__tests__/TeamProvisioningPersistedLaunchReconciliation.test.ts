import { describe, expect, it, vi } from 'vitest';

import { createPersistedLaunchSnapshot } from '../../TeamLaunchStateEvaluator';
import {
  decideFinalReconciledSnapshotWrite,
  decidePreferredBootstrapSnapshot,
  filterOptionalRemovedMembersFromLaunchSnapshot,
  getCommittedEvidenceOverlayWriteDecision,
  getPromotionCleanupWriteDecision,
  projectEmptyPersistedLaunchReconciliationResult,
  projectPersistedLaunchReconciliationResult,
  type ReconcilePersistedLaunchStatePorts,
  reconcilePersistedLaunchStateWithPorts,
  shouldReturnSnapshotBeforeRuntimeReconcile,
} from '../TeamProvisioningPersistedLaunchReconciliation';

import type {
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TeamMember,
} from '@shared/types';

const at = '2026-01-01T00:00:00.000Z';

function member(
  name: string,
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name,
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    lastEvaluatedAt: at,
    ...overrides,
  };
}

function snapshot(input: {
  members: Record<string, PersistedTeamLaunchMemberState>;
  expectedMembers?: readonly string[];
  launchPhase?: PersistedTeamLaunchSnapshot['launchPhase'];
}): PersistedTeamLaunchSnapshot {
  return createPersistedLaunchSnapshot({
    teamName: 'demo',
    expectedMembers: input.expectedMembers ?? Object.keys(input.members),
    launchPhase: input.launchPhase ?? 'active',
    members: input.members,
    updatedAt: at,
  });
}

function mixedSnapshot(): PersistedTeamLaunchSnapshot {
  return snapshot({
    members: {
      Builder: member('Builder', {
        providerId: 'opencode',
        laneKind: 'secondary',
        laneOwnerProviderId: 'opencode',
        laneId: 'secondary:opencode:Builder',
      }),
    },
  });
}

function createReconcilePorts(
  overrides: Partial<ReconcilePersistedLaunchStatePorts> = {}
): ReconcilePersistedLaunchStatePorts {
  return {
    readBootstrapLaunchSnapshot: vi.fn(async () => null),
    readLaunchState: vi.fn(async () => null),
    readMembersMeta: vi.fn(async () => []),
    recoverStaleMixedSecondaryLaunchSnapshot: vi.fn(async () => null),
    applyOpenCodeSecondaryEvidenceOverlay: vi.fn(async ({ snapshot }) => snapshot),
    applyOpenCodeSecondaryBootstrapStallOverlay: vi.fn((launchSnapshot) => launchSnapshot),
    writeLaunchStateSnapshot: vi.fn(async (_teamName, launchSnapshot) => launchSnapshot),
    clearPersistedLaunchState: vi.fn(async () => undefined),
    applyBootstrapTranscriptEvidenceOverlay: vi.fn(async (launchSnapshot) => launchSnapshot),
    needsBootstrapAcceptanceReconcile: vi.fn(() => false),
    needsConfirmedBootstrapDiagnosticReconcile: vi.fn(() => false),
    cleanConfirmedBootstrapRuntimeDiagnostics: vi.fn((launchSnapshot) => launchSnapshot),
    hasBootstrapTranscriptLaunchReconcileOutcome: vi.fn(async () => false),
    choosePreferredLaunchSnapshot: vi.fn((bootstrapSnapshot, persistedSnapshot) =>
      bootstrapSnapshot ?? persistedSnapshot
    ),
    createDefaultLaunchReconcileConfigMembers: vi.fn(() => ({
      configMembers: new Set<string>(),
      configBootstrapRunIds: new Map<string, string>(),
      leadName: 'team-lead',
    })),
    parseLaunchReconcileConfigMembers: vi.fn(() => ({
      configMembers: new Set<string>(),
      configBootstrapRunIds: new Map<string, string>(),
      leadName: 'team-lead',
    })),
    getTeamsBasePath: vi.fn(() => '/teams'),
    pathJoin: vi.fn((...parts) => parts.join('/')),
    readRegularFileUtf8: vi.fn(async () => null),
    teamJsonReadTimeoutMs: 5_000,
    teamConfigMaxBytes: 10 * 1024 * 1024,
    readLeadInboxMessagesForLaunchReconcile: vi.fn(async () => []),
    hasLeadInboxLaunchReconcileHeartbeat: vi.fn(() => false),
    getLiveTeamAgentRuntimeMetadata: vi.fn(async () => new Map()),
    getPersistedLaunchMemberNames: vi.fn((launchSnapshot) => [
      ...launchSnapshot.expectedMembers,
      ...Object.keys(launchSnapshot.members).filter(
        (name) => !launchSnapshot.expectedMembers.includes(name)
      ),
    ]),
    selectLatestLeadInboxLaunchReconcileMessage: vi.fn(() => null),
    findBootstrapRuntimeProofObservedAt: vi.fn(async () => null),
    findBootstrapTranscriptOutcome: vi.fn(async () => null),
    readProcessBootstrapTransportSummary: vi.fn(async () => null),
    applyProcessBootstrapTransportOverlay: vi.fn(({ member }) => member),
    nowIso: vi.fn(() => at),
    nowMs: vi.fn(() => Date.parse(at)),
    ...overrides,
  };
}

describe('persisted launch reconciliation helpers', () => {
  it('filters removed snapshot members before projecting reconcile statuses', () => {
    const launchSnapshot = snapshot({
      expectedMembers: ['Builder', 'Removed'],
      members: {
        Builder: member('Builder', {
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
        }),
        Removed: member('Removed'),
      },
    });
    const metaMembers: TeamMember[] = [
      { name: 'Builder', joinedAt: 1 },
      { name: 'Removed', joinedAt: 1, removedAt: 2 },
    ];

    const filtered = filterOptionalRemovedMembersFromLaunchSnapshot(launchSnapshot, metaMembers);
    const result = projectPersistedLaunchReconciliationResult(filtered);

    expect(filtered?.expectedMembers).toEqual(['Builder']);
    expect(Object.keys(filtered?.members ?? {})).toEqual(['Builder']);
    expect(result.statuses.Builder).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
    });
    expect(result.statuses.Removed).toBeUndefined();
    expect(projectEmptyPersistedLaunchReconciliationResult()).toEqual({
      snapshot: null,
      statuses: {},
    });
  });

  it('reports committed evidence, bootstrap stall, promotion, and cleanup write reasons', () => {
    const previous = snapshot({
      members: {
        Builder: member('Builder', {
          launchState: 'runtime_pending_bootstrap',
          bootstrapConfirmed: false,
        }),
      },
    });
    const overlaid = snapshot({
      members: {
        Builder: member('Builder', {
          launchState: 'confirmed_alive',
          bootstrapConfirmed: true,
          diagnostics: ['opencode_bootstrap_evidence_committed'],
        }),
      },
    });
    const stalled = { ...overlaid, updatedAt: '2026-01-01T00:00:01.000Z' };

    expect(
      getCommittedEvidenceOverlayWriteDecision({
        snapshot: stalled,
        previousSnapshot: previous,
        snapshotBeforeBootstrapStallOverlay: overlaid,
      })
    ).toEqual({
      shouldWrite: true,
      reasons: ['committed_evidence_overlay', 'bootstrap_stall_overlay'],
    });

    expect(
      getPromotionCleanupWriteDecision({
        baseSnapshot: previous,
        promotedSnapshot: overlaid,
        cleanedSnapshot: stalled,
      })
    ).toEqual({
      shouldWrite: true,
      reasons: ['failure_reason_promotion', 'confirmed_bootstrap_diagnostic_cleanup'],
    });
  });

  it('keeps runtime reconcile required when bootstrap transcript inputs need reconciliation', () => {
    const launchSnapshot = mixedSnapshot();

    expect(
      shouldReturnSnapshotBeforeRuntimeReconcile({
        snapshot: launchSnapshot,
        requireMixedLaunchMetadata: true,
        needsBootstrapAcceptanceReconcile: false,
        needsConfirmedBootstrapDiagnosticReconcile: false,
        hasBootstrapTranscriptLaunchReconcileOutcome: false,
      })
    ).toBe(true);
    expect(
      shouldReturnSnapshotBeforeRuntimeReconcile({
        snapshot: launchSnapshot,
        requireMixedLaunchMetadata: true,
        hasLeadInboxLaunchReconcileHeartbeat: true,
        needsBootstrapAcceptanceReconcile: false,
        needsConfirmedBootstrapDiagnosticReconcile: false,
        hasBootstrapTranscriptLaunchReconcileOutcome: false,
      })
    ).toBe(false);
    expect(
      shouldReturnSnapshotBeforeRuntimeReconcile({
        snapshot: snapshot({ members: { Builder: member('Builder') } }),
        requireMixedLaunchMetadata: true,
        needsBootstrapAcceptanceReconcile: false,
        needsConfirmedBootstrapDiagnosticReconcile: false,
        hasBootstrapTranscriptLaunchReconcileOutcome: false,
      })
    ).toBe(false);
  });

  it('decides preferred bootstrap and final reconciled snapshot persistence actions', () => {
    const cleanBootstrap = snapshot({
      members: {
        Builder: member('Builder', {
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
        }),
      },
      launchPhase: 'finished',
    });
    const persisted = mixedSnapshot();
    const nonMixedPersisted = snapshot({ members: { Builder: member('Builder') } });

    expect(
      decidePreferredBootstrapSnapshot({
        preferredSnapshot: cleanBootstrap,
        bootstrapSnapshot: cleanBootstrap,
        persistedSnapshot: null,
      })
    ).toEqual({ kind: 'return_snapshot' });
    expect(
      decidePreferredBootstrapSnapshot({
        preferredSnapshot: cleanBootstrap,
        bootstrapSnapshot: cleanBootstrap,
        persistedSnapshot: nonMixedPersisted,
      })
    ).toEqual({ kind: 'clear_persisted_state' });
    expect(
      decidePreferredBootstrapSnapshot({
        preferredSnapshot: cleanBootstrap,
        bootstrapSnapshot: cleanBootstrap,
        persistedSnapshot: persisted,
      })
    ).toEqual({ kind: 'ignore' });

    expect(decideFinalReconciledSnapshotWrite(cleanBootstrap)).toEqual({
      kind: 'clear_persisted_state',
    });
    expect(decideFinalReconciledSnapshotWrite(persisted)).toEqual({ kind: 'write_snapshot' });
  });

  it('writes recovered mixed committed evidence overlay before returning early', async () => {
    const recovered = mixedSnapshot();
    const committed = snapshot({
      members: {
        Builder: member('Builder', {
          providerId: 'opencode',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          laneId: 'secondary:opencode:Builder',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          livenessKind: 'confirmed_bootstrap',
          diagnostics: ['opencode_bootstrap_evidence_committed'],
        }),
      },
    });
    const ports = createReconcilePorts({
      recoverStaleMixedSecondaryLaunchSnapshot: vi.fn(async () => recovered),
      applyOpenCodeSecondaryEvidenceOverlay: vi.fn(async () => committed),
    });

    const result = await reconcilePersistedLaunchStateWithPorts('demo', ports);

    expect(ports.writeLaunchStateSnapshot).toHaveBeenCalledTimes(1);
    expect(ports.writeLaunchStateSnapshot).toHaveBeenCalledWith('demo', committed);
    expect(ports.readRegularFileUtf8).not.toHaveBeenCalled();
    expect(ports.getLiveTeamAgentRuntimeMetadata).not.toHaveBeenCalled();
    expect(result.snapshot).toBe(committed);
    expect(result.statuses.Builder).toMatchObject({
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
    });
  });

  it('clears persisted state for final clean non-mixed reconciled snapshot', async () => {
    const cleanPersisted = snapshot({
      members: {
        Builder: member('Builder', {
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          livenessKind: 'confirmed_bootstrap',
        }),
      },
      launchPhase: 'finished',
    });
    const ports = createReconcilePorts({
      readLaunchState: vi.fn(async () => cleanPersisted),
      getLiveTeamAgentRuntimeMetadata: vi.fn(
        async () =>
          new Map([['Builder', { alive: true, livenessKind: 'confirmed_bootstrap' as const }]])
      ),
    });

    const result = await reconcilePersistedLaunchStateWithPorts('demo', ports);

    expect(ports.clearPersistedLaunchState).toHaveBeenCalledTimes(1);
    expect(ports.clearPersistedLaunchState).toHaveBeenCalledWith('demo');
    expect(ports.writeLaunchStateSnapshot).not.toHaveBeenCalled();
    expect(result).toEqual({ snapshot: null, statuses: {} });
  });
});
