import crypto from 'node:crypto';

import { evaluateCodexLaunchReadiness } from '@features/codex-account';
import { execCli } from '@main/utils/childProcess';
import { getCachedShellEnv } from '@main/utils/shellEnv';
import {
  isDynamicCodexModelCatalog,
  isUsableCodexModelCatalog,
} from '@shared/utils/codexModelCatalog';

import { ApiKeyService } from '../extensions/apikeys/ApiKeyService';
import { ConfigManager } from '../infrastructure/ConfigManager';

import { readClaudeUserAnthropicSettingsAuthEnv } from './claudeUserSettingsEnv';
import { isCodexExecBinary } from './codexCliBinary';

import type {
  AnthropicCompatibleEndpointConfig,
  CodexCustomProviderConfig,
} from '../infrastructure/ConfigManager';
import type {
  CodexAccountAuthMode,
  CodexAccountSnapshotDto,
} from '@features/codex-account/contracts';
import type { CodexAccountFeatureFacade } from '@features/codex-account/main';
import type { CodexModelCatalogDto } from '@features/codex-model-catalog';
import type {
  CodexModelCatalogFeatureFacade,
  CodexModelCatalogRequest,
} from '@features/codex-model-catalog/main';
import type {
  CliProviderAuthMode,
  CliProviderConnectionInfo,
  CliProviderId,
  CliProviderModelCatalog,
  CliProviderReasoningEffort,
  CliProviderStatus,
} from '@shared/types';

type ExternalCredential = {
  label: string;
  value: string;
} | null;

interface StoredApiKeyAccessOptions {
  allowStoredApiKeyDecryption?: boolean;
  allowedStoredApiKeyEnvVarNames?: readonly string[];
  allowClaudeUserSettingsAuthEnv?: boolean;
}

interface CodexLaunchSnapshotRefreshOptions {
  refreshRuntimeMissing?: boolean;
  refreshBlockedLaunch?: boolean;
}

const PROVIDER_CAPABILITIES: Record<
  CliProviderId,
  Pick<CliProviderConnectionInfo, 'supportsOAuth' | 'supportsApiKey' | 'configurableAuthModes'>
> = {
  anthropic: {
    supportsOAuth: true,
    supportsApiKey: true,
    configurableAuthModes: ['auto', 'oauth', 'api_key'],
  },
  codex: {
    supportsOAuth: false,
    supportsApiKey: true,
    configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
  },
  gemini: {
    supportsOAuth: false,
    supportsApiKey: true,
    configurableAuthModes: [],
  },
  opencode: {
    supportsOAuth: false,
    supportsApiKey: false,
    configurableAuthModes: [],
  },
};

const PROVIDER_API_KEY_ENV_VARS: Partial<Record<CliProviderId, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

const ANTHROPIC_BASE_URL_ENV_VAR = 'ANTHROPIC_BASE_URL';
const ANTHROPIC_AUTH_TOKEN_ENV_VAR = 'ANTHROPIC_AUTH_TOKEN';
const CODEX_NATIVE_API_KEY_ENV_VAR = 'CODEX_API_KEY';
const CODEX_CLI_PATH_ENV_VAR = 'CODEX_CLI_PATH';
const CODEX_HOME_ENV_VAR = 'CODEX_HOME';
const CODEX_FORCED_LOGIN_METHOD_ENV_VAR = 'CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD';
const CODEX_CUSTOM_PROVIDER_ID = 'agent_teams_custom';
const CODEX_CUSTOM_PROVIDER_NAME = 'Agent Teams Custom';
const CODEX_CUSTOM_PROVIDER_SETTINGS_KEY = 'agent_teams_custom_provider';
const CODEX_LAUNCH_CONFIG_SETTINGS_KEY = 'agent_teams_launch_config';
const CODEX_NATIVE_BACKEND_ID = 'codex-native';
const CODEX_LOGIN_STATUS_TIMEOUT_MS = 5_000;
const CODEX_LOGIN_STATUS_CONFIG_OVERRIDES = ['service_tier="fast"'] as const;
const ANTHROPIC_API_KEY_VERIFY_TIMEOUT_MS = 10_000;
const ANTHROPIC_API_KEY_VERIFY_CACHE_TTL_MS = 60_000;
const ANTHROPIC_DEFAULT_API_BASE_URL = 'https://api.anthropic.com';
const FIRST_PARTY_ANTHROPIC_HOSTS = new Set(['api.anthropic.com', 'api-staging.anthropic.com']);

type CodexCliLoginStatus = 'logged_in' | 'not_logged_in' | 'unknown';

interface CodexCliLoginStatusCheckResult {
  status: CodexCliLoginStatus;
  detail: string | null;
}

type CodexCliLoginStatusChecker = (params: {
  binaryPath: string | null;
  env: NodeJS.ProcessEnv;
}) => Promise<CodexCliLoginStatusCheckResult>;

type AnthropicApiKeyVerificationState = 'valid' | 'invalid' | 'unknown';

interface AnthropicApiKeyVerificationResult {
  state: AnthropicApiKeyVerificationState;
  status?: number | null;
  errorType?: string | null;
  errorMessage?: string | null;
}

type AnthropicApiKeyVerifier = (
  apiKey: string,
  baseUrl?: string | null
) => Promise<AnthropicApiKeyVerificationResult>;

type CodexAccountSnapshotReader = Pick<CodexAccountFeatureFacade, 'getSnapshot'> & {
  refreshSnapshot?: CodexAccountFeatureFacade['refreshSnapshot'];
};

interface ProviderStatusEnrichmentOptions {
  hydrateModelCatalog?: boolean;
}

function hashCredentialForCache(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeAnthropicApiKeyVerificationMessage(
  result: AnthropicApiKeyVerificationResult
): string {
  if (result.errorMessage?.trim()) {
    return result.errorMessage.trim();
  }

  if (result.errorType?.trim()) {
    return result.errorType.trim();
  }

  if (typeof result.status === 'number') {
    return `HTTP ${result.status}`;
  }

  return 'unknown verification error';
}

function buildAnthropicModelsUrl(baseUrl?: string | null): string {
  const url = new URL(baseUrl?.trim() || ANTHROPIC_DEFAULT_API_BASE_URL);
  let pathname = url.pathname;
  while (pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  if (pathname.endsWith('/v1/models')) {
    url.pathname = pathname;
  } else if (pathname.endsWith('/v1')) {
    url.pathname = `${pathname}/models`;
  } else {
    url.pathname = `${pathname}/v1/models`;
  }
  url.search = '';
  return url.toString();
}

function isAnthropicCompatibleBaseUrl(baseUrl?: string | null): boolean {
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
      !FIRST_PARTY_ANTHROPIC_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}

function hasAnthropicCompatibleAuthEnv(env: NodeJS.ProcessEnv): boolean {
  if (!isAnthropicCompatibleBaseUrl(env.ANTHROPIC_BASE_URL)) {
    return false;
  }

  return Boolean(env.ANTHROPIC_AUTH_TOKEN?.trim() || env.ANTHROPIC_API_KEY?.trim());
}

function hasExplicitAnthropicCredentialEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.ANTHROPIC_BASE_URL?.trim() ||
    env.ANTHROPIC_AUTH_TOKEN?.trim() ||
    env.ANTHROPIC_API_KEY?.trim()
  );
}

