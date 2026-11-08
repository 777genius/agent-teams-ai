import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import http from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  privateDirectory,
  publishApiAuthority,
  replacePrivateJson,
  validatePrivatePath,
  validateProfileRoot,
} from '../../src/features/local-http-auth/main';
import { CopyHandoffStdioClient, copyToolFailed, copyToolJson } from './CopyHandoffStdioClient';

const bootstrap = fileURLToPath(new URL('../dist/copyHandoff.js', import.meta.url));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
interface Context {
  appInstanceId: string;
  dataRootFingerprint: string;
  connectionGeneration: number;
}

/** Only synthetic HTTP drafts exist; the compiled controller cannot fall back to a real root. */
class CopyFixture {
  directory = '';
  root = '';
  profile = '';
  configs = '';
  origin = '';
  reference = '';
  readonly instanceId = randomUUID();
  readonly tokens = [`synthetic-token-${randomUUID()}`, `synthetic-token-${randomUUID()}`];
  token = this.tokens[0];
  context: Context = {
    appInstanceId: randomUUID(),
    dataRootFingerprint: '',
    connectionGeneration: 1,
  };
  readonly teams = new Map<string, Record<string, unknown>>();
  readonly requests: {
    authorized: boolean;
    contextMatched: boolean;
    method: string;
    path: string;
  }[] = [];
  readonly clients: CopyHandoffStdioClient[] = [];
  handlerFailed = false;
  private server: http.Server | undefined;

  async start(): Promise<void> {
    // The guarded Windows policy requires canonical user-profile ancestry. POSIX also validates
    // actual ownership/ACLs; chmod is not treated as proof of Windows privacy.
    this.directory = await realpath(
      await mkdtemp(path.join(await realpath(homedir()), 'TEST-copy-handoff-'))
    );
    await validateProfileRoot(this.directory);
    this.root = path.join(this.directory, 'claude');
    this.profile = path.join(this.directory, 'profile');
    await mkdir(this.root, { mode: 0o700 });
    await mkdir(this.profile, { mode: 0o700 });
    this.configs = path.join(await privateDirectory(this.profile), 'copy-handoffs');
    await mkdir(this.configs, { mode: 0o700 });
    await validatePrivatePath(this.configs, true);
    this.context.dataRootFingerprint = hash(this.root);
    this.server = http.createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        this.handlerFailed = true;
        response.writeHead(500, { 'content-type': 'application/json', connection: 'close' });
        response.end(JSON.stringify({ error: 'SYNTHETIC_FIXTURE_FAILURE' }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string')
      throw new Error('Synthetic listener is unavailable');
    this.origin = `http://127.0.0.1:${address.port}`;
    await this.publish(this.token);
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const authorized = request.headers.authorization === `Bearer ${this.token}`;
    const contextMatched =
      request.headers['x-agent-teams-app-context'] === JSON.stringify(this.context);
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    this.requests.push({
      authorized,
      contextMatched,
      method: request.method ?? '',
      path: pathname,
    });
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify(value));
    };
    if (!authorized) return reply(401, { error: 'SYNTHETIC_AUTH_REQUIRED' });
    if (!contextMatched) return reply(409, { error: 'APP_CONTEXT_MISMATCH' });
    if (request.method === 'GET' && pathname === '/api/app/connection')
      return reply(200, {
        schemaVersion: 1,
        context: this.context,
        profileFingerprint: hash(this.profile),
      });
    if (request.method === 'GET' && pathname.startsWith('/api/teams/'))
      return reply(200, this.teams.get(pathname.slice('/api/teams/'.length)) ?? null);
    if (request.method === 'POST' && pathname === '/api/teams') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (
        body.runtimeSelectionVersion !== 1 ||
        JSON.stringify(body.expectedContext) !== JSON.stringify(this.context) ||
        body.cwd ||
        body.providerId ||
        body.providerBackendId ||
        body.model ||
        !String(body.teamName).startsWith('fixture-')
      )
        throw new Error('Invalid synthetic draft request');
      const saved = { ...body, status: 'draft', runtimeSelection: 'unresolved' };
      this.teams.set(String(body.teamName), saved);
      return reply(200, saved);
    }
    return reply(404, { error: 'SYNTHETIC_ROUTE_NOT_ALLOWED' });
  }

  async publish(token: string): Promise<void> {
    this.reference = await publishApiAuthority(this.root, {
      schemaVersion: 1,
      service: 'api',
      profileScope: hash(this.root),
      instanceId: this.instanceId,
      generation: randomUUID(),
      baseUrl: this.origin,
      token,
    });
    this.token = token;
  }

  async selector(patch: Record<string, unknown> = {}): Promise<string> {
    const file = path.join(this.configs, `${randomUUID()}.json`);
    await replacePrivateJson(
      file,
      {
        schemaVersion: 1,
        context: { ...this.context },
        profileFingerprint: hash(this.profile),
        root: this.root,
        controlUrl: this.origin,
        authReference: this.reference,
        ...patch,
      },
      validatePrivatePath
    );
    return file;
  }

  client(selector: string): CopyHandoffStdioClient {
    const client = new CopyHandoffStdioClient(
      bootstrap,
      selector,
      this.directory,
      this.tokens,
      this.origin
    );
    this.clients.push(client);
    return client;
  }

  async close(): Promise<void> {
    let failed = false;
    for (const client of this.clients) {
      try {
        await client.close();
      } catch {
        failed = true;
      }
    }
    if (this.server)
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
        this.server!.closeAllConnections();
      });
    // Retain the tiny fixture if a child was not joined; never erase live authority beneath it.
    if (failed || this.clients.some((client) => !client.joined))
      throw new Error('Copy handoff child cleanup is incomplete');
    if (this.directory) await rm(this.directory, { recursive: true });
    expect(this.handlerFailed).toBe(false);
    for (const client of this.clients) {
      expect(client.secretObserved).toBe(false);
      expect(client.protocolError).toBe(false);
    }
  }
}

