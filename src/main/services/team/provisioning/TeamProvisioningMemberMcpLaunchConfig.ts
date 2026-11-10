import {
  buildTeamMemberMcpSettingSources,
  normalizeTeamMemberMcpPolicy,
  requiresStrictTeamMemberMcpConfig,
} from '@shared/utils/teamMemberMcpPolicy';

import type { RuntimeBootstrapMemberMcpLaunchConfig } from './TeamProvisioningBootstrapSpec';
import type { TeamCreateRequest, TeamMemberMcpPolicy } from '@shared/types';

export interface TeamProvisioningMemberMcpRun {
  request: Pick<TeamCreateRequest, 'cwd'>;
  memberMcpConfigPaths?: string[];
  processKilled?: boolean;
  cancelRequested?: boolean;
}

export interface TeamProvisioningMemberMcpConfigBuilderPort {
  writeConfigFile(
    projectPath?: string,
    options?: { mcpPolicy?: TeamMemberMcpPolicy; controlApiBaseUrl?: string | null }
  ): Promise<string>;
  removeConfigFile(configPath: string): Promise<void> | void;
}

export interface TeamProvisioningMemberMcpLaunchConfigPorts<
  TRun extends TeamProvisioningMemberMcpRun,
> {
  mcpConfigBuilder: TeamProvisioningMemberMcpConfigBuilderPort;
  ensureCwdExists(cwd: string): Promise<void>;
  resolveControlApiBaseUrl(): Promise<string | null>;
  getAliveRun(teamName: string): TRun | null | undefined;
}

export interface TeamProvisioningMemberMcpLaunchConfigServiceHost<
  TRun extends TeamProvisioningMemberMcpRun,
> {
  mcpConfigBuilder: TeamProvisioningMemberMcpConfigBuilderPort;
  providerRuntime: {
    resolveControlApiBaseUrl(): Promise<string | null>;
  };
  runTracking: {
    getAliveRunId(teamName: string): string | null;
  };
  runs: {
    get(runId: string): TRun | undefined;
  };
}

export interface TeamProvisioningMemberMcpLaunchConfigServiceHostOptions {
  ensureCwdExists: TeamProvisioningMemberMcpLaunchConfigPorts<TeamProvisioningMemberMcpRun>['ensureCwdExists'];
}

export function createTeamProvisioningMemberMcpLaunchConfigProvisionerFromService<
  TRun extends TeamProvisioningMemberMcpRun,
>(
  service: TeamProvisioningMemberMcpLaunchConfigServiceHost<TRun>,
  options: TeamProvisioningMemberMcpLaunchConfigServiceHostOptions
): TeamProvisioningMemberMcpLaunchConfigProvisioner<TRun> {
  return new TeamProvisioningMemberMcpLaunchConfigProvisioner({
    mcpConfigBuilder: service.mcpConfigBuilder,
    ensureCwdExists: (cwd) => options.ensureCwdExists(cwd),
    resolveControlApiBaseUrl: () => service.providerRuntime.resolveControlApiBaseUrl(),
    getAliveRun: (teamName) => {
      const runId = service.runTracking.getAliveRunId(teamName);
      return runId ? service.runs.get(runId) : undefined;
    },
  });
}

export class TeamProvisioningMemberMcpLaunchConfigProvisioner<
  TRun extends TeamProvisioningMemberMcpRun,
