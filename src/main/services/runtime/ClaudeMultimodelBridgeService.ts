import { execCli } from '@main/utils/childProcess';
import { buildEnrichedEnv } from '@main/utils/cliEnv';
import {
  getCachedShellEnv,
  getShellPreferredHome,
  resolveInteractiveShellEnv,
} from '@main/utils/shellEnv';
import { createLogger } from '@shared/utils/logger';

import type { CliProviderId, CliProviderStatus } from '@shared/types';
import { resolveGeminiRuntimeAuth } from './geminiRuntimeAuth';

const logger = createLogger('ClaudeMultimodelBridgeService');

const PROVIDER_STATUS_TIMEOUT_MS = 10_000;
const PROVIDER_MODELS_TIMEOUT_MS = 10_000;

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
      models?: Array<string | { id?: string; label?: string; description?: string }>;
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
    statusMessage: null,
    models: [],
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: false,
      oneShot: false,
    },
    backend: null,
  };
}

function extractModelIds(
  models: Array<string | { id?: string; label?: string; description?: string }> | undefined
): string[] {
  if (!models) {
    return [];
  }

  return models.flatMap((model) => {
    if (typeof model === 'string') {
      return model;
    }
    if (typeof model?.id === 'string' && model.id.trim().length > 0) {
      return model.id.trim();
    }
    return [];
  });
}

export class ClaudeMultimodelBridgeService {
  private buildCliEnv(binaryPath: string): NodeJS.ProcessEnv {
    const shellEnv = getCachedShellEnv() ?? {};
    const home =
      getShellPreferredHome() || shellEnv.HOME || process.env.HOME || process.env.USERPROFILE;
    const env = {
      ...buildEnrichedEnv(binaryPath),
      ...shellEnv,
    };
    if (home) {
      env.HOME = home;
    }
    return env;
  }

  private buildProviderCliEnv(binaryPath: string, providerId: CliProviderId): NodeJS.ProcessEnv {
    const env = { ...this.buildCliEnv(binaryPath) };
    delete env.CLAUDE_CODE_USE_OPENAI;
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_CODE_USE_VERTEX;
    delete env.CLAUDE_CODE_USE_FOUNDRY;
    delete env.CLAUDE_CODE_USE_GEMINI;

    if (providerId === 'codex') {
      env.CLAUDE_CODE_USE_OPENAI = '1';
    } else if (providerId === 'gemini') {
      env.CLAUDE_CODE_USE_GEMINI = '1';
    }

    return env;
  }

  private async buildGeminiStatus(binaryPath: string): Promise<CliProviderStatus> {
    const provider = createDefaultProviderStatus('gemini');
    const env = this.buildProviderCliEnv(binaryPath, 'gemini');

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
    const env = this.buildCliEnv(binaryPath);

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

    return ORDERED_PROVIDER_IDS.map((providerId) => providers.get(providerId)!);
  }
}
