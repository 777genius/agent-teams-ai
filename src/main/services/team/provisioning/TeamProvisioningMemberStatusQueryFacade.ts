import { boundLaunchDiagnostics } from '../progressPayload';
import { type TeamMembersMetaStore } from '../TeamMembersMetaStore';

import {
  createTeamProvisioningOpenCodeBootstrapStallReconciliationPorts,
  createTeamProvisioningOpenCodeBootstrapStallStatusPorts,
  type TeamProvisioningOpenCodeBootstrapStallReconciliationPorts,
} from './TeamProvisioningBootstrapStallPortsFactory';
import { type BootstrapTranscriptOutcome } from './TeamProvisioningBootstrapTranscript';
import { buildLaunchDiagnosticsFromRun } from './TeamProvisioningLaunchDiagnostics';
import { getMemberSpawnStatusesSnapshot } from './TeamProvisioningMemberSpawnSnapshots';
import { MEMBER_LAUNCH_GRACE_MS } from './TeamProvisioningMemberSpawnStatusPolicy';
import {
  createTeamProvisioningMemberSpawnStatusesSnapshotHostFromService,
  createTeamProvisioningMemberSpawnStatusesSnapshotPortsBoundary,
  type TeamProvisioningMemberSpawnStatusesSnapshotServiceHost,
} from './TeamProvisioningMemberSpawnStatusSnapshotPortsFactory';
import {
  isOpenCodeBootstrapStallWindowElapsed as isOpenCodeBootstrapStallWindowElapsedHelper,
  type OpenCodeBootstrapStallRetryPromptPorts,
  type OpenCodeBootstrapStallStatusPorts,
  scheduleOpenCodeBootstrapStallReevaluation as scheduleOpenCodeBootstrapStallReevaluationHelper,
} from './TeamProvisioningOpenCodeBootstrapStall';
import { type TeamProvisioningReevaluateMemberLaunchStatusBoundary } from './TeamProvisioningReevaluateMemberLaunchStatusPortsFactory';
import { type ProvisioningRun } from './TeamProvisioningRunModel';
import { nowIso } from './TeamProvisioningRunProgress';
import {
  isOpenCodeRuntimeRecipient as isOpenCodeRuntimeRecipientHelper,
  resolveRuntimeRecipientProviderId as resolveRuntimeRecipientProviderIdHelper,
} from './TeamProvisioningRuntimeRecipientResolution';
import { type TeamProvisioningRuntimeSnapshotFacade } from './TeamProvisioningRuntimeSnapshotFacade';
import { type TeamProvisioningRunTrackingDeliveryHelper } from './TeamProvisioningRunTrackingDelivery';
import { TeamProvisioningTaskActivityCompatibilityFacade } from './TeamProvisioningTaskActivityCompatibilityFacade';

import type {
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  TeamAgentRuntimeSnapshot,
  TeamProviderId,
} from '@shared/types';

export abstract class TeamProvisioningMemberStatusQueryFacade<
  TRun extends ProvisioningRun = ProvisioningRun,
