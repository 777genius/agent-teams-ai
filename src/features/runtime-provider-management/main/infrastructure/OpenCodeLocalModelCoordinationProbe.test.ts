import { describe, expect, it, vi } from 'vitest';

import { probeOpenCodeLocalModelCoordination } from './OpenCodeLocalModelCoordinationProbe';

import type { RuntimeLocalProviderListEntryDto } from '../../contracts';

describe('probeOpenCodeLocalModelCoordination', () => {
  it('proves the streaming Ollama tool loop without indexes despite a malformed tail', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<Record<string, unknown>>;
      };
      if (body.messages.length === 2) {
        return sseResponse(
          [
            {
              choices: [{ delta: { role: 'assistant', reasoning_content: 'Need the queue.' } }],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        id: 'call-1',
                        type: 'function',
                        function: {
                          name: 'agent-teams_task_briefing',
                          arguments: '{"teamName":"agent-teams-local-probe",',
                        },
                      },
                    ],
                  },
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        id: 'call-1',
                        function: {
                          arguments: '"memberName":"probe-member"}',
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
          true
        );
      }
      expect(body.messages[2]).toMatchObject({
        role: 'assistant',
        reasoning_content: 'Need the queue.',
        tool_calls: [
          {
            id: 'call-1',
            function: {
              name: 'agent-teams_task_briefing',
            },
          },
        ],
      });
      return sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-2',
                    type: 'function',
                    function: {
                      name: 'agent-teams_message_send',
                      arguments: JSON.stringify({
                        teamName: 'agent-teams-local-probe',
                        to: 'probe-lead',
                        from: 'probe-member',
                        text: 'fixed-nonce',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        },
      ]);
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
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(fetchImpl.mock.calls[1]?.[1]?.signal);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'qwen3:8b',
      stream: true,
      temperature: 0,
      max_tokens: 1_024,
      reasoning_effort: 'none',
      tools: [
        {
          function: {
            name: 'agent-teams_task_briefing',
          },
        },
        {
          function: {
            name: 'agent-teams_message_send',
            parameters: {
              required: ['teamName', 'to', 'from', 'text'],
              properties: {
                claudeDir: { type: 'string' },
                summary: { type: 'string' },
                source: { type: 'string' },
                relayOfMessageId: { type: 'string' },
                leadSessionId: { type: 'string' },
                attachments: {
                  type: 'array',
                  items: {
                    required: ['id', 'filename', 'mimeType', 'size'],
                  },
                },
                taskRefs: {
                  type: 'array',
                  items: {
                    required: ['taskId', 'displayId', 'teamName'],
                  },
                },
              },
            },
          },
        },
      ],
    });
  });

  it('keeps Ollama tool calls separate when distinct ids repeat an index', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Record<string, unknown>[] };
      if (body.messages.length === 2) {
        return sseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-noise',
                      function: { name: 'unrelated_tool', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-briefing',
                      function: {
                        name: 'agent-teams_task_briefing',
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
          },
        ]);
      }
      return sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-message',
                    function: {
                      name: 'agent-teams_message_send',
                      arguments: JSON.stringify({
                        teamName: 'agent-teams-local-probe',
                        to: 'probe-lead',
                        from: 'probe-member',
                        text: 'fixed-nonce',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        },
      ]);
    });

    const result = await probeOpenCodeLocalModelCoordination(
      {
        provider: localProvider('ollama', 'http://127.0.0.1:11434/v1'),
        modelId: 'qwen3:8b',
      },
      { fetchImpl, createNonce: () => 'fixed-nonce' }
    );

    expect(result.status).toBe('passed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps non-Ollama OpenAI-compatible probes on the portable non-streaming contract', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<Record<string, unknown>>;
      };
      const toolName =
        body.messages.length === 2 ? 'agent-teams_task_briefing' : 'agent-teams_message_send';
      const toolArguments =
        body.messages.length === 2
          ? {
              teamName: 'agent-teams-local-probe',
              memberName: 'probe-member',
            }
          : {
              teamName: 'agent-teams-local-probe',
              to: 'probe-lead',
              from: 'probe-member',
              text: 'fixed-nonce',
            };
      return jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call-${body.messages.length}`,
                  type: 'function',
                  function: {
                    name: toolName,
                    arguments: JSON.stringify(toolArguments),
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
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of fetchImpl.mock.calls) {
      const request = call[1];
      const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
      expect(body.stream).toBe(false);
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(new Headers(request?.headers).get('accept')).toBe('application/json');
    }
  });

  it('normalizes object tool arguments before replaying them to a strict compatible server', async () => {
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
                    id: 'call-object-args',
                    function: {
                      name: 'agent-teams_task_briefing',
                      arguments: {
                        teamName: 'agent-teams-local-probe',
                        memberName: 'probe-member',
                      },
                    },
                  },
                ],
              },
            },
          ],
        });
      }

      const replayedToolCall = (
        body.messages[2] as {
          tool_calls: Array<{ type: string; function: { arguments: unknown } }>;
        }
      ).tool_calls[0];
      expect(replayedToolCall.type).toBe('function');
      expect(typeof replayedToolCall.function.arguments).toBe('string');
      expect(JSON.parse(String(replayedToolCall.function.arguments))).toEqual({
        teamName: 'agent-teams-local-probe',
        memberName: 'probe-member',
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
                    name: 'agent-teams_message_send',
                    arguments: {
                      teamName: 'agent-teams-local-probe',
                      to: 'probe-lead',
                      from: 'probe-member',
                      text: 'fixed-nonce',
                    },
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
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('accepts summary when a model includes the optional production field', async () => {
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

  it('keeps an explicit client rejection of the tool request blocking', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: 'tools are not supported by this model' }, 400)
    );

    const result = await probeOpenCodeLocalModelCoordination(
      {
        provider: localProvider('llama.cpp', 'http://127.0.0.1:8080/v1'),
        modelId: 'no-tools-model',
      },
      { fetchImpl }
    );

    expect(result).toMatchObject({
      status: 'failed',
      failureKind: 'request_rejected',
      message: expect.stringContaining('HTTP 400: tools are not supported by this model'),
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

function sseResponse(chunks: unknown[], malformedTail = false): Response {
  return new Response(
    [
      ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
      ...(malformedTail ? ['data: {"truncated":\n\n'] : []),
      'data: [DONE]\n\n',
    ].join(''),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }
  );
}
