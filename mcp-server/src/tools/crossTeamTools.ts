import type { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { getController } from '../controller';
import { jsonTextContent } from '../utils/format';

const toolContextSchema = {
  teamName: z.string().min(1),
  claudeDir: z.string().min(1).optional(),
};

export function registerCrossTeamTools(server: Pick<FastMCP, 'addTool'>) {
  server.addTool({
    name: 'cross_team_send',
    description:
      'Send a message to another team. The message is delivered to the target team lead inbox.',
    parameters: z.object({
      ...toolContextSchema,
      toTeam: z.string().min(1),
      text: z.string().min(1),
      fromMember: z.string().optional(),
      summary: z.string().optional(),
      chainDepth: z.number().int().nonnegative().optional(),
    }),
    execute: async ({ teamName, claudeDir, toTeam, text, fromMember, summary, chainDepth }) =>
      await Promise.resolve(
        jsonTextContent(
          getController(teamName, claudeDir).crossTeam.sendCrossTeamMessage({
            toTeam,
            text,
            ...(fromMember ? { fromMember } : {}),
            ...(summary ? { summary } : {}),
            ...(chainDepth !== undefined ? { chainDepth } : {}),
          })
        )
      ),
  });

  server.addTool({
    name: 'cross_team_list_targets',
    description: 'List available teams that can receive cross-team messages.',
    parameters: z.object({
      ...toolContextSchema,
      excludeTeam: z.string().optional(),
    }),
    execute: async ({ teamName, claudeDir, excludeTeam }) =>
      await Promise.resolve(
        jsonTextContent(
          getController(teamName, claudeDir).crossTeam.listCrossTeamTargets({
            ...(excludeTeam ? { excludeTeam } : {}),
          })
        )
      ),
  });

  server.addTool({
    name: 'cross_team_get_outbox',
    description: 'Get sent cross-team messages for the current team.',
    parameters: z.object({
      ...toolContextSchema,
    }),
    execute: async ({ teamName, claudeDir }) =>
      await Promise.resolve(
        jsonTextContent(getController(teamName, claudeDir).crossTeam.getCrossTeamOutbox())
      ),
  });
}
