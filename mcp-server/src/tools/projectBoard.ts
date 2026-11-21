import { type FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';

import agentTeamsControllerModule from 'agent-teams-controller';

import { resolveBoardTeam } from '../utils/teamConfig';

const { AGENT_TEAMS_PROJECT_BOARD_TOOL_NAMES } = agentTeamsControllerModule;

type ToolServer = Pick<FastMCP, 'addTool'>;

/** The tools that work on the board of one team (the catalog's `projectBoard` groups). */
const PROJECT_BOARD_TOOL_NAMES: ReadonlySet<string> = new Set(AGENT_TEAMS_PROJECT_BOARD_TOOL_NAMES);

// Kept short on purpose: every agent of every team loads this field on every board tool.
const projectPathParameter = z.string().optional().describe('Per-project team: project folder');

interface BoardToolArgs {
  teamName: string;
  claudeDir?: string;
  projectPath?: string;
  [key: string]: unknown;
}

/**
 * A refusal of the app (an error the controller marks `appRefusal`, with its `code`) as the MCP
 * client sees it: a client only gets the text of a tool error, and FastMCP shows a `UserError` as
 * it is instead of `Tool '…' execution failed: …`. So the text starts with the code,
 * `[PROJECT_REQUIRED] …`, and the code is also in the structured content and on the error.
 */
function asClientRefusal(error: unknown): unknown {
  const refusal = error as { appRefusal?: unknown; code?: unknown } | null;
  if (!(error instanceof Error) || refusal?.appRefusal !== true || typeof refusal.code !== 'string') {
    return error;
  }
  const { code } = refusal;
  return Object.assign(new UserError(`[${code}] ${error.message}`, { code }), { code });
}

/**
 * Registers the board tools of `server` so that each works on the board the caller means. A board
 * tool gets an optional `projectPath`, and its team is resolved once, before the tool runs, by the
 * one rule in `resolveBoardTeam`: the tool then receives the physical team (an ordinary team, or
 * the project copy of a per-project team) as its `teamName`, and never sees `projectPath`. A
 * refusal of the app, from the resolution or from the tool itself (`cross_team_send`), reaches the
 * client with its code. The other tools (the team as a whole, launch and stop, the runtime bridge)
 * are registered unchanged.
 */
export function withProjectBoards(server: ToolServer): ToolServer {
  return {
    addTool(tool) {
      if (!PROJECT_BOARD_TOOL_NAMES.has(tool.name)) {
        server.addTool(tool);
        return;
      }
      const parameters: unknown = tool.parameters;
      if (
        !(parameters instanceof z.ZodObject) ||
        !Object.hasOwn(parameters.shape, 'teamName') ||
        Object.hasOwn(parameters.shape, 'projectPath')
      ) {
        throw new Error(
          `Board tool ${tool.name} needs an object schema with teamName and no projectPath`
        );
      }
      const { execute } = tool;
      server.addTool({
        ...tool,
        parameters: parameters.extend({ projectPath: projectPathParameter }),
        execute: async (args, context) => {
          const { projectPath, ...rest } = args as BoardToolArgs;
          try {
            const teamName = await resolveBoardTeam(
              rest.teamName,
              rest.claudeDir,
              projectPath?.trim() || undefined
            );
            return await execute({ ...rest, teamName } as Parameters<typeof execute>[0], context);
          } catch (error) {
            throw asClientRefusal(error);
          }
        },
      });
    },
  };
}
