import {
  getOpenCodeRuntimeAdapter as getOpenCodeRuntimeAdapterFromRegistry,
  getOpenCodeRuntimeMessageAdapter as getOpenCodeRuntimeMessageAdapterFromAdapter,
  getOpenCodeRuntimePermissionListingAdapter as getOpenCodeRuntimePermissionListingAdapterFromAdapter,
} from './TeamProvisioningRuntimeRecipientResolution';

import type { OpenCodeRuntimeMessageAdapter } from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import type { TeamLaunchRuntimeAdapter, TeamRuntimeAdapterRegistry } from '../runtime';
import type {
  MemberWorkSyncAcceptedReportChecker,
  MemberWorkSyncProofMissingRecoveryScheduler,
} from './TeamProvisioningMemberWorkSyncProof';
import type { OpenCodeRuntimePermissionListingAdapter } from './TeamProvisioningOpenCodeRuntimePermissions';
import type {
  RuntimeTurnSettledEnvironmentProvider,
  RuntimeTurnSettledHookSettingsProvider,
} from './TeamProvisioningRuntimeTurnSettledPlanning';
import type { WorkspaceTrustCoordinator } from '@features/workspace-trust/main';
import type { CrossTeamSendRequest, CrossTeamSendResult } from '@shared/types';

export type TeamProvisioningMemberRuntimeAdvisoryInvalidator = (
  teamName: string,
  memberName: string
) => void;

export type TeamProvisioningCrossTeamSender = (
  request: CrossTeamSendRequest
) => Promise<CrossTeamSendResult>;

export type TeamProvisioningControlApiBaseUrlResolver = () => Promise<string | null>;

export class TeamProvisioningAppShellBoundary {
  private runtimeAdapterRegistry: TeamRuntimeAdapterRegistry | null = null;
  private memberRuntimeAdvisoryInvalidator: TeamProvisioningMemberRuntimeAdvisoryInvalidator | null =
    null;
  private memberWorkSyncProofMissingRecoveryScheduler: MemberWorkSyncProofMissingRecoveryScheduler | null =
    null;
  private memberWorkSyncAcceptedReportChecker: MemberWorkSyncAcceptedReportChecker | null = null;
  private crossTeamSender: TeamProvisioningCrossTeamSender | null = null;
  private controlApiBaseUrlResolver: TeamProvisioningControlApiBaseUrlResolver | null = null;
  private workspaceTrustCoordinator: WorkspaceTrustCoordinator | null = null;
  private runtimeTurnSettledHookSettingsProvider: RuntimeTurnSettledHookSettingsProvider | null =
    null;
  private runtimeTurnSettledEnvironmentProvider: RuntimeTurnSettledEnvironmentProvider | null =
    null;

  setRuntimeAdapterRegistry(registry: TeamRuntimeAdapterRegistry | null): void {
    this.runtimeAdapterRegistry = registry;
  }

  getRuntimeAdapterRegistry(): TeamRuntimeAdapterRegistry | null {
    return this.runtimeAdapterRegistry;
  }

  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null {
    return getOpenCodeRuntimeAdapterFromRegistry(this.runtimeAdapterRegistry);
  }

  getOpenCodeRuntimeMessageAdapter(): OpenCodeRuntimeMessageAdapter | null {
    return getOpenCodeRuntimeMessageAdapterFromAdapter(this.getOpenCodeRuntimeAdapter());
  }

  getOpenCodeRuntimePermissionListingAdapter(): OpenCodeRuntimePermissionListingAdapter | null {
    return getOpenCodeRuntimePermissionListingAdapterFromAdapter(this.getOpenCodeRuntimeAdapter());
  }

  setMemberRuntimeAdvisoryInvalidator(
    invalidator: TeamProvisioningMemberRuntimeAdvisoryInvalidator | null
  ): void {
    this.memberRuntimeAdvisoryInvalidator = invalidator;
  }

  getMemberRuntimeAdvisoryInvalidator(): TeamProvisioningMemberRuntimeAdvisoryInvalidator | null {
    return this.memberRuntimeAdvisoryInvalidator;
  }

  setMemberWorkSyncProofMissingRecoveryScheduler(
    scheduler: MemberWorkSyncProofMissingRecoveryScheduler | null
  ): void {
    this.memberWorkSyncProofMissingRecoveryScheduler = scheduler;
  }

  getMemberWorkSyncProofMissingRecoveryScheduler(): MemberWorkSyncProofMissingRecoveryScheduler | null {
    return this.memberWorkSyncProofMissingRecoveryScheduler;
  }

  setMemberWorkSyncAcceptedReportChecker(
    checker: MemberWorkSyncAcceptedReportChecker | null
  ): void {
    this.memberWorkSyncAcceptedReportChecker = checker;
  }

  getMemberWorkSyncAcceptedReportChecker(): MemberWorkSyncAcceptedReportChecker | null {
    return this.memberWorkSyncAcceptedReportChecker;
  }

  setCrossTeamSender(sender: TeamProvisioningCrossTeamSender | null): void {
    this.crossTeamSender = sender;
  }

  getCrossTeamSender(): TeamProvisioningCrossTeamSender | null {
    return this.crossTeamSender;
  }

  setControlApiBaseUrlResolver(resolver: TeamProvisioningControlApiBaseUrlResolver | null): void {
    this.controlApiBaseUrlResolver = resolver;
  }

  getControlApiBaseUrlResolver(): TeamProvisioningControlApiBaseUrlResolver | null {
    return this.controlApiBaseUrlResolver;
  }

  setWorkspaceTrustCoordinator(coordinator: WorkspaceTrustCoordinator | null): void {
    this.workspaceTrustCoordinator = coordinator;
  }

  getWorkspaceTrustCoordinator(): WorkspaceTrustCoordinator | null {
    return this.workspaceTrustCoordinator;
  }

  setRuntimeTurnSettledHookSettingsProvider(
    provider: RuntimeTurnSettledHookSettingsProvider | null
  ): void {
    this.runtimeTurnSettledHookSettingsProvider = provider;
  }

  getRuntimeTurnSettledHookSettingsProvider(): RuntimeTurnSettledHookSettingsProvider | null {
    return this.runtimeTurnSettledHookSettingsProvider;
  }

  setRuntimeTurnSettledEnvironmentProvider(
    provider: RuntimeTurnSettledEnvironmentProvider | null
  ): void {
    this.runtimeTurnSettledEnvironmentProvider = provider;
  }

  getRuntimeTurnSettledEnvironmentProvider(): RuntimeTurnSettledEnvironmentProvider | null {
    return this.runtimeTurnSettledEnvironmentProvider;
  }
}
