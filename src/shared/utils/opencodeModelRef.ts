export interface OpenCodeQualifiedModelRef {
  sourceId: string;
  modelId: string;
  raw: string;
}

const OPEN_CODE_MODEL_REF_PATTERN = /^(?<source>[a-z0-9-]+)\/(?<model>\S.*)$/i;

const OPEN_CODE_SOURCE_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  azure: 'Azure',
  bedrock: 'Bedrock',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  google: 'Google',
  groq: 'Groq',
  minimax: 'MiniMax',
  mistral: 'Mistral',
  moonshot: 'Moonshot',
  ollama: 'Ollama',
  opencode: 'OpenCode',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI Compatible',
  openrouter: 'OpenRouter',
  together: 'Together',
  vertex: 'Vertex',
  xai: 'xAI',
  'z-ai': 'Z.AI',
};

function humanizeOpenCodeSourceId(sourceId: string): string {
  const normalized = sourceId.trim().toLowerCase();
  if (!normalized) {
    return sourceId;
  }

  const knownLabel = OPEN_CODE_SOURCE_LABELS[normalized];
  if (knownLabel) {
    return knownLabel;
  }

  return normalized
    .split('-')
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

export function parseOpenCodeQualifiedModelRef(
  model: string | undefined | null
): OpenCodeQualifiedModelRef | null {
  const trimmed = model?.trim();
  if (!trimmed) {
    return null;
  }

  const match = OPEN_CODE_MODEL_REF_PATTERN.exec(trimmed);
  if (!match?.groups?.source || !match.groups.model) {
    return null;
  }

  return {
    raw: trimmed,
    sourceId: match.groups.source.toLowerCase(),
    modelId: match.groups.model,
  };
}

export function getOpenCodeQualifiedModelSourceLabel(
  model: string | undefined | null
): string | null {
  const parsed = parseOpenCodeQualifiedModelRef(model);
  if (!parsed) {
    return null;
  }

  return humanizeOpenCodeSourceId(parsed.sourceId);
}
