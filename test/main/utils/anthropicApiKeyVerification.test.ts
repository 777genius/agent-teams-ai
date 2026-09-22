import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ANTHROPIC_DEFAULT_API_BASE_URL,
  verifyAnthropicApiKeyWithApi,
} from '../../../src/main/utils/anthropicApiKeyVerification';

const API_KEY = 'sk-ant-test-key';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** The shape Node throws when `redirect: 'error'` refuses a 30x. */
function redirectRefusalError(): TypeError {
  return new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
}

describe('verifyAnthropicApiKeyWithApi', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports a working key as valid and probes the models endpoint', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));

    await expect(verifyAnthropicApiKeyWithApi(API_KEY)).resolves.toEqual({
      state: 'valid',
      status: 200,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ANTHROPIC_DEFAULT_API_BASE_URL}/v1/models`);
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(API_KEY);
  });

  // Node strips `Authorization` on a cross-origin redirect but keeps the
  // nonstandard `x-api-key`, so following a 30x would hand the key to an
  // origin the user never configured. The probe has to refuse instead.
  it('refuses to follow redirects so the key cannot leak to another origin', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));

    await verifyAnthropicApiKeyWithApi(API_KEY);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe('error');
  });

  // The F15 connect fallback only commits a credential on `valid`, and treats
  // `invalid` as a rejected key. A refused redirect proves nothing about the
  // key, so it has to land in the recoverable `unknown` branch.
  it('maps a refused redirect to unknown rather than invalid', async () => {
    fetchMock.mockRejectedValue(redirectRefusalError());

    const result = await verifyAnthropicApiKeyWithApi(API_KEY, 'https://redirecting.example.com');

    expect(result.state).toBe('unknown');
    expect(result.state).not.toBe('invalid');
    expect(result.status).toBeNull();
    expect(result.errorType).toBe('redirect_refused');
    // `fetch` alone only says "fetch failed"; the reason lives on `cause`.
    expect(result.errorMessage).toBe('fetch failed: unexpected redirect');
  });

  // Negative control: a genuinely rejected key must still be `invalid`, or the
  // mapping above would just be swallowing every failure.
  it('still reports a rejected key as invalid', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } })
    );

    await expect(verifyAnthropicApiKeyWithApi(API_KEY)).resolves.toEqual({
      state: 'invalid',
      status: 401,
      errorType: 'authentication_error',
      errorMessage: 'invalid x-api-key',
    });
  });

  it('reports an unrelated transport failure as unknown without a redirect tag', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }));

    const result = await verifyAnthropicApiKeyWithApi(API_KEY);

    expect(result.state).toBe('unknown');
    expect(result.errorType).toBeNull();
    expect(result.errorMessage).toBe('fetch failed: ECONNREFUSED');
  });
});
