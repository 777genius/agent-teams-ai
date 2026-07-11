import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerHttpSecurityMiddleware } from '../../../../src/main/services/infrastructure/HttpServer';

async function createSecuredTestApp(authToken: string | null, corsOrigin?: string) {
  const app = Fastify({ logger: false });
  await registerHttpSecurityMiddleware(app, authToken, corsOrigin);

  app.get('/api/secure', async () => ({ success: true }));
  app.get('/health', async () => ({ ok: true }));

  return app;
}

describe('HttpServer security middleware', () => {
  it('handles authenticated CORS preflight before bearer auth', async () => {
    const app = await createSecuredTestApp('expected-token', 'http://localhost:5173');

    try {
      const preflight = await app.inject({
        method: 'OPTIONS',
        url: '/api/secure',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
          authorization: 'Bearer wrong-token',
        },
      });

      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(preflight.headers['access-control-allow-credentials']).toBe('true');
      expect(preflight.body).not.toContain('Unauthorized');
    } finally {
      await app.close();
    }
  });

  it('keeps non-preflight API requests fail-closed without bearer auth', async () => {
    const app = await createSecuredTestApp('expected-token', 'http://localhost:5173');

    try {
      const missingAuth = await app.inject({
        method: 'GET',
        url: '/api/secure',
        headers: {
          origin: 'http://localhost:5173',
        },
      });
      expect(missingAuth.statusCode).toBe(401);

      const wrongAuth = await app.inject({
        method: 'GET',
        url: '/api/secure',
        headers: {
          origin: 'http://localhost:5173',
          authorization: 'Bearer wrong-token',
        },
      });
      expect(wrongAuth.statusCode).toBe(401);

      const malformedAuth = await app.inject({
        method: 'GET',
        url: '/api/secure',
        headers: {
          origin: 'http://localhost:5173',
          authorization: 'Bearer expected-token extra',
        },
      });
      expect(malformedAuth.statusCode).toBe(401);

      const validAuth = await app.inject({
        method: 'GET',
        url: '/api/secure',
        headers: {
          origin: 'http://localhost:5173',
          authorization: 'Bearer expected-token',
        },
      });
      expect(validAuth.statusCode).toBe(200);
      expect(validAuth.json()).toEqual({ success: true });
    } finally {
      await app.close();
    }
  });

  it('does not emit wildcard CORS headers with credentials for wildcard origin config', async () => {
    const app = await createSecuredTestApp('expected-token', '*');

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/secure',
        headers: {
          origin: 'https://example.test',
          authorization: 'Bearer expected-token',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('https://example.test');
      expect(response.headers['access-control-allow-origin']).not.toBe('*');
      expect(response.headers['access-control-allow-credentials']).toBe('true');

      const preflight = await app.inject({
        method: 'OPTIONS',
        url: '/api/secure',
        headers: {
          origin: 'https://example.test',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
        },
      });

      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe('https://example.test');
      expect(preflight.headers['access-control-allow-origin']).not.toBe('*');
      expect(preflight.headers['access-control-allow-credentials']).toBe('true');
    } finally {
      await app.close();
    }
  });
});