> extends TeamProvisioningTaskActivityCompatibilityFacade<TRun> {
  protected abstract readonly runTracking: Pick<
    TeamProvisioningRunTrackingDeliveryHelper<TRun>,
    'getTrackedRunId'
  >;
  protected abstract readonly runs: ReadonlyMap<string, TRun>;
  protected abstract readonly membersMetaStore: Pick<TeamMembersMetaStore, 'getMembers'>;
  protected abstract readonly runtimeSnapshotFacade: Pick<
    TeamProvisioningRuntimeSnapshotFacade,
    'getTeamAgentRuntimeSnapshot'
  >;
  protected abstract readonly reevaluateMemberLaunchStatusBoundary: TeamProvisioningReevaluateMemberLaunchStatusBoundary<TRun>;
  protected abstract readonly pendingTimeouts: Map<string, NodeJS.Timeout>;

  protected abstract findBootstrapTranscriptOutcome(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<BootstrapTranscriptOutcome | null>;
  protected abstract sendOpenCodeMemberMessageToRuntimeSerialized(
    input: Parameters<
      OpenCodeBootstrapStallRetryPromptPorts['sendOpenCodeMemberMessageToRuntimeSerialized']
    >[0]
  ): ReturnType<
    OpenCodeBootstrapStallRetryPromptPorts['sendOpenCodeMemberMessageToRuntimeSerialized']
  >;
  protected abstract emitMemberSpawnChange(run: TRun, memberName: string): void;
  protected abstract persistLaunchStateSnapshot(
    run: TRun,
    phase: 'active' | 'finished'
  ): Promise<unknown>;

  async resolveRuntimeRecipientProviderId(
    teamName: string,
    memberName: string
  ): Promise<TeamProviderId | undefined> {
    return resolveRuntimeRecipientProviderIdHelper(
      { teamName, memberName },
      {
        readConfigSnapshot: (candidateTeamName) => this.readConfigSnapshot(candidateTeamName),
        readMembersMeta: (candidateTeamName) => this.membersMetaStore.getMembers(candidateTeamName),
      }
    );
  }

  async isOpenCodeRuntimeRecipient(teamName: string, memberName: string): Promise<boolean> {
    return isOpenCodeRuntimeRecipientHelper(
      { teamName, memberName },
      {
        readConfigSnapshot: (candidateTeamName) => this.readConfigSnapshot(candidateTeamName),
        readMembersMeta: (candidateTeamName) => this.membersMetaStore.getMembers(candidateTeamName),
      }
    );
  }

  protected isCurrentTrackedRun(run: TRun): boolean {
    return this.runTracking.getTrackedRunId(run.teamName) === run.runId;
  }

  protected startRuntimeToolActivity(
    run: TRun,
    memberName: string,
    block: Record<string, unknown>
  ): void {
    this.runtimeToolActivity.startRuntimeToolActivity(run, memberName, block);
  }

  protected finishRuntimeToolActivity(
    run: TRun,
    toolUseId: string,
    resultContent: unknown,
    isError: boolean
  ): void {
    this.runtimeToolActivity.finishRuntimeToolActivity(run, toolUseId, resultContent, isError);
  }

  protected appendMemberBootstrapDiagnostic(run: TRun, memberName: string, text: string): void {
    this.runtimeToolActivity.appendMemberBootstrapDiagnostic(run, memberName, text);
  }

  protected updateLaunchDiagnosticsForRun(run: TRun, observedAt: string): void {
    const launchDiagnostics = boundLaunchDiagnostics(
      buildLaunchDiagnosticsFromRun(run, { nowIso: () => observedAt })
    );
    if (!launchDiagnostics) {
      return;
    }
    run.progress = {
      ...run.progress,
      updatedAt: observedAt,
      launchDiagnostics,
    };
    run.onProgress(run.progress);
  }

  protected resetRuntimeToolActivity(run: TRun, memberName?: string): void {
    this.runtimeToolActivity.resetRuntimeToolActivity(run, memberName);
  }

  protected clearMemberSpawnToolTracking(run: TRun, memberName: string): void {
    this.runtimeToolActivity.clearMemberSpawnToolTracking(run, memberName);
  }

  protected pauseMemberTaskActivityForRuntimeLoss(
    run: TRun,
    memberName: string,
    previous: MemberSpawnStatusEntry,
    observedAt: string
  ): void {
    this.runtimeToolActivity.pauseMemberTaskActivityForRuntimeLoss(
      run,
      memberName,
      previous,
      observedAt
    );
  }

  protected syncMemberTaskActivityForRuntimeTransition(
    run: TRun,
    memberName: string,
    previous: MemberSpawnStatusEntry,
    next: MemberSpawnStatusEntry,
    observedAt: string
  ): void {
    this.runtimeToolActivity.syncMemberTaskActivityForRuntimeTransition(
      run,
      memberName,
      previous,
      next,
      observedAt
    );
  }

  protected createMemberSpawnStatusesSnapshotPorts() {
    return createTeamProvisioningMemberSpawnStatusesSnapshotPortsBoundary<TRun>(
      createTeamProvisioningMemberSpawnStatusesSnapshotHostFromService(
        this as unknown as TeamProvisioningMemberSpawnStatusesSnapshotServiceHost<TRun>
      )
    );
  }

  async getMemberSpawnStatuses(teamName: string): Promise<MemberSpawnStatusesSnapshot> {
    return getMemberSpawnStatusesSnapshot(teamName, this.createMemberSpawnStatusesSnapshotPorts());
  }

  async getTeamAgentRuntimeSnapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot> {
    return this.runtimeSnapshotFacade.getTeamAgentRuntimeSnapshot(teamName);
  }

  protected getMemberLaunchGraceKey(run: TRun, memberName: string): string {
    return `member-launch-grace:${run.runId}:${memberName}`;
  }

  protected syncMemberLaunchGraceCheck(
    run: TRun,
    memberName: string,
    entry: MemberSpawnStatusEntry
  ): void {
    const key = this.getMemberLaunchGraceKey(run, memberName);
    const existing = this.pendingTimeouts.get(key);
    if (entry.launchState === 'failed_to_start' || entry.launchState === 'confirmed_alive') {
      if (existing) {
        clearTimeout(existing);
        this.pendingTimeouts.delete(key);
      }
      return;
    }
    if (!entry.firstSpawnAcceptedAt) {
      if (existing) {
        clearTimeout(existing);
        this.pendingTimeouts.delete(key);
      }
      return;
    }
    const remainingMs =
      Date.parse(entry.firstSpawnAcceptedAt) + MEMBER_LAUNCH_GRACE_MS - Date.now();
    if (remainingMs <= 0) {
      if (existing) {
        clearTimeout(existing);
        this.pendingTimeouts.delete(key);
      }
      void this.reevaluateMemberLaunchStatus(run, memberName);
      return;
    }
    if (existing) {
      return;
    }
    const timer = setTimeout(() => {
      this.pendingTimeouts.delete(key);
      void this.reevaluateMemberLaunchStatus(run, memberName);
    }, remainingMs);
    timer.unref?.();
    this.pendingTimeouts.set(key, timer);
  }

  protected async reevaluateMemberLaunchStatus(run: TRun, memberName: string): Promise<void> {
    await this.reevaluateMemberLaunchStatusBoundary.reevaluateMemberLaunchStatus(run, memberName);
  }

  protected getOpenCodeBootstrapStallStatusPorts(): OpenCodeBootstrapStallStatusPorts {
    return createTeamProvisioningOpenCodeBootstrapStallStatusPorts<TRun>({
      nowIso,
      syncMemberTaskActivityForRuntimeTransition: (targetRun, targetMember, previous, next, at) =>
        this.syncMemberTaskActivityForRuntimeTransition(
          targetRun,
          targetMember,
          previous,
          next,
          at
        ),
      updateLaunchDiagnostics: (targetRun, observedAt) =>
        this.updateLaunchDiagnosticsForRun(targetRun, observedAt),
      appendMemberBootstrapDiagnostic: (targetRun, targetMember, text) =>
        this.appendMemberBootstrapDiagnostic(targetRun, targetMember, text),
      isCurrentTrackedRun: (targetRun) => this.isCurrentTrackedRun(targetRun),
      emitMemberSpawnChange: (targetRun, targetMember) =>
        this.emitMemberSpawnChange(targetRun, targetMember),
      persistLaunchStateSnapshot: (targetRun, phase) => {
        void this.persistLaunchStateSnapshot(targetRun, phase);
      },
    });
  }

  protected getOpenCodeBootstrapStallReconciliationPorts(): TeamProvisioningOpenCodeBootstrapStallReconciliationPorts {
    return createTeamProvisioningOpenCodeBootstrapStallReconciliationPorts<TRun>({
      getOpenCodeBootstrapStallStatusPorts: () => this.getOpenCodeBootstrapStallStatusPorts(),
      findBootstrapTranscriptOutcome: (teamName, memberName, acceptedAtMs) =>
        this.findBootstrapTranscriptOutcome(teamName, memberName, acceptedAtMs),
      getOpenCodeRuntimeMessageAdapter: () =>
        this.appShellBoundary.getOpenCodeRuntimeMessageAdapter(),
      sendOpenCodeMemberMessageToRuntimeSerialized: (sendInput) =>
        this.sendOpenCodeMemberMessageToRuntimeSerialized(sendInput),
      appendMemberBootstrapDiagnostic: (targetRun, targetMember, text) =>
        this.appendMemberBootstrapDiagnostic(targetRun, targetMember, text),
      isCurrentTrackedRun: (targetRun) => this.isCurrentTrackedRun(targetRun),
      scheduleOpenCodeBootstrapStallReevaluation: (targetRun, targetMember, firstSpawnAcceptedAt) =>
        this.scheduleOpenCodeBootstrapStallReevaluation(
          targetRun,
          targetMember,
          firstSpawnAcceptedAt
        ),
    });
  }

  protected scheduleOpenCodeBootstrapStallReevaluation(
    run: TRun,
    memberName: string,
    firstSpawnAcceptedAt: string
  ): void {
    scheduleOpenCodeBootstrapStallReevaluationHelper(run, memberName, firstSpawnAcceptedAt, {
      nowMs: () => Date.now(),
      getMemberLaunchGraceKey: (targetRun, targetMember) =>
        this.getMemberLaunchGraceKey(targetRun as TRun, targetMember),
      hasPendingTimeout: (key) => this.pendingTimeouts.has(key),
      setPendingTimeout: (key, timer) => this.pendingTimeouts.set(key, timer),
      deletePendingTimeout: (key) => this.pendingTimeouts.delete(key),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      reevaluateMemberLaunchStatus: (targetRun, targetMember) =>
        this.reevaluateMemberLaunchStatus(targetRun as TRun, targetMember),
    });
  }

  protected isOpenCodeBootstrapStallWindowElapsed(
    firstSpawnAcceptedAt: string | undefined
  ): boolean {
    return isOpenCodeBootstrapStallWindowElapsedHelper(firstSpawnAcceptedAt, Date.now());
  }
}
