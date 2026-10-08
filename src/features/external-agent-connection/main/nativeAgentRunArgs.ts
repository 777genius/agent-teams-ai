import agentTeamsController from 'agent-teams-controller';

import type { ConnectionInfoV1, ExternalAgentRunProvider } from '../contracts';

const SERVER_NAME = 'agent-teams';
const { AGENT_TEAMS_MCP_TOOL_GROUPS, AGENT_TEAMS_REGISTERED_TOOL_NAMES } = agentTeamsController;
const MANAGEMENT_TOOLS = (
  AGENT_TEAMS_MCP_TOOL_GROUPS.find((group) => group.id === 'team')?.toolNames ?? []
).filter((tool) =>
  [
    'app_get_connection_info',
    'team_list',
    'team_get',
    'team_create',
    'team_update',
    'team_trash',
  ].includes(tool)
);

/** Per-run config only. The registered team group contains no launch/stop/delete/restore tools. */
export function nativeAgentRunArgs(
  provider: ExternalAgentRunProvider,
  connection: ConnectionInfoV1
): string[] {
  const tools = MANAGEMENT_TOOLS.filter(
    (tool) =>
      (tool !== 'team_update' || connection.capabilities.configurationEdit) &&
      (tool !== 'team_trash' || connection.capabilities.reversibleTrash)
  );
  if (!connection.mcp.url) throw new Error('App MCP is unavailable');
  if (!tools.includes('app_get_connection_info') || !tools.includes('team_create'))
    throw new Error('Management MCP tools are unavailable');
  if (provider === 'anthropic') {
    const namespaced = (tool: string) => `mcp__${SERVER_NAME}__${tool}`;
    return [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '20',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--tools',
      '',
      '--settings',
      JSON.stringify({ disableAllHooks: true }),
      '--disable-slash-commands',
      '--mcp-config',
      JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'http', url: connection.mcp.url } } }),
      '--allowedTools',
      tools.map(namespaced).join(','),
      '--disallowedTools',
      AGENT_TEAMS_REGISTERED_TOOL_NAMES.filter((tool) => !tools.includes(tool))
        .map(namespaced)
        .join(','),
    ];
  }
  const config: Record<string, unknown> = {
    sandbox_mode: 'read-only',
    approval_policy: 'never',
    web_search: 'disabled',
    'features.shell_tool': false,
    'features.unified_exec': false,
    'features.apply_patch_freeform': false,
    'features.js_repl': false,
    'features.multi_agent': false,
    'features.apps': false,
    'features.skill_mcp_dependency_install': false,
    'features.hooks': false,
    [`mcp_servers.${SERVER_NAME}.url`]: connection.mcp.url,
    [`mcp_servers.${SERVER_NAME}.enabled_tools`]: tools,
    [`mcp_servers.${SERVER_NAME}.required`]: true,
    ...Object.fromEntries(
      tools.map((tool) => [`mcp_servers.${SERVER_NAME}.tools.${tool}.approval_mode`, 'approve'])
    ),
  };
  return [
    'exec',
    '--ignore-user-config',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
    '-',
  ];
}
