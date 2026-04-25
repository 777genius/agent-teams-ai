import { execCli } from '@main/utils/childProcess';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { createLogger } from '@shared/utils/logger';
import {
  createDefaultCliExtensionCapabilities,
  createLegacyRuntimeFallbackCliExtensionCapabilities,
} from '@shared/utils/providerExtensionCapabilities';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { resolveGeminiRuntimeAuth } from './geminiRuntimeAuth';
import { buildProviderAwareCliEnv } from './providerAwareCliEnv';
import { providerConnectionService } from './ProviderConnectionService';

import type { CliProviderId, CliProviderReasoningEffort, CliProviderStatus } from '@shared/types';

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

interface RuntimeProviderCapabilitiesResponse {
  modelCatalog?: {
    dynamic?: boolean;
    source?: 'anthropic-models-api' | 'app-server' | 'static-fallback' | 'runtime';
  };
  reasoningEffort?: {
    supported?: boolean;
    values?: string[];
    configPassthrough?: boolean;
  };
  fastMode?: {
    supported?: boolean;
    available?: boolean;
    reason?: string | null;
    source?: 'runtime';
  };
}

interface RuntimeProviderModelCatalogItemResponse {
  id?: string;
  launchModel?: string;
  displayName?: string;
  hidden?: boolean;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string | null;
  supportsFastMode?: boolean;
  inputModalities?: string[];
  supportsPersonality?: boolean;
  isDefault?: boolean;
  upgrade?: boolean;
  source?: 'anthropic-models-api' | 'app-server' | 'static-fallback';
  badgeLabel?: string | null;
  statusMessage?: string | null;
}

interface RuntimeProviderModelCatalogResponse {
  schemaVersion?: number;
  providerId?: CliProviderId;
  source?: 'anthropic-models-api' | 'app-server' | 'static-fallback';
  status?: 'ready' | 'stale' | 'degraded' | 'unavailable';
  fetchedAt?: string;
  staleAt?: string;
  defaultModelId?: string | null;
  defaultLaunchModel?: string | null;
  models?: RuntimeProviderModelCatalogItemResponse[];
  diagnostics?: {
    configReadState?: 'ready' | 'unsupported' | 'failed' | 'skipped';
    appServerState?: 'healthy' | 'degraded' | 'runtime-missing' | 'incompatible';
    message?: string | null;
    code?: string | null;
  };
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
      detailMessage?: string | null;
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
      runtimeCapabilities?: RuntimeProviderCapabilitiesResponse;
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
        state?:
          | 'ready'
          | 'locked'
          | 'disabled'
          | 'authentication-required'
          | 'runtime-missing'
          | 'degraded';
        audience?: 'general' | 'internal';
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
      modelCatalog?: RuntimeProviderModelCatalogResponse | null;
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
      runtimeCapabilities?: RuntimeProviderCapabilitiesResponse;
    }
  >;
}

interface OpenCodeRuntimeVerifyResponse {
  schemaVersion?: number;
  providerId?: 'opencode';
  snapshot?: {
    detected?: boolean;
    hostHealthy?: boolean;
    probeError?: string | null;
    diagnostics?: string[];
    host?: {
      version?: string | null;
      resolvedConfigFingerprint?: string | null;
    } | null;
    profile?: {
      profileRootKey?: string;
      projectBehaviorFingerprint?: string;
      managedConfigFingerprint?: string;
    } | null;
    config?: {
      default_agent?: string;
      share?: string | null;
      snapshot?: boolean;
      autoupdate?: boolean | string;
    } | null;
  } | null;
}

export interface OpenCodeRuntimeTranscriptResponse {
  schemaVersion?: number;
  providerId?: 'opencode';
  transcript?: {
    sessionId?: string;
    durableState?: string;
    staleReason?: string | null;
    messageCount?: number;
    toolCallCount?: number;
    errorCount?: number;
    latestAssistantText?: string | null;
    latestAssistantPreview?: string | null;
    messages?: unknown[];
    diagnostics?: string[];
    logProjection?: {
      sessionId?: string;
      durableState?: string;
      sourceMessageCount?: number;
      projectedMessageCount?: number;
      syntheticMessageCount?: number;
      toolCallCount?: number;
      errorCount?: number;
      diagnostics?: string[];
      messages?: OpenCodeRuntimeTranscriptLogMessage[];
    } | null;
  } | null;
}

export type OpenCodeRuntimeTranscriptLogContentBlock =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'thinking';
      thinking: string;
      signature: string;
    }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string | OpenCodeRuntimeTranscriptLogContentBlock[];
      is_error?: boolean;
    };

export interface OpenCodeRuntimeTranscriptLogToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  isTask: boolean;
  taskDescription?: string;
  taskSubagentType?: string;
}

