/** TEST-only OpenCode-shaped API process. No vendor OAuth, models or external network. */
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';

import type { IncomingMessage, ServerResponse } from 'node:http';

const root = process.env.TEST_MANAGEMENT_FIXTURE_ROOT;
assert.ok(root && basename(root).startsWith('TEST-oauth-host-') && realpathSync(root) === root);
for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) {
  const path = process.env[key];
  assert.ok(path && path.startsWith(root + '/') && realpathSync(path) === path);
}
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 4), ['serve', '--hostname', '127.0.0.1', '--port']);
const port = Number(args[4]);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}') as Record<string, unknown>;
const username = process.env.OPENCODE_SERVER_USERNAME,
  password = process.env.OPENCODE_SERVER_PASSWORD;
assert.ok(username && password);
const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
const logPath = join(root, 'native-effects.ndjson');
const authDirectory = join(process.env.XDG_DATA_HOME!, 'opencode');
mkdirSync(authDirectory, { recursive: true, mode: 0o700 });
const authPath = join(authDirectory, 'auth.json');
const events = (value: Record<string, unknown>) =>
  appendFileSync(logPath, JSON.stringify({ ...value, pid: process.pid }) + '\n', { mode: 0o600 });
const credentials = (): Record<string, unknown> =>
  existsSync(authPath)
    ? (JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, unknown>)
    : {};
function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > 64 * 1024) throw new Error('TEST body limit');
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function configuredLimit(providerId: string): Record<string, unknown> | undefined {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const limit = record(
    record(record(record(config.provider)[providerId]).models)['TEST-model']
  ).limit;
  return limit && typeof limit === 'object' && !Array.isArray(limit)
    ? (limit as Record<string, unknown>)
    : undefined;
}
const providers = ['TEST-oauth-code', 'TEST-oauth-auto', 'TEST-api'];
const authorized = new Set<string>();
const sessions = new Set<string>();
let sessionSequence = 0;
const server = createServer((request, response) => {
  void (async () => {
    if (
      request.headers.authorization !== authHeader ||
      request.headers['x-opencode-directory'] !== process.cwd()
    ) {
      json(response, { error: 'TEST unauthorized' }, 401);
      return;
    }
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    if (request.method === 'GET' && url.pathname === '/config') {
      json(response, config);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/provider/auth') {
      json(
        response,
        Object.fromEntries(
          providers.map((id) => [
            id,
            [{ type: id === 'TEST-api' ? 'api' : 'oauth', label: 'TEST authentication' }],
          ])
        )
      );
      return;
    }
    if (request.method === 'GET' && ['/provider', '/config/providers'].includes(url.pathname)) {
      const all = providers.map((id) => ({
        id,
        name: id,
        source: 'config',
        ...(id === 'TEST-api'
          ? { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:19999/v1' } }
          : {}),
        models: {
          'TEST-model': {
            name: 'TEST model',
            limit: configuredLimit(id) ?? { context: 4096, output: 1024 },
          },
          ...(id === 'TEST-api' ? { 'TEST-blocked': { name: 'TEST blocked model' } } : {}),
        },
      }));
      json(
        response,
        url.pathname === '/provider'
          ? { all, default: {}, connected: Object.keys(credentials()) }
          : { providers: all, default: {} }
      );
      return;
    }
    if (request.method === 'GET' && url.pathname === '/experimental/tool/ids') {
      json(response, ['bash', 'edit', 'TEST-mcp-tool']);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/session') {
      const input = await body(request);
      assert.equal(input.title, 'Agent Teams model connection test');
      assert.deepEqual(config.permission, { '*': 'deny' });
      const id = `TEST-probe-${++sessionSequence}`;
      sessions.add(id);
      events({ event: 'probe-session-created' });
      json(response, { id });
      return;
    }
    const probe = /^\/session\/([^/]+)\/message$/.exec(url.pathname);
    if (request.method === 'POST' && probe) {
      const id = probe[1]!;
      assert.ok(sessions.has(id));
      const input = await body(request),
        model = input.model as Record<string, unknown>;
      assert.equal(model.providerID, 'TEST-api');
      assert.ok(model.modelID === 'TEST-model' || model.modelID === 'TEST-blocked');
      assert.deepEqual(input.tools, {
        '*': false,
        bash: false,
        edit: false,
        'TEST-mcp-tool': false,
      });
      events({
        event: 'model-request-start',
        modelId: model.modelID,
        ...(configuredLimit('TEST-api') ? { effectiveLimits: configuredLimit('TEST-api') } : {}),
      });
      if (model.modelID === 'TEST-blocked') {
        while (!existsSync(join(root, 'release-probe')))
          await new Promise<void>((done) => setTimeout(done, 25));
      }
      events({ event: 'model-response', modelId: model.modelID });
      json(response, {
        info: {
          role: 'assistant',
          sessionID: id,
          providerID: 'TEST-api',
          modelID: model.modelID,
          time: { completed: Date.now() },
        },
        parts: [{ type: 'text', text: 'TEST-private-model-response' }],
      });
      return;
    }
    const match = /^\/provider\/([^/]+)\/oauth\/(authorize|callback)$/.exec(url.pathname);
    if (request.method === 'POST' && match) {
      const providerId = decodeURIComponent(match[1]!);
      assert.ok(providers.includes(providerId));
      const input = await body(request);
      assert.equal(input.method, 0);
      if (match[2] === 'authorize') {
        authorized.add(providerId);
        events({ event: 'authorize', providerId });
        json(response, {
          url: `http://127.0.0.1:${port}/TEST-browser?state=TEST-private-state`,
          instructions: 'TEST-private-instructions',
          method: providerId.endsWith('auto') ? 'auto' : 'code',
        });
        return;
      }
      assert.ok(authorized.has(providerId));
      events({ event: 'callback-start', providerId });
      if (providerId.endsWith('code')) assert.equal(input.code, 'TEST-correct-code');
      else {
        assert.equal(input.code, undefined);
        // The harness may release this only after cancellation. A retired process must never write.
        while (!existsSync(join(root, 'release-auto')))
          await new Promise<void>((done) => setTimeout(done, 25));
      }
      const next = credentials();
      next[providerId] = {
        type: 'oauth',
        access: 'TEST-fixture-access',
        refresh: 'TEST-fixture-refresh',
        expires: 9999999999999,
      };
      writeFileSync(authPath, JSON.stringify(next), { mode: 0o600 });
      events({ event: 'credential-written', providerId });
      json(response, true);
      return;
    }
    if (request.method === 'DELETE' && url.pathname.startsWith('/auth/')) {
      const providerId = decodeURIComponent(url.pathname.slice('/auth/'.length));
      const next = credentials();
      delete next[providerId];
      writeFileSync(authPath, JSON.stringify(next), { mode: 0o600 });
      events({ event: 'credential-forgotten', providerId });
      json(response, true);
      return;
    }
    if (request.method === 'PUT' && url.pathname === '/auth/TEST-api') {
      const input = await body(request);
      assert.equal(input.type, 'api');
      assert.equal(input.key, 'TEST-api-key');
      const next = credentials();
      next['TEST-api'] = { type: 'api', key: input.key };
      writeFileSync(authPath, JSON.stringify(next), { mode: 0o600 });
      events({ event: 'credential-written', providerId: 'TEST-api' });
      json(response, true);
      return;
    }
    json(response, { error: 'TEST unknown endpoint' }, 404);
  })().catch(() => {
    if (!response.headersSent) json(response, { error: 'TEST request refused' }, 400);
    else response.end();
  });
});
server.listen(port, '127.0.0.1', () => events({ event: 'launch' }));
