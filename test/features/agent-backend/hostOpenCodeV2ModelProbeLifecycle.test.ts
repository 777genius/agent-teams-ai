// @vitest-environment node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers';

import { afterEach, expect, test, vi } from 'vitest';

import type { IncomingMessage, ServerResponse } from 'node:http';

const controlled = vi.hoisted(() => ({
  create: (_options: unknown): unknown => { throw new Error('TEST native factory unset'); },
  spawn: vi.fn(() => { throw new Error('TEST unexpected native spawn'); }),
}));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: controlled.spawn,
}));
vi.mock('../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedServer.js',
  () => ({ createOpenCodeV2EmbeddedServer: (options: unknown) => controlled.create(options) }));

import * as probeDiagnostics from '../../../packages/legacy-agent-host/src/adapters/providers/createClaudeCloseDiagnostic';
import * as embeddedGraph from '../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedGraph';
import { createOpenCodeV2ModelProbe } from '../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2ModelProbe';
import * as windowsCustody from '../../../packages/legacy-agent-host/src/adapters/providers/WindowsJobCustody';
import { runtimeMemberProfileSchema } from '../../../packages/legacy-agent-host/src/composition/runtimeProfile';
import { teamModelProbeProfile } from '../../../packages/legacy-agent-host/src/composition/teamLaunchModelProbe';
import { openCodeManagementProfileSchema } from '../../../packages/legacy-agent-host/src/management/profile';

import type { OpenCodeV2EmbeddedServerOptions } from '../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedServer';
import type { OpenCodeProbeDiagnostic } from '../../../src/features/agent-backend/main/infrastructure/decodeClaudeCloseDiagnostics';

