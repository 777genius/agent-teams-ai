import { resolveAgentTeamsMcpLaunchSpec } from '@main/services/team/TeamMcpConfigBuilder';
import { createLogger } from '@shared/utils/logger';

import type { McpLaunchSpec } from '@main/services/team/TeamMcpConfigBuilder';

const logger = createLogger('Runtime:AgentTeamsMcpLaunchEnv');

const MCP_COMMAND_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND';
const MCP_ENTRY_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY';
const MCP_ARGS_JSON_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON';
const MCP_ENV_JSON_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON';
const ELECTRON_RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE';

export type AgentTeamsMcpLaunchEnv = Record<string, string | undefined>;

export function hasAgentTeamsMcpLocalLaunchEnv(env: AgentTeamsMcpLaunchEnv): boolean {
  return Boolean(
    env[MCP_COMMAND_ENV]?.trim() && env[MCP_ENTRY_ENV]?.trim() && env[MCP_ARGS_JSON_ENV]?.trim()
  );
}

function ensureLegacyMcpChildEnvJson(env: AgentTeamsMcpLaunchEnv): void {
  if (env[MCP_ENV_JSON_ENV]?.trim()) {
    return;
  }
  const electronRunAsNode = env[ELECTRON_RUN_AS_NODE_ENV]?.trim();
  if (electronRunAsNode) {
    env[MCP_ENV_JSON_ENV] = JSON.stringify({
      [ELECTRON_RUN_AS_NODE_ENV]: electronRunAsNode,
    });
  }
}

export async function ensureAgentTeamsMcpLocalLaunchEnv(
  env: AgentTeamsMcpLaunchEnv,
  resolveLaunchSpec: () => Promise<McpLaunchSpec> = resolveAgentTeamsMcpLaunchSpec
): Promise<void> {
  if (hasAgentTeamsMcpLocalLaunchEnv(env)) {
    ensureLegacyMcpChildEnvJson(env);
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
    env[MCP_ENV_JSON_ENV] = JSON.stringify(launchSpec.env ?? {});
  } catch (error) {
    logger.warn(
      `Unable to resolve Agent Teams MCP local launch env: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
