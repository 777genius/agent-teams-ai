import * as agentTeamsControllerModule from 'agent-teams-controller';

export const REQUIRED_AGENT_TEAMS_RUNTIME_PROOF_TOOLS = [
  'runtime_bootstrap_checkin',
  'runtime_deliver_message',
  'runtime_task_event',
  'runtime_heartbeat',
] as const;

export const REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS = REQUIRED_AGENT_TEAMS_RUNTIME_PROOF_TOOLS;

export type RequiredAgentTeamsRuntimeTool =
  (typeof REQUIRED_AGENT_TEAMS_RUNTIME_PROOF_TOOLS)[number];

export const REQUIRED_AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOLS: readonly string[] = [
  ...agentTeamsControllerModule.AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES,
];

export const REQUIRED_AGENT_TEAMS_APP_TOOLS: readonly string[] = [
  ...REQUIRED_AGENT_TEAMS_RUNTIME_PROOF_TOOLS,
  ...REQUIRED_AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOLS,
];

export const REQUIRED_AGENT_TEAMS_APP_TOOL_IDS: readonly string[] =
  REQUIRED_AGENT_TEAMS_APP_TOOLS.map((tool) =>
    buildOpenCodeCanonicalMcpToolId('agent-teams', tool)
  );

export interface OpenCodeToolListItem {
  id: string;
  description?: string;
  parameters?: unknown;
}

export interface OpenCodeInfrastructureToolClient {
  listExperimentalToolIds(): Promise<string[]>;
  listExperimentalTools(input: {
    providerId: string;
    modelId: string;
  }): Promise<OpenCodeToolListItem[]>;
}

export type OpenCodeMcpToolProofRoute = '/experimental/tool/ids' | '/experimental/tool' | null;

export interface OpenCodeMcpToolProof {
  ok: boolean;
  route: OpenCodeMcpToolProofRoute;
  canonicalServerName: string;
  canonicalExpectedIds: Record<string, string>;
  observedTools: string[];
  missingTools: string[];
  matchedByRequiredTool: Record<string, string | null>;
  aliasMatchedByRequiredTool: Record<string, string | null>;
  diagnostics: string[];
}

export interface AppMcpRuntimeToolContract {
  name: RequiredAgentTeamsRuntimeTool;
  requiredInputFields: string[];
  idempotencyField: string | null;
  runScoped: boolean;
  handlerKind: 'bootstrap' | 'delivery' | 'task_event' | 'heartbeat';
}

export interface AppMcpToolDefinition {
  name: string;
  inputSchema: unknown;
}

export interface AppMcpRuntimeToolPreflightResult {
  ok: boolean;
  observedToolNames: string[];
  diagnostics: string[];
}

export interface RuntimeDeliverMessageSchemaDiagnostic {
  severity: 'error';
  message: string;
  missingFields?: string[];
}

export const APP_MCP_RUNTIME_TOOL_CONTRACTS: AppMcpRuntimeToolContract[] = [
  {
    name: 'runtime_bootstrap_checkin',
    requiredInputFields: ['runId', 'teamName', 'memberName', 'runtimeSessionId'],
    idempotencyField: null,
    runScoped: true,
    handlerKind: 'bootstrap',
  },
  {
    name: 'runtime_deliver_message',
    requiredInputFields: [
      'idempotencyKey',
      'runId',
      'teamName',
      'fromMemberName',
      'runtimeSessionId',
      'to',
      'text',
    ],
    idempotencyField: 'idempotencyKey',
    runScoped: true,
    handlerKind: 'delivery',
  },
  {
    name: 'runtime_task_event',
    requiredInputFields: ['idempotencyKey', 'runId', 'teamName', 'memberName', 'taskId', 'event'],
    idempotencyField: 'idempotencyKey',
    runScoped: true,
    handlerKind: 'task_event',
  },
  {
    name: 'runtime_heartbeat',
    requiredInputFields: ['runId', 'teamName', 'memberName', 'runtimeSessionId'],
    idempotencyField: null,
    runScoped: true,
    handlerKind: 'heartbeat',
  },
];

export class OpenCodeMcpToolAvailabilityProbe {
  constructor(private readonly client: OpenCodeInfrastructureToolClient) {}

  async proveRequiredTools(input: {
    serverName: string;
    requiredTools: string[];
    providerId: string;
    modelId: string;
  }): Promise<OpenCodeMcpToolProof> {
    const idsProof = await this.tryToolIdsProof(input);
    if (idsProof.ok) {
      return idsProof;
    }

    const definitionsProof = await this.tryToolDefinitionsProof(input);
    if (definitionsProof.ok) {
      return definitionsProof;
    }

    return mergeFailedToolProofs({
      serverName: input.serverName,
      requiredTools: input.requiredTools,
      idsProof,
      definitionsProof,
    });
  }