export interface OpenCodeRuntimeTranscriptLogToolResult {
  toolUseId: string;
  content: string | OpenCodeRuntimeTranscriptLogContentBlock[];
  isError: boolean;
}

export interface OpenCodeRuntimeTranscriptLogMessage {
  uuid: string;
  parentUuid: string | null;
  type: 'assistant' | 'user' | 'system';
  timestamp: string;
  role?: string;
  content: OpenCodeRuntimeTranscriptLogContentBlock[] | string;
  model?: string;
  agentName?: string;
  isMeta: boolean;
  sessionId: string;
  toolCalls: OpenCodeRuntimeTranscriptLogToolCall[];
  toolResults: OpenCodeRuntimeTranscriptLogToolResult[];
  sourceToolUseID?: string;
  sourceToolAssistantUUID?: string;
  subtype?: string;
  level?: string;
}

const ORDERED_PROVIDER_IDS: CliProviderId[] = ['anthropic', 'codex', 'gemini', 'opencode'];

function getProviderDisplayName(providerId: CliProviderId): string {
  switch (providerId) {
    case 'anthropic':
      return 'Anthropic';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'opencode':
      return 'OpenCode (75+ LLM providers)';
  }
}

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
    displayName: getProviderDisplayName(providerId),
    supported: false,
    authenticated: false,
    authMethod: null,
    verificationState: 'unknown',
    modelVerificationState: 'idle',
    statusMessage: null,
    detailMessage: null,
    models: [],
    modelAvailability: [],
    canLoginFromUi: providerId !== 'opencode',
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
    modelCatalog: null,
    runtimeCapabilities: null,
  };
}