> {
  constructor(private readonly ports: TeamProvisioningMemberMcpLaunchConfigPorts<TRun>) {}

  async buildRuntimeBootstrapMemberMcpLaunchConfigs(input: {
    cwd: string;
    members: TeamCreateRequest['members'];
    run: TRun;
    controlApiBaseUrl?: string | null;
  }): Promise<Map<string, RuntimeBootstrapMemberMcpLaunchConfig>> {
    const configs = new Map<string, RuntimeBootstrapMemberMcpLaunchConfig>();
    for (const member of input.members) {
      const mcpPolicy = normalizeTeamMemberMcpPolicy(member.mcpPolicy);
      if (!mcpPolicy) {
        continue;
      }

      const memberCwd = member.cwd?.trim() || input.cwd;
      const mcpConfigPath = await this.ports.mcpConfigBuilder.writeConfigFile(memberCwd, {
        mcpPolicy,
        controlApiBaseUrl: input.controlApiBaseUrl,
      });
      this.trackMemberMcpConfigPath(input.run, mcpConfigPath);
      configs.set(member.name, this.buildLaunchConfig(mcpConfigPath, mcpPolicy));
    }
    return configs;
  }

  async buildTrackedMemberMcpLaunchConfig(input: {
    cwd: string;
    mcpPolicy: unknown;
    run: TRun;
    controlApiBaseUrl?: string | null;
  }): Promise<RuntimeBootstrapMemberMcpLaunchConfig | null> {
    const mcpPolicy = normalizeTeamMemberMcpPolicy(input.mcpPolicy);
    if (!mcpPolicy) {
      return null;
    }

    const mcpConfigPath = await this.ports.mcpConfigBuilder.writeConfigFile(input.cwd, {
      mcpPolicy,
      controlApiBaseUrl: input.controlApiBaseUrl,
    });
    this.trackMemberMcpConfigPath(input.run, mcpConfigPath);
    return this.buildLaunchConfig(mcpConfigPath, mcpPolicy);
  }

  async removeTrackedMemberMcpLaunchConfig(
    run: TRun,
    mcpLaunchConfig: RuntimeBootstrapMemberMcpLaunchConfig | null | undefined
  ): Promise<void> {
    if (!mcpLaunchConfig?.mcpConfigPath) {
      return;
    }
    const memberMcpConfigPaths = (run.memberMcpConfigPaths ??= []);
    const index = memberMcpConfigPaths.indexOf(mcpLaunchConfig.mcpConfigPath);
    if (index >= 0) {
      memberMcpConfigPaths.splice(index, 1);
    }
    await this.ports.mcpConfigBuilder.removeConfigFile(mcpLaunchConfig.mcpConfigPath);
  }

  async prepareLiveMemberMcpLaunchConfig(input: {
    teamName: string;
    cwd?: string;
    mcpPolicy?: unknown;
  }): Promise<RuntimeBootstrapMemberMcpLaunchConfig | null> {
    const mcpPolicy = normalizeTeamMemberMcpPolicy(input.mcpPolicy);
    if (!mcpPolicy) {
      return null;
    }

    const run = this.ports.getAliveRun(input.teamName);
    if (!run || run.processKilled || run.cancelRequested) {
      throw new Error(`Team "${input.teamName}" is not currently running`);
    }

    const cwd = input.cwd?.trim() || run.request.cwd?.trim();
    if (!cwd) {
      throw new Error(`Team "${input.teamName}" project path is not available`);
    }
    await this.ports.ensureCwdExists(cwd);

    return this.buildTrackedMemberMcpLaunchConfig({
      cwd,
      mcpPolicy,
      run,
      controlApiBaseUrl: await this.ports.resolveControlApiBaseUrl().catch(() => null),
    });
  }

  async discardLiveMemberMcpLaunchConfig(input: {
    teamName: string;
    mcpLaunchConfig: RuntimeBootstrapMemberMcpLaunchConfig | null | undefined;
  }): Promise<void> {
    const run = this.ports.getAliveRun(input.teamName);
    if (!run) {
      if (input.mcpLaunchConfig?.mcpConfigPath) {
        await this.ports.mcpConfigBuilder.removeConfigFile(input.mcpLaunchConfig.mcpConfigPath);
      }
      return;
    }
    await this.removeTrackedMemberMcpLaunchConfig(run, input.mcpLaunchConfig);
  }

  async removeRunMemberMcpConfigFiles(run: TRun): Promise<void> {
    const paths = run.memberMcpConfigPaths?.splice(0) ?? [];
    await Promise.all(
      paths.map((configPath) =>
        Promise.resolve(this.ports.mcpConfigBuilder.removeConfigFile(configPath))
      )
    );
  }

  removeRunMemberMcpConfigFilesLater(run: TRun): void {
    for (const configPath of run.memberMcpConfigPaths?.splice(0) ?? []) {
      void this.ports.mcpConfigBuilder.removeConfigFile(configPath);
    }
  }

  private trackMemberMcpConfigPath(run: TRun, mcpConfigPath: string): void {
    const memberMcpConfigPaths = run.memberMcpConfigPaths ?? [];
    run.memberMcpConfigPaths = memberMcpConfigPaths;
    memberMcpConfigPaths.push(mcpConfigPath);
  }

  private buildLaunchConfig(
    mcpConfigPath: string,
    mcpPolicy: TeamMemberMcpPolicy
  ): RuntimeBootstrapMemberMcpLaunchConfig {
    return {
      mcpConfigPath,
      mcpSettingSources: buildTeamMemberMcpSettingSources(mcpPolicy),
      strictMcpConfig: requiresStrictTeamMemberMcpConfig(mcpPolicy),
    };
  }
}
