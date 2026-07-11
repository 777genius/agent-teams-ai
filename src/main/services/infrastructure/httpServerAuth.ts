import { createHmac, timingSafeEqual } from 'node:crypto';

export const HTTP_AUTH_TOKEN_ENV = 'AGENT_TEAMS_HTTP_AUTH_TOKEN';

const HTTP_AUTH_HMAC_KEY = 'agent-teams-http-auth-token-v1';
const HTTP_AUTH_TOKEN_MAX_LENGTH = 4096;

export function isLoopbackHttpHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function getHttpAuthTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env[HTTP_AUTH_TOKEN_ENV]?.trim();
  return token ? token : null;
}

export function assertHttpServerBindAllowed(host: string, authToken: string | null): void {
  if (!isLoopbackHttpHost(host) && !authToken) {
    throw new Error(
      `Refusing to bind HTTP server to non-loopback host without ${HTTP_AUTH_TOKEN_ENV}`
    );
  }
}

function digestAuthToken(token: string): Buffer {
  return createHmac('sha256', HTTP_AUTH_HMAC_KEY).update(token).digest();
}

export function timingSafeHttpAuthTokenEquals(expected: string, received: string): boolean {
  if (!received || received.length > HTTP_AUTH_TOKEN_MAX_LENGTH) {
    return false;
  }

  const expectedDigest = digestAuthToken(expected);
  const receivedDigest = digestAuthToken(received);
  return timingSafeEqual(expectedDigest, receivedDigest);
}

export function extractBearerAuthToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (!scheme || scheme.toLowerCase() !== 'bearer' || rest.length !== 1) {
    return null;
  }

  return rest[0] ?? null;
}
