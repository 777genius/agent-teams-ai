import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';
import { isOpenCodeLocalProviderId } from '@shared/utils/opencodeModelRoute';

import { readResponseTextWithLimit } from './boundedResponseBody';
import { buildLocalServerModelMetadataRequest } from './localServerRuntimeApi';
import {
  buildOllamaNativeUrl,
  parseOllamaRunningContextTokens,
  parseOllamaShowMetadata,
} from './ollamaRuntimeApi';
import {
  type OpenCodeLocalModelCoordinationProbeResult,
  probeOpenCodeLocalModelCoordination,
} from './OpenCodeLocalModelCoordinationProbe';
import { OpenCodeLocalProviderConnector } from './OpenCodeLocalProviderConnector';

import type { RuntimeLocalProviderListEntryDto } from '../../contracts';
import type { RuntimeLocalProviderConnectorPort } from '../../core/application';

export const MIN_AGENT_TEAMS_LOCAL_CONTEXT_TOKENS = 16_384;
export const RECOMMENDED_AGENT_TEAMS_LOCAL_CONTEXT_TOKENS = 65_536;
export const MIN_AGENT_TEAMS_LOCAL_PARAMETER_COUNT = 3_000_000_000;

const INSPECTION_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_COORDINATION_PROBE_ATTEMPTS = 2;
const COORDINATION_PROBE_RETRY_DELAY_MS = 500;
const COORDINATION_PROBE_TOTAL_TIMEOUT_MS = 90_000;

export interface OpenCodeLocalModelRuntimeReadiness {
  readonly providerId: string;
  readonly modelId: string;
  readonly presetId: RuntimeLocalProviderListEntryDto['preset']['id'];
  readonly toolCapable: boolean | null;
  readonly parameterCount: number | null;
  readonly trainedContextTokens: number | null;
  readonly configuredContextTokens: number | null;
  readonly effectiveContextTokens: number | null;
  readonly coordinationProbeStatus: OpenCodeLocalModelCoordinationProbeResult['status'] | null;
  readonly severity: 'ready' | 'warning' | 'blocking';
  readonly experimentalOverrideAvailable?: boolean;
  readonly code:
    | 'local_coordination_verified'
    | 'local_coordination_probe_failed'
    | 'local_coordination_probe_unavailable'
    | 'local_team_tools_unverified'
    | 'local_model_too_small'
    | 'local_tools_unsupported'
    | 'local_context_too_small'
    | 'local_provider_unavailable'
    | 'local_model_not_loaded'
    | 'local_runtime_inspection_failed'
    | 'local_runtime_unverified';
  readonly message: string;
}

interface OpenCodeLocalModelRuntimeInspectorDependencies {
  readonly inventory?: Pick<RuntimeLocalProviderConnectorPort, 'listLocalProviders'>;
  readonly fetchImpl?: typeof fetch;
  readonly probeCoordination?: (input: {
    readonly provider: RuntimeLocalProviderListEntryDto;
    readonly modelId: string;
    readonly signal?: AbortSignal;
  }) => Promise<OpenCodeLocalModelCoordinationProbeResult>;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly coordinationProbeTimeoutMs?: number;
}

