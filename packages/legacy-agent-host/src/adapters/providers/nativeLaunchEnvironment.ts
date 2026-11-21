import { canonicalOpenCodeAgentPermission } from './openCodeAgentPolicy.js';
import { coordinationNames, coordinationServer } from './OpenCodeCoordinationEndpoint.js';
import { ManagementCommandError } from '../../management/commandRecords.js';

import type { OpenCodeMemberProfile } from '../../composition/runtimeProfile.js';
import type { OpenCodeManagementProfile } from '../../management/profile.js';

type Environment = Readonly<Record<string, string>>;
type RecordValue = Record<string, unknown>;
export type NativeTeamEndpoint = Readonly<{ url: string; bearerToken: string }>;
export type CoordinationModel = Readonly<{ providerId: string; modelId: string }>;
export const coordinationAgent = 'agent-teams-local-coordination';
export const codexTeamTokenEnvironment = 'LEGACY_AGENT_HOST_TEAM_MCP_TOKEN';

const record = (value: unknown): RecordValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid OpenCode configuration');
  return value as RecordValue;
};

/** Assembly only. Endpoint creation, secrets, file identities and guards stay with each owner. */
export function buildCodexMemberEnvironment(environment: Environment, token: string) {
  return { ...environment, [codexTeamTokenEnvironment]: token };
}

export function readOpenCodeLaunchConfig(environment: Environment): RecordValue {
  return environment.OPENCODE_CONFIG_CONTENT === undefined
    ? {} : record(JSON.parse(environment.OPENCODE_CONFIG_CONTENT) as unknown);
}

export function openCodeMemberPrompt(profile: OpenCodeMemberProfile, config: RecordValue,
  instructions: string): string {
  const agents = config.agent === undefined ? {} : record(config.agent);
  const agent = agents[profile.nativeOptions.agent] === undefined
    ? {} : record(agents[profile.nativeOptions.agent]);
  if (agent.prompt !== undefined && typeof agent.prompt !== 'string')
    throw new Error('Invalid OpenCode agent prompt');
  return [instructions, agent.prompt, profile.nativeOptions.instructions].filter(Boolean).join('\n\n');
}

export function buildOpenCodeMemberConfiguration(profile: OpenCodeMemberProfile,
  config: RecordValue, prompt: string, input: {
    mcp: RecordValue; prefix: string; endpoint: NativeTeamEndpoint;
    requiredToolNames: readonly string[]; plugin?: string;
  }) {
  const { mcp, prefix, endpoint, requiredToolNames, plugin } = input;
  const agentName = profile.nativeOptions.agent;
  const agents = config.agent === undefined ? {} : record(config.agent);
  const agent = agents[agentName] === undefined ? {} : record(agents[agentName]);
  let serverName = Object.hasOwn(mcp, 'team') ? prefix : 'team';
  for (let index = 1; Object.hasOwn(mcp, serverName); index++) serverName = `${prefix}_${index}`;
  const required = requiredToolNames.map((name) => `${serverName}_${name}`);
  const permission = agent.permission === undefined ? {} : record(agent.permission);
  const approvalMode = profile.nativeOptions.toolApprovalMode;
  const selectedPermissions = approvalMode === undefined ? permission : {
    '*': approvalMode === 'manual' ? 'ask' : 'deny',
    ...(approvalMode === 'manual' ? {} : Object.fromEntries(
      ['read', 'glob', 'grep', 'list', 'lsp', 'todoread', 'todowrite', 'edit', 'bash']
        .map((name) => [name, 'allow']))),
    task: { '*': 'deny' }, external_directory: 'deny', doom_loop: 'deny',
  };
  const tools = agent.tools === undefined ? {} : record(agent.tools);
  const effectiveAgent = {
    ...Object.fromEntries(Object.entries(agent).filter(([key]) => key !== 'tools')),
    prompt,
    model: `${profile.nativeOptions.providerId}/${profile.model}`,
    permission: canonicalOpenCodeAgentPermission(tools, selectedPermissions, required),
  };
  const plugins = config.plugin === undefined ? [] : config.plugin;
  if (!Array.isArray(plugins)) throw new Error('Invalid OpenCode plugins');
  const nativeConfig = {
    ...config,
    ...(plugin ? { plugin: [...plugins.filter((value) => value !== plugin), plugin] } : {}),
    agent: { ...agents, [agentName]: effectiveAgent },
    mcp: {
      ...mcp,
      [serverName]: {
        type: 'remote', url: endpoint.url,
        headers: { Authorization: `Bearer ${endpoint.bearerToken}` },
        oauth: false, enabled: true, timeout: profile.limits.timeoutMs,
      },
    },
  };
  return { serverName, required, effectiveAgent, nativeConfig, approvalMode, selectedPermissions };
}

