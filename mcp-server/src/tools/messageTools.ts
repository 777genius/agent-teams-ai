import type { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { getController } from '../controller';
import { assertConfiguredTeam } from '../utils/teamConfig';
import { jsonTextContent } from '../utils/format';

const toolContextSchema = {
  teamName: z.string().min(1),
  claudeDir: z.string().min(1).optional(),
};

export function registerMessageTools(server: Pick<FastMCP, 'addTool'>) {
  server.addTool({
    name: 'message_send',
    description:
      'Send a visible team/user message into team inbox. OpenCode teammates should use this for normal replies to the human user, lead, or same-team teammates. When to is "user", from is required and must be your configured teammate name.',
    parameters: z.object({
      ...toolContextSchema,
      to: z.string().min(1),
      text: z.string().min(1),
      from: z.string().optional(),
      summary: z.string().optional(),
      source: z.string().optional(),
      leadSessionId: z.string().optional(),
      attachments: z
        .array(
          z.object({
            id: z.string().min(1),
            filename: z.string().min(1),
            mimeType: z.string().min(1),
            size: z.number().nonnegative(),
          })
        )
        .optional(),
      taskRefs: z
        .array(
          z.object({
            taskId: z.string().min(1),
            displayId: z.string().min(1),
            teamName: z.string().min(1),
          })
        )
        .optional(),
    }),
    execute: async ({
      teamName,
      claudeDir,
      to,
      text,
      from,
      summary,
      source,
      leadSessionId,
      attachments,
      taskRefs,
    }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          getController(teamName, claudeDir).messages.sendMessage({
            to,
            text,
            ...(from ? { from } : {}),
            ...(summary ? { summary } : {}),
            ...(source ? { source } : {}),
            ...(leadSessionId ? { leadSessionId } : {}),
            ...(attachments?.length ? { attachments } : {}),
            ...(taskRefs?.length ? { taskRefs } : {}),
          })
        )
      );
    },
  });
}