/** Inspects a configured local route and returns Agent Teams launch-readiness evidence. */
export async function inspectOpenCodeLocalModelRuntimeReadiness(
  input: {
    readonly projectPath: string;
    readonly modelRoute: string;
    readonly allowExperimentalLocalModels?: boolean;
    readonly classificationOnly?: boolean;
  },
  dependencies: OpenCodeLocalModelRuntimeInspectorDependencies = {}
): Promise<OpenCodeLocalModelRuntimeReadiness | null> {
  const parsed = parseOpenCodeQualifiedModelRef(input.modelRoute);
  if (!parsed) return null;

  const inventory = dependencies.inventory ?? new OpenCodeLocalProviderConnector();
  const provider = await resolveConfiguredLocalProvider(
    inventory,
    input.projectPath,
    parsed.sourceId
  );
  if (!provider) {
    if (!isOpenCodeLocalProviderId(parsed.sourceId)) return null;
    return {
      providerId: parsed.sourceId,
      modelId: parsed.modelId,
      presetId: 'custom',
      toolCapable: null,
      parameterCount: null,
      trainedContextTokens: null,
      configuredContextTokens: null,
      effectiveContextTokens: null,
      coordinationProbeStatus: null,
      severity: 'blocking',
      code: 'local_provider_unavailable',
      message:
        `Local provider ${parsed.sourceId} for ${input.modelRoute} is not configured for this ` +
        'project or globally. Reconnect the local provider, then retry launch.',
    };
  }
  if (input.classificationOnly) {
    return {
      providerId: parsed.sourceId,
      modelId: parsed.modelId,
      presetId: provider.preset.id,
      toolCapable: null,
      parameterCount: null,
      trainedContextTokens: null,
      configuredContextTokens: null,
      effectiveContextTokens: null,
      coordinationProbeStatus: null,
      severity: 'warning',
      code: 'local_runtime_unverified',
      message: `Local provider route ${input.modelRoute} is configured. Deep verification pending.`,
    };
  }
  if (provider.state !== 'available') {
    const providerMessage = provider.message.trim();
    return {
      providerId: parsed.sourceId,
      modelId: parsed.modelId,
      presetId: provider.preset.id,
      toolCapable: null,
      parameterCount: null,
      trainedContextTokens: null,
      configuredContextTokens: null,
      effectiveContextTokens: null,
      coordinationProbeStatus: null,
      severity: 'blocking',
      code: 'local_provider_unavailable',
      message:
        `${provider.preset.displayName} for ${input.modelRoute} is configured but unavailable. ` +
        `${providerMessage ? `${providerMessage} ` : ''}` +
        'Start the local server, then retry launch.',
    };
  }
  if (provider.preset.id !== 'ollama' && provider.liveModels.length === 0) {
    return {
      providerId: parsed.sourceId,
      modelId: parsed.modelId,
      presetId: provider.preset.id,
      toolCapable: null,
      parameterCount: null,
      trainedContextTokens: null,
      configuredContextTokens: null,
      effectiveContextTokens: null,
      coordinationProbeStatus: null,
      severity: 'blocking',
      code: 'local_model_not_loaded',
      message:
        `${provider.preset.displayName} is reachable but reports no loaded models, so it cannot ` +
        `serve ${input.modelRoute}. Load the model, refresh the provider, then retry launch.`,
    };
  }
  if (
    provider.preset.id !== 'ollama' &&
    !provider.liveModels.some((model) => model.id === parsed.modelId)
  ) {
    return {
      providerId: parsed.sourceId,
      modelId: parsed.modelId,
      presetId: provider.preset.id,
      toolCapable: null,
      parameterCount: null,
      trainedContextTokens: null,
      configuredContextTokens: null,
      effectiveContextTokens: null,
      coordinationProbeStatus: null,
      severity: 'blocking',
      code: 'local_model_not_loaded',
      message:
        `${input.modelRoute} is configured, but ${provider.preset.displayName} does not currently ` +
        'serve it. Load or download the model, refresh the provider, then retry launch.',
    };
  }

  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const probeCoordination =
    dependencies.probeCoordination ??
    ((probeInput) =>
      probeOpenCodeLocalModelCoordination(probeInput, {
        fetchImpl,
      }));
  const probeCoordinationReliably = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      dependencies.coordinationProbeTimeoutMs ?? COORDINATION_PROBE_TOTAL_TIMEOUT_MS
    );
    timeout.unref?.();
    try {
      return await verifyCoordinationReliability(
        {
          provider,
          modelId: parsed.modelId,
          signal: controller.signal,
        },
        probeCoordination,
        dependencies.sleep ?? delay
      );
    } finally {
      clearTimeout(timeout);
    }
  };

  if (provider.preset.id !== 'ollama') {
    const metadataRequest = buildLocalServerModelMetadataRequest(
      provider.preset.id,
      provider.baseUrl,
      parsed.modelId
    );
    const metadataRaw = metadataRequest
      ? await fetchJsonText(fetchImpl, metadataRequest.url, {
          method: metadataRequest.method,
          ...(metadataRequest.body ? { body: metadataRequest.body } : {}),
        })
      : null;
    const metadata = metadataRaw ? metadataRequest?.parse(metadataRaw) : null;

    if (metadata?.toolCapable === false) {
      return {
        providerId: parsed.sourceId,
        modelId: parsed.modelId,
        presetId: provider.preset.id,
        toolCapable: false,
        parameterCount: null,
        trainedContextTokens: null,
        configuredContextTokens: null,
        effectiveContextTokens: metadata.contextTokens,
        coordinationProbeStatus: null,
        severity: 'blocking',
        code: 'local_tools_unsupported',
        message:
          `${provider.preset.displayName} reports that ${input.modelRoute} does not support ` +
          'tool calling. Choose a tool-capable model before launching Agent Teams.',
      };
    }
    if (
      metadata?.contextTokens != null &&
      metadata.contextTokens < MIN_AGENT_TEAMS_LOCAL_CONTEXT_TOKENS
    ) {
      return buildContextTooSmallResult({
        providerId: parsed.sourceId,
        modelId: parsed.modelId,
        modelRoute: input.modelRoute,
        presetId: provider.preset.id,
        providerDisplayName: provider.preset.displayName,
        toolCapable: metadata.toolCapable,
        parameterCount: null,
        trainedContextTokens: null,
        configuredContextTokens: null,
        effectiveContextTokens: metadata.contextTokens,
        provenContextTokens: metadata.contextTokens,
        coordinationProbeStatus: null,
      });
    }

    const coordination = await probeCoordinationReliably();
    if (coordination.status !== 'passed') {
      return buildCoordinationProbeFailure({
        providerId: parsed.sourceId,
        modelId: parsed.modelId,
        presetId: provider.preset.id,
        toolCapable: metadata?.toolCapable ?? null,
        effectiveContextTokens: metadata?.contextTokens ?? null,
        coordination,
        allowExperimentalLocalModels: input.allowExperimentalLocalModels === true,
      });
    }
    if (metadata?.contextTokens != null) {
      return {
        providerId: parsed.sourceId,
        modelId: parsed.modelId,
        presetId: provider.preset.id,
        toolCapable: metadata.toolCapable,
        parameterCount: null,
        trainedContextTokens: null,
        configuredContextTokens: null,
        effectiveContextTokens: metadata.contextTokens,
        coordinationProbeStatus: coordination.status,
        severity: 'ready',
        code: 'local_coordination_verified',
        message:
          `${coordination.message} ${provider.preset.displayName} is running it with ` +
          `${formatContextTokens(metadata.contextTokens)} effective context.`,
      };
    }
    return {
      providerId: parsed.sourceId,
      modelId: parsed.modelId,
      presetId: provider.preset.id,
      toolCapable: metadata?.toolCapable ?? null,
      parameterCount: null,
      trainedContextTokens: null,
      configuredContextTokens: null,
      effectiveContextTokens: null,
      coordinationProbeStatus: coordination.status,
      severity: 'warning',
      code: 'local_runtime_unverified',
      message:
        `${coordination.message} ${provider.preset.displayName} does not expose enough runtime ` +
        `metadata to prove the effective context size; use at least ` +
        `${formatContextTokens(MIN_AGENT_TEAMS_LOCAL_CONTEXT_TOKENS)} ` +
        `(${formatContextTokens(RECOMMENDED_AGENT_TEAMS_LOCAL_CONTEXT_TOKENS)} recommended).`,
    };
  }

  const showRaw = await fetchJsonText(
    fetchImpl,
    buildOllamaNativeUrl(provider.baseUrl, '/api/show'),
    {
      method: 'POST',
      body: JSON.stringify({ model: parsed.modelId }),
    }
  );
  const metadata = showRaw ? parseOllamaShowMetadata(showRaw) : null;
  const configuredContextTokens = metadata?.configuredContextTokens ?? null;
  const trainedContextTokens = metadata?.trainedContextTokens ?? null;
  const toolCapable = metadata?.toolCapable ?? null;
  const parameterCount = metadata?.parameterCount ?? null;
  const parameterCountAdvisory =
    parameterCount !== null && parameterCount < MIN_AGENT_TEAMS_LOCAL_PARAMETER_COUNT
      ? `Ollama reports ${formatParameterCount(parameterCount)} parameters, below the ` +
        `${formatParameterCount(MIN_AGENT_TEAMS_LOCAL_PARAMETER_COUNT)} reliability guideline.`
      : null;
  const configuredContextAdvisory =
    configuredContextTokens !== null &&
    configuredContextTokens < MIN_AGENT_TEAMS_LOCAL_CONTEXT_TOKENS
      ? `The model metadata contains num_ctx=${configuredContextTokens}, but Ollama runtime ` +
        'settings can override it; verify the active allocation with ollama ps.'
      : null;

  if (toolCapable === false) {
    return {
      providerId: parsed.sourceId,
      modelId: parsed.modelId,
      presetId: provider.preset.id,
      toolCapable,
      parameterCount,
      trainedContextTokens,
      configuredContextTokens,
      effectiveContextTokens: null,
      coordinationProbeStatus: null,
      severity: 'blocking',
      code: 'local_tools_unsupported',
      message:
        `Ollama reports that ${input.modelRoute} does not support tool calling. ` +
        'Choose a tool-capable model before launching Agent Teams.',
    };
  }

  const coordination = await probeCoordinationReliably();
  // The coordination request loads the model when it was not already resident. Read
  // /api/ps after that request even when coordination failed so the experimental
  // override can never bypass the effective-context hard floor.
  const psRaw = await fetchJsonText(fetchImpl, buildOllamaNativeUrl(provider.baseUrl, '/api/ps'), {
    method: 'GET',
  });
  const effectiveContextTokens = psRaw
    ? parseOllamaRunningContextTokens(psRaw, parsed.modelId)
    : null;
  if (
    effectiveContextTokens !== null &&
    effectiveContextTokens < MIN_AGENT_TEAMS_LOCAL_CONTEXT_TOKENS
  ) {
    return buildContextTooSmallResult({
      providerId: parsed.sourceId,
      modelId: parsed.modelId,
      modelRoute: input.modelRoute,
      presetId: provider.preset.id,
      toolCapable,
      parameterCount,
      trainedContextTokens,
      configuredContextTokens,
      effectiveContextTokens,
      provenContextTokens: effectiveContextTokens,
      coordinationProbeStatus: coordination.status,
    });
  }

  if (coordination.status !== 'passed') {
    return buildCoordinationProbeFailure({
      providerId: parsed.sourceId,
      modelId: parsed.modelId,
      presetId: provider.preset.id,
      toolCapable,
      parameterCount,
      trainedContextTokens,
      configuredContextTokens,
      effectiveContextTokens,
      coordination,
      allowExperimentalLocalModels: input.allowExperimentalLocalModels === true,
    });
  }

  if (effectiveContextTokens === null || toolCapable === null) {
    return {
      providerId: parsed.sourceId,
      modelId: parsed.modelId,
      presetId: provider.preset.id,
      toolCapable,
      parameterCount,
      trainedContextTokens,
      configuredContextTokens,
      effectiveContextTokens,
      coordinationProbeStatus: coordination.status,
      severity: 'warning',
      code: 'local_runtime_unverified',
      message:
        `${coordination.message} Ollama did not expose both effective context and tool support, ` +
        `so runtime capacity remains unverified.` +
        `${configuredContextAdvisory ? ` ${configuredContextAdvisory}` : ''}` +
        `${parameterCountAdvisory ? ` ${parameterCountAdvisory}` : ''}`,
    };
  }

  if (parameterCountAdvisory) {
    return {
      providerId: parsed.sourceId,
      modelId: parsed.modelId,
      presetId: provider.preset.id,
      toolCapable,
      parameterCount,
      trainedContextTokens,
      configuredContextTokens,
      effectiveContextTokens,
      coordinationProbeStatus: coordination.status,
      severity: 'warning',
      code: 'local_model_too_small',
      message:
        `${coordination.message} ${parameterCountAdvisory} The empirical coordination and ` +
        'OpenCode execution probes remain authoritative.',
    };
  }

  return {
    providerId: parsed.sourceId,
    modelId: parsed.modelId,
    presetId: provider.preset.id,
    toolCapable,
    parameterCount,
    trainedContextTokens,
    configuredContextTokens,
    effectiveContextTokens,
    coordinationProbeStatus: coordination.status,
    severity: 'ready',
    code: 'local_coordination_verified',
    message:
      `${coordination.message} Ollama is running it with ` +
      `${formatContextTokens(effectiveContextTokens)} effective context.`,
  };
}

