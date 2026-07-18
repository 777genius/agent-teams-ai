import { prepareAgentChildProcessWritableEnv } from '@main/services/runtime/agentChildProcessPreflight';
import { buildProviderAwareCliEnv } from '@main/services/runtime/providerAwareCliEnv';
import { resolveTeamProviderId } from '@main/services/runtime/providerRuntimeEnv';
import {
  getAutoDetectedClaudeBasePath,
  getClaudeBasePath,
  getHomeDir,
} from '@main/utils/pathDecoder';
import { resolveInteractiveShellEnvBestEffort } from '@main/utils/shellEnv';
import {
  AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV,
  ANTHROPIC_DIRECT_ROUTE_ENV_KEYS,
  ANTHROPIC_EXTERNAL_ROUTE_ENV_KEYS,
} from '@shared/constants/anthropicConnectionMode';
import * as os from 'os';

import {
  ANTHROPIC_HELPER_MODE_COMPETING_AUTH_ENV_KEYS,
  type AnthropicTeamApiKeyHelperMaterial,
  cleanupAnthropicTeamApiKeyHelperMaterial,
  DISABLE_ANTHROPIC_TEAM_API_KEY_HELPER_ENV,
  materializeAnthropicTeamApiKeyHelper,
  verifyAnthropicTeamApiKeyHelperMaterial,
} from '../../runtime/anthropicTeamApiKeyHelper';
import {
  type GeminiRuntimeAuthState,
  resolveGeminiRuntimeAuth,
} from '../../runtime/geminiRuntimeAuth';

import { hasAnthropicCompatibleAuthTokenEnv } from './TeamProvisioningDirectRestart';
import { normalizeTeamMemberProviderId } from './TeamProvisioningMemberSpecs';
import {
  getConfiguredRuntimeBackend,
  getTeamProviderLabel,
} from './TeamProvisioningRuntimeDiagnostics';
import {
  filterOutSettingsPathArgs,
  normalizeTeamRuntimeNodeEnv,
} from './TeamProvisioningRuntimeLaunchSelection';

import type { TeamCreateRequest, TeamProviderId } from '@shared/types';

export type ProvisioningAuthSource =
  | 'anthropic_api_key_helper'
  | 'anthropic_api_key'
  | 'anthropic_auth_token'
  | 'configured_api_key_missing'
  | 'codex_runtime'
  | 'gemini_runtime'
  | 'none';

export interface TeamRuntimeAuthContext {
  teamName?: string;
  authMaterialId?: string;
  allowAnthropicApiKeyHelper?: boolean;
}

export interface ProvisioningEnvResolution {
  env: NodeJS.ProcessEnv;
  authSource: ProvisioningAuthSource;
  geminiRuntimeAuth: GeminiRuntimeAuthState | null;
  providerArgs?: string[];
  anthropicApiKeyHelper?: AnthropicTeamApiKeyHelperMaterial | null;
  warning?: string;
}

export interface CrossProviderMemberArgsResult {
  args: string[];
  providerArgsByProvider: Map<TeamProviderId, string[]>;
  envPatch: NodeJS.ProcessEnv;
  usesAnthropicApiKeyHelper: boolean;
  anthropicApiKeyHelper: AnthropicTeamApiKeyHelperMaterial | null;
}

interface TeamProvisioningProviderConnectionPort {
  augmentConfiguredConnectionEnv(
    env: NodeJS.ProcessEnv,
    providerId: 'codex',
    providerBackendId?: string | null
  ): Promise<NodeJS.ProcessEnv>;
  getConfiguredAnthropicApiKeyForTeamRuntime(env: NodeJS.ProcessEnv): Promise<string | null>;
}

interface TeamProvisioningEnvBuilderLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface TeamProvisioningEnvBuilderPorts {
  providerConnectionService: TeamProvisioningProviderConnectionPort;
  buildRuntimeTurnSettledEnvironment(providerId: TeamProviderId): Promise<NodeJS.ProcessEnv>;
  resolveControlApiBaseUrl(): Promise<string | null>;
  logger: TeamProvisioningEnvBuilderLogger;
  processEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  resolveInteractiveShellEnvBestEffort?: typeof resolveInteractiveShellEnvBestEffort;
  getHomeDir?: typeof getHomeDir;
  getClaudeBasePath?: typeof getClaudeBasePath;
  getAutoDetectedClaudeBasePath?: typeof getAutoDetectedClaudeBasePath;
  getOsUsername?: () => string;
  buildProviderAwareCliEnv?: typeof buildProviderAwareCliEnv;
  prepareAgentChildProcessWritableEnv?: typeof prepareAgentChildProcessWritableEnv;
  resolveGeminiRuntimeAuth?: typeof resolveGeminiRuntimeAuth;
  getConfiguredRuntimeBackend?: typeof getConfiguredRuntimeBackend;
  materializeAnthropicTeamApiKeyHelper?: typeof materializeAnthropicTeamApiKeyHelper;
  verifyAnthropicTeamApiKeyHelperMaterial?: typeof verifyAnthropicTeamApiKeyHelperMaterial;
  cleanupAnthropicTeamApiKeyHelperMaterial?: typeof cleanupAnthropicTeamApiKeyHelperMaterial;
}

export interface BuildProvisioningEnvOptions {
  includeCodexTeammateAuth?: boolean;
  teamRuntimeAuth?: TeamRuntimeAuthContext;
}

export interface BuildProvisioningEnvInput {
  providerId?: TeamProviderId;
  providerBackendId?: string | null;
  options?: BuildProvisioningEnvOptions;
  ports: TeamProvisioningEnvBuilderPorts;
}

export interface BuildCrossProviderMemberArgsInput {
  primaryProviderId: TeamProviderId;
  memberSpecs: TeamCreateRequest['members'];
  options?: { teamRuntimeAuth?: TeamRuntimeAuthContext };
  ports: {
    buildProvisioningEnv(
      providerId?: TeamProviderId,
      providerBackendId?: string | null,
      options?: BuildProvisioningEnvOptions
    ): Promise<ProvisioningEnvResolution>;
    buildRuntimeTurnSettledHookSettingsArgs(providerId: TeamProviderId): Promise<string[]>;
    logger: Pick<TeamProvisioningEnvBuilderLogger, 'error'>;
  };
}

export function isAnthropicApiKeyBackedAuthSource(authSource: unknown): boolean {
  return authSource === 'anthropic_api_key' || authSource === 'anthropic_api_key_helper';
}

export function isAnthropicDirectCredentialAuthSource(authSource: unknown): boolean {
  return isAnthropicApiKeyBackedAuthSource(authSource) || authSource === 'anthropic_auth_token';
}

function buildAnthropicCrossProviderDirectAuthEnvPatch(
  env: NodeJS.ProcessEnv,
  authSource: ProvisioningAuthSource
): NodeJS.ProcessEnv {
  const envPatch: NodeJS.ProcessEnv = {};
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) {
    envPatch.ANTHROPIC_API_KEY = apiKey;
  }
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim();
  if (baseUrl) {
    envPatch.ANTHROPIC_BASE_URL = baseUrl;
  }
  if (authSource === 'anthropic_auth_token' && hasAnthropicCompatibleAuthTokenEnv(env)) {
    envPatch.ANTHROPIC_API_KEY = apiKey || '';
    envPatch.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN?.trim();
    return envPatch;
  }
  for (const key of ANTHROPIC_HELPER_MODE_COMPETING_AUTH_ENV_KEYS) {
    if (key !== 'ANTHROPIC_API_KEY') {
      envPatch[key] = '';
    }
  }
  return envPatch;
}

const ANTHROPIC_AUTO_PROVIDER_SELECTION_ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

const ANTHROPIC_AUTO_CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT_ID',
  'GCLOUD_PROJECT',
] as const;

function copyDefinedEnvKeys(
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv,
  keys: readonly string[]
): void {
  for (const key of keys) {
    if (source[key] !== undefined) {
      target[key] = source[key];
    }
  }
}

