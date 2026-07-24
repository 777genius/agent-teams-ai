import {
  CancelProvisioning,
  GetProvisioningStatus,
  LaunchTeam,
  LifecycleLaneCoordinator,
  PrepareProvisioning,
  RecoverTeamRun,
  StopTeam,
  TEAM_LIFECYCLE_DURABLE_COMMAND_DESCRIPTORS,
} from '../../core/application';

import type {
  CancelProvisioningRequest,
  CancelProvisioningResult,
  GetProvisioningStatusRequest,
  GetProvisioningStatusResult,
  LaunchTeamRequest,
  LaunchTeamResult,
  PrepareProvisioningRequest,
  PrepareProvisioningResult,
  RecoverTeamRunRequest,
  RecoverTeamRunResult,
  StopTeamRequest,
  StopTeamResult,
} from '../../contracts';
import type {
  TeamLifecycleCommandContext,
  TeamLifecycleCommandDependencies,
} from '../../core/application';

export interface TeamLifecycleCommandFeature {
  readonly commandDescriptors: typeof TEAM_LIFECYCLE_DURABLE_COMMAND_DESCRIPTORS;
  prepareProvisioning(
    request: PrepareProvisioningRequest,
    context: TeamLifecycleCommandContext
  ): Promise<PrepareProvisioningResult>;
  launchTeam(
    request: LaunchTeamRequest,
    context: TeamLifecycleCommandContext
  ): Promise<LaunchTeamResult>;
  getProvisioningStatus(
    request: GetProvisioningStatusRequest,
    context: TeamLifecycleCommandContext
  ): Promise<GetProvisioningStatusResult>;
  cancelProvisioning(
    request: CancelProvisioningRequest,
    context: TeamLifecycleCommandContext
  ): Promise<CancelProvisioningResult>;
  stopTeam(request: StopTeamRequest, context: TeamLifecycleCommandContext): Promise<StopTeamResult>;
  recoverTeamRun(
    request: RecoverTeamRunRequest,
    context: TeamLifecycleCommandContext
  ): Promise<RecoverTeamRunResult>;
}

export type TeamLifecycleCommandFeatureDependencies = TeamLifecycleCommandDependencies;

export function createTeamLifecycleCommandFeature(
  dependencies: TeamLifecycleCommandFeatureDependencies
): TeamLifecycleCommandFeature {
  const lanes = new LifecycleLaneCoordinator(dependencies.backendRegistry);
  const prepare = new PrepareProvisioning({
    state: dependencies.state,
    preflight: dependencies.provisioningPreflight,
    deadlines: dependencies.deadlines,
    clock: dependencies.clock,
  });
  const launch = new LaunchTeam({
    state: dependencies.state,
    fingerprint: dependencies.fingerprint,
    externalWriterBarrier: dependencies.externalWriterBarrier,
    deadlines: dependencies.deadlines,
    lanes,
    clock: dependencies.clock,
    ids: dependencies.ids,
  });
  const status = new GetProvisioningStatus({
    state: dependencies.state,
    lanes,
    legacyRuntime: dependencies.legacyRuntime,
    clock: dependencies.clock,
    ids: dependencies.ids,
  });
  const drain = {
    state: dependencies.state,
    fingerprint: dependencies.fingerprint,
    lanes,
    legacyRuntime: dependencies.legacyRuntime,
    clock: dependencies.clock,
    ids: dependencies.ids,
  };
  const cancel = new CancelProvisioning(drain);
  const stop = new StopTeam(drain);
  const recover = new RecoverTeamRun(drain);

  return Object.freeze({
    commandDescriptors: TEAM_LIFECYCLE_DURABLE_COMMAND_DESCRIPTORS,
    prepareProvisioning: (
      request: PrepareProvisioningRequest,
      context: TeamLifecycleCommandContext
    ) => prepare.execute(request, context),
    launchTeam: (request: LaunchTeamRequest, context: TeamLifecycleCommandContext) =>
      launch.execute(request, context),
    getProvisioningStatus: (
      request: GetProvisioningStatusRequest,
      context: TeamLifecycleCommandContext
    ) => status.execute(request, context),
    cancelProvisioning: (
      request: CancelProvisioningRequest,
      context: TeamLifecycleCommandContext
    ) => cancel.execute(request, context),
    stopTeam: (request: StopTeamRequest, context: TeamLifecycleCommandContext) =>
      stop.execute(request, context),
    recoverTeamRun: (request: RecoverTeamRunRequest, context: TeamLifecycleCommandContext) =>
      recover.execute(request, context),
  });
}
