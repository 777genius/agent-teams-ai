import { type TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import { execCli as defaultExecCli } from '@main/utils/childProcess';

import { ClaudeBinaryResolver } from '../ClaudeBinaryResolver';

import {
  type PreparedOpenCodeRuntimeAdapterLaunch,
  prepareOpenCodeRuntimeAdapterLaunch,
} from './TeamProvisioningOpenCodeRuntimeAdapterPreparation';
import {
  type CachedProbeResult,
  createInMemoryProviderProbeCachePort,
  type PrepareForProvisioningOptions,
  type ProbeResult,
  type ProviderProbeCachePort,
  TeamProvisioningPrepareCoordinator,
  type TeamProvisioningPrepareCoordinatorPorts,
} from './TeamProvisioningPrepareCoordinator';

import type { TeamLaunchRuntimeAdapter } from '../runtime';
import type {
  ProvisioningEnvResolution,
  TeamRuntimeAuthContext,
} from './TeamProvisioningEnvBuilder';
import type { RuntimeProviderLaunchFacts } from './TeamProvisioningRuntimeLaunchSelection';
import type {
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamProviderId,
  TeamProvisioningPrepareResult,
} from '@shared/types';

export interface TeamProvisioningPrepareFacadePorts {
  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null;
  buildProvisioningEnv(
    providerId?: TeamProviderId,
    providerBackendId?: string,
    options?: { teamRuntimeAuth?: TeamRuntimeAuthContext }
  ): Promise<ProvisioningEnvResolution>;
  runProviderOneShotDiagnostic(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    providerId: TeamProviderId,
    providerArgs: string[]
  ): Promise<{ warning?: string }>;
  readRuntimeProviderLaunchFacts(params: {
    claudePath: string;
    cwd: string;
    providerId: TeamProviderId;
    env: NodeJS.ProcessEnv;
    providerArgs?: string[];
    limitContext?: boolean;
  }): Promise<RuntimeProviderLaunchFacts>;
  resolveClaudeBinaryPath?: () => Promise<string | null>;
  probeClaudeRuntime(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    providerId: TeamProviderId | undefined,
    providerArgs: string[]
  ): Promise<{ warning?: string }>;
  ensureMemberWorktree(input: {
    teamName: string;
    memberName: string;
    baseCwd: string;
  }): Promise<{ worktreePath: string }>;
  providerProbeCache?: ProviderProbeCachePort;
  execCli?: TeamProvisioningPrepareCoordinatorPorts['execCli'];
  inspectOpenCodeLocalModelRuntime?: TeamProvisioningPrepareCoordinatorPorts['inspectOpenCodeLocalModelRuntime'];
  planRuntimeLanesOrThrow(
    leadProviderId: TeamProviderId | undefined,
    members: TeamCreateRequest['members'],
    baseCwd?: string
  ): TeamRuntimeLanePlan;
  info(message: string): void;
  warn(message: string): void;
}

export interface TeamProvisioningPrepareFacadeServiceHost {
  appShellBoundary: {
    getOpenCodeRuntimeAdapter: TeamProvisioningPrepareFacadePorts['getOpenCodeRuntimeAdapter'];
  };
  buildProvisioningEnv: TeamProvisioningPrepareFacadePorts['buildProvisioningEnv'];
  providerRuntime: Pick<
    TeamProvisioningPrepareFacadePorts,
    'runProviderOneShotDiagnostic' | 'probeClaudeRuntime'
  >;
  readRuntimeProviderLaunchFacts: TeamProvisioningPrepareFacadePorts['readRuntimeProviderLaunchFacts'];
  memberWorktreeManager: {
    ensureMemberWorktree: TeamProvisioningPrepareFacadePorts['ensureMemberWorktree'];
  };
  planRuntimeLanesOrThrow: TeamProvisioningPrepareFacadePorts['planRuntimeLanesOrThrow'];
}

export interface TeamProvisioningPrepareFacadeServiceHostOptions
  extends
    Pick<TeamProvisioningPrepareFacadePorts, 'info' | 'warn'>,
    Partial<
      Pick<
        TeamProvisioningPrepareFacadePorts,
        | 'execCli'
        | 'inspectOpenCodeLocalModelRuntime'
        | 'providerProbeCache'
        | 'resolveClaudeBinaryPath'
      >
    > {}

export function createTeamProvisioningPrepareFacadeFromService(
  service: TeamProvisioningPrepareFacadeServiceHost,
  options: TeamProvisioningPrepareFacadeServiceHostOptions
): TeamProvisioningPrepareFacade {
  return new TeamProvisioningPrepareFacade({
    getOpenCodeRuntimeAdapter: () => service.appShellBoundary.getOpenCodeRuntimeAdapter(),
    buildProvisioningEnv: (providerId, providerBackendId, envOptions) =>
      service.buildProvisioningEnv(providerId, providerBackendId, envOptions),
    runProviderOneShotDiagnostic: (claudePath, cwd, env, providerId, providerArgs) =>
      service.providerRuntime.runProviderOneShotDiagnostic(
        claudePath,
        cwd,
        env,
        providerId,
        providerArgs
      ),
    readRuntimeProviderLaunchFacts: (params) => service.readRuntimeProviderLaunchFacts(params),
    resolveClaudeBinaryPath: options.resolveClaudeBinaryPath,
    probeClaudeRuntime: (claudePath, cwd, env, providerId, providerArgs) =>
      service.providerRuntime.probeClaudeRuntime(claudePath, cwd, env, providerId, providerArgs),
    ensureMemberWorktree: (input) => service.memberWorktreeManager.ensureMemberWorktree(input),
    providerProbeCache: options.providerProbeCache,
    execCli: options.execCli,
    inspectOpenCodeLocalModelRuntime: options.inspectOpenCodeLocalModelRuntime,
    planRuntimeLanesOrThrow: (leadProviderId, members, baseCwd) =>
      service.planRuntimeLanesOrThrow(leadProviderId, members, baseCwd),
    info: (message) => options.info(message),
    warn: (message) => options.warn(message),
  });
}

export class TeamProvisioningPrepareFacade {
  private readonly coordinator: TeamProvisioningPrepareCoordinator;
  private readonly resolveClaudeBinaryPath: () => Promise<string | null>;

  constructor(private readonly ports: TeamProvisioningPrepareFacadePorts) {
    this.resolveClaudeBinaryPath =
      ports.resolveClaudeBinaryPath ?? (() => ClaudeBinaryResolver.resolve());
    const execCli = ports.execCli ?? defaultExecCli;
    this.coordinator = new TeamProvisioningPrepareCoordinator({
      providerProbeCache: ports.providerProbeCache ?? createInMemoryProviderProbeCachePort(),
      getOpenCodeRuntimeAdapter: () => ports.getOpenCodeRuntimeAdapter(),
      buildProvisioningEnv: (providerId, providerBackendId, options) =>
        ports.buildProvisioningEnv(providerId, providerBackendId, options),
      runProviderOneShotDiagnostic: (claudePath, cwd, env, providerId, providerArgs) =>
        ports.runProviderOneShotDiagnostic(claudePath, cwd, env, providerId, providerArgs),
      readRuntimeProviderLaunchFacts: (params) => ports.readRuntimeProviderLaunchFacts(params),
      resolveClaudeBinaryPath: this.resolveClaudeBinaryPath,
      probeClaudeRuntime: (claudePath, cwd, env, providerId, providerArgs) =>
        ports.probeClaudeRuntime(claudePath, cwd, env, providerId, providerArgs),
      ensureMemberWorktree: (input) => ports.ensureMemberWorktree(input),
      execCli: (command, args, opts) => execCli(command, args, opts),
      inspectOpenCodeLocalModelRuntime: ports.inspectOpenCodeLocalModelRuntime,
      info: (message) => ports.info(message),
      warn: (message) => ports.warn(message),
    });
  }

  async warmup(): Promise<void> {
    await this.coordinator.warmup();
  }

  async prepareForProvisioning(
    cwd?: string,
    opts?: PrepareForProvisioningOptions
  ): Promise<TeamProvisioningPrepareResult> {
    return this.coordinator.prepareForProvisioning(cwd, opts);
  }

  async materializeEffectiveTeamMemberSpecs(params: {
    claudePath: string;
    cwd: string;
    members: TeamCreateRequest['members'];
    defaults: {
      providerId?: TeamProviderId;
      model?: string;
      effort?: TeamCreateRequest['effort'];
    };
    primaryProviderId?: TeamProviderId;
    primaryEnv?: ProvisioningEnvResolution;
    teamRuntimeAuth?: TeamRuntimeAuthContext;
    limitContext?: boolean;
    providerArgsResolver?: (input: {
      providerId: TeamProviderId;
      providerArgs: string[];
      phase: 'default-model-resolution';
    }) => string[];
  }): Promise<TeamCreateRequest['members']> {
    return this.coordinator.materializeEffectiveTeamMemberSpecs(params);
  }

  getOpenCodeRuntimeLaunchCwd(fallbackCwd: string, members: TeamCreateRequest['members']): string {
    return this.coordinator.getOpenCodeRuntimeLaunchCwd(fallbackCwd, members);
  }

  async prepareOpenCodeRuntimeAdapterLaunch<
    TRequest extends TeamCreateRequest | TeamLaunchRequest,
  >(params: {
    request: TRequest;
    members: TeamCreateRequest['members'];
  }): Promise<PreparedOpenCodeRuntimeAdapterLaunch<TRequest>> {
    return prepareOpenCodeRuntimeAdapterLaunch(params, {
      resolveClaudePath: this.resolveClaudeBinaryPath,
      buildProvisioningEnv: (providerId, providerBackendId) =>
        this.ports.buildProvisioningEnv(providerId, providerBackendId),
      resolveProviderDefaultModel: (claudePath, cwd, providerId, env, providerArgs, limitContext) =>
        this.coordinator.resolveProviderDefaultModel(
          claudePath,
          cwd,
          providerId,
          env,
          providerArgs,
          limitContext
        ),
      resolveOpenCodeMemberWorkspacesForRuntime: (workspaceParams) =>
        this.coordinator.resolveOpenCodeMemberWorkspacesForRuntime(workspaceParams),
      planRuntimeLanesOrThrow: (leadProviderId, members, cwd) =>
        this.ports.planRuntimeLanesOrThrow(leadProviderId, members, cwd),
      buildOpenCodeRuntimeAdapterLaunchMembers: (launchRequest, members, lanePlan) =>
        this.coordinator.buildOpenCodeRuntimeAdapterLaunchMembers(launchRequest, members, lanePlan),
    });
  }

  buildOpenCodeRuntimeAdapterLaunchMembers(
    request: TeamCreateRequest | TeamLaunchRequest,
    members: TeamCreateRequest['members'],
    lanePlan?: TeamRuntimeLanePlan
  ): TeamCreateRequest['members'] {
    return this.coordinator.buildOpenCodeRuntimeAdapterLaunchMembers(request, members, lanePlan);
  }

  async resolveOpenCodeMemberWorkspacesForRuntime(params: {
    teamName: string;
    baseCwd: string;
    leadProviderId?: TeamProviderId;
    members: TeamCreateRequest['members'];
  }): Promise<TeamCreateRequest['members']> {
    return this.coordinator.resolveOpenCodeMemberWorkspacesForRuntime(params);
  }

  getFreshCachedProbeResult(
    cwd: string,
    providerId: TeamProviderId | undefined
  ): CachedProbeResult | null {
    return this.coordinator.getFreshCachedProbeResult(cwd, providerId);
  }

  clearProbeCache(cwd: string, providerId: TeamProviderId | undefined): void {
    this.coordinator.clearProbeCache(cwd, providerId);
  }

  async getCachedOrProbeResult(
    cwd: string,
    providerId: TeamProviderId | undefined
  ): Promise<ProbeResult | null> {
    return this.coordinator.getCachedOrProbeResult(cwd, providerId);
  }
}