function isUsableAnthropicCompatibleEndpoint(
  endpoint: AnthropicCompatibleEndpointConfig | undefined
): endpoint is AnthropicCompatibleEndpointConfig {
  if (endpoint?.enabled !== true || !endpoint.baseUrl.trim()) {
    return false;
  }

  try {
    const url = new URL(endpoint.baseUrl.trim());
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      isAnthropicCompatibleBaseUrl(endpoint.baseUrl)
    );
  } catch {
    return false;
  }
}

async function verifyAnthropicApiKeyWithApi(
  apiKey: string,
  baseUrl?: string | null
): Promise<AnthropicApiKeyVerificationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANTHROPIC_API_KEY_VERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(buildAnthropicModelsUrl(baseUrl), {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
    const text = await response.text();
    let body: { error?: { type?: string; message?: string } } | null = null;
    try {
      body = text ? (JSON.parse(text) as { error?: { type?: string; message?: string } }) : null;
    } catch {
      body = null;
    }

    if (response.ok) {
      return { state: 'valid', status: response.status };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        state: 'invalid',
        status: response.status,
        errorType: body?.error?.type ?? null,
        errorMessage: body?.error?.message ?? null,
      };
    }

    return {
      state: 'unknown',
      status: response.status,
      errorType: body?.error?.type ?? null,
      errorMessage: body?.error?.message ?? null,
    };
  } catch (error) {
    return {
      state: 'unknown',
      status: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function buildCodexCustomProviderConfigOverrides(config: CodexCustomProviderConfig): string[] {
  return [
    `model_provider=${tomlString(CODEX_CUSTOM_PROVIDER_ID)}`,
    `model_providers.${CODEX_CUSTOM_PROVIDER_ID}.name=${tomlString(CODEX_CUSTOM_PROVIDER_NAME)}`,
    `model_providers.${CODEX_CUSTOM_PROVIDER_ID}.base_url=${tomlString(config.baseUrl.trim())}`,
    `model_providers.${CODEX_CUSTOM_PROVIDER_ID}.wire_api="responses"`,
    `model_providers.${CODEX_CUSTOM_PROVIDER_ID}.env_key=${tomlString(CODEX_NATIVE_API_KEY_ENV_VAR)}`,
  ];
}

function buildCodexLaunchArgs(
  binaryPath: string | null | undefined,
  loginMethod: 'chatgpt' | 'api',
  options: {
    customProviderConfigOverrides?: readonly string[];
    cliConfigOverrides?: readonly string[];
  } = {}
): string[] {
  const customProviderConfigOverrides = options.customProviderConfigOverrides ?? [];
  const cliConfigOverrides = [...(options.cliConfigOverrides ?? [])];
  if (isCodexExecBinary(binaryPath)) {
    return [
      '-c',
      `forced_login_method="${loginMethod}"`,
      ...customProviderConfigOverrides.flatMap((override) => ['-c', override]),
      ...cliConfigOverrides.flatMap((override) => ['-c', override]),
    ];
  }

  const codexSettings: Record<string, unknown> = { forced_login_method: loginMethod };
  if (customProviderConfigOverrides.length > 0) {
    codexSettings[CODEX_CUSTOM_PROVIDER_SETTINGS_KEY] = {
      config_overrides: [...customProviderConfigOverrides],
    };
  }
  if (cliConfigOverrides.length > 0) {
    codexSettings[CODEX_LAUNCH_CONFIG_SETTINGS_KEY] = {
      config_overrides: [...cliConfigOverrides],
    };
  }

  return ['--settings', JSON.stringify({ codex: codexSettings })];
}

function buildCodexForcedLoginLaunchArgs(
  binaryPath: string | null | undefined,
  loginMethod: 'chatgpt' | 'api',
  cliConfigOverrides: readonly string[] = []
): string[] {
  return buildCodexLaunchArgs(binaryPath, loginMethod, { cliConfigOverrides });
}

function isCodexCustomProviderBaseUrlUsable(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const url = new URL(trimmed);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isCodexCustomProviderModelUsable(model: string): boolean {
  const trimmed = model.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    return false;
  }

  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return false;
    }
  }

  return true;
}

function createCodexCustomProviderCatalog(
  config: CodexCustomProviderConfig
): CliProviderModelCatalog {
  const model = config.model.trim();
  const now = new Date();
  const staleAt = new Date(now.getTime() + 10 * 60_000);
  return {
    schemaVersion: 1,
    providerId: 'codex',
    source: 'static-fallback',
    status: 'ready',
    fetchedAt: now.toISOString(),
    staleAt: staleAt.toISOString(),
    defaultModelId: model,
    defaultLaunchModel: model,
    models: [
      {
        id: model,
        launchModel: model,
        displayName: model,
        hidden: false,
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium',
        supportsFastMode: false,
        inputModalities: ['text'],
        supportsPersonality: false,
        isDefault: true,
        upgrade: false,
        source: 'static-fallback',
        badgeLabel: 'custom',
        statusMessage: `Custom endpoint: ${config.baseUrl.trim()}`,
      },
    ],
    diagnostics: {
      configReadState: 'skipped',
      appServerState: 'healthy',
      message:
        'Using app-managed Codex custom provider profile. Runtime support is verified during launch or model probe.',
      code: 'agent-teams-custom-provider',
    },
  };
}

function applyCodexRuntimeContextEnv(
  env: NodeJS.ProcessEnv,
  snapshot: CodexAccountSnapshotDto
): void {
  const binaryPath = snapshot.runtimeContext?.binaryPath?.trim();
  if (binaryPath) {
    env[CODEX_CLI_PATH_ENV_VAR] = binaryPath;
  }

  const codexHome = snapshot.runtimeContext?.codexHome?.trim();
  if (codexHome) {
    env[CODEX_HOME_ENV_VAR] = codexHome;
  }
}

function applyCodexForcedLoginMethodEnv(
  env: NodeJS.ProcessEnv,
  loginMethod: 'chatgpt' | 'api' | null
): void {
  if (loginMethod) {
    env[CODEX_FORCED_LOGIN_METHOD_ENV_VAR] = loginMethod;
    return;
  }

  delete env[CODEX_FORCED_LOGIN_METHOD_ENV_VAR];
}

function sanitizeCodexLoginStatusDetail(detail: string): string {
  return detail
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted-api-key]')
    .replace(
      /"?(access_token|refresh_token|id_token)"?\s*[:=]\s*"?[^"\s,}]+/gi,
      '$1=[redacted-token]'
    )
    .trim()
    .slice(0, 500);
}

async function checkCodexCliLoginStatus({
  binaryPath,
  env,
}: {
  binaryPath: string | null;
  env: NodeJS.ProcessEnv;
}): Promise<CodexCliLoginStatusCheckResult> {
  const executable = binaryPath?.trim() || 'codex';
  const args = [
    ...buildCodexForcedLoginLaunchArgs(executable, 'chatgpt', CODEX_LOGIN_STATUS_CONFIG_OVERRIDES),
    'login',
    'status',
  ];

  try {
    const result = await execCli(executable, args, {
      env,
      timeout: CODEX_LOGIN_STATUS_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 128 * 1024,
    });
    const detail = sanitizeCodexLoginStatusDetail(`${result.stdout}\n${result.stderr}`);
    return { status: 'logged_in', detail: detail || null };
  } catch (error) {
    const stdout =
      error && typeof error === 'object' && 'stdout' in error
        ? String((error as { stdout?: unknown }).stdout ?? '')
        : '';
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr ?? '')
        : '';
    const detail = sanitizeCodexLoginStatusDetail(`${stdout}\n${stderr}`);

    if (/not logged in/i.test(detail)) {
      return { status: 'not_logged_in', detail: detail || null };
    }

    const fallback = error instanceof Error ? sanitizeCodexLoginStatusDetail(error.message) : null;
    return { status: 'unknown', detail: detail || fallback || null };
  }
}

