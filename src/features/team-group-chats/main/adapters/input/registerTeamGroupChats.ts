import { GROUP_CHAT_CHANNELS } from '../../../contracts';
import { GroupChatError } from '../../../core/domain/groupChat';

import type { GroupChatSendRequest } from '../../../contracts';
import type { TeamGroupChatsFeature } from '../../composition/createTeamGroupChatsFeature';
import type { IpcMain } from 'electron';
import type { FastifyInstance } from 'fastify';

function errorPayload(error: unknown) {
  return {
    code: error instanceof GroupChatError ? error.code : 'storage-unavailable',
    message: error instanceof Error ? error.message : String(error),
  };
}
function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GroupChatError('invalid-input', 'Expected group chat request');
  return value as Record<string, unknown>;
}

export function registerTeamGroupChatsIpc(ipcMain: IpcMain, feature: TeamGroupChatsFeature): void {
  for (const method of ['list', 'create', 'setArchived', 'send'] as const) {
    ipcMain.handle(GROUP_CHAT_CHANNELS[method], async (_event, request: unknown) => {
      try {
        const input = objectInput(request);
        // Sender identity never comes from renderer input.
        const result = await (feature[method] as (request: unknown) => Promise<unknown>)(input);
        return { result };
      } catch (error) {
        return { error: errorPayload(error) };
      }
    });
  }
}

export function registerTeamGroupChatsHttp(
  app: FastifyInstance,
  feature: TeamGroupChatsFeature
): void {
  for (const method of ['list', 'create', 'setArchived', 'send'] as const) {
    app.post(`/api/team-group-chats/${method}`, async (request, reply) => {
      try {
        return await (feature[method] as (request: unknown) => Promise<unknown>)(
          objectInput(request.body)
        );
      } catch (error) {
        return reply.code(400).send({ error: errorPayload(error) });
      }
    });
  }
  for (const method of ['list', 'send'] as const) {
    app.post<{ Params: { teamName: string } }>(
      `/api/teams/:teamName/group-chats/${method}`,
      async (request, reply) => {
        try {
          const body = objectInput(request.body);
          if (typeof body.from !== 'string' || !body.from.trim() || body.from === 'user')
            throw new GroupChatError('invalid-input', 'Agent sender required');
          const input = { ...body, teamName: request.params.teamName };
          return method === 'list'
            ? await feature.list(input, body.from)
            : await feature.send(input as unknown as GroupChatSendRequest, body.from);
        } catch (error) {
          return reply.code(400).send({ error: errorPayload(error) });
        }
      }
    );
  }
}
