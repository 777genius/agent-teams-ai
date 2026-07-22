import {
  buildOpenCodeSecondaryBootstrapStallDiagnostic,
  type BuildOpenCodeSecondaryBootstrapStallDiagnosticPorts,
  type MarkOpenCodeSecondaryBootstrapStalledPorts,
  maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt,
  type OpenCodeBootstrapStallRetryPromptPorts,
  type OpenCodeBootstrapStallRunLike,
  type OpenCodeBootstrapStallStatusPorts,
  type ReconcileOpenCodeRuntimeProcessBootstrapPorts,
  setOpenCodeRuntimePendingBootstrapStatus,
  setOpenCodeSecondaryBootstrapStalledStatus,
} from './TeamProvisioningOpenCodeBootstrapStall';

import type { MemberSpawnStatusEntry, TeamAgentRuntimeDiagnosticSeverity } from '@shared/types';

export type TeamProvisioningOpenCodeBootstrapStallReconciliationPorts =
  ReconcileOpenCodeRuntimeProcessBootstrapPorts & MarkOpenCodeSecondaryBootstrapStalledPorts;

export interface TeamProvisioningOpenCodeBootstrapStallStatusPortDependencies<
  TRun extends OpenCodeBootstrapStallRunLike,
> {
  nowIso(): string;
  syncMemberTaskActivityForRuntimeTransition(
    run: TRun,
    memberName: string,
    previous: MemberSpawnStatusEntry,
    next: MemberSpawnStatusEntry,
    observedAt: string
  ): void;
  updateLaunchDiagnostics(run: TRun, observedAt: string): void;
  appendMemberBootstrapDiagnostic(run: TRun, memberName: string, text: string): void;
  isCurrentTrackedRun(run: TRun): boolean;
  emitMemberSpawnChange(run: TRun, memberName: string): void;
  persistLaunchStateSnapshot(run: TRun, phase: 'active' | 'finished'): void | Promise<void>;
}

export interface TeamProvisioningOpenCodeBootstrapStallReconciliationPortDependencies<
  TRun extends OpenCodeBootstrapStallRunLike,
> {
  getOpenCodeBootstrapStallStatusPorts(): OpenCodeBootstrapStallStatusPorts;
  findBootstrapTranscriptOutcome: BuildOpenCodeSecondaryBootstrapStallDiagnosticPorts['findBootstrapTranscriptOutcome'];
  getOpenCodeRuntimeMessageAdapter: OpenCodeBootstrapStallRetryPromptPorts['getOpenCodeRuntimeMessageAdapter'];
  sendOpenCodeMemberMessageToRuntimeSerialized: OpenCodeBootstrapStallRetryPromptPorts['sendOpenCodeMemberMessageToRuntimeSerialized'];
  appendMemberBootstrapDiagnostic(run: TRun, memberName: string, text: string): void;
  isCurrentTrackedRun(run: TRun): boolean;
  scheduleOpenCodeBootstrapStallReevaluation(
    run: TRun,
    memberName: string,
    firstSpawnAcceptedAt: string
  ): void;
}

export function createTeamProvisioningOpenCodeBootstrapStallStatusPorts<
  TRun extends OpenCodeBootstrapStallRunLike,
>(
  dependencies: TeamProvisioningOpenCodeBootstrapStallStatusPortDependencies<TRun>
): OpenCodeBootstrapStallStatusPorts {
  return {
    nowIso: dependencies.nowIso,
    syncMemberTaskActivityForRuntimeTransition: (targetRun, targetMember, previous, next, at) =>
      dependencies.syncMemberTaskActivityForRuntimeTransition(
        targetRun as TRun,
        targetMember,
        previous,
        next,
        at
      ),
    updateLaunchDiagnostics: (targetRun, observedAt) =>
      dependencies.updateLaunchDiagnostics(targetRun as TRun, observedAt),
    appendMemberBootstrapDiagnostic: (targetRun, targetMember, text) =>
      dependencies.appendMemberBootstrapDiagnostic(targetRun as TRun, targetMember, text),
    isCurrentTrackedRun: (targetRun) => dependencies.isCurrentTrackedRun(targetRun as TRun),
    emitMemberSpawnChange: (targetRun, targetMember) =>
      dependencies.emitMemberSpawnChange(targetRun as TRun, targetMember),
    persistLaunchStateSnapshot: (targetRun, phase) => {
      void dependencies.persistLaunchStateSnapshot(targetRun as TRun, phase);
    },
  };
}

export function createTeamProvisioningOpenCodeBootstrapStallReconciliationPorts<
  TRun extends OpenCodeBootstrapStallRunLike,
>(
  dependencies: TeamProvisioningOpenCodeBootstrapStallReconciliationPortDependencies<TRun>
): TeamProvisioningOpenCodeBootstrapStallReconciliationPorts {
  return {
    buildOpenCodeSecondaryBootstrapStallDiagnostic: (targetRun, targetMember, targetCurrent) =>
      buildOpenCodeSecondaryBootstrapStallDiagnostic(
        { run: targetRun, memberName: targetMember, current: targetCurrent },
        {
          findBootstrapTranscriptOutcome: dependencies.findBootstrapTranscriptOutcome,
        }
      ),
    setOpenCodeRuntimePendingBootstrapStatus: (
      targetRun,
      targetMember,
      current,
      options: {
        bootstrapStalled: boolean;
        runtimeDiagnostic: string;
        runtimeDiagnosticSeverity: TeamAgentRuntimeDiagnosticSeverity;
      }
    ) =>
      setOpenCodeRuntimePendingBootstrapStatus(
        targetRun,
        targetMember,
        current,
        options,
        dependencies.getOpenCodeBootstrapStallStatusPorts()
      ),
    setOpenCodeSecondaryBootstrapStalledStatus: (
      targetRun,
      targetMember,
      targetCurrent,
      runtimeDiagnostic
    ) =>
      setOpenCodeSecondaryBootstrapStalledStatus(
        targetRun,
        targetMember,
        targetCurrent,
        runtimeDiagnostic,
        dependencies.getOpenCodeBootstrapStallStatusPorts()
      ),
    maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt: (retryInput) =>
      maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt(retryInput, {
        getOpenCodeRuntimeMessageAdapter: dependencies.getOpenCodeRuntimeMessageAdapter,
        sendOpenCodeMemberMessageToRuntimeSerialized:
          dependencies.sendOpenCodeMemberMessageToRuntimeSerialized,
        appendMemberBootstrapDiagnostic: (targetRun, targetMember, text) =>
          dependencies.appendMemberBootstrapDiagnostic(targetRun as TRun, targetMember, text),
        isCurrentTrackedRun: (targetRun) => dependencies.isCurrentTrackedRun(targetRun as TRun),
      }),
    scheduleOpenCodeBootstrapStallReevaluation: (targetRun, targetMember, firstSpawnAcceptedAt) =>
      dependencies.scheduleOpenCodeBootstrapStallReevaluation(
        targetRun as TRun,
        targetMember,
        firstSpawnAcceptedAt
      ),
  };
}
