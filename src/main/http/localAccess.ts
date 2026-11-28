import type { FastifyRequest } from 'fastify';

/** Exact loopback host/origin checks for APIs exposing private local state. */
export function localHttpOrigin(host: string): string | null {
  if (!/^(127\.0\.0\.1|localhost)(:[0-9]{1,5})?$/.test(host)) return null;
  const port = host.split(':')[1];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- exact local origin normalization
  return new URL('http://' + host).origin;
}

export function isLocalHttpRead(request: FastifyRequest): boolean {
  const expectedOrigin = localHttpOrigin(request.headers.host ?? '');
  const site = request.headers['sec-fetch-site'];
  if (expectedOrigin === null) return false;
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- exact loopback source allowlist
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip)) return false;
  if (request.headers.origin !== undefined && request.headers.origin !== expectedOrigin)
    return false;
  return site === undefined || site === 'same-origin' || site === 'none';
}
