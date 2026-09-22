import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV,
  ANTHROPIC_CONNECTION_MODES,
  ANTHROPIC_DIRECT_ROUTE_ENV_KEYS,
  ANTHROPIC_EXTERNAL_ROUTE_ENV_KEYS,
  type AnthropicConnectionMode,
} from '@shared/constants/anthropicConnectionMode';

import {
  ANTHROPIC_HELPER_MODE_COMPETING_AUTH_ENV_KEYS,
  CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH_ENV,
  CLAUDE_TEAM_ANTHROPIC_AUTH_MODE_API_KEY_HELPER,
  CLAUDE_TEAM_ANTHROPIC_AUTH_MODE_ENV,
} from '../../runtime/anthropicTeamApiKeyHelper';
import { resolveAnthropicRuntimeBackendFromEnv } from '../../runtime/providerRuntimeEnv';

import type { TeamProviderId } from '@shared/types';

const DIRECT_TMUX_RESTART_ENV_KEYS = [
  'PATH',
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

const ANTHROPIC_AUTO_PROVIDER_SELECTION_ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

const ANTHROPIC_AUTO_RESTART_ENV_KEYS = [
  ...ANTHROPIC_EXTERNAL_ROUTE_ENV_KEYS,
  ...ANTHROPIC_DIRECT_ROUTE_ENV_KEYS,
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT_ID',
  'GCLOUD_PROJECT',
] as const;

const INTERACTIVE_SHELL_COMMANDS = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh', 'mksh']);

export function shellQuote(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function isInteractiveShellCommand(
  command: string | undefined,
  platform: NodeJS.Platform = process.platform
): boolean {
  // The direct command uses POSIX paths and shell syntax. Windows tmux runs
  // inside WSL while cwd/binary paths are resolved by the desktop host, so the
  // normal orchestrator restart must own path translation on that platform.
  if (platform === 'win32') {
    return false;
  }
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
  const value = env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]?.trim().toLowerCase();
  return ANTHROPIC_CONNECTION_MODES.includes(value as AnthropicConnectionMode)
    ? (value as AnthropicConnectionMode)
    : null;
}

function applyAnthropicRestartConnectionPolicy(
  assignments: Map<string, string>,
  unsetKeys: Set<string>,
  env: NodeJS.ProcessEnv,
  providerId: TeamProviderId
): void {
  if (providerId !== 'anthropic') {
    return;
  }
  const connectionMode = getAnthropicConnectionMode(env);
  if (!connectionMode || connectionMode === 'auto') {
    const backend = resolveAnthropicRuntimeBackendFromEnv(env);
    assignments.set('CLAUDE_CODE_ENTRY_PROVIDER', backend);
    // Auto may be owned by ~/.claude/settings.json. Remove false selector pins
    // from the child environment instead of passing empty values, otherwise
    // Claude Desktop's spawn-env snapshot would block settings from restoring
    // Bedrock, Vertex, or Foundry after a direct pane restart.
    for (const key of ANTHROPIC_AUTO_PROVIDER_SELECTION_ENV_KEYS) {
      assignments.delete(key);
      unsetKeys.add(key);
    }
    if (backend === 'bedrock') {
      unsetKeys.delete('CLAUDE_CODE_USE_BEDROCK');
      assignments.set('CLAUDE_CODE_USE_BEDROCK', '1');
    } else if (backend === 'vertex') {
      unsetKeys.delete('CLAUDE_CODE_USE_VERTEX');
      assignments.set('CLAUDE_CODE_USE_VERTEX', '1');
    } else if (backend === 'foundry') {
      unsetKeys.delete('CLAUDE_CODE_USE_FOUNDRY');
      assignments.set('CLAUDE_CODE_USE_FOUNDRY', '1');
    }
    for (const key of ANTHROPIC_AUTO_RESTART_ENV_KEYS) {
      const value = env[key];
      if (typeof value === 'string' && value.length > 0 && !assignments.has(key)) {
        assignments.set(key, value);
      }
    }
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
  const unsetKeys = new Set<string>();
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
  applyAnthropicRestartConnectionPolicy(assignments, unsetKeys, env, providerId);
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

  return [
    ...[...unsetKeys].map((key) => `-u ${shellQuote(key)}`),
    ...[...assignments.entries()].map(([key, value]) => `${key}=${shellQuote(value)}`),
  ].join(' ');
}

interface DirectTmuxRestartCommandInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
  providerId: TeamProviderId;
  binaryPath: string;
  args: string[];
}

export function buildDirectTmuxRestartCommand(input: DirectTmuxRestartCommandInput): string {
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

export interface DirectTmuxRestartLauncher {
  command: string;
  scriptPath: string;
  cleanup: () => Promise<void>;
}

/**
 * Keeps credentials and long quoted arguments out of the interactive shell
 * history. The launcher script is private to the current user and unlinks
 * itself before the teammate process starts.
 */
export async function buildDirectTmuxRestartLauncher(
  input: DirectTmuxRestartCommandInput
): Promise<DirectTmuxRestartLauncher> {
  const scriptDir = await mkdtemp(path.join(tmpdir(), 'claude-team-direct-restart-'));
  const scriptPath = path.join(scriptDir, 'launch.sh');
  const launcherPath =
    input.env.PATH?.trim() ||
    process.env.PATH?.trim() ||
    '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  const cleanup = async (): Promise<void> => {
    await rm(scriptDir, { recursive: true, force: true });
  };
  const script = [
    '#!/bin/sh',
    `SCRIPT_PATH=${shellQuote(scriptPath)}`,
    `SCRIPT_DIR=${shellQuote(scriptDir)}`,
    `PATH=${shellQuote(launcherPath)}`,
    'export PATH',
    'cleanup_direct_restart_script() {',
    '  rm -f "$SCRIPT_PATH"',
    '  rmdir "$SCRIPT_DIR" 2>/dev/null || true',
    '}',
    'trap cleanup_direct_restart_script EXIT',
    'cleanup_direct_restart_script',
    buildDirectTmuxRestartCommand(input),
    '',
  ].join('\n');

  try {
    await writeFile(scriptPath, script, { mode: 0o700 });
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    command: `/bin/sh ${shellQuote(scriptPath)}`,
    scriptPath,
    cleanup,
  };
}
