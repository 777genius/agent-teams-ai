import { ipcRenderer } from 'electron';

import { GROUP_CHAT_CHANNELS } from '../contracts';

import type { TeamGroupChatsAPI } from '../contracts';

export function createTeamGroupChatsBridge(): TeamGroupChatsAPI {
  async function invoke<T>(channel: string, request: unknown): Promise<T> {
    const reply = (await ipcRenderer.invoke(channel, request)) as {
      result?: T;
      error?: { code: string; message: string };
    };
    if (reply.error)
      throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
    return reply.result as T;
  }
  return {
    list: (request) => invoke(GROUP_CHAT_CHANNELS.list, request),
    create: (request) => invoke(GROUP_CHAT_CHANNELS.create, request),
    setArchived: (request) => invoke(GROUP_CHAT_CHANNELS.setArchived, request),
    send: (request) => invoke(GROUP_CHAT_CHANNELS.send, request),
  };
}
