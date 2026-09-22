export interface OpenCodeQualifiedModelRef {
  sourceId: string;
  modelId: string;
  raw: string;
}

const OPEN_CODE_SOURCE_ID_PATTERN = /^[a-z0-9._-]+$/i;

const OPEN_CODE_SOURCE_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  azure: 'Azure',
  bedrock: 'Bedrock',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  google: 'Google Gemini API',
  'google-vertex': 'Google Vertex AI',
  'google-vertex-anthropic': 'Claude via Google Vertex',
  groq: 'Groq',
  'llama.cpp': 'llama.cpp',
  llamacpp: 'llama.cpp',
  lmstudio: 'LM Studio',
  'lm-studio': 'LM Studio',
  minimax: 'MiniMax',
  mistral: 'Mistral',
  moonshot: 'Moonshot',
  ollama: 'Ollama',
  opencode: 'OpenCode Zen',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI Compatible',
  openrouter: 'OpenRouter',
  together: 'Together',
  vercel: 'Vercel AI Gateway',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  vertex: 'Google Vertex AI',
  vllm: 'vLLM',
  xai: 'xAI',
  'z-ai': 'Z.AI',
};

export function getOpenCodeSourceDisplayName(
  sourceId: string,
  fallbackDisplayName?: string | null
): string {
  const normalized = sourceId.trim().toLowerCase();
  const fallback = fallbackDisplayName?.trim();
  if (!normalized) {
    return fallback || sourceId;
  }

  // xAI API access and the SuperGrok subscription share the same OpenCode
  // source id, so keep the plan-specific label supplied by the runtime.
  if (normalized === 'xai' && fallback?.toLowerCase() === 'supergrok') {
    return fallback;
  }

  const knownLabel = OPEN_CODE_SOURCE_LABELS[normalized];
  if (knownLabel) {
    return knownLabel;
  }

  if (fallback) {
    return fallback;
  }

  return normalized
    .split(/[-._]/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

export function parseOpenCodeQualifiedModelRef(
  model: string | undefined | null
): OpenCodeQualifiedModelRef | null {
  const trimmed = model?.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return null;
  }

  const separatorIndex = trimmed.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    return null;
  }

  const sourceId = trimmed.slice(0, separatorIndex).toLowerCase();
  const modelId = trimmed.slice(separatorIndex + 1);
  if (!OPEN_CODE_SOURCE_ID_PATTERN.test(sourceId) || !modelId) {
    return null;
  }

  return {
    raw: `${sourceId}/${modelId}`,
    sourceId,
    modelId,
  };
}

export function getOpenCodeQualifiedModelSourceLabel(
  model: string | undefined | null
): string | null {
  const parsed = parseOpenCodeQualifiedModelRef(model);
  if (!parsed) {
    return null;
  }

  return getOpenCodeSourceDisplayName(parsed.sourceId);
}
