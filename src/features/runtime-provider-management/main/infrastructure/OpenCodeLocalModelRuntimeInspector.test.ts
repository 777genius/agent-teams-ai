import { describe, expect, it, vi } from 'vitest';

import { inspectOpenCodeLocalModelRuntimeReadiness } from './OpenCodeLocalModelRuntimeInspector';

import type {
  RuntimeLocalProviderListEntryDto,
  RuntimeLocalProviderListResponse,
} from '../../contracts';

const TEST_PROJECT_PATH = process.cwd();

describe('inspectOpenCodeLocalModelRuntimeReadiness', () => {
  it('blocks an Ollama model that the execution runtime loaded with only 4K context', async () => {
    const inventory = createInventory([ollamaProvider()]);
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/show')) {
        return jsonResponse({
          capabilities: ['completion', 'tools'],
          model_info: {
            'general.parameter_count': 7_615_616_000,
            'qwen2.context_length': 32_768,
          },
        });
      }
      if (url.endsWith('/api/ps')) {
        return jsonResponse({
          models: [{ name: 'qwen2.5:0.5b', context_length: 4_096 }],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await inspectOpenCodeLocalModelRuntimeReadiness(
      {
        projectPath: TEST_PROJECT_PATH,
        modelRoute: 'ollama/qwen2.5:0.5b',
      },
      { inventory, fetchImpl, probeCoordination: coordinationPassed }
    );

    expect(result).toMatchObject({
      severity: 'blocking',
      code: 'local_context_too_small',
      toolCapable: true,
      trainedContextTokens: 32_768,
      effectiveContextTokens: 4_096,
    });
    expect(result?.message).toContain('at least 16K');
  });

  it('marks a tool-capable Ollama model with 32K context and coordination proof ready', async () => {
    const inventory = createInventory([ollamaProvider()]);
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return url.endsWith('/api/show')
        ? jsonResponse({
            capabilities: ['completion', 'tools'],
            parameters: 'temperature 0.2\nnum_ctx 32768',
            model_info: {
              'general.parameter_count': 7_615_616_000,
              'qwen2.context_length': 32_768,
            },
          })
        : jsonResponse({
            models: [{ model: 'qwen2.5:0.5b', context_length: 32_768 }],
          });
    });

    const result = await inspectOpenCodeLocalModelRuntimeReadiness(
      {
        projectPath: TEST_PROJECT_PATH,
        modelRoute: 'ollama/qwen2.5:0.5b',
      },
      { inventory, fetchImpl, probeCoordination: coordinationPassed }
    );

    expect(result).toMatchObject({
      severity: 'ready',
      code: 'local_coordination_verified',
      coordinationProbeStatus: 'passed',
      configuredContextTokens: 32_768,
      effectiveContextTokens: 32_768,
      parameterCount: 7_615_616_000,
    });
    expect(result?.message).toContain('task_briefing -> message_send');
  });

  it('blocks a sub-3B Ollama model even when it advertises tools and 32K context', async () => {
    const inventory = createInventory([ollamaProvider()]);
    const probeCoordination = vi.fn(coordinationPassed);
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return url.endsWith('/api/show')
        ? jsonResponse({
            capabilities: ['completion', 'tools'],
            parameters: 'num_ctx 32768',
            model_info: {
              'general.parameter_count': 2_031_739_904,
              'qwen3.context_length': 40_960,
            },
          })
        : jsonResponse({
            models: [{ model: 'qwen3:1.7b', context_length: 32_768 }],
          });
    });

    const result = await inspectOpenCodeLocalModelRuntimeReadiness(
      {
        projectPath: TEST_PROJECT_PATH,
        modelRoute: 'ollama/qwen3:1.7b',
      },
      { inventory, fetchImpl, probeCoordination }
    );

    expect(result).toMatchObject({
      severity: 'blocking',
      code: 'local_model_too_small',
      parameterCount: 2_031_739_904,
      toolCapable: true,
      effectiveContextTokens: null,
    });
    expect(result?.message).toContain('below 3B');
    expect(probeCoordination).not.toHaveBeenCalled();
  });

  it('blocks an Ollama model that does not advertise tool support', async () => {
    const inventory = createInventory([ollamaProvider()]);
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return url.endsWith('/api/show')
        ? jsonResponse({
            capabilities: ['completion'],
            model_info: { 'llama.context_length': 32_768 },
          })
        : jsonResponse({
            models: [{ name: 'legacy:latest', context_length: 32_768 }],
          });
    });

    const result = await inspectOpenCodeLocalModelRuntimeReadiness(
      {
        projectPath: TEST_PROJECT_PATH,
        modelRoute: 'ollama/legacy',
      },
      { inventory, fetchImpl, probeCoordination: coordinationPassed }
    );

    expect(result).toMatchObject({
      severity: 'blocking',
      code: 'local_tools_unsupported',
      toolCapable: false,
    });
  });

  it('uses project provider configuration before a global provider with the same id', async () => {
    const projectProvider = ollamaProvider('http://127.0.0.1:22434/v1');
    const globalProvider = ollamaProvider('http://127.0.0.1:11434/v1');
    const inventory = {
      listLocalProviders: vi.fn(async ({ scope }) =>
        listResponse(scope === 'project' ? [projectProvider] : [globalProvider])
      ),
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      expect(url).toContain('127.0.0.1:22434');
      return url.endsWith('/api/show')
        ? jsonResponse({
            capabilities: ['completion', 'tools'],
            model_info: {
              'general.parameter_count': 7_615_616_000,
              'qwen2.context_length': 32_768,
            },
          })
        : jsonResponse({
            models: [{ name: 'qwen2.5:0.5b', context_length: 32_768 }],
          });
    });

    await inspectOpenCodeLocalModelRuntimeReadiness(
      {
        projectPath: TEST_PROJECT_PATH,
        modelRoute: 'ollama/qwen2.5:0.5b',
      },
      { inventory, fetchImpl, probeCoordination: coordinationPassed }
    );

    expect(inventory.listLocalProviders).toHaveBeenCalledTimes(1);
  });

  it('blocks a model that cannot complete the Agent Teams coordination probe', async () => {
    const inventory = createInventory([ollamaProvider()]);
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return url.endsWith('/api/show')
        ? jsonResponse({
            capabilities: ['completion', 'tools'],
            model_info: {
              'general.parameter_count': 7_615_616_000,
              'qwen2.context_length': 32_768,
            },
          })
        : jsonResponse({
            models: [{ model: 'qwen3:8b', context_length: 32_768 }],
          });
    });

    const result = await inspectOpenCodeLocalModelRuntimeReadiness(
      {
        projectPath: TEST_PROJECT_PATH,
        modelRoute: 'ollama/qwen3:8b',
      },
      {
        inventory,
        fetchImpl,
        probeCoordination: vi.fn().mockResolvedValue({
          status: 'failed',
          message: 'The model wrote plain text instead of message_send.',
        }),
      }
    );

    expect(result).toMatchObject({
      severity: 'blocking',
      code: 'local_coordination_probe_failed',
      coordinationProbeStatus: 'failed',
      message: expect.stringContaining('plain text'),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('blocks a local model that passes once but fails the repeated reliability check', async () => {
    const inventory = createInventory([customProvider()]);
    const probeCoordination = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'passed' as const,
        message: 'Initial coordination check passed.',
      })
      .mockResolvedValueOnce({
        status: 'failed' as const,
        message: 'The repeated check returned plain text.',
      });

    const result = await inspectOpenCodeLocalModelRuntimeReadiness(
      {
        projectPath: TEST_PROJECT_PATH,
        modelRoute: 'local-lab/team-model',
      },
      { inventory, probeCoordination }
    );

    expect(result).toMatchObject({
      severity: 'blocking',
      code: 'local_coordination_probe_failed',
      message: expect.stringContaining('Repeated coordination check 2/2 failed'),
    });
    expect(probeCoordination).toHaveBeenCalledTimes(2);
  });

  it('blocks a known local route when its provider configuration is unavailable', async () => {
    const inventory = createInventory([]);

    const result = await inspectOpenCodeLocalModelRuntimeReadiness(
      {
        projectPath: TEST_PROJECT_PATH,
        modelRoute: 'ollama/qwen3:8b',
      },
      { inventory }
    );

    expect(result).toMatchObject({
      providerId: 'ollama',
      modelId: 'qwen3:8b',
      severity: 'blocking',
      code: 'local_provider_unavailable',
      message: expect.stringContaining('Reconnect the local provider'),
    });
    expect(inventory.listLocalProviders).toHaveBeenCalledTimes(2);
  });

  it('ignores an unconfigured cloud provider route', async () => {
    const inventory = createInventory([]);

    const result = await inspectOpenCodeLocalModelRuntimeReadiness(
      {
        projectPath: TEST_PROJECT_PATH,
        modelRoute: 'openrouter/qwen/qwen3-8b',
      },
      { inventory }
    );

    expect(result).toBeNull();
  });

  it('fails fast for a configured provider that is already known to be unavailable', async () => {
    const unavailableProvider: RuntimeLocalProviderListEntryDto = {
      ...customProvider(),
      state: 'unavailable',
      liveModels: [],
      latencyMs: null,
      message: 'Could not reach the local server.',
    };
    const inventory = createInventory([unavailableProvider]);
    const probeCoordination = vi.fn(coordinationPassed);

    const result = await inspectOpenCodeLocalModelRuntimeReadiness(
      {
        projectPath: TEST_PROJECT_PATH,
        modelRoute: 'local-lab/team-model',
      },
      { inventory, probeCoordination }
    );

    expect(result).toMatchObject({
      providerId: 'local-lab',
      modelId: 'team-model',
      severity: 'blocking',
      code: 'local_provider_unavailable',
      message: expect.stringContaining('Start the local server'),
    });
    expect(probeCoordination).not.toHaveBeenCalled();
  });

  it('fails fast when a configured custom model is not in the live server catalog', async () => {
    const inventory = createInventory([customProvider()]);
    const probeCoordination = vi.fn(coordinationPassed);

    const result = await inspectOpenCodeLocalModelRuntimeReadiness(
      {
        projectPath: TEST_PROJECT_PATH,
        modelRoute: 'local-lab/missing-model',
      },
      { inventory, probeCoordination }
    );

    expect(result).toMatchObject({
      providerId: 'local-lab',
      modelId: 'missing-model',
      severity: 'blocking',
      code: 'local_model_not_loaded',
      message: expect.stringContaining('does not currently serve it'),
    });
    expect(probeCoordination).not.toHaveBeenCalled();
  });

  it('recognizes a configured custom local provider with an arbitrary source id', async () => {
    const inventory = createInventory([customProvider()]);

    const result = await inspectOpenCodeLocalModelRuntimeReadiness(
      {
        projectPath: TEST_PROJECT_PATH,
        modelRoute: 'local-lab/team-model',
      },
      { inventory, probeCoordination: coordinationPassed }
    );

    expect(result).toMatchObject({
      providerId: 'local-lab',
      modelId: 'team-model',
      presetId: 'custom',
      severity: 'warning',
      code: 'local_runtime_unverified',
      coordinationProbeStatus: 'passed',
    });
    expect(inventory.listLocalProviders).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath: TEST_PROJECT_PATH,
      providerId: 'local-lab',
    });
  });
});

