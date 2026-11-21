import type { FastMCP } from 'fastmcp';
import { z } from 'zod';

import agentTeamsControllerModule from 'agent-teams-controller';

import { resolveBoardTeam } from '../utils/teamConfig';

const { AGENT_TEAMS_MANAGEMENT_TOOL_NAMES } = agentTeamsControllerModule;

type ToolServer = Pick<FastMCP, 'addTool'>;

/**
 * Tools that address a team as a whole: its definition (`team_*`, the management tools) or its
 * process (launch, stop). The app resolves a per-project team for them itself. Every other tool
 * works on the board of one team.
 */
const TEAM_LEVEL_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...AGENT_TEAMS_MANAGEMENT_TOOL_NAMES,
  'team_launch',
  'team_stop',
]);

const projectPathParameter = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Only for a team with a separate history per project: its project folder (team_launch cwd).'
  );

interface BoardToolArgs {
  teamName: string;
  claudeDir?: string;
  projectPath?: string;
  [key: string]: unknown;
}

/**
 * Registers the board tools of `server` so that each works on the board the caller means. A board
 * tool gets an optional `projectPath`, and its team is resolved once, before the tool runs, by the
 * one rule in `resolveBoardTeam`: the tool then receives the physical team (an ordinary team, or
 * the project copy of a per-project team) as its `teamName`, and never sees `projectPath`.
 * Tools of the team as a whole are registered unchanged.
 */
export function withProjectBoards(server: ToolServer): ToolServer {
  return {
    addTool(tool) {
      if (TEAM_LEVEL_TOOL_NAMES.has(tool.name)) {
        server.addTool(tool);
        return;
      }
      const parameters: unknown = tool.parameters;
      if (
        !(parameters instanceof z.ZodObject) ||
        !Object.hasOwn(parameters.shape, 'teamName') ||
        Object.hasOwn(parameters.shape, 'projectPath')
      ) {
        throw new Error(`Board tool ${tool.name} needs an object schema with teamName and no projectPath`);
      }
      const { execute } = tool;
      server.addTool({
        ...tool,
        parameters: parameters.extend({ projectPath: projectPathParameter }),
        execute: async (args, context) => {
          const { projectPath, ...rest } = args as BoardToolArgs;
          const teamName = await resolveBoardTeam(rest.teamName, rest.claudeDir, projectPath);
          return execute({ ...rest, teamName } as Parameters<typeof execute>[0], context);
        },
      });
    },
  };
}
