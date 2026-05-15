import { ConfigManager } from '../infrastructure/ConfigManager';

import type { CliProviderId, TeamProviderId } from '@shared/types';

type RuntimeEnvProviderId = CliProviderId | TeamProviderId;

type AnthropicRuntimeBackendProviderId =
  | 'anthropic'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'claude-platform-aws';

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

function isTruthyEnvValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized && normalized !== '0' && normalized !== 'false' && normalized !== 'no');
}

function resolveAnthropicRuntimeBackendFromEnv(
  env: NodeJS.ProcessEnv
): AnthropicRuntimeBackendProviderId {
  if (isTruthyEnvValue(env.CLAUDE_CODE_USE_BEDROCK)) {
    return 'bedrock';
  }
  if (isTruthyEnvValue(env.CLAUDE_CODE_USE_VERTEX)) {
    return 'vertex';
  }
  if (isTruthyEnvValue(env.CLAUDE_CODE_USE_FOUNDRY)) {
    return 'foundry';
  }
  if (env.ANTHROPIC_AWS_WORKSPACE_ID?.trim()) {
    return 'claude-platform-aws';
  }
  return 'anthropic';
}

function applyAnthropicRuntimeBackendEnv(
  env: NodeJS.ProcessEnv,
  backend: AnthropicRuntimeBackendProviderId
): void {
  if (backend === 'bedrock') {
    env.CLAUDE_CODE_USE_BEDROCK = '1';
  } else if (backend === 'vertex') {
    env.CLAUDE_CODE_USE_VERTEX = '1';
  } else if (backend === 'foundry') {
    env.CLAUDE_CODE_USE_FOUNDRY = '1';
  }
}

export function applyProviderRuntimeEnv(
  env: NodeJS.ProcessEnv,
  providerId: RuntimeEnvProviderId | undefined
): NodeJS.ProcessEnv {
  const resolvedProvider = resolveRuntimeProviderId(providerId);
  const anthropicBackend =
    resolvedProvider === 'anthropic' ? resolveAnthropicRuntimeBackendFromEnv(env) : 'anthropic';

  for (const key of PROVIDER_ROUTING_ENV_KEYS) {
    env[key] = undefined;
  }

  // Provider overrides must be positive pins. In dev and multimodel desktop
  // flows the host process can already be routed to codex or gemini, and the
  // child runtime reapplies settings.env after trust. Mark the env as
  // host-managed and set the exact entry provider so anthropic teammates do not
  // silently fall back into the host's current routing world.
  env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
  env.CLAUDE_CODE_ENTRY_PROVIDER =
    resolvedProvider === 'anthropic' ? anthropicBackend : resolvedProvider;
  applyAnthropicRuntimeBackendEnv(env, anthropicBackend);

  return env;
}

export function resolveRuntimeProviderId(
  providerId: RuntimeEnvProviderId | undefined
): CliProviderId {
  if (
    providerId === 'codex' ||
    providerId === 'gemini' ||
    providerId === 'opencode' ||
    providerId === 'kilocode'
  ) {
    return providerId;
  }

  return 'anthropic';
}

export function resolveTeamProviderId(providerId: TeamProviderId | undefined): TeamProviderId {
  return providerId === 'codex' ||
    providerId === 'gemini' ||
    providerId === 'opencode' ||
    providerId === 'kilocode'
    ? providerId
    : 'anthropic';
}