function buildAnthropicCrossProviderConnectionEnvPatch(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const connectionMode = env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]?.trim();
  const envPatch: NodeJS.ProcessEnv = connectionMode
    ? { [AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]: connectionMode }
    : {};

  if (!connectionMode || connectionMode === 'auto') {
    copyDefinedEnvKeys(envPatch, env, ANTHROPIC_AUTO_PROVIDER_SELECTION_ENV_KEYS);
    copyDefinedEnvKeys(envPatch, env, ANTHROPIC_EXTERNAL_ROUTE_ENV_KEYS);
    copyDefinedEnvKeys(envPatch, env, ANTHROPIC_DIRECT_ROUTE_ENV_KEYS);
    copyDefinedEnvKeys(envPatch, env, ANTHROPIC_AUTO_CREDENTIAL_ENV_KEYS);
    return envPatch;
  }

  if (connectionMode === 'compatible') {
    envPatch.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL?.trim() ?? '';
    envPatch.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN?.trim() ?? '';
    envPatch.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY?.trim() ?? '';
    if (env.ANTHROPIC_CUSTOM_HEADERS !== undefined) {
      envPatch.ANTHROPIC_CUSTOM_HEADERS = env.ANTHROPIC_CUSTOM_HEADERS;
    }
  }

  return envPatch;
}

const CODEX_CROSS_PROVIDER_SAFE_ENV_KEYS = [
  'CLAUDE_CODE_CODEX_BACKEND',
  'CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD',
  'CODEX_CLI_PATH',
  'CODEX_HOME',
] as const;

function buildCodexCrossProviderSafeEnvPatch(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const envPatch: NodeJS.ProcessEnv = {};
  for (const key of CODEX_CROSS_PROVIDER_SAFE_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      envPatch[key] = value;
    }
  }
  return envPatch;
}

function getOsUsername(ports: TeamProvisioningEnvBuilderPorts): string {
  try {
    return ports.getOsUsername ? ports.getOsUsername() : os.userInfo().username;
  } catch {
    // os.userInfo() can throw SystemError in restricted environments (no passwd entry, Docker, etc.)
    return '';
  }
}

