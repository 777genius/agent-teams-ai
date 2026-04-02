import type { TeamProviderId } from '@shared/types';

const THIRD_PARTY_PROVIDER_ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
] as const;

export function applyProviderRuntimeEnv(
  env: NodeJS.ProcessEnv,
  providerId: TeamProviderId | undefined
): NodeJS.ProcessEnv {
  const resolvedProvider: TeamProviderId =
    providerId === 'codex' || providerId === 'gemini' ? providerId : 'anthropic';

  for (const key of THIRD_PARTY_PROVIDER_ENV_KEYS) {
    env[key] = undefined;
  }

  if (resolvedProvider === 'codex') {
    env.CLAUDE_CODE_USE_OPENAI = '1';
  } else if (resolvedProvider === 'gemini') {
    env.CLAUDE_CODE_USE_GEMINI = '1';
  }

  return env;
}

export function resolveTeamProviderId(providerId: TeamProviderId | undefined): TeamProviderId {
  return providerId === 'codex' || providerId === 'gemini' ? providerId : 'anthropic';
}
