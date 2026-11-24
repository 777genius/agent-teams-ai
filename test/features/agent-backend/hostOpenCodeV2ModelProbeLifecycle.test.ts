// @vitest-environment node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { EventEmitter, once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, test, vi } from 'vitest';

import type { IncomingMessage, ServerResponse } from 'node:http';

const controlled = vi.hoisted(() => ({
  create: (_options: unknown): unknown => { throw new Error('TEST native factory unset'); },
  spawn: vi.fn(() => { throw new Error('TEST unexpected native spawn'); }),
  driverFactory: undefined as ((_options: unknown) => unknown) | undefined,
  observeClient: undefined as ((client: unknown) => void) | undefined,
}));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: controlled.spawn,
}));
vi.mock('../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedServer.js',
  () => ({ createOpenCodeV2EmbeddedServer: (options: unknown) => controlled.create(options) }));
vi.mock('../../../packages/legacy-agent-host/node_modules/@agent-teams/provider-implementations/dist/opencode.js',
  async importOriginal => {
    const original = await importOriginal<typeof import('../../../packages/legacy-agent-host/node_modules/@agent-teams/provider-implementations/dist/opencode.js')>();
    return { ...original,
      createOpenCodeV2OwnedSessionClient: (...args: Parameters<typeof original.createOpenCodeV2OwnedSessionClient>) => {
        const client = original.createOpenCodeV2OwnedSessionClient(...args);
        controlled.observeClient?.(client);
        return client;
      },
      createOpenCodeV2DriverFactory: (options: Parameters<typeof original.createOpenCodeV2DriverFactory>[0]) =>
      controlled.driverFactory ? controlled.driverFactory(options) : original.createOpenCodeV2DriverFactory(options) };
  });

import * as capturedProcess from '../../../packages/legacy-agent-host/src/adapters/providers/CapturedProcess';
import * as probeDiagnostics from '../../../packages/legacy-agent-host/src/adapters/providers/createClaudeCloseDiagnostic';
import * as embeddedGraph from '../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedGraph';
import { createOpenCodeV2ModelProbe } from '../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2ModelProbe';
import { attestOpenCodeV2ModelSelection } from '../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2ModelSelection';
import * as sessionCredential from '../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2SessionCredential';
import * as windowsCustody from '../../../packages/legacy-agent-host/src/adapters/providers/WindowsJobCustody';
import { runtimeMemberProfileSchema } from '../../../packages/legacy-agent-host/src/composition/runtimeProfile';
import { teamModelProbeProfile } from '../../../packages/legacy-agent-host/src/composition/teamLaunchModelProbe';
import { openCodeManagementProfileSchema } from '../../../packages/legacy-agent-host/src/management/profile';
import { opencodeV2ModelProbeProfile } from '../../../packages/legacy-agent-host/tests/fixtures/opencode-v2-model-probe-profile';
import { decodeClaudeCloseDiagnostics } from '../../../src/features/agent-backend/main/infrastructure/decodeClaudeCloseDiagnostics';

import type { OpenCodeV2EmbeddedServerOptions } from '../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedServer';
import type { OpenCodeProbeCloseDiagnostic, OpenCodeProbeDiagnostic } from '../../../src/features/agent-backend/main/infrastructure/decodeClaudeCloseDiagnostics';

afterEach(() => {
  controlled.create = () => { throw new Error('TEST native factory unset'); };
  controlled.driverFactory = undefined;
  controlled.observeClient = undefined;
  expect(controlled.spawn).not.toHaveBeenCalled();
  controlled.spawn.mockClear();
});

async function within<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('TEST original HTTP observation: ' + label)), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

/**
 * Only native process creation/measurement is a controlled TEST precondition.
 * Production ModelProbe, its private configuration, both D clients and global fetch
 * remain real. These checks do not qualify an actual native process or credential.
 */
