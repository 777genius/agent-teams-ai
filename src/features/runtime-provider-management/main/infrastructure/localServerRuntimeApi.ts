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
    case 'llama.cpp':
      return {
        url: buildOllamaNativeUrl(baseUrl, '/props'),
        method: 'GET',
        parse: parseLlamaCppPropsMetadata,
      };
    case 'lm-studio':
      return {
        url: buildOllamaNativeUrl(baseUrl, '/api/v0/models'),
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
 * LM Studio exposes `GET /api/v0/models` at the server root with per-model
 * `max_context_length`, `loaded_context_length` (when loaded), and on newer
 * versions a `capabilities` array (e.g. `["tool_use"]`).
 */
export function parseLmStudioModelMetadata(
  raw: string,
  requestedModelId: string
): LocalServerModelMetadata | null {
  const root = parseRecord(raw);
  if (!root || !Array.isArray(root.data)) return null;

  for (const value of root.data) {
    const model = asRecord(value);
    if (!model || model.id !== requestedModelId) continue;
    const capabilities = Array.isArray(model.capabilities)
      ? model.capabilities.filter((entry): entry is string => typeof entry === 'string')
      : null;
    const contextTokens = isPositiveSafeInteger(model.loaded_context_length)
      ? model.loaded_context_length
      : isPositiveSafeInteger(model.max_context_length)
        ? model.max_context_length
        : null;
    return {
      toolCapable: capabilities ? capabilities.includes('tool_use') : null,
      contextTokens,
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