export class ProviderConnectionService {
  private static instance: ProviderConnectionService | null = null;
  private codexAccountFeature: CodexAccountSnapshotReader | null = null;
  private codexModelCatalogFeature: Pick<CodexModelCatalogFeatureFacade, 'getCatalog'> | null =
    null;
  private readonly anthropicApiKeyVerificationCache = new Map<
    string,
    { result: AnthropicApiKeyVerificationResult; at: number }
  >();

  constructor(
    private apiKeyService = new ApiKeyService(),
    private readonly configManager = ConfigManager.getInstance(),
    private readonly codexCliLoginStatusChecker: CodexCliLoginStatusChecker = checkCodexCliLoginStatus,
    private readonly anthropicApiKeyVerifier: AnthropicApiKeyVerifier = verifyAnthropicApiKeyWithApi
  ) {}

  static getInstance(): ProviderConnectionService {
    ProviderConnectionService.instance ??= new ProviderConnectionService();
    return ProviderConnectionService.instance;
  }

  setCodexAccountFeature(feature: CodexAccountSnapshotReader | null): void {
    this.codexAccountFeature = feature;
  }

  setCodexModelCatalogFeature(
    feature: Pick<CodexModelCatalogFeatureFacade, 'getCatalog'> | null
  ): void {
    this.codexModelCatalogFeature = feature;
  }

  async getCodexModelCatalog(
    request: CodexModelCatalogRequest = {}
  ): Promise<CodexModelCatalogDto | null> {
    if (!this.codexModelCatalogFeature) {
      return null;
    }

    try {
      return await this.codexModelCatalogFeature.getCatalog(request);
    } catch {
      return null;
    }
  }

  setApiKeyService(apiKeyService: ApiKeyService): void {
    this.apiKeyService = apiKeyService;
  }

  getConfiguredAuthMode(providerId: CliProviderId): CliProviderAuthMode | null {
    if (providerId === 'anthropic') {
      return this.configManager.getConfig().providerConnections.anthropic.authMode;
    }

    if (providerId === 'codex') {
      return this.configManager.getConfig().providerConnections.codex.preferredAuthMode;
    }

    return null;
  }

  private getRawCodexCustomProvider(): CodexCustomProviderConfig {
    const config = this.configManager.getConfig().providerConnections.codex.customProvider;
    return {
      enabled: config.enabled === true,
      baseUrl: config.baseUrl.trim(),
      model: config.model.trim(),
    };
  }

  private getConfiguredCodexCustomProviderIssue(): string | null {
    const config = this.getRawCodexCustomProvider();
    if (config.enabled !== true) {
      return null;
    }

    if (this.getConfiguredAuthMode('codex') !== 'api_key') {
      return 'Codex custom provider is enabled but inactive because Codex auth mode is not API key.';
    }

    if (!config.baseUrl) {
      return 'Codex custom provider is enabled, but no base URL is configured.';
    }

    if (!isCodexCustomProviderBaseUrlUsable(config.baseUrl)) {
      return 'Codex custom provider base URL must use http:// or https:// and must not include credentials, query, or fragment.';
    }

    if (!config.model) {
      return 'Codex custom provider is enabled, but no model is configured.';
    }

    if (!isCodexCustomProviderModelUsable(config.model)) {
      return 'Codex custom provider model must be 200 characters or fewer and must not include control characters.';
    }

    return null;
  }

  private getConfiguredCodexCustomProvider(): CodexCustomProviderConfig | null {
    const config = this.getRawCodexCustomProvider();
    if (
      config.enabled !== true ||
      this.getConfiguredAuthMode('codex') !== 'api_key' ||
      !isCodexCustomProviderBaseUrlUsable(config.baseUrl) ||
      !isCodexCustomProviderModelUsable(config.model)
    ) {
      return null;
    }

    return {
      enabled: true,
      baseUrl: config.baseUrl,
      model: config.model,
    };
  }

  getConfiguredCodexCustomProviderModel(): string | null {
    return this.getConfiguredCodexCustomProvider()?.model ?? null;
  }

  private getConfiguredAnthropicCompatibleEndpoint(): AnthropicCompatibleEndpointConfig | null {
    const endpoint =
      this.configManager.getConfig().providerConnections.anthropic.compatibleEndpoint;
    return isUsableAnthropicCompatibleEndpoint(endpoint)
      ? { enabled: true, baseUrl: endpoint.baseUrl.trim() }
      : null;
  }

  private getConfiguredAnthropicCompatibleEndpointIssue(): string | null {
    const endpoint =
      this.configManager.getConfig().providerConnections.anthropic.compatibleEndpoint;
    if (endpoint?.enabled !== true) {
      return null;
    }

    const baseUrl = endpoint.baseUrl.trim();
    if (!baseUrl) {
      return 'Anthropic-compatible endpoint is enabled, but no base URL is configured.';
    }

    try {
      const url = new URL(baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return 'Anthropic-compatible endpoint base URL must use http:// or https://.';
      }

      if (url.username || url.password) {
        return 'Anthropic-compatible endpoint base URL must not include credentials.';
      }

      if (!isAnthropicCompatibleBaseUrl(baseUrl)) {
        return 'Anthropic-compatible endpoint cannot use the first-party Anthropic API host.';
      }
    } catch {
      return 'Anthropic-compatible endpoint base URL is invalid.';
    }

    return null;
  }

  private async getConfiguredAnthropicCompatibleToken(
    options?: StoredApiKeyAccessOptions
  ): Promise<ExternalCredential> {
    const storedToken = await this.lookupStoredApiKeyValue(ANTHROPIC_AUTH_TOKEN_ENV_VAR, options);
    if (storedToken?.value.trim()) {
      return {
        label: 'Stored in app',
        value: storedToken.value.trim(),
      };
    }

    const envToken = this.getExternalEnvValue(ANTHROPIC_AUTH_TOKEN_ENV_VAR);
    return envToken
      ? {
          label: `Detected from ${ANTHROPIC_AUTH_TOKEN_ENV_VAR}`,
          value: envToken,
        }
      : null;
  }

  private async applyConfiguredAnthropicCompatibleEndpointEnv(
    env: NodeJS.ProcessEnv,
    options?: StoredApiKeyAccessOptions
  ): Promise<boolean> {
    const endpoint = this.getConfiguredAnthropicCompatibleEndpoint();
    if (!endpoint) {
      return false;
    }

    env[ANTHROPIC_BASE_URL_ENV_VAR] = endpoint.baseUrl;
    const token = await this.getConfiguredAnthropicCompatibleToken(options);
    if (token?.value.trim()) {
      env[ANTHROPIC_AUTH_TOKEN_ENV_VAR] = token.value.trim();
    }

    if (typeof env.ANTHROPIC_API_KEY !== 'string' || !env.ANTHROPIC_API_KEY.trim()) {
      env.ANTHROPIC_API_KEY = '';
    }

    return true;
  }

