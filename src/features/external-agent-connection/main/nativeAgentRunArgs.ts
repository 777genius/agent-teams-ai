import agentTeamsController from 'agent-teams-controller';

import type { ConnectionInfoV1, ExternalAgentRunProvider } from '../contracts';

const SERVER_NAME = 'agent-teams';

export interface NativeManagementMcp {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Per-run config only. The registered team group contains no launch/stop/delete/restore tools. */
export function nativeAgentRunArgs(
  provider: ExternalAgentRunProvider,
  connection: ConnectionInfoV1,
  managementMcp?: NativeManagementMcp
): string[] {
  const { AGENT_TEAMS_MANAGEMENT_TOOL_NAMES, AGENT_TEAMS_REGISTERED_TOOL_NAMES } =
    agentTeamsController;
  const managementTools = AGENT_TEAMS_MANAGEMENT_TOOL_NAMES;
  const tools = managementTools.filter(
    (tool) =>
      (tool !== 'team_update' || connection.capabilities.configurationEdit) &&
      (tool !== 'team_trash' || connection.capabilities.reversibleTrash)
  );
  if (!connection.mcp.url) throw new Error('App MCP is unavailable');
  if (!tools.includes('app_get_connection_info') || !tools.includes('team_create'))
    throw new Error('Management MCP tools are unavailable');
  if (provider === 'anthropic') {
    if (!managementMcp) throw new Error('Bound management MCP launch is unavailable');
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
      JSON.stringify({
        mcpServers: {
          [SERVER_NAME]: {
            type: 'stdio',
            ...managementMcp,
            args: [...managementMcp.args, '--transport', 'stdio', '--tool-profile', 'management'],
          },
        },
      }),
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
