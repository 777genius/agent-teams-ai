import { isLoopbackHostname, isPrivateNetworkHostname, isUnusableNetworkHostname } from '@shared/utils/networkHost';

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
    displayName: 'Custom OpenAI-compatible server',
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    description: 'Connect a local server or a trusted remote HTTPS endpoint.',
    scannable: false,
  },
];

/** Raised when local-provider identity or endpoint input violates the supported safety policy. */
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

/** Resolves a supported local-server preset or rejects unknown preset ids. */
export function getRuntimeLocalProviderPreset(
  presetId: RuntimeLocalProviderPresetIdDto
): RuntimeLocalProviderPresetDto {
  const preset = RUNTIME_LOCAL_PROVIDER_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset) {
    throw new RuntimeLocalProviderValidationError('Local provider preset is not supported.');
  }
  return preset;
}

/** Validates and canonicalizes a local provider id and OpenAI-compatible base URL. */
export function normalizeRuntimeLocalProviderTarget(input: {
  presetId: RuntimeLocalProviderPresetIdDto;
  baseUrl?: string | null;
  providerId?: string | null;
  allowPrivateNetwork?: boolean;
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
    throw new RuntimeLocalProviderValidationError('Provider URL is too long.');
  }

  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new RuntimeLocalProviderValidationError('Enter a valid provider URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RuntimeLocalProviderValidationError('Provider URL must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new RuntimeLocalProviderValidationError(
      'Credentials are not allowed in the provider URL.'
    );
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (!loopback && preset.id !== 'custom') {
    throw new RuntimeLocalProviderValidationError(
      'Choose Custom OpenAI-compatible server for a remote endpoint.'
    );
  }
  if (isUnusableNetworkHostname(url.hostname)) {
    throw new RuntimeLocalProviderValidationError(
      'Provider URL must use a reachable host, not an unspecified or broadcast address.'
    );
  }
  const privateNetwork = !loopback && isPrivateNetworkHostname(url.hostname);
  if (privateNetwork && !input.allowPrivateNetwork) {
    throw new RuntimeLocalProviderValidationError(
      'This address is on your local network, not this computer. Enable local network access to use it.'
    );
  }
  if (!loopback && !privateNetwork && url.protocol !== 'https:') {
    throw new RuntimeLocalProviderValidationError(
      'Remote provider URLs must use HTTPS to protect model requests and API keys.'
    );
  }
  if (url.search || url.hash) {
    throw new RuntimeLocalProviderValidationError(
      'Provider URL cannot include query parameters or a fragment.'
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

/** Returns a trimmed, control-character-free model id that is safe for config keys. */
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

/** Builds the provider-qualified model route consumed by OpenCode. */
export function buildRuntimeLocalProviderModelRoute(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/** Reports whether a valid URL targets an approved private or link-local network range. */
export function isPrivateNetworkRuntimeLocalProviderUrl(rawBaseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawBaseUrl.trim());
  } catch {
    return false;
  }
  return !isLoopbackHostname(url.hostname) && isPrivateNetworkHostname(url.hostname);
}

export function isRuntimeLocalProviderLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}
