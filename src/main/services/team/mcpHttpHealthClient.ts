import http from 'node:http';

const HEALTH_POLL_MS = 100;
const HEALTH_BODY_MAX_BYTES = 8 * 1024;

export interface LoopbackHealthProbe<TIdentity> {
  healthy: boolean;
  statusCode: number | null;
  identity: TIdentity | null;
}

export async function probeAuthenticatedLoopbackHealth<TIdentity>(
  host: string,
  port: number,
  authToken: string | undefined,
  parseIdentity: (raw: string) => TIdentity | null
): Promise<LoopbackHealthProbe<TIdentity>> {
  return new Promise((resolve) => {
    let settled = false;
    let body = '';
    const finish = (probe: LoopbackHealthProbe<TIdentity>): void => {
      if (settled) return;
      settled = true;
      resolve(probe);
    };
    const request = http.get(
      {
        host,
        port,
        path: '/health',
        timeout: HEALTH_POLL_MS,
        ...(authToken ? { headers: { authorization: `Bearer ${authToken}` } } : {}),
      },
      (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          if (body.length < HEALTH_BODY_MAX_BYTES) {
            body += chunk.slice(0, HEALTH_BODY_MAX_BYTES - body.length);
          }
        });
        response.on('end', () => {
          const statusCode = response.statusCode ?? null;
          const healthy = statusCode !== null && statusCode >= 200 && statusCode < 300;
          finish({
            healthy,
            statusCode,
            identity: healthy ? parseIdentity(body) : null,
          });
        });
      }
    );
    request.once('timeout', () => {
      request.destroy();
      finish({ healthy: false, statusCode: null, identity: null });
    });
    request.once('error', () => {
      finish({ healthy: false, statusCode: null, identity: null });
    });
  });
}

export async function waitForAuthenticatedLoopbackHealth<TIdentity>(
  host: string,
  port: number,
  timeoutMs: number,
  authToken: string | undefined,
  parseIdentity: (raw: string) => TIdentity | null
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((await probeAuthenticatedLoopbackHealth(host, port, authToken, parseIdentity)).healthy) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  throw new Error(
    `Agent Teams MCP HTTP server did not become healthy at ${host}:${port} in ${timeoutMs}ms`
  );
}