function mapRuntimeExtensionCapabilities(
  providerId: CliProviderId,
  capabilities?: RuntimeExtensionCapabilitiesResponse
): CliProviderStatus['capabilities']['extensions'] {
  const defaults = capabilities
    ? createDefaultCliExtensionCapabilities()
    : createLegacyRuntimeFallbackCliExtensionCapabilities();
  const pluginStatus =
    providerId === 'opencode'
      ? 'unsupported'
      : (capabilities?.plugins?.status ?? defaults.plugins.status);
  const pluginReason =
    providerId === 'opencode'
      ? (capabilities?.plugins?.reason ??
        'OpenCode does not support plugin management from Agent Teams.')
      : (capabilities?.plugins?.reason ?? defaults.plugins.reason);

  return {
    plugins: {
      ...defaults.plugins,
      status: pluginStatus,
      ownership: capabilities?.plugins?.ownership ?? defaults.plugins.ownership,
      reason: pluginReason,
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

function normalizeRuntimeReasoningEffort(
  value: string | null | undefined
): CliProviderReasoningEffort | null {
  return value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
    ? value
    : null;
}

function collectRuntimeReasoningEfforts(values?: string[]): CliProviderReasoningEffort[] {
  return (
    values?.flatMap((value) => {
      const normalized = normalizeRuntimeReasoningEffort(value);
      return normalized ? [normalized] : [];
    }) ?? []
  );
}

function mapRuntimeProviderModelCatalog(
  providerId: CliProviderId,
  modelCatalog?: RuntimeProviderModelCatalogResponse | null
): CliProviderStatus['modelCatalog'] {
  if (modelCatalog?.providerId !== providerId) {
    return null;
  }

  const fetchedAt = modelCatalog.fetchedAt?.trim();
  const staleAt = modelCatalog.staleAt?.trim();
  const source = modelCatalog.source;
  const status = modelCatalog.status;
  if (
    modelCatalog.schemaVersion !== 1 ||
    !fetchedAt ||
    !staleAt ||
    (source !== 'anthropic-models-api' &&
      source !== 'app-server' &&
      source !== 'static-fallback') ||
    (status !== 'ready' && status !== 'stale' && status !== 'degraded' && status !== 'unavailable')
  ) {
    return null;
  }

  const models: NonNullable<CliProviderStatus['modelCatalog']>['models'] =
    modelCatalog.models?.flatMap((model) => {
      const id = model.id?.trim();
      const launchModel = model.launchModel?.trim();
      const displayName = model.displayName?.trim();
      if (!id || !launchModel || !displayName) {
        return [];
      }

      const supportedReasoningEfforts = collectRuntimeReasoningEfforts(
        model.supportedReasoningEfforts
      );
      const defaultReasoningEffort = normalizeRuntimeReasoningEffort(
        model.defaultReasoningEffort ?? null
      );
      const itemSource =
        model.source === 'anthropic-models-api' ||
        model.source === 'app-server' ||
        model.source === 'static-fallback'
          ? model.source
          : source;

      return [
        {
          id,
          launchModel,
          displayName,
          hidden: model.hidden === true,
          supportedReasoningEfforts,
          defaultReasoningEffort,
          supportsFastMode: model.supportsFastMode === true,
          inputModalities: model.inputModalities?.filter((value) => value.trim().length > 0) ?? [],
          supportsPersonality: model.supportsPersonality === true,
          isDefault: model.isDefault === true,
          upgrade: model.upgrade === true,
          source: itemSource,
          badgeLabel: model.badgeLabel ?? null,
          statusMessage: model.statusMessage ?? null,
        },
      ];
    }) ?? [];

  return {
    schemaVersion: 1,
    providerId,
    source,
    status,
    fetchedAt,
    staleAt,
    defaultModelId: modelCatalog.defaultModelId ?? null,
    defaultLaunchModel: modelCatalog.defaultLaunchModel ?? null,
    models,
    diagnostics: {
      configReadState: modelCatalog.diagnostics?.configReadState ?? 'skipped',
      appServerState: modelCatalog.diagnostics?.appServerState ?? 'degraded',
      message: modelCatalog.diagnostics?.message ?? null,
      code: modelCatalog.diagnostics?.code ?? null,
    },
  };
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
      detailMessage: runtimeStatus.detailMessage ?? null,
      canLoginFromUi: runtimeStatus.canLoginFromUi !== false,
      capabilities: {
        teamLaunch: runtimeStatus.capabilities?.teamLaunch === true,
        oneShot: runtimeStatus.capabilities?.oneShot === true,
        extensions: mapRuntimeExtensionCapabilities(
          providerId,
          runtimeStatus.capabilities?.extensions
        ),
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
          state: backend.state ?? undefined,
          audience: backend.audience ?? undefined,
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
      modelCatalog: mapRuntimeProviderModelCatalog(providerId, runtimeStatus.modelCatalog),
      backend: runtimeStatus.backend?.kind
        ? {
            kind: runtimeStatus.backend.kind,
            label: runtimeStatus.backend.label ?? runtimeStatus.backend.kind,
            endpointLabel: runtimeStatus.backend.endpointLabel ?? null,
            projectId: runtimeStatus.backend.projectId ?? null,
            authMethodDetail: runtimeStatus.backend.authMethodDetail ?? null,
          }
        : null,
      runtimeCapabilities: runtimeStatus.runtimeCapabilities
        ? {
            modelCatalog: runtimeStatus.runtimeCapabilities.modelCatalog
              ? {
                  dynamic: runtimeStatus.runtimeCapabilities.modelCatalog.dynamic === true,
                  source: runtimeStatus.runtimeCapabilities.modelCatalog.source,
                }
              : undefined,
            reasoningEffort: runtimeStatus.runtimeCapabilities.reasoningEffort
              ? {
                  supported: runtimeStatus.runtimeCapabilities.reasoningEffort.supported === true,
                  values: collectRuntimeReasoningEfforts(
                    runtimeStatus.runtimeCapabilities.reasoningEffort.values
                  ),
                  configPassthrough:
                    runtimeStatus.runtimeCapabilities.reasoningEffort.configPassthrough === true,
                }
              : undefined,
            fastMode: runtimeStatus.runtimeCapabilities.fastMode
              ? {
                  supported: runtimeStatus.runtimeCapabilities.fastMode.supported === true,
                  available: runtimeStatus.runtimeCapabilities.fastMode.available === true,
                  reason: runtimeStatus.runtimeCapabilities.fastMode.reason ?? null,
                  source: 'runtime',
                }
              : undefined,
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
      detailMessage: null,
      backend: null,
    };
  }

  private applyConnectionIssues(
    providers: CliProviderStatus[],
    connectionIssues: Partial<Record<CliProviderId, string>>
  ): CliProviderStatus[] {
    return providers.map((provider) => this.applyConnectionIssue(provider, connectionIssues));
  }

  private async getOpenCodeVerifySnapshot(
    binaryPath: string
  ): Promise<OpenCodeRuntimeVerifyResponse['snapshot'] | null> {
    const { env } = await this.buildCliEnv(binaryPath);
    const { stdout } = await execCli(
      binaryPath,
      ['runtime', 'verify', '--json', '--provider', 'opencode'],
      {
        timeout: PROVIDER_STATUS_TIMEOUT_MS,
        env,
      }
    );
    const parsed = extractJsonObject<OpenCodeRuntimeVerifyResponse>(stdout);
    return parsed.providerId === 'opencode' ? (parsed.snapshot ?? null) : null;
  }

  private mergeOpenCodeVerification(
    provider: CliProviderStatus,
    snapshot: OpenCodeRuntimeVerifyResponse['snapshot']
  ): CliProviderStatus {
    if (!snapshot) {
      return provider;
    }

    const diagnostics = snapshot.diagnostics ?? [];
    const diagnosticsSummary = diagnostics.slice(0, 2).join(' - ');
    const liveIssuesPresent =
      snapshot.detected === false ||
      snapshot.hostHealthy !== true ||
      Boolean(snapshot.probeError) ||
      diagnostics.length > 0;

    const detailParts = [
      provider.detailMessage ?? null,
      snapshot.host?.resolvedConfigFingerprint
        ? `live ${snapshot.host.resolvedConfigFingerprint.slice(0, 12)}`
        : null,
      snapshot.profile?.managedConfigFingerprint
        ? `managed ${snapshot.profile.managedConfigFingerprint.slice(0, 12)}`
        : null,
      snapshot.profile?.projectBehaviorFingerprint
        ? `behavior ${snapshot.profile.projectBehaviorFingerprint.slice(0, 12)}`
        : null,
      diagnosticsSummary || null,
    ].filter((value): value is string => Boolean(value));

    const nextDiagnostics = [
      ...(provider.externalRuntimeDiagnostics ?? []),
      {
        id: 'opencode-live-host',
        label: 'OpenCode live host',
        detected: snapshot.hostHealthy === true,
        statusMessage: snapshot.hostHealthy === true ? 'Healthy' : 'Unavailable',
        detailMessage: snapshot.probeError ?? null,
      },
      {
        id: 'opencode-managed-runtime',
        label: 'OpenCode managed runtime',
        detected: !liveIssuesPresent,
        statusMessage: liveIssuesPresent
          ? 'Live verification found runtime drift'
          : 'Managed runtime verified',
        detailMessage: diagnosticsSummary || null,
      },
    ];

    return {
      ...provider,
      verificationState: liveIssuesPresent ? 'error' : 'verified',
      statusMessage: liveIssuesPresent
        ? (snapshot.probeError ??
          diagnostics[0] ??
          'OpenCode live verification found runtime drift')
        : provider.statusMessage,
      detailMessage: detailParts.length > 0 ? detailParts.join(' - ') : provider.detailMessage,
      externalRuntimeDiagnostics: nextDiagnostics,
      backend: provider.backend
        ? {
            ...provider.backend,
            authMethodDetail:
              snapshot.config?.default_agent === 'teammate'
                ? 'managed teammate agent'
                : (provider.backend.authMethodDetail ?? null),
          }
        : provider.backend,
    };
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

  async verifyProviderStatus(
    binaryPath: string,
    providerId: CliProviderId
  ): Promise<CliProviderStatus> {
    const provider = await this.getProviderStatus(binaryPath, providerId);
    if (providerId !== 'opencode') {
      return provider;
    }

    try {
      const snapshot = await this.getOpenCodeVerifySnapshot(binaryPath);
      return this.mergeOpenCodeVerification(provider, snapshot);
    } catch (error) {
      logger.warn(
        `OpenCode live verification unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return {
        ...provider,
        verificationState: 'error',
        statusMessage: 'OpenCode live verification failed',
        detailMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getOpenCodeTranscript(
    binaryPath: string,
    params: {
      teamId: string;
      memberName: string;
      limit?: number;
    }
  ): Promise<OpenCodeRuntimeTranscriptResponse['transcript'] | null> {
    const { env } = await this.buildCliEnv(binaryPath);
    const args = [
      'runtime',
      'transcript',
      '--json',
      '--provider',
      'opencode',
      '--team',
      params.teamId,
      '--member',
      params.memberName,
      '--projection-only',
    ];
    if (typeof params.limit === 'number') {
      args.push('--limit', String(params.limit));
    }

    const outputDir = await mkdtemp(path.join(tmpdir(), 'opencode-transcript-'));
    const outputPath = path.join(outputDir, 'transcript.json');
    try {
      await execCli(binaryPath, [...args, '--output', outputPath], {
        timeout: PROVIDER_STATUS_TIMEOUT_MS,
        env,
      });
      const parsed = extractJsonObject<OpenCodeRuntimeTranscriptResponse>(
        await readFile(outputPath, 'utf8')
      );
      return parsed.providerId === 'opencode' ? (parsed.transcript ?? null) : null;
    } finally {
      await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async verifyOpenCodeModels(
    _binaryPath: string,
    provider: CliProviderStatus
  ): Promise<CliProviderStatus> {
    return {
      ...provider,
      modelVerificationState: 'idle',
      modelAvailability: [],
    };
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
            detailMessage: runtimeStatus.detailMessage ?? null,
            canLoginFromUi: runtimeStatus.canLoginFromUi !== false,
            capabilities: {
              teamLaunch: runtimeStatus.capabilities?.teamLaunch === true,
              oneShot: runtimeStatus.capabilities?.oneShot === true,
              extensions: mapRuntimeExtensionCapabilities(
                providerId,
                runtimeStatus.capabilities?.extensions
              ),
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
