// @vitest-environment node
import { createServer, type RequestListener, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GatewayHttpError,
  probeGatewayModels,
  readGatewayUsageDay,
} from '../main/adapters/output/HttpGatewayClient';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        })
    )
  );
});
async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return `http://127.0.0.1:${address.port}`;
}
function request(kind: 'models' | 'usage', baseUrl: string) {
  const input = { baseUrl, apiKey: 'fixture-only-key', day: '2026-10-20' };
  return kind === 'models' ? probeGatewayModels(input) : readGatewayUsageDay(input);
}
describe('gateway HTTP origin boundary', () => {
  it.each(['models', 'usage'] as const)(
    'rejects %s redirects without contacting the target',
    async (kind) => {
      let targetRequests = 0;
      const target = await listen((_req, response) => {
        targetRequests++;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ data: [{ id: 'redirected-model' }], model_stats: [] }));
      });
      const gateway = await listen((_req, response) => {
        response.writeHead(302, { Location: target + '/otherwise-forbidden-target' });
        response.end();
      });
      await expect(request(kind, gateway)).rejects.toBeInstanceOf(GatewayHttpError);
      expect(targetRequests).toBe(0);
    }
  );
  it.each(['models', 'usage'] as const)(
    'accepts direct %s JSON from the approved gateway',
    async (kind) => {
      const gateway = await listen((_req, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ data: [{ id: 'direct-model' }], model_stats: [] }));
      });
      await expect(request(kind, gateway)).resolves.toEqual(
        kind === 'models' ? ['direct-model'] : []
      );
    }
  );
});

describe('gateway HTTP response bounds', () => {
  it.each(['models', 'usage'] as const)(
    'rejects oversized %s bodies with or without Content-Length',
    async (kind) => {
      for (const contentLength of [false, true]) {
        const payload = JSON.stringify({
          data: [{ id: 'model' }],
          model_stats: [],
          padding: 'x'.repeat(5 * 1024 * 1024),
        });
        const gateway = await listen((_req, response) => {
          response.setHeader('Content-Type', 'application/json');
          if (contentLength) response.setHeader('Content-Length', Buffer.byteLength(payload));
          response.end(payload);
        });
        await expect(request(kind, gateway)).rejects.toMatchObject({
          name: 'GatewayHttpError',
          kind: 'shape',
          message: 'Gateway response is too large.',
        });
      }
    }
  );
  it.each(['models', 'usage'] as const)('rejects malformed %s JSON', async (kind) => {
    const gateway = await listen((_req, response) => response.end('{'));
    await expect(request(kind, gateway)).rejects.toMatchObject({
      kind: 'shape',
      message: 'Gateway returned invalid JSON.',
    });
  });
});