async function verifyCoordinationReliability(
  input: {
    readonly provider: RuntimeLocalProviderListEntryDto;
    readonly modelId: string;
    readonly signal: AbortSignal;
  },
  probeCoordination: (input: {
    readonly provider: RuntimeLocalProviderListEntryDto;
    readonly modelId: string;
    readonly signal?: AbortSignal;
  }) => Promise<OpenCodeLocalModelCoordinationProbeResult>,
  sleep: (delayMs: number) => Promise<void>
): Promise<OpenCodeLocalModelCoordinationProbeResult> {
  for (let attempt = 1; attempt <= MAX_COORDINATION_PROBE_ATTEMPTS; attempt += 1) {
    const result = await probeCoordination(input);
    if (result.status === 'passed' || result.status === 'failed') {
      return result;
    }
    if (input.signal.aborted) {
      return {
        ...result,
        message: `${result.message} The Agent Teams coordination probe timed out.`,
      };
    }
    if (attempt < MAX_COORDINATION_PROBE_ATTEMPTS) {
      await sleep(COORDINATION_PROBE_RETRY_DELAY_MS);
      if (input.signal.aborted) {
        return {
          ...result,
          message: `${result.message} The Agent Teams coordination probe timed out.`,
        };
      }
      continue;
    }
    return {
      ...result,
      message:
        `${result.message} Verification remained unavailable after ` +
        `${MAX_COORDINATION_PROBE_ATTEMPTS} attempts.`,
    };
  }
  throw new Error('Coordination probe retry loop completed without a result.');
}

