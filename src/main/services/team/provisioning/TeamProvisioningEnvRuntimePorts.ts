import {
  buildCrossProviderMemberArgs,
  buildProvisioningEnv,
  type BuildProvisioningEnvOptions,
  type CrossProviderMemberArgsResult,
  type ProvisioningEnvResolution,
  type TeamProvisioningEnvBuilderPorts,
  type TeamRuntimeAuthContext,
} from './TeamProvisioningEnvBuilder';
import {
  buildRuntimeTurnSettledEnvironment,
  buildRuntimeTurnSettledHookSettingsArgs,
  type RuntimeTurnSettledEnvironmentProvider,
  type RuntimeTurnSettledHookSettingsProvider,
} from './TeamProvisioningRuntimeTurnSettledPlanning';

import type { TeamCreateRequest, TeamProviderId } from '@shared/types';

export interface TeamProvisioningEnvRuntimePortsDeps {
  providerConnectionService: TeamProvisioningEnvBuilderPorts['providerConnectionService'];
  getControlApiBaseUrlResolver(): (() => Promise<string | null>) | null;
  getRuntimeTurnSettledEnvironmentProvider(): RuntimeTurnSettledEnvironmentProvider | null;
  getRuntimeTurnSettledHookSettingsProvider(): RuntimeTurnSettledHookSettingsProvider | null;
  logger: TeamProvisioningEnvBuilderPorts['logger'];
  processEnv?: NodeJS.ProcessEnv;
}

export interface TeamProvisioningEnvRuntimePorts {
  getProvisioningEnvBuilderPorts(): TeamProvisioningEnvBuilderPorts;
  buildProvisioningEnv(
    providerId?: TeamProviderId,
    providerBackendId?: string | null,
    options?: BuildProvisioningEnvOptions
  ): Promise<ProvisioningEnvResolution>;
  buildCrossProviderMemberArgs(
    primaryProviderId: TeamProviderId,
    memberSpecs: TeamCreateRequest['members'],
    options?: { teamRuntimeAuth?: TeamRuntimeAuthContext }
  ): Promise<CrossProviderMemberArgsResult>;
  resolveControlApiBaseUrl(): Promise<string | null>;
}

export async function resolveControlApiBaseUrlForProvisioning(
  deps: Pick<
    TeamProvisioningEnvRuntimePortsDeps,
    'getControlApiBaseUrlResolver' | 'logger' | 'processEnv'
  >
): Promise<string | null> {
  const resolver = deps.getControlApiBaseUrlResolver();
  if (!resolver) {
    return null;
  }

  try {
    const baseUrl = await resolver();
    if (!baseUrl) {
      throw new Error('Team control API resolver returned no base URL after startup.');
    }
    (deps.processEnv ?? process.env).CLAUDE_TEAM_CONTROL_URL = baseUrl;
    return baseUrl;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.error(`Failed to resolve team control API base URL: ${message}`);
    throw new Error(
      `Team control API failed to start or publish its base URL. Team runtime commands require the desktop Control API. ${message}`
    );
  }
}

export function createTeamProvisioningEnvRuntimePorts(
  deps: TeamProvisioningEnvRuntimePortsDeps
): TeamProvisioningEnvRuntimePorts {
  const runtimePorts: TeamProvisioningEnvRuntimePorts = {
    getProvisioningEnvBuilderPorts: () => ({
      providerConnectionService: deps.providerConnectionService,
      buildRuntimeTurnSettledEnvironment: (providerId) =>
        buildRuntimeTurnSettledEnvironment(
          { providerId },
          {
            environmentProvider: deps.getRuntimeTurnSettledEnvironmentProvider(),
            logger: deps.logger,
          }
        ),
      resolveControlApiBaseUrl: () => runtimePorts.resolveControlApiBaseUrl(),
      logger: deps.logger,
    }),
    buildProvisioningEnv: (
      providerId: TeamProviderId | undefined = 'anthropic',
      providerBackendId?: string | null,
      options?: BuildProvisioningEnvOptions
    ) =>
      buildProvisioningEnv({
        providerId,
        providerBackendId,
        options,
        ports: runtimePorts.getProvisioningEnvBuilderPorts(),
      }),
    buildCrossProviderMemberArgs: (primaryProviderId, memberSpecs, options) =>
      buildCrossProviderMemberArgs({
        primaryProviderId,
        memberSpecs,
        options,
        ports: {
          buildProvisioningEnv: (providerIdForEnv, providerBackendId, buildOptions) =>
            runtimePorts.buildProvisioningEnv(providerIdForEnv, providerBackendId, buildOptions),
          buildRuntimeTurnSettledHookSettingsArgs: (providerIdForArgs) =>
            buildRuntimeTurnSettledHookSettingsArgs(
              { providerId: providerIdForArgs },
              {
                hookSettingsProvider: deps.getRuntimeTurnSettledHookSettingsProvider(),
                logger: deps.logger,
              }
            ),
          logger: deps.logger,
        },
      }),
    resolveControlApiBaseUrl: () => resolveControlApiBaseUrlForProvisioning(deps),
  };

  return runtimePorts;
}
