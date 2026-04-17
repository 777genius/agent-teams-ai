import { execCli } from '@main/utils/childProcess';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { createLogger } from '@shared/utils/logger';
import {
  createDefaultCliExtensionCapabilities,
  createLegacyRuntimeFallbackCliExtensionCapabilities,
} from '@shared/utils/providerExtensionCapabilities';

import { resolveGeminiRuntimeAuth } from './geminiRuntimeAuth';
import { buildProviderAwareCliEnv } from './providerAwareCliEnv';
import { providerConnectionService } from './ProviderConnectionService';

import type { CliProviderId, CliProviderStatus } from '@shared/types';

const logger = createLogger('ClaudeMultimodelBridgeService');

const PROVIDER_STATUS_TIMEOUT_MS = 10_000;
const PROVIDER_MODELS_TIMEOUT_MS = 10_000;

interface RuntimeExtensionCapabilityResponse {
  status?: 'supported' | 'read-only' | 'unsupported';
  ownership?: 'shared' | 'provider-scoped';
  reason?: string | null;
}

interface RuntimeExtensionCapabilitiesResponse {
  plugins?: RuntimeExtensionCapabilityResponse;
  mcp?: RuntimeExtensionCapabilityResponse;
  skills?: RuntimeExtensionCapabilityResponse;
  apiKeys?: RuntimeExtensionCapabilityResponse;
}

interface ProviderStatusCommandResponse {
  schemaVersion?: number;
  providers?: Record<
    string,
    {
      supported?: boolean;
      authenticated?: boolean;
      authMethod?: string | null;
      verificationState?: 'verified' | 'unknown' | 'offline' | 'error';
      canLoginFromUi?: boolean;
      statusMessage?: string | null;
      capabilities?: {
        teamLaunch?: boolean;
        oneShot?: boolean;
        extensions?: RuntimeExtensionCapabilitiesResponse;
      };
      backend?: {
        kind?: string;
        label?: string;
        endpointLabel?: string | null;
        projectId?: string | null;
        authMethodDetail?: string | null;
      } | null;
    }
  >;
}

interface ProviderModelsCommandResponse {
  schemaVersion?: number;
  providers?: Record<
    string,
    {
      models?: (string | { id?: string; label?: string; description?: string })[];
    }
  >;
}

interface UnifiedRuntimeStatusResponse {
  schemaVersion?: number;
  providers?: Record<
    string,
    {
      supported?: boolean;
      authenticated?: boolean;
      authMethod?: string | null;
      verificationState?: 'verified' | 'unknown' | 'offline' | 'error';
      canLoginFromUi?: boolean;
      statusMessage?: string | null;
      detailMessage?: string | null;
      selectedBackendId?: string | null;
      resolvedBackendId?: string | null;
      availableBackends?: {
        id?: string;
        label?: string;
        description?: string;
        selectable?: boolean;
        recommended?: boolean;
        available?: boolean;
        statusMessage?: string | null;
        detailMessage?: string | null;
      }[];
      externalRuntimeDiagnostics?: {
        id?: string;
        label?: string;
        detected?: boolean;
        statusMessage?: string | null;
        detailMessage?: string | null;
      }[];
      models?: (string | { id?: string; label?: string; description?: string })[];
      capabilities?: {
        teamLaunch?: boolean;
        oneShot?: boolean;
        extensions?: RuntimeExtensionCapabilitiesResponse;
      };
      backend?: {
        kind?: string;
        label?: string;
        endpointLabel?: string | null;
        projectId?: string | null;
        authMethodDetail?: string | null;
      } | null;
    }
  >;
}

const ORDERED_PROVIDER_IDS: CliProviderId[] = ['anthropic', 'codex', 'gemini'];

function extractJsonObject<T>(raw: string): T {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    }
    throw new Error('No JSON object found in CLI output');
  }
}

function createDefaultProviderStatus(providerId: CliProviderId): CliProviderStatus {
  return {
    providerId,
    displayName:
      providerId === 'anthropic' ? 'Anthropic' : providerId === 'codex' ? 'Codex' : 'Gemini',
    supported: false,
    authenticated: false,
    authMethod: null,
    verificationState: 'unknown',
    modelVerificationState: 'idle',
    statusMessage: null,
    models: [],
    modelAvailability: [],
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: false,
      oneShot: false,
      extensions: createLegacyRuntimeFallbackCliExtensionCapabilities(),
    },
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    backend: null,
    connection: null,
  };
}

