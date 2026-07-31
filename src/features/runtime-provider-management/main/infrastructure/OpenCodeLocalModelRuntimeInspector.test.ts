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

  it('uses the active Ollama allocation instead of rejecting a smaller Modelfile num_ctx', async () => {
    const inventory = createInventory([ollamaProvider()]);
    const probeCoordination = vi.fn(coordinationPassed);
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return url.endsWith('/api/show')
        ? jsonResponse({
            capabilities: ['completion', 'tools'],
            parameters: 'num_ctx 4096',
            model_info: {
              'general.parameter_count': 7_615_616_000,
              'qwen2.context_length': 131_072,
            },
          })
        : jsonResponse({
            models: [{ model: 'qwen2.5:0.5b', context_length: 65_536 }],
          });
    });

    const result = await inspectOpenCodeLocalModelRuntimeReadiness(
      {
        projectPath: TEST_PROJECT_PATH,
        modelRoute: 'ollama/qwen2.5:0.5b',
      },
      { inventory, fetchImpl, probeCoordination }
    );

    expect(result).toMatchObject({
      severity: 'ready',
      code: 'local_coordination_verified',
      configuredContextTokens: 4_096,
      effectiveContextTokens: 65_536,
      coordinationProbeStatus: 'passed',
    });
    expect(probeCoordination).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('warns instead of false-blocking when low Modelfile num_ctx cannot be compared with runtime allocation', async () => {
    const inventory = createInventory([ollamaProvider()]);
    const probeCoordination = vi.fn(coordinationPassed);
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return url.endsWith('/api/show')
        ? jsonResponse({
            capabilities: ['completion', 'tools'],
            parameters: 'num_ctx 4096',
            model_info: {
              'general.parameter_count': 7_615_616_000,
              'qwen2.context_length': 131_072,
            },
          })
        : jsonResponse({ error: 'runtime inventory unavailable' }, 503);
    });

    const result = await inspectOpenCodeLocalModelRuntimeReadiness(
      {
        projectPath: TEST_PROJECT_PATH,
        modelRoute: 'ollama/qwen2.5:0.5b',
      },
      { inventory, fetchImpl, probeCoordination }
    );

    expect(result).toMatchObject({
      severity: 'warning',
      code: 'local_runtime_unverified',
      configuredContextTokens: 4_096,
      effectiveContextTokens: null,
      coordinationProbeStatus: 'passed',
      message: expect.stringContaining('verify the active allocation with ollama ps'),
    });
    expect(probeCoordination).toHaveBeenCalledTimes(1);
  });

  it('treats sub-3B size as advisory after empirical coordination succeeds', async () => {
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
      severity: 'warning',
      code: 'local_model_too_small',
      parameterCount: 2_031_739_904,
      toolCapable: true,
      effectiveContextTokens: 32_768,
      coordinationProbeStatus: 'passed',
    });
    expect(result?.message).toContain('below the 3B reliability guideline');
    expect(probeCoordination).toHaveBeenCalledTimes(1);
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
      experimentalOverrideAvailable: true,
      message: expect.stringContaining('plain text'),
    });
    expect(result?.message).toContain('experimental local-model override');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never lets the coordination override bypass a proven 4K Ollama allocation', async () => {
    const inventory = createInventory([ollamaProvider()]);
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return url.endsWith('/api/show')
        ? jsonResponse({
            capabilities: ['completion', 'tools'],
            model_info: {
              'general.parameter_count': 7_615_616_000,
              'qwen3.context_length': 32_768,
            },
          })
        : jsonResponse({
            models: [{ model: 'qwen3:8b', context_length: 4_096 }],
          });
    });

    const result = await inspectOpenCodeLocalModelRuntimeReadiness(
      {
        projectPath: TEST_PROJECT_PATH,
        modelRoute: 'ollama/qwen3:8b',
        allowExperimentalLocalModels: true,
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
      code: 'local_context_too_small',
      effectiveContextTokens: 4_096,
      coordinationProbeStatus: 'failed',
    });
    expect(result?.experimentalOverrideAvailable).toBeUndefined();
    expect(result?.message).toContain(
      'Agent Teams coordination also failed: The model wrote plain text instead of message_send.'
    );
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:11434/api/show',
      'http://127.0.0.1:11434/api/ps',
    ]);
  });

  it('allows an explicit experimental override to defer a failed direct probe to OpenCode', async () => {
    const inventory = createInventory([ollamaProvider()]);
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith('/api/show')
        ? jsonResponse({
            capabilities: ['completion', 'tools'],
            model_info: {
              'general.parameter_count': 7_615_616_000,
              'qwen2.context_length': 32_768,
            },
          })
        : jsonResponse({
            models: [{ model: 'qwen3:8b', context_length: 32_768 }],
          })
    );

    const result = await inspectOpenCodeLocalModelRuntimeReadiness(
      {
        projectPath: TEST_PROJECT_PATH,
        modelRoute: 'ollama/qwen3:8b',
        allowExperimentalLocalModels: true,
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
      severity: 'warning',
      code: 'local_coordination_probe_failed',
      coordinationProbeStatus: 'failed',
      experimentalOverrideAvailable: true,
      message: expect.stringContaining('override is enabled'),
    });
    expect(result?.effectiveContextTokens).toBe(32_768);
  });

  it('retries a temporarily unavailable coordination probe before deciding', async () => {
    const inventory = createInventory([customProvider()]);
    const probeCoordination = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'unavailable' as const,
        message: 'The local server is loading.',
      })
      .mockResolvedValueOnce({
        status: 'passed' as const,
        message: 'Coordination check passed after loading.',
      });
    const sleep = vi.fn(async () => undefined);

    const result = await inspectOpenCodeLocalModelRuntimeReadiness(
      {
        projectPath: TEST_PROJECT_PATH,
        modelRoute: 'local-lab/team-model',
      },
      { inventory, probeCoordination, sleep }
    );

    expect(result).toMatchObject({
      severity: 'warning',
      code: 'local_runtime_unverified',
      coordinationProbeStatus: 'passed',
    });
    expect(probeCoordination).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
    expect(probeCoordination.mock.calls[0]?.[0].signal).toBe(
      probeCoordination.mock.calls[1]?.[0].signal
    );
  });

  it('delegates authenticated remote endpoint verification to OpenCode', async () => {
    const inventory = createInventory([
      {
        ...customProvider(),
        baseUrl: 'https://models.example.com/v1',
      },
    ]);
    const probeCoordination = vi.fn(coordinationPassed);

    const result = await inspectOpenCodeLocalModelRuntimeReadiness(
      {
        projectPath: TEST_PROJECT_PATH,
        modelRoute: 'local-lab/team-model',
      },
      { inventory, probeCoordination }
    );

    expect(result).toMatchObject({
      severity: 'warning',
      code: 'local_runtime_unverified',
      coordinationProbeStatus: null,
      message: expect.stringContaining('OpenCode execution probe is authoritative'),
    });
    expect(probeCoordination).not.toHaveBeenCalled();
  });

  it('uses one timeout budget across coordination probe attempts', async () => {
    const inventory = createInventory([customProvider()]);
    const probeCoordination = vi.fn(
      async (probeInput: { readonly signal?: AbortSignal }) =>
        new Promise<{ status: 'unavailable'; message: string }>((resolve) => {
          const finish = () =>
            resolve({
              status: 'unavailable',
              message: 'The local server did not finish the probe.',
            });
          if (probeInput.signal?.aborted) {
            finish();
            return;
          }
          probeInput.signal?.addEventListener('abort', finish, { once: true });
        })
    );

    const result = await inspectOpenCodeLocalModelRuntimeReadiness(
      {
        projectPath: TEST_PROJECT_PATH,
        modelRoute: 'local-lab/team-model',
      },
      {
        inventory,
        probeCoordination,
        coordinationProbeTimeoutMs: 5,
        sleep: vi.fn(async () => undefined),
      }
    );

    expect(result).toMatchObject({
      severity: 'warning',
      code: 'local_coordination_probe_unavailable',
      coordinationProbeStatus: 'unavailable',
      message: expect.stringContaining('timed out'),
    });
    expect(probeCoordination).toHaveBeenCalledTimes(1);
  });

  it('reports exhausted transient verification as a warning, not unsupported', async () => {
    const inventory = createInventory([customProvider()]);
    const probeCoordination = vi.fn().mockResolvedValue({
      status: 'unavailable' as const,
      message: 'The local server is still loading.',
    });

    const result = await inspectOpenCodeLocalModelRuntimeReadiness(
      {
        projectPath: TEST_PROJECT_PATH,
        modelRoute: 'local-lab/team-model',
      },
      { inventory, probeCoordination, sleep: vi.fn(async () => undefined) }
    );

    expect(result).toMatchObject({
      severity: 'warning',
      code: 'local_coordination_probe_unavailable',
      coordinationProbeStatus: 'unavailable',
      experimentalOverrideAvailable: false,
      message: expect.stringContaining('not proof that the model is unsupported'),
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

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
