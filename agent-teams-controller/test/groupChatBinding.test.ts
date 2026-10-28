import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlAuthority } from '../src/internal/controlApiAuth';

const require = createRequire(import.meta.url);
const bindingPath = require.resolve('../src/internal/desktopControlBinding.js');
const groupPath = require.resolve('../src/internal/groupChats.js');
const previousUrl = process.env.AGENT_TEAMS_BOUND_CONTROL_URL;
const previousContext = process.env.AGENT_TEAMS_BOUND_CONTEXT_JSON;
const previousToken = process.env.AGENT_TEAMS_BOUND_CONTROL_AUTH_TOKEN;
const previousRoot = process.env.AGENT_TEAMS_MCP_CLAUDE_DIR;
const previousReference = process.env.CLAUDE_TEAM_CONTROL_AUTH_REF;
const previousExternalReference = process.env.CLAUDE_TEAM_CONTROL_EXTERNAL_AUTH_REF;
beforeEach(() => {
  delete process.env.CLAUDE_TEAM_CONTROL_AUTH_REF;
  delete process.env.CLAUDE_TEAM_CONTROL_EXTERNAL_AUTH_REF;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries({
    AGENT_TEAMS_BOUND_CONTROL_URL: previousUrl,
    AGENT_TEAMS_BOUND_CONTEXT_JSON: previousContext,
    AGENT_TEAMS_BOUND_CONTROL_AUTH_TOKEN: previousToken,
    AGENT_TEAMS_MCP_CLAUDE_DIR: previousRoot,
    CLAUDE_TEAM_CONTROL_AUTH_REF: previousReference,
    CLAUDE_TEAM_CONTROL_EXTERNAL_AUTH_REF: previousExternalReference,
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
    const seen: Array<{
      path: string;
      context: string;
      authorization: string;
      body: Record<string, unknown>;
    }> = [];
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
        authorization: String(request.headers.authorization),
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
    process.env.AGENT_TEAMS_BOUND_CONTROL_AUTH_TOKEN = 'sandbox-control-token-0123456789abcdef';
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
      expect(
        seen.every(
          ({ authorization }) => authorization === 'Bearer sandbox-control-token-0123456789abcdef'
        )
      ).toBe(true);
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

async function boundReferenceFixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bound-control-ref-')));
  const received: Array<{ authorization: string; context: string }> = [];
  const server = createServer((request, response) => {
    received.push({
      authorization: String(request.headers.authorization),
      context: String(request.headers['x-agent-teams-app-context']),
    });
    response.setHeader('content-type', 'application/json');
    response.end('[]');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const directory = path.join(root, 'local-http-auth');
  await mkdir(directory, { mode: 0o700 });
  const instanceId = randomUUID();
  const reference = path.join(directory, `api-${instanceId}.ref.json`);
  const appContext = {
    appInstanceId: 'fixture-app',
    dataRootFingerprint: 'fixture-root',
    connectionGeneration: 1,
  };
  async function publish(token: string, overrides: Partial<ControlAuthority> = {}) {
    const authority: ControlAuthority = {
      schemaVersion: 1,
      service: 'api',
      instanceId,
      generation: randomUUID(),
      baseUrl,
      token,
      profileScope: createHash('sha256').update(root).digest('hex'),
      ...overrides,
    };
    const descriptorPath = path.join(
      directory,
      `api-${authority.instanceId}-${authority.generation}.json`
    );
    await writeFile(descriptorPath, JSON.stringify(authority), { mode: 0o600 });
    await writeFile(
      reference,
      JSON.stringify({
        schemaVersion: 1,
        service: 'api',
        profileScope: authority.profileScope,
        instanceId: authority.instanceId,
        generation: authority.generation,
        descriptorPath,
      }),
      { mode: 0o600 }
    );
    return descriptorPath;
  }
  process.env.AGENT_TEAMS_BOUND_CONTROL_URL = baseUrl;
  process.env.AGENT_TEAMS_BOUND_CONTEXT_JSON = JSON.stringify(appContext);
  process.env.AGENT_TEAMS_BOUND_CONTROL_AUTH_TOKEN = 'stale-legacy-fallback-token-0123456789';
  process.env.AGENT_TEAMS_MCP_CLAUDE_DIR = root;
  process.env.CLAUDE_TEAM_CONTROL_AUTH_REF = reference;
  const context = { teamName: 'sandbox', claudeDir: root };
  return {
    root,
    reference,
    baseUrl,
    appContext,
    received,
    publish,
    context,
    api: () =>
      require(groupPath) as { listGroupChats(context: unknown, flags: unknown): Promise<unknown> },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

it('refreshes a bound child bearer from its pinned instance reference after an API restart', async () => {
  const fixture = await boundReferenceFixture();
  const firstToken = 'first-generation-private-token-0123456789';
  const secondToken = 'second-generation-private-token-0123456789';
  try {
    await fixture.publish(firstToken);
    const api = fixture.api();
    await api.listGroupChats(fixture.context, { from: 'alice' });
    await fixture.publish(secondToken);
    // Later hints cannot retarget the already bound child or override its key.
    process.env.CLAUDE_TEAM_CONTROL_AUTH_REF = '/foreign/reference.json';
    process.env.CLAUDE_TEAM_CONTROL_EXTERNAL_AUTH_REF = '/foreign/external.json';
    process.env.AGENT_TEAMS_BOUND_CONTROL_AUTH_TOKEN = 'foreign-env-token-0123456789abcdef';
    await api.listGroupChats(fixture.context, { from: 'alice' });
    expect(fixture.received).toEqual([
      { authorization: `Bearer ${firstToken}`, context: JSON.stringify(fixture.appContext) },
      { authorization: `Bearer ${secondToken}`, context: JSON.stringify(fixture.appContext) },
    ]);
  } finally {
    await fixture.close();
  }
});

it.each(['missing', 'unsafe', 'foreign-profile', 'foreign-instance', 'foreign-endpoint'])(
  'does not send HTTP or fall back to an old bearer after the pinned reference becomes %s',
  async (failure) => {
    const fixture = await boundReferenceFixture();
    try {
      const descriptor = await fixture.publish('valid-private-reference-token-0123456789');
      const api = fixture.api();
      await api.listGroupChats(fixture.context, { from: 'alice' });
      if (failure === 'missing') await rm(fixture.reference);
      if (failure === 'unsafe') await chmod(descriptor, 0o644);
      if (failure === 'foreign-profile')
        await fixture.publish('foreign-profile-token-0123456789abcdef', {
          profileScope: 'foreign',
        });
      if (failure === 'foreign-instance')
        await fixture.publish('foreign-instance-token-0123456789abcdef', {
          instanceId: randomUUID(),
        });
      if (failure === 'foreign-endpoint')
        await fixture.publish('foreign-endpoint-token-0123456789abcdef', {
          baseUrl: 'http://127.0.0.1:1',
        });
      await expect(api.listGroupChats(fixture.context, { from: 'alice' })).rejects.toThrow();
      expect(fixture.received).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  }
);

it('refuses an invalid captured reference before HTTP despite a usable legacy environment bearer', async () => {
  const fixture = await boundReferenceFixture();
  try {
    expect(() => fixture.api()).toThrow('APP_CONTEXT_MISMATCH');
    expect(fixture.received).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});
