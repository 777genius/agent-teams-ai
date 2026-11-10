import { describe, expect, it, vi } from 'vitest';

import {
  APP_MCP_RUNTIME_TOOL_CONTRACTS,
  assertRuntimeDeliverMessageSchema,
  buildOpenCodeCanonicalMcpToolId,
  matchRequiredOpenCodeTools,
  OpenCodeMcpToolAvailabilityProbe,
  REQUIRED_AGENT_TEAMS_APP_TOOL_IDS,
  REQUIRED_AGENT_TEAMS_APP_TOOLS,
  REQUIRED_AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOLS,
  REQUIRED_AGENT_TEAMS_RUNTIME_PROOF_TOOLS,
  REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS,
  sanitizeOpenCodeMcpToolPart,
  verifyAppMcpRuntimeToolContracts,
  type OpenCodeInfrastructureToolClient,
  type OpenCodeToolListItem,
} from '../../../../src/main/services/team/opencode/mcp/OpenCodeMcpToolAvailability';

describe('OpenCode MCP tool availability', () => {
  it('builds source-verified canonical MCP tool ids', () => {
    expect(sanitizeOpenCodeMcpToolPart('agent-teams')).toBe('agent-teams');
    expect(buildOpenCodeCanonicalMcpToolId('agent-teams', 'runtime_deliver_message')).toBe(
      'agent-teams_runtime_deliver_message'
    );
  });

  it('loads launch-visible teammate-operational tools from the controller catalog', () => {
    expect(REQUIRED_AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOLS).toContain('message_send');
    expect(REQUIRED_AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOLS).toContain('cross_team_send');
    expect(REQUIRED_AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOLS).toContain('task_start');
    expect(REQUIRED_AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOLS).not.toContain('lead_briefing');
    expect(REQUIRED_AGENT_TEAMS_APP_TOOLS).toEqual([
      ...REQUIRED_AGENT_TEAMS_RUNTIME_PROOF_TOOLS,
      ...REQUIRED_AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOLS,
    ]);
    expect(REQUIRED_AGENT_TEAMS_APP_TOOL_IDS).toContain('agent-teams_message_send');
    expect(REQUIRED_AGENT_TEAMS_APP_TOOL_IDS).toContain('agent-teams_member_briefing');
    expect(REQUIRED_AGENT_TEAMS_APP_TOOL_IDS).toContain('agent-teams_cross_team_send');
  });

  it('fails production proof when only alias ids are observed', () => {
    const proof = matchRequiredOpenCodeTools({
      route: '/experimental/tool/ids',
      serverName: 'agent-teams',
      requiredTools: ['runtime_deliver_message'],
      observedTools: ['mcp__agent-teams__runtime_deliver_message'],
    });

    expect(proof).toMatchObject({
      ok: false,
      missingTools: ['runtime_deliver_message'],
      matchedByRequiredTool: {
        runtime_deliver_message: null,
      },
      aliasMatchedByRequiredTool: {
        runtime_deliver_message: 'mcp__agent-teams__runtime_deliver_message',
      },
    });
    expect(proof.diagnostics).toContain(
      'OpenCode observed alias mcp__agent-teams__runtime_deliver_message but missing canonical app MCP tool id agent-teams_runtime_deliver_message'
    );
  });

  it('proves required tools through experimental tool ids', async () => {
    const client = fakeToolClient({
      ids: REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS.map((tool) =>
        buildOpenCodeCanonicalMcpToolId('agent-teams', tool)
      ),
      tools: [],
    });
    const probe = new OpenCodeMcpToolAvailabilityProbe(client);

    await expect(
      probe.proveRequiredTools({
        serverName: 'agent-teams',
        requiredTools: [...REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS],
        providerId: 'anthropic',
        modelId: 'claude-sonnet',
      })
    ).resolves.toMatchObject({
      ok: true,
      route: '/experimental/tool/ids',
      missingTools: [],
      matchedByRequiredTool: {
        runtime_deliver_message: 'agent-teams_runtime_deliver_message',
      },
    });
    expect(client.listExperimentalTools).not.toHaveBeenCalled();
  });

  it('falls back to provider/model tool definitions when ids route fails', async () => {
    const client = fakeToolClient({
      idsError: new Error('ids unavailable'),
      tools: REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS.map((tool) => ({
        id: buildOpenCodeCanonicalMcpToolId('agent-teams', tool),
      })),
    });
    const probe = new OpenCodeMcpToolAvailabilityProbe(client);

    await expect(
      probe.proveRequiredTools({
        serverName: 'agent-teams',
        requiredTools: [...REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS],
        providerId: 'anthropic',
        modelId: 'claude-sonnet',
      })
    ).resolves.toMatchObject({
      ok: true,
      route: '/experimental/tool',
      diagnostics: [],
    });
    expect(client.listExperimentalTools).toHaveBeenCalledWith({
      providerId: 'anthropic',
      modelId: 'claude-sonnet',
    });
  });

  it('keeps launch blocked when neither tool endpoint proves canonical tools', async () => {
    const client = fakeToolClient({
      ids: ['agent-teams_runtime_bootstrap_checkin'],
      toolsError: new Error('definitions unavailable'),
    });
    const probe = new OpenCodeMcpToolAvailabilityProbe(client);

    const proof = await probe.proveRequiredTools({
      serverName: 'agent-teams',
      requiredTools: [...REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS],
      providerId: 'anthropic',
      modelId: 'claude-sonnet',
    });

    expect(proof.ok).toBe(false);
    expect(proof.missingTools).toEqual(
      expect.arrayContaining(['runtime_deliver_message', 'runtime_task_event', 'runtime_heartbeat'])
    );
    expect(proof.diagnostics).toContain(
      'OpenCode app-owned MCP server is connected but required app tools were not proven available'
    );
  });

  it('verifies direct app MCP runtime tool contracts', () => {
    const result = verifyAppMcpRuntimeToolContracts(
      APP_MCP_RUNTIME_TOOL_CONTRACTS.map((contract) => ({
        name: contract.name,
        inputSchema: schemaWithRequired(contract.requiredInputFields),
      }))
    );

    expect(result).toEqual({
      ok: true,
      observedToolNames: [
        'runtime_bootstrap_checkin',
        'runtime_deliver_message',
        'runtime_heartbeat',
        'runtime_task_event',
      ],
      diagnostics: [],
    });
  });

  it('keeps runtime schema validation scoped to runtime proof tools', () => {
    expect(APP_MCP_RUNTIME_TOOL_CONTRACTS.map((contract) => contract.name)).toEqual(
      REQUIRED_AGENT_TEAMS_RUNTIME_PROOF_TOOLS
    );
    expect(REQUIRED_AGENT_TEAMS_APP_TOOLS).toContain('message_send');
    expect(APP_MCP_RUNTIME_TOOL_CONTRACTS.map((contract) => contract.name)).not.toContain(
      'message_send'
    );
  });

  it('fails direct app MCP preflight when delivery schema misses idempotencyKey', () => {
    const tools = APP_MCP_RUNTIME_TOOL_CONTRACTS.map((contract) => ({
      name: contract.name,
      inputSchema:
        contract.name === 'runtime_deliver_message'
          ? schemaWithRequired(['runId', 'teamName', 'fromMemberName', 'runtimeSessionId', 'to', 'text'])
          : schemaWithRequired(contract.requiredInputFields),
    }));

    expect(verifyAppMcpRuntimeToolContracts(tools).diagnostics).toContain(
      'App MCP tool runtime_deliver_message missing required field idempotencyKey'
    );
  });

  it('validates provider/model runtime_deliver_message tool schema', () => {
    const tools: OpenCodeToolListItem[] = [
      {
        id: 'agent-teams_runtime_deliver_message',
        parameters: schemaWithRequired([
          'idempotencyKey',
          'runId',
          'teamName',
          'fromMemberName',
          'runtimeSessionId',
          'to',
          'text',
        ]),
      },
    ];

    expect(assertRuntimeDeliverMessageSchema(tools)).toEqual([]);
    expect(
      assertRuntimeDeliverMessageSchema([
        {
          id: 'agent-teams_runtime_deliver_message',
          parameters: schemaWithRequired(['runId', 'teamName']),
        },
      ])
    ).toEqual([
      {
        severity: 'error',
        message:
          'runtime_deliver_message schema missing required fields: idempotencyKey, fromMemberName, runtimeSessionId, to, text',
        missingFields: ['idempotencyKey', 'fromMemberName', 'runtimeSessionId', 'to', 'text'],
      },
    ]);
  });
});

function fakeToolClient(options: {
  ids?: string[];
  tools?: OpenCodeToolListItem[];
  idsError?: Error;
  toolsError?: Error;
}): OpenCodeInfrastructureToolClient & {
  listExperimentalToolIds: ReturnType<typeof vi.fn>;
  listExperimentalTools: ReturnType<typeof vi.fn>;
} {
  return {
    listExperimentalToolIds: vi.fn(async () => {
      if (options.idsError) {
        throw options.idsError;
      }
      return options.ids ?? [];
    }),
    listExperimentalTools: vi.fn(async () => {
      if (options.toolsError) {
        throw options.toolsError;
      }
      return options.tools ?? [];
    }),
  };
}

function schemaWithRequired(required: string[]): Record<string, unknown> {
  return {
    type: 'object',
    required,
    properties: Object.fromEntries(required.map((field) => [field, { type: 'string' }])),
  };
}
