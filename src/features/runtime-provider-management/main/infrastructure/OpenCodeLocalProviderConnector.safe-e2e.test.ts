import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OpenCodeLocalProviderConnector } from './OpenCodeLocalProviderConnector';

describe('OpenCodeLocalProviderConnector safe e2e', () => {
  let tempDir: string;
  let server: http.Server | null;
  let requests: string[];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-teams-local-provider-e2e-'));
    server = null;
    requests = [];
  });

  afterEach(async () => {
    if (server) {
      await closeServer(server);
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('discovers models over HTTP and preserves existing JSONC while configuring OpenCode', async () => {
    const projectPath = path.join(tempDir, 'sandbox-project');
    await fs.mkdir(projectPath, { recursive: true });
    const configPath = path.join(projectPath, 'opencode.jsonc');
    await fs.writeFile(
      configPath,
      [
        '{',
        '  // keep this project-owned comment',
        '  "plugin": ["example-plugin"],',
        '  "provider": {',
        '    "existing": { "npm": "@ai-sdk/openai-compatible" }',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8'
    );
    const started = await startModelServer(requests);
    server = started.server;
    const connector = new OpenCodeLocalProviderConnector();

    const probe = await connector.probeLocalProvider({
      runtimeId: 'opencode',
      presetId: 'custom',
      providerId: 'local-test',
      baseUrl: started.baseUrl,
    });

    expect(probe.error).toBeUndefined();
    expect(probe.probe).toMatchObject({
      state: 'available',
      providerId: 'local-test',
      baseUrl: `${started.baseUrl}/v1`,
      models: [
        { id: 'phi-4', displayName: 'Phi 4' },
        { id: 'qwen3:8b', displayName: 'qwen3:8b' },
      ],
    });

    const configured = await connector.configureLocalProvider({
      runtimeId: 'opencode',
      projectPath,
      presetId: 'custom',
      providerId: 'local-test',
      baseUrl: started.baseUrl,
      defaultModelId: 'qwen3:8b',
      setAsProjectDefault: true,
    });

    expect(configured.error).toBeUndefined();
    expect(configured.configuration).toMatchObject({
      providerId: 'local-test',
      baseUrl: `${started.baseUrl}/v1`,
      modelIds: ['phi-4', 'qwen3:8b'],
      defaultModelId: 'qwen3:8b',
      modelRoute: 'local-test/qwen3:8b',
      configPath: await fs.realpath(configPath),
      setAsProjectDefault: true,
    });
    expect(requests.filter((request) => request === 'GET /v1/models')).toHaveLength(2);

    const raw = await fs.readFile(configPath, 'utf8');
    expect(raw).toContain('// keep this project-owned comment');
    const parsed = parse(raw) as {
      plugin: string[];
      provider: Record<string, Record<string, unknown>>;
      model: string;
      small_model: string;
    };
    expect(parsed.plugin).toEqual(['example-plugin']);
    expect(parsed.provider.existing).toEqual({ npm: '@ai-sdk/openai-compatible' });
    expect(parsed.provider['local-test']).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: `${started.baseUrl}/v1` },
      models: { 'phi-4': {}, 'qwen3:8b': {} },
    });
    expect(parsed.model).toBe('local-test/qwen3:8b');
    expect(parsed.small_model).toBe('local-test/qwen3:8b');
  });

  it('scans every built-in local server preset without including the custom endpoint', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:1234/v1/models') {
        return new Response(
          JSON.stringify({ object: 'list', data: [{ id: 'lmstudio-model', object: 'model' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new TypeError('connection refused');
    }) as typeof fetch;
    const connector = new OpenCodeLocalProviderConnector({ fetchImpl });

    const response = await connector.scanLocalProviders({ runtimeId: 'opencode' });

    expect(response.error).toBeUndefined();
    expect(response.probes?.map((probe) => probe.preset.id)).toEqual([
      'ollama',
      'lm-studio',
      'atomic-chat',
      'llama.cpp',
    ]);
    expect(response.probes?.find((probe) => probe.preset.id === 'lm-studio')).toMatchObject({
      state: 'available',
      providerId: 'lmstudio',
      models: [{ id: 'lmstudio-model', displayName: 'lmstudio-model' }],
    });
    expect(
      response.probes
        ?.filter((probe) => probe.preset.id !== 'lm-studio')
        .every((probe) => probe.state === 'unavailable')
    ).toBe(true);
  });
});

async function startModelServer(requests: string[]): Promise<{
  server: http.Server;
  baseUrl: string;
}> {
  const server = http.createServer((request, response) => {
    requests.push(`${request.method ?? 'GET'} ${request.url ?? '/'}`);
    if (request.method === 'OPTIONS' && request.url === '/v1/models') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET',
        'access-control-allow-headers': 'accept',
      });
      response.end();
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
      response.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'qwen3:8b', object: 'model' },
            { id: 'phi-4', name: 'Phi 4', object: 'model' },
            { id: 'qwen3:8b', object: 'model' },
          ],
        })
      );
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Mock local provider server did not bind to a TCP port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
