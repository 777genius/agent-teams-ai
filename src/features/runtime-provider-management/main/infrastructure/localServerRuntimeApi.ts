import { buildOllamaNativeUrl, parseOllamaShowMetadata } from './ollamaRuntimeApi';

export interface LocalServerModelMetadata {
  readonly toolCapable: boolean | null;
  readonly contextTokens: number | null;
}

export interface LocalServerModelMetadataRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly body?: string;
  readonly parse: (raw: string) => LocalServerModelMetadata | null;
}

/** Builds the supported native metadata request for a local-server preset. */
export function buildLocalServerModelMetadataRequest(
  presetId: string,
  baseUrl: string,
  modelId: string
): LocalServerModelMetadataRequest | null {
  switch (presetId) {
    case 'ollama':
      return {
        url: buildOllamaNativeUrl(baseUrl, '/api/show'),
        method: 'POST',
        body: JSON.stringify({ model: modelId }),
        parse: (raw) => {
          const metadata = parseOllamaShowMetadata(raw);
          if (!metadata) return null;
          return {
            toolCapable: metadata.toolCapable,
            contextTokens: metadata.configuredContextTokens ?? metadata.trainedContextTokens,
          };
        },
      };
    case 'llama.cpp': {
      const propsUrl = new URL(buildOllamaNativeUrl(baseUrl, '/props'));
      propsUrl.searchParams.set('model', modelId);
      return {
        url: propsUrl.toString(),
        method: 'GET',
        parse: parseLlamaCppPropsMetadata,
      };
    }
    case 'lm-studio':
      return {
        url: buildOllamaNativeUrl(baseUrl, '/api/v1/models'),
        method: 'GET',
        parse: (raw) => parseLmStudioModelMetadata(raw, modelId),
      };
    default:
      return null;
  }
}

/**
 * llama.cpp (llama-server) exposes `GET /props` at the server root with the
 * effective per-slot context size in `default_generation_settings.n_ctx`.
 */
export function parseLlamaCppPropsMetadata(raw: string): LocalServerModelMetadata | null {
  const root = parseRecord(raw);
  if (!root) return null;
  const generationSettings = asRecord(root.default_generation_settings);
  const contextTokens = generationSettings?.n_ctx;
  return {
    toolCapable: null,
    contextTokens: isPositiveSafeInteger(contextTokens) ? contextTokens : null,
  };
}

/**
 * LM Studio exposes `GET /api/v1/models` with each loaded instance's effective
 * context length and the model's tool-use capability. Legacy v0 responses are
 * accepted without treating the model's maximum context as its runtime context.
 */
export function parseLmStudioModelMetadata(
  raw: string,
  requestedModelId: string
): LocalServerModelMetadata | null {
  const root = parseRecord(raw);
  if (!root) return null;

  if (Array.isArray(root.models)) {
    for (const value of root.models) {
      const model = asRecord(value);
      if (!model) continue;
      const loadedInstances = Array.isArray(model.loaded_instances)
        ? model.loaded_instances.map(asRecord).filter((entry) => entry !== null)
        : [];
      const requestedInstance = loadedInstances.find(
        (instance) => instance.id === requestedModelId
      );
      const modelMatches =
        model.key === requestedModelId ||
        (Array.isArray(model.variants) && model.variants.includes(requestedModelId));
      if (!requestedInstance && !modelMatches) continue;

      const effectiveInstance =
        requestedInstance ?? (loadedInstances.length === 1 ? loadedInstances[0] : null);
      const instanceConfig = asRecord(effectiveInstance?.config);
      const capabilities = asRecord(model.capabilities);
      const trainedForToolUse = capabilities?.trained_for_tool_use;
      return {
        toolCapable: typeof trainedForToolUse === 'boolean' ? trainedForToolUse : null,
        contextTokens: isPositiveSafeInteger(instanceConfig?.context_length)
          ? instanceConfig.context_length
          : null,
      };
    }
    return null;
  }

  if (!Array.isArray(root.data)) return null;
  for (const value of root.data) {
    const model = asRecord(value);
    if (model?.id !== requestedModelId) continue;
    const capabilities = Array.isArray(model.capabilities)
      ? model.capabilities.filter((entry): entry is string => typeof entry === 'string')
      : null;
    return {
      toolCapable: capabilities ? capabilities.includes('tool_use') : null,
      contextTokens: isPositiveSafeInteger(model.loaded_context_length)
        ? model.loaded_context_length
        : null,
    };
  }
  return null;
}

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
