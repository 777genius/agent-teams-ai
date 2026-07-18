import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OpenCodeLocalProviderConnector } from './OpenCodeLocalProviderConnector';

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
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(
      path.join(projectPath, 'opencode.jsonc'),
      [
        '{',
        '  // project-owned comment',
        '  "model": "ollama/qwen3:8b",',
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
      'utf8'
    );
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
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
    expect(response.providers).toHaveLength(2);
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
      preset: { id: 'custom', displayName: 'Custom local server' },
      providerId: 'local-lab',
      isDefault: false,
      state: 'unavailable',
      liveModels: [],
    });
    expect(response.providers?.some((entry) => entry.providerId === 'remote-compatible')).toBe(
      false
    );
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

  it('lists providers from the global config without requiring a project', async () => {
    const globalConfigDirectory = path.join(tempDir, '.config', 'opencode');
    await fs.mkdir(globalConfigDirectory, { recursive: true });
    await fs.writeFile(
      path.join(globalConfigDirectory, 'opencode.json'),
      JSON.stringify({
        model: 'lmstudio/global-model',
        provider: {
          lmstudio: {
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL: 'http://127.0.0.1:1234/v1' },
            models: { 'global-model': {} },
          },
        },
      }),
      'utf8'
    );
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
