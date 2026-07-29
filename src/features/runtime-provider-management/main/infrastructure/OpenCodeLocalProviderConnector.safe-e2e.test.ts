/* eslint-disable sonarjs/no-clear-text-protocols -- plain-HTTP local URLs are the safe test subject */
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

  it('restricts an existing provider to the models requested by a per-card setup action', async () => {
    const projectPath = path.join(tempDir, 'single-model-project');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(
      path.join(projectPath, 'opencode.json'),
      JSON.stringify({
        provider: {
          'local-scoped': {
            customFlag: true,
            models: { stale: {}, 'qwen3:8b': { name: 'Existing Qwen metadata' } },
          },
        },
      }),
      'utf8'
    );
    const started = await startModelServer(requests);
    server = started.server;
    const connector = new OpenCodeLocalProviderConnector();

    const response = await connector.configureLocalProvider({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath,
      presetId: 'custom',
      providerId: 'local-scoped',
      baseUrl: started.baseUrl,
      defaultModelId: 'qwen3:8b',
      modelIds: ['qwen3:8b'],
      setAsDefault: false,
    });

    expect(response.error).toBeUndefined();
    expect(response.configuration?.modelIds).toEqual(['qwen3:8b']);
    const configPath = path.join(projectPath, 'opencode.json');
    const parsed = parse(await fs.readFile(configPath, 'utf8')) as {
      provider: Record<string, { customFlag?: boolean; models: Record<string, unknown> }>;
    };
    expect(parsed.provider['local-scoped']).toMatchObject({
      customFlag: true,
      models: { 'qwen3:8b': { name: 'Existing Qwen metadata' } },
    });
  });

  it('preserves concurrent per-card additions while dropping unavailable configured models', async () => {
    const projectPath = path.join(tempDir, 'concurrent-model-project');
    await fs.mkdir(projectPath, { recursive: true });
    const configPath = path.join(projectPath, 'opencode.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        provider: {
          'local-concurrent': {
            models: { unavailable: {} },
          },
        },
      }),
      'utf8'
    );
    const started = await startModelServer(requests);
    server = started.server;
    const connector = new OpenCodeLocalProviderConnector();

    const configure = (modelId: string) =>
      connector.configureLocalProvider({
        runtimeId: 'opencode',
        scope: 'project',
        projectPath,
        presetId: 'custom',
        providerId: 'local-concurrent',
        baseUrl: started.baseUrl,
        defaultModelId: modelId,
        modelIds: [modelId],
        preserveAvailableConfiguredModels: true,
        setAsDefault: false,
      });
    const responses = await Promise.all([configure('qwen3:8b'), configure('phi-4')]);

    expect(responses.every((response) => response.error === undefined)).toBe(true);
    const parsed = parse(await fs.readFile(configPath, 'utf8')) as {
      provider: Record<string, { models: Record<string, unknown> }>;
    };
    expect(Object.keys(parsed.provider['local-concurrent'].models).sort()).toEqual([
      'phi-4',
      'qwen3:8b',
    ]);
    expect(responses.at(-1)?.configuration?.modelIds).toEqual(
      expect.arrayContaining(['phi-4', 'qwen3:8b'])
    );
  });

  it('rejects a requested model that the server no longer reports', async () => {
    const projectPath = path.join(tempDir, 'stale-model-project');
    await fs.mkdir(projectPath, { recursive: true });
    const started = await startModelServer(requests);
    server = started.server;
    const connector = new OpenCodeLocalProviderConnector();

    const response = await connector.configureLocalProvider({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath,
      presetId: 'custom',
      providerId: 'local-scoped',
      baseUrl: started.baseUrl,
      defaultModelId: 'qwen3:8b',
      modelIds: ['qwen3:8b', 'missing-model'],
      setAsDefault: false,
    });

    expect(response.configuration).toBeUndefined();
    expect(response.error).toMatchObject({
      code: 'invalid-input',
      message: expect.stringContaining('no longer reported'),
    });
    await expect(fs.access(path.join(projectPath, 'opencode.json'))).rejects.toThrow();
  });

  it('can assign only small_model while preserving the existing default model', async () => {
    const projectPath = path.join(tempDir, 'small-model-project');
    await fs.mkdir(projectPath, { recursive: true });
    const configPath = path.join(projectPath, 'opencode.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        model: 'anthropic/claude-sonnet',
        small_model: 'anthropic/claude-haiku',
      }),
      'utf8'
    );
    const connector = new OpenCodeLocalProviderConnector({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: [{ id: 'team-model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });

    const response = await connector.configureLocalProvider({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath,
      presetId: 'custom',
      providerId: 'local-small',
      baseUrl: 'http://127.0.0.1:18080/v1',
      defaultModelId: 'team-model',
      setAsDefault: false,
      setAsSmallModel: true,
    });

    expect(response.error).toBeUndefined();
    expect(response.configuration).toMatchObject({
      setAsDefault: false,
      setAsSmallModel: true,
    });
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      model: string;
      small_model: string;
    };
    expect(config.model).toBe('anthropic/claude-sonnet');
    expect(config.small_model).toBe('local-small/team-model');
  });

  it('rejects non-boolean small_model assignment before probing the provider', async () => {
    let probeCount = 0;
    const connector = new OpenCodeLocalProviderConnector({
      fetchImpl: (async () => {
        probeCount += 1;
        return new Response(JSON.stringify({ data: [{ id: 'team-model' }] }));
      }) as typeof fetch,
    });

    const response = await connector.configureLocalProvider({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath: tempDir,
      presetId: 'custom',
      providerId: 'local-small',
      baseUrl: 'http://127.0.0.1:18080/v1',
      defaultModelId: 'team-model',
      setAsDefault: false,
      setAsSmallModel: 'false' as unknown as boolean,
    });

    expect(response.error).toMatchObject({
      code: 'invalid-input',
      message: 'Lightweight-task model selection is invalid.',
    });
    expect(probeCount).toBe(0);
  });

  it('persists private-network approval before later list probes use the address', async () => {
    const projectPath = path.join(tempDir, 'private-provider-project');
    await fs.mkdir(projectPath, { recursive: true });
    const approvals: string[] = [];
    const privateNetworkApprovalStore = {
      isApproved: async (approval: { baseUrl: string }) => approvals.includes(approval.baseUrl),
      approve: async (approval: { baseUrl: string }) => {
        approvals.push(approval.baseUrl);
      },
    };
    const requestedUrls: string[] = [];
    const connector = new OpenCodeLocalProviderConnector({
      fetchImpl: (async (input: string | URL | Request) => {
        requestedUrls.push(String(input));
        return new Response(JSON.stringify({ data: [{ id: 'team-model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
      privateNetworkApprovalStore,
    });

    const configured = await connector.configureLocalProvider({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath,
      presetId: 'custom',
      providerId: 'home-server',
      baseUrl: 'http://192.168.1.20:8080/v1',
      defaultModelId: 'team-model',
      setAsDefault: false,
      setAsSmallModel: false,
      allowPrivateNetwork: true,
    });
    const listed = await connector.listLocalProviders({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath,
    });

    expect(configured.error).toBeUndefined();
    expect(approvals).toEqual(['http://192.168.1.20:8080/v1']);
    expect(listed.providers).toEqual([
      expect.objectContaining({
        providerId: 'home-server',
        privateNetworkApproved: true,
        state: 'available',
      }),
    ]);
    expect(requestedUrls).toEqual([
      'http://192.168.1.20:8080/v1/models',
      'http://192.168.1.20:8080/v1/models',
    ]);
  });

  it('reports approval persistence failure without misreporting the completed config write', async () => {
    const projectPath = path.join(tempDir, 'approval-failure-project');
    await fs.mkdir(projectPath, { recursive: true });
    const configPath = path.join(projectPath, 'opencode.json');
    const connector = new OpenCodeLocalProviderConnector({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: [{ id: 'team-model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
      privateNetworkApprovalStore: {
        isApproved: async () => false,
        approve: async () => {
          throw new Error('approval store is read-only');
        },
      },
    });

    const response = await connector.configureLocalProvider({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath,
      presetId: 'custom',
      providerId: 'home-server',
      baseUrl: 'http://192.168.1.20:8080/v1',
      defaultModelId: 'team-model',
      setAsDefault: false,
      setAsSmallModel: false,
      allowPrivateNetwork: true,
    });

    expect(response.error).toMatchObject({
      code: 'approval-write-failed',
      message: expect.stringContaining('OpenCode config was updated'),
      recoverable: true,
    });
    expect(JSON.parse(await fs.readFile(configPath, 'utf8'))).toMatchObject({
      provider: {
        'home-server': {
          options: { baseURL: 'http://192.168.1.20:8080/v1' },
        },
      },
    });
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

  it('persists Ollama tool support and native context limits for the selected model', async () => {
    const requests: Array<{ url: string; method: string; body: string | null }> = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      const request = input instanceof Request ? input : null;
      const url = request?.url ?? String(input);
      const method = init?.method ?? request?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : null;
      requests.push({ url, method, body });
      if (url === 'http://127.0.0.1:11434/api/show') {
        return new Response(
          JSON.stringify({
            capabilities: ['completion', 'tools'],
            model_info: {
              'qwen2.context_length': 32_768,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ data: [{ id: 'qwen2.5:0.5b', object: 'model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const connector = new OpenCodeLocalProviderConnector({ fetchImpl, homePath: tempDir });

    const response = await connector.configureLocalProvider({
      runtimeId: 'opencode',
      scope: 'global',
      presetId: 'ollama',
      defaultModelId: 'qwen2.5:0.5b',
      setAsDefault: true,
    });

    expect(response.error).toBeUndefined();
    expect(requests).toContainEqual({
      url: 'http://127.0.0.1:11434/api/show',
      method: 'POST',
      body: JSON.stringify({ model: 'qwen2.5:0.5b' }),
    });
    const configPath = path.join(tempDir, '.config', 'opencode', 'opencode.json');
    const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      provider: {
        ollama: {
          models: Record<string, unknown>;
        };
      };
    };
    expect(parsed.provider.ollama.models['qwen2.5:0.5b']).toEqual({
      tool_call: true,
      options: {
        reasoningEffort: 'none',
      },
      limit: {
        context: 32_768,
        output: 4_096,
      },
    });
  });

  it('hides Ollama embedding and stale models from the teammate model list', async () => {
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/v1/models')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'qwen3:4b' },
              { id: 'nomic-embed-text:latest' },
              { id: 'stale-chat:latest' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as { model?: string }) : {};
      if (body.model === 'qwen3:4b') {
        return new Response(JSON.stringify({ capabilities: ['completion', 'tools'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (body.model === 'nomic-embed-text:latest') {
        return new Response(JSON.stringify({ capabilities: ['embedding'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'model not found' }), { status: 404 });
    }) as typeof fetch;
    const connector = new OpenCodeLocalProviderConnector({ fetchImpl });

    const response = await connector.probeLocalProvider({
      runtimeId: 'opencode',
      presetId: 'ollama',
    });

    expect(response.error).toBeUndefined();
    expect(response.probe).toMatchObject({
      state: 'available',
      models: [{ id: 'qwen3:4b', displayName: 'qwen3:4b' }],
      message: 'Connected. Found 1 model.',
    });
  });

  it('serializes concurrent configures so neither provider block is lost', async () => {
    const projectPath = path.join(tempDir, 'concurrent-config-project');
    await fs.mkdir(projectPath, { recursive: true });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'qwen3:8b', object: 'model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const connector = new OpenCodeLocalProviderConnector({ fetchImpl });

    // Both configures read-modify-write the same opencode.json concurrently.
    // Without serialization the second read observes a stale snapshot and its
    // write drops the first provider block.
    const [a, b] = await Promise.all([
      connector.configureLocalProvider({
        runtimeId: 'opencode',
        scope: 'project',
        projectPath,
        presetId: 'custom',
        providerId: 'provider-a',
        baseUrl: 'http://127.0.0.1:18123/v1',
        defaultModelId: 'qwen3:8b',
        setAsDefault: false,
      }),
      connector.configureLocalProvider({
        runtimeId: 'opencode',
        scope: 'project',
        projectPath,
        presetId: 'custom',
        providerId: 'provider-b',
        baseUrl: 'http://127.0.0.1:18124/v1',
        defaultModelId: 'qwen3:8b',
        setAsDefault: false,
      }),
    ]);

    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    const config = await fs.readFile(path.join(projectPath, 'opencode.json'), 'utf8');
    expect(config).toContain('"provider-a"');
    expect(config).toContain('"provider-b"');
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

/* eslint-enable sonarjs/no-clear-text-protocols -- re-enable after the safe local HTTP fixtures */
