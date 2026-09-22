import type { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { getController } from '../controller';
import { jsonTextContent } from '../utils/format';
import { assertConfiguredTeam } from '../utils/teamConfig';

const toolContextSchema = {
  teamName: z.string().min(1),
  claudeDir: z.string().min(1).optional(),
};

const taskRefSchema = z.object({
  taskId: z.string().min(1),
  displayId: z.string().min(1),
  teamName: z.string().min(1),
});

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
      conversationId: z.string().optional(),
      replyToConversationId: z.string().optional(),
      taskRefs: z.array(taskRefSchema).optional(),
      chainDepth: z.number().int().nonnegative().optional(),
    }),
    execute: async ({
      teamName,
      claudeDir,
      toTeam,
      text,
      fromMember,
      summary,
      conversationId,
      replyToConversationId,
      taskRefs,
      chainDepth,
    }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          getController(teamName, claudeDir).crossTeam.sendCrossTeamMessage({
            toTeam,
            text,
            ...(fromMember ? { fromMember } : {}),
            ...(summary ? { summary } : {}),
            ...(conversationId ? { conversationId } : {}),
            ...(replyToConversationId ? { replyToConversationId } : {}),
            ...(taskRefs?.length ? { taskRefs } : {}),
            ...(chainDepth !== undefined ? { chainDepth } : {}),
          })
        )
      );
    },
  });

  server.addTool({
    name: 'cross_team_list_targets',
    description: 'List available teams that can receive cross-team messages.',
    parameters: z.object({
      ...toolContextSchema,
      excludeTeam: z.string().optional(),
    }),
    execute: async ({ teamName, claudeDir, excludeTeam }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          getController(teamName, claudeDir).crossTeam.listCrossTeamTargets({
            ...(excludeTeam ? { excludeTeam } : {}),
          })
        )
      );
    },
  });

  server.addTool({
    name: 'cross_team_get_outbox',
    description: 'Get sent cross-team messages for the current team.',
    parameters: z.object({
      ...toolContextSchema,
    }),
    execute: async ({ teamName, claudeDir }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(getController(teamName, claudeDir).crossTeam.getCrossTeamOutbox())
      );
    },
  });
}
