import { getCachedShellEnv } from '@main/utils/shellEnv';

import { ApiKeyService } from '../extensions/apikeys/ApiKeyService';
import { ConfigManager } from '../infrastructure/ConfigManager';

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
    supportsOAuth: true,
    supportsApiKey: true,
    configurableAuthModes: [],
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

const CODEX_API_KEY_BETA_ENV_VAR = 'CLAUDE_CODE_CODEX_API_KEY_BETA';

export class ProviderConnectionService {
  private static instance: ProviderConnectionService | null = null;

  constructor(
    private readonly apiKeyService = new ApiKeyService(),
    private readonly configManager = ConfigManager.getInstance()
  ) {}

  static getInstance(): ProviderConnectionService {
    ProviderConnectionService.instance ??= new ProviderConnectionService();
    return ProviderConnectionService.instance;
  }

  getConfiguredAuthMode(providerId: CliProviderId): CliProviderAuthMode | null {
    if (providerId === 'anthropic') {
      return this.configManager.getConfig().providerConnections.anthropic.authMode;
    }

    if (providerId === 'codex') {
      const codexConnection = this.configManager.getConfig().providerConnections.codex;
      return codexConnection.apiKeyBetaEnabled ? codexConnection.authMode : null;
    }

    return null;
  }

  async applyConfiguredConnectionEnv(
    env: NodeJS.ProcessEnv,
    providerId: CliProviderId
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

    const codexConnection = this.configManager.getConfig().providerConnections.codex;
    if (!codexConnection.apiKeyBetaEnabled) {
      delete env[CODEX_API_KEY_BETA_ENV_VAR];
      delete env.OPENAI_API_KEY;
      return env;
    }

    env[CODEX_API_KEY_BETA_ENV_VAR] = '1';

    if (codexConnection.authMode === 'oauth') {
      env.CLAUDE_CODE_CODEX_BACKEND = 'adapter';
      delete env.OPENAI_API_KEY;
      return env;
    }

    env.CLAUDE_CODE_CODEX_BACKEND = 'api';

    const storedKey = await this.apiKeyService.lookupPreferred('OPENAI_API_KEY');
    if (storedKey?.value.trim()) {
      env.OPENAI_API_KEY = storedKey.value;
      return env;
    }

    if (typeof env.OPENAI_API_KEY !== 'string' || !env.OPENAI_API_KEY.trim()) {
      delete env.OPENAI_API_KEY;
    }

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
    providerId: CliProviderId
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

    const codexConnection = this.configManager.getConfig().providerConnections.codex;
    if (!codexConnection.apiKeyBetaEnabled) {
      return env;
    }

    env[CODEX_API_KEY_BETA_ENV_VAR] = '1';
    env.CLAUDE_CODE_CODEX_BACKEND = codexConnection.authMode === 'oauth' ? 'adapter' : 'api';

    if (codexConnection.authMode !== 'api_key') {
      return env;
    }

    const storedKey = await this.apiKeyService.lookupPreferred('OPENAI_API_KEY');
    if (storedKey?.value.trim()) {
      env.OPENAI_API_KEY = storedKey.value;
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
    providerId: CliProviderId
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

    const codexConnection = this.configManager.getConfig().providerConnections.codex;
    if (!codexConnection.apiKeyBetaEnabled || codexConnection.authMode !== 'api_key') {
      return null;
    }

    if (typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.trim()) {
      return null;
    }

    return (
      'Codex API key mode is enabled, but no OPENAI_API_KEY is configured. ' +
      'Add a stored/environment API key or switch Codex auth mode back to OAuth.'
    );
  }

  async getConfiguredConnectionIssues(
    env: NodeJS.ProcessEnv,
    providerIds: readonly CliProviderId[] = ['anthropic', 'codex', 'gemini']
  ): Promise<Partial<Record<CliProviderId, string>>> {
    const issues: Partial<Record<CliProviderId, string>> = {};

    for (const providerId of providerIds) {
      const issue = await this.getConfiguredConnectionIssue(env, providerId);
      if (issue) {
        issues[providerId] = issue;
      }
    }

    return issues;
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
    const codexBetaEnabled =
      providerId === 'codex'
        ? this.configManager.getConfig().providerConnections.codex.apiKeyBetaEnabled
        : undefined;
    const configurableAuthModes =
      providerId === 'codex' && codexBetaEnabled
        ? (['oauth', 'api_key'] as CliProviderAuthMode[])
        : capabilities.configurableAuthModes;
    const configuredAuthMode =
      providerId === 'codex' && !codexBetaEnabled ? null : this.getConfiguredAuthMode(providerId);

    return {
      ...capabilities,
      configurableAuthModes,
      configuredAuthMode,
      apiKeyBetaAvailable: providerId === 'codex' ? true : undefined,
      apiKeyBetaEnabled: codexBetaEnabled,
      apiKeyConfigured: Boolean(storedApiKey?.value.trim() || externalCredential?.value.trim()),
      apiKeySource: storedApiKey?.value.trim()
        ? 'stored'
        : externalCredential?.value.trim()
          ? 'environment'
          : null,
      apiKeySourceLabel: storedApiKey?.value.trim()
        ? 'Stored in app'
        : (externalCredential?.label ?? null),
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