  private async applyClaudeUserAnthropicSettingsAuthEnv(
    env: NodeJS.ProcessEnv,
    options?: StoredApiKeyAccessOptions
  ): Promise<boolean> {
    if (options?.allowClaudeUserSettingsAuthEnv === false) {
      return false;
    }

    if (this.getConfiguredAuthMode('anthropic') !== 'auto') {
      return false;
    }

    if (hasExplicitAnthropicCredentialEnv(env)) {
      return false;
    }

    const settingsEnv = await readClaudeUserAnthropicSettingsAuthEnv();
    if (!settingsEnv) {
      return false;
    }

    if (settingsEnv.ANTHROPIC_BASE_URL) {
      env.ANTHROPIC_BASE_URL = settingsEnv.ANTHROPIC_BASE_URL;
    }
    if (settingsEnv.ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = settingsEnv.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      return true;
    }
    if (settingsEnv.ANTHROPIC_AUTH_TOKEN) {
      env.ANTHROPIC_AUTH_TOKEN = settingsEnv.ANTHROPIC_AUTH_TOKEN;
    }
    env.ANTHROPIC_API_KEY = '';
    return true;
  }

  private async getAnthropicCompatibleEndpointConnectionInfo(): Promise<
    NonNullable<CliProviderConnectionInfo['compatibleEndpoint']>
  > {
    const endpoint =
      this.configManager.getConfig().providerConnections.anthropic.compatibleEndpoint;
    const hasStoredToken = await this.hasStoredApiKey(ANTHROPIC_AUTH_TOKEN_ENV_VAR);
    const envToken = this.getExternalEnvValue(ANTHROPIC_AUTH_TOKEN_ENV_VAR);
    const tokenSource = hasStoredToken ? 'stored' : envToken ? 'environment' : null;

    return {
      enabled: endpoint.enabled,
      baseUrl: endpoint.baseUrl,
      tokenConfigured: Boolean(tokenSource),
      tokenSource,
      tokenSourceLabel:
        tokenSource === 'stored'
          ? 'Stored in app'
          : tokenSource === 'environment'
            ? `Detected from ${ANTHROPIC_AUTH_TOKEN_ENV_VAR}`
            : null,
    };
  }

  async getConfiguredAnthropicApiKeyForTeamRuntime(env: NodeJS.ProcessEnv): Promise<string | null> {
    if (this.getConfiguredAuthMode('anthropic') !== 'api_key') {
      return null;
    }

    const configuredEndpoint =
      this.configManager.getConfig().providerConnections.anthropic.compatibleEndpoint;
    if (
      configuredEndpoint?.enabled === true ||
      isAnthropicCompatibleBaseUrl(env.ANTHROPIC_BASE_URL)
    ) {
      return null;
    }

    const storedKey = await this.apiKeyService.lookupPreferred('ANTHROPIC_API_KEY');
    if (storedKey?.value.trim()) {
      return storedKey.value.trim();
    }

    const envKey = env.ANTHROPIC_API_KEY?.trim();
    return envKey || null;
  }

  async applyConfiguredConnectionEnv(
    env: NodeJS.ProcessEnv,
    providerId: CliProviderId,
    runtimeBackendOverride?: string | null,
    options?: StoredApiKeyAccessOptions
  ): Promise<NodeJS.ProcessEnv> {
    if (providerId === 'anthropic') {
      if (await this.applyConfiguredAnthropicCompatibleEndpointEnv(env, options)) {
        return env;
      }

      if (await this.applyClaudeUserAnthropicSettingsAuthEnv(env, options)) {
        return env;
      }

      if (hasAnthropicCompatibleAuthEnv(env)) {
        return env;
      }

      const authMode = this.getConfiguredAuthMode(providerId);
      if (authMode === 'oauth') {
        delete env.ANTHROPIC_API_KEY;
        delete env.ANTHROPIC_AUTH_TOKEN;
        return env;
      }

      if (authMode !== 'api_key') {
        return env;
      }

      const storedKey = await this.lookupStoredApiKeyValue('ANTHROPIC_API_KEY', options);
      if (storedKey?.value.trim()) {
        env.ANTHROPIC_API_KEY = storedKey.value;
        delete env.ANTHROPIC_AUTH_TOKEN;
        return env;
      }

      delete env.ANTHROPIC_AUTH_TOKEN;

      if (typeof env.ANTHROPIC_API_KEY !== 'string' || !env.ANTHROPIC_API_KEY.trim()) {
        delete env.ANTHROPIC_API_KEY;
      }

      return env;
    }

    if (providerId === 'gemini') {
      const storedKey = await this.lookupStoredApiKeyValue('GEMINI_API_KEY', options);
      if (storedKey?.value.trim()) {
        env.GEMINI_API_KEY = storedKey.value;
      }
      return env;
    }

    if (providerId !== 'codex') {
      return env;
    }

    const snapshot = await this.getCodexLaunchSnapshot(env, {
      refreshRuntimeMissing: true,
      refreshBlockedLaunch: true,
    });
    applyCodexRuntimeContextEnv(env, snapshot);
    const readiness = evaluateCodexLaunchReadiness({
      preferredAuthMode: snapshot.preferredAuthMode,
      managedAccount: snapshot.managedAccount,
      apiKey: snapshot.apiKey,
      appServerState: snapshot.appServerState,
      appServerStatusMessage: snapshot.appServerStatusMessage,
      localActiveChatgptAccountPresent: snapshot.localActiveChatgptAccountPresent,
    });

    if (readiness.effectiveAuthMode === 'chatgpt') {
      delete env.OPENAI_API_KEY;
      delete env[CODEX_NATIVE_API_KEY_ENV_VAR];
      applyCodexForcedLoginMethodEnv(env, 'chatgpt');
      return env;
    }

    const resolvedApiKey = await this.resolveCodexApiKeyValue(env, runtimeBackendOverride, options);
    if (readiness.effectiveAuthMode === 'api_key' && resolvedApiKey) {
      env.OPENAI_API_KEY = resolvedApiKey;
      env[CODEX_NATIVE_API_KEY_ENV_VAR] = resolvedApiKey;
      applyCodexForcedLoginMethodEnv(env, 'api');
      return env;
    }

    if (typeof env.OPENAI_API_KEY !== 'string' || !env.OPENAI_API_KEY.trim()) {
      delete env.OPENAI_API_KEY;
    }
    delete env[CODEX_NATIVE_API_KEY_ENV_VAR];
    applyCodexForcedLoginMethodEnv(env, null);

    return env;
  }

  async applyAllConfiguredConnectionEnv(
    env: NodeJS.ProcessEnv,
    options?: StoredApiKeyAccessOptions
  ): Promise<NodeJS.ProcessEnv> {
    let nextEnv = env;
    for (const providerId of ['anthropic', 'codex', 'gemini', 'opencode'] as const) {
      nextEnv = await this.applyConfiguredConnectionEnv(nextEnv, providerId, undefined, options);
    }
    return nextEnv;
  }

