import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const bindingPath = require.resolve('../src/internal/desktopControlBinding.js');
const groupPath = require.resolve('../src/internal/groupChats.js');
const previousUrl = process.env.AGENT_TEAMS_BOUND_CONTROL_URL;
const previousContext = process.env.AGENT_TEAMS_BOUND_CONTEXT_JSON;
const previousRoot = process.env.AGENT_TEAMS_MCP_CLAUDE_DIR;

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries({
    AGENT_TEAMS_BOUND_CONTROL_URL: previousUrl,
    AGENT_TEAMS_BOUND_CONTEXT_JSON: previousContext,
    AGENT_TEAMS_MCP_CLAUDE_DIR: previousRoot,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete require.cache[bindingPath];
  delete require.cache[groupPath];
});

describe('app-bound group chat transport', () => {
  it('refreshes the catalog, carries app identity, and preserves archived admission errors', async () => {
    const deadline = vi.spyOn(AbortSignal, 'timeout');
    const seen: Array<{ path: string; context: string; body: Record<string, unknown> }> = [];
    const appContext = {
      appInstanceId: 'test-app',
      dataRootFingerprint: 'test-root',
      connectionGeneration: 1,
    };
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      seen.push({
        path: request.url ?? '',
        context: String(request.headers['x-agent-teams-app-context']),
        body: JSON.parse(body),
      });
      response.setHeader('content-type', 'application/json');
      if (request.url?.endsWith('/create')) {
        response.statusCode = 400;
        response.end(
          JSON.stringify({
            error: { code: 'invalid-user-request', message: 'Original missing' },
            sourceMessageId: 'original-id',
          })
        );
      } else if (request.url?.endsWith('/react')) {
        response.end(
          JSON.stringify({
            saved: true,
            acknowledged: true,
            groupChatId: 'group',
            messageId: 'canonical',
            relayOfMessageId: 'physical',
            from: 'alice',
            groupRunKey: 'run',
          })
        );
      } else if (request.url?.endsWith('/send')) {
        response.statusCode = 400;
        response.end(
          JSON.stringify({ error: { code: 'GROUP_CHAT_ARCHIVED', message: 'Archived group' } })
        );
      } else
        response.end(JSON.stringify([{ id: 'group', archivedAt: seen.length > 1 ? 'now' : null }]));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    process.env.AGENT_TEAMS_BOUND_CONTROL_URL = `http://127.0.0.1:${address.port}`;
    process.env.AGENT_TEAMS_BOUND_CONTEXT_JSON = JSON.stringify(appContext);
    process.env.AGENT_TEAMS_MCP_CLAUDE_DIR = '/tmp/group-transport-sandbox';
    delete require.cache[bindingPath];
    delete require.cache[groupPath];
    const api = require(groupPath) as {
      createGroupChat(context: unknown, flags: unknown): Promise<unknown>;
      listGroupChats(context: unknown, flags: unknown): Promise<unknown>;
      sendGroupMessage(context: unknown, flags: unknown): Promise<unknown>;
      reactToGroupMessage(context: unknown, flags: unknown): Promise<unknown>;
    };
    const context = { teamName: 'sandbox', claudeDir: '/tmp/group-transport-sandbox' };
    try {
      expect(await api.listGroupChats(context, { from: 'alice' })).toEqual([
        { id: 'group', archivedAt: null },
      ]);
      expect(await api.listGroupChats(context, { from: 'alice' })).toEqual([
        { id: 'group', archivedAt: 'now' },
      ]);
      await expect(
        api.sendGroupMessage(context, {
          from: 'alice',
          groupChatId: 'group',
          messageId: 'post',
          text: 'Hello',
        })
      ).rejects.toMatchObject({ code: 'GROUP_CHAT_ARCHIVED', message: 'Archived group' });
      expect(seen).toHaveLength(3);
      // The client must retain the desktop's full 120-second admission budget.
      expect(deadline.mock.calls.slice(0, 3).map(([ms]) => ms)).toEqual([135000, 135000, 135000]);
      expect(seen[0]).toMatchObject({
        path: '/api/teams/sandbox/group-chats/list',
        context: JSON.stringify(appContext),
        body: { from: 'alice' },
      });
      expect(seen[2].body).toMatchObject({
        from: 'alice',
        groupChatId: 'group',
        messageId: 'post',
        text: 'Hello',
      });
      await expect(api.reactToGroupMessage(context, { from: 'user' })).rejects.toThrow('reserved');
      expect(seen).toHaveLength(3);
      expect(
        await api.reactToGroupMessage(context, {
          from: 'alice',
          groupChatId: 'group',
          relayOfMessageId: 'physical',
          emoji: 'wrong',
        })
      ).toEqual({
        saved: true,
        acknowledged: true,
        groupChatId: 'group',
        messageId: 'canonical',
        relayOfMessageId: 'physical',
        from: 'alice',
        groupRunKey: 'run',
      });
      expect(seen[3]).toMatchObject({
        path: '/api/teams/sandbox/group-chats/react',
        context: JSON.stringify(appContext),
        body: { from: 'alice', groupChatId: 'group', relayOfMessageId: 'physical' },
      });
      expect(seen[3].body).not.toHaveProperty('emoji');
      const creation = {
        from: 'alice',
        sourceMessageId: 'original-id',
        name: 'Release',
        selectedMemberNames: ['alice', 'bob'],
      };
      await expect(api.createGroupChat(context, creation)).rejects.toMatchObject({
        code: 'invalid-user-request',
      });
      expect(seen[4]).toMatchObject({
        path: '/api/teams/sandbox/group-chats/create',
        context: JSON.stringify(appContext),
        body: creation,
      });
      await expect(
        api.createGroupChat({ ...context, claudeDir: '/other-root' }, creation)
      ).rejects.toMatchObject({ code: 'APP_CONTEXT_MISMATCH' });
      await expect(api.createGroupChat(context, { ...creation, from: 'user' })).rejects.toThrow(
        'reserved'
      );
      await expect(
        api.createGroupChat(context, { ...creation, userConfirmed: true })
      ).rejects.toMatchObject({ code: 'invalid-input' });
      expect(seen).toHaveLength(5); // No discovery or fallback request after invalid binding/input.
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
