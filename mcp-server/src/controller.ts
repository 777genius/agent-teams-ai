import * as agentTeamsControllerModule from 'agent-teams-controller';

type ControllerModule = typeof import('agent-teams-controller') & {
  default?: typeof import('agent-teams-controller');
};

const controllerModule =
  (agentTeamsControllerModule as ControllerModule).default ?? agentTeamsControllerModule;
const { createController } = controllerModule;

const FORCED_CLAUDE_DIR_ENV = 'AGENT_TEAMS_MCP_CLAUDE_DIR';

/** Re-export agentBlocks utilities (stripAgentBlocks, wrapAgentBlock, etc.) */
export const agentBlocks = controllerModule.agentBlocks;

export function getController(teamName: string, claudeDir?: string) {
  const forcedClaudeDir = process.env[FORCED_CLAUDE_DIR_ENV]?.trim();
  return createController({
    teamName,
    ...(forcedClaudeDir ? { claudeDir: forcedClaudeDir } : claudeDir ? { claudeDir } : {}),
  });
}