  async augmentConfiguredConnectionEnv(
    env: NodeJS.ProcessEnv,
    providerId: CliProviderId,
    runtimeBackendOverride?: string | null,
    options?: StoredApiKeyAccessOptions
  ): Promise<NodeJS.ProcessEnv> {
    if (providerId === 'anthropic') {
      if (await this.applyConfiguredAnthropicCompatibleEndpointEnv(env, options)) {
        return env;
      }

      if (await this.applyClaudeUserAnthropicSettingsAuthEnv(env, options)) {
        return env;
      }

      if (this.getConfiguredAuthMode(providerId) !== 'api_key') {
        return env;
      }

      const storedKey = await this.lookupStoredApiKeyValue('ANTHROPIC_API_KEY', options);
      if (storedKey?.value.trim()) {
        env.ANTHROPIC_API_KEY = storedKey.value;
      }
      return env;
    }

    if (providerId === 'gemini') {
      const storedKey = await this.lookupStoredApiKeyValue('GEMINI_API_KEY', options);
      if (storedKey?.value.trim()) {
        env.GEMINI_API_KEY = storedKey.value;
      }
      return env;
    }

    if (providerId !== 'codex') {
      return env;
    }

    const snapshot = await this.getCodexLaunchSnapshot(env, {
      refreshRuntimeMissing: true,
      refreshBlockedLaunch: true,
    });
    applyCodexRuntimeContextEnv(env, snapshot);
    const readiness = evaluateCodexLaunchReadiness({
      preferredAuthMode: snapshot.preferredAuthMode,
      managedAccount: snapshot.managedAccount,
      apiKey: snapshot.apiKey,
      appServerState: snapshot.appServerState,
      appServerStatusMessage: snapshot.appServerStatusMessage,
      localActiveChatgptAccountPresent: snapshot.localActiveChatgptAccountPresent,
    });

    if (readiness.effectiveAuthMode === 'chatgpt') {
      delete env.OPENAI_API_KEY;
      delete env[CODEX_NATIVE_API_KEY_ENV_VAR];
      applyCodexForcedLoginMethodEnv(env, 'chatgpt');
      return env;
    }

    const resolvedApiKey = await this.resolveCodexApiKeyValue(env, runtimeBackendOverride, options);
    if (readiness.effectiveAuthMode === 'api_key' && resolvedApiKey) {
      env.OPENAI_API_KEY = resolvedApiKey;
      env[CODEX_NATIVE_API_KEY_ENV_VAR] = resolvedApiKey;
      applyCodexForcedLoginMethodEnv(env, 'api');
      return env;
    }

    applyCodexForcedLoginMethodEnv(env, null);
    return env;
  }

  async augmentAllConfiguredConnectionEnv(
    env: NodeJS.ProcessEnv,
    options?: StoredApiKeyAccessOptions
  ): Promise<NodeJS.ProcessEnv> {
    let nextEnv = env;
    for (const providerId of ['anthropic', 'codex', 'gemini', 'opencode'] as const) {
      nextEnv = await this.augmentConfiguredConnectionEnv(nextEnv, providerId, undefined, options);
    }
    return nextEnv;
  }

  async getConfiguredConnectionIssue(
    env: NodeJS.ProcessEnv,
    providerId: CliProviderId,
    runtimeBackendOverride?: string | null
  ): Promise<string | null> {
    if (providerId === 'anthropic') {
      const compatibleEndpointIssue = this.getConfiguredAnthropicCompatibleEndpointIssue();
      if (compatibleEndpointIssue) {
        return compatibleEndpointIssue;
      }

      if (this.getConfiguredAnthropicCompatibleEndpoint()) {
        return null;
      }

      if (this.getConfiguredAuthMode(providerId) !== 'api_key') {
        return null;
      }

      if (hasAnthropicCompatibleAuthEnv(env)) {
        return null;
      }

      if (typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.trim()) {
        return null;
      }

      if (await this.hasStoredApiKey('ANTHROPIC_API_KEY')) {
        return null;
      }

      return (
        'Anthropic API key mode is enabled, but no ANTHROPIC_API_KEY is configured. ' +
        'Add a stored/environment API key or switch Anthropic auth mode back to Auto or OAuth.'
      );
    }

    if (providerId !== 'codex') {
      return null;
    }

    const customProviderIssue =
      this.getConfiguredAuthMode('codex') === 'api_key'
        ? this.getConfiguredCodexCustomProviderIssue()
        : null;
    if (customProviderIssue) {
      return customProviderIssue;
    }

    const snapshot = await this.getCodexLaunchSnapshot(env, {
      refreshRuntimeMissing: true,
      refreshBlockedLaunch: true,
    });
    const runtimeEnv = { ...env };
    applyCodexRuntimeContextEnv(runtimeEnv, snapshot);
    const readiness = evaluateCodexLaunchReadiness({
      preferredAuthMode: snapshot.preferredAuthMode,
      managedAccount: snapshot.managedAccount,
      apiKey: snapshot.apiKey,
      appServerState: snapshot.appServerState,
      appServerStatusMessage: snapshot.appServerStatusMessage,
      localActiveChatgptAccountPresent: snapshot.localActiveChatgptAccountPresent,
    });

    if (readiness.launchAllowed) {
      if (
        readiness.effectiveAuthMode !== 'chatgpt' ||
        this.getConfiguredCodexRuntimeBackend(runtimeBackendOverride) !== CODEX_NATIVE_BACKEND_ID
      ) {
        return null;
      }

      if (snapshot.appServerState === 'healthy' && snapshot.managedAccount?.type === 'chatgpt') {
        return null;
      }

      delete runtimeEnv.OPENAI_API_KEY;
      delete runtimeEnv[CODEX_NATIVE_API_KEY_ENV_VAR];
      applyCodexForcedLoginMethodEnv(runtimeEnv, 'chatgpt');

      const loginStatus = await this.codexCliLoginStatusChecker({
        binaryPath: snapshot.runtimeContext?.binaryPath?.trim() || null,
        env: runtimeEnv,
      });
      if (loginStatus.status === 'logged_in') {
        return null;
      }

      const base =
        loginStatus.status === 'not_logged_in'
          ? 'Codex ChatGPT account mode is selected, but the Codex CLI login status is not active for the launch runtime.'
          : 'Codex ChatGPT account mode is selected, but the Codex CLI login status could not be verified for the launch runtime.';
      const reconnectHint = snapshot.localActiveChatgptAccountPresent
        ? 'Reconnect ChatGPT to refresh the current Codex subscription session.'
        : snapshot.localAccountArtifactsPresent
          ? 'Local Codex account data exists, but the launch runtime cannot use it. Reconnect ChatGPT.'
          : 'Connect ChatGPT again or switch Codex auth mode to API key.';
      return `${base} ${reconnectHint}${
        loginStatus.detail ? ` Details: ${loginStatus.detail}` : ''
      }`;
    }

    if (readiness.state === 'missing_auth') {
      if (snapshot.preferredAuthMode === 'chatgpt') {
        return snapshot.requiresOpenaiAuth
          ? snapshot.localActiveChatgptAccountPresent
            ? 'Codex ChatGPT account mode is selected, and Codex has a locally selected ChatGPT account, but the current session needs reconnect. Reconnect ChatGPT or switch Codex auth mode to API key.'
            : snapshot.localAccountArtifactsPresent
              ? 'Codex ChatGPT account mode is selected, but Codex CLI reports no active ChatGPT login. Local Codex account data exists, but no active managed session is selected. Connect ChatGPT again or switch Codex auth mode to API key.'
              : 'Codex ChatGPT account mode is selected, but Codex CLI reports no active ChatGPT login. Connect ChatGPT again or switch Codex auth mode to API key.'
          : 'Codex ChatGPT account mode is selected, but no managed ChatGPT account is available. Connect ChatGPT again or switch Codex auth mode to API key.';
      }

      if (snapshot.preferredAuthMode === 'api_key') {
        return 'Codex API key mode is selected, but no OPENAI_API_KEY or CODEX_API_KEY credential is available. Add one before launching Codex.';
      }

      return 'Codex native requires OPENAI_API_KEY or CODEX_API_KEY, or a connected ChatGPT account. Add one before launching Codex.';
    }

    return (
      readiness.issueMessage ??
      'Codex native is not ready. Connect a ChatGPT account or add an API key before launching.'
    );
  }

