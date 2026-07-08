import { TeamProvisioningAppShellBoundary } from './TeamProvisioningAppShellBoundary';

import type { TeamLaunchRuntimeAdapter, TeamRuntimeAdapterRegistry } from '../runtime';
import type {
  MemberWorkSyncAcceptedReportChecker,
  MemberWorkSyncProofMissingRecoveryScheduler,
} from './TeamProvisioningMemberWorkSyncProof';
import type {
  RuntimeTurnSettledEnvironmentProvider,
  RuntimeTurnSettledHookSettingsProvider,
} from './TeamProvisioningRuntimeTurnSettledPlanning';
import type { WorkspaceTrustCoordinator } from '@features/workspace-trust/main';
import type { CrossTeamSendRequest, CrossTeamSendResult } from '@shared/types';

export abstract class TeamProvisioningAppShellFacade {
  protected readonly appShellBoundary = new TeamProvisioningAppShellBoundary();

  setRuntimeAdapterRegistry(registry: TeamRuntimeAdapterRegistry | null): void {
    this.appShellBoundary.setRuntimeAdapterRegistry(registry);
  }

  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null {
    return this.appShellBoundary.getOpenCodeRuntimeAdapter();
  }

  setMemberRuntimeAdvisoryInvalidator(
    invalidator: ((teamName: string, memberName: string) => void) | null
  ): void {
    this.appShellBoundary.setMemberRuntimeAdvisoryInvalidator(invalidator);
  }

  setMemberWorkSyncProofMissingRecoveryScheduler(
    scheduler: MemberWorkSyncProofMissingRecoveryScheduler | null
  ): void {
    this.appShellBoundary.setMemberWorkSyncProofMissingRecoveryScheduler(scheduler);
  }

  setMemberWorkSyncAcceptedReportChecker(
    checker: MemberWorkSyncAcceptedReportChecker | null
  ): void {
    this.appShellBoundary.setMemberWorkSyncAcceptedReportChecker(checker);
  }

  setCrossTeamSender(
    sender: ((request: CrossTeamSendRequest) => Promise<CrossTeamSendResult>) | null
  ): void {
    this.appShellBoundary.setCrossTeamSender(sender);
  }

  setControlApiBaseUrlResolver(resolver: (() => Promise<string | null>) | null): void {
    this.appShellBoundary.setControlApiBaseUrlResolver(resolver);
  }

  setWorkspaceTrustCoordinator(coordinator: WorkspaceTrustCoordinator | null): void {
    this.appShellBoundary.setWorkspaceTrustCoordinator(coordinator);
  }

  setRuntimeTurnSettledHookSettingsProvider(
    provider: RuntimeTurnSettledHookSettingsProvider | null
  ): void {
    this.appShellBoundary.setRuntimeTurnSettledHookSettingsProvider(provider);
  }

  setRuntimeTurnSettledEnvironmentProvider(
    provider: RuntimeTurnSettledEnvironmentProvider | null
  ): void {
    this.appShellBoundary.setRuntimeTurnSettledEnvironmentProvider(provider);
  }
}
