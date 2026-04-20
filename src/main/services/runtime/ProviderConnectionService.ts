import path from 'node:path';

import { evaluateCodexLaunchReadiness } from '@features/codex-account';
import { getCachedShellEnv } from '@main/utils/shellEnv';

import { ApiKeyService } from '../extensions/apikeys/ApiKeyService';
import { ConfigManager } from '../infrastructure/ConfigManager';

import type {
  CodexAccountAuthMode,
  CodexAccountSnapshotDto,
} from '@features/codex-account/contracts';
import type { CodexAccountFeatureFacade } from '@features/codex-account/main';
import type {
  CliProviderAuthMode,
  CliProviderConnectionInfo,
  CliProviderId,
  CliProviderStatus,
} from '@shared/types';

type ExternalCredential = {
  label: string;
  value: string;
} | null;

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
};

const PROVIDER_API_KEY_ENV_VARS: Partial<Record<CliProviderId, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

const CODEX_NATIVE_API_KEY_ENV_VAR = 'CODEX_API_KEY';
const CODEX_NATIVE_BACKEND_ID = 'codex-native';

function isCodexExecBinary(binaryPath?: string | null): boolean {
  const binaryName = path.basename(binaryPath?.trim() ?? '').toLowerCase();
  return (
    binaryName === 'codex' ||
    binaryName === 'codex.exe' ||
    binaryName === 'codex-cli' ||
    binaryName === 'codex-cli.exe'
  );
}

function buildCodexForcedLoginLaunchArgs(
  binaryPath: string | null | undefined,
  loginMethod: 'chatgpt' | 'api'
): string[] {
  if (isCodexExecBinary(binaryPath)) {
    return ['-c', `forced_login_method="${loginMethod}"`];
  }

  return ['--settings', JSON.stringify({ codex: { forced_login_method: loginMethod } })];
}

export class ProviderConnectionService {
  private static instance: ProviderConnectionService | null = null;
  private codexAccountFeature: Pick<CodexAccountFeatureFacade, 'getSnapshot'> | null = null;

  constructor(
    private readonly apiKeyService = new ApiKeyService(),
    private readonly configManager = ConfigManager.getInstance()
  ) {}

  static getInstance(): ProviderConnectionService {
    ProviderConnectionService.instance ??= new ProviderConnectionService();
    return ProviderConnectionService.instance;
  }

  setCodexAccountFeature(feature: Pick<CodexAccountFeatureFacade, 'getSnapshot'> | null): void {
    this.codexAccountFeature = feature;
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

  async applyConfiguredConnectionEnv(
    env: NodeJS.ProcessEnv,
    providerId: CliProviderId,
    runtimeBackendOverride?: string | null
  ): Promise<NodeJS.ProcessEnv> {
    if (providerId === 'anthropic') {
      const authMode = this.getConfiguredAuthMode(providerId);
      if (authMode === 'oauth') {
        delete env.ANTHROPIC_API_KEY;
        delete env.ANTHROPIC_AUTH_TOKEN;
        return env;
      }

      if (authMode !== 'api_key') {
        return env;
      }

      const storedKey = await this.apiKeyService.lookupPreferred('ANTHROPIC_API_KEY');
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

    if (providerId !== 'codex') {
      return env;
    }

    const snapshot = this.mergeCodexApiKeyAvailability(await this.getCodexAccountSnapshot(), env);
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
      return env;
    }

    const resolvedApiKey = await this.resolveCodexApiKeyValue(env, runtimeBackendOverride);
    if (readiness.effectiveAuthMode === 'api_key' && resolvedApiKey) {
      env.OPENAI_API_KEY = resolvedApiKey;
      env[CODEX_NATIVE_API_KEY_ENV_VAR] = resolvedApiKey;
      return env;
    }

    if (typeof env.OPENAI_API_KEY !== 'string' || !env.OPENAI_API_KEY.trim()) {
      delete env.OPENAI_API_KEY;
    }
    delete env[CODEX_NATIVE_API_KEY_ENV_VAR];

    return env;
  }

  async applyAllConfiguredConnectionEnv(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    let nextEnv = env;
    for (const providerId of ['anthropic', 'codex', 'gemini'] as const) {
      nextEnv = await this.applyConfiguredConnectionEnv(nextEnv, providerId);
    }
    return nextEnv;
  }

  async augmentConfiguredConnectionEnv(
    env: NodeJS.ProcessEnv,
    providerId: CliProviderId,
    runtimeBackendOverride?: string | null
  ): Promise<NodeJS.ProcessEnv> {
    if (providerId === 'anthropic') {
      if (this.getConfiguredAuthMode(providerId) !== 'api_key') {
        return env;
      }

      const storedKey = await this.apiKeyService.lookupPreferred('ANTHROPIC_API_KEY');
      if (storedKey?.value.trim()) {
        env.ANTHROPIC_API_KEY = storedKey.value;
      }
      return env;
    }

    if (providerId !== 'codex') {
      return env;
    }

    const snapshot = this.mergeCodexApiKeyAvailability(await this.getCodexAccountSnapshot(), env);
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
      return env;
    }

    const resolvedApiKey = await this.resolveCodexApiKeyValue(env, runtimeBackendOverride);
    if (readiness.effectiveAuthMode === 'api_key' && resolvedApiKey) {
      env.OPENAI_API_KEY = resolvedApiKey;
      env[CODEX_NATIVE_API_KEY_ENV_VAR] = resolvedApiKey;
    }

    return env;
  }