  async getConfiguredConnectionIssues(
    env: NodeJS.ProcessEnv,
    providerIds: readonly CliProviderId[] = ['anthropic', 'codex', 'gemini', 'opencode'],
    runtimeBackendOverrides?: Partial<Record<CliProviderId, string>>
  ): Promise<Partial<Record<CliProviderId, string>>> {
    const issues: Partial<Record<CliProviderId, string>> = {};

    for (const providerId of providerIds) {
      const issue = await this.getConfiguredConnectionIssue(
        env,
        providerId,
        runtimeBackendOverrides?.[providerId]
      );
      if (issue) {
        issues[providerId] = issue;
      }
    }

    return issues;
  }

  async getConfiguredConnectionLaunchArgs(
    env: NodeJS.ProcessEnv,
    providerId: CliProviderId,
    runtimeBackendOverride?: string | null,
    binaryPath?: string | null
  ): Promise<string[]> {
    if (providerId !== 'codex') {
      return [];
    }

    if (this.getConfiguredCodexRuntimeBackend(runtimeBackendOverride) !== CODEX_NATIVE_BACKEND_ID) {
      return [];
    }

    const snapshot = await this.getCodexLaunchSnapshot(env, {
      refreshRuntimeMissing: true,
      refreshBlockedLaunch: true,
    });
    const readiness = evaluateCodexLaunchReadiness({
      preferredAuthMode: snapshot.preferredAuthMode,
      managedAccount: snapshot.managedAccount,
      apiKey: snapshot.apiKey,
      appServerState: snapshot.appServerState,
      appServerStatusMessage: snapshot.appServerStatusMessage,
      localActiveChatgptAccountPresent: snapshot.localActiveChatgptAccountPresent,
    });

    if (readiness.effectiveAuthMode === 'chatgpt') {
      return buildCodexLaunchArgs(binaryPath, 'chatgpt');
    }

    if (readiness.effectiveAuthMode === 'api_key') {
      const customProvider = this.getConfiguredCodexCustomProvider();
      return buildCodexLaunchArgs(binaryPath, 'api', {
        customProviderConfigOverrides: customProvider
          ? buildCodexCustomProviderConfigOverrides(customProvider)
          : [],
      });
    }

    return [];
  }

  async enrichProviderStatus(
    provider: CliProviderStatus,
    options: ProviderStatusEnrichmentOptions = {}
  ): Promise<CliProviderStatus> {
    const withConnection = {
      ...provider,
      connection: await this.getConnectionInfo(provider.providerId),
    };

    if (provider.providerId === 'anthropic') {
      return this.enrichAnthropicProviderStatus(withConnection);
    }

    if (provider.providerId !== 'codex') {
      return withConnection;
    }

    const customProvider = this.getConfiguredCodexCustomProvider();
    if (customProvider) {
      const catalog = createCodexCustomProviderCatalog(customProvider);
      const model = catalog.defaultLaunchModel ?? customProvider.model;
      const statusMessage =
        withConnection.statusMessage ??
        (withConnection.connection?.apiKeyConfigured
          ? 'Codex custom provider configured'
          : 'Codex custom provider configured. API key is not set.');

      return {
        ...withConnection,
        models: [model],
        modelCatalog: catalog,
        subscriptionRateLimits: null,
        backend: withConnection.backend
          ? {
              ...withConnection.backend,
              endpointLabel: customProvider.baseUrl,
            }
          : {
              kind: CODEX_NATIVE_BACKEND_ID,
              label: 'Codex native',
              endpointLabel: customProvider.baseUrl,
            },
        runtimeCapabilities: {
          ...withConnection.runtimeCapabilities,
          modelCatalog: {
            dynamic: false,
            source: catalog.source,
          },
          reasoningEffort: {
            supported: true,
            values: ['low', 'medium', 'high'] satisfies CliProviderReasoningEffort[],
            configPassthrough: true,
          },
        },
        statusMessage,
      };
    }

    try {
      if (
        options.hydrateModelCatalog === false &&
        !isUsableCodexModelCatalog(withConnection.modelCatalog)
      ) {
        return withConnection;
      }

      const orchestratorCatalog = isUsableCodexModelCatalog(withConnection.modelCatalog)
        ? withConnection.modelCatalog
        : null;
      const catalog =
        orchestratorCatalog ??
        (this.codexModelCatalogFeature ? await this.codexModelCatalogFeature.getCatalog() : null);
      if (!isUsableCodexModelCatalog(catalog)) {
        return withConnection;
      }

      const models = catalog.models
        .filter((model) => !model.hidden)
        .map((model) => model.launchModel.trim())
        .filter(Boolean);
      const reasoningEfforts = Array.from(
        new Set(
          catalog.models.flatMap<CliProviderReasoningEffort>(
            (model) => model.supportedReasoningEfforts
          )
        )
      );
      const runtimeReasoningCapability = withConnection.runtimeCapabilities?.reasoningEffort;
      const runtimeModelCatalogCapability = withConnection.runtimeCapabilities?.modelCatalog;
      const modelCatalogCapability =
        orchestratorCatalog && runtimeModelCatalogCapability
          ? runtimeModelCatalogCapability
          : {
              dynamic: isDynamicCodexModelCatalog(catalog),
              source: catalog.source,
            };
      return {
        ...withConnection,
        models: models.length > 0 ? models : withConnection.models,
        modelCatalog: catalog,
        runtimeCapabilities: {
          ...withConnection.runtimeCapabilities,
          modelCatalog: modelCatalogCapability,
          reasoningEffort: {
            supported: runtimeReasoningCapability?.supported ?? reasoningEfforts.length > 0,
            values:
              runtimeReasoningCapability?.values && runtimeReasoningCapability.values.length > 0
                ? runtimeReasoningCapability.values
                : (['low', 'medium', 'high'] satisfies CliProviderReasoningEffort[]),
            configPassthrough: runtimeReasoningCapability?.configPassthrough === true,
          },
        },
      };
    } catch {
      return withConnection;
    }
  }

