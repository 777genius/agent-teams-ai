const OLLAMA_CONTEXT_PARAMETER_PATTERN = /(?:^|\n)\s*num_ctx\s+(\d+)\s*(?:\n|$)/i;

export interface OllamaShowMetadata {
  readonly completionCapable: boolean | null;
  readonly toolCapable: boolean | null;
  readonly parameterCount: number | null;
  readonly configuredContextTokens: number | null;
  readonly trainedContextTokens: number | null;
}

export function buildOllamaNativeUrl(baseUrl: string, pathname: string): string {
  const url = new URL(baseUrl);
  const normalizedPath = url.pathname.replace(/\/+$/, '');
  const rootPath = normalizedPath.endsWith('/v1')
    ? normalizedPath.slice(0, -'/v1'.length)
    : normalizedPath;
  url.pathname = `${rootPath}/${pathname.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function parseOllamaShowMetadata(raw: string): OllamaShowMetadata | null {
  const root = parseRecord(raw);
  if (!root) return null;

  const capabilities = Array.isArray(root.capabilities)
    ? root.capabilities.filter((value): value is string => typeof value === 'string')
    : null;
  const modelInfo = asRecord(root.model_info);
  const parameterCount =
    Object.entries(modelInfo ?? {}).find(
      ([key, value]) => key.endsWith('.parameter_count') && isPositiveSafeInteger(value)
    )?.[1] ?? null;
  const trainedContextTokens =
    Object.entries(modelInfo ?? {}).find(
      ([key, value]) => key.endsWith('.context_length') && isPositiveSafeInteger(value)
    )?.[1] ?? null;
  const parameters = typeof root.parameters === 'string' ? root.parameters : '';
  const configuredContextMatch = OLLAMA_CONTEXT_PARAMETER_PATTERN.exec(parameters);
  const configuredContextTokens = configuredContextMatch
    ? Number.parseInt(configuredContextMatch[1], 10)
    : null;

  return {
    completionCapable: capabilities ? capabilities.includes('completion') : null,
    toolCapable: capabilities ? capabilities.includes('tools') : null,
    parameterCount: isPositiveSafeInteger(parameterCount) ? parameterCount : null,
    configuredContextTokens: isPositiveSafeInteger(configuredContextTokens)
      ? configuredContextTokens
      : null,
    trainedContextTokens: isPositiveSafeInteger(trainedContextTokens) ? trainedContextTokens : null,
  };
}

export function parseOllamaRunningContextTokens(
  raw: string,
  requestedModelId: string
): number | null {
  const root = parseRecord(raw);
  if (!root || !Array.isArray(root.models)) return null;

  const requested = normalizeOllamaModelName(requestedModelId);
  for (const value of root.models) {
    const model = asRecord(value);
    if (!model) continue;
    const names = [model.name, model.model]
      .filter((entry): entry is string => typeof entry === 'string')
      .map(normalizeOllamaModelName);
    if (!names.includes(requested)) continue;
    return isPositiveSafeInteger(model.context_length) ? model.context_length : null;
  }
  return null;
}

function normalizeOllamaModelName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.includes(':')) return normalized;
  return `${normalized}:latest`;
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
