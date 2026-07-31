/* eslint-disable sonarjs/no-clear-text-protocols -- plain-HTTP local URLs are the connector subject */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OpenCodeLocalProviderConnector } from './OpenCodeLocalProviderConnector';

const writeOpenCodeConfig = async (
  directory: string,
  config: unknown,
  fileName = 'opencode.json'
): Promise<void> => {
  await fs.mkdir(directory, { recursive: true });
  const contents = typeof config === 'string' ? config : JSON.stringify(config);
  await fs.writeFile(path.join(directory, fileName), contents, 'utf8');
};

describe('OpenCodeLocalProviderConnector local provider list', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-teams-local-provider-list-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('reads every project-local provider and reports its live state and default', async () => {
    const projectPath = path.join(tempDir, 'sandbox-project');
    await writeOpenCodeConfig(
      projectPath,
      [
        '{',
        '  // project-owned comment',
        '  "model": "ollama/qwen3:8b",',
        '  "small_model": "local-lab/tiny-model",',
        '  "provider": {',
        '    "ollama": {',
        '      "npm": "@ai-sdk/openai-compatible",',
        '      "options": { "baseURL": "http://127.0.0.1:11434/v1" },',
        '      "models": { "qwen3:8b": {}, "phi-4": {} }',
        '    },',
        '    "local-lab": {',
        '      "npm": "@ai-sdk/openai-compatible",',
        '      "options": { "baseURL": "http://127.0.0.1:18080/v1" },',
        '      "models": { "tiny-model": {} }',
        '    },',
        '    "remote-compatible": {',
        '      "npm": "@ai-sdk/openai-compatible",',
        '      "options": { "baseURL": "https://example.com/v1" },',
        '      "models": { "remote-model": {} }',
        '    }',
        '  }',
        '}',
      ].join('\n'),
      'opencode.jsonc'
    );
    const requests: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url === 'http://127.0.0.1:11434/v1/models') {
        return new Response(
          JSON.stringify({ data: [{ id: 'qwen3:8b' }, { id: 'phi-4', name: 'Phi 4' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new TypeError('connection refused');
    }) as typeof fetch;
    const connector = new OpenCodeLocalProviderConnector({ fetchImpl });

    const response = await connector.listLocalProviders({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath,
    });

    expect(response.error).toBeUndefined();
    expect(response.providers).toHaveLength(3);
    expect(response.providers?.[0]).toMatchObject({
      preset: { id: 'ollama', displayName: 'Ollama' },
      providerId: 'ollama',
      configuredModelIds: ['qwen3:8b', 'phi-4'],
      defaultModelId: 'qwen3:8b',
      isDefault: true,
      state: 'available',
      liveModels: [
        { id: 'phi-4', displayName: 'Phi 4' },
        { id: 'qwen3:8b', displayName: 'qwen3:8b' },
      ],
    });
    expect(response.providers?.[1]).toMatchObject({
      preset: { id: 'custom', displayName: 'Custom OpenAI-compatible server' },
      providerId: 'local-lab',
      defaultModelId: 'tiny-model',
      smallModelId: 'tiny-model',
      isDefault: false,
      state: 'unavailable',
      liveModels: [],
    });
    expect(response.providers?.[2]).toMatchObject({
      preset: { id: 'custom', displayName: 'Custom OpenAI-compatible server' },
      providerId: 'remote-compatible',
      state: 'available',
      liveModels: [{ id: 'remote-model', displayName: 'remote-model' }],
      latencyMs: null,
      message: expect.stringContaining('OpenCode verifies'),
    });
    expect(requests).not.toContain('https://example.com/v1/models');
  });

  it('returns an empty list when the project has no OpenCode config yet', async () => {
    const projectPath = path.join(tempDir, 'empty-project');
    await fs.mkdir(projectPath, { recursive: true });
    const connector = new OpenCodeLocalProviderConnector();

    const response = await connector.listLocalProviders({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath,
    });

    expect(response.error).toBeUndefined();
    expect(response.providers).toEqual([]);
    expect(response.configPath).toBe(path.join(await fs.realpath(projectPath), 'opencode.json'));
  });

  it('treats a remote endpoint with a built-in provider id as custom', async () => {
    const projectPath = path.join(tempDir, 'remote-builtin-id-project');
    await writeOpenCodeConfig(projectPath, {
      provider: {
        ollama: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'https://models.example.com/v1' },
          models: { 'remote-model': {} },
        },
      },
    });
    const connector = new OpenCodeLocalProviderConnector({
      fetchImpl: (async () => {
        throw new Error('Remote providers must not be fetched while listing.');
      }) as typeof fetch,
    });

    const response = await connector.listLocalProviders({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath,
    });

    expect(response.error).toBeUndefined();
    expect(response.providers).toEqual([
      expect.objectContaining({
        preset: expect.objectContaining({ id: 'custom' }),
        providerId: 'ollama',
        state: 'available',
      }),
    ]);
  });

  it('defers a credential-backed loopback endpoint to OpenCode instead of probing without its key', async () => {
    const projectPath = path.join(tempDir, 'credential-loopback-project');
    await writeOpenCodeConfig(projectPath, {
      provider: {
        'local-secure': {
          npm: '@ai-sdk/openai-compatible',
          options: {
            baseURL: 'http://127.0.0.1:18080/v1',
            apiKey: '{file:~/.config/opencode/agent-teams-credentials/local-secure.key}',
          },
          models: { 'team-model': {} },
        },
      },
    });
    const connector = new OpenCodeLocalProviderConnector({
      fetchImpl: (async () => {
        throw new Error('Credential-backed providers must not be fetched without their key.');
      }) as typeof fetch,
    });

    const response = await connector.listLocalProviders({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath,
    });

    expect(response.error).toBeUndefined();
    expect(response.providers).toEqual([
      expect.objectContaining({
        providerId: 'local-secure',
        hasConfiguredApiKey: true,
        state: 'available',
        liveModels: [{ id: 'team-model', displayName: 'team-model' }],
        message: expect.stringContaining('Credential-backed endpoint'),
      }),
    ]);
  });

  it('filters by provider id before probing so custom local detection stays cheap', async () => {
    const projectPath = path.join(tempDir, 'filtered-project');
    await writeOpenCodeConfig(projectPath, {
      provider: {
        'local-lab': {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'http://127.0.0.1:18080/v1' },
          models: { 'team-model': {} },
        },
        ollama: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'http://127.0.0.1:11434/v1' },
          models: { 'qwen3:8b': {} },
        },
      },
    });
    const requestedUrls: string[] = [];
    const connector = new OpenCodeLocalProviderConnector({
      fetchImpl: (async (input: string | URL | Request) => {
        requestedUrls.push(String(input));
        return new Response(JSON.stringify({ data: [{ id: 'team-model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });

    const response = await connector.listLocalProviders({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath,
      providerId: 'local-lab',
    });

    expect(response.providers).toEqual([
      expect.objectContaining({
        providerId: 'local-lab',
        state: 'available',
      }),
    ]);
    expect(requestedUrls).toEqual(['http://127.0.0.1:18080/v1/models']);
  });

  it('does not probe private-network config URLs without app-owned approval', async () => {
    const projectPath = path.join(tempDir, 'cloned-project');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(
      path.join(projectPath, 'opencode.json'),
      JSON.stringify({
        provider: {
          'home-server': {
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL: 'http://192.168.1.20:8080/v1' },
            models: { 'team-model': {} },
          },
        },
      }),
      'utf8'
    );
    const requestedUrls: string[] = [];
    const connector = new OpenCodeLocalProviderConnector({
      fetchImpl: (async (input: string | URL | Request) => {
        requestedUrls.push(String(input));
        return new Response(JSON.stringify({ data: [{ id: 'team-model' }] }));
      }) as typeof fetch,
      privateNetworkApprovalStore: {
        isApproved: async () => false,
        approve: async () => {},
      },
    });

    const response = await connector.listLocalProviders({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath,
    });

    expect(response.providers).toEqual([
      expect.objectContaining({
        providerId: 'home-server',
        privateNetworkApproved: false,
        state: 'unavailable',
        message: expect.stringContaining('has not been approved'),
      }),
    ]);
    expect(requestedUrls).toEqual([]);
  });

  it('lists providers from the global config without requiring a project', async () => {
    const globalConfigDirectory = path.join(tempDir, '.config', 'opencode');
    await writeOpenCodeConfig(globalConfigDirectory, {
      model: 'lmstudio/global-model',
      provider: {
        lmstudio: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'http://127.0.0.1:1234/v1' },
          models: { 'global-model': {} },
        },
      },
    });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'global-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const connector = new OpenCodeLocalProviderConnector({ fetchImpl, homePath: tempDir });

    const response = await connector.listLocalProviders({
      runtimeId: 'opencode',
      scope: 'global',
    });

    expect(response.error).toBeUndefined();
    expect(response.scope).toBe('global');
    expect(response.projectPath).toBeUndefined();
    expect(response.providers).toEqual([
      expect.objectContaining({
        providerId: 'lmstudio',
        defaultModelId: 'global-model',
        isDefault: true,
        state: 'available',
      }),
    ]);
  });
});

/* eslint-enable sonarjs/no-clear-text-protocols -- re-enable after the local connector fixtures */