  private async enrichAnthropicProviderStatus(
    provider: CliProviderStatus
  ): Promise<CliProviderStatus> {
    const connection = provider.connection;
    if (connection?.compatibleEndpoint?.enabled === true) {
      return {
        ...provider,
        subscriptionRateLimits: null,
        statusMessage:
          provider.statusMessage ??
          (connection.compatibleEndpoint.tokenConfigured
            ? 'Anthropic-compatible endpoint configured'
            : 'Anthropic-compatible endpoint configured. Auth token is not set.'),
      };
    }

    if (connection?.configuredAuthMode !== 'api_key') {
      return provider;
    }

    if (connection.apiKeyConfigured) {
      const runtimeApiKeyAuthMethod =
        provider.authMethod === 'api_key' || provider.authMethod === 'api_key_helper';
      const runtimeVerifiedApiKey =
        provider.authenticated === true &&
        runtimeApiKeyAuthMethod &&
        provider.verificationState === 'verified';

      if (runtimeVerifiedApiKey) {
        return {
          ...provider,
          authenticated: true,
          authMethod: provider.authMethod,
          subscriptionRateLimits: null,
          verificationState: 'verified',
          statusMessage: provider.statusMessage ?? 'Connected via API key',
        };
      }

      const apiVerification = await this.verifyConfiguredAnthropicApiKeyForStatus();
      if (apiVerification?.state === 'valid') {
        return {
          ...provider,
          authenticated: true,
          authMethod: 'api_key',
          subscriptionRateLimits: null,
          verificationState: 'verified',
          statusMessage: 'Connected via API key',
        };
      }

      if (apiVerification?.state === 'invalid') {
        return {
          ...provider,
          authenticated: false,
          authMethod: null,
          subscriptionRateLimits: null,
          verificationState: 'error',
          statusMessage: `Anthropic API key verification failed: ${normalizeAnthropicApiKeyVerificationMessage(
            apiVerification
          )}`,
        };
      }

      return {
        ...provider,
        authenticated: false,
        authMethod: null,
        subscriptionRateLimits: null,
        verificationState:
          provider.verificationState === 'error' || provider.verificationState === 'offline'
            ? provider.verificationState
            : 'unknown',
        statusMessage:
          provider.verificationState === 'error'
            ? (provider.statusMessage ?? 'Anthropic API key verification failed')
            : 'Anthropic API key is configured, but has not been verified by the runtime yet.',
      };
    }

    return {
      ...provider,
      authenticated: false,
      authMethod: null,
      subscriptionRateLimits: null,
      verificationState: provider.verificationState === 'error' ? 'error' : 'unknown',
      statusMessage: 'API key mode is selected, but no Anthropic API credential is available yet.',
    };
  }

  private async verifyConfiguredAnthropicApiKeyForStatus(): Promise<AnthropicApiKeyVerificationResult | null> {
    const apiKey = await this.resolveAnthropicApiKeyForStatus();
    if (!apiKey) {
      return null;
    }

    const baseUrl = this.getExternalEnvValue('ANTHROPIC_BASE_URL');
    const cacheKey = hashCredentialForCache(`${apiKey}\0${baseUrl ?? ''}`);
    const cached = this.anthropicApiKeyVerificationCache.get(cacheKey);
    if (cached && Date.now() - cached.at < ANTHROPIC_API_KEY_VERIFY_CACHE_TTL_MS) {
      return cached.result;
    }

    const result = await this.anthropicApiKeyVerifier(apiKey, baseUrl);
    this.anthropicApiKeyVerificationCache.set(cacheKey, { result, at: Date.now() });
    return result;
  }

  private async resolveAnthropicApiKeyForStatus(): Promise<string | null> {
    const storedKey = await this.lookupStoredApiKeyValue('ANTHROPIC_API_KEY');
    if (storedKey?.value.trim()) {
      return storedKey.value.trim();
    }

    return this.getExternalCredential('anthropic')?.value.trim() || null;
  }

  async enrichProviderStatuses(providers: CliProviderStatus[]): Promise<CliProviderStatus[]> {
    return Promise.all(providers.map((provider) => this.enrichProviderStatus(provider)));
  }

  async getConnectionInfo(providerId: CliProviderId): Promise<CliProviderConnectionInfo> {
    const capabilities = PROVIDER_CAPABILITIES[providerId];
    const hasStoredApiKey = await this.hasStoredProviderApiKey(providerId);
    const externalCredential = this.getExternalCredential(providerId);
    const codexSnapshot = providerId === 'codex' ? await this.getCodexAccountSnapshot() : null;
    const configurableAuthModes = capabilities.configurableAuthModes;
    const configuredAuthMode =
      providerId === 'codex'
        ? (codexSnapshot?.preferredAuthMode ?? this.getConfiguredAuthMode(providerId))
        : this.getConfiguredAuthMode(providerId);
    const apiKeyConfigured =
      providerId === 'codex'
        ? (codexSnapshot?.apiKey.available ?? false)
        : Boolean(hasStoredApiKey || externalCredential?.value.trim());
    const apiKeySource =
      providerId === 'codex'
        ? (codexSnapshot?.apiKey.source ?? null)
        : hasStoredApiKey
          ? 'stored'
          : externalCredential?.value.trim()
            ? 'environment'
            : null;
    const apiKeySourceLabel =
      providerId === 'codex'
        ? (codexSnapshot?.apiKey.sourceLabel ?? null)
        : hasStoredApiKey
          ? 'Stored in app'
          : (externalCredential?.label ?? null);
    const compatibleEndpoint =
      providerId === 'anthropic' ? await this.getAnthropicCompatibleEndpointConnectionInfo() : null;
    const codexCustomProvider =
      providerId === 'codex'
        ? {
            config: this.getRawCodexCustomProvider(),
            issueMessage: this.getConfiguredCodexCustomProviderIssue(),
            active: Boolean(this.getConfiguredCodexCustomProvider()),
          }
        : null;

    return {
      ...capabilities,
      configurableAuthModes,
      configuredAuthMode,
      apiKeyConfigured,
      apiKeySource,
      apiKeySourceLabel,
      compatibleEndpoint,
      codex:
        providerId === 'codex' && codexSnapshot
          ? {
              preferredAuthMode: codexSnapshot.preferredAuthMode,
              effectiveAuthMode: codexSnapshot.effectiveAuthMode,
              appServerState: codexSnapshot.appServerState,
              appServerStatusMessage: codexSnapshot.appServerStatusMessage,
              managedAccount: codexSnapshot.managedAccount,
              requiresOpenaiAuth: codexSnapshot.requiresOpenaiAuth,
              localAccountArtifactsPresent: codexSnapshot.localAccountArtifactsPresent,
              localActiveChatgptAccountPresent: codexSnapshot.localActiveChatgptAccountPresent,
              login: codexSnapshot.login,
              rateLimits: codexSnapshot.rateLimits,
              launchAllowed: codexSnapshot.launchAllowed,
              launchIssueMessage: codexSnapshot.launchIssueMessage,
              launchReadinessState: codexSnapshot.launchReadinessState,
              customProvider: {
                enabled: codexCustomProvider?.config.enabled ?? false,
                active: codexCustomProvider?.active ?? false,
                baseUrl: codexCustomProvider?.config.baseUrl ?? '',
                model: codexCustomProvider?.config.model ?? '',
                issueMessage: codexCustomProvider?.issueMessage ?? null,
              },
            }
          : null,
    };
  }

  private async hasStoredProviderApiKey(providerId: CliProviderId): Promise<boolean> {
    const envVarName = PROVIDER_API_KEY_ENV_VARS[providerId];
    if (!envVarName) {
      return false;
    }

    return this.hasStoredApiKey(envVarName);
  }

  private async hasStoredApiKey(envVarName: string): Promise<boolean> {
    const service = this.apiKeyService as ApiKeyService & {
      hasPreferred?: (envVarName: string) => Promise<boolean>;
    };

    if (typeof service.hasPreferred === 'function') {
      return service.hasPreferred(envVarName);
    }

    const storedKey = await service.lookupPreferred(envVarName);
    return Boolean(storedKey?.value.trim());
  }

  private async lookupStoredApiKeyValue(
    envVarName: string,
    options?: StoredApiKeyAccessOptions
  ): Promise<{ envVarName: string; value: string } | null> {
    const allowedWhenMetadataOnly =
      options?.allowedStoredApiKeyEnvVarNames?.includes(envVarName) === true;
    if (options?.allowStoredApiKeyDecryption === false && !allowedWhenMetadataOnly) {
      return null;
    }

    return this.apiKeyService.lookupPreferred(envVarName);
  }