export function buildOpenCodeMemberEnvironment(environment: Environment, nativeConfig: RecordValue,
  password: string, policy?: { nonce: string; serverName: string }) {
  return {
    ...environment,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(nativeConfig),
    ...(policy ? {
      LEGACY_AGENT_HOST_MCP_POLICY_NONCE: policy.nonce,
      LEGACY_AGENT_HOST_MCP_TEAM_SERVER: policy.serverName,
    } : {}),
    OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password,
  };
}

export function buildOpenCodeManagementEnvironment(environment: Environment, config: RecordValue,
  input: { password: string; witnessAgent: string; witness: string; coordination: boolean }) {
  const agents = config.agent === undefined ? {} : record(config.agent);
  return {
    ...environment,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...config,
      // Management model probes deny tools; the coordination challenge has its own finite policy.
      permission: input.coordination ? config.permission : { '*': 'deny' },
      // The disabled witness is neither a conversation nor a Team member.
      agent: {
        ...agents,
        [input.witnessAgent]: { prompt: input.witness, disable: true, hidden: true },
      },
    }),
    OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: input.password,
  };
}

export function buildOpenCodeCoordinationEnvironment(environment: Environment, paths: {
  home: string; config: string; data: string; cache: string; state: string;
}) {
  const retained = Object.fromEntries(Object.entries(environment)
    .filter(([key]) => !key.toUpperCase().startsWith('OPENCODE_')));
  return {
    ...retained, HOME: paths.home, USERPROFILE: paths.home,
    XDG_CONFIG_HOME: paths.config, XDG_DATA_HOME: paths.data,
    XDG_CACHE_HOME: paths.cache, XDG_STATE_HOME: paths.state,
    OPENCODE_PURE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
  };
}

export function selectOpenCodeCoordinationProvider(selected: RecordValue,
  input: CoordinationModel, key?: string): RecordValue | undefined {
  const row = (value: unknown): RecordValue => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new ManagementCommandError('invalid');
    return value as RecordValue;
  };
  const provider = structuredClone(selected), options = row(provider.options ?? {});
  const modelId = input.modelId.startsWith(input.providerId + '/')
    ? input.modelId.slice(input.providerId.length + 1) : input.modelId;
  if (provider.npm !== '@ai-sdk/openai-compatible' || !provider.models ||
      !Object.hasOwn(row(provider.models), modelId)) return undefined;
  if (key !== undefined && options.apiKey === undefined) options.apiKey = key;
  provider.options = options;
  provider.models = { [modelId]: row(provider.models)[modelId] };
  return provider;
}

export function coordinationV1Permissions() {
  return { '*': 'deny', ...Object.fromEntries(coordinationNames
    .map(name => [coordinationServer + '_' + name, 'allow'])) };
}

/** The general local-readiness path only; the older Linux Phase-A constructor stays separate. */
export function buildOpenCodeCoordinationConfig(profile: Pick<OpenCodeManagementProfile, 'modelProbeTimeoutMs'>,
  input: CoordinationModel, provider: RecordValue, endpoint: NativeTeamEndpoint) {
  const modelId = input.modelId.startsWith(input.providerId + '/')
    ? input.modelId.slice(input.providerId.length + 1) : input.modelId;
  const model = input.providerId + '/' + modelId, permission = coordinationV1Permissions();
  return {
    autoupdate: false, share: 'disabled', enabled_providers: [input.providerId],
    model, small_model: model, default_agent: coordinationAgent, plugin: [], instructions: [],
    permission, compaction: { auto: false }, provider: { [input.providerId]: provider },
    agent: {
      title: { disable: true }, summary: { disable: true },
      [coordinationAgent]: { mode: 'primary', model, permission, steps: 3 },
    },
    mcp: {
      [coordinationServer]: {
        type: 'remote', url: endpoint.url,
        headers: { Authorization: 'Bearer ' + endpoint.bearerToken }, oauth: false, enabled: true,
        timeout: Math.min(profile.modelProbeTimeoutMs ?? 90000, 90000),
      },
    },
  };
}
