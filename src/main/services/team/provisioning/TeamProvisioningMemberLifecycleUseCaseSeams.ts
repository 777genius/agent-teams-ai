import type { AppendDirectProcessRuntimeEventUseCase } from './TeamProvisioningAppendDirectProcessRuntimeEventUseCase';
import type { OpenCodeSecondaryRetryCandidate } from './TeamProvisioningCollectFailedOpenCodeSecondaryRetryCandidatesUseCase';
import type {
  DirectProcessMemberRestartInput,
  LiveRosterAttachReason,
  ProvisioningRun,
  ReattachOpenCodeOwnedMemberLaneOptions,
} from './TeamProvisioningMemberLifecycleTypes';
import type { PersistOpenCodeMemberRestartSystemMessageUseCase } from './TeamProvisioningOpenCodeMemberRestartSystemMessageUseCase';
import type {
  PreparePrimaryOwnedMemberRestartRuntimeInput,
  PreparePrimaryOwnedMemberRestartRuntimeResult,
} from './TeamProvisioningPreparePrimaryOwnedMemberRestartRuntimeUseCase';
import type { OpenCodeSecondaryRetryOutcome } from './TeamProvisioningReadOpenCodeSecondaryRetryOutcomeUseCase';
import type { ResolveDirectRestartRuntimeCwdUseCase } from './TeamProvisioningResolveDirectRestartRuntimeCwdUseCase';
import type { StopPrimaryOwnedRosterRuntimeInput } from './TeamProvisioningStopPrimaryOwnedRosterRuntimeUseCase';
import type { UpdateDirectTmuxRestartMemberConfigUseCase } from './TeamProvisioningUpdateDirectTmuxRestartMemberConfigUseCase';
import type { RetryFailedOpenCodeSecondaryLanesResult } from '@shared/types';

export interface TeamProvisioningMemberLifecycleActionUseCaseSeams {
  attachLiveRosterMember?(
    teamName: string,
    memberName: string,
    options?: { reason?: LiveRosterAttachReason }
  ): Promise<void>;
  detachLiveRosterMember?(teamName: string, memberName: string): Promise<void>;
  restartMember?(teamName: string, memberName: string): Promise<void>;
  retryFailedOpenCodeSecondaryLanes?(
    teamName: string
  ): Promise<RetryFailedOpenCodeSecondaryLanesResult>;
  skipMemberForLaunch?(teamName: string, memberName: string): Promise<void>;
}

export interface TeamProvisioningMemberLifecycleRestartUseCaseSeams {
  persistOpenCodeMemberRestartSystemMessage?: PersistOpenCodeMemberRestartSystemMessageUseCase;
  launchDirectProcessMemberRestart?(input: DirectProcessMemberRestartInput): Promise<void>;
  appendDirectProcessRuntimeEvent?: AppendDirectProcessRuntimeEventUseCase;
  updateDirectTmuxRestartMemberConfig?: UpdateDirectTmuxRestartMemberConfigUseCase;
  stopPrimaryOwnedRosterRuntime?(input: StopPrimaryOwnedRosterRuntimeInput): Promise<void>;
  preparePrimaryOwnedMemberRestartRuntime?(
    input: PreparePrimaryOwnedMemberRestartRuntimeInput
  ): Promise<PreparePrimaryOwnedMemberRestartRuntimeResult>;
  resolveDirectRestartRuntimeCwd?: ResolveDirectRestartRuntimeCwdUseCase;
}

export interface TeamProvisioningMemberLifecycleOpenCodeRetryUseCaseSeams {
  collectFailedOpenCodeSecondaryRetryCandidates?(
    run: ProvisioningRun
  ): Promise<OpenCodeSecondaryRetryCandidate[]>;
  readOpenCodeSecondaryRetryOutcome?(
    run: ProvisioningRun,
    memberName: string,
    laneId: string
  ): Promise<OpenCodeSecondaryRetryOutcome>;
  notifyLeadAboutConfirmedOpenCodeRetries?(
    run: ProvisioningRun,
    result: RetryFailedOpenCodeSecondaryLanesResult
  ): Promise<void>;
  reattachOpenCodeOwnedMemberLaneUnlocked?(
    teamName: string,
    memberName: string,
    options?: ReattachOpenCodeOwnedMemberLaneOptions
  ): Promise<void>;
  detachOpenCodeOwnedMemberLaneUnlocked?(teamName: string, memberName: string): Promise<void>;
}

export interface TeamProvisioningMemberLifecycleControllerUseCaseSeams {
  actions?: TeamProvisioningMemberLifecycleActionUseCaseSeams;
  restart?: TeamProvisioningMemberLifecycleRestartUseCaseSeams;
  openCodeRetry?: TeamProvisioningMemberLifecycleOpenCodeRetryUseCaseSeams;
}