export async function buildProvisioningEnv({
  providerId = 'anthropic',
  providerBackendId,
  options,
  ports,
}: BuildProvisioningEnvInput): Promise<ProvisioningEnvResolution> {
  const processEnv = ports.processEnv ?? process.env;
  const platform = ports.platform ?? process.platform;
  const shellEnv = await (
    ports.resolveInteractiveShellEnvBestEffort ?? resolveInteractiveShellEnvBestEffort
  )({
    source: 'team-provisioning',
    timeoutMs: 1_500,
    fallbackEnv: processEnv,
    background: false,
  });
  // getHomeDir() uses Electron's app.getPath('home') which handles Unicode
  // correctly on Windows. Prefer it over process.env which may be garbled.
  const electronHome = (ports.getHomeDir ?? getHomeDir)();
  const isWindows = platform === 'win32';
  const home = shellEnv.HOME?.trim() || electronHome;
  const osUsername = getOsUsername(ports);
  const user =
    shellEnv.USER?.trim() ||
    processEnv.USER?.trim() ||
    processEnv.USERNAME?.trim() ||
    osUsername ||
    'unknown';

  // Shell: on Windows there is no SHELL env var; use COMSPEC (cmd.exe / powershell).
  // On Unix, prefer the user's login shell from env or fall back to /bin/zsh.
  const shell = isWindows
    ? (processEnv.COMSPEC ?? 'powershell.exe')
    : shellEnv.SHELL?.trim() || processEnv.SHELL?.trim() || '/bin/zsh';

  const resolvedClaudeBasePath = (ports.getClaudeBasePath ?? getClaudeBasePath)();
  const autoDetectedClaudeBasePath = (
    ports.getAutoDetectedClaudeBasePath ?? getAutoDetectedClaudeBasePath
  )();
  const env: NodeJS.ProcessEnv = {
    ...processEnv,
    ...shellEnv,
    HOME: home,
    USERPROFILE: home,
    USER: user,
    LOGNAME: shellEnv.LOGNAME?.trim() || processEnv.LOGNAME?.trim() || user,
    TERM: shellEnv.TERM?.trim() || processEnv.TERM?.trim() || 'xterm-256color',
    // Only set CLAUDE_CONFIG_DIR when the user configured a custom path.
    // Setting it to the default ~/.claude changes the macOS Keychain namespace
    // for OAuth credential lookup, causing auth failures. (See issue #27)
    ...(resolvedClaudeBasePath !== autoDetectedClaudeBasePath
      ? { CLAUDE_CONFIG_DIR: resolvedClaudeBasePath }
      : {}),
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  };
  normalizeTeamRuntimeNodeEnv(env);
  const resolvedProviderId = resolveTeamProviderId(providerId);
  const providerEnvResult = await (ports.buildProviderAwareCliEnv ?? buildProviderAwareCliEnv)({
    providerId,
    providerBackendId,
    shellEnv,
    env,
  });
  const providerConnectionIssue = providerEnvResult.connectionIssues[resolvedProviderId];
  const providerEnv = providerEnvResult.env;
  const writableEnvResult = await (
    ports.prepareAgentChildProcessWritableEnv ?? prepareAgentChildProcessWritableEnv
  )(providerEnv, { home });
  if (writableEnvResult.warning) {
    ports.logger.warn(`[TeamProvisioningService] ${writableEnvResult.warning}`);
  }
  if (options?.includeCodexTeammateAuth && resolvedProviderId !== 'codex') {
    await ports.providerConnectionService.augmentConfiguredConnectionEnv(
      providerEnv,
      'codex',
      (ports.getConfiguredRuntimeBackend ?? getConfiguredRuntimeBackend)('codex')
    );
  }
  Object.assign(providerEnv, await ports.buildRuntimeTurnSettledEnvironment(resolvedProviderId));

  const controlApiBaseUrl = await ports.resolveControlApiBaseUrl();
  if (controlApiBaseUrl) {
    providerEnv.CLAUDE_TEAM_CONTROL_URL = controlApiBaseUrl;
  }

  // SHELL is a Unix concept - only set it on non-Windows platforms.
  if (!isWindows) {
    providerEnv.SHELL = shell;
  }

  // XDG directories are a freedesktop.org (Linux/macOS) convention.
  // On Windows, these are unused by most tools and can cause confusion.
  if (!isWindows) {
    const xdgConfigHome =
      shellEnv.XDG_CONFIG_HOME?.trim() || processEnv.XDG_CONFIG_HOME?.trim() || `${home}/.config`;
    const xdgStateHome =
      shellEnv.XDG_STATE_HOME?.trim() ||
      processEnv.XDG_STATE_HOME?.trim() ||
      `${home}/.local/state`;
    providerEnv.XDG_CONFIG_HOME = xdgConfigHome;
    providerEnv.XDG_STATE_HOME = xdgStateHome;
  }

  if (providerConnectionIssue) {
    return {
      env: providerEnv,
      authSource: 'configured_api_key_missing',
      geminiRuntimeAuth: null,
      providerArgs: providerEnvResult.providerArgs,
      warning: providerConnectionIssue,
    };
  }

  if (resolvedProviderId === 'codex') {
    return {
      env: providerEnv,
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
      providerArgs: providerEnvResult.providerArgs,
    };
  }

  if (resolvedProviderId === 'gemini') {
    return {
      env: providerEnv,
      authSource: 'gemini_runtime',
      geminiRuntimeAuth: await (ports.resolveGeminiRuntimeAuth ?? resolveGeminiRuntimeAuth)(
        providerEnv
      ),
      providerArgs: providerEnvResult.providerArgs,
    };
  }

  const teamRuntimeAuth = options?.teamRuntimeAuth;
  const helperAllowed =
    resolvedProviderId === 'anthropic' &&
    teamRuntimeAuth?.allowAnthropicApiKeyHelper === true &&
    typeof teamRuntimeAuth.teamName === 'string' &&
    teamRuntimeAuth.teamName.trim().length > 0 &&
    typeof teamRuntimeAuth.authMaterialId === 'string' &&
    teamRuntimeAuth.authMaterialId.trim().length > 0 &&
    !isWindows &&
    processEnv[DISABLE_ANTHROPIC_TEAM_API_KEY_HELPER_ENV] !== '1';

  if (helperAllowed) {
    const apiKey =
      await ports.providerConnectionService.getConfiguredAnthropicApiKeyForTeamRuntime(providerEnv);
    if (apiKey) {
      const helper = await (
        ports.materializeAnthropicTeamApiKeyHelper ?? materializeAnthropicTeamApiKeyHelper
      )({
        teamName: teamRuntimeAuth.teamName!,
        authMaterialId: teamRuntimeAuth.authMaterialId!,
        apiKey,
        baseClaudeDir: resolvedClaudeBasePath,
      });
      try {
        await (
          ports.verifyAnthropicTeamApiKeyHelperMaterial ?? verifyAnthropicTeamApiKeyHelperMaterial
        )({
          helperPath: helper.helperPath,
          expectedApiKey: apiKey,
        });
      } catch (error) {
        await (
          ports.cleanupAnthropicTeamApiKeyHelperMaterial ?? cleanupAnthropicTeamApiKeyHelperMaterial
        )({
          directory: helper.directory,
        });
        throw error;
      }

      for (const key of ANTHROPIC_HELPER_MODE_COMPETING_AUTH_ENV_KEYS) {
        delete providerEnv[key];
      }
      Object.assign(providerEnv, helper.envPatch);

      return {
        env: providerEnv,
        authSource: 'anthropic_api_key_helper',
        geminiRuntimeAuth: null,
        providerArgs: [...(providerEnvResult.providerArgs ?? []), ...helper.settingsArgs],
        anthropicApiKeyHelper: helper,
      };
    }
  }

  // 1. Explicit ANTHROPIC_API_KEY - works with `-p` mode directly
  if (
    typeof providerEnv.ANTHROPIC_API_KEY === 'string' &&
    providerEnv.ANTHROPIC_API_KEY.trim().length > 0
  ) {
    return {
      env: providerEnv,
      authSource: 'anthropic_api_key',
      geminiRuntimeAuth: null,
      providerArgs: providerEnvResult.providerArgs,
    };
  }

  // 2. Anthropic-compatible runtimes (Ollama/LM Studio/gateways) expect a bearer
  //    token and often require ANTHROPIC_API_KEY to stay empty.
  if (hasAnthropicCompatibleAuthTokenEnv(providerEnv)) {
    return {
      env: providerEnv,
      authSource: 'anthropic_auth_token',
      geminiRuntimeAuth: null,
      providerArgs: providerEnvResult.providerArgs,
    };
  }

  // 3. Proxy token (ANTHROPIC_AUTH_TOKEN) - `-p` mode does NOT read this var,
  //    so we must copy it into ANTHROPIC_API_KEY for it to work.
  if (
    typeof providerEnv.ANTHROPIC_AUTH_TOKEN === 'string' &&
    providerEnv.ANTHROPIC_AUTH_TOKEN.trim().length > 0
  ) {
    providerEnv.ANTHROPIC_API_KEY = providerEnv.ANTHROPIC_AUTH_TOKEN;
    return {
      env: providerEnv,
      authSource: 'anthropic_auth_token',
      geminiRuntimeAuth: null,
      providerArgs: providerEnvResult.providerArgs,
    };
  }

  // 4. No explicit API key - let the CLI handle its own OAuth auth.
  //    Claude CLI reads credentials from its own storage and refreshes
  //    tokens in-memory. Injecting CLAUDE_CODE_OAUTH_TOKEN from the
  //    credentials file causes 401 errors because the stored token is
  //    often stale (CLI refreshes in-memory but rarely writes back).
  return {
    env: providerEnv,
    authSource: 'none',
    geminiRuntimeAuth: null,
    providerArgs: providerEnvResult.providerArgs,
  };
}

