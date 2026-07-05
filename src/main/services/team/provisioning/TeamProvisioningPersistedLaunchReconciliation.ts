import {
  createPersistedLaunchSnapshot,
  snapshotToMemberSpawnStatuses,
} from '../TeamLaunchStateEvaluator';

import {
  type LaunchReconcileConfigMembers,
  reconcilePersistedLaunchMember,
  type ReconcilePersistedLaunchMemberPorts,
} from './TeamProvisioningLaunchReconcileReporting';
import {
  getPersistedLaunchMemberNames,
  hasMixedLaunchMetadata,
} from './TeamProvisioningLaunchStateProjection';
import { hasCommittedOpenCodeSecondaryEvidenceOverlayDelta } from './TeamProvisioningLaunchStateReconciliation';
import { filterRemovedMembersFromLaunchSnapshot } from './TeamProvisioningMemberStatusProjection';
import { promoteOpenCodePersistedFailureReasonsFromDiagnostics } from './TeamProvisioningOpenCodeDiagnosticsPolicy';

import type { LeadInboxLaunchReconcileMessage } from './TeamProvisioningBootstrapTranscript';
import type { LiveTeamAgentRuntimeMetadata } from './TeamProvisioningRuntimeMetadataPolicy';
import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchSnapshot,
  TeamMember,
} from '@shared/types';

export interface PersistedLaunchReconciliationResult {
  snapshot: PersistedTeamLaunchSnapshot | null;
  statuses: Record<string, MemberSpawnStatusEntry>;
}

export type PersistedLaunchSnapshotWriteReason =
  | 'committed_evidence_overlay'
  | 'bootstrap_stall_overlay'
  | 'failure_reason_promotion'
  | 'confirmed_bootstrap_diagnostic_cleanup';

export interface PersistedLaunchSnapshotWriteDecision {
  shouldWrite: boolean;
  reasons: PersistedLaunchSnapshotWriteReason[];
}

export type PreferredBootstrapSnapshotDecision =
  | { kind: 'ignore' }
  | { kind: 'return_snapshot' }
  | { kind: 'clear_persisted_state' }
  | { kind: 'write_snapshot' };

export type FinalReconciledSnapshotDecision =
  | { kind: 'clear_persisted_state' }
  | { kind: 'write_snapshot' };

