import {
  type TeamProvisioningBootstrapEvidenceFacade,
  type TeamProvisioningProcessBootstrapTransportOverlayInput,
} from './TeamProvisioningBootstrapEvidenceFacade';
import {
  type BootstrapTranscriptOutcome,
  type ParsedBootstrapTranscriptTailCacheEntry,
} from './TeamProvisioningBootstrapTranscript';
import { type TeamProvisioningBootstrapTranscriptMemberLogsPort } from './TeamProvisioningBootstrapTranscriptFacade';
import { TeamProvisioningLaunchRuntimeStatusCompatibilityFacade } from './TeamProvisioningLaunchRuntimeStatusCompatibilityFacade';
import { type ProvisioningRun } from './TeamProvisioningRunModel';

import type { PersistedTeamLaunchMemberState, PersistedTeamLaunchSnapshot } from '@shared/types';

export abstract class TeamProvisioningBootstrapEvidenceCompatibilityFacade<
  TRun extends ProvisioningRun = ProvisioningRun,
> extends TeamProvisioningLaunchRuntimeStatusCompatibilityFacade<TRun> {
  protected abstract readonly bootstrapEvidenceFacade: TeamProvisioningBootstrapEvidenceFacade;

  private get parsedBootstrapTranscriptTailCache(): Map<
    string,
    ParsedBootstrapTranscriptTailCacheEntry
  > {
    return this.bootstrapEvidenceFacade.parsedBootstrapTranscriptTailCache;
  }

  private get memberLogsFinder(): TeamProvisioningBootstrapTranscriptMemberLogsPort {
    return this.bootstrapEvidenceFacade.memberLogsFinder;
  }

  private set memberLogsFinder(value: TeamProvisioningBootstrapTranscriptMemberLogsPort) {
    this.bootstrapEvidenceFacade.memberLogsFinder = value;
  }

  private async findBootstrapRuntimeProofObservedAt(
    teamName: string,
    memberName: string,
    member: Pick<
      PersistedTeamLaunchMemberState,
      'firstSpawnAcceptedAt' | 'launchState' | 'hardFailureReason'
    >
  ): Promise<string | null> {
    return this.bootstrapEvidenceFacade.findBootstrapRuntimeProofObservedAt(
      teamName,
      memberName,
      member
    );
  }

  private async findBootstrapTranscriptFailureReason(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<string | null> {
    return this.bootstrapEvidenceFacade.findBootstrapTranscriptFailureReason(
      teamName,
      memberName,
      sinceMs
    );
  }

  protected async findBootstrapTranscriptOutcome(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<BootstrapTranscriptOutcome | null> {
    return this.bootstrapEvidenceFacade.findBootstrapTranscriptOutcome(
      teamName,
      memberName,
      sinceMs
    );
  }

  private async readRecentBootstrapTranscriptOutcome(
    filePath: string,
    sinceMs: number | null,
    memberName: string,
    teamName: string,
    options: {
      allowAnonymousFailure?: boolean;
      contextMemberNames?: readonly string[];
    } = {}
  ): Promise<BootstrapTranscriptOutcome | null> {
    return this.bootstrapEvidenceFacade.readRecentBootstrapTranscriptOutcome(
      filePath,
      sinceMs,
      memberName,
      teamName,
      options
    );
  }

  private async readBootstrapTranscriptOutcomesInProjectRoot(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<BootstrapTranscriptOutcome[]> {
    return this.bootstrapEvidenceFacade.readBootstrapTranscriptOutcomesInProjectRoot(
      teamName,
      memberName,
      sinceMs
    );
  }

  private applyProcessBootstrapTransportOverlay(
    input: TeamProvisioningProcessBootstrapTransportOverlayInput
  ) {
    return this.bootstrapEvidenceFacade.applyProcessBootstrapTransportOverlay(input);
  }

  private async applyBootstrapTranscriptEvidenceOverlay(
    snapshot: PersistedTeamLaunchSnapshot | null
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return this.bootstrapEvidenceFacade.applyBootstrapTranscriptEvidenceOverlay(snapshot);
  }
}
