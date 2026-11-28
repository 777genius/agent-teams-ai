import { GitHubAuthorizationError } from '../../core/application/deviceAuthorization';

import type { DeviceIssuer } from '../../core/application/deviceAuthorization';

async function json(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) throw new GitHubAuthorizationError('GitHub sign-in expired.');
    throw new Error('GitHub sign-in failed.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  let ended = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        ended = true;
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > 64 * 1024) throw new Error('Invalid sign-in response.');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    if (!ended) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Fixed GitHub issuer and identity endpoint; no callback server or client secret. */
export function createGitHubDeviceIssuer(fetcher: typeof fetch = fetch): DeviceIssuer {
  const post = async (
    path: '/login/device/code' | '/login/oauth/access_token',
    parameters: Readonly<Record<string, string>>,
    signal: AbortSignal
  ) =>
    json(
      await fetcher(`https://github.com${path}`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(parameters),
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      })
    );
  return {
    request: (parameters, signal) => post('/login/device/code', parameters, signal),
    exchange: (parameters, signal) => post('/login/oauth/access_token', parameters, signal),
    async identity(token, signal) {
      const value = await json(
        await fetcher('https://api.github.com/user', {
          method: 'GET',
          redirect: 'error',
          headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        })
      );
      if (
        !value ||
        typeof value !== 'object' ||
        !('id' in value) ||
        !Number.isSafeInteger(value.id) ||
        Number(value.id) < 1
      )
        throw new Error('Invalid GitHub account.');
      return String(value.id);
    },
  };
}
