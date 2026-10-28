import { BrowserAccessSession } from '@features/local-http-auth/renderer';
import { vi } from 'vitest';

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function fixtureRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

export function fixtureKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}
/** Fixture readiness service for authorized-method characterization; data uses the caller's fake fetch. */
export function fixtureBrowserAccess(baseUrl: string): BrowserAccessSession {
  const dataFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, options?: RequestInit) =>
    fixtureRequestUrl(input) === `${baseUrl}/api/auth/ready`
      ? Promise.resolve(new Response(JSON.stringify({ ready: true, service: 'api' })))
      : dataFetch(input, options)
  );
  const session = new BrowserAccessSession(baseUrl);
  void session.enterKey(fixtureKey());
  return session;
}