function buildCoordinationProbeFailure(input: {
  providerId: string;
  modelId: string;
  presetId: RuntimeLocalProviderListEntryDto['preset']['id'];
  toolCapable?: boolean | null;
  parameterCount?: number | null;
  trainedContextTokens?: number | null;
  configuredContextTokens?: number | null;
  effectiveContextTokens?: number | null;
  coordination: OpenCodeLocalModelCoordinationProbeResult;
  allowExperimentalLocalModels: boolean;
}): OpenCodeLocalModelRuntimeReadiness {
  const unavailable = input.coordination.status === 'unavailable';
  const failed = input.coordination.status === 'failed';
  const requestRejected = input.coordination.failureKind === 'request_rejected';
  const experimentalOverride = failed && !requestRejected;
  const overrideApplied = experimentalOverride && input.allowExperimentalLocalModels;
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    presetId: input.presetId,
    toolCapable: input.toolCapable ?? null,
    parameterCount: input.parameterCount ?? null,
    trainedContextTokens: input.trainedContextTokens ?? null,
    configuredContextTokens: input.configuredContextTokens ?? null,
    effectiveContextTokens: input.effectiveContextTokens ?? null,
    coordinationProbeStatus: input.coordination.status,
    severity: unavailable || overrideApplied ? 'warning' : 'blocking',
    experimentalOverrideAvailable: experimentalOverride,
    code: failed ? 'local_coordination_probe_failed' : 'local_coordination_probe_unavailable',
    message: unavailable
      ? `${input.coordination.message} This is a verification availability problem, not proof ` +
        'that the model is unsupported. The real OpenCode execution probe will make the launch decision.'
      : requestRejected
        ? `${input.coordination.message} The local server rejected the required tool-call request, ` +
          'so the experimental local-model override cannot bypass this failure.'
        : overrideApplied
          ? `${input.coordination.message} Experimental local-model override is enabled; the real ` +
            'OpenCode execution probe must still pass.'
          : `${input.coordination.message} You can explicitly enable the experimental local-model ` +
            'override to continue to the real OpenCode execution probe.',
  };
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, delayMs);
    timeout.unref?.();
  });
}

