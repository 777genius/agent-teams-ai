import { describe, expect, it, vi } from 'vitest';

import { probeOpenCodeLocalModelCoordination } from './OpenCodeLocalModelCoordinationProbe';

import type { RuntimeLocalProviderListEntryDto } from '../../contracts';

describe('probeOpenCodeLocalModelCoordination', () => {
  it('proves Ollama task briefing followed by a valid message_send call', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<Record<string, unknown>>;
      };
      if (body.messages.length === 2) {
        return jsonResponse({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: {
                      name: 'agent_teams_task_briefing',
                      arguments: JSON.stringify({
                        teamName: 'agent-teams-local-probe',
                        memberName: 'probe-member',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-2',
                  type: 'function',
                  function: {
                    name: 'agent_teams_message_send',
                    arguments: JSON.stringify({
                      teamName: 'agent-teams-local-probe',
                      to: 'probe-lead',
                      from: 'probe-member',
                      text: 'fixed-nonce',
                      summary: 'Compatibility probe',
                    }),
                  },
                },
              ],
            },
          },
        ],
      });
    });

    const result = await probeOpenCodeLocalModelCoordination(
      {
        provider: localProvider('ollama', 'http://127.0.0.1:11434/v1'),
        modelId: 'qwen3:8b',
      },
      { fetchImpl, createNonce: () => 'fixed-nonce' }
    );

    expect(result).toMatchObject({
      status: 'passed',
      message: expect.stringContaining('task_briefing -> message_send'),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'qwen3:8b',
      stream: false,
      temperature: 0,
      max_tokens: 1_024,
    });
  });

  it('blocks a model that writes the requested message as plain text', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<Record<string, unknown>>;
      };
      return body.messages.length === 2
        ? jsonResponse({
            choices: [
              {
                message: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: {
                        name: 'agent_teams_task_briefing',
                        arguments: JSON.stringify({
                          teamName: 'agent-teams-local-probe',
                          memberName: 'probe-member',
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          })
        : jsonResponse({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Use agent_teams_message_send with the requested text.',
                },
              },
            ],
          });
    });

    const result = await probeOpenCodeLocalModelCoordination(
      {
        provider: localProvider('ollama', 'http://127.0.0.1:11434/v1'),
        modelId: 'weak-model',
      },
      { fetchImpl, createNonce: () => 'fixed-nonce' }
    );

    expect(result).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('plain text'),
    });
  });

  it('supports OpenAI-compatible local servers and string tool arguments', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<Record<string, unknown>>;
      };
      if (body.messages.length === 2) {
        return jsonResponse({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: {
                      name: 'agent_teams_task_briefing',
                      arguments: JSON.stringify({
                        teamName: 'agent-teams-local-probe',
                        memberName: 'probe-member',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      expect(body.messages.at(-1)).toMatchObject({
        role: 'tool',
        tool_call_id: 'call-1',
      });
      return jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-2',
                  type: 'function',
                  function: {
                    name: 'agent_teams_message_send',
                    arguments: JSON.stringify({
                      teamName: 'agent-teams-local-probe',
                      to: 'probe-lead',
                      from: 'probe-member',
                      text: 'fixed-nonce',
                      summary: 'Compatibility probe',
                    }),
                  },
                },
              ],
            },
          },
        ],
      });
    });

    const result = await probeOpenCodeLocalModelCoordination(
      {
        provider: localProvider('lm-studio', 'http://127.0.0.1:1234/v1'),
        modelId: 'qwen3-8b',
      },
      { fetchImpl, createNonce: () => 'fixed-nonce' }
    );

    expect(result.status).toBe('passed');
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('http://127.0.0.1:1234/v1/chat/completions');
  });

  it('reports a bounded local server error as unavailable', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: 'model is not loaded' }, 503)
    );

    const result = await probeOpenCodeLocalModelCoordination(
      {
        provider: localProvider('lm-studio', 'http://127.0.0.1:1234/v1'),
        modelId: 'missing-model',
      },
      { fetchImpl }
    );

    expect(result).toMatchObject({
      status: 'unavailable',
      message: expect.stringContaining('HTTP 503: model is not loaded'),
    });
  });
});

function localProvider(
  presetId: RuntimeLocalProviderListEntryDto['preset']['id'],
  baseUrl: string
): RuntimeLocalProviderListEntryDto {
  const providerId = presetId === 'lm-studio' ? 'lmstudio' : presetId;
  return {
    preset: {
      id: presetId,
      providerId,
      displayName: presetId === 'lm-studio' ? 'LM Studio' : 'Ollama',
      defaultBaseUrl: baseUrl,
      description: 'Local provider',
      scannable: true,
    },
    providerId,
    baseUrl,
    configuredModelIds: ['model'],
    defaultModelId: 'model',
    isDefault: true,
    state: 'available',
    liveModels: [{ id: 'model', displayName: 'model' }],
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