  private getConfiguredCodexRuntimeBackend(runtimeBackendOverride?: string | null): 'codex-native' {
    if (runtimeBackendOverride === CODEX_NATIVE_BACKEND_ID) {
      return runtimeBackendOverride;
    }
    return CODEX_NATIVE_BACKEND_ID;
  }

  private async getCodexAccountSnapshot(options?: {
    forceRefresh?: boolean;
  }): Promise<CodexAccountSnapshotDto> {
    if (this.codexAccountFeature) {
      if (options?.forceRefresh && this.codexAccountFeature.refreshSnapshot) {
        return this.codexAccountFeature.refreshSnapshot({ forceRefreshToken: true });
      }
      return this.codexAccountFeature.getSnapshot();
    }

    const preferredAuthMode =
      (this.configManager.getConfig().providerConnections.codex.preferredAuthMode as
        | CodexAccountAuthMode
        | undefined) ?? 'auto';
    const hasStoredOpenAiKey = await this.hasStoredApiKey('OPENAI_API_KEY');
    const externalCredential = this.getExternalCredential('codex');
    const apiKeyAvailable = Boolean(hasStoredOpenAiKey || externalCredential?.value.trim());
    const apiKey = {
      available: apiKeyAvailable,
      source: hasStoredOpenAiKey
        ? 'stored'
        : externalCredential?.value.trim()
          ? 'environment'
          : null,
      sourceLabel: hasStoredOpenAiKey ? 'Stored in app' : (externalCredential?.label ?? null),
    } satisfies CodexAccountSnapshotDto['apiKey'];
    const readiness = evaluateCodexLaunchReadiness({
      preferredAuthMode,
      managedAccount: null,
      apiKey,
      appServerState: 'degraded',
      appServerStatusMessage: 'Codex account management has not been initialized yet.',
      localActiveChatgptAccountPresent: false,
    });

    return {
      preferredAuthMode,
      effectiveAuthMode: readiness.effectiveAuthMode,
      launchAllowed: readiness.launchAllowed,
      launchIssueMessage: readiness.issueMessage,
      launchReadinessState: readiness.state,
      appServerState: 'degraded',
      appServerStatusMessage: 'Codex account management has not been initialized yet.',
      managedAccount: null,
      apiKey,
      requiresOpenaiAuth: null,
      localAccountArtifactsPresent: false,
      localActiveChatgptAccountPresent: false,
      runtimeContext: {
        binaryPath: null,
        codexHome: null,
      },
      login: {
        status: 'idle',
        error: null,
        startedAt: null,
      },
      rateLimits: null,
      updatedAt: new Date().toISOString(),
    };
  }

  private async getCodexLaunchSnapshot(
    env: NodeJS.ProcessEnv,
    options?: CodexLaunchSnapshotRefreshOptions
  ): Promise<CodexAccountSnapshotDto> {
    let snapshot = this.mergeCodexApiKeyAvailability(await this.getCodexAccountSnapshot(), env);
    const readiness = evaluateCodexLaunchReadiness({
      preferredAuthMode: snapshot.preferredAuthMode,
      managedAccount: snapshot.managedAccount,
      apiKey: snapshot.apiKey,
      appServerState: snapshot.appServerState,
      appServerStatusMessage: snapshot.appServerStatusMessage,
      localActiveChatgptAccountPresent: snapshot.localActiveChatgptAccountPresent,
    });
    const shouldRefresh =
      (options?.refreshRuntimeMissing === true && snapshot.appServerState === 'runtime-missing') ||
      (options?.refreshBlockedLaunch === true && !readiness.launchAllowed);
    if (!shouldRefresh) {
      return snapshot;
    }

    try {
      snapshot = this.mergeCodexApiKeyAvailability(
        await this.getCodexAccountSnapshot({ forceRefresh: true }),
        env
      );
    } catch {
      // Keep the original blocked snapshot so callers still report the concrete issue.
    }

    return snapshot;
  }

  private async resolveCodexApiKeyValue(
    env: NodeJS.ProcessEnv,
    runtimeBackendOverride?: string | null,
    options?: StoredApiKeyAccessOptions
  ): Promise<string | null> {
    const codexRuntimeBackend = this.getConfiguredCodexRuntimeBackend(runtimeBackendOverride);
    const storedKey = await this.lookupStoredApiKeyValue('OPENAI_API_KEY', options);
    const existingOpenAiKey =
      typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.trim()
        ? env.OPENAI_API_KEY
        : null;
    const existingNativeKey =
      typeof env[CODEX_NATIVE_API_KEY_ENV_VAR] === 'string' &&
      env[CODEX_NATIVE_API_KEY_ENV_VAR]?.trim()
        ? env[CODEX_NATIVE_API_KEY_ENV_VAR]
        : null;

    return (
      storedKey?.value.trim() ||
      existingOpenAiKey ||
      (codexRuntimeBackend === CODEX_NATIVE_BACKEND_ID ? existingNativeKey : null)
    );
  }

  private mergeCodexApiKeyAvailability(
    snapshot: CodexAccountSnapshotDto,
    env: NodeJS.ProcessEnv
  ): CodexAccountSnapshotDto {
    const openAiApiKey =
      typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.trim()
        ? env.OPENAI_API_KEY
        : null;
    const codexApiKey =
      typeof env[CODEX_NATIVE_API_KEY_ENV_VAR] === 'string' &&
      env[CODEX_NATIVE_API_KEY_ENV_VAR]?.trim()
        ? env[CODEX_NATIVE_API_KEY_ENV_VAR]
        : null;

    if (!openAiApiKey && !codexApiKey) {
      return snapshot;
    }

    return {
      ...snapshot,
      apiKey: {
        available: true,
        source: 'environment',
        sourceLabel: codexApiKey ? 'Detected from CODEX_API_KEY' : 'Detected from OPENAI_API_KEY',
      },
    };
  }

  private getExternalCredential(providerId: CliProviderId): ExternalCredential {
    if (providerId === 'anthropic') {
      const apiKey = this.getExternalEnvValue('ANTHROPIC_API_KEY');
      if (apiKey) {
        return {
          label: 'Detected from ANTHROPIC_API_KEY',
          value: apiKey,
        };
      }
    }

    if (providerId === 'gemini') {
      const apiKey = this.getExternalEnvValue('GEMINI_API_KEY');
      if (apiKey) {
        return {
          label: 'Detected from GEMINI_API_KEY',
          value: apiKey,
        };
      }
    }

    if (providerId === 'codex') {
      const nativeApiKey = this.getExternalEnvValue(CODEX_NATIVE_API_KEY_ENV_VAR);
      if (nativeApiKey) {
        return {
          label: `Detected from ${CODEX_NATIVE_API_KEY_ENV_VAR}`,
          value: nativeApiKey,
        };
      }

      const apiKey = this.getExternalEnvValue('OPENAI_API_KEY');
      if (apiKey) {
        return {
          label: 'Detected from OPENAI_API_KEY',
          value: apiKey,
        };
      }
    }

    return null;
  }

  private getExternalEnvValue(envVarName: string): string | null {
    const shellEnv = getCachedShellEnv() ?? {};
    for (const source of [shellEnv, process.env]) {
      const value = source[envVarName];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }
    return null;
  }
}

export const providerConnectionService = ProviderConnectionService.getInstance();
