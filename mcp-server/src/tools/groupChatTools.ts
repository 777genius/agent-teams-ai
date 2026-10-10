import type { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { getController } from '../controller';
import { jsonTextContent } from '../utils/format';
import { taskRefSchema } from '../utils/schemas';
import { assertConfiguredTeam } from '../utils/teamConfig';

const context = {
  teamName: z.string().min(1),
  claudeDir: z.string().min(1).optional(),
  from: z.string().min(1),
};

export function registerGroupChatTools(server: Pick<FastMCP, 'addTool'>) {
  server.addTool({
    name: 'group_chat_list',
    description:
      'Get the fresh group chat catalog, including membership, archive state and canSend/reason. from must be your configured member name. Refresh before proactive posts; only send to groups you belong to.',
    parameters: z.object(context),
    execute: async ({ teamName, claudeDir, from }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return jsonTextContent(
        await getController(teamName, claudeDir).groupChats.listGroupChats({ from })
      );
    },
  });
  server.addTool({
    name: 'group_chat_send',
    description:
      'Post to the explicit groupChatId. Use a new UUID messageId per logical post; retry an uncertain request with the same ID and unchanged payload. For a reply, relayOfMessageId must be the physical inbound messageId from this group. Proactive posts may omit relayOfMessageId. Archived or unavailable groups reject sends: never fall back to private user DM. Saved partial/unknown delivery must not be reposted under a new ID.',
    parameters: z.object({
      ...context,
      groupChatId: z.string().uuid(),
      messageId: z.string().uuid(),
      text: z.string().min(1),
      summary: z.string().optional(),
      taskRefs: z.array(taskRefSchema).optional(),
      relayOfMessageId: z.string().min(1).optional(),
    }),
    execute: async ({ teamName, claudeDir, ...flags }) => {
      assertConfiguredTeam(teamName, claudeDir);
      try {
        const result = await getController(teamName, claudeDir).groupChats.sendGroupMessage(flags);
        return jsonTextContent({
          ...(result as Record<string, unknown>),
          groupMessageId: flags.messageId,
          ...(flags.relayOfMessageId ? { relayOfMessageId: flags.relayOfMessageId } : {}),
        });
      } catch (error) {
        const detail = error as Error & { code?: string };
        // Keep admission errors machine-readable for runtime outcome routing.
        return jsonTextContent({
          error: { code: detail.code ?? 'GROUP_CHAT_UNAVAILABLE', message: detail.message },
          groupChatId: flags.groupChatId,
          groupMessageId: flags.messageId,
          ...(flags.relayOfMessageId ? { relayOfMessageId: flags.relayOfMessageId } : {}),
          protocolInstruction: 'Group send failed. Do not send this answer as a private message.',
        });
      }
    },
  });
}