async function coordinationPassed() {
  return {
    status: 'passed',
    message:
      'The model completed the Agent Teams task_briefing -> message_send coordination probe.',
  } as const;
}

function createInventory(projectProviders: RuntimeLocalProviderListEntryDto[]) {
  return {
    listLocalProviders: vi.fn(async ({ scope }) =>
      listResponse(scope === 'project' ? projectProviders : [])
    ),
  };
}

function listResponse(
  providers: RuntimeLocalProviderListEntryDto[]
): RuntimeLocalProviderListResponse {
  return {
    schemaVersion: 1,
    runtimeId: 'opencode',
    providers,
  };
}

function ollamaProvider(baseUrl = 'http://127.0.0.1:11434/v1'): RuntimeLocalProviderListEntryDto {
  return {
    preset: {
      id: 'ollama',
      providerId: 'ollama',
      displayName: 'Ollama',
      defaultBaseUrl: 'http://127.0.0.1:11434/v1',
      description: 'Local Ollama',
      scannable: true,
    },
    providerId: 'ollama',
    baseUrl,
    configuredModelIds: ['qwen2.5:0.5b'],
    defaultModelId: 'qwen2.5:0.5b',
    isDefault: true,
    state: 'available',
    liveModels: [{ id: 'qwen2.5:0.5b', displayName: 'qwen2.5:0.5b' }],
    latencyMs: 1,
    message: 'Connected',
  };
}

function customProvider(): RuntimeLocalProviderListEntryDto {
  return {
    preset: {
      id: 'custom',
      providerId: 'local',
      displayName: 'Custom local server',
      defaultBaseUrl: 'http://127.0.0.1:18080/v1',
      description: 'Custom local server',
      scannable: false,
    },
    providerId: 'local-lab',
    baseUrl: 'http://127.0.0.1:18080/v1',
    configuredModelIds: ['team-model'],
    defaultModelId: 'team-model',
    isDefault: false,
    state: 'available',
    liveModels: [{ id: 'team-model', displayName: 'team-model' }],
    latencyMs: 1,
    message: 'Connected',
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
