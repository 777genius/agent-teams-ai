import type {
  RuntimeLocalProviderPresetDto,
  RuntimeLocalProviderPresetIdDto,
} from '../../contracts';

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODEL_ID_MAX_LENGTH = 256;

export const RUNTIME_LOCAL_PROVIDER_PRESETS: readonly RuntimeLocalProviderPresetDto[] = [
  {
    id: 'ollama',
    providerId: 'ollama',
    displayName: 'Ollama',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    description: 'Use models served by the local Ollama daemon.',
    scannable: true,
  },
  {
    id: 'lm-studio',
    providerId: 'lmstudio',
    displayName: 'LM Studio',
    defaultBaseUrl: 'http://127.0.0.1:1234/v1',
    description: 'Connect to the LM Studio local server.',
    scannable: true,
  },
  {
    id: 'atomic-chat',
    providerId: 'atomic-chat',
    displayName: 'Atomic Chat',
    defaultBaseUrl: 'http://127.0.0.1:1337/v1',
    description: 'Use models managed by the Atomic Chat desktop app.',
    scannable: true,
  },
  {
    id: 'llama.cpp',
    providerId: 'llama.cpp',
    displayName: 'llama.cpp',
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    description: 'Connect to a locally running llama-server process.',
    scannable: true,
  },
  {
    id: 'custom',
    providerId: 'local',
    displayName: 'Custom local server',
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    description: 'Connect another OpenAI-compatible server on this computer.',
    scannable: false,
  },
];

export class RuntimeLocalProviderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeLocalProviderValidationError';
  }
}

export interface NormalizedRuntimeLocalProviderTarget {
  readonly preset: RuntimeLocalProviderPresetDto;
  readonly providerId: string;
  readonly baseUrl: string;
}

export function getRuntimeLocalProviderPreset(
  presetId: RuntimeLocalProviderPresetIdDto
): RuntimeLocalProviderPresetDto {
  const preset = RUNTIME_LOCAL_PROVIDER_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset) {
    throw new RuntimeLocalProviderValidationError('Local provider preset is not supported.');
  }
  return preset;
}

export function normalizeRuntimeLocalProviderTarget(input: {
  presetId: RuntimeLocalProviderPresetIdDto;
  baseUrl?: string | null;
  providerId?: string | null;
}): NormalizedRuntimeLocalProviderTarget {
  const preset = getRuntimeLocalProviderPreset(input.presetId);
  const providerId =
    preset.id === 'custom' ? input.providerId?.trim() || preset.providerId : preset.providerId;
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new RuntimeLocalProviderValidationError(
      'Provider id must start with a lowercase letter or number and contain only lowercase letters, numbers, dots, dashes, or underscores.'
    );
  }

  const rawBaseUrl = input.baseUrl?.trim() || preset.defaultBaseUrl;
  if (rawBaseUrl.length > 2_048) {
    throw new RuntimeLocalProviderValidationError('Local provider URL is too long.');
  }

  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new RuntimeLocalProviderValidationError('Enter a valid local provider URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RuntimeLocalProviderValidationError('Local provider URL must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new RuntimeLocalProviderValidationError(
      'Credentials are not allowed in the local provider URL.'
    );
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new RuntimeLocalProviderValidationError(
      'Local provider URL must point to localhost or a loopback address.'
    );
  }
  if (url.search || url.hash) {
    throw new RuntimeLocalProviderValidationError(
      'Local provider URL cannot include query parameters or a fragment.'
    );
  }

  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname && pathname !== '/' ? pathname : '/v1';
  return {
    preset,
    providerId,
    baseUrl: url.toString().replace(/\/$/, ''),
  };
}

export function normalizeRuntimeLocalProviderModelId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const modelId = value.trim();
  if (
    modelId.length === 0 ||
    modelId.length > MODEL_ID_MAX_LENGTH ||
    containsControlCharacter(modelId)
  ) {
    return null;
  }
  return modelId;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) {
      return true;
    }
  }
  return false;
}

export function buildRuntimeLocalProviderModelRoute(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') {
    return true;
  }
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) {
    return false;
  }
  return ipv4.slice(1).every((part) => Number(part) <= 255) && Number(ipv4[1]) === 127;
}