export interface ReconcilePersistedLaunchStatePorts {
  readBootstrapLaunchSnapshot(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  readMembersMeta(teamName: string): Promise<readonly TeamMember[]>;
  recoverStaleMixedSecondaryLaunchSnapshot(
    teamName: string,
    bootstrapSnapshot: PersistedTeamLaunchSnapshot | null,
    persistedSnapshot: PersistedTeamLaunchSnapshot | null
  ): Promise<PersistedTeamLaunchSnapshot | null>;
  applyOpenCodeSecondaryEvidenceOverlay(input: {
    teamName: string;
    snapshot: PersistedTeamLaunchSnapshot;
    previousSnapshot?: PersistedTeamLaunchSnapshot | null;
    metaMembers?: readonly TeamMember[];
  }): Promise<PersistedTeamLaunchSnapshot>;
  applyOpenCodeSecondaryBootstrapStallOverlay(
    snapshot: PersistedTeamLaunchSnapshot | null
  ): PersistedTeamLaunchSnapshot | null;
  writeLaunchStateSnapshot(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot
  ): Promise<PersistedTeamLaunchSnapshot>;
  clearPersistedLaunchState(teamName: string): Promise<void>;
  applyBootstrapTranscriptEvidenceOverlay(
    snapshot: PersistedTeamLaunchSnapshot | null
  ): Promise<PersistedTeamLaunchSnapshot | null>;
  needsBootstrapAcceptanceReconcile(
    snapshot: PersistedTeamLaunchSnapshot,
    bootstrapSnapshot: PersistedTeamLaunchSnapshot | null
  ): boolean;
  needsConfirmedBootstrapDiagnosticReconcile(snapshot: PersistedTeamLaunchSnapshot): boolean;
  cleanConfirmedBootstrapRuntimeDiagnostics(
    snapshot: PersistedTeamLaunchSnapshot | null
  ): PersistedTeamLaunchSnapshot | null;
  hasBootstrapTranscriptLaunchReconcileOutcome(
    snapshot: PersistedTeamLaunchSnapshot
  ): Promise<boolean>;
  choosePreferredLaunchSnapshot(
    bootstrapSnapshot: PersistedTeamLaunchSnapshot | null,
    persistedSnapshot: PersistedTeamLaunchSnapshot | null
  ): PersistedTeamLaunchSnapshot | null;
  createDefaultLaunchReconcileConfigMembers(): LaunchReconcileConfigMembers;
  parseLaunchReconcileConfigMembers(raw: string): LaunchReconcileConfigMembers;
  getTeamsBasePath(): string;
  pathJoin(...parts: string[]): string;
  readRegularFileUtf8(
    filePath: string,
    opts: { timeoutMs: number; maxBytes: number }
  ): Promise<string | null>;
  teamJsonReadTimeoutMs: number;
  teamConfigMaxBytes: number;
  readLeadInboxMessagesForLaunchReconcile(
    teamName: string,
    leadName: string
  ): Promise<LeadInboxLaunchReconcileMessage[]>;
  hasLeadInboxLaunchReconcileHeartbeat(
    snapshot: PersistedTeamLaunchSnapshot,
    messages: readonly LeadInboxLaunchReconcileMessage[]
  ): boolean;
  getLiveTeamAgentRuntimeMetadata(
    teamName: string
  ): Promise<ReadonlyMap<string, LiveTeamAgentRuntimeMetadata>>;
  getPersistedLaunchMemberNames(snapshot: PersistedTeamLaunchSnapshot): string[];
  selectLatestLeadInboxLaunchReconcileMessage: ReconcilePersistedLaunchMemberPorts['selectLatestLeadInboxLaunchReconcileMessage'];
  findBootstrapRuntimeProofObservedAt: ReconcilePersistedLaunchMemberPorts['findBootstrapRuntimeProofObservedAt'];
  findBootstrapTranscriptOutcome: ReconcilePersistedLaunchMemberPorts['findBootstrapTranscriptOutcome'];
  readProcessBootstrapTransportSummary: ReconcilePersistedLaunchMemberPorts['readProcessBootstrapTransportSummary'];
  applyProcessBootstrapTransportOverlay: ReconcilePersistedLaunchMemberPorts['applyProcessBootstrapTransportOverlay'];
  nowIso(): string;
  nowMs(): number;
}

export async function reconcilePersistedLaunchStateWithPorts(
  teamName: string,
  ports: ReconcilePersistedLaunchStatePorts
): Promise<PersistedLaunchReconciliationResult> {
  const bootstrapSnapshot = await ports.readBootstrapLaunchSnapshot(teamName);
  const persisted = await ports.readLaunchState(teamName);
  const metaMembers = await ports.readMembersMeta(teamName).catch(() => []);
  const recoveredMixedSnapshot = await ports.recoverStaleMixedSecondaryLaunchSnapshot(
    teamName,
    bootstrapSnapshot,
    persisted
  );
  const filteredRecoveredMixedSnapshot = filterOptionalRemovedMembersFromLaunchSnapshot(
    recoveredMixedSnapshot,
    metaMembers
  );
  const overlaidRecoveredMixedSnapshot = filteredRecoveredMixedSnapshot
    ? await ports.applyOpenCodeSecondaryEvidenceOverlay({
        teamName,
        snapshot: filteredRecoveredMixedSnapshot,
        previousSnapshot: persisted,
        metaMembers,
      })
    : null;
  const recoveredMixedSnapshotWithBootstrapStall =
    ports.applyOpenCodeSecondaryBootstrapStallOverlay(overlaidRecoveredMixedSnapshot);
  const recoveredCommittedEvidenceWriteDecision = getCommittedEvidenceOverlayWriteDecision({
    snapshot: recoveredMixedSnapshotWithBootstrapStall,
    previousSnapshot: persisted,
    snapshotBeforeBootstrapStallOverlay: overlaidRecoveredMixedSnapshot,
  });
  const stableRecoveredMixedSnapshotWithCommittedEvidence =
    recoveredMixedSnapshotWithBootstrapStall &&
    recoveredCommittedEvidenceWriteDecision.shouldWrite
      ? await ports.writeLaunchStateSnapshot(teamName, recoveredMixedSnapshotWithBootstrapStall)
      : recoveredMixedSnapshotWithBootstrapStall;
  const promotedRecoveredMixedSnapshot = promoteOpenCodePersistedFailureReasonsFromDiagnostics(
    stableRecoveredMixedSnapshotWithCommittedEvidence
  );
  const cleanedRecoveredMixedSnapshot =
    ports.cleanConfirmedBootstrapRuntimeDiagnostics(promotedRecoveredMixedSnapshot);
  const recoveredPromotionCleanupWriteDecision = getPromotionCleanupWriteDecision({
    baseSnapshot: stableRecoveredMixedSnapshotWithCommittedEvidence,
    promotedSnapshot: promotedRecoveredMixedSnapshot,
    cleanedSnapshot: cleanedRecoveredMixedSnapshot,
  });
  const stableRecoveredMixedSnapshot =
    cleanedRecoveredMixedSnapshot && recoveredPromotionCleanupWriteDecision.shouldWrite
      ? await ports.writeLaunchStateSnapshot(teamName, cleanedRecoveredMixedSnapshot)
      : cleanedRecoveredMixedSnapshot;
  const filteredBootstrapSnapshot = filterOptionalRemovedMembersFromLaunchSnapshot(
    bootstrapSnapshot,
    metaMembers
  );
  const overlaidBootstrapSnapshot =
    await ports.applyBootstrapTranscriptEvidenceOverlay(filteredBootstrapSnapshot);
  if (
    await shouldReturnSnapshotBeforeRuntimeReconcileFromPorts({
      snapshot: stableRecoveredMixedSnapshot,
      bootstrapSnapshot: overlaidBootstrapSnapshot,
      needsBootstrapAcceptanceReconcile: (snapshot, bootstrapSnapshot) =>
        ports.needsBootstrapAcceptanceReconcile(snapshot, bootstrapSnapshot),
      needsConfirmedBootstrapDiagnosticReconcile: (snapshot) =>
        ports.needsConfirmedBootstrapDiagnosticReconcile(snapshot),
      hasBootstrapTranscriptLaunchReconcileOutcome: (snapshot) =>
        ports.hasBootstrapTranscriptLaunchReconcileOutcome(snapshot),
    })
  ) {
    return projectPersistedLaunchReconciliationResult(stableRecoveredMixedSnapshot);
  }
  const filteredPersistedBase =
    stableRecoveredMixedSnapshot ??
    filterOptionalRemovedMembersFromLaunchSnapshot(persisted, metaMembers);
  const filteredPersisted = filteredPersistedBase
    ? await ports.applyOpenCodeSecondaryEvidenceOverlay({
        teamName,
        snapshot: filteredPersistedBase,
        previousSnapshot: persisted,
        metaMembers,
      })
    : null;
  const filteredPersistedWithBootstrapStall =
    ports.applyOpenCodeSecondaryBootstrapStallOverlay(filteredPersisted);
  const committedEvidenceWriteDecision = getCommittedEvidenceOverlayWriteDecision({
    snapshot: filteredPersistedWithBootstrapStall,
    previousSnapshot: persisted,
    snapshotBeforeBootstrapStallOverlay: filteredPersisted,
  });
  const promotedPersisted = promoteOpenCodePersistedFailureReasonsFromDiagnostics(
    filteredPersistedWithBootstrapStall
  );
  const cleanedPersisted = ports.cleanConfirmedBootstrapRuntimeDiagnostics(promotedPersisted);
  const promotionCleanupWriteDecision = getPromotionCleanupWriteDecision({
    baseSnapshot: filteredPersistedWithBootstrapStall,
    promotedSnapshot: promotedPersisted,
    cleanedSnapshot: cleanedPersisted,
  });
  const persistedWriteDecision = combinePersistedLaunchSnapshotWriteDecisions(
    committedEvidenceWriteDecision,
    promotionCleanupWriteDecision
  );
  const persistedWithCommittedEvidence =
    cleanedPersisted && persistedWriteDecision.shouldWrite
      ? await ports.writeLaunchStateSnapshot(teamName, cleanedPersisted)
      : cleanedPersisted;
  const preferredSnapshot = ports.choosePreferredLaunchSnapshot(
    overlaidBootstrapSnapshot,
    persistedWithCommittedEvidence
  );
  const preferredBootstrapDecision = decidePreferredBootstrapSnapshot({
    preferredSnapshot,
    bootstrapSnapshot: overlaidBootstrapSnapshot,
    persistedSnapshot: persistedWithCommittedEvidence,
  });
  if (preferredSnapshot && preferredBootstrapDecision.kind !== 'ignore') {
    if (preferredBootstrapDecision.kind === 'clear_persisted_state') {
      await ports.clearPersistedLaunchState(teamName);
      return projectPersistedLaunchReconciliationResult(preferredSnapshot);
    }
    if (preferredBootstrapDecision.kind === 'write_snapshot') {
      const writtenSnapshot = await ports.writeLaunchStateSnapshot(teamName, preferredSnapshot);
      return projectPersistedLaunchReconciliationResult(writtenSnapshot);
    }
    return projectPersistedLaunchReconciliationResult(preferredSnapshot);
  }
  if (!persistedWithCommittedEvidence) {
    return projectEmptyPersistedLaunchReconciliationResult();
  }

  const configPath = ports.pathJoin(ports.getTeamsBasePath(), teamName, 'config.json');
  let launchReconcileConfigMembers = ports.createDefaultLaunchReconcileConfigMembers();
  try {
    const raw = await ports.readRegularFileUtf8(configPath, {
      timeoutMs: ports.teamJsonReadTimeoutMs,
      maxBytes: ports.teamConfigMaxBytes,
    });
    if (raw) {
      launchReconcileConfigMembers = ports.parseLaunchReconcileConfigMembers(raw);
    }
  } catch {
    // best-effort
  }

  const leadInboxMessages = await ports.readLeadInboxMessagesForLaunchReconcile(
    teamName,
    launchReconcileConfigMembers.leadName
  );

  if (
    await shouldReturnSnapshotBeforeRuntimeReconcileFromPorts({
      snapshot: persistedWithCommittedEvidence,
      bootstrapSnapshot: overlaidBootstrapSnapshot,
      requireMixedLaunchMetadata: true,
      hasLeadInboxLaunchReconcileHeartbeat: ports.hasLeadInboxLaunchReconcileHeartbeat(
        persistedWithCommittedEvidence,
        leadInboxMessages
      ),
      needsBootstrapAcceptanceReconcile: (snapshot, bootstrapSnapshot) =>
        ports.needsBootstrapAcceptanceReconcile(snapshot, bootstrapSnapshot),
      needsConfirmedBootstrapDiagnosticReconcile: (snapshot) =>
        ports.needsConfirmedBootstrapDiagnosticReconcile(snapshot),
      hasBootstrapTranscriptLaunchReconcileOutcome: (snapshot) =>
        ports.hasBootstrapTranscriptLaunchReconcileOutcome(snapshot),
    })
  ) {
    return projectPersistedLaunchReconciliationResult(persistedWithCommittedEvidence);
  }

  const liveRuntimeByMember = await ports.getLiveTeamAgentRuntimeMetadata(teamName);
  const nextMembers = { ...persistedWithCommittedEvidence.members };
  const persistedMemberNames = ports.getPersistedLaunchMemberNames(persistedWithCommittedEvidence);
  const now = ports.nowIso();
  for (const expected of persistedMemberNames) {
    nextMembers[expected] = await reconcilePersistedLaunchMember({
      teamName,
      expected,
      current: nextMembers[expected],
      bootstrapMember: bootstrapSnapshot?.members[expected],
      persistedMemberNames,
      configMembers: launchReconcileConfigMembers.configMembers,
      configBootstrapRunIds: launchReconcileConfigMembers.configBootstrapRunIds,
      leadInboxMessages,
      liveRuntimeByMember,
      launchPhase: persistedWithCommittedEvidence.launchPhase,
      now,
      ports: {
        selectLatestLeadInboxLaunchReconcileMessage:
          ports.selectLatestLeadInboxLaunchReconcileMessage,
        findBootstrapRuntimeProofObservedAt: ports.findBootstrapRuntimeProofObservedAt,
        findBootstrapTranscriptOutcome: ports.findBootstrapTranscriptOutcome,
        readProcessBootstrapTransportSummary: ports.readProcessBootstrapTransportSummary,
        applyProcessBootstrapTransportOverlay: ports.applyProcessBootstrapTransportOverlay,
        nowMs: ports.nowMs,
      },
    });
  }

  const reconciled = createPersistedLaunchSnapshot({
    teamName,
    expectedMembers: persistedMemberNames,
    leadSessionId: persistedWithCommittedEvidence.leadSessionId,
    launchPhase: persistedWithCommittedEvidence.launchPhase,
    members: nextMembers,
    updatedAt: now,
  });

  const finalSnapshotDecision = decideFinalReconciledSnapshotWrite(reconciled);
  if (finalSnapshotDecision.kind === 'clear_persisted_state') {
    await ports.clearPersistedLaunchState(teamName);
    return projectEmptyPersistedLaunchReconciliationResult();
  }

  const writtenSnapshot = await ports.writeLaunchStateSnapshot(teamName, reconciled);
  return projectPersistedLaunchReconciliationResult(writtenSnapshot);
}

export function filterOptionalRemovedMembersFromLaunchSnapshot(
  snapshot: PersistedTeamLaunchSnapshot | null,
  metaMembers: readonly TeamMember[]
): PersistedTeamLaunchSnapshot | null {
  if (!snapshot) {
    return null;
  }
  return filterRemovedMembersFromLaunchSnapshot(
    snapshot,
    metaMembers,
    getPersistedLaunchMemberNames(snapshot)
  );
}

export function projectPersistedLaunchReconciliationResult(
  snapshot: PersistedTeamLaunchSnapshot | null
): PersistedLaunchReconciliationResult {
  return {
    snapshot,
    statuses: snapshotToMemberSpawnStatuses(snapshot),
  };
}

export function projectEmptyPersistedLaunchReconciliationResult(): PersistedLaunchReconciliationResult {
  return { snapshot: null, statuses: {} };
}

export function getCommittedEvidenceOverlayWriteDecision(input: {
  snapshot: PersistedTeamLaunchSnapshot | null;
  previousSnapshot: PersistedTeamLaunchSnapshot | null;
  snapshotBeforeBootstrapStallOverlay: PersistedTeamLaunchSnapshot | null;
}): PersistedLaunchSnapshotWriteDecision {
  const reasons: PersistedLaunchSnapshotWriteReason[] = [];
  if (!input.snapshot) {
    return { shouldWrite: false, reasons };
  }
  if (hasCommittedOpenCodeSecondaryEvidenceOverlayDelta(input.snapshot, input.previousSnapshot)) {
    reasons.push('committed_evidence_overlay');
  }
  if (input.snapshot !== input.snapshotBeforeBootstrapStallOverlay) {
    reasons.push('bootstrap_stall_overlay');
  }
  return { shouldWrite: reasons.length > 0, reasons };
}

export function getPromotionCleanupWriteDecision(input: {
  baseSnapshot: PersistedTeamLaunchSnapshot | null;
  promotedSnapshot: PersistedTeamLaunchSnapshot | null;
  cleanedSnapshot: PersistedTeamLaunchSnapshot | null;
}): PersistedLaunchSnapshotWriteDecision {
  const reasons: PersistedLaunchSnapshotWriteReason[] = [];
  if (!input.cleanedSnapshot) {
    return { shouldWrite: false, reasons };
  }
  if (input.promotedSnapshot !== input.baseSnapshot) {
    reasons.push('failure_reason_promotion');
  }
  if (input.cleanedSnapshot !== input.promotedSnapshot) {
    reasons.push('confirmed_bootstrap_diagnostic_cleanup');
  }
  return { shouldWrite: reasons.length > 0, reasons };
}

export function combinePersistedLaunchSnapshotWriteDecisions(
  ...decisions: readonly PersistedLaunchSnapshotWriteDecision[]
): PersistedLaunchSnapshotWriteDecision {
  const reasons = Array.from(new Set(decisions.flatMap((decision) => decision.reasons)));
  return { shouldWrite: reasons.length > 0, reasons };
}

export function shouldReturnSnapshotBeforeRuntimeReconcile(input: {
  snapshot: PersistedTeamLaunchSnapshot | null;
  requireMixedLaunchMetadata?: boolean;
  hasLeadInboxLaunchReconcileHeartbeat?: boolean;
  needsBootstrapAcceptanceReconcile: boolean;
  needsConfirmedBootstrapDiagnosticReconcile: boolean;
  hasBootstrapTranscriptLaunchReconcileOutcome: boolean;
}): boolean {
  if (!input.snapshot) {
    return false;
  }
  if (input.requireMixedLaunchMetadata === true && !hasMixedLaunchMetadata(input.snapshot)) {
    return false;
  }
  return (
    input.hasLeadInboxLaunchReconcileHeartbeat !== true &&
    !input.needsBootstrapAcceptanceReconcile &&
    !input.needsConfirmedBootstrapDiagnosticReconcile &&
    !input.hasBootstrapTranscriptLaunchReconcileOutcome
  );
}

export async function shouldReturnSnapshotBeforeRuntimeReconcileFromPorts(input: {
  snapshot: PersistedTeamLaunchSnapshot | null;
  bootstrapSnapshot: PersistedTeamLaunchSnapshot | null;
  requireMixedLaunchMetadata?: boolean;
  hasLeadInboxLaunchReconcileHeartbeat?: boolean;
  needsBootstrapAcceptanceReconcile(
    snapshot: PersistedTeamLaunchSnapshot,
    bootstrapSnapshot: PersistedTeamLaunchSnapshot | null
  ): boolean;
  needsConfirmedBootstrapDiagnosticReconcile(snapshot: PersistedTeamLaunchSnapshot): boolean;
  hasBootstrapTranscriptLaunchReconcileOutcome(
    snapshot: PersistedTeamLaunchSnapshot
  ): Promise<boolean>;
}): Promise<boolean> {
  if (!input.snapshot) {
    return false;
  }
  return shouldReturnSnapshotBeforeRuntimeReconcile({
    snapshot: input.snapshot,
    requireMixedLaunchMetadata: input.requireMixedLaunchMetadata,
    hasLeadInboxLaunchReconcileHeartbeat: input.hasLeadInboxLaunchReconcileHeartbeat,
    needsBootstrapAcceptanceReconcile: input.needsBootstrapAcceptanceReconcile(
      input.snapshot,
      input.bootstrapSnapshot
    ),
    needsConfirmedBootstrapDiagnosticReconcile: input.needsConfirmedBootstrapDiagnosticReconcile(
      input.snapshot
    ),
    hasBootstrapTranscriptLaunchReconcileOutcome:
      await input.hasBootstrapTranscriptLaunchReconcileOutcome(input.snapshot),
  });
}

export function decidePreferredBootstrapSnapshot(input: {
  preferredSnapshot: PersistedTeamLaunchSnapshot | null;
  bootstrapSnapshot: PersistedTeamLaunchSnapshot | null;
  persistedSnapshot: PersistedTeamLaunchSnapshot | null;
}): PreferredBootstrapSnapshotDecision {
  const bootstrapSelectionWouldCollapseMixedLaunch = Boolean(
    input.preferredSnapshot &&
    input.preferredSnapshot === input.bootstrapSnapshot &&
    input.preferredSnapshot.teamLaunchState === 'clean_success' &&
    !hasMixedLaunchMetadata(input.preferredSnapshot) &&
    hasMixedLaunchMetadata(input.persistedSnapshot)
  );
  if (
    !input.preferredSnapshot ||
    input.preferredSnapshot !== input.bootstrapSnapshot ||
    bootstrapSelectionWouldCollapseMixedLaunch
  ) {
    return { kind: 'ignore' };
  }
  if (!input.persistedSnapshot) {
    return { kind: 'return_snapshot' };
  }
  if (
    input.preferredSnapshot.teamLaunchState === 'clean_success' &&
    !hasMixedLaunchMetadata(input.preferredSnapshot)
  ) {
    return { kind: 'clear_persisted_state' };
  }
  return { kind: 'write_snapshot' };
}

export function decideFinalReconciledSnapshotWrite(
  snapshot: PersistedTeamLaunchSnapshot
): FinalReconciledSnapshotDecision {
  if (snapshot.teamLaunchState === 'clean_success' && !hasMixedLaunchMetadata(snapshot)) {
    return { kind: 'clear_persisted_state' };
  }
  return { kind: 'write_snapshot' };
}