  async augmentAllConfiguredConnectionEnv(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    let nextEnv = env;
    for (const providerId of ['anthropic', 'codex', 'gemini'] as const) {
      nextEnv = await this.augmentConfiguredConnectionEnv(nextEnv, providerId);
    }
    return nextEnv;
  }

  async getConfiguredConnectionIssue(
    env: NodeJS.ProcessEnv,
    providerId: CliProviderId,
    _runtimeBackendOverride?: string | null
  ): Promise<string | null> {
    if (providerId === 'anthropic') {
      if (this.getConfiguredAuthMode(providerId) !== 'api_key') {
        return null;
      }

      if (typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.trim()) {
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

    const snapshot = this.mergeCodexApiKeyAvailability(await this.getCodexAccountSnapshot(), env);
    const readiness = evaluateCodexLaunchReadiness({
      preferredAuthMode: snapshot.preferredAuthMode,
      managedAccount: snapshot.managedAccount,
      apiKey: snapshot.apiKey,
      appServerState: snapshot.appServerState,
      appServerStatusMessage: snapshot.appServerStatusMessage,
      localActiveChatgptAccountPresent: snapshot.localActiveChatgptAccountPresent,
    });

    if (readiness.launchAllowed) {
      return null;
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
    providerIds: readonly CliProviderId[] = ['anthropic', 'codex', 'gemini'],
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

    const snapshot = this.mergeCodexApiKeyAvailability(await this.getCodexAccountSnapshot(), env);
    const readiness = evaluateCodexLaunchReadiness({
      preferredAuthMode: snapshot.preferredAuthMode,
      managedAccount: snapshot.managedAccount,
      apiKey: snapshot.apiKey,
      appServerState: snapshot.appServerState,
      appServerStatusMessage: snapshot.appServerStatusMessage,
      localActiveChatgptAccountPresent: snapshot.localActiveChatgptAccountPresent,
    });

    if (readiness.effectiveAuthMode === 'chatgpt') {
      return buildCodexForcedLoginLaunchArgs(binaryPath, 'chatgpt');
    }

    if (readiness.effectiveAuthMode === 'api_key') {
      return buildCodexForcedLoginLaunchArgs(binaryPath, 'api');
    }

    return [];
  }

  async enrichProviderStatus(provider: CliProviderStatus): Promise<CliProviderStatus> {
    return {
      ...provider,
      connection: await this.getConnectionInfo(provider.providerId),
    };
  }

  async enrichProviderStatuses(providers: CliProviderStatus[]): Promise<CliProviderStatus[]> {
    return Promise.all(providers.map((provider) => this.enrichProviderStatus(provider)));
  }

  async getConnectionInfo(providerId: CliProviderId): Promise<CliProviderConnectionInfo> {
    const capabilities = PROVIDER_CAPABILITIES[providerId];
    const storedApiKey = await this.getStoredApiKey(providerId);
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
        : Boolean(storedApiKey?.value.trim() || externalCredential?.value.trim());
    const apiKeySource =
      providerId === 'codex'
        ? (codexSnapshot?.apiKey.source ?? null)
        : storedApiKey?.value.trim()
          ? 'stored'
          : externalCredential?.value.trim()
            ? 'environment'
            : null;
    const apiKeySourceLabel =
      providerId === 'codex'
        ? (codexSnapshot?.apiKey.sourceLabel ?? null)
        : storedApiKey?.value.trim()
          ? 'Stored in app'
          : (externalCredential?.label ?? null);

    return {
      ...capabilities,
      configurableAuthModes,
      configuredAuthMode,
      apiKeyConfigured,
      apiKeySource,
      apiKeySourceLabel,
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
            }
          : null,
    };
  }

  private async getStoredApiKey(
    providerId: CliProviderId
  ): Promise<{ envVarName: string; value: string } | null> {
    const envVarName = PROVIDER_API_KEY_ENV_VARS[providerId];
    if (!envVarName) {
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

  private async getCodexAccountSnapshot(): Promise<CodexAccountSnapshotDto> {
    if (this.codexAccountFeature) {
      return this.codexAccountFeature.getSnapshot();
    }

    const preferredAuthMode =
      (this.configManager.getConfig().providerConnections.codex.preferredAuthMode as
        | CodexAccountAuthMode
        | undefined) ?? 'auto';
    const storedKey = await this.apiKeyService.lookupPreferred('OPENAI_API_KEY');
    const externalCredential = this.getExternalCredential('codex');
    const apiKeyAvailable = Boolean(storedKey?.value.trim() || externalCredential?.value.trim());
    const apiKey = {
      available: apiKeyAvailable,
      source: storedKey?.value.trim()
        ? 'stored'
        : externalCredential?.value.trim()
          ? 'environment'
          : null,
      sourceLabel: storedKey?.value.trim() ? 'Stored in app' : (externalCredential?.label ?? null),
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
      login: {
        status: 'idle',
        error: null,
        startedAt: null,
      },
      rateLimits: null,
      updatedAt: new Date().toISOString(),
    };
  }

  private async resolveCodexApiKeyValue(
    env: NodeJS.ProcessEnv,
    runtimeBackendOverride?: string | null
  ): Promise<string | null> {
    const codexRuntimeBackend = this.getConfiguredCodexRuntimeBackend(runtimeBackendOverride);
    const storedKey = await this.apiKeyService.lookupPreferred('OPENAI_API_KEY');
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
    const shellEnv = getCachedShellEnv() ?? {};
    const sources = [shellEnv, process.env];

    const findEnvValue = (envVarName: string): string | null => {
      for (const source of sources) {
        const value = source[envVarName];
        if (typeof value === 'string' && value.trim().length > 0) {
          return value;
        }
      }
      return null;
    };

    if (providerId === 'anthropic') {
      const apiKey = findEnvValue('ANTHROPIC_API_KEY');
      if (apiKey) {
        return {
          label: 'Detected from ANTHROPIC_API_KEY',
          value: apiKey,
        };
      }
    }

    if (providerId === 'gemini') {
      const apiKey = findEnvValue('GEMINI_API_KEY');
      if (apiKey) {
        return {
          label: 'Detected from GEMINI_API_KEY',
          value: apiKey,
        };
      }
    }

    if (providerId === 'codex') {
      const nativeApiKey = findEnvValue(CODEX_NATIVE_API_KEY_ENV_VAR);
      if (nativeApiKey) {
        return {
          label: `Detected from ${CODEX_NATIVE_API_KEY_ENV_VAR}`,
          value: nativeApiKey,
        };
      }

      const apiKey = findEnvValue('OPENAI_API_KEY');
      if (apiKey) {
        return {
          label: 'Detected from OPENAI_API_KEY',
          value: apiKey,
        };
      }
    }

    return null;
  }
}

export const providerConnectionService = ProviderConnectionService.getInstance();
