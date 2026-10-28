import cors from '@fastify/cors';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import { postWithReboundHost } from '../../../scripts/e2e/uap-management-http';
import { EXTENSION_MANAGEMENT_METHODS } from '../../../src/features/extension-management/contracts';
import { registerExtensionManagementHttp } from '../../../src/features/extension-management/main/adapters/input/registerExtensionManagementHttp';
import { ManagementHttpCapability } from '../../../src/features/extension-management/main/infrastructure/ManagementHttpCapability';

import type { ExtensionManagementFeature } from '../../../src/features/extension-management/core/application/ports';

it('returns feature-local refusals through the real CORS middleware without invoking management', async () => {
  const app = Fastify();
  const hostStatus = vi.fn(() => Promise.resolve({ available: true }));
  const capture = vi.fn(() => Promise.resolve({ contextId: 'trusted' }));
  const capability = new ManagementHttpCapability();
  capability.rotate();
  const token = new URL(capability.browserUrl(4141)).hash.split('=')[1];
  // The desktop sidecar rejects foreign origins in the earlier onRequest hook.
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin))
        callback(null, true);
      else callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
  });
  registerExtensionManagementHttp(
    app,
    { hostStatus, capture } as unknown as ExtensionManagementFeature,
    (authorization) => capability.accepts(authorization)
  );
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a bound TCP listener');
    const host = `127.0.0.1:${address.port}`;
    const viewerHeaders = {
      host,
      origin: `http://${host}`,
      'content-type': 'application/json',
    };
    const headers = {
      ...viewerHeaders,
      authorization: `Bearer ${token}`,
    };
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
    for (const authorization of [
      undefined,
      '',
      'Bearer invalid',
      `Bearer ${'0'.repeat(64)}`,
      `Basic ${token}`,
    ]) {
      const refused = await app.inject({
        method: 'POST',
        url: '/api/extension-management/capture',
        headers: authorization === undefined ? viewerHeaders : { ...viewerHeaders, authorization },
        payload: { client: 'opencode', scope: 'user' },
      });
      expect(refused.statusCode).toBe(401);
      expect(refused.json().code).toBe('MANAGEMENT_AUTH_REQUIRED');
    }
    expect(capture).not.toHaveBeenCalled();
    for (const method of EXTENSION_MANAGEMENT_METHODS.filter((method) => method !== 'hostStatus')) {
      const refused = await app.inject({
        method: 'POST',
        url: `/api/extension-management/${method}`,
        headers: viewerHeaders,
        payload: {},
      });
      expect(refused.statusCode).toBe(401);
    }
    const viewer = await app.inject({
      method: 'POST',
      url: '/api/extension-management/hostStatus',
      headers: viewerHeaders,
      payload: {},
    });
    expect(viewer.json()).toMatchObject({ available: false });
    expect(viewer.body).not.toContain(token);
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
    const captured = await app.inject({
      method: 'POST',
      url: '/api/extension-management/capture',
      headers,
      payload: {},
    });
    expect(captured.statusCode).toBe(200);
    expect(capture).toHaveBeenCalledOnce();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/extension-management/browserAccess',
          headers,
          payload: {},
        })
      ).statusCode
    ).toBe(404);
    capability.revoke();
    expect(capability.accepts(headers.authorization)).toBe(false);
    capability.rotate();
    const stale = await app.inject({
      method: 'POST',
      url: '/api/extension-management/capture',
      headers,
      payload: {},
    });
    expect(stale.statusCode).toBe(401);
    expect(capture).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});
