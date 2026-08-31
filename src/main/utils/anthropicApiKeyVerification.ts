/**
 * Direct Anthropic API-key verification against `GET /v1/models`.
 *
 * Lives in shared main utils so both `ProviderConnectionService` and the
 * OpenCode connect-api-key fallback can verify a key without importing the
 * whole provider connection service into a feature slice.
 */

export const ANTHROPIC_DEFAULT_API_BASE_URL = 'https://api.anthropic.com';

const ANTHROPIC_API_KEY_VERIFY_TIMEOUT_MS = 10_000;

/** Undici's wording for a response refused by `redirect: 'error'`. */
const REDIRECT_REFUSED_RE = /redirect/i;

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
      // A key-verification probe has no legitimate redirect. Following one is
      // a credential leak: Node strips `Authorization` and `Cookie` on a
      // cross-origin hop but keeps the nonstandard `x-api-key` below, so an
      // endpoint answering 30x would hand the key to an unconfigured origin.
      // Refusing throws, and the catch below reports `unknown` — the probe
      // could not verify the key, which is recoverable, rather than `invalid`,
      // which would wrongly condemn a good key.
      redirect: 'error',
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
    // `fetch` reports every transport failure as a bare "fetch failed"; the
    // reason (including a refused redirect) only lives on `cause`.
    const cause = error instanceof Error ? error.cause : null;
    const causeMessage = cause instanceof Error ? cause.message : null;
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: 'unknown',
      status: null,
      errorType: causeMessage && REDIRECT_REFUSED_RE.test(causeMessage) ? 'redirect_refused' : null,
      errorMessage: causeMessage ? `${message}: ${causeMessage}` : message,
    };
  } finally {
    clearTimeout(timeout);
  }
}