function mapRuntimeExtensionCapabilities(
  capabilities?: RuntimeExtensionCapabilitiesResponse
): CliProviderStatus['capabilities']['extensions'] {
  const defaults = capabilities
    ? createDefaultCliExtensionCapabilities()
    : createLegacyRuntimeFallbackCliExtensionCapabilities();

  return {
    plugins: {
      ...defaults.plugins,
      status: capabilities?.plugins?.status ?? defaults.plugins.status,
      ownership: capabilities?.plugins?.ownership ?? defaults.plugins.ownership,
      reason: capabilities?.plugins?.reason ?? defaults.plugins.reason,
    },
    mcp: {
      ...defaults.mcp,
      status: capabilities?.mcp?.status ?? defaults.mcp.status,
      ownership: capabilities?.mcp?.ownership ?? defaults.mcp.ownership,
      reason: capabilities?.mcp?.reason ?? defaults.mcp.reason,
    },
    skills: {
      ...defaults.skills,
      status: capabilities?.skills?.status ?? defaults.skills.status,
      ownership: capabilities?.skills?.ownership ?? defaults.skills.ownership,
      reason: capabilities?.skills?.reason ?? defaults.skills.reason,
    },
    apiKeys: {
      ...defaults.apiKeys,
      status: capabilities?.apiKeys?.status ?? defaults.apiKeys.status,
      ownership: capabilities?.apiKeys?.ownership ?? defaults.apiKeys.ownership,
      reason: capabilities?.apiKeys?.reason ?? defaults.apiKeys.reason,
    },
  };
}

function extractModelIds(
  models: (string | { id?: string; label?: string; description?: string })[] | undefined
): string[] {
  if (!models) {
    return [];
  }

  return models.flatMap<string>((model) => {
    if (typeof model === 'string') {
      return [model];
    }
    if (typeof model?.id === 'string' && model.id.trim().length > 0) {
      return [model.id.trim()];
    }
    return [];
  });
}

export class ClaudeMultimodelBridgeService {
  private async buildCliEnv(
    binaryPath: string
  ): Promise<Awaited<ReturnType<typeof buildProviderAwareCliEnv>>> {
    return buildProviderAwareCliEnv({ binaryPath });
  }

  private async buildProviderCliEnv(
    binaryPath: string,
    providerId: CliProviderId
  ): Promise<Awaited<ReturnType<typeof buildProviderAwareCliEnv>>> {
    return buildProviderAwareCliEnv({ binaryPath, providerId });
  }

  private isUnifiedRuntimeUnsupported(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    return (
      lower.includes('unknown command') ||
      lower.includes('unknown option') ||
      lower.includes('no such command') ||
      lower.includes('did you mean') ||
      lower.includes('runtime status')
    );
  }

  private mapRuntimeProviderStatus(
    providerId: CliProviderId,
    runtimeStatus: NonNullable<UnifiedRuntimeStatusResponse['providers']>[string] | undefined
  ): CliProviderStatus {
    const provider = createDefaultProviderStatus(providerId);
    if (!runtimeStatus) {
      return provider;
    }

    return {
      ...provider,
      supported: runtimeStatus.supported === true,
      authenticated: runtimeStatus.authenticated === true,
      authMethod: runtimeStatus.authMethod ?? null,
      verificationState: runtimeStatus.verificationState ?? 'unknown',
      statusMessage: runtimeStatus.statusMessage ?? null,
      canLoginFromUi: runtimeStatus.canLoginFromUi !== false,
      capabilities: {
        teamLaunch: runtimeStatus.capabilities?.teamLaunch === true,
        oneShot: runtimeStatus.capabilities?.oneShot === true,
        extensions: mapRuntimeExtensionCapabilities(runtimeStatus.capabilities?.extensions),
      },
      selectedBackendId: runtimeStatus.selectedBackendId ?? null,
      resolvedBackendId: runtimeStatus.resolvedBackendId ?? null,
      availableBackends:
        runtimeStatus.availableBackends?.map((backend) => ({
          id: backend.id ?? 'unknown',
          label: backend.label ?? backend.id ?? 'Unknown',
          description: backend.description ?? '',
          selectable: backend.selectable !== false,
          recommended: backend.recommended === true,
          available: backend.available === true,
          statusMessage: backend.statusMessage ?? null,
          detailMessage: backend.detailMessage ?? null,
        })) ?? [],
      externalRuntimeDiagnostics:
        runtimeStatus.externalRuntimeDiagnostics?.map((diagnostic) => ({
          id: diagnostic.id ?? 'unknown',
          label: diagnostic.label ?? diagnostic.id ?? 'Unknown',
          detected: diagnostic.detected === true,
          statusMessage: diagnostic.statusMessage ?? null,
          detailMessage: diagnostic.detailMessage ?? null,
        })) ?? [],
      models: extractModelIds(runtimeStatus.models),
      backend: runtimeStatus.backend?.kind
        ? {
            kind: runtimeStatus.backend.kind,
            label: runtimeStatus.backend.label ?? runtimeStatus.backend.kind,
            endpointLabel: runtimeStatus.backend.endpointLabel ?? null,
            projectId: runtimeStatus.backend.projectId ?? null,
            authMethodDetail: runtimeStatus.backend.authMethodDetail ?? null,
          }
        : null,
    };
  }

