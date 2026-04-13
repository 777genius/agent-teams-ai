import { buildEnrichedEnv } from '@main/utils/cliEnv';
import { getCachedShellEnv, getShellPreferredHome } from '@main/utils/shellEnv';

import { configManager } from '../infrastructure/ConfigManager';

import { providerConnectionService } from './ProviderConnectionService';
import {
  applyConfiguredRuntimeBackendsEnv,
  applyProviderRuntimeEnv,
  resolveTeamProviderId,
} from './providerRuntimeEnv';

import type { CliProviderId, TeamProviderId } from '@shared/types';

type ProviderEnvTargetId = CliProviderId | TeamProviderId | undefined;

export interface ProviderAwareCliEnvOptions {
  binaryPath?: string | null;
  providerId?: ProviderEnvTargetId;
  shellEnv?: NodeJS.ProcessEnv | null;
  env?: NodeJS.ProcessEnv;
  connectionMode?: 'strict' | 'augment';
}

export interface ProviderAwareCliEnvResult {
  env: NodeJS.ProcessEnv;
  connectionIssues: Partial<Record<CliProviderId, string>>;
}

function getFirstNonEmptyEnvValue(...values: (string | null | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

export async function buildProviderAwareCliEnv(
  options: ProviderAwareCliEnvOptions = {}
): Promise<ProviderAwareCliEnvResult> {
  const connectionMode = options.connectionMode ?? 'strict';
  const shellEnv = options.shellEnv ?? getCachedShellEnv() ?? {};
  const env = {
    ...buildEnrichedEnv(options.binaryPath),
    ...shellEnv,
  };

  applyConfiguredRuntimeBackendsEnv(env, configManager.getConfig().runtime);

  Object.assign(env, options.env ?? {});

  const explicitHome = getFirstNonEmptyEnvValue(options.env?.HOME, options.env?.USERPROFILE);
  const fallbackHome = getFirstNonEmptyEnvValue(
    env.HOME,
    env.USERPROFILE,
    getShellPreferredHome(),
    shellEnv.HOME,
    process.env.HOME,
    process.env.USERPROFILE
  );

  if (explicitHome) {
    env.HOME = getFirstNonEmptyEnvValue(options.env?.HOME, explicitHome);
    env.USERPROFILE = getFirstNonEmptyEnvValue(options.env?.USERPROFILE, explicitHome);
  } else if (fallbackHome) {
    env.HOME = getFirstNonEmptyEnvValue(env.HOME, fallbackHome);
    env.USERPROFILE = getFirstNonEmptyEnvValue(env.USERPROFILE, fallbackHome);
  }

  if (options.providerId) {
    const resolvedProviderId = resolveTeamProviderId(options.providerId);
    applyProviderRuntimeEnv(env, options.providerId);
    if (connectionMode === 'augment') {
      await providerConnectionService.augmentConfiguredConnectionEnv(env, resolvedProviderId);
      return {
        env,
        connectionIssues: {},
      };
    }

    await providerConnectionService.applyConfiguredConnectionEnv(env, resolvedProviderId);

    return {
      env,
      connectionIssues: await providerConnectionService.getConfiguredConnectionIssues(env, [
        resolvedProviderId,
      ]),
    };
  }

  if (connectionMode === 'augment') {
    await providerConnectionService.augmentAllConfiguredConnectionEnv(env);
    return {
      env,
      connectionIssues: {},
    };
  }

  await providerConnectionService.applyAllConfiguredConnectionEnv(env);
  return {
    env,
    connectionIssues: await providerConnectionService.getConfiguredConnectionIssues(env),
  };
}
