import { describe, expect, it } from 'vitest';

import {
  createEmptyEndpointMap,
  createOpenCodeApiDiscoverySnapshot,
  detectOpenCodeApiCapabilities,
  resolveMissingOpenCodeCapabilities,
  type OpenCodeApiEndpointMap,
} from '../../../../src/main/services/team/opencode/capabilities/OpenCodeApiCapabilities';

describe('OpenCodeApiCapabilities', () => {
  it('proves production launch capabilities from OpenAPI v1.14-style paths', async () => {
    const fetch = fakeFetch({
      '/doc': jsonResponse(openApiDocument()),
      '/global/health': jsonResponse({ version: '1.14.19' }),
    });

    await expect(
      detectOpenCodeApiCapabilities({
        baseUrl: 'http://127.0.0.1:4096',
        fetchImpl: fetch,
        timeoutMs: 100,
      })
    ).resolves.toMatchObject({
      version: '1.14.19',
      source: 'openapi_doc',
      endpoints: {
        permissionReply: true,
        experimentalToolIds: true,
      },
      evidence: {
        permissionReply: 'openapi',
        experimentalToolIds: 'openapi',
      },
      requiredForTeamLaunch: {
        ready: true,
        missing: [],
      },
    });
  });

  it('keeps launch blocked when no permission reply route is proven', async () => {
    const document = openApiDocument({
      withoutPaths: ['/permission/{requestID}/reply'],
    });
    const fetch = fakeFetch({
      '/doc': jsonResponse(document),
      '/global/health': jsonResponse({ version: '1.14.19' }),
    });

    const capabilities = await detectOpenCodeApiCapabilities({
      baseUrl: 'http://127.0.0.1:4096',
      fetchImpl: fetch,
      timeoutMs: 100,
    });

    expect(capabilities.endpoints.permissionReply).toBe(false);
    expect(capabilities.requiredForTeamLaunch).toEqual({
      ready: false,
      missing: ['POST permission reply route'],
    });
    expect(capabilities.diagnostics).toContain(
      'OpenCode permission response endpoint was not proven by OpenAPI; require real permission E2E before production launch'
    );
  });

  it('accepts the legacy session permission response route as compatibility fallback', async () => {
    const document = openApiDocument({
      withoutPaths: ['/permission/{requestID}/reply'],
      extraPaths: {
        '/session/{sessionID}/permissions/{permissionID}': { post: {} },
      },
    });
    const fetch = fakeFetch({
      '/doc': jsonResponse(document),
      '/global/health': jsonResponse({ version: '1.14.19' }),
    });

    const capabilities = await detectOpenCodeApiCapabilities({
      baseUrl: 'http://127.0.0.1:4096',
      fetchImpl: fetch,
      timeoutMs: 100,
    });

    expect(capabilities.endpoints.permissionReply).toBe(false);
    expect(capabilities.endpoints.permissionLegacySessionRespond).toBe(true);
    expect(capabilities.requiredForTeamLaunch).toEqual({ ready: true, missing: [] });
  });

  it('uses safe direct probes as evidence when OpenAPI doc is unavailable', async () => {
    const fetch = fakeFetch({
      '/doc': new Response('missing', { status: 404 }),
      '/doc.json': new Response('<html>not json</html>', { status: 200 }),
      '/openapi.json': new Response('missing', { status: 404 }),
      '/global/health': jsonResponse({ build: { version: '1.14.19' } }),
      '/session/status': jsonResponse({}),
      '/permission/': jsonResponse([]),
      '/event': eventStreamResponse(),
      '/global/event': eventStreamResponse(),
      '/mcp': jsonResponse([]),
      '/experimental/tool/ids': jsonResponse(['agent-teams_runtime_deliver_message']),
    });

    const capabilities = await detectOpenCodeApiCapabilities({
      baseUrl: 'http://127.0.0.1:4096',
      fetchImpl: fetch,
      timeoutMs: 100,
    });

    expect(capabilities.version).toBe('1.14.19');
    expect(capabilities.source).toBe('direct_probe');
    expect(capabilities.endpoints.permissionList).toBe(true);
    expect(capabilities.evidence.permissionList).toBe('direct_probe');
    expect(capabilities.requiredForTeamLaunch.ready).toBe(false);
    expect(capabilities.requiredForTeamLaunch.missing).toContain('POST /session');
    expect(capabilities.requiredForTeamLaunch.missing).toContain('POST permission reply route');
  });

  it('uses experimental tool list as fallback for tool availability proof', () => {
    const endpoints: OpenCodeApiEndpointMap = {
      ...createEmptyEndpointMap(),
      health: true,
      sessionCreate: true,
      sessionGet: true,
      sessionMessageList: true,
      sessionPromptAsync: true,
      sessionAbort: true,
      sessionStatus: true,
      permissionList: true,
      permissionReply: true,
      sessionEventStream: true,
      globalEventStream: true,
      mcpList: true,
      mcpCreate: true,
      experimentalToolIds: false,
      experimentalToolList: true,
    };

    expect(resolveMissingOpenCodeCapabilities(endpoints)).toEqual([]);
  });

  it('redacts credentials and hashes the OpenAPI document in discovery snapshots', async () => {
    const capabilities = await detectOpenCodeApiCapabilities({
      baseUrl: 'http://user:secret@127.0.0.1:4096',
      fetchImpl: fakeFetch({
        '/doc': jsonResponse(openApiDocument()),
        '/global/health': jsonResponse({ version: '1.14.19' }),
      }),
      timeoutMs: 100,
    });

    const snapshot = createOpenCodeApiDiscoverySnapshot({
      baseUrl: 'http://user:secret@127.0.0.1:4096',
      checkedAt: '2026-04-21T12:00:00.000Z',
      capabilities,
      openApiDocument: openApiDocument(),
    });

    expect(snapshot).toMatchObject({
      checkedAt: '2026-04-21T12:00:00.000Z',
      opencodeVersion: '1.14.19',
      baseUrlRedacted: 'http://redacted:redacted@127.0.0.1:4096/',
    });
    expect(snapshot.openApiHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

function openApiDocument(options: {
  withoutPaths?: string[];
  extraPaths?: Record<string, Record<string, unknown>>;
} = {}): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {
    '/global/health': { get: {} },
    '/session': { post: {} },
    '/session/{id}': { get: {} },
    '/session/{id}/message': { get: {} },
    '/session/{id}/prompt_async': { post: {} },
    '/session/{id}/abort': { post: {} },
    '/session/status': { get: {} },
    '/permission': { get: {} },
    '/permission/{requestID}/reply': { post: {} },
    '/event': { get: {} },
    '/global/event': { get: {} },
    '/mcp': { get: {}, post: {} },
    '/experimental/tool/ids': { get: {} },
    ...options.extraPaths,
  };

  for (const path of options.withoutPaths ?? []) {
    delete paths[path];
  }

  return {
    openapi: '3.1.0',
    info: { title: 'OpenCode', version: '1.14.19' },
    paths,
  };
}

function fakeFetch(routes: Record<string, Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const response = routes[url.pathname];
    if (!response) {
      return new Response('not found', { status: 404 });
    }
    return response.clone();
  }) as typeof fetch;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function eventStreamResponse(): Response {
  return new Response('', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}