export async function buildCrossProviderMemberArgs({
  primaryProviderId,
  memberSpecs,
  options,
  ports,
}: BuildCrossProviderMemberArgsInput): Promise<CrossProviderMemberArgsResult> {
  const crossProviderIds = new Set<TeamProviderId>();
  for (const member of memberSpecs) {
    const memberId = resolveTeamProviderId(
      normalizeTeamMemberProviderId(member.providerId) ?? primaryProviderId
    );
    if (memberId !== primaryProviderId) {
      crossProviderIds.add(memberId);
    }
  }
  const args: string[] = [];
  const providerArgsByProvider = new Map<TeamProviderId, string[]>();
  const envPatch: NodeJS.ProcessEnv = {};
  let usesAnthropicApiKeyHelper = false;
  let anthropicApiKeyHelper: AnthropicTeamApiKeyHelperMaterial | null = null;
  const providersToPrepare = new Set(crossProviderIds);
  const prepareAnthropicForDynamicSpawn =
    primaryProviderId !== 'anthropic' && !crossProviderIds.has('anthropic');
  if (prepareAnthropicForDynamicSpawn) {
    providersToPrepare.add('anthropic');
  }

  try {
    for (const providerId of providersToPrepare) {
      const dynamicSpawnOnly = providerId === 'anthropic' && prepareAnthropicForDynamicSpawn;
      let env: ProvisioningEnvResolution;
      try {
        env = await ports.buildProvisioningEnv(providerId, undefined, {
          teamRuntimeAuth: options?.teamRuntimeAuth,
        });
      } catch (error) {
        ports.logger.error(
          `[TeamProvisioningService] Failed to build cross-provider args for provider "${providerId}"`,
          error
        );
        // Best-effort: don't block launch if cross-provider env resolution fails
        // before the provider can report a concrete auth/readiness issue.
        continue;
      }
      if (env.warning) {
        if (dynamicSpawnOnly) {
          ports.logger.error(
            `[TeamProvisioningService] Dynamic Anthropic spawn auth was not pre-materialized: ${env.warning}`
          );
          continue;
        }
        throw new Error(`${getTeamProviderLabel(providerId)}: ${env.warning}`);
      }
      if (!dynamicSpawnOnly) {
        args.push(...(await ports.buildRuntimeTurnSettledHookSettingsArgs(providerId)));
      }
      const providerArgs = env.providerArgs ?? [];
      if (!dynamicSpawnOnly) {
        providerArgsByProvider.set(providerId, providerArgs);
      }
      if (providerId === 'codex') {
        Object.assign(envPatch, buildCodexCrossProviderSafeEnvPatch(env.env));
      }
      if (providerId === 'anthropic') {
        Object.assign(envPatch, buildAnthropicCrossProviderConnectionEnvPatch(env.env));
      }
      if (env.anthropicApiKeyHelper) {
        usesAnthropicApiKeyHelper = true;
        anthropicApiKeyHelper = env.anthropicApiKeyHelper;
        Object.assign(envPatch, env.anthropicApiKeyHelper.envPatch);
      } else if (
        providerId === 'anthropic' &&
        isAnthropicDirectCredentialAuthSource(env.authSource)
      ) {
        Object.assign(
          envPatch,
          buildAnthropicCrossProviderDirectAuthEnvPatch(env.env, env.authSource)
        );
      }
      if (!dynamicSpawnOnly) {
        const flattenedArgs =
          providerId === 'anthropic' && env.anthropicApiKeyHelper
            ? filterOutSettingsPathArgs(providerArgs, env.anthropicApiKeyHelper.settingsPath)
            : providerArgs;
        if (flattenedArgs.length > 0) {
          args.push(...flattenedArgs);
        }
      }
    }
    return {
      args,
      providerArgsByProvider,
      envPatch,
      usesAnthropicApiKeyHelper,
      anthropicApiKeyHelper,
    };
  } catch (error) {
    if (anthropicApiKeyHelper) {
      await cleanupAnthropicTeamApiKeyHelperMaterial({
        directory: anthropicApiKeyHelper.directory,
      }).catch(() => undefined);
    }
    throw error;
  }
}