describe('compiled copied-prompt stdio bootstrap', () => {
  let fixture: CopyFixture;
  beforeEach(async () => {
    fixture = new CopyFixture();
    await fixture.start();
  });
  afterEach(async () => {
    await fixture?.close();
  });

  it('discovers only management tools and saves/readbacks drafts through rotated reference auth', async () => {
    const client = fixture.client(await fixture.selector());
    await client.initialize();
    const listed = await client.request('tools/list', {});
    const names = (listed.result as { tools: { name: string }[] }).tools
      .map((tool) => tool.name)
      .sort();
    expect(names).toEqual([
      'app_get_connection_info',
      'team_create',
      'team_get',
      'team_list',
      'team_trash',
      'team_update',
    ]);
    expect(copyToolJson(await client.tool('app_get_connection_info')).context).toEqual(
      fixture.context
    );
    const create = (teamName: string) => ({
      teamName,
      runtimeSelectionVersion: 1,
      expectedContext: { ...fixture.context },
      members: [{ name: 'reviewer', role: 'Review fixture' }],
    });
    copyToolJson(await client.tool('team_create', create('fixture-first')));
    expect(
      copyToolJson(await client.tool('team_get', { teamName: 'fixture-first' }))
    ).toMatchObject({ status: 'draft', runtimeSelection: 'unresolved' });
    await fixture.publish(fixture.tokens[1]);
    copyToolJson(await client.tool('team_create', create('fixture-rotated')));
    expect(
      copyToolJson(await client.tool('team_get', { teamName: 'fixture-rotated' })).teamName
    ).toBe('fixture-rotated');
    expect(fixture.requests.every((request) => request.authorized && request.contextMatched)).toBe(
      true
    );
    expect([...fixture.teams.keys()]).toEqual(['fixture-first', 'fixture-rotated']);
    expect(await client.endInput()).toBe(0);
    expect(client.joined).toBe(true);
  });

  it('keeps a captured epoch immutable and admits a freshly copied selector', async () => {
    const client = fixture.client(await fixture.selector());
    await client.initialize();
    copyToolJson(await client.tool('app_get_connection_info'));
    fixture.context = {
      ...fixture.context,
      connectionGeneration: fixture.context.connectionGeneration + 1,
    };
    expect(copyToolFailed(await client.tool('app_get_connection_info'))).toBe(true);
    const count = fixture.requests.length;
    expect(
      copyToolFailed(
        await client.tool('team_create', {
          teamName: 'fixture-forbidden',
          runtimeSelectionVersion: 1,
          expectedContext: fixture.context,
        })
      )
    ).toBe(true);
    expect(fixture.requests).toHaveLength(count);
    expect(fixture.teams.size).toBe(0);
    expect(await client.endInput()).toBe(0);
    const fresh = fixture.client(await fixture.selector());
    await fresh.initialize();
    expect(copyToolJson(await fresh.tool('app_get_connection_info')).context).toEqual(
      fixture.context
    );
    expect(await fresh.endInput()).toBe(0);
  });

  it.each(['missing', 'foreign-root', 'missing-reference'] as const)(
    'rejects a %s selector before any API request',
    async (kind) => {
      const file =
        kind === 'missing'
          ? path.join(fixture.configs, `${randomUUID()}.json`)
          : await fixture.selector(
              kind === 'foreign-root'
                ? { root: path.join(fixture.root, 'foreign') }
                : {
                    authReference: path.join(
                      fixture.root,
                      'local-http-auth',
                      `api-${randomUUID()}.ref.json`
                    ),
                  }
            );
      const client = fixture.client(file);
      expect(await client.waitForClose()).toBe(1);
      expect(client.stdoutBytes).toBe(0);
      expect(fixture.requests).toHaveLength(0);
    }
  );

  // Windows rejects unsafe effective ACLs through the shared guard, not POSIX chmod bits.
  it.skipIf(process.platform === 'win32')(
    'rejects a broadly readable POSIX config before API access',
    async () => {
      const file = await fixture.selector();
      await chmod(file, 0o644);
      const client = fixture.client(file);
      expect(await client.waitForClose()).toBe(1);
      expect(client.stdoutBytes).toBe(0);
      expect(fixture.requests).toHaveLength(0);
    }
  );

  it('does not fall back to manual discovery or inherited credentials after revocation', async () => {
    const client = fixture.client(await fixture.selector());
    await client.initialize();
    copyToolJson(await client.tool('app_get_connection_info'));
    await rm(fixture.reference);
    const count = fixture.requests.length;
    expect(copyToolFailed(await client.tool('app_get_connection_info'))).toBe(true);
    expect(fixture.requests).toHaveLength(count);
    expect(await client.endInput()).toBe(0);
  });
});
