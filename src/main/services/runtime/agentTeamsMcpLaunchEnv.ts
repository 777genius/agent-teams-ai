import { resolveAgentTeamsMcpLaunchSpec } from '@main/services/team/TeamMcpConfigBuilder';
import { createLogger } from '@shared/utils/logger';

import type { McpLaunchSpec } from '@main/services/team/TeamMcpConfigBuilder';

const logger = createLogger('Runtime:AgentTeamsMcpLaunchEnv');

const MCP_COMMAND_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND';
const MCP_ENTRY_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY';
const MCP_ARGS_JSON_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON';

export type AgentTeamsMcpLaunchEnv = Record<string, string | undefined>;

export function hasAgentTeamsMcpLocalLaunchEnv(env: AgentTeamsMcpLaunchEnv): boolean {
  return Boolean(
    env[MCP_COMMAND_ENV]?.trim() && env[MCP_ENTRY_ENV]?.trim() && env[MCP_ARGS_JSON_ENV]?.trim()
  );
}

export async function ensureAgentTeamsMcpLocalLaunchEnv(
  env: AgentTeamsMcpLaunchEnv,
  resolveLaunchSpec: () => Promise<McpLaunchSpec> = resolveAgentTeamsMcpLaunchSpec
): Promise<void> {
  if (hasAgentTeamsMcpLocalLaunchEnv(env)) {
    return;
  }

  try {
    const launchSpec = await resolveLaunchSpec();
    const entry = launchSpec.args[0]?.trim();
    const command = launchSpec.command.trim();
    if (!command || !entry) {
      return;
    }

    env[MCP_COMMAND_ENV] = command;
    env[MCP_ENTRY_ENV] = entry;
    env[MCP_ARGS_JSON_ENV] = JSON.stringify(launchSpec.args);
  } catch (error) {
    logger.warn(
      `Unable to resolve Agent Teams MCP local launch env: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
