import { buildEnrichedEnv } from '@main/utils/cliEnv';
import { getShellPreferredHome } from '@main/utils/shellEnv';

import { configManager } from '../infrastructure/ConfigManager';

import {
  applyConfiguredRuntimeBackendsEnv,
  applyProviderRuntimeEnv,
  resolveTeamProviderId,
} from './providerRuntimeEnv';

import type { CliProviderId, TeamProviderId } from '@shared/types';

type ProviderEnvTargetId = CliProviderId | TeamProviderId | undefined;

export interface BuildRuntimeBaseEnvOptions {
  binaryPath?: string | null;
  providerId?: ProviderEnvTargetId;
  providerBackendId?: string | null;
  shellEnv?: NodeJS.ProcessEnv | null;
  env?: NodeJS.ProcessEnv;
}

function getFirstNonEmptyEnvValue(...values: (string | null | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

export function buildRuntimeBaseEnv(options: BuildRuntimeBaseEnvOptions = {}): {
  env: NodeJS.ProcessEnv;
  resolvedProviderId: CliProviderId | null;
} {
  const shellEnv = options.shellEnv ?? {};
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

  if (!options.providerId) {
    return {
      env,
      resolvedProviderId: null,
    };
  }

  const resolvedProviderId = resolveTeamProviderId(options.providerId);
  applyProviderRuntimeEnv(env, options.providerId);

  if (resolvedProviderId === 'codex' && options.providerBackendId?.trim()) {
    env.CLAUDE_CODE_CODEX_BACKEND = options.providerBackendId.trim();
  }

  if (resolvedProviderId === 'gemini' && options.providerBackendId?.trim()) {
    env.CLAUDE_CODE_GEMINI_BACKEND = options.providerBackendId.trim();
  }

  return {
    env,
    resolvedProviderId,
  };
}
