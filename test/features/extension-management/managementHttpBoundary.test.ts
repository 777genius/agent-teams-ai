import cors from '@fastify/cors';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import { postWithReboundHost } from '../../../scripts/e2e/uap-management-http';
import { registerExtensionManagementHttp } from '../../../src/features/extension-management/main/adapters/input/registerExtensionManagementHttp';

import type { ExtensionManagementFeature } from '../../../src/features/extension-management/core/application/ports';

it('returns feature-local refusals through the real CORS middleware without invoking management', async () => {
  const app = Fastify();
  const hostStatus = vi.fn(async () => ({ available: true }));
  // The desktop sidecar rejects foreign origins in the earlier onRequest hook.
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin))
        callback(null, true);
      else callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
  });
  registerExtensionManagementHttp(app, { hostStatus } as unknown as ExtensionManagementFeature);
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a bound TCP listener');
    const host = `127.0.0.1:${address.port}`;
    const headers = { host, origin: `http://${host}`, 'content-type': 'application/json' };
    for (const refused of [
      { headers: { ...headers, origin: 'https://attacker.invalid' } },
      { headers: { ...headers, origin: 'http://127.0.0.1:1' } },
      { headers: { ...headers, host: `rebound.invalid:${address.port}` } },
      { headers, remoteAddress: '192.0.2.10' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/extension-management/hostStatus',
        payload: {},
        ...refused,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: 'Extension management requires the trusted local application.',
      });
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
    const rebound = await postWithReboundHost(`http://${host}`);
    expect(rebound).toEqual({ status: 403, allowedOrigin: undefined });
    expect(hostStatus).not.toHaveBeenCalled();
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/extension-management/hostStatus',
      headers,
      payload: {},
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ available: true });
    expect(hostStatus).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});
