import {
  resolveAgentTeamsMcpLaunchSpec,
  resolvePackagedAgentTeamsMcpEntry,
} from '@main/services/team/TeamMcpConfigBuilder';
import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import type { McpLaunchSpec } from '@main/services/team/TeamMcpConfigBuilder';

const logger = createLogger('Runtime:AgentTeamsMcpLaunchEnv');

const MCP_COMMAND_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND';
const MCP_ENTRY_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY';
const MCP_ARGS_JSON_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON';
const MCP_ENV_JSON_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON';
const ELECTRON_RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE';

export type AgentTeamsMcpLaunchEnv = Record<string, string | undefined>;

/** Project existing app authority only; never resolve or start a server on a read. */
export function applyAgentTeamsMcpAppContext(
  env: AgentTeamsMcpLaunchEnv,
  claudeBasePath: string = getClaudeBasePath(),
  controlApiBaseUrl: string | null | undefined = process.env.CLAUDE_TEAM_CONTROL_URL
): void {
  const rawChildEnv = env[MCP_ENV_JSON_ENV]?.trim();
  const parsed: unknown = rawChildEnv ? JSON.parse(rawChildEnv) : {};
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((value) => typeof value !== 'string')
  ) {
    throw new Error('Agent Teams MCP child environment must be a JSON object of strings');
  }
  const childEnv = { ...parsed } as Record<string, string>;
  env.AGENT_TEAMS_MCP_CLAUDE_DIR = claudeBasePath;
  childEnv.AGENT_TEAMS_MCP_CLAUDE_DIR = claudeBasePath;
  const controlUrl = controlApiBaseUrl?.trim();
  if (controlUrl) {
    env.CLAUDE_TEAM_CONTROL_URL = controlUrl;
    childEnv.CLAUDE_TEAM_CONTROL_URL = controlUrl;
  } else {
    delete env.CLAUDE_TEAM_CONTROL_URL;
    delete childEnv.CLAUDE_TEAM_CONTROL_URL;
  }
  env[MCP_ENV_JSON_ENV] = JSON.stringify(childEnv);
}

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
  resolveLaunchSpec: () => Promise<McpLaunchSpec> = resolveAgentTeamsMcpLaunchSpec,
  resolvePackagedEntry: () => Promise<string | null> = resolvePackagedAgentTeamsMcpEntry
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
      throw new Error('Resolved Agent Teams MCP launch spec is incomplete');
    }

    env[MCP_COMMAND_ENV] = command;
    env[MCP_ENTRY_ENV] = entry;
    env[MCP_ARGS_JSON_ENV] = JSON.stringify(launchSpec.args);
    env[MCP_ENV_JSON_ENV] = JSON.stringify(launchSpec.env ?? {});
  } catch (error) {
    const entryOnlyFallback =
      env[MCP_ENTRY_ENV]?.trim() || (await resolvePackagedEntry().catch(() => null));
    if (entryOnlyFallback) {
      env[MCP_ENTRY_ENV] = entryOnlyFallback;
      logger.warn(
        `Unable to resolve the full Agent Teams MCP launch env; using packaged entrypoint fallback: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }
    logger.warn(
      `Unable to resolve Agent Teams MCP local launch env: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
