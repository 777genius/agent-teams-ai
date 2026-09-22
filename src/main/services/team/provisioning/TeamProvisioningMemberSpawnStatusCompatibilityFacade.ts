import { TeamProvisioningMemberLifecycleCompatibilityFacade } from './TeamProvisioningMemberLifecycleCompatibilityFacade';
import {
  refreshMemberSpawnStatusesFromLeadInbox as refreshMemberSpawnStatusesFromLeadInboxHelper,
  resolveExpectedLaunchMemberName as resolveExpectedLaunchMemberNameHelper,
} from './TeamProvisioningMemberSpawnLeadInbox';
import {
  confirmMemberSpawnStatusFromTranscriptForRun,
  maybeAuditMemberSpawnStatusesForRun,
  type MemberSpawnStatusAuditPorts,
  type MemberSpawnStatusMutationPorts,
  reconcileBootstrapTranscriptFailuresForRun,
  reconcileBootstrapTranscriptSuccessesForRun,
  setMemberSpawnStatusForRun,
} from './TeamProvisioningMemberSpawnSnapshots';
import { type ProvisioningRun } from './TeamProvisioningRunModel';

import type { InboxMessage, MemberSpawnLivenessSource, MemberSpawnStatus } from '@shared/types';

export abstract class TeamProvisioningMemberSpawnStatusCompatibilityFacade<
  TRun extends ProvisioningRun = ProvisioningRun,
> extends TeamProvisioningMemberLifecycleCompatibilityFacade<TRun> {
  protected abstract readonly inboxReader: {
    getMessagesFor(teamName: string, memberName: string): Promise<InboxMessage[]>;
  };
  protected abstract readonly memberSpawnStatusMutationPorts: MemberSpawnStatusMutationPorts<TRun>;
  protected abstract readonly memberSpawnStatusAuditPorts: MemberSpawnStatusAuditPorts<TRun>;

  protected abstract getRunLeadName(run: TRun): string;

  protected async refreshMemberSpawnStatusesFromLeadInbox(run: TRun): Promise<void> {
    await refreshMemberSpawnStatusesFromLeadInboxHelper(run, {
      getRunLeadName: (targetRun) => this.getRunLeadName(targetRun),
      readLeadInboxMessages: (teamName, leadName) =>
        this.inboxReader.getMessagesFor(teamName, leadName),
      setMemberSpawnStatus: (targetRun, memberName, status, error, source, heartbeatTimestamp) =>
        this.setMemberSpawnStatus(targetRun, memberName, status, error, source, heartbeatTimestamp),
    });
  }

  protected resolveExpectedLaunchMemberName(
    expectedMembers: readonly string[] | undefined,
    candidateName: string
  ): string | null {
    return resolveExpectedLaunchMemberNameHelper(expectedMembers, candidateName);
  }

  protected setMemberSpawnStatus(
    run: TRun,
    memberName: string,
    status: MemberSpawnStatus,
    error?: string,
    livenessSource?: MemberSpawnLivenessSource,
    heartbeatAt?: string
  ): void {
    setMemberSpawnStatusForRun(
      {
        run,
        memberName,
        status,
        error,
        livenessSource,
        heartbeatAt,
      },
      this.memberSpawnStatusMutationPorts
    );
  }

  protected confirmMemberSpawnStatusFromTranscript(
    run: TRun,
    memberName: string,
    observedAt: string,
    source: 'transcript' | 'runtime-proof' = 'transcript'
  ): void {
    confirmMemberSpawnStatusFromTranscriptForRun(
      {
        run,
        memberName,
        observedAt,
        source,
      },
      this.memberSpawnStatusMutationPorts
    );
  }

  protected async reconcileBootstrapTranscriptFailures(run: TRun): Promise<void> {
    await reconcileBootstrapTranscriptFailuresForRun(run, this.memberSpawnStatusAuditPorts);
  }

  protected async reconcileBootstrapTranscriptSuccesses(run: TRun): Promise<void> {
    await reconcileBootstrapTranscriptSuccessesForRun(run, this.memberSpawnStatusAuditPorts);
  }

  protected async maybeAuditMemberSpawnStatuses(
    run: TRun,
    options?: { force?: boolean }
  ): Promise<void> {
    await maybeAuditMemberSpawnStatusesForRun(run, this.memberSpawnStatusAuditPorts, options);
  }
}
