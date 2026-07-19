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
        '    "existing": { "npm": "@ai-sdk/openai-compatible" },',
        '    "local-test": {',
        '      // keep this provider-owned comment',
        '      "customFlag": true,',
        '      "options": { "headers": { "x-test": "preserve" } },',
        '      "models": {',
        '        "manual-model": { "name": "Manual model" },',
        '        "__proto__": { "name": "Reserved model id" }',
        '      }',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8'
    );
    if (process.platform !== 'win32') {
      await fs.chmod(configPath, 0o600);
    }
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
        { id: '__proto__', displayName: '__proto__' },
        { id: 'phi-4', displayName: 'Phi 4' },
        { id: 'qwen3:8b', displayName: 'qwen3:8b' },
      ],
    });

    const configured = await connector.configureLocalProvider({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath,
      presetId: 'custom',
      providerId: 'local-test',
      baseUrl: started.baseUrl,
      defaultModelId: 'qwen3:8b',
      setAsDefault: true,
    });

    const secondaryConfigured = await connector.configureLocalProvider({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath,
      presetId: 'custom',
      providerId: 'local-secondary',
      baseUrl: started.baseUrl,
      defaultModelId: 'phi-4',
      setAsDefault: false,
    });

    expect(configured.error).toBeUndefined();
    expect(configured.configuration).toMatchObject({
      providerId: 'local-test',
      baseUrl: `${started.baseUrl}/v1`,
      modelIds: ['__proto__', 'phi-4', 'qwen3:8b'],
      defaultModelId: 'qwen3:8b',
      modelRoute: 'local-test/qwen3:8b',
      configPath: await fs.realpath(configPath),
      scope: 'project',
      setAsDefault: true,
    });
    expect(secondaryConfigured.error).toBeUndefined();
    expect(secondaryConfigured.configuration).toMatchObject({
      providerId: 'local-secondary',
      defaultModelId: 'phi-4',
      scope: 'project',
      setAsDefault: false,
    });
    expect(requests.filter((request) => request === 'GET /v1/models')).toHaveLength(3);

    const raw = await fs.readFile(configPath, 'utf8');
    expect(raw).toContain('// keep this project-owned comment');
    expect(raw).toContain('// keep this provider-owned comment');
    expect(raw.match(/"__proto__"/g)).toHaveLength(2);
    if (process.platform !== 'win32') {
      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
    }
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
      customFlag: true,
      options: {
        baseURL: `${started.baseUrl}/v1`,
        headers: { 'x-test': 'preserve' },
      },
      models: {
        'manual-model': { name: 'Manual model' },
        'phi-4': {},
        'qwen3:8b': {},
      },
    });
    expect(parsed.provider['local-secondary']).toMatchObject({
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

  it('refuses ambiguous duplicate JSONC keys without changing the project config', async () => {
    const projectPath = path.join(tempDir, 'duplicate-config-project');
    await fs.mkdir(projectPath, { recursive: true });
    const configPath = path.join(projectPath, 'opencode.json');
    const original = [
      '{',
      '  "provider": { "local-test": { "models": { "first": {} } } },',
      '  "provider": { "local-test": { "models": { "shadowed": {} } } }',
      '}',
      '',
    ].join('\n');
    await fs.writeFile(configPath, original, 'utf8');
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'qwen3:8b', object: 'model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const connector = new OpenCodeLocalProviderConnector({ fetchImpl });

    const response = await connector.configureLocalProvider({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath,
      presetId: 'custom',
      providerId: 'local-test',
      baseUrl: 'http://127.0.0.1:18123/v1',
      defaultModelId: 'qwen3:8b',
      setAsDefault: true,
    });

    expect(response.configuration).toBeUndefined();
    expect(response.error).toMatchObject({
      code: 'config-invalid',
      message: expect.stringContaining('duplicate object keys'),
    });
    expect(await fs.readFile(configPath, 'utf8')).toBe(original);
  });

  it('cancels an oversized chunked model response before buffering the full payload', async () => {
    let chunkCount = 0;
    let cancelled = false;
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            chunkCount += 1;
            if (chunkCount <= 4) {
              controller.enqueue(new Uint8Array(400_000));
            } else {
              controller.close();
            }
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as typeof fetch;
    const connector = new OpenCodeLocalProviderConnector({ fetchImpl });

    const response = await connector.probeLocalProvider({
      runtimeId: 'opencode',
      presetId: 'custom',
      providerId: 'local-test',
      baseUrl: 'http://127.0.0.1:18123/v1',
    });

    expect(response.probe).toMatchObject({
      state: 'unavailable',
      message: 'Local server returned a model list that is too large.',
    });
    expect(cancelled).toBe(true);
    expect(chunkCount).toBeLessThan(5);
  });

  it('creates a new project config with private file permissions', async () => {
    const projectPath = path.join(tempDir, 'new-config-project');
    await fs.mkdir(projectPath, { recursive: true });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'qwen3:8b', object: 'model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const connector = new OpenCodeLocalProviderConnector({ fetchImpl });

    const response = await connector.configureLocalProvider({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath,
      presetId: 'custom',
      providerId: 'local-test',
      baseUrl: 'http://127.0.0.1:18123/v1',
      defaultModelId: 'qwen3:8b',
      setAsDefault: true,
    });

    const configPath = path.join(projectPath, 'opencode.json');
    expect(response.error).toBeUndefined();
    expect(response.configuration?.configPath).toBe(await fs.realpath(configPath));
    expect(await fs.readFile(configPath, 'utf8')).toContain('"local-test"');
    if (process.platform !== 'win32') {
      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('creates a private global config and can set the global default without a project', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'qwen3:8b', object: 'model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const connector = new OpenCodeLocalProviderConnector({ fetchImpl, homePath: tempDir });

    const response = await connector.configureLocalProvider({
      runtimeId: 'opencode',
      scope: 'global',
      presetId: 'ollama',
      defaultModelId: 'qwen3:8b',
      setAsDefault: true,
    });

    const configPath = path.join(tempDir, '.config', 'opencode', 'opencode.json');
    expect(response.error).toBeUndefined();
    expect(response.configuration).toMatchObject({
      scope: 'global',
      providerId: 'ollama',
      defaultModelId: 'qwen3:8b',
      setAsDefault: true,
      configPath: await fs.realpath(configPath),
    });
    const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      model: string;
      small_model: string;
      provider: Record<string, unknown>;
    };
    expect(parsed.model).toBe('ollama/qwen3:8b');
    expect(parsed.small_model).toBe('ollama/qwen3:8b');
    expect(parsed.provider.ollama).toBeDefined();
    if (process.platform !== 'win32') {
      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses ambiguous global JSON and JSONC configs without changing either file', async () => {
    const configDirectory = path.join(tempDir, '.config', 'opencode');
    await fs.mkdir(configDirectory, { recursive: true });
    const jsonPath = path.join(configDirectory, 'opencode.json');
    const jsoncPath = path.join(configDirectory, 'opencode.jsonc');
    await fs.writeFile(jsonPath, '{}\n', 'utf8');
    await fs.writeFile(jsoncPath, '{ /* keep */ }\n', 'utf8');
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'qwen3:8b', object: 'model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const connector = new OpenCodeLocalProviderConnector({ fetchImpl, homePath: tempDir });

    const response = await connector.configureLocalProvider({
      runtimeId: 'opencode',
      scope: 'global',
      presetId: 'ollama',
      defaultModelId: 'qwen3:8b',
      setAsDefault: true,
    });

    expect(response.configuration).toBeUndefined();
    expect(response.error).toMatchObject({ code: 'config-conflict' });
    expect(await fs.readFile(jsonPath, 'utf8')).toBe('{}\n');
    expect(await fs.readFile(jsoncPath, 'utf8')).toBe('{ /* keep */ }\n');
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
            { id: '__proto__', object: 'model' },
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
