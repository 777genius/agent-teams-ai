import { ConfigManager } from '@main/services/infrastructure/ConfigManager';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';

import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';

import type { GeminiRuntimeAuthState } from '../../runtime/geminiRuntimeAuth';
import type { ProviderModelLaunchIdentity, TeamCreateRequest, TeamProviderId } from '@shared/types';

export interface PromptSizeSummary {
  chars: number;
  lines: number;
}

export interface RuntimeLaunchLogger {
  info(message: string): void;
}

export function getAnthropicFastModeDefault(): boolean {
  return (
    ConfigManager.getInstance().getConfig().providerConnections.anthropic.fastModeDefault === true
  );
}

export function getTeamProviderLabel(providerId: TeamProviderId): string {
  switch (providerId) {
    case 'opencode':
      return 'OpenCode';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'anthropic':
    default:
      return 'Anthropic';
  }
}

export function getConfiguredRuntimeBackend(providerId: TeamProviderId): string | null {
  const runtimeConfig = ConfigManager.getInstance().getConfig().runtime.providerBackends;
  switch (providerId) {
    case 'opencode':
      return null;
    case 'gemini':
      return runtimeConfig.gemini;
    case 'codex':
      return migrateProviderBackendId('codex', runtimeConfig.codex) ?? 'codex-native';
    case 'anthropic':
    default:
      return null;
  }
}

export function buildRuntimeLaunchWarning(
  request: Pick<
    TeamCreateRequest,
    'providerId' | 'providerBackendId' | 'model' | 'effort' | 'fastMode'
  >,
  env: NodeJS.ProcessEnv,
  options?: {
    geminiRuntimeAuth?: GeminiRuntimeAuthState | null;
    promptSize?: PromptSizeSummary | null;
    expectedMembersCount?: number;
  }
): string {
  const providerId = resolveTeamProviderId(request.providerId);
  const providerLabel = getTeamProviderLabel(providerId);
  const modelLabel = request.model?.trim() || 'default';
  const effortLabel = request.effort ?? 'default';
  const fastLabel =
    providerId === 'anthropic'
      ? `, fast ${request.fastMode ?? (getAnthropicFastModeDefault() ? 'inherit:on' : 'inherit:off')}`
      : providerId === 'codex'
        ? `, fast ${request.fastMode ?? 'inherit:off'}`
        : '';
  const backend =
    migrateProviderBackendId(providerId, request.providerBackendId?.trim()) ||
    getConfiguredRuntimeBackend(providerId);
  const flags: string[] = [];
  if (env.CLAUDE_CODE_USE_GEMINI === '1') flags.push('USE_GEMINI');
  if (env.CLAUDE_CODE_USE_OPENAI === '1') flags.push('USE_OPENAI');
  if (env.CLAUDE_CODE_ENTRY_PROVIDER) {
    flags.push(`ENTRY_PROVIDER=${env.CLAUDE_CODE_ENTRY_PROVIDER}`);
  }
  if (env.CLAUDE_CODE_GEMINI_BACKEND) {
    flags.push(`GEMINI_BACKEND=${env.CLAUDE_CODE_GEMINI_BACKEND}`);
  }
  if (env.CLAUDE_CODE_CODEX_BACKEND) {
    flags.push(`CODEX_BACKEND=${env.CLAUDE_CODE_CODEX_BACKEND}`);
  }
  if (env.CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES === '1') {
    flags.push('FORCE_PROCESS_TEAMMATES');
  }
  const backendPart = backend ? `, backend ${backend}` : '';
  const flagsPart = flags.length > 0 ? `, env ${flags.join(', ')}` : '';
  const geminiAuth = options?.geminiRuntimeAuth;
  const authPart =
    providerId === 'gemini' && geminiAuth
      ? `, auth ${geminiAuth.authMethod ?? 'none'}/${geminiAuth.resolvedBackend}`
      : '';
  const promptSize = options?.promptSize;
  const promptPart = promptSize
    ? `, prompt ${promptSize.chars.toLocaleString('en-US')} chars/${promptSize.lines} lines`
    : '';
  const membersPart =
    typeof options?.expectedMembersCount === 'number'
      ? `, members ${options.expectedMembersCount}`
      : '';
  return `Launch runtime: ${providerLabel} · ${modelLabel} · ${effortLabel}${fastLabel}${backendPart}${authPart}${promptPart}${membersPart}${flagsPart}`;
}

export function logRuntimeLaunchSnapshot(
  logger: RuntimeLaunchLogger,
  teamName: string,
  claudePath: string,
  args: string[],
  request: Pick<
    TeamCreateRequest,
    'providerId' | 'providerBackendId' | 'model' | 'effort' | 'fastMode'
  >,
  env: NodeJS.ProcessEnv,
  options?: {
    geminiRuntimeAuth?: GeminiRuntimeAuthState | null;
    promptSize?: PromptSizeSummary | null;
    expectedMembersCount?: number;
    launchIdentity?: ProviderModelLaunchIdentity | null;
  }
): void {
  const providerId = resolveTeamProviderId(request.providerId);
  const snapshot = {
    providerId,
    providerBackendId: migrateProviderBackendId(providerId, request.providerBackendId) ?? null,
    model: request.model ?? null,
    effort: request.effort ?? null,
    fastMode: request.fastMode ?? null,
    configuredBackend:
      migrateProviderBackendId(providerId, request.providerBackendId?.trim()) ||
      getConfiguredRuntimeBackend(providerId),
    promptSize: options?.promptSize ?? null,
    expectedMembersCount: options?.expectedMembersCount ?? null,
    launchIdentity: options?.launchIdentity ?? null,
    geminiRuntimeAuth:
      providerId === 'gemini'
        ? {
            authenticated: options?.geminiRuntimeAuth?.authenticated ?? null,
            authMethod: options?.geminiRuntimeAuth?.authMethod ?? null,
            resolvedBackend: options?.geminiRuntimeAuth?.resolvedBackend ?? null,
            projectId: options?.geminiRuntimeAuth?.projectId ?? null,
            statusMessage: options?.geminiRuntimeAuth?.statusMessage ?? null,
          }
        : null,
    env: {
      CLAUDE_CODE_USE_GEMINI: env.CLAUDE_CODE_USE_GEMINI ?? null,
      CLAUDE_CODE_USE_OPENAI: env.CLAUDE_CODE_USE_OPENAI ?? null,
      CLAUDE_CODE_ENTRY_PROVIDER: env.CLAUDE_CODE_ENTRY_PROVIDER ?? null,
      CLAUDE_CODE_GEMINI_BACKEND: env.CLAUDE_CODE_GEMINI_BACKEND ?? null,
      CLAUDE_CODE_CODEX_BACKEND: env.CLAUDE_CODE_CODEX_BACKEND ?? null,
      CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES: env.CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES ?? null,
      CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR ?? null,
      CLAUDE_TEAM_CONTROL_URL: env.CLAUDE_TEAM_CONTROL_URL ?? null,
    },
    args,
    claudePath,
  };
  logger.info(`[${teamName}] Launch runtime snapshot ${JSON.stringify(snapshot)}`);
}

export function getPromptSizeSummary(prompt: string): PromptSizeSummary {
  return {
    chars: prompt.length,
    lines: prompt.length === 0 ? 0 : prompt.split(/\r?\n/g).length,
  };
}
