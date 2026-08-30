/**
 * Direct Anthropic API-key verification against `GET /v1/models`.
 *
 * Lives in shared main utils so both `ProviderConnectionService` and the
 * OpenCode connect-api-key fallback can verify a key without importing the
 * whole provider connection service into a feature slice.
 */

export const ANTHROPIC_DEFAULT_API_BASE_URL = 'https://api.anthropic.com';

const ANTHROPIC_API_KEY_VERIFY_TIMEOUT_MS = 10_000;

export type AnthropicApiKeyVerificationState = 'valid' | 'invalid' | 'unknown';

export interface AnthropicApiKeyVerificationResult {
  state: AnthropicApiKeyVerificationState;
  status?: number | null;
  errorType?: string | null;
  errorMessage?: string | null;
}

export type AnthropicApiKeyVerifier = (
  apiKey: string,
  baseUrl?: string | null
) => Promise<AnthropicApiKeyVerificationResult>;

function buildAnthropicModelsUrl(baseUrl?: string | null): string {
  const url = new URL(baseUrl?.trim() || ANTHROPIC_DEFAULT_API_BASE_URL);
  let pathname = url.pathname;
  while (pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  if (pathname.endsWith('/v1/models')) {
    url.pathname = pathname;
  } else if (pathname.endsWith('/v1')) {
    url.pathname = `${pathname}/models`;
  } else {
    url.pathname = `${pathname}/v1/models`;
  }
  url.search = '';
  return url.toString();
}

export async function verifyAnthropicApiKeyWithApi(
  apiKey: string,
  baseUrl?: string | null
): Promise<AnthropicApiKeyVerificationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANTHROPIC_API_KEY_VERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(buildAnthropicModelsUrl(baseUrl), {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
    const text = await response.text();
    let body: { error?: { type?: string; message?: string } } | null = null;
    try {
      body = text ? (JSON.parse(text) as { error?: { type?: string; message?: string } }) : null;
    } catch {
      body = null;
    }

    if (response.ok) {
      return { state: 'valid', status: response.status };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        state: 'invalid',
        status: response.status,
        errorType: body?.error?.type ?? null,
        errorMessage: body?.error?.message ?? null,
      };
    }

    return {
      state: 'unknown',
      status: response.status,
      errorType: body?.error?.type ?? null,
      errorMessage: body?.error?.message ?? null,
    };
  } catch (error) {
    return {
      state: 'unknown',
      status: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}
