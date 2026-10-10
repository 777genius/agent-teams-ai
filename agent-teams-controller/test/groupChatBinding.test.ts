import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const bindingPath = require.resolve('../src/internal/desktopControlBinding.js');
const groupPath = require.resolve('../src/internal/groupChats.js');
const previousUrl = process.env.AGENT_TEAMS_BOUND_CONTROL_URL;
const previousContext = process.env.AGENT_TEAMS_BOUND_CONTEXT_JSON;
const previousRoot = process.env.AGENT_TEAMS_MCP_CLAUDE_DIR;

afterEach(() => {
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
      if (request.url?.endsWith('/send')) {
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
      listGroupChats(context: unknown, flags: unknown): Promise<unknown>;
      sendGroupMessage(context: unknown, flags: unknown): Promise<unknown>;
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
      await expect(api.listGroupChats(context, { from: 'user' })).rejects.toThrow('reserved');
      expect(seen).toHaveLength(3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
