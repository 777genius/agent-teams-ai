import path from 'node:path';

import { applyAgentTeamsIdentityEnv } from '@main/services/identity/AgentTeamsIdentityStore';
import { buildEnrichedEnv } from '@main/utils/cliEnv';
import { getShellPreferredHome } from '@main/utils/shellEnv';

import { configManager } from '../infrastructure/ConfigManager';

import { applyOpenCodeAutoUpdatePolicy } from './openCodeAutoUpdatePolicy';
import {
  applyConfiguredRuntimeBackendsEnv,
  applyProviderRuntimeEnv,
  resolveRuntimeProviderId,
} from './providerRuntimeEnv';

import type { CliProviderId, TeamProviderId } from '@shared/types';

type ProviderEnvTargetId = CliProviderId | TeamProviderId | undefined;

export interface BuildRuntimeBaseEnvOptions {
  binaryPath?: string | null;
  providerId?: ProviderEnvTargetId;
  providerBackendId?: string | null;
  shellEnv?: NodeJS.ProcessEnv | null;
  env?: NodeJS.ProcessEnv;
  mergePathFallbacks?: boolean;
}

function getFirstNonEmptyEnvValue(...values: (string | null | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function mergePathValues(...values: (string | null | undefined)[]): string | undefined {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const value of values) {
    for (const entry of value?.split(path.delimiter) ?? []) {
      const normalized = entry.trim();
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        merged.push(normalized);
      }
    }
  }
  return merged.length > 0 ? merged.join(path.delimiter) : undefined;
}

export function buildRuntimeBaseEnv(options: BuildRuntimeBaseEnvOptions = {}): {
  env: NodeJS.ProcessEnv;
  resolvedProviderId: CliProviderId | null;
} {
  const shellEnv = options.shellEnv ?? {};
  const enrichedEnv = buildEnrichedEnv(options.binaryPath);
  const mergedPath = options.mergePathFallbacks
    ? mergePathValues(options.env?.PATH, shellEnv.PATH, enrichedEnv.PATH, process.env.PATH)
    : undefined;
  const env = {
    ...enrichedEnv,
    ...shellEnv,
  };
  if (mergedPath) {
    env.PATH = mergedPath;
  }

  applyConfiguredRuntimeBackendsEnv(env, configManager.getConfig().runtime);
  Object.assign(env, options.env ?? {});
  if (mergedPath) {
    env.PATH = mergedPath;
  }
  applyAgentTeamsIdentityEnv(env);
  const policyAppliedEnv = applyOpenCodeAutoUpdatePolicy(env);
  if (policyAppliedEnv.OPENCODE_DISABLE_AUTOUPDATE === undefined) {
    delete env.OPENCODE_DISABLE_AUTOUPDATE;
  }
  Object.assign(env, policyAppliedEnv);

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

  const runtimeProviderId = resolveRuntimeProviderId(options.providerId);
  applyProviderRuntimeEnv(env, options.providerId);

  if (runtimeProviderId === 'codex' && options.providerBackendId?.trim()) {
    env.CLAUDE_CODE_CODEX_BACKEND = options.providerBackendId.trim();
  }

  if (runtimeProviderId === 'gemini' && options.providerBackendId?.trim()) {
    env.CLAUDE_CODE_GEMINI_BACKEND = options.providerBackendId.trim();
  }

  return {
    env,
    resolvedProviderId: runtimeProviderId,
  };
}