function buildContextTooSmallResult(input: {
  providerId: string;
  modelId: string;
  modelRoute: string;
  presetId: RuntimeLocalProviderListEntryDto['preset']['id'];
  providerDisplayName?: string;
  toolCapable: boolean | null;
  parameterCount: number | null;
  trainedContextTokens: number | null;
  configuredContextTokens: number | null;
  effectiveContextTokens: number | null;
  provenContextTokens: number;
  coordinationProbeStatus: OpenCodeLocalModelCoordinationProbeResult['status'] | null;
}): OpenCodeLocalModelRuntimeReadiness {
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    presetId: input.presetId,
    toolCapable: input.toolCapable,
    parameterCount: input.parameterCount,
    trainedContextTokens: input.trainedContextTokens,
    configuredContextTokens: input.configuredContextTokens,
    effectiveContextTokens: input.effectiveContextTokens,
    coordinationProbeStatus: input.coordinationProbeStatus,
    severity: 'blocking',
    code: 'local_context_too_small',
    message:
      `${input.providerDisplayName ?? 'Ollama'} is running ${input.modelRoute} with ` +
      `${formatContextTokens(input.provenContextTokens)} context. Agent Teams requires at least ` +
      `${formatContextTokens(MIN_AGENT_TEAMS_LOCAL_CONTEXT_TOKENS)} ` +
      `(${formatContextTokens(RECOMMENDED_AGENT_TEAMS_LOCAL_CONTEXT_TOKENS)} recommended). ` +
      buildContextTooSmallRemedy(input.presetId),
  };
}

