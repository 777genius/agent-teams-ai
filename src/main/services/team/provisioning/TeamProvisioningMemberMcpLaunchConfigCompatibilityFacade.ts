import { TeamProvisioningStreamTurnCompatibilityFacade } from './TeamProvisioningStreamTurnCompatibilityFacade';

import type { RuntimeBootstrapMemberMcpLaunchConfig } from './TeamProvisioningBootstrapSpec';
import type { TeamProvisioningMemberMcpLaunchConfigProvisioner } from './TeamProvisioningMemberMcpLaunchConfig';
import type { ProvisioningRun } from './TeamProvisioningRunModel';
import type { TeamCreateRequest } from '@shared/types';

export abstract class TeamProvisioningMemberMcpLaunchConfigCompatibilityFacade<
  TRun extends ProvisioningRun = ProvisioningRun,
> extends TeamProvisioningStreamTurnCompatibilityFacade<TRun> {
  protected readonly memberMcpLaunchConfigProvisioner!: TeamProvisioningMemberMcpLaunchConfigProvisioner<TRun>;

  private async buildRuntimeBootstrapMemberMcpLaunchConfigs(input: {
    cwd: string;
    members: TeamCreateRequest['members'];
    run: TRun;
    controlApiBaseUrl?: string | null;
  }): Promise<Map<string, RuntimeBootstrapMemberMcpLaunchConfig>> {
    return this.memberMcpLaunchConfigProvisioner.buildRuntimeBootstrapMemberMcpLaunchConfigs(input);
  }

  async prepareLiveMemberMcpLaunchConfig(input: {
    teamName: string;
    cwd?: string;
    mcpPolicy?: unknown;
  }): Promise<RuntimeBootstrapMemberMcpLaunchConfig | null> {
    return this.memberMcpLaunchConfigProvisioner.prepareLiveMemberMcpLaunchConfig(input);
  }

  async discardLiveMemberMcpLaunchConfig(input: {
    teamName: string;
    mcpLaunchConfig: RuntimeBootstrapMemberMcpLaunchConfig | null | undefined;
  }): Promise<void> {
    await this.memberMcpLaunchConfigProvisioner.discardLiveMemberMcpLaunchConfig(input);
  }

  private async removeRunMemberMcpConfigFiles(run: TRun): Promise<void> {
    await this.memberMcpLaunchConfigProvisioner.removeRunMemberMcpConfigFiles(run);
  }

  private removeRunMemberMcpConfigFilesLater(run: TRun): void {
    this.memberMcpLaunchConfigProvisioner.removeRunMemberMcpConfigFilesLater(run);
  }
}