  private async tryToolIdsProof(input: {
    serverName: string;
    requiredTools: string[];
  }): Promise<OpenCodeMcpToolProof> {
    try {
      const observedTools = await this.client.listExperimentalToolIds();
      return matchRequiredOpenCodeTools({
        route: '/experimental/tool/ids',
        serverName: input.serverName,
        requiredTools: input.requiredTools,
        observedTools,
      });
    } catch (error) {
      return failedToolProof({
        route: '/experimental/tool/ids',
        serverName: input.serverName,
        requiredTools: input.requiredTools,
        diagnostics: [`OpenCode /experimental/tool/ids unavailable - ${stringifyError(error)}`],
      });
    }
  }

  private async tryToolDefinitionsProof(input: {
    serverName: string;
    requiredTools: string[];
    providerId: string;
    modelId: string;
  }): Promise<OpenCodeMcpToolProof> {
    try {
      const tools = await this.client.listExperimentalTools({
        providerId: input.providerId,
        modelId: input.modelId,
      });
      return matchRequiredOpenCodeTools({
        route: '/experimental/tool',
        serverName: input.serverName,
        requiredTools: input.requiredTools,
        observedTools: tools.map((tool) => tool.id),
      });
    } catch (error) {
      return failedToolProof({
        route: '/experimental/tool',
        serverName: input.serverName,
        requiredTools: input.requiredTools,
        diagnostics: [`OpenCode /experimental/tool unavailable - ${stringifyError(error)}`],
      });
    }
  }
}

export function sanitizeOpenCodeMcpToolPart(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_');
  return sanitized.length > 0 ? sanitized : 'unknown';
}

export function buildOpenCodeCanonicalMcpToolId(serverName: string, toolName: string): string {
  return `${sanitizeOpenCodeMcpToolPart(serverName)}_${sanitizeOpenCodeMcpToolPart(toolName)}`;
}

export function buildOpenCodeToolIdCandidates(serverName: string, toolName: string): string[] {
  const dashServerName = serverName.trim();
  const underscoreServerName = sanitizeOpenCodeMcpToolPart(serverName);
  const canonical = buildOpenCodeCanonicalMcpToolId(serverName, toolName);

  return unique([
    canonical,
    toolName,
    `${dashServerName}:${toolName}`,
    `${underscoreServerName}:${toolName}`,
    `${dashServerName}_${toolName}`,
    `${underscoreServerName}_${toolName}`,
    `mcp__${dashServerName}__${toolName}`,
    `mcp__${underscoreServerName}__${toolName}`,
  ]);
}

export function matchRequiredOpenCodeTools(input: {
  route: Exclude<OpenCodeMcpToolProofRoute, null>;
  serverName: string;
  requiredTools: string[];
  observedTools: string[];
}): OpenCodeMcpToolProof {
  const observed = new Set(input.observedTools);
  const matchedByRequiredTool: Record<string, string | null> = {};
  const aliasMatchedByRequiredTool: Record<string, string | null> = {};
  const missingTools: string[] = [];
  const diagnostics: string[] = [];
  const canonicalExpectedIds = buildCanonicalExpectedIds(input.serverName, input.requiredTools);

  for (const requiredTool of input.requiredTools) {
    const canonical = canonicalExpectedIds[requiredTool];
    const alias = buildOpenCodeToolIdCandidates(input.serverName, requiredTool).find(
      (candidate) => candidate !== canonical && observed.has(candidate)
    );

    matchedByRequiredTool[requiredTool] = observed.has(canonical) ? canonical : null;
    aliasMatchedByRequiredTool[requiredTool] = alias ?? null;

    if (!observed.has(canonical)) {
      missingTools.push(requiredTool);
      diagnostics.push(
        alias
          ? `OpenCode observed alias ${alias} but missing canonical app MCP tool id ${canonical}`
          : `OpenCode missing canonical app MCP tool id ${canonical}`
      );
    }
  }

  return {
    ok: missingTools.length === 0,
    route: input.route,
    canonicalServerName: sanitizeOpenCodeMcpToolPart(input.serverName),
    canonicalExpectedIds,
    observedTools: unique(input.observedTools).sort(),
    missingTools,
    matchedByRequiredTool,
    aliasMatchedByRequiredTool,
    diagnostics,
  };
}

