import { TeamProvisioningRuntimeResourceSamplingCompatibilityFacade } from './TeamProvisioningRuntimeResourceSamplingCompatibilityFacade';

import type { TeamProvisioningCompatibilityDelegationRun } from './TeamProvisioningCompatibilityFacade';
import type { LiveRosterAttachReason } from './TeamProvisioningMemberLifecycleTypes';
import type { RetryFailedOpenCodeSecondaryLanesResult } from '@shared/types';

export interface TeamProvisioningMemberLifecyclePublicFacade {
  isMemberLifecycleOperationActive(teamName: string, memberName: string): boolean;
  attachLiveRosterMember(
    teamName: string,
    memberName: string,
    options?: { reason?: LiveRosterAttachReason }
  ): Promise<void>;
  detachLiveRosterMember(teamName: string, memberName: string): Promise<void>;
  restartMember(teamName: string, memberName: string): Promise<void>;
  retryFailedOpenCodeSecondaryLanes(
    teamName: string
  ): Promise<RetryFailedOpenCodeSecondaryLanesResult>;
  skipMemberForLaunch(teamName: string, memberName: string): Promise<void>;
  reattachOpenCodeOwnedMemberLane(
    teamName: string,
    memberName: string,
    options?: { reason?: 'member_added' | 'member_updated' | 'manual_restart' }
  ): Promise<void>;
  detachOpenCodeOwnedMemberLane(teamName: string, memberName: string): Promise<void>;
}

export abstract class TeamProvisioningMemberLifecycleCompatibilityFacade<
  TRun extends TeamProvisioningCompatibilityDelegationRun =
    TeamProvisioningCompatibilityDelegationRun,
> extends TeamProvisioningRuntimeResourceSamplingCompatibilityFacade<TRun> {
  protected abstract readonly memberLifecycleFacade: TeamProvisioningMemberLifecyclePublicFacade;

  protected isMemberLifecycleOperationActive(teamName: string, memberName: string): boolean {
    return this.memberLifecycleFacade.isMemberLifecycleOperationActive(teamName, memberName);
  }

  async attachLiveRosterMember(
    teamName: string,
    memberName: string,
    options?: { reason?: LiveRosterAttachReason }
  ): Promise<void> {
    return this.memberLifecycleFacade.attachLiveRosterMember(teamName, memberName, options);
  }

  async detachLiveRosterMember(teamName: string, memberName: string): Promise<void> {
    return this.memberLifecycleFacade.detachLiveRosterMember(teamName, memberName);
  }

  async restartMember(teamName: string, memberName: string): Promise<void> {
    return this.memberLifecycleFacade.restartMember(teamName, memberName);
  }

  async retryFailedOpenCodeSecondaryLanes(
    teamName: string
  ): Promise<RetryFailedOpenCodeSecondaryLanesResult> {
    return this.memberLifecycleFacade.retryFailedOpenCodeSecondaryLanes(teamName);
  }

  async skipMemberForLaunch(teamName: string, memberName: string): Promise<void> {
    return this.memberLifecycleFacade.skipMemberForLaunch(teamName, memberName);
  }

  async reattachOpenCodeOwnedMemberLane(
    teamName: string,
    memberName: string,
    options?: { reason?: 'member_added' | 'member_updated' | 'manual_restart' }
  ): Promise<void> {
    return this.memberLifecycleFacade.reattachOpenCodeOwnedMemberLane(
      teamName,
      memberName,
      options
    );
  }

  async detachOpenCodeOwnedMemberLane(teamName: string, memberName: string): Promise<void> {
    return this.memberLifecycleFacade.detachOpenCodeOwnedMemberLane(teamName, memberName);
  }
}
