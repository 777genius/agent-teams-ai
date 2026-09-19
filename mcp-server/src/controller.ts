import * as agentTeamsControllerModule from 'agent-teams-controller';

type ControllerModule = typeof import('agent-teams-controller') & {
  default?: typeof import('agent-teams-controller');
};

const controllerModule =
  (agentTeamsControllerModule as ControllerModule).default ?? agentTeamsControllerModule;
const { createController } = controllerModule;

const FORCED_CLAUDE_DIR_ENV = 'AGENT_TEAMS_MCP_CLAUDE_DIR';

type WorkSyncCapableController = ReturnType<typeof createController> & {
  workSync: {
    memberWorkSyncStatus(flags: Record<string, unknown>): Promise<unknown>;
    memberWorkSyncReport(flags: Record<string, unknown>): Promise<unknown>;
  };
};

/** Re-export agentBlocks utilities (stripAgentBlocks, wrapAgentBlock, etc.) */
export const agentBlocks = controllerModule.agentBlocks;

/** Re-export context-free text classifiers (completion-claim shape). */
export const taskTextSignals = controllerModule.taskTextSignals;

export function getController(teamName: string, claudeDir?: string): WorkSyncCapableController {
  const forcedClaudeDir = process.env[FORCED_CLAUDE_DIR_ENV]?.trim();
  let resolvedClaudeDir = claudeDir;
  if (forcedClaudeDir) {
    resolvedClaudeDir = forcedClaudeDir;
  }

  return createController({
    teamName,
    ...(resolvedClaudeDir ? { claudeDir: resolvedClaudeDir } : {}),
    allowUserMessageSender: false,
  }) as WorkSyncCapableController;
}