export function verifyAppMcpRuntimeToolContracts(
  tools: AppMcpToolDefinition[]
): AppMcpRuntimeToolPreflightResult {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const diagnostics: string[] = [];

  for (const contract of APP_MCP_RUNTIME_TOOL_CONTRACTS) {
    const tool = byName.get(contract.name);
    if (!tool) {
      diagnostics.push(`App MCP tool missing: ${contract.name}`);
      continue;
    }

    const schema = asRecord(tool.inputSchema);
    const properties = asRecord(schema?.properties);
    const required = asStringArray(schema?.required);

    for (const field of contract.requiredInputFields) {
      if (!properties?.[field] || !required.includes(field)) {
        diagnostics.push(`App MCP tool ${contract.name} missing required field ${field}`);
      }
    }

    if (contract.idempotencyField && !required.includes(contract.idempotencyField)) {
      diagnostics.push(
        `App MCP tool ${contract.name} idempotency field ${contract.idempotencyField} is not required`
      );
    }
  }

  return {
    ok: diagnostics.length === 0,
    observedToolNames: tools.map((tool) => tool.name).sort(),
    diagnostics,
  };
}

export function assertRuntimeDeliverMessageSchema(
  tools: OpenCodeToolListItem[],
  serverName = 'agent-teams'
): RuntimeDeliverMessageSchemaDiagnostic[] {
  const deliverToolIds = new Set(
    buildOpenCodeToolIdCandidates(serverName, 'runtime_deliver_message')
  );
  const deliver = tools.find((tool) => deliverToolIds.has(tool.id));
  if (!deliver) {
    return [{ severity: 'error', message: 'runtime_deliver_message tool is absent' }];
  }

  const schema = asRecord(deliver.parameters);
  const properties = asRecord(schema?.properties);
  const required = asStringArray(schema?.required);
  const requiredFields = [
    'idempotencyKey',
    'runId',
    'teamName',
    'fromMemberName',
    'runtimeSessionId',
    'to',
    'text',
  ];
  const missingFields = requiredFields.filter(
    (field) => !properties?.[field] || !required.includes(field)
  );

  return missingFields.length === 0
    ? []
    : [
        {
          severity: 'error',
          message: `runtime_deliver_message schema missing required fields: ${missingFields.join(', ')}`,
          missingFields,
        },
      ];
}

function mergeFailedToolProofs(input: {
  serverName: string;
  requiredTools: string[];
  idsProof: OpenCodeMcpToolProof;
  definitionsProof: OpenCodeMcpToolProof;
}): OpenCodeMcpToolProof {
  const canonicalExpectedIds = buildCanonicalExpectedIds(input.serverName, input.requiredTools);
  const matchedByRequiredTool: Record<string, string | null> = {};
  const aliasMatchedByRequiredTool: Record<string, string | null> = {};

  for (const tool of input.requiredTools) {
    matchedByRequiredTool[tool] =
      input.idsProof.matchedByRequiredTool[tool] ??
      input.definitionsProof.matchedByRequiredTool[tool] ??
      null;
    aliasMatchedByRequiredTool[tool] =
      input.idsProof.aliasMatchedByRequiredTool[tool] ??
      input.definitionsProof.aliasMatchedByRequiredTool[tool] ??
      null;
  }

  return {
    ok: false,
    route: input.definitionsProof.route ?? input.idsProof.route,
    canonicalServerName: sanitizeOpenCodeMcpToolPart(input.serverName),
    canonicalExpectedIds,
    observedTools: unique([
      ...input.idsProof.observedTools,
      ...input.definitionsProof.observedTools,
    ]).sort(),
    missingTools: unique([
      ...input.idsProof.missingTools,
      ...input.definitionsProof.missingTools,
    ]).sort(),
    matchedByRequiredTool,
    aliasMatchedByRequiredTool,
    diagnostics: [
      ...input.idsProof.diagnostics,
      ...input.definitionsProof.diagnostics,
      'OpenCode app-owned MCP server is connected but required app tools were not proven available',
    ],
  };
}

function failedToolProof(input: {
  route: Exclude<OpenCodeMcpToolProofRoute, null>;
  serverName: string;
  requiredTools: string[];
  diagnostics: string[];
}): OpenCodeMcpToolProof {
  const canonicalExpectedIds = buildCanonicalExpectedIds(input.serverName, input.requiredTools);
  return {
    ok: false,
    route: input.route,
    canonicalServerName: sanitizeOpenCodeMcpToolPart(input.serverName),
    canonicalExpectedIds,
    observedTools: [],
    missingTools: [...input.requiredTools],
    matchedByRequiredTool: Object.fromEntries(input.requiredTools.map((tool) => [tool, null])),
    aliasMatchedByRequiredTool: Object.fromEntries(input.requiredTools.map((tool) => [tool, null])),
    diagnostics: input.diagnostics,
  };
}

function buildCanonicalExpectedIds(
  serverName: string,
  requiredTools: string[]
): Record<string, string> {
  return Object.fromEntries(
    requiredTools.map((tool) => [tool, buildOpenCodeCanonicalMcpToolId(serverName, tool)])
  );
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