function buildContextTooSmallRemedy(
  presetId: RuntimeLocalProviderListEntryDto['preset']['id']
): string {
  switch (presetId) {
    case 'llama.cpp':
      return (
        `Restart llama-server with --ctx-size ` +
        `${RECOMMENDED_AGENT_TEAMS_LOCAL_CONTEXT_TOKENS} or larger, then retry.`
      );
    case 'lm-studio':
      return (
        `Increase the model's context length to at least ` +
        `${RECOMMENDED_AGENT_TEAMS_LOCAL_CONTEXT_TOKENS} in LM Studio, reload the model, ` +
        'then retry.'
      );
    case 'ollama':
      return (
        `Create an Ollama model with PARAMETER num_ctx ` +
        `${RECOMMENDED_AGENT_TEAMS_LOCAL_CONTEXT_TOKENS} or restart Ollama with ` +
        `OLLAMA_CONTEXT_LENGTH=${RECOMMENDED_AGENT_TEAMS_LOCAL_CONTEXT_TOKENS}, then retry.`
      );
    default:
      return (
        `Increase the local server's context window to at least ` +
        `${RECOMMENDED_AGENT_TEAMS_LOCAL_CONTEXT_TOKENS} tokens, then retry.`
      );
  }
}

async function resolveConfiguredLocalProvider(
  inventory: Pick<RuntimeLocalProviderConnectorPort, 'listLocalProviders'>,
  projectPath: string,
  providerId: string
): Promise<RuntimeLocalProviderListEntryDto | null> {
  const projectResult = await inventory.listLocalProviders({
    runtimeId: 'opencode',
    scope: 'project',
    projectPath,
    providerId,
  });
  const projectProvider = projectResult.providers?.find(
    (provider) => provider.providerId === providerId
  );
  if (projectProvider) return projectProvider;

  const globalResult = await inventory.listLocalProviders({
    runtimeId: 'opencode',
    scope: 'global',
    providerId,
  });
  return globalResult.providers?.find((provider) => provider.providerId === providerId) ?? null;
}

async function fetchJsonText(
  fetchImpl: typeof fetch,
  url: string,
  init: Pick<RequestInit, 'method' | 'body'>
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INSPECTION_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await readResponseTextWithLimit(response, MAX_RESPONSE_BYTES);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function formatContextTokens(tokens: number): string {
  return tokens % 1024 === 0 ? `${tokens / 1024}K` : tokens.toLocaleString('en-US');
}

function formatParameterCount(parameterCount: number): string {
  if (parameterCount >= 1_000_000_000) {
    return `${(parameterCount / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  }
  return `${Math.round(parameterCount / 1_000_000)}M`;
}