  private applyConnectionIssue(
    provider: CliProviderStatus,
    connectionIssues: Partial<Record<CliProviderId, string>>
  ): CliProviderStatus {
    const issue = connectionIssues[provider.providerId];
    if (!issue) {
      return provider;
    }

    return {
      ...provider,
      authenticated: false,
      authMethod: null,
      verificationState: 'error',
      statusMessage: issue,
      backend: null,
    };
  }

  private applyConnectionIssues(
    providers: CliProviderStatus[],
    connectionIssues: Partial<Record<CliProviderId, string>>
  ): CliProviderStatus[] {
    return providers.map((provider) => this.applyConnectionIssue(provider, connectionIssues));
  }

  async getProviderStatus(
    binaryPath: string,
    providerId: CliProviderId
  ): Promise<CliProviderStatus> {
    await resolveInteractiveShellEnv();
    const { env, connectionIssues } = await this.buildCliEnv(binaryPath);

    try {
      const { stdout } = await execCli(
        binaryPath,
        ['runtime', 'status', '--json', '--provider', providerId],
        {
          timeout: PROVIDER_STATUS_TIMEOUT_MS,
          env,
        }
      );
      const parsed = extractJsonObject<UnifiedRuntimeStatusResponse>(stdout);
      return providerConnectionService.enrichProviderStatus(
        this.applyConnectionIssue(
          this.mapRuntimeProviderStatus(providerId, parsed.providers?.[providerId]),
          connectionIssues
        )
      );
    } catch (error) {
      if (!this.isUnifiedRuntimeUnsupported(error)) {
        logger.warn(
          `Provider-scoped runtime status unavailable for ${providerId}, falling back to full probe: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    const providers = await this.getProviderStatuses(binaryPath);
    return (
      providers.find((provider) => provider.providerId === providerId) ??
      createDefaultProviderStatus(providerId)
    );
  }

  private async buildGeminiStatus(binaryPath: string): Promise<CliProviderStatus> {
    const provider = createDefaultProviderStatus('gemini');
    const { env } = await this.buildProviderCliEnv(binaryPath, 'gemini');

    try {
      const { stdout } = await execCli(
        binaryPath,
        ['model', 'list', '--json', '--provider', 'all'],
        {
          timeout: PROVIDER_MODELS_TIMEOUT_MS,
          env,
        }
      );
      const parsed = extractJsonObject<ProviderModelsCommandResponse>(stdout);
      const models = extractModelIds(parsed.providers?.gemini?.models);
      if (models.length > 0) {
        provider.supported = true;
        provider.models = models;
        provider.capabilities = {
          teamLaunch: true,
          oneShot: true,
          extensions: createDefaultCliExtensionCapabilities(),
        };
      }
    } catch (error) {
      logger.warn(
        `Gemini model list unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const authState = await resolveGeminiRuntimeAuth(env);
    if (authState.authenticated) {
      provider.authenticated = true;
      provider.authMethod =
        authState.authMethod === 'adc_authorized_user' ||
        authState.authMethod === 'adc_service_account'
          ? `gemini_${authState.authMethod}`
          : authState.authMethod;
      provider.verificationState = 'verified';
      provider.statusMessage = null;
      if (authState.authMethod === 'cli_oauth_personal') {
        provider.backend = {
          kind: 'cli',
          label: 'Gemini CLI',
          endpointLabel: 'Code Assist (cloudcode-pa.googleapis.com/v1internal)',
          projectId: authState.projectId,
          authMethodDetail: authState.authMethod,
        };
      }
      return provider;
    }

    provider.statusMessage =
      authState.statusMessage ?? 'Set GEMINI_API_KEY or Google ADC to use Gemini.';
    return provider;
  }

  async getProviderStatuses(
    binaryPath: string,
    onUpdate?: (providers: CliProviderStatus[]) => void
  ): Promise<CliProviderStatus[]> {
    await resolveInteractiveShellEnv();
    const { env, connectionIssues } = await this.buildCliEnv(binaryPath);

    try {
      const { stdout } = await execCli(binaryPath, ['runtime', 'status', '--json'], {
        timeout: PROVIDER_STATUS_TIMEOUT_MS,
        env,
      });
      const parsed = extractJsonObject<UnifiedRuntimeStatusResponse>(stdout);
      const providers = await providerConnectionService.enrichProviderStatuses(
        this.applyConnectionIssues(
          ORDERED_PROVIDER_IDS.map((providerId) =>
            this.mapRuntimeProviderStatus(providerId, parsed.providers?.[providerId])
          ),
          connectionIssues
        )
      );
      onUpdate?.(providers);
      return providers;
    } catch (error) {
      if (!this.isUnifiedRuntimeUnsupported(error)) {
        logger.warn(
          `Unified runtime status unavailable, falling back to legacy probes: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    const [statusResult, modelsResult] = await Promise.allSettled([
      execCli(binaryPath, ['auth', 'status', '--json', '--provider', 'all'], {
        timeout: PROVIDER_STATUS_TIMEOUT_MS,
        env,
      }),
      execCli(binaryPath, ['model', 'list', '--json', '--provider', 'all'], {
        timeout: PROVIDER_MODELS_TIMEOUT_MS,
        env,
      }),
    ]);

    const providers = new Map<CliProviderId, CliProviderStatus>(
      ORDERED_PROVIDER_IDS.map((providerId) => [
        providerId,
        createDefaultProviderStatus(providerId),
      ])
    );

    if (statusResult.status === 'fulfilled') {
      try {
        const parsed = extractJsonObject<ProviderStatusCommandResponse>(statusResult.value.stdout);
        for (const providerId of ORDERED_PROVIDER_IDS.filter((id) => id !== 'gemini')) {
          const runtimeStatus = parsed.providers?.[providerId];
          if (!runtimeStatus) continue;
          providers.set(providerId, {
            ...providers.get(providerId)!,
            supported: runtimeStatus.supported === true,
            authenticated: runtimeStatus.authenticated === true,
            authMethod: runtimeStatus.authMethod ?? null,
            verificationState: runtimeStatus.verificationState ?? 'unknown',
            statusMessage: runtimeStatus.statusMessage ?? null,
            canLoginFromUi: runtimeStatus.canLoginFromUi !== false,
            capabilities: {
              teamLaunch: runtimeStatus.capabilities?.teamLaunch === true,
              oneShot: runtimeStatus.capabilities?.oneShot === true,
              extensions: mapRuntimeExtensionCapabilities(runtimeStatus.capabilities?.extensions),
            },
            backend: runtimeStatus.backend?.kind
              ? {
                  kind: runtimeStatus.backend.kind,
                  label: runtimeStatus.backend.label ?? runtimeStatus.backend.kind,
                  endpointLabel: runtimeStatus.backend.endpointLabel ?? null,
                  projectId: runtimeStatus.backend.projectId ?? null,
                  authMethodDetail: runtimeStatus.backend.authMethodDetail ?? null,
                }
              : null,
          });
          onUpdate?.(ORDERED_PROVIDER_IDS.map((id) => providers.get(id)!));
        }
      } catch (error) {
        logger.warn(
          `Failed to parse provider auth status JSON: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    } else {
      const message =
        statusResult.reason instanceof Error
          ? statusResult.reason.message
          : String(statusResult.reason);
      logger.warn(`Provider auth status unavailable: ${message}`);
      for (const providerId of ORDERED_PROVIDER_IDS) {
        providers.set(providerId, {
          ...providers.get(providerId)!,
          statusMessage: 'Provider status not supported by current claude-multimodel build',
        });
        onUpdate?.(ORDERED_PROVIDER_IDS.map((id) => providers.get(id)!));
      }
    }

    if (modelsResult.status === 'fulfilled') {
      try {
        const parsed = extractJsonObject<ProviderModelsCommandResponse>(modelsResult.value.stdout);
        for (const providerId of ORDERED_PROVIDER_IDS.filter((id) => id !== 'gemini')) {
          const runtimeModels = extractModelIds(parsed.providers?.[providerId]?.models);
          if (runtimeModels.length === 0) continue;
          providers.set(providerId, {
            ...providers.get(providerId)!,
            models: runtimeModels,
          });
          onUpdate?.(ORDERED_PROVIDER_IDS.map((id) => providers.get(id)!));
        }
      } catch (error) {
        logger.warn(
          `Failed to parse provider models JSON: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    providers.set('gemini', await this.buildGeminiStatus(binaryPath));
    onUpdate?.(ORDERED_PROVIDER_IDS.map((id) => providers.get(id)!));

    const enrichedProviders = await providerConnectionService.enrichProviderStatuses(
      this.applyConnectionIssues(
        ORDERED_PROVIDER_IDS.map((providerId) => providers.get(providerId)!),
        connectionIssues
      )
    );
    onUpdate?.(enrichedProviders);

    return enrichedProviders;
  }
}
