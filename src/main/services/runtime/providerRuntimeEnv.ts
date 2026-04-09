import type { TeamProviderId } from '@shared/types';

import { ConfigManager } from '../infrastructure/ConfigManager';

const PROVIDER_ROUTING_ENV_KEYS = [
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_ENTRY_PROVIDER',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
] as const;

const BACKEND_SELECTION_ENV_KEYS = [
  'CLAUDE_CODE_GEMINI_BACKEND',
  'CLAUDE_CODE_CODEX_BACKEND',
] as const;

export function applyConfiguredRuntimeBackendsEnv(
  env: NodeJS.ProcessEnv,
  runtimeConfig = ConfigManager.getInstance().getConfig().runtime
): NodeJS.ProcessEnv {
  for (const key of BACKEND_SELECTION_ENV_KEYS) {
    env[key] = undefined;
  }

  env.CLAUDE_CODE_GEMINI_BACKEND = runtimeConfig.providerBackends.gemini;
  env.CLAUDE_CODE_CODEX_BACKEND = runtimeConfig.providerBackends.codex;
  return env;
}

export function applyProviderRuntimeEnv(
  env: NodeJS.ProcessEnv,
  providerId: TeamProviderId | undefined
): NodeJS.ProcessEnv {
  const resolvedProvider: TeamProviderId =
    providerId === 'codex' || providerId === 'gemini' ? providerId : 'anthropic';

  for (const key of PROVIDER_ROUTING_ENV_KEYS) {
    env[key] = undefined;
  }

  // Provider overrides must be positive pins. In dev and multimodel desktop
  // flows the host process can already be routed to codex or gemini, and the
  // child runtime reapplies settings.env after trust. Mark the env as
  // host-managed and set the exact entry provider so anthropic teammates do not
  // silently fall back into the host's current routing world.
  env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
  env.CLAUDE_CODE_ENTRY_PROVIDER = resolvedProvider;

  return env;
}

export function resolveTeamProviderId(providerId: TeamProviderId | undefined): TeamProviderId {
  return providerId === 'codex' || providerId === 'gemini' ? providerId : 'anthropic';
}