afterEach(() => {
  controlled.create = () => { throw new Error('TEST native factory unset'); };
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
async function fixture(mode: 'http' | 'custody' | 'stop-unknown' = 'http', startFailure?: unknown,
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
  const parent = new AbortController();
  const location = { directory: root };
  const json = (res: ServerResponse, value: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
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
      assert.ok(session); return json(res, { data: session });
    }
    if (req.method === 'GET' && url.pathname === '/api/permission/saved')
      return json(res, { data: [] });
    if (req.method === 'GET' && (url.pathname === '/api/plugin' || url.pathname === '/api/mcp'))
      return json(res, { location, data: [] });
    if (req.method === 'GET' && url.pathname === '/api/experimental/session/' + sessionId + '/log') {
      assert.ok(session); assert.equal(url.searchParams.get('follow'), 'false');
      assert.equal(++logReads, 1, 'one original D queue preflight, never a replay');
      if (mode === 'custody') {
        // Let this original read complete, then stop the next admission BEFORE credentials.
        holdNextCustody = true;
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
        return { endpoint, pid, startIdentity };
      },
      readPassword: () => { passwordReads++; return password; },
      async readNativeCustody(signal: AbortSignal) {
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
  const probe = createOpenCodeV2ModelProbe(management, {
    commandId: 'TEST-original-probe', profileId: management.profileId, configRevision: management.configRevision,
    providerId: 'TEST-provider', modelId: 'TEST-model',
  }, isCurrent);
  return {
    observations,
    probe, parent, disconnected: disconnected.promise, custodyReturned: custodyReturned.promise,
    releaseCustody: () => returnCustody.resolve(),
    heldSignal: () => heldSignal,
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
    assertClosed() {
      expect(failures).toEqual([]);
      expect(nativeCreations).toBe(1); expect(logReads).toBe(1); expect(promptPosts).toBe(0);
      expect(physicalStops).toBe(1);
      expect(probe.wasRejected()).toBe(false);
    },
    async dispose() {
      const close = probe.close(); returnCustody.resolve();
      try { await close; if (run) await run.catch(() => {}); }
      finally {
        diagnostic.unsubscribe(observe);
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

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
  const f = await fixture('stop-unknown', failure);
  try {
    await expect(f.start()).rejects.toBe(failure);
    const closing = f.probe.close();
    await expect(closing).resolves.toBe(false);
    expect(f.probe.close()).toBe(closing);
    expect(f.observations).toEqual([expect.objectContaining({ runState: 'threw', outcome: 'unobserved',
      errorClass: kind === 'held' ? 'held' : 'unknown', stage: 'server-stop', reason: 'unconfirmed' })]);
    expect(getterCalls).toBe(0);
    expect(JSON.stringify(f.observations)).not.toContain(secret);
    expect(f.counts()).toMatchObject({ requests: 0, nativeCreations: 1, physicalStops: 1 });
  } finally { await f.dispose(); }
});

const probePrefix = 'legacy-agent-host: opencode-probe ';
const phases = ['run', 'graph-start', 'graph-done', 'native-launch', 'native-ready',
  'credential', 'attestation', 'session-create', 'driver-open', 'first-submit'];

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
      expect(records.map(record => record.phase)).toEqual(phases);
      expect(records.map(record => record.sequence)).toEqual(phases.map((_phase, index) => index + 1));
      expect(records.every(record => record.probeDigest === records[0]!.probeDigest)).toBe(true);
      expect(records.every(record => /^[a-f0-9]{64}$/.test(record.probeDigest))).toBe(true);
      // first-submit only observes entry: the original D queue still blocks the native prompt POST.
      f.parent.abort();
      await within(f.disconnected, 'original response after phase observation');
      await expect(running).resolves.toBe(false);
      await expect(f.probe.close()).resolves.toBe(true);
      expect(f.counts().requests).toBe(before.requests);
      expect(f.counts().passwordReads).toBe(before.passwordReads);
      expect(records).toHaveLength(phases.length);
      f.assertClosed(); expect(f.observations).toEqual([]);
    } finally { diagnostic.mockRestore(); await f?.dispose(); }
  }
});

test.each(['native-ready', 'session-create', 'first-submit'] as const)(
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
      await expect(f.start()).rejects.toMatchObject({ code: 'held' });
      expect(observed.at(-1)).toBe(boundary);
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

/** The real server verifies a tiny TEST file; its original allocation guard never permits a child. */
async function embeddedBoundary(
  observer: 'absent' | 'throw' | 'getter' | 'captured', graphFailure: boolean, abortAt?: StartupPhase
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-v2-probe-phase-boundary-')));
  const executable = join(root, 'TEST-never-executed'), bytes = Buffer.from('TEST inert source only\n');
  writeFileSync(executable, bytes, { mode: 0o600 });
  const originalFailure = new Error('TEST original graph failure');
  const diagnosticFailure = new Error('TEST diagnostic failure');
  const originalAbort = new Error('TEST original startup abort');
  const controller = new AbortController(), observed: StartupPhase[] = [];
  let graphReads = 0, allocationChecks = 0, custodyCalls = 0, getterReads = 0;
  const graph = vi.spyOn(embeddedGraph, 'verifyOpenCodeV2EmbeddedGraph').mockImplementation(async () => {
    graphReads++;
    if (graphFailure) throw originalFailure;
    return { modulePath: executable, effectPath: executable, requiredBunVersion: 'TEST-unused' };
  });
  const windows = vi.spyOn(windowsCustody, 'createWindowsJobCustody').mockImplementation(async () => {
    graphReads++;
    if (graphFailure) throw originalFailure;
    return { capture() { custodyCalls++; throw new Error('TEST unexpected native custody'); } };
  });
  const options: OpenCodeV2EmbeddedServerOptions = {
    profile: { provider: 'opencode', cwd: root, environment: { HOME: root },
      executable: { path: executable, sha256: createHash('sha256').update(bytes).digest('hex') } },
    embedded: { directory: root, manifestSha256: 'a'.repeat(64), version: '2.1.4',
      platform: process.platform, arch: process.arch },
    databasePath: join(root, 'TEST-unused.sqlite'), configDirectory: root, config: {},
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
    const failure = await server.start(controller.signal).then(() => {
      throw new Error('TEST unadmitted native startup unexpectedly succeeded');
    }, error => error as unknown);
    if (abortAt) expect(failure).toBe(originalAbort);
    else if (graphFailure) expect(failure).toBe(originalFailure);
    else expect(failure).toMatchObject({ message: 'Native launch unavailable' });
    const expectedPhases: StartupPhase[] = graphFailure || abortAt === 'graph-start'
      ? ['graph-start'] : ['graph-start', 'graph-done', 'native-launch'];
    expect(observed).toEqual(observer === 'absent' || observer === 'getter' ? [] : expectedPhases);
    expect(graphReads).toBe(abortAt === 'graph-start' ? 0 : 1);
    expect(allocationChecks).toBe(graphFailure || abortAt ? 0 : 1);
    expect(getterReads).toBe(observer === 'getter' ? 1 : 0);
    expect(custodyCalls).toBe(0); expect(controlled.spawn).not.toHaveBeenCalled();
    await expect(server.stopOwned()).resolves.toBe(true);
  } finally {
    await server?.stopOwned();
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
