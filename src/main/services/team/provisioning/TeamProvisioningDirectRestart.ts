import {
  AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV,
  ANTHROPIC_CONNECTION_MODES,
  ANTHROPIC_DIRECT_ROUTE_ENV_KEYS,
  ANTHROPIC_EXTERNAL_ROUTE_ENV_KEYS,
  type AnthropicConnectionMode,
} from '@shared/constants/anthropicConnectionMode';
import * as path from 'path';

import {
  ANTHROPIC_HELPER_MODE_COMPETING_AUTH_ENV_KEYS,
  CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH_ENV,
  CLAUDE_TEAM_ANTHROPIC_AUTH_MODE_API_KEY_HELPER,
  CLAUDE_TEAM_ANTHROPIC_AUTH_MODE_ENV,
} from '../../runtime/anthropicTeamApiKeyHelper';

import type { TeamProviderId } from '@shared/types';

const DIRECT_TMUX_RESTART_ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_TEAM_CONTROL_URL',
  'CLAUDE_TEAM_RUNTIME_SETTINGS_PATH',
  AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV,
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_ENTRY_PROVIDER',
  'CLAUDE_CODE_GEMINI_BACKEND',
  'CLAUDE_CODE_CODEX_BACKEND',
  'CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD',
  'CODEX_CLI_PATH',
  'CODEX_HOME',
  CLAUDE_TEAM_ANTHROPIC_AUTH_MODE_ENV,
  CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH_ENV,
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_AWS_WORKSPACE_ID',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'GEMINI_BASE_URL',
  'GEMINI_API_VERSION',
  'GEMINI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT_ID',
  'GCLOUD_PROJECT',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
] as const;

const DIRECT_TMUX_PROVIDER_SELECTION_ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_ENTRY_PROVIDER',
] as const;

const INTERACTIVE_SHELL_COMMANDS = new Set([
  'bash',
  'zsh',
  'sh',
  'fish',
  'nu',
  'pwsh',
  'powershell',
  'cmd',
  'cmd.exe',
]);

export function shellQuote(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function isInteractiveShellCommand(command: string | undefined): boolean {
  const normalized = command?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return INTERACTIVE_SHELL_COMMANDS.has(path.basename(normalized));
}

function getDirectRestartEntryProvider(providerId: TeamProviderId): string {
  return providerId === 'codex' || providerId === 'gemini' ? providerId : 'anthropic';
}

export function isAnthropicCompatibleBaseUrl(baseUrl?: string | null): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const url = new URL(trimmed);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      url.hostname !== 'api.anthropic.com' &&
      url.hostname !== 'api-staging.anthropic.com'
    );
  } catch {
    return false;
  }
}

export function hasAnthropicCompatibleAuthTokenEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    isAnthropicCompatibleBaseUrl(env.ANTHROPIC_BASE_URL) && env.ANTHROPIC_AUTH_TOKEN?.trim()
  );
}

function getAnthropicConnectionMode(env: NodeJS.ProcessEnv): AnthropicConnectionMode | null {
  const value = env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]?.trim();
  return ANTHROPIC_CONNECTION_MODES.includes(value as AnthropicConnectionMode)
    ? (value as AnthropicConnectionMode)
    : null;
}

function applyAnthropicRestartConnectionPolicy(
  assignments: Map<string, string>,
  env: NodeJS.ProcessEnv,
  providerId: TeamProviderId
): void {
  if (providerId !== 'anthropic') {
    return;
  }
  const connectionMode = getAnthropicConnectionMode(env);
  if (!connectionMode || connectionMode === 'auto') {
    return;
  }

  for (const key of ANTHROPIC_EXTERNAL_ROUTE_ENV_KEYS) {
    assignments.set(key, '');
  }
  if (connectionMode !== 'compatible') {
    for (const key of ANTHROPIC_DIRECT_ROUTE_ENV_KEYS) {
      assignments.set(key, '');
    }
  }
  if (connectionMode === 'subscription') {
    assignments.set('ANTHROPIC_API_KEY', '');
    assignments.set('ANTHROPIC_AUTH_TOKEN', '');
  } else if (connectionMode === 'api_key') {
    assignments.set('ANTHROPIC_AUTH_TOKEN', '');
    assignments.set('CLAUDE_CODE_OAUTH_TOKEN', '');
    assignments.set('CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', '');
  }
}

export function buildDirectTmuxRestartEnvAssignments(
  env: NodeJS.ProcessEnv,
  providerId: TeamProviderId
): string {
  const assignments = new Map<string, string>();
  assignments.set('CLAUDECODE', '1');
  assignments.set('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', '1');

  for (const key of DIRECT_TMUX_RESTART_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) {
      assignments.set(key, value);
    }
  }

  for (const key of DIRECT_TMUX_PROVIDER_SELECTION_ENV_KEYS) {
    assignments.set(key, '');
  }
  assignments.set('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', '1');
  assignments.set('CLAUDE_CODE_ENTRY_PROVIDER', getDirectRestartEntryProvider(providerId));
  if (providerId === 'anthropic') {
    if (hasAnthropicCompatibleAuthTokenEnv(env)) {
      assignments.set('ANTHROPIC_BASE_URL', env.ANTHROPIC_BASE_URL?.trim() ?? '');
      assignments.set('ANTHROPIC_AUTH_TOKEN', env.ANTHROPIC_AUTH_TOKEN?.trim() ?? '');
      if (!env.ANTHROPIC_API_KEY?.trim()) {
        assignments.set('ANTHROPIC_API_KEY', '');
      }
    } else if (!isAnthropicCompatibleBaseUrl(env.ANTHROPIC_BASE_URL)) {
      assignments.set('ANTHROPIC_AUTH_TOKEN', '');
    }
  }
  applyAnthropicRestartConnectionPolicy(assignments, env, providerId);
  if (
    providerId === 'anthropic' &&
    env[CLAUDE_TEAM_ANTHROPIC_AUTH_MODE_ENV] === CLAUDE_TEAM_ANTHROPIC_AUTH_MODE_API_KEY_HELPER
  ) {
    assignments.set(
      CLAUDE_TEAM_ANTHROPIC_AUTH_MODE_ENV,
      CLAUDE_TEAM_ANTHROPIC_AUTH_MODE_API_KEY_HELPER
    );
    const settingsPath = env[CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH_ENV];
    if (typeof settingsPath === 'string') {
      assignments.set(CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH_ENV, settingsPath);
    }
    for (const key of ANTHROPIC_HELPER_MODE_COMPETING_AUTH_ENV_KEYS) {
      assignments.set(key, '');
    }
  }

  return [...assignments.entries()].map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
}

export function buildDirectTmuxRestartCommand(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  providerId: TeamProviderId;
  binaryPath: string;
  args: string[];
}): string {
  const envAssignments = buildDirectTmuxRestartEnvAssignments(input.env, input.providerId);
  const command = [
    'cd',
    shellQuote(input.cwd),
    '&&',
    'env',
    envAssignments,
    shellQuote(input.binaryPath),
    ...input.args.map(shellQuote),
  ].join(' ');
  return `(${command}); __claude_teammate_exit=$?; printf '\\n__CLAUDE_TEAMMATE_EXIT__:%s\\n' "$__claude_teammate_exit"`;
}