async function fixture(mode: 'http' | 'custody' | 'stop-unknown' | 'final-cut' | 'open-read-failed' = 'http', startFailure?: unknown,
  isCurrent: () => boolean = () => true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-v2-model-probe-lifecycle-')));
  const pid = 48101, startIdentity = 'TEST-original-start-identity', password = 'TEST-loopback-only';
  const blocked = Promise.withResolvers<void>(), disconnected = Promise.withResolvers<void>();
  const returnCustody = Promise.withResolvers<void>(), custodyReturned = Promise.withResolvers<void>();
  const failures: string[] = [];
  let session: Record<string, unknown> | undefined;
  let sessionId = '', requests = 0, passwordReads = 0, physicalStops = 0, nativeCreations = 0;
  let logReads = 0, promptPosts = 0, holdNextCustody = false, custodyHeld = false;
  let heldSignal: AbortSignal | undefined, stop: Promise<boolean> | undefined;
  let run: Promise<boolean> | undefined;
  const finalGates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
  const finalReturned = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
  const finalHttp = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
  const finalDisconnected = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
  const finalEntered = Promise.withResolvers<void>(), cutFailed = Promise.withResolvers<void>();
  const finalSignals: AbortSignal[] = [], finalRequests: [number, number] = [0, 0];
  const unfinishedClosed: [boolean, boolean] = [false, false];
  const cutFailures: unknown[] = [], driverFailures: unknown[] = [];
  let finalArmed = false, finalCustodyCalls = 0, finalCustodyReturns = 0, messageReads = 0;
  let cutFailureCount = 0, driverFailureCount = 0, nativeInput: { id: string; text: string } | undefined;
  const parent = new AbortController();
  const openEntered = Promise.withResolvers<void>();
  const openResponses = new Map<'session' | 'mcp', ServerResponse>();
  const openCancelled: string[] = [];
  const location = { directory: root };
  const json = (res: ServerResponse, value: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const holdFinalResponse = (index: 0 | 1, res: ServerResponse) => {
    assert.equal(++finalRequests[index], 1, 'each original final GET reaches HTTP at most once');
    res.once('close', () => {
      unfinishedClosed[index] = !res.writableFinished;
      finalDisconnected[index].resolve();
    });
    finalHttp[index].resolve();
  };
  const holdOpenResponse = (kind: 'session' | 'mcp', res: ServerResponse) => {
    assert.equal(openResponses.has(kind), false, 'one original driver-open read per route');
    openResponses.set(kind, res);
    res.once('close', () => { if (!res.writableFinished) openCancelled.push(kind); });
    if (openResponses.size === 2) openEntered.resolve();
  };
  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    assert.ok(++requests <= 64, 'finite original HTTP requests');
    assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('opencode:' + password).toString('base64'));
    const url = new URL(req.url!, 'http://127.0.0.1');
    if (url.searchParams.has('location[directory]'))
      assert.equal(url.searchParams.get('location[directory]'), root);
    if (req.method === 'GET' && url.pathname === '/api/info')
      return json(res, { pid, version: '2.1.4' });
    if (req.method === 'GET' && url.pathname === '/api/provider')
      return json(res, { location, data: [{ id: 'TEST-provider', name: 'TEST provider', activation: 'enabled' }] });
    if (req.method === 'GET' && url.pathname === '/api/model')
      return json(res, { location, data: [{ id: 'TEST-model', providerID: 'TEST-provider', name: 'TEST model',
        enabled: true, limit: { context: 4096, output: 512 },
        capabilities: { tools: false, input: ['text'] }, variants: [{ id: 'high' }] }] });
    if (req.method === 'GET' && url.pathname === '/api/model/default')
      return json(res, { location, data: { providerID: 'TEST-provider', id: 'TEST-model' } });
    if (req.method === 'POST' && url.pathname === '/api/session') {
      assert.equal(session, undefined, 'one original session creation');
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) {
        const value = Buffer.from(chunk); bytes += value.length; assert.ok(bytes <= 65536); chunks.push(value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      assert.equal(typeof body.id, 'string'); assert.match(body.id as string, /^ses_[a-f0-9]{40}$/);
      assert.deepEqual(body.location, location); sessionId = body.id as string;
      session = { ...body, time: { created: 1 } };
      return json(res, { data: session });
    }
    if (req.method === 'GET' && url.pathname === '/api/session/' + sessionId) {
      if (mode === 'open-read-failed') return holdOpenResponse('session', res);
      if (mode === 'final-cut' && finalArmed) return holdFinalResponse(1, res);
      assert.ok(session); return json(res, { data: session });
    }
    if (mode === 'final-cut' && req.method === 'GET' && url.pathname === '/api/session/' + sessionId + '/message') {
      assert.ok(nativeInput); assert.ok(++messageReads <= 2);
      assert.equal(url.searchParams.get('limit'), '200');
      if (messageReads === 1) {
        assert.equal(url.searchParams.get('order'), 'asc'); assert.equal(url.searchParams.get('cursor'), null);
        return json(res, { data: [{ id: nativeInput.id, sessionID: sessionId, type: 'user',
          time: { created: 2 }, payload: { text: nativeInput.text } }],
        cursor: { previous: 'TEST-page-before', next: 'TEST-page-after' } });
      }
      assert.equal(url.searchParams.get('order'), null); assert.equal(url.searchParams.get('cursor'), 'TEST-page-after');
      finalArmed = true;
      return json(res, { data: [], cursor: { previous: null, next: null } });
    }
    if (req.method === 'GET' && url.pathname === '/api/permission/saved')
      return json(res, { data: [] });
    if (mode === 'open-read-failed' && req.method === 'GET' && url.pathname === '/api/mcp')
      return holdOpenResponse('mcp', res);
    if (req.method === 'GET' && (url.pathname === '/api/plugin' || url.pathname === '/api/mcp'))
      return json(res, { location, data: [] });
    if (req.method === 'GET' && url.pathname === '/api/experimental/session/' + sessionId + '/log') {
      assert.ok(session); assert.equal(url.searchParams.get('follow'), 'false');
      ++logReads;
      if (mode === 'final-cut') {
        assert.ok(logReads <= 3, 'original queue, before-log and after-log only');
        if (finalArmed) {
          assert.equal(logReads, 3);
          return holdFinalResponse(0, res);
        }
      } else assert.equal(logReads, 1, 'one original D queue preflight, never a replay');
      if (mode === 'custody' || mode === 'final-cut') {
        // The controlled peer retains the original owned pre-execution prefix.
        if (mode === 'custody') holdNextCustody = true;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const events = [{ id: 'evt_TESTcreated', type: 'session.created',
          durable: { aggregateID: sessionId, seq: 0 }, data: { sessionID: sessionId }, location },
        { type: 'log.synced', aggregateID: sessionId, seq: 0 }];
        res.end(events.map(value => 'data: ' + JSON.stringify(value) + '\n\n').join(''));
      } else {
        // IncomingMessage.close is not an abort witness. This original response is
        // deliberately unfinished and has sent no headers when its socket closes.
        res.once('close', () => {
          if (!res.writableFinished) disconnected.resolve();
        });
        blocked.resolve();
      }
      return;
    }
    if (mode === 'final-cut' && req.method === 'POST' && url.pathname === '/api/session/' + sessionId + '/prompt') {
      assert.equal(++promptPosts, 1, 'one original prompt, never a replay');
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) {
        const value = Buffer.from(chunk); bytes += value.length; assert.ok(bytes <= 65536); chunks.push(value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ['delivery', 'id', 'resume', 'text']);
      assert.equal(typeof body.id, 'string'); assert.match(body.id as string, /^msg_[A-Za-z0-9_-]{1,256}$/);
      assert.equal(body.resume, true); assert.equal(body.delivery, 'queue');
      assert.equal(body.text, 'Reply only OK. Do not use tools, access files or run commands.');
      nativeInput = { id: body.id as string, text: body.text as string };
      return json(res, { data: { id: nativeInput.id, sessionID: sessionId, type: 'user',
        delivery: 'queue', payload: { text: nativeInput.text } } });
    }
    if (req.method === 'POST' && url.pathname.endsWith('/prompt')) promptPosts++;
    throw new Error('TEST unexpected native route: ' + req.method + ' ' + url.pathname);
  };
  const server = createServer((req, res) => {
    void serve(req, res).catch(error => {
      failures.push(error instanceof Error ? error.message : 'TEST native route failed');
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = 'http://127.0.0.1:' + address.port;
  const profile = runtimeMemberProfileSchema.parse({
    provider: 'opencode', nativeGeneration: 'v2', protocolRevision: '2.1.4',
    teamId: 'TEST-team', memberId: 'TEST-member', principalId: 'TEST-principal',
    sessionId: 'TEST-session', generation: 1, configRevision: 'TEST-revision',
    cwd: root, accountBinding: 'TEST-account', model: 'TEST-model',
    executable: { path: join(root, 'TEST-unused-native'), sha256: 'a'.repeat(64) }, endpoint,
    environment: Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
      .map(key => [key, root])),
    embedded: { version: '2.1.4', platform: process.platform, arch: process.arch,
      directory: join(root, 'TEST-unused-engine'), manifestSha256: 'b'.repeat(64), externalDirectory: 'deny' },
    nativeOptions: { providerId: 'TEST-provider', agent: 'build', variant: 'high', toolApprovalMode: 'manual' },
    limits: { queuedInputs: 1, inputBytes: 4096, outputBytes: 8192, outputEvents: 128,
      pendingInteractions: 1, timeoutMs: 30000 },
  });
  const management = openCodeManagementProfileSchema.parse({
    ...teamModelProbeProfile(profile), timeoutMs: 30000, modelProbeTimeoutMs: 30000,
  });
  const identity = { executablePath: management.executable.path, executableSha256: management.executable.sha256,
    pid, startIdentity, version: '2.1.4' as const };
  controlled.create = raw => {
    nativeCreations++;
    const observe = (raw as Pick<OpenCodeV2EmbeddedServerOptions, 'observeStartupPhase'>).observeStartupPhase;
    return {
      start: async () => {
        observe?.('graph-start');
        if (startFailure !== undefined) throw startFailure;
        observe?.('graph-done'); observe?.('native-launch');
        observe?.('native-launch-returned'); observe?.('native-endpoint-resolved');
        return { endpoint, pid, startIdentity };
      },
      readPassword: () => { passwordReads++; return password; },
      async readNativeCustody(signal: AbortSignal) {
        if (mode === 'final-cut' && finalArmed) {
          const index = finalCustodyCalls++;
          assert.ok(index === 0 || index === 1, 'only the two original final custody admissions');
          finalSignals.push(signal);
          if (finalCustodyCalls === 2) finalEntered.resolve();
          await finalGates[index].promise;
          finalCustodyReturns++; finalReturned[index].resolve();
        }
        if (holdNextCustody) {
          holdNextCustody = false; custodyHeld = true; heldSignal = signal; blocked.resolve();
          await returnCustody.promise; custodyReturned.resolve();
        }
        return { ...identity };
      },
      stopOwned() {
        stop ??= Promise.resolve().then(() => { physicalStops++; return mode !== 'stop-unknown'; });
        return stop;
      },
    };
  };
  const observations: unknown[] = [], diagnostic = channel('agent-teams:opencode-v2:host-probe-close-failed');
  const observe = (value: unknown) => { observations.push(value); };
  diagnostic.subscribe(observe);
  const cutDiagnostic = channel('agent-teams:opencode-v2:read-cut-failed');
  const driverDiagnostic = channel('agent-teams:opencode-v2:driver-close-failed');
  const observeCut = (value: unknown) => {
    if (++cutFailureCount <= 2) cutFailures.push(value);
    cutFailed.resolve();
  };
  const observeDriver = (value: unknown) => { if (++driverFailureCount <= 2) driverFailures.push(value); };
  if (mode === 'final-cut') { cutDiagnostic.subscribe(observeCut); driverDiagnostic.subscribe(observeDriver); }
  const probe = createOpenCodeV2ModelProbe(management, {
    commandId: 'TEST-original-probe', profileId: management.profileId, configRevision: management.configRevision,
    providerId: 'TEST-provider', modelId: 'TEST-model',
  }, isCurrent);
  return {
    observations,
    probe, parent, disconnected: disconnected.promise, custodyReturned: custodyReturned.promise,
    releaseCustody: () => returnCustody.resolve(),
    heldSignal: () => heldSignal,
    openRead: {
      entered: openEntered.promise,
      cancelled: openCancelled,
      failSession() {
        const response = openResponses.get('session'); assert.ok(response);
        response.writeHead(500, { 'content-type': 'application/json' }); response.end('{}');
      },
      releaseSibling() { const response = openResponses.get('mcp'); assert.ok(response); json(response, { location, data: [] }); },
    },
    finalCut: {
      entered: finalEntered.promise, http: finalHttp.map(value => value.promise),
      disconnected: finalDisconnected.map(value => value.promise), failed: cutFailed.promise,
      returned: finalReturned.map(value => value.promise), release: (index: 0 | 1) => finalGates[index].resolve(),
      signals: finalSignals, failures: cutFailures, driverFailures,
      counts: () => ({ messageReads, finalCustodyCalls, finalCustodyReturns,
        finalRequests: [...finalRequests], unfinishedClosed: [...unfinishedClosed], cutFailureCount, driverFailureCount }),
    },
    counts: () => ({ requests, passwordReads, physicalStops, nativeCreations, logReads, promptPosts, custodyHeld,
      sessionCreates: session === undefined ? 0 : 1 }),
    start() {
      run = probe.run(parent.signal); void run.catch(() => {});
      return run;
    },
    async barrier() {
      assert.ok(run);
      await within(Promise.race([blocked.promise, run.then(() => {
        throw new Error('TEST probe ended before the original D request barrier');
      })]), 'original D queue preflight');
    },
    assertClosed(expected = { logReads: 1, promptPosts: 0 }) {
      expect(failures).toEqual([]);
      expect(nativeCreations).toBe(1); expect(logReads).toBe(expected.logReads); expect(promptPosts).toBe(expected.promptPosts);
      expect(physicalStops).toBe(1);
      expect(probe.wasRejected()).toBe(false);
    },
    async dispose() {
      const close = probe.close(); returnCustody.resolve();
      for (const gate of finalGates) gate.resolve();
      for (const response of openResponses.values())
        if (!response.destroyed && !response.writableEnded) json(response, { location, data: [] });
      try { await close; if (run) await run.catch(() => {}); }
      finally {
        diagnostic.unsubscribe(observe);
        if (mode === 'final-cut') { cutDiagnostic.unsubscribe(observeCut); driverDiagnostic.unsubscribe(observeDriver); }
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

test('driver-open rejected read retains its real sibling HTTP until settlement before owner cleanup', async () => {
  type OwnerClient = ReturnType<typeof import('../../../packages/legacy-agent-host/node_modules/@agent-teams/provider-implementations/dist/opencode.js').createOpenCodeV2OwnedSessionClient>;
  const failedRead = Promise.withResolvers<unknown>(), siblingReturned = Promise.withResolvers<void>();
  const disposals: number[] = [];
  let owners = 0, siblingSettled = false, runSettled = false;
  controlled.observeClient = raw => {
    const client = raw as OwnerClient, owner = ++owners;
    const dispose = client.dispose.bind(client);
    vi.spyOn(client, 'dispose').mockImplementation(async () => { disposals.push(owner); await dispose(); });
    if (owner !== 2) return;
    const readSession = client.readSession.bind(client), readMcp = client.readMcp.bind(client);
    vi.spyOn(client, 'readSession').mockImplementation(async () => {
      try { return await readSession(); }
      catch (error) { failedRead.resolve(error); throw error; }
    });
    vi.spyOn(client, 'readMcp').mockImplementation(async () => {
      try { return await readMcp(); }
      finally { siblingSettled = true; siblingReturned.resolve(); }
    });
  };
  const f = await fixture('open-read-failed');
  try {
    const running = f.start(); void running.then(() => { runSettled = true; }, () => { runSettled = true; });
    await within(f.openRead.entered, 'original session and MCP HTTP');
    expect(owners).toBe(2); expect(disposals).toEqual([1]);
    f.openRead.failSession();
    await expect(within(failedRead.promise, 'original failed session read')).resolves.toMatchObject({ code: 'invalid_response' });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(disposals, 'owner disposal must not cancel its still-pending sibling').toEqual([1]);
    expect(siblingSettled).toBe(false); expect(runSettled).toBe(false);
    expect(f.openRead.cancelled).toEqual([]); expect(f.counts().physicalStops).toBe(0);
    const before = f.counts();
    f.openRead.releaseSibling(); await within(siblingReturned.promise, 'original MCP body settlement');
    await expect(within(running, 'failed driver-open settlement')).rejects.toThrow('opencode.driver.dependency-unavailable');
    expect(disposals).toEqual([1, 2]); expect(f.openRead.cancelled).toEqual([]);
    await expect(f.probe.close()).resolves.toBe(true);
    expect(f.counts().requests).toBe(before.requests); expect(f.counts().passwordReads).toBe(before.passwordReads);
    f.assertClosed({ logReads: 0, promptPosts: 0 }); expect(f.observations).toEqual([]);
  } finally { await f.dispose(); controlled.observeClient = undefined; }
});

test.each(['close', 'parent-signal'] as const)(
  'original ModelProbe %s aborts admitted driver HTTP before waiting for its lease',
  async origin => {
    const f = await fixture();
    try {
      const running = f.start(); await f.barrier();
      const before = f.counts();
      const closing = origin === 'close' ? f.probe.close() : undefined;
      if (origin === 'parent-signal') f.parent.abort();
      await within(f.disconnected, 'original unfinished response closed');
      await expect(running).resolves.toBe(false);
      await expect(closing ?? f.probe.close()).resolves.toBe(true);
      expect(f.counts().requests).toBe(before.requests);
      expect(f.counts().passwordReads).toBe(before.passwordReads);
      f.assertClosed();
      expect(f.observations).toEqual([]);
    } finally { await f.dispose(); }
  }
);

test('pending original custody stays UNKNOWN after the existing drain bound and late release', async () => {
  const f = await fixture('custody');
  try {
    const running = f.start(); await f.barrier();
    expect(f.counts().custodyHeld).toBe(true);
    const before = f.counts(), closing = f.probe.close();
    expect(f.heldSignal()?.aborted).toBe(true);
    expect(f.probe.close()).toBe(closing);
    // Do not shorten, renew or replace the production five-second acquisition drain.
    await expect(closing).resolves.toBe(false);
    // Original driver close settles submit before this final record; custody is still unreleased.
    expect(f.observations).toEqual([expect.objectContaining({ probeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      runState: 'false', outcome: 'unobserved', errorClass: 'none', stage: 'request-drain', reason: 'unconfirmed' })]);
    const retained = JSON.stringify(f.observations);
    expect(f.counts().requests).toBe(before.requests);
    expect(f.counts().passwordReads).toBe(before.passwordReads);
    f.releaseCustody(); await f.custodyReturned;
    await new Promise<void>(resolve => setImmediate(resolve));
    await expect(running).resolves.toBe(false);
    expect(f.probe.close()).toBe(closing); await expect(f.probe.close()).resolves.toBe(false);
    expect(JSON.stringify(f.observations)).toBe(retained);
    expect(f.counts().requests).toBe(before.requests);
    expect(f.counts().passwordReads).toBe(before.passwordReads);
    f.assertClosed();
  } finally { await f.dispose(); }
});

test.each(['admitted', 'pending', 'abort-responsive'] as const)(
  'original ModelProbe final read-cut cancellation retains the %s sibling cleanup obligation', async sibling => {
    const f = await fixture('final-cut');
    const cleanupExpected = sibling !== 'pending';
    const cooperative = { responses: 0, events: [] as string[], returnedAtFailure: [] as number[] };
    const note = (event: string) => { if (cooperative.events.length < 4) cooperative.events.push(event); };
    const diagnostic = channel('agent-teams:opencode-v2:read-cut-failed');
    let abortSource: AbortSignal | undefined, respond: (() => void) | undefined;
    let observeFailure: (() => void) | undefined, returnedObservation: Promise<void> | undefined;
    try {
      const running = f.start(), cut = f.finalCut;
      await within(cut.entered, 'both original final custody admissions');
      expect(cut.signals).toHaveLength(2); expect(cut.signals.every(signal => !signal.aborted)).toBe(true);
      expect(cut.counts()).toMatchObject({ messageReads: 2, finalCustodyCalls: 2, finalCustodyReturns: 0,
        finalRequests: [0, 0], cutFailureCount: 0, driverFailureCount: 0 });
      cut.release(0); await within(cut.http[0]!, 'original after-log HTTP');
      if (sibling === 'admitted') {
        cut.release(1); await within(cut.http[1]!, 'original after-session HTTP');
      }
      if (sibling === 'abort-responsive') {
        abortSource = cut.signals[1]!;
        respond = () => { cooperative.responses++; note('abort'); cut.release(1); };
        returnedObservation = cut.returned[1]!.then(() => { note('custody-return'); });
        observeFailure = () => {
          if (cooperative.returnedAtFailure.length < 2)
            cooperative.returnedAtFailure.push(cut.counts().finalCustodyReturns);
          note('cut-failure');
        };
        diagnostic.subscribe(observeFailure);
        abortSource.addEventListener('abort', respond, { once: true });
      }
      const before = f.counts();
      expect(before).toMatchObject({ nativeCreations: 1, sessionCreates: 1, promptPosts: 1, logReads: 3 });
      f.parent.abort();
      await within(cut.disconnected[0]!, 'original after-log cancellation');
      if (sibling === 'admitted') await within(cut.disconnected[1]!, 'original after-session cancellation');
      await within(cut.failed, 'original final read-cut failure');
      if (sibling === 'pending') {
        expect(cut.signals[1]!.aborted).toBe(true);
        expect(cut.counts().finalCustodyReturns).toBe(1);
        expect(cut.failures).toEqual([expect.objectContaining({ stage: 'after-log', reason: 'transport_failure',
          deadlineExpired: false, aborted: false, finalReason: 'native_read_cleanup_unknown' })]);
        // Release the same original acquisition only after its UNKNOWN was observed.
        cut.release(1); await within(cut.returned[1]!, 'original pending custody return');
      } else if (sibling === 'abort-responsive') {
        await within(returnedObservation!, 'original abort-responsive custody return');
        expect(cut.signals[1]!.aborted).toBe(true);
        expect(cooperative).toEqual({ responses: 1, events: ['abort', 'custody-return', 'cut-failure'],
          returnedAtFailure: [2] });
        expect(cut.failures).toEqual([expect.objectContaining({ stage: 'after-log', reason: 'transport_failure',
          deadlineExpired: false, aborted: false, finalReason: 'invalid_native_read_response' })]);
      } else {
        expect(cut.failures).toEqual([expect.objectContaining({
          stage: expect.stringMatching(/^after-(log|session)$/), reason: 'transport_failure',
          deadlineExpired: false, aborted: false, finalReason: 'invalid_native_read_response' })]);
      }
      await expect(within(running, 'original probe run settlement')).rejects.toBe(f.parent.signal.reason);
      const closing = f.probe.close();
      expect(f.probe.close()).toBe(closing);
      const cleanup = await closing;
      expect(cleanup).toBe(cleanupExpected);
      expect(f.counts().requests).toBe(before.requests); expect(f.counts().passwordReads).toBe(before.passwordReads);
      expect(cut.counts()).toEqual({ messageReads: 2, finalCustodyCalls: 2, finalCustodyReturns: 2,
        finalRequests: sibling === 'admitted' ? [1, 1] : [1, 0],
        unfinishedClosed: sibling === 'admitted' ? [true, true] : [true, false],
        cutFailureCount: 1, driverFailureCount: cleanupExpected ? 0 : 1 });
      if (sibling === 'pending') {
        expect(cut.driverFailures).toEqual([expect.objectContaining({ stage: 'protocol-dispose', outcome: 'threw' })]);
        expect(f.observations).toEqual([expect.objectContaining({ stage: 'driver-close', reason: 'unconfirmed' })]);
      } else { expect(cut.driverFailures).toEqual([]); expect(f.observations).toEqual([]); }
      const retained = JSON.stringify([cut.failures, cut.driverFailures, f.observations, cooperative]);
      const retainedCounts = f.counts(), retainedCutCounts = cut.counts();
      if (sibling !== 'abort-responsive') cut.release(1);
      await expect(f.probe.close()).resolves.toBe(cleanupExpected);
      expect(JSON.stringify([cut.failures, cut.driverFailures, f.observations, cooperative])).toBe(retained);
      expect(f.counts()).toEqual(retainedCounts); expect(cut.counts()).toEqual(retainedCutCounts);
      f.assertClosed({ logReads: 3, promptPosts: 1 });
      console.info('TEST-final-cut-cancellation ' + JSON.stringify({ sibling, cleanup, counts: f.counts(),
        cut: cut.counts(), readCut: cut.failures, driverClose: cut.driverFailures, hostClose: f.observations,
        ...(sibling === 'abort-responsive' ? { cooperative } : {}) }));
    } finally {
      if (abortSource && respond) abortSource.removeEventListener('abort', respond);
      if (observeFailure) diagnostic.unsubscribe(observeFailure);
      await f.dispose();
    }
  }
);

test('confirmed HTTP cancellation cannot repair an unknown original physical stop', async () => {
  const f = await fixture('stop-unknown');
  try {
    const running = f.start(); await f.barrier();
    const closing = f.probe.close();
    await within(f.disconnected, 'original unfinished response closed');
    await expect(closing).resolves.toBe(false); await expect(running).resolves.toBe(false);
    expect(f.probe.close()).toBe(closing); await expect(f.probe.close()).resolves.toBe(false);
    // D's original confirmStopped call reports unknown before the Host's later explicit stop.
    expect(f.observations).toEqual([expect.objectContaining({ stage: 'driver-close', reason: 'unconfirmed' })]);
    f.assertClosed();
  } finally { await f.dispose(); }
});

test.each(['getter', 'proxy', 'held'] as const)('original probe exception survives %s diagnostic fields', async kind => {
  const secret = 'TEST-private-probe-failure';
  let getterCalls = 0;
  const failure = kind === 'proxy' ? new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error(secret); },
  }) : Object.defineProperties({}, {
    code: kind === 'held' ? { value: 'held' } : { get() { getterCalls++; throw new Error(secret); } },
    message: { get() { getterCalls++; throw new Error(secret); } },
    stack: { get() { getterCalls++; throw new Error(secret); } },
    token: { value: secret },
  });
  const records: OpenCodeProbeCloseDiagnostic[] = [];
  const decode = decodeClaudeCloseDiagnostics(() => {}, undefined, undefined, undefined, undefined,
    value => { records.push(value); });
  const originalFactory = probeDiagnostics.createOpenCodeProbeCloseDiagnostic;
  const diagnostic = vi.spyOn(probeDiagnostics, 'createOpenCodeProbeCloseDiagnostic')
    .mockImplementation((selected, command, digest) => originalFactory(selected, command, digest, line => {
      decode(Buffer.from(line));
      if (kind === 'proxy') throw new Error(secret);
    }));
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture('stop-unknown', failure);
    expect(records, 'construction cannot invent a failed close').toEqual([]);
    await expect(f.start()).rejects.toBe(failure);
    const closing = f.probe.close();
    await expect(closing).resolves.toBe(false);
    expect(f.probe.close()).toBe(closing);
    expect(f.observations).toEqual([expect.objectContaining({ runState: 'threw', outcome: 'unobserved',
      errorClass: kind === 'held' ? 'held' : 'unknown', stage: 'server-stop', reason: 'unconfirmed' })]);
    expect(getterCalls).toBe(0);
    expect(JSON.stringify(f.observations)).not.toContain(secret);
    expect(records).toHaveLength(1);
    const first = records[0]; assert.ok(first);
    const { profileHash, commandHash, ...channelFields } = first;
    expect(profileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(commandHash).toBe(createHash('sha256').update(JSON.stringify('TEST-original-probe')).digest('hex'));
    expect(channelFields, 'stderr retains the same original scalar failure as the existing channel').toEqual(f.observations[0]);
    expect(JSON.stringify(records)).not.toContain(secret);
    await expect(f.probe.close()).resolves.toBe(false);
    expect(records, 'repeated close cannot publish another failure or change UNKNOWN').toHaveLength(1);
    expect(f.counts()).toMatchObject({ requests: 0, nativeCreations: 1, physicalStops: 1 });
  } finally { diagnostic.mockRestore(); await f?.dispose(); }
});

const probePrefix = 'legacy-agent-host: opencode-probe ';
const catalogPhases = ([1, 2, 3] as const).flatMap(index => [
  `catalog-${index}-request-start`, `catalog-${index}-custody-start`, `catalog-${index}-custody-returned`,
  `catalog-${index}-request-admitted`, `catalog-${index}-lease-released`,
]);
const currentnessPhases = ['identity-currentness-summary', 'catalog-1-currentness-summary',
  'catalog-2-currentness-summary', 'catalog-3-currentness-summary'];
function assertCurrentnessSummaries(records: OpenCodeProbeDiagnostic[], expected: string[]) {
  const summaries = records.filter(record => currentnessPhases.includes(record.phase));
  expect(summaries.map(record => record.phase)).toEqual(expected);
  for (const record of summaries) {
    expect(Number.isSafeInteger(record.currentCalls)).toBe(true);
    expect(record.currentCalls).toBeGreaterThan(0); expect(record.currentCalls).toBeLessThanOrEqual(1_000_000);
    expect(Number.isSafeInteger(record.currentElapsedMs)).toBe(true);
    expect(record.currentElapsedMs).toBeGreaterThanOrEqual(0);
    expect(record.currentElapsedMs).toBeLessThanOrEqual(3_600_000);
    expect(record.sequence).toBe(records[records.indexOf(record) - 1]!.sequence);
  }
}
const phases = ['run', 'graph-start', 'graph-done', 'native-launch', 'native-launch-returned', 'native-endpoint-resolved', 'native-ready',
  'identity-start', 'identity-request-start', 'identity-custody-start', 'identity-custody-returned', 'identity-request-admitted',
  'credential', 'credential-returned', 'attestation', ...catalogPhases, 'catalog-read-returned', 'catalog-current-returned',
  'attestation-returned', 'attestation-observe-returned', 'session-create', 'session-current-returned', 'session-create-returned',
  'driver-open', 'driver-open-returned', 'first-submit', 'first-submit-current-returned'];

test.each(['complete', 'custody', 'mismatch', 'http'] as const)(
  'catalog admissions retain original calls, errors and release with %s in memory', async fault => {
    let baseline: unknown;
    const originalDiagnostic = probeDiagnostics.createOpenCodeProbeDiagnostic;
    const originalCredential = sessionCredential.captureOpenCodeV2SessionCredential;
    for (const sink of ['absent', 'healthy', 'throws'] as const) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-catalog-admission-')));
      const management = openCodeManagementProfileSchema.parse(
        teamModelProbeProfile(runtimeMemberProfileSchema.parse(opencodeV2ModelProbeProfile(root))));
      const controller = new AbortController(), failure = new Error('TEST original catalog failure');
      const records: OpenCodeProbeDiagnostic[] = [], routes: string[] = [];
      const windowStarts = new Map<string, number>(), originalCalls = new Map<string, number>();
      let guards = 0, custody = 0, passwordReads = 0, stops = 0, providers = 0;
      let admission: Parameters<ReturnType<typeof originalCredential>['prepare']>[0]['beforeRequest'];
      const diagnostic = vi.spyOn(probeDiagnostics, 'createOpenCodeProbeDiagnostic')
        .mockImplementation((selected, command, digest) => sink === 'absent' ? () => {}
          : originalDiagnostic(selected, command, digest, line => {
            const record = JSON.parse(line.slice(probePrefix.length)) as OpenCodeProbeDiagnostic;
            records.push(record);
            if (/^(identity|catalog-[123])-request-start$/.test(record.phase))
              windowStarts.set(record.phase.replace('request-start', 'currentness-summary'), guards);
            if (currentnessPhases.includes(record.phase))
              originalCalls.set(record.phase, guards - windowStarts.get(record.phase)!);
            if (sink === 'throws') throw new Error('TEST diagnostic sink failure');
          }));
      const credential = vi.spyOn(sessionCredential, 'captureOpenCodeV2SessionCredential').mockImplementation((...args) => {
        const original = originalCredential(...args);
        return { ...original, prepare(wire, ...rest) { admission = wire.beforeRequest; return original.prepare(wire, ...rest); } };
      });
      const identity = { pid: 48101, startIdentity: 'TEST-original-root', version: '2.1.4' };
      controlled.create = () => ({
        start: async () => ({ ...identity, endpoint: management.endpoint }),
        readPassword: () => { passwordReads++; return 'TEST-private-password'; },
        readNativeCustody: async () => {
          custody++;
          if (custody === 3 && fault === 'custody') throw failure;
          return { ...identity, pid: custody === 3 && fault === 'mismatch' ? 48102 : identity.pid };
        },
        stopOwned: async () => { stops++; return true; },
      });
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async request => {
        const path = new URL(request instanceof Request ? request.url : String(request)).pathname;
        expect(['/api/info', '/api/provider', '/api/model', '/api/model/default']).toContain(path);
        routes.push(path); expect(routes.length).toBeLessThanOrEqual(7);
        if (path === '/api/model' && fault === 'http') throw failure;
        const location = { directory: root };
        const value = path === '/api/info' ? { pid: identity.pid, version: identity.version }
          : path === '/api/provider' ? { location, data: ++providers === 1 && fault === 'complete' ? []
            : [{ id: 'TEST-provider', name: 'TEST provider', activation: 'enabled' }] }
            : path === '/api/model' ? { location, data: [{ id: 'TEST-model', providerID: 'TEST-provider', name: 'TEST model',
              enabled: true, limit: { context: 4096, output: 512 },
              capabilities: { tools: false, input: ['text'] }, variants: [{ id: 'high' }] }] }
              : { location, data: { providerID: 'TEST-provider', id: 'TEST-model' } };
        return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
      });
      const probe = createOpenCodeV2ModelProbe(management, { commandId: 'TEST-catalog', profileId: management.profileId,
        configRevision: management.configRevision, providerId: 'TEST-provider', modelId: 'TEST-model' },
      () => { guards++; return true; }, { readiness: { observeProvider: () => { throw failure; } } });
      try {
        const running = probe.run(controller.signal, Date.now() + 30000);
        if (fault === 'complete') await expect(running).rejects.toBe(failure);
        else await expect(running).rejects.toMatchObject({ code: 'transport_failure' });
        const before = { guards, custody, passwordReads, routes: [...routes] };
        baseline ??= before; expect(before).toEqual(baseline);
        const observed = records.map(record => record.phase).filter(phase => catalogPhases.includes(phase));
        const second = fault === 'custody' ? [0, 1, 4] : fault === 'mismatch' ? [0, 1, 2, 4] : [0, 1, 2, 3, 4];
        expect(observed).toEqual(sink === 'absent' ? [] : fault === 'complete' ? catalogPhases
          : fault === 'http' ? catalogPhases.slice(0, 5)
            : [...catalogPhases.slice(0, 5), ...second.map(index => catalogPhases[5 + index])]);
        assertCurrentnessSummaries(records, sink === 'absent' ? [] : fault === 'complete'
          ? currentnessPhases : currentnessPhases.slice(0, fault === 'http' ? 2 : 3));
        for (const record of records.filter(record => currentnessPhases.includes(record.phase)))
          expect(record.currentCalls).toBe(originalCalls.get(record.phase));
        expect(records.map(record => record.phase).filter(phase =>
          ['catalog-read-returned', 'catalog-current-returned', 'catalog-repeat'].includes(phase)))
          .toEqual(sink !== 'absent' && fault === 'complete'
            ? ['catalog-read-returned', 'catalog-current-returned', 'catalog-repeat'] : []);
        expect(routes).toEqual(fault === 'complete'
          ? ['/api/info', '/api/model', '/api/provider', '/api/model/default',
            '/api/model', '/api/provider', '/api/model/default']
          : ['/api/info', '/api/model']);
        const phaseCount = records.length, release = await admission!(controller.signal);
        assert.ok(typeof release === 'function'); release(); release();
        expect(records).toHaveLength(phaseCount); // finally disables catalog marks, even after failure.
        await expect(probe.close()).resolves.toBe(true);
        await expect(probe.close()).resolves.toBe(true); expect(stops).toBe(1);
      } finally {
        await probe.close(); fetch.mockRestore(); credential.mockRestore(); diagnostic.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
);

test.each(['connected', 'directory', 'catalog-failed', 'directory-failed', 'connect-failed'] as const)(
  'credential timing preserves original request order and closes every started window for %s', async mode => {
    const originalDiagnostic = probeDiagnostics.createOpenCodeProbeDiagnostic;
    const originalCredential = sessionCredential.captureOpenCodeV2SessionCredential;
    const credentialWindows = ['credential-catalog', 'credential-directory', 'credential-connect'];
    let baseline: unknown;
    for (const sink of ['absent', 'healthy', 'throws'] as const) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-credential-currentness-')));
      const management = openCodeManagementProfileSchema.parse(
        teamModelProbeProfile(runtimeMemberProfileSchema.parse(opencodeV2ModelProbeProfile(root))));
      const authDirectory = join(root, 'opencode'), authFile = join(authDirectory, 'auth.json');
      mkdirSync(authDirectory, { mode: 0o700 });
      const authBytes = JSON.stringify({ 'TEST-provider': { type: 'api', key: 'TEST-private-key' } });
      writeFileSync(authFile, authBytes, { mode: 0o600 });
      const records: OpenCodeProbeDiagnostic[] = [], routes: string[] = [];
      const starts = new Map<string, number>(), callsAtSummary = new Map<string, number>();
      let guards = 0, custody = 0, passwordReads = 0, stops = 0, connected = false;
      const failure = new Error('TEST original operation failure'), attested = new Error('TEST stop after original attestation');
      const parent = new AbortController();
      let admission: Parameters<ReturnType<typeof originalCredential>['prepare']>[0]['beforeRequest'];
      const diagnostic = vi.spyOn(probeDiagnostics, 'createOpenCodeProbeDiagnostic')
        .mockImplementation((selected, command, digest) => sink === 'absent' ? () => {}
          : originalDiagnostic(selected, command, digest, line => {
            const record = JSON.parse(line.slice(probePrefix.length)) as OpenCodeProbeDiagnostic;
            records.push(record);
            for (const window of credentialWindows) {
              if (record.phase === window + '-start') starts.set(window, guards);
              if (record.phase === window + '-currentness-summary')
                callsAtSummary.set(window, guards - starts.get(window)!);
            }
            if (sink === 'throws') throw new Error('TEST diagnostic write failed');
          }));
      const credential = vi.spyOn(sessionCredential, 'captureOpenCodeV2SessionCredential').mockImplementation((...args) => {
        const original = originalCredential(...args);
        return { ...original, prepare(wire, ...rest) { admission = wire.beforeRequest; return original.prepare(wire, ...rest); } };
      });
      const identity = { pid: 48101, startIdentity: 'TEST-original-root', version: '2.1.4' };
      controlled.create = () => ({
        start: async () => ({ ...identity, endpoint: management.endpoint }),
        readPassword: () => { passwordReads++; return 'TEST-private-password'; },
        readNativeCustody: async () => { custody++; return { ...identity }; },
        stopOwned: async () => { stops++; return true; },
      });
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async request => {
        const native = request instanceof Request ? request : new Request(String(request));
        const path = new URL(native.url).pathname;
        routes.push(native.method + ' ' + path); expect(routes.length).toBeLessThanOrEqual(14);
        if (mode === 'catalog-failed' && path === '/api/model'
            || mode === 'directory-failed' && path === '/api/integration'
            || mode === 'connect-failed' && native.method === 'POST') throw failure;
        if (native.method === 'POST') {
          expect(path).toBe('/api/integration/TEST-provider/connect/key');
          expect(connected).toBe(false); expect(await native.json()).toEqual({ key: 'TEST-private-key' });
          connected = true; return new Response(null, { status: 204 });
        }
        const location = { directory: root };
        const integration = { id: 'TEST-provider', name: 'TEST integration', methods: [{ type: 'key' }],
          connections: connected ? [{ type: 'credential', method: 'key', id: 'cred_TEST' }] : [] };
        const data: Record<string, unknown> = {
          '/api/provider': [{ id: 'TEST-provider', name: 'TEST provider', activation: 'enabled',
            ...(mode === 'connected' ? { integrationID: 'TEST-provider' } : {}) }],
          '/api/model': [{ id: 'TEST-model', providerID: 'TEST-provider', name: 'TEST model',
            enabled: true, limit: { context: 4096, output: 512 },
            capabilities: { tools: false, input: ['text'] }, variants: [{ id: 'high' }] }],
          '/api/model/default': { providerID: 'TEST-provider', id: 'TEST-model' },
          '/api/integration': [integration], '/api/integration/TEST-provider': integration,
        };
        expect(path === '/api/info' || Object.hasOwn(data, path)).toBe(true);
        return new Response(JSON.stringify(path === '/api/info'
          ? { pid: identity.pid, version: identity.version } : { location, data: data[path] }),
        { headers: { 'content-type': 'application/json' } });
      });
      const probe = createOpenCodeV2ModelProbe(management, { commandId: 'TEST-credential-timing',
        profileId: management.profileId, configRevision: management.configRevision,
        providerId: 'TEST-provider', modelId: 'TEST-model' }, () => { guards++; return true; },
      { readiness: { observeProvider: () => { throw attested; } } });
      try {
        const running = probe.run(parent.signal, Date.now() + 30000);
        expect(probe.run(parent.signal)).toBe(running);
        if (mode === 'connected' || mode === 'directory') await expect(running).rejects.toBe(attested);
        else await expect(running).rejects.toMatchObject({ code: mode === 'connect-failed'
          ? 'native_credential_request_failed' : 'transport_failure' });
        const before = { guards, custody, passwordReads, connected, routes: [...routes] };
        baseline ??= before; expect(before).toEqual(baseline);
        const expected = mode === 'connected' ? [credentialWindows[0], credentialWindows[2]]
          : mode === 'catalog-failed' ? credentialWindows.slice(0, 1)
            : mode === 'directory-failed' ? credentialWindows.slice(0, 2) : credentialWindows;
        const summaries = records.filter(record => credentialWindows.some(window => record.phase === window + '-currentness-summary'));
        expect(summaries.map(record => record.phase)).toEqual(sink === 'absent' ? [] : expected.map(window => window + '-currentness-summary'));
        expect(summaries.length).toBeLessThanOrEqual(3);
        for (const summary of summaries) {
          const window = summary.phase.replace('-currentness-summary', '');
          expect(summary.currentCalls).toBe(callsAtSummary.get(window));
          expect(summary.currentCalls).toBeGreaterThan(0);
          expect(Number.isSafeInteger(summary.currentElapsedMs)).toBe(true);
          expect(summary.currentElapsedMs).toBeGreaterThanOrEqual(0);
          expect(summary.sequence).toBe(records[records.indexOf(summary) - 1]!.sequence);
          expect(Object.keys(summary).sort()).toEqual(['commandHash', 'currentCalls', 'currentElapsedMs',
            'elapsedMs', 'phase', 'probeDigest', 'profileHash', 'sequence']);
        }
        const count = records.length, release = await admission!(parent.signal);
        assert.ok(typeof release === 'function'); release(); release();
        expect(records, 'failed and successful credential windows close before later work').toHaveLength(count);
        expect(JSON.stringify(records)).not.toContain('TEST-private');
        expect(readFileSync(authFile, 'utf8')).toBe(authBytes);
        await expect(probe.close()).resolves.toBe(true); expect(stops).toBe(1);
        expect(records, 'cleanup cannot reopen a credential summary').toHaveLength(count);
      } finally {
        await probe.close(); fetch.mockRestore(); credential.mockRestore(); diagnostic.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
);

test.each(['complete', 'read-failed', 'current-lost'] as const)(
  'catalog loop observations preserve original reads and failure for %s', async fault => {
    let baseline: unknown;
    for (const sink of ['absent', 'healthy', 'throws'] as const) {
      const selection = { providerID: 'TEST-provider', id: 'TEST-model' }, phases: string[] = [];
      const failure = Error('TEST original catalog failure');
      let reads = 0, checks = 0, current = true;
      const result = attestOpenCodeV2ModelSelection({ readCatalog: async () => {
        reads++;
        if (fault === 'read-failed') throw failure;
        if (fault === 'current-lost') current = false;
        return { provider: { id: selection.providerID, activation: 'enabled' },
          defaultModel: { providerId: selection.providerID, modelId: selection.id },
          models: reads < 3 ? [] : [{ id: selection.id, enabled: true, variants: [] }] };
      } }, selection, { signal: new AbortController().signal, deadline: Date.now() + 5000,
        isCurrent: () => { checks++; return current; } }, sink === 'absent' ? undefined : phase => {
        phases.push(phase); if (sink === 'throws') throw Error('TEST diagnostic failure');
      });
      if (fault === 'complete') await expect(result).resolves.toBeUndefined();
      else if (fault === 'read-failed') await expect(result).rejects.toBe(failure);
      else await expect(result).rejects.toMatchObject({ code: 'held' });
      baseline ??= { reads, checks }; expect({ reads, checks }).toEqual(baseline);
      expect(phases).toEqual(sink === 'absent' || fault === 'read-failed' ? [] : fault === 'current-lost'
        ? ['catalog-read-returned'] : ['catalog-read-returned', 'catalog-current-returned', 'catalog-repeat']);
      expect(reads).toBe(fault === 'complete' ? 3 : 1);
    }
  }
);

test.each(['first-pass', 'absent-provider', 'absent-model', 'both-absent', 'hard-invalid'] as const)(
  'catalog repeat preserves the first missing selection pair for %s', async shape => {
    let baseline: unknown;
    for (const sink of ['absent', 'healthy', 'throws'] as const) {
      const selection = { providerID: 'TEST-provider', id: 'TEST-model' };
      const observations: { phase: string; detail?: unknown }[] = [];
      let reads = 0, checks = 0;
      const result = attestOpenCodeV2ModelSelection({ readCatalog: async () => {
        reads++;
        const first = reads === 1;
        return {
          provider: first && (shape === 'absent-provider' || shape === 'both-absent') ? null
            : { id: selection.providerID, activation: shape === 'hard-invalid' ? 'disabled' : 'enabled' },
          defaultModel: { providerId: selection.providerID, modelId: selection.id },
          models: first && (shape === 'absent-model' || shape === 'both-absent') ? []
            : [{ id: selection.id, enabled: true, variants: [] }],
        };
      } }, selection, { signal: new AbortController().signal, deadline: Date.now() + 5000,
        isCurrent: () => { checks++; return true; } }, sink === 'absent' ? undefined : (phase, detail?: unknown) => {
        observations.push({ phase, ...(detail === undefined ? {} : { detail }) });
        if (sink === 'throws') throw Error('TEST diagnostic failure');
      });
      if (shape === 'hard-invalid') await expect(result).rejects.toMatchObject({ code: 'invalid' });
      else await expect(result).resolves.toBeUndefined();
      baseline ??= { reads, checks }; expect({ reads, checks }).toEqual(baseline);
      const repeats = shape !== 'first-pass' && shape !== 'hard-invalid';
      expect({ reads, checks }).toEqual(repeats ? { reads: 2, checks: 4 } : { reads: 1, checks: 2 });
      expect(observations.filter(row => row.phase === 'catalog-repeat')).toEqual(sink === 'absent' || !repeats ? [] : [{
        phase: 'catalog-repeat', detail: {
          catalogProviderPresent: shape === 'absent-model', catalogModelPresent: shape === 'absent-provider',
        },
      }]);
      expect(observations.filter(row => row.phase !== 'catalog-repeat').every(row => row.detail === undefined)).toBe(true);
    }
  }
);

test.each(['accessor', 'proxy'] as const)(
  'catalog repeat projection adds no reads or reflection through a %s catalog', async shape => {
    let baseline: string[] | undefined;
    for (const sink of ['absent', 'healthy', 'throws'] as const) {
      const selection = { providerID: 'TEST-provider', id: 'TEST-model' }, trace: string[] = [];
      const complete = { provider: { id: selection.providerID, activation: 'enabled' },
        defaultModel: { providerId: selection.providerID, modelId: selection.id },
        models: [{ id: selection.id, enabled: true, variants: [] }] };
      const missing = { ...complete, provider: null };
      const catalog = shape === 'accessor' ? Object.defineProperty(missing, 'provider', {
        get() { trace.push('provider getter'); return null; },
      }) : new Proxy(missing, {
        get(target, key, receiver) { trace.push('get ' + String(key)); return Reflect.get(target, key, receiver); },
        getOwnPropertyDescriptor() { trace.push('forbidden descriptor'); throw Error('TEST diagnostic reflection'); },
        ownKeys() { trace.push('forbidden keys'); throw Error('TEST diagnostic reflection'); },
      });
      let reads = 0;
      const observations: { phase: string; detail?: unknown }[] = [];
      await expect(attestOpenCodeV2ModelSelection({ readCatalog: async () => ++reads === 1 ? catalog : complete },
        selection, { signal: new AbortController().signal, deadline: Date.now() + 5000,
          isCurrent: () => { trace.push('current'); return true; } }, sink === 'absent' ? undefined : (phase, detail?: unknown) => {
          observations.push({ phase, ...(detail === undefined ? {} : { detail }) });
          if (sink === 'throws') throw Error('TEST diagnostic failure');
        })).resolves.toBeUndefined();
      baseline ??= trace; expect(trace).toEqual(baseline);
      expect(trace.some(value => value.startsWith('forbidden'))).toBe(false);
      expect(observations.filter(row => row.phase === 'catalog-repeat')).toEqual(sink === 'absent' ? [] : [{ phase: 'catalog-repeat' }]);
      expect(reads).toBe(2);
    }
  }
);

test('phase sink failure preserves the original probe HTTP, single run and physical cleanup', async () => {
  const originalFactory = probeDiagnostics.createOpenCodeProbeDiagnostic;
  let baseline: ReturnType<Awaited<ReturnType<typeof fixture>>['counts']> | undefined;
  for (const brokenSink of [false, true]) {
    const records: OpenCodeProbeDiagnostic[] = [];
    const diagnostic = vi.spyOn(probeDiagnostics, 'createOpenCodeProbeDiagnostic')
      .mockImplementation((selected, command, digest) => originalFactory(selected, command, digest, line => {
        records.push(JSON.parse(line.slice(probePrefix.length)) as OpenCodeProbeDiagnostic);
        if (brokenSink) throw new Error('TEST diagnostic sink failure');
      }));
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      f = await fixture();
      expect(records, 'constructing a probe does not start its clock or observe a run').toEqual([]);
      const running = f.start();
      expect(f.probe.run(f.parent.signal)).toBe(running);
      await f.barrier();
      const before = f.counts();
      baseline ??= before;
      expect(before).toEqual(baseline);
      expect(before).toMatchObject({ nativeCreations: 1, sessionCreates: 1, logReads: 1, promptPosts: 0 });
      const originals = records.filter(record => !currentnessPhases.includes(record.phase));
      expect(originals.map(record => record.phase)).toEqual(phases);
      expect(originals.map(record => record.sequence)).toEqual(phases.map((_phase, index) => index + 1));
      expect(records.map(record => record.phase)).toEqual(phases.flatMap(phase =>
        /^(identity|catalog-[123])-request-admitted$/.test(phase)
          ? [phase, phase.replace('request-admitted', 'currentness-summary')] : [phase]));
      assertCurrentnessSummaries(records, currentnessPhases);
      expect(records.every(record => record.probeDigest === records[0]!.probeDigest)).toBe(true);
      expect(records.every(record => /^[a-f0-9]{64}$/.test(record.probeDigest))).toBe(true);
      // first-submit only observes entry: the original D queue still blocks the native prompt POST.
      f.parent.abort();
      await within(f.disconnected, 'original response after phase observation');
      await expect(running).resolves.toBe(false);
      await expect(f.probe.close()).resolves.toBe(true);
      expect(f.counts().requests).toBe(before.requests);
      expect(f.counts().passwordReads).toBe(before.passwordReads);
      expect(records).toHaveLength(phases.length + currentnessPhases.length + 1);
      expect(records.at(-1)).toMatchObject({ phase: 'first-submit-returned', submitStatus: 'refused' });
      f.assertClosed(); expect(f.observations).toEqual([]);
    } finally { diagnostic.mockRestore(); await f?.dispose(); }
  }
});

test.each(['native-ready', 'attestation-returned', 'session-create', 'first-submit'] as const)(
  'the original guard after %s still refuses ownership lost during observation', async boundary => {
    const originalFactory = probeDiagnostics.createOpenCodeProbeDiagnostic;
    const observed: string[] = [];
    let current = true;
    const diagnostic = vi.spyOn(probeDiagnostics, 'createOpenCodeProbeDiagnostic')
      .mockImplementation((selected, command, digest) => originalFactory(selected, command, digest, line => {
        const record = JSON.parse(line.slice(probePrefix.length)) as OpenCodeProbeDiagnostic;
        observed.push(record.phase);
        if (record.phase === boundary) {
          current = false;
          throw new Error('TEST diagnostic failure after owner revocation');
        }
      }));
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      f = await fixture('http', undefined, () => current);
      const running = f.start();
      await expect(boundary === 'attestation-returned' ? f.barrier() : running).rejects.toMatchObject({ code: 'held' });
      expect(observed.at(-1)).toBe(boundary === 'attestation-returned' ? 'session-create' : boundary);
      expect(f.counts()).toMatchObject({ nativeCreations: 1, logReads: 0, promptPosts: 0,
        sessionCreates: boundary === 'first-submit' ? 1 : 0 });
      if (boundary === 'native-ready') expect(f.counts().requests).toBe(0);
      const before = f.counts();
      await expect(f.probe.close()).resolves.toBe(true);
      expect(f.counts().physicalStops).toBe(1);
      expect(f.counts().requests).toBe(before.requests);
      expect(f.probe.wasRejected()).toBe(false);
    } finally { diagnostic.mockRestore(); await f?.dispose(); }
  }
);

type StartupPhase = Parameters<NonNullable<OpenCodeV2EmbeddedServerOptions['observeStartupPhase']>>[0];

/** Actual server/abort/endpoint parsing; any returned child is a finite in-memory TEST stream. */
async function embeddedBoundary(
  observer: 'absent' | 'throw' | 'getter' | 'captured', graphFailure: boolean,
  abortAt?: StartupPhase | 'timer' | 'lifecycle'
) {
  const entry = fileURLToPath(new URL('../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedChild.ts', import.meta.url));
  expect(await realpath(entry), 'the original source child entry must already have its native canonical spelling').toBe(entry);
  // Match the real server's native directory admission, including Windows aliases.
  const root = await realpath(mkdtempSync(join(tmpdir(), 'TEST-v2-probe-phase-boundary-')));
  const executable = join(root, 'TEST-never-executed'), bytes = Buffer.from('TEST inert source only\n');
  writeFileSync(executable, bytes, { mode: 0o600 });
  const originalFailure = new Error('TEST original graph failure');
  const diagnosticFailure = new Error('TEST diagnostic failure');
  const originalAbort = new Error('TEST original startup abort');
  const controller = new AbortController(), observed: StartupPhase[] = [];
  let graphReads = 0, allocationChecks = 0, custodyCalls = 0, getterReads = 0;
  const graphEntered = Promise.withResolvers<void>();
  let cancelledGraphReason: unknown, launchCalls = 0, stopCalls = 0, inputWrites = 0;
  const returnedChild = abortAt === 'native-launch-returned' || abortAt === 'native-endpoint-resolved';
  const child = Object.assign(new EventEmitter(), { pid: 48101, stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), exitCode: null, signalCode: null, killed: false,
    kill() { assert.fail('TEST stream is not native process or termination authority'); } });
  child.stdin.on('data', (bytes: Buffer) => {
    expect(++inputWrites).toBe(1);
    const input = JSON.parse(bytes.toString('utf8')) as { nonce: string };
    child.stdout.write(JSON.stringify({ type: 'ready', nonce: input.nonce, pid: child.pid,
      version: '2.1.4', endpoint: 'http://127.0.0.1:48102' }) + '\n');
  });
  const OriginalProcess = capturedProcess.CapturedProcess;
  const custody = returnedChild ? vi.spyOn(capturedProcess, 'CapturedProcess').mockImplementation(function (...args) {
    return Object.assign(new OriginalProcess(...args), {
      launch: () => { launchCalls++; return child; },
      confirmStopped: async () => { stopCalls++; return true; },
    });
  }) : undefined;
  const cancelGraph = async (signal?: AbortSignal) => {
    if (abortAt !== 'timer' && abortAt !== 'lifecycle') return;
    assert.ok(signal); graphEntered.resolve();
    await new Promise<void>((_resolve, reject) => {
      const fail = () => { cancelledGraphReason = signal.reason; reject(signal.reason); };
      if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
    });
  };
  const graph = vi.spyOn(embeddedGraph, 'verifyOpenCodeV2EmbeddedGraph').mockImplementation(async (_embedded, signal) => {
    graphReads++;
    if (graphFailure) throw originalFailure;
    await cancelGraph(signal);
    return { modulePath: executable, effectPath: executable, requiredBunVersion: 'TEST-unused' };
  });
  const windows = vi.spyOn(windowsCustody, 'createWindowsJobCustody').mockImplementation(async (_embedded, signal) => {
    graphReads++;
    if (graphFailure) throw originalFailure;
    await cancelGraph(signal);
    return { capture() { custodyCalls++; throw new Error('TEST unexpected native custody'); } };
  });
  const options: OpenCodeV2EmbeddedServerOptions = {
    profile: { provider: 'opencode', cwd: root, environment: { HOME: root },
      executable: { path: executable, sha256: createHash('sha256').update(bytes).digest('hex') } },
    embedded: { directory: root, manifestSha256: 'a'.repeat(64), version: '2.1.4',
      platform: process.platform, arch: process.arch },
    databasePath: join(root, 'TEST-unused.sqlite'), configDirectory: root, config: {},
    ...(abortAt === 'timer' ? { startupTimeoutMs: 1000 } : {}),
    canAllocate: () => { allocationChecks++; return false; },
    processCustody: {
      captureRoot() { custodyCalls++; throw new Error('TEST unexpected root capture'); },
      readRootExecutable() { custodyCalls++; throw new Error('TEST unexpected executable measurement'); },
    },
  };
  if (observer === 'getter') Object.defineProperty(options, 'observeStartupPhase', {
    get() { getterReads++; throw diagnosticFailure; },
  });
  else if (observer !== 'absent') options.observeStartupPhase = phase => {
    observed.push(phase);
    if (phase === abortAt) controller.abort(originalAbort);
    if (observer === 'throw') throw diagnosticFailure;
  };
  let server: ReturnType<typeof import('../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedServer')['createOpenCodeV2EmbeddedServer']> | undefined;
  try {
    const actual = await vi.importActual<typeof import('../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedServer')>(
      '../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedServer');
    server = actual.createOpenCodeV2EmbeddedServer(options);
    if (observer === 'captured') options.observeStartupPhase = () => { throw diagnosticFailure; };
    if (abortAt === 'timer') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const completion = server.start(controller.signal).then(() => {
      throw new Error('TEST unadmitted native startup unexpectedly succeeded');
    }, error => error as unknown);
    if (abortAt === 'timer' || abortAt === 'lifecycle') {
      await graphEntered.promise;
      if (abortAt === 'timer') {
        await vi.advanceTimersByTimeAsync(999);
        expect(cancelledGraphReason).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
      } else await expect(server.stopOwned()).resolves.toBe(true);
    }
    const failure = await completion;
    if (abortAt === 'timer' || abortAt === 'lifecycle') expect(failure).toBe(cancelledGraphReason);
    else if (abortAt === 'native-launch-returned') expect(failure).toMatchObject({ message: 'OpenCode V2 embedded startup failed' });
    else if (abortAt) expect(failure).toBe(originalAbort);
    else if (graphFailure) expect(failure).toBe(originalFailure);
    else expect(failure).toMatchObject({ message: 'Native launch unavailable' });
    const expectedPhases: StartupPhase[] = graphFailure || abortAt === 'graph-start' || abortAt === 'timer' || abortAt === 'lifecycle'
      ? ['graph-start'] : ['graph-start', 'graph-done', 'native-launch'];
    if (returnedChild) expectedPhases.push('native-launch-returned');
    if (abortAt === 'native-endpoint-resolved') expectedPhases.push('native-endpoint-resolved');
    expectedPhases.push(abortAt === 'timer' ? 'startup-timer-aborted' : abortAt === 'lifecycle'
      ? 'startup-lifecycle-aborted' : abortAt ? 'startup-parent-aborted' : 'startup-failed');
    expect(observed).toEqual(observer === 'absent' || observer === 'getter' ? [] : expectedPhases);
    expect(graphReads).toBe(abortAt === 'graph-start' ? 0 : 1);
    expect(allocationChecks).toBe(graphFailure || abortAt ? 0 : 1);
    expect(getterReads).toBe(observer === 'getter' ? 1 : 0);
    expect(custodyCalls).toBe(0); expect(controlled.spawn).not.toHaveBeenCalled();
    await expect(server.stopOwned()).resolves.toBe(true);
    expect(launchCalls).toBe(returnedChild ? 1 : 0);
    expect(stopCalls).toBe(returnedChild ? 1 : 0);
    expect(inputWrites).toBe(abortAt === 'native-endpoint-resolved' ? 1 : 0);
  } finally {
    await server?.stopOwned();
    if (abortAt === 'timer') vi.useRealTimers();
    custody?.mockRestore();
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    windows.mockRestore(); graph.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}

test.each(['absent', 'throw', 'getter', 'captured'] as const)(
  'real embedded startup keeps original graph and launch refusal with %s observation', async observer => {
    await embeddedBoundary(observer, true);
    await embeddedBoundary(observer, false);
  }
);

test.each(['graph-start', 'native-launch'] as const)(
  'original startup cutoff immediately after %s refuses even if the observer throws', async phase => {
    await embeddedBoundary('throw', false, phase);
  }
);

test.each(['native-launch-returned', 'native-endpoint-resolved'] as const)(
  'actual embedded %s preserves the original abort and one cleanup when its observer throws', async phase => {
    await embeddedBoundary('throw', false, phase);
  }
);

test.each(['timer', 'lifecycle'] as const)(
  'actual embedded startup observes the existing %s abort without extending it', async reason => {
    await embeddedBoundary('throw', false, reason);
  }
);

test.each(['refused', 'accepted', 'threw', 'revoked-open'] as const)(
  'passive probe handoff preserves original operations and clean close for %s in memory', async mode => {
    let baseline: string[] | undefined;
    const originalDiagnostic = probeDiagnostics.createOpenCodeProbeDiagnostic;
    for (const sink of ['absent', 'healthy', 'throws'] as const) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-probe-handoff-')));
      const management = openCodeManagementProfileSchema.parse(
        teamModelProbeProfile(runtimeMemberProfileSchema.parse(opencodeV2ModelProbeProfile(root))));
      const records: OpenCodeProbeDiagnostic[] = [], operations: string[] = [];
      const phasePositions = new Map<string, number>();
      const opened = Promise.withResolvers<void>(), releaseOpen = Promise.withResolvers<void>();
      const originalFailure = new Error('TEST original submit failure');
      let current = true, input: { inputId: string; operationRef: string } | undefined;
      const diagnostic = vi.spyOn(probeDiagnostics, 'createOpenCodeProbeDiagnostic')
        .mockImplementation((selected, command, digest) => sink === 'absent' ? () => {}
          : originalDiagnostic(selected, command, digest, line => {
            const record = JSON.parse(line.slice(probePrefix.length)) as OpenCodeProbeDiagnostic;
            records.push(record); phasePositions.set(record.phase, operations.length);
            if (sink === 'throws') throw new Error('TEST diagnostic sink failure');
          }));
      const identity = { pid: 48101, startIdentity: 'TEST-original-root', version: '2.1.4' };
      controlled.create = () => {
        operations.push('create');
        return {
          start: async () => { operations.push('start'); return { ...identity, endpoint: management.endpoint }; },
          readPassword: () => { operations.push('password'); return 'TEST-private-password'; },
          readNativeCustody: async () => { operations.push('custody'); return { ...identity }; },
          stopOwned: async () => { operations.push('stop'); return true; },
        };
      };
      const driver = {
        sessionRef: 'TEST-private-session',
        submit: async (value: { inputId: string; operationRef: string }) => {
          operations.push('submit'); input = value;
          if (mode === 'threw') throw originalFailure;
          return mode === 'refused' ? { ok: false, code: 'dependency-unavailable', delivery: 'known-not-sent' }
            : { ok: true, value: { ...value, delivery: 'client-consumed', providerAcceptance: 'unknown' } };
        },
        observe: async function* () {
          operations.push('observe'); assert.ok(input);
          yield { sessionRef: driver.sessionRef, ...input, kind: 'text', text: 'TEST OK' };
          yield { sessionRef: driver.sessionRef, ...input, kind: 'result', outcome: 'succeeded' };
        },
        close: async () => { operations.push('close'); return { cleanup: 'confirmed' }; },
      };
      controlled.driverFactory = () => {
        operations.push('factory');
        return { open: async () => {
          operations.push('open-enter'); opened.resolve();
          await releaseOpen.promise; operations.push('open-return'); return { driver };
        } };
      };
      let requests = 0;
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async request => {
        const native = request instanceof Request ? request : new Request(String(request));
        const path = new URL(native.url).pathname;
        operations.push(native.method + ' ' + path); expect(++requests).toBeLessThanOrEqual(12);
        const location = { directory: root };
        if (native.method === 'POST') {
          expect(path).toBe('/api/session');
          const body = await native.json() as Record<string, unknown>;
          expect(body.location).toEqual(location);
          return new Response(JSON.stringify({ data: { ...body, time: { created: 1 } } }),
            { headers: { 'content-type': 'application/json' } });
        }
        expect(['/api/info', '/api/provider', '/api/model', '/api/model/default']).toContain(path);
        const value = path === '/api/info' ? { pid: identity.pid, version: identity.version }
          : path === '/api/provider' ? { location, data: [{ id: 'TEST-provider', name: 'TEST provider', activation: 'enabled' }] }
            : path === '/api/model' ? { location, data: [{ id: 'TEST-model', providerID: 'TEST-provider', name: 'TEST model',
              enabled: true, limit: { context: 4096, output: 512 }, capabilities: { tools: false, input: ['text'] }, variants: [{ id: 'high' }] }] }
              : { location, data: { providerID: 'TEST-provider', id: 'TEST-model' } };
        return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
      });
      const probe = createOpenCodeV2ModelProbe(management, { commandId: 'TEST-handoff', profileId: management.profileId,
        configRevision: management.configRevision, providerId: 'TEST-provider', modelId: 'TEST-model' },
      () => { operations.push('current'); return current; });
      try {
        const signal = new AbortController().signal, running = probe.run(signal);
        expect(probe.run(signal)).toBe(running);
        const settled = running.then(value => ({ value }), error => ({ error }));
        await within(Promise.race([opened.promise, settled.then(result => {
          if ('error' in result) throw result.error;
          throw new Error('TEST run settled before original open');
        })]), 'original in-memory open');
        if (mode === 'revoked-open') current = false;
        releaseOpen.resolve();
        const result = await settled;
        if (mode === 'threw') {
          assert.ok('error' in result); expect(result.error).toBe(originalFailure);
        }
        else if (mode === 'revoked-open') expect(result).toMatchObject({ error: { code: 'held' } });
        else expect(result).toEqual({ value: mode === 'accepted' });
        const handoffs = records.filter(record => ['driver-open-returned', 'first-submit-current-returned',
          'first-submit-returned'].includes(record.phase));
        expect(handoffs.map(record => record.phase)).toEqual(sink === 'absent' ? [] : mode === 'revoked-open'
          ? ['driver-open-returned'] : mode === 'threw' ? ['driver-open-returned', 'first-submit-current-returned']
            : ['driver-open-returned', 'first-submit-current-returned', 'first-submit-returned']);
        if (sink !== 'absent' && (mode === 'refused' || mode === 'accepted'))
          expect(handoffs.at(-1)).toMatchObject({ submitStatus: mode === 'refused' ? 'refused' : 'ok',
            submitCode: mode === 'refused' ? 'dependency-unavailable' : null,
            submitDelivery: mode === 'refused' ? 'known-not-sent' : 'unobserved' });
        if (sink !== 'absent') {
          const openAt = phasePositions.get('driver-open-returned')!;
          expect(operations[openAt - 1]).toBe('open-return'); expect(operations[openAt]).toBe('current');
          if (mode !== 'revoked-open') {
            const currentAt = phasePositions.get('first-submit-current-returned')!;
            expect(operations[currentAt - 1]).toBe('current'); expect(operations[currentAt]).toBe('submit');
          }
        }
        const beforeClose = [...records];
        await expect(probe.close()).resolves.toBe(true);
        await expect(probe.close()).resolves.toBe(true);
        expect(records, 'the submit snapshot is independent of successful cleanup').toEqual(beforeClose);
        expect(operations.filter(operation => operation === 'create')).toHaveLength(1);
        expect(operations.filter(operation => operation === 'POST /api/session')).toHaveLength(1);
        expect(operations.filter(operation => operation === 'submit')).toHaveLength(mode === 'revoked-open' ? 0 : 1);
        expect(operations.filter(operation => operation === 'observe')).toHaveLength(mode === 'accepted' ? 1 : 0);
        expect(operations.filter(operation => operation === 'close')).toHaveLength(1);
        expect(operations.filter(operation => operation === 'stop')).toHaveLength(1);
        expect(operations.slice(-2)).toEqual(['close', 'stop']);
        baseline ??= operations; expect(operations).toEqual(baseline);
        expect(JSON.stringify(records)).not.toContain('TEST-private');
      } finally {
        releaseOpen.resolve(); await probe.close();
        fetch.mockRestore(); diagnostic.mockRestore(); controlled.driverFactory = undefined;
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
);
