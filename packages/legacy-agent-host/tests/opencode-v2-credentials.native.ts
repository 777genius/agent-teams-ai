/** TEST-only key connection through the actual 2.1.4 engine and Host credential ledger. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, open, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { fileHash, startHost, tick } from './fixtures/native-host.ts';
import { createPassiveNativeDiagnosticCapture } from './fixtures/native-opencode-team/passive-diagnostics.ts';
import { assertNativeV1Build, buildNativeV1Host } from './opencode-v1-version-source.ts';
import { applyOpenCodeRuntimeSource } from '../dist/composition/applyOpenCodeRuntimeSource.js';
import { selectOpenCodeV2ManagementModel } from '../dist/composition/openCodeV2ModelSelection.js';
import { managementDigest } from '../dist/management/identity.js';
import { openCodeManagementProfileSchema } from '../dist/management/profile.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { RuntimeSourceCandidate, RuntimeSourceGrant, RuntimeSourcePublication, RuntimeSourceSummary } from '../dist/composition/runtimeSourceContracts.js';
import type {
  ProviderCredentialReceipt, ProviderManagementCatalog, ProviderModelProbeSnapshot,
} from '../dist/management/contracts.js';

const value = <T>(result: Record<string, unknown>): T => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value as T;
};
const selectedKey = 'TEST-native-selected-key-never-a-real-secret';
const rejectedKey = 'TEST-native-rejected-key-never-a-real-secret';
const foreignKey = 'TEST-native-foreign-key-never-import';

interface NativeBirth {
  pid: number;
  parent: number;
  group: number;
  session: number;
  startIdentity: string;
}
interface MetadataReady {
  profileHash: string;
  mode: 'directory';
  providerHash: null;
  pid: number;
  startIdentity: string;
  stage: 'ready';
}
interface HostEpoch {
  id: number;
  pid: number;
  line: string;
  discarded: boolean;
}
interface CatalogOwner {
  epoch: HostEpoch;
  profileHash: string;
  ready?: MetadataReady;
  released: boolean;
}
interface ProbeIntent {
  epoch: HostEpoch;
  commandId: string;
  requestIndex: number;
  catalogs: readonly CatalogOwner[];
  namespacePrefix: string;
  dataRoot: string;
  configRoot: string;
  native?: NativeBirth;
  directories?: Readonly<{ data: string; config: string }>;
}

test('native V2 rejects a wrong key, accepts its explicit correction and retains unknown intents without replay', {
  skip: process.env.OPENCODE_V2_CREDENTIAL_GO !== '1', timeout: 240000,
}, async context => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v24.21.0');
  const repo = resolve(import.meta.dirname, '../../..'), pkg = join(repo, 'packages/legacy-agent-host');
  const node = await realpath(process.execPath), entry = join(pkg, 'dist/cli.js');
  const bun = await realpath(process.env.OPENCODE_V2_EMBEDDED_BUN!);
  const engine = await realpath(process.env.OPENCODE_V2_EMBEDDED_GRAPH!);
  const receiptPath = process.env.OPENCODE_V2_CREDENTIAL_RECEIPT!;
  assert.ok(receiptPath?.startsWith('/'));
  const sourceHead = process.env.OPENCODE_V2_TEST_SOURCE_HEAD!;
  const build = await buildNativeV1Host(repo, sourceHead);
  const digests = { node: await fileHash(node), bun: await fileHash(bun),
    manifest: await fileHash(join(engine, 'opencode-v2-engine-manifest.json')),
    hostSource: build.hostSourceDigest, hostDist: build.hostDistDigest, provider: build.providerDigest };
  assert.equal(digests.manifest, process.env.OPENCODE_V2_EMBEDDED_MANIFEST_SHA256);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-v2-credentials-')));
  const steps: string[] = [], failures: string[] = [];
  const requests: { authorizationMatched: boolean; tools: number; promptMatched: boolean; outcome: string }[] = [];
  const hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [];
  // Four original Host lifetimes; each unchanged collector retains at most 257 sanitized rows.
  const passive: ReturnType<typeof createPassiveNativeDiagnosticCapture>[] = [];
  let hostEpoch = 0;
  const nativePids = new Set<number>();
  let host: ReturnType<typeof startHost> | undefined, originalFailure: unknown;
  let passed = false, cleanup = false, nativeCredentialCount = 0;
  const cleanupErrors: unknown[] = [];
  const metadataPrefix = 'legacy-agent-host: opencode-metadata ';
  const epochs: HostEpoch[] = [], catalogs: CatalogOwner[] = [], probes: ProbeIntent[] = [];
  const births = new Map<number, string>(), probeDirectories = new Set<string>();
  const metadataWaiters = new Set<() => void>();
  const profiles = new Map<string, ReturnType<typeof openCodeManagementProfileSchema.parse>>();
  let epoch: HostEpoch | undefined, activeProbe: ProbeIntent | undefined;
  let metadataCount = 0, metadataFailure: Error | undefined;
  const targetHash = (target: { profileId: string; configRevision: string }) =>
    createHash('sha256').update(JSON.stringify([target.profileId, target.configRevision])).digest('hex');
  const sameBirth = (left: NativeBirth, right: NativeBirth | undefined) => right !== undefined &&
    left.pid === right.pid && left.parent === right.parent && left.group === right.group &&
    left.session === right.session && left.startIdentity === right.startIdentity;
  const observerCurrent = () => { if (metadataFailure) throw metadataFailure; context.signal.throwIfAborted(); };
  function metadataLine(original: HostEpoch, line: string): void {
    assert.ok(++metadataCount <= 10, 'TEST metadata lineage exceeded its five original owners');
    const raw: unknown = JSON.parse(line.slice(metadataPrefix.length));
    assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw), 'TEST metadata row shape');
    const row = raw as Record<string, unknown>;
    assert.ok(Object.keys(row).sort().join(',') === 'mode,pid,profileHash,providerHash,stage,startIdentity',
      'TEST metadata row fields');
    assert.ok(typeof row.profileHash === 'string' && /^[a-f0-9]{64}$/.test(row.profileHash) &&
      row.mode === 'directory' && row.providerHash === null && typeof row.pid === 'number' &&
      Number.isSafeInteger(row.pid) && row.pid > 1 && typeof row.startIdentity === 'string' &&
      new RegExp('^' + row.pid + ':[0-9]+$').test(row.startIdentity), 'TEST metadata identity shape');
    assert.ok(row.stage === 'ready' || row.stage === 'released' || row.stage === 'cleanup-unknown',
      'TEST metadata stage');
    if (row.stage === 'ready') {
      const awaiting = catalogs.filter(item => item.epoch === original &&
        item.profileHash === row.profileHash && !item.ready);
      assert.ok(awaiting.length === 1 && !births.has(row.pid), 'TEST unexpected or reused metadata birth');
      assert.ok(!catalogs.some(item => item.epoch === original && item.profileHash === row.profileHash &&
        item.ready && !item.released), 'TEST duplicate live metadata owner');
      births.set(row.pid, row.startIdentity);
      awaiting[0]!.ready = Object.freeze({ profileHash: row.profileHash, mode: 'directory', providerHash: null,
        pid: row.pid, startIdentity: row.startIdentity, stage: 'ready' });
    } else {
      const owner = catalogs.find(item => item.epoch === original && item.ready?.pid === row.pid);
      assert.ok(owner && !owner.released && owner.profileHash === row.profileHash &&
        owner.ready?.startIdentity === row.startIdentity && row.stage === 'released',
      'TEST unmatched or unconfirmed metadata release');
      owner.released = true;
    }
  }
  function diagnostic(original: HostEpoch, chunk: Buffer): void {
    if (metadataFailure) return;
    try {
      for (const byte of chunk) {
        if (byte === 10) {
          if (!original.discarded && original.line.startsWith(metadataPrefix)) metadataLine(original, original.line);
          original.line = ''; original.discarded = false;
        } else if (!original.discarded) {
          original.line += String.fromCharCode(byte);
          if (original.line.length >= metadataPrefix.length && !original.line.startsWith(metadataPrefix)) {
            original.line = ''; original.discarded = true;
          } else assert.ok(original.line.length <= 1024, 'TEST metadata line limit');
        }
      }
    } catch { metadataFailure ??= new Error('TEST original metadata lineage refused'); }
    for (const wake of metadataWaiters) wake();
  }
  function expectCatalog(target: { profileId: string; configRevision: string }): CatalogOwner {
    observerCurrent();
    assert.ok(epoch && catalogs.length < 5 && profiles.has(targetHash(target)), 'TEST original catalog target');
    const owner: CatalogOwner = { epoch, profileHash: targetHash(target), released: false };
    catalogs.push(owner);
    return owner;
  }
  async function metadataReady(expected: readonly CatalogOwner[]): Promise<MetadataReady[]> {
    const original = epoch;
    assert.ok(original && new Set(expected).size === expected.length &&
      expected.every(item => item.epoch === original && catalogs.includes(item)), 'TEST original metadata epoch');
    const complete = () => {
      observerCurrent();
      assert.ok(epoch === original && expected.every(item => !item.released), 'TEST metadata owner changed');
      return catalogs.filter(item => item.epoch === original)
        .every(item => item.ready && (expected.includes(item) ? !item.released : item.released));
    };
    while (!complete()) await new Promise<void>((done, reject) => {
      const clear = () => { metadataWaiters.delete(wake); context.signal.removeEventListener('abort', aborted); };
      const wake = () => { clear(); done(); };
      const aborted = () => { clear(); reject(new Error('TEST original metadata observation aborted')); };
      metadataWaiters.add(wake);
      context.signal.addEventListener('abort', aborted, { once: true });
      if (context.signal.aborted) aborted();
    });
    return expected.map(item => item.ready!);
  }
  async function readBirth(pid: number, original: HostEpoch): Promise<NativeBirth | undefined> {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8').catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!text) return undefined;
    const end = text.lastIndexOf(') ');
    assert.ok(end >= 0, 'TEST native stat shape');
    const fields = text.slice(end + 2).trim().split(/\s+/);
    if (Number(fields[1]) !== original.pid || fields[0] === 'Z') return undefined;
    assert.ok(Number(fields[2]) === pid && Number(fields[3]) === pid && /^\d+$/.test(fields[19] ?? ''),
      'TEST original native group and birth');
    return { pid, parent: original.pid, group: pid, session: pid, startIdentity: `${pid}:${fields[19]}` };
  }
  async function nativeChildren(): Promise<NativeBirth[]> {
    const original = epoch;
    assert.ok(original && host?.facts().pid === original.pid, 'TEST original Host child census');
    const found: NativeBirth[] = [];
    for (const candidate of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
      const child = await readBirth(Number(candidate), original);
      if (child) found.push(child);
    }
    return found;
  }
  const children = async () => (await nativeChildren()).map(child => child.pid);
  async function probeNamespace(child: NativeBirth, intent: ProbeIntent): Promise<{ data: string; config: string }> {
    const fd = await open(`/proc/${child.pid}/environ`, 'r');
    const bytes = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    try {
      while (length < bytes.length) {
        observerCurrent();
        const read = await fd.read(bytes, length, bytes.length - length, null);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
    } finally { await fd.close(); }
    assert.ok(length > 0 && length < bytes.length && bytes[length - 1] === 0, 'TEST native environment bound');
    let data: string | undefined, config: string | undefined;
    for (let start = 0; start < length;) {
      const end = bytes.indexOf(0, start), entry = bytes.subarray(start, end);
      const separator = entry.indexOf(61), key = entry.subarray(0, separator < 0 ? entry.length : separator);
      const isData = key.equals(Buffer.from('XDG_DATA_HOME')), isConfig = key.equals(Buffer.from('XDG_CONFIG_HOME'));
      if (isData || isConfig) {
        const raw = entry.subarray(separator + 1), decoded = raw.toString('utf8');
        assert.ok(separator > 0 && raw.length > 0 && Buffer.from(decoded).equals(raw) &&
          (isData ? data === undefined : config === undefined), 'TEST native XDG field refused');
        if (isData) data = decoded; else config = decoded;
      }
      start = end + 1;
    }
    assert.ok(data && config, 'TEST native probe XDG pair missing');
    for (const [directory, parent] of [[data, intent.dataRoot], [config, intent.configRoot]]) {
      const name = basename(directory!);
      assert.ok(dirname(directory!) === parent && name.startsWith(intent.namespacePrefix) &&
        /^[A-Za-z0-9]+$/.test(name.slice(intent.namespacePrefix.length)) &&
        await realpath(directory!) === directory, 'TEST original probe namespace refused');
    }
    return { data, config };
  }
  function assertNativeSet(actual: readonly NativeBirth[], observed: readonly MetadataReady[],
    expected: readonly CatalogOwner[], probe?: NativeBirth): void {
    assert.ok(observed.length === expected.length && expected.every(item => observed.some(row =>
      row.profileHash === item.profileHash && row.pid === item.ready?.pid &&
      row.startIdentity === item.ready?.startIdentity)), 'TEST original catalog owners changed');
    const wanted = [...observed, ...(probe ? [probe] : [])];
    assert.ok(new Set(wanted.map(row => row.pid)).size === wanted.length &&
      new Set(actual.map(row => row.pid)).size === actual.length && actual.length === wanted.length &&
      wanted.every(row => actual.some(child => row.pid === child.pid && row.startIdentity === child.startIdentity)),
    'TEST Host owns exactly its original catalogs and current finite probe');
  }
  async function observeNative(expected: readonly CatalogOwner[], intent?: ProbeIntent): Promise<NativeBirth[]> {
    const observed = await metadataReady(expected), original = epoch!;
    const actual = await nativeChildren();
    for (const child of actual) {
      assert.ok(sameBirth(child, await readBirth(child.pid, original)), 'TEST original birth before executable read');
      assert.equal(await fileHash(`/proc/${child.pid}/exe`), digests.bun);
      assert.ok(sameBirth(child, await readBirth(child.pid, original)), 'TEST original birth after executable read');
      nativePids.add(child.pid);
    }
    let probe: NativeBirth | undefined;
    if (intent) {
      assert.ok(activeProbe === intent && intent.epoch === original && requests.length === intent.requestIndex,
        'TEST model request has its original intent');
      const unmatched = actual.filter(child => !observed.some(row => row.pid === child.pid && row.startIdentity === child.startIdentity));
      assert.ok(unmatched.length === 1, 'TEST exactly one original verification probe');
      probe = unmatched[0]!;
      assert.ok(sameBirth(probe, await readBirth(probe.pid, original)), 'TEST probe birth before namespace read');
      const directories = await probeNamespace(probe, intent);
      assert.ok(sameBirth(probe, await readBirth(probe.pid, original)), 'TEST probe birth after namespace read');
      assert.ok(!intent.native && !births.has(probe.pid) && !probeDirectories.has(directories.data) &&
        !probeDirectories.has(directories.config), 'TEST original probe may be captured only once');
      births.set(probe.pid, probe.startIdentity);
      probeDirectories.add(directories.data); probeDirectories.add(directories.config);
      intent.native = Object.freeze(probe); intent.directories = Object.freeze(directories);
    }
    assertNativeSet(actual, observed, expected, probe);
    for (const owner of catalogs.filter(item => item.released && item.ready))
      assert.throws(() => process.kill(-owner.ready!.pid, 0), { code: 'ESRCH' });
    for (const previous of probes.filter(item => item !== intent && item.native))
      assert.throws(() => process.kill(-previous.native!.pid, 0), { code: 'ESRCH' });
    assert.ok(epoch === original && host?.facts().pid === original.pid, 'TEST original Host remains current');
    observerCurrent();
    return actual;
  }
  function beginProbe(input: { profileId: string; configRevision: string; commandId: string; providerId: string },
    kind: 'connect' | 'check', expected: readonly CatalogOwner[]): void {
    observerCurrent();
    const base = profiles.get(targetHash(input));
    assert.ok(epoch && base && !activeProbe && probes.length < 4, 'TEST original finite probe admission');
    const selected = selectOpenCodeV2ManagementModel(base,
      { providerId: input.providerId, modelId: 'TEST-local/TEST-model' });
    const commandId = kind === 'connect'
      ? 'connect-verify-' + managementDigest(input.commandId).slice(0, 48) : input.commandId;
    const captured = managementDigest({ profile: selected, commandId });
    assert.ok(selected.environment.XDG_DATA_HOME && selected.environment.XDG_CONFIG_HOME);
    activeProbe = { epoch, commandId, requestIndex: requests.length, catalogs: expected,
      namespacePrefix: `agent-teams-v2-probe-${captured.slice(0, 16)}-`,
      dataRoot: selected.environment.XDG_DATA_HOME, configRoot: selected.environment.XDG_CONFIG_HOME };
    probes.push(activeProbe);
  }
  const model = createServer((request, response) => {
    void (async () => {
      assert.equal(failures.length, 0);
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const data = Buffer.from(chunk as Uint8Array);
        bytes += data.length;
        assert.ok(bytes <= 1024 * 1024);
        chunks.push(data);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const body = JSON.parse(text) as Record<string, unknown>;
      assert.equal(body.model, 'TEST-model');
      assert.equal(body.reasoning_effort, undefined, 'verification fallback does not inherit the captured variant');
      assert.ok(body.tools === undefined || Array.isArray(body.tools) && body.tools.length === 0);
      const refused = requests.length === 0, timedOut = requests.length === 3;
      const authorizationMatched = request.headers.authorization === 'Bearer ' + (refused ? rejectedKey : selectedKey);
      const promptMatched = JSON.stringify(body.messages).includes(
        'Reply only OK. Do not use tools, access files or run commands.');
      assert.equal(authorizationMatched, true);
      assert.equal(promptMatched, true);
      for (const privateValue of [selectedKey, rejectedKey, foreignKey, 'agentTeamsCredential', 'scopeDigest', 'credentialId'])
        assert.equal(text.includes(privateValue), false, 'credential witnesses never enter model context');
      assert.ok(requests.length < 4, 'readback/reconnect cannot cause native inference replay');
      const intent = activeProbe;
      assert.ok(intent, 'TEST model request has an original finite intent');
      await observeNative(intent.catalogs, intent);
      requests.push({ authorizationMatched, tools: 0, promptMatched,
        outcome: refused ? 'refused' : timedOut ? 'timeout' : 'OK' });
      if (refused) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'TEST controlled model refusal',
          type: 'authentication_error', code: 'invalid_api_key' } }));
        return;
      }
      if (timedOut) {
        // The original native request is observed, but no terminal response is
        // supplied. Its captured deadline and original child cleanup must settle it.
        await new Promise<void>(done => response.once('close', done));
        return;
      }
      const event = (delta: Record<string, unknown>, finish: string | null) => ({
        id: 'TEST-native-v2-key-reply', object: 'chat.completion.chunk', created: 1700000000,
        model: 'TEST-model', choices: [{ index: 0, delta, finish_reason: finish }],
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify(event({ role: 'assistant', content: 'OK' }, null))}\n\n`);
      response.write(`data: ${JSON.stringify(event({}, 'stop'))}\n\n`);
      response.end('data: [DONE]\n\n');
    })().catch(() => {
      failures.push('TEST_native_key_model_request_refused');
      if (!response.headersSent) response.writeHead(400);
      response.end('TEST native key oracle refused request');
    });
  });
  try {
    for (const name of ['workspace', 'home', 'config', 'data', 'cache', 'tmp', 'store'])
      await mkdir(join(root, name), { mode: 0o700 });
    await mkdir(join(root, 'data/opencode'), { mode: 0o700 });
    const authPath = join(root, 'data/opencode/auth.json');
    const foreign = { 'TEST-foreign': { type: 'api', key: foreignKey } };
    await writeFile(authPath, JSON.stringify(foreign), { mode: 0o600 });
    await new Promise<void>(done => model.listen(0, '127.0.0.1', done));
    const address = model.address();
    assert.ok(address && typeof address !== 'string');
    const profile: TeamHostProfile = {
      schemaVersion: 1, principalId: 'TEST-human', teams: [],
      owner: { ownerId: 'TEST-key-owner', revision: 'TEST-owner-v1', profileId: 'TEST-host',
        storageRoot: join(root, 'store'), protocolVersion: 1, buildId: 'TEST-native-v2-credentials',
        nodeSha256: digests.node, hostEntrySha256: await fileHash(entry) },
      management: [{ provider: 'opencode', profileId: 'TEST-management', configRevision: 'TEST-config',
        nativeGeneration: 'v2', protocolRevision: '2.1.4', accountBinding: 'TEST-account',
        cwd: join(root, 'workspace'), executable: { path: bun, sha256: digests.bun },
        endpoint: `http://127.0.0.1:${address.port}`, timeoutMs: 30000, modelProbeTimeoutMs: 30000,
        nativeModel: { providerId: 'TEST-local', modelId: 'TEST-unavailable-model' }, variant: 'high',
        environment: { HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
          XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
          XDG_CACHE_HOME: join(root, 'cache'), PATH: `${dirname(node)}:/usr/bin:/bin`, NO_COLOR: '1' },
        embedded: { version: '2.1.4', platform: 'linux', arch: 'x64', directory: engine,
          manifestSha256: digests.manifest, externalDirectory: 'deny',
          providerConfiguration: { package: 'aisdk:@ai-sdk/openai-compatible',
            // Only native credential connection can supply the Authorization header.
            settings: { baseURL: `http://127.0.0.1:${address.port}/v1` },
            models: { 'TEST-model': { name: 'TEST-model', limit: { context: 200000, output: 128 },
              capabilities: { tools: true, input: ['text'], output: ['text'] } } } } },
      }],
    };
    const originalProfile = openCodeManagementProfileSchema.parse(profile.management![0]);
    profiles.set(targetHash(originalProfile), originalProfile);
    const profilePath = join(root, 'profile.json');
    await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
    const profileHash = await fileHash(profilePath);
    const start = async () => {
      await assertNativeV1Build(repo, sourceHead, build);
      assert.ok(!host && epochs.length < 4, 'TEST original Host epochs only');
      const original: HostEpoch = { id: ++hostEpoch, pid: 0, line: '', discarded: false };
      const diagnostics = createPassiveNativeDiagnosticCapture();
      passive.push(diagnostics);
      host = startHost({ node, entry, root, profile: profilePath, profileHash,
        testImports: [new URL('./fixtures/native-opencode-team/passive-diagnostics.ts', import.meta.url).href],
        onDiagnostic: (chunk: Buffer) => {
          diagnostics.accept(chunk, original.id);
          diagnostic(original, chunk);
        } });
      original.pid = host.facts().pid ?? 0;
      epoch = original; epochs.push(original);
      assert.ok(original.pid > 1, 'TEST original Host PID');
      await host.rpc('host.handshake', { protocolVersion: 1 });
    };
    const stop = async () => {
      assert.ok(host);
      await host.close();
      hosts.push(host.facts());
      host = undefined;
      for (const pid of nativePids) assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
      await metadataReady([]);
    };
    let target = { profileId: 'TEST-management', configRevision: 'TEST-config' };
    const directory = async () => value<ProviderManagementCatalog>(await host!.rpc('management.catalog', target));
    const selected = (catalog: ProviderManagementCatalog) => {
      const found = catalog.providers.find(row => row.providerId === 'TEST-local');
      assert.ok(found);
      for (const key of [selectedKey, rejectedKey, foreignKey]) assert.equal(JSON.stringify(catalog).includes(key), false);
      return found;
    };
    let pending = { ...target, providerId: 'TEST-local' };
    let connect = { ...pending, commandId: 'TEST-key-connect', kind: 'credential.set', key: selectedKey };
    await start();
    const a0 = expectCatalog(target);
    const before = await directory();
    assert.deepEqual(before.runtime, { generation: 'v2', version: '2.1.4' });
    assert.ok(before.providers.length > 1, 'the passive native directory includes other integrations');
    assert.equal(selected(before).connected, false);
    assert.deepEqual(selected(before).authMethods, ['api']);
    assert.equal(requests.length, 0);
    await observeNative([a0]);
    steps.push('passive_all_provider_directory_without_import_or_inference');
    const rejected = { ...connect, commandId: 'TEST-rejected-connect', key: rejectedKey };
    beginProbe(rejected, 'connect', []);
    const rejectedReceipt = value<ProviderCredentialReceipt>(await host!.rpc('management.credential', rejected));
    assert.equal(rejectedReceipt.phase, 'held');
    assert.equal(rejectedReceipt.reason, 'verification-rejected');
    assert.equal(requests.length, 1);
    activeProbe = undefined;
    await observeNative([]);
    assert.deepEqual(value(await host!.rpc('management.credential.pending', pending)),
      { generation: 'v2', receipt: null });
    const a1 = expectCatalog(target);
    const rejectedCatalog = selected(await directory());
    assert.equal(rejectedCatalog.configured, true);
    assert.equal(rejectedCatalog.connected, false);
    await observeNative([a1]);
    const originalCatalogPids = await children();
    assert.equal(originalCatalogPids.length, 1, 'the rejected source retains one original catalog owner');
    const grant: RuntimeSourceGrant = { targetId: 'c'.repeat(64), ownerId: profile.owner.ownerId,
      ownerRevision: profile.owner.revision, contextId: 'TEST-context', projectPath: join(root, 'workspace'),
      runtimeId: 'opencode', ...target, teamScopes: [] };
    const current = value<RuntimeSourceSummary>(await host!.rpc('runtime.source.current', { grant }));
    const candidate: RuntimeSourceCandidate = { sourceKind: 'captured', executable: profile.management![0]!.executable };
    const published = value<RuntimeSourcePublication>(await host!.rpc('runtime.source.publish', {
      grant, commandId: 'TEST-new-runtime-source', expectedRevision: current.revision,
      candidate,
    }));
    assert.equal(published.phase, 'published');
    assert.ok(published.selection);
    assert.notEqual(published.selection.profileId, target.profileId);
    target = { profileId: published.selection.profileId, configRevision: published.selection.configRevision };
    profiles.set(targetHash(target), openCodeManagementProfileSchema.parse({
      ...applyOpenCodeRuntimeSource(originalProfile, candidate), ...target, executable: candidate.executable,
    }));
    pending = { ...target, providerId: 'TEST-local' };
    connect = { ...connect, ...target };
    const b1 = expectCatalog(target);
    assert.equal(selected(await directory()).connected, false, 'a source revision cannot inherit old model verification');
    assert.equal(requests.length, 1, 'source publication and passive read do not verify a model');
    // Distinct retained source profiles own distinct passive catalogs until the original Host closes.
    const retainedCatalogs = [a1, b1], originalChildren = await observeNative(retainedCatalogs);
    assert.ok(originalChildren.some(child => child.pid === originalCatalogPids[0]!),
      'new source cannot retarget the old catalog owner');
    const originalMetadata = retainedCatalogs.map(item => item.ready!);
    assert.throws(() => assertNativeSet(originalChildren,
      [{ ...originalMetadata[0]!, profileHash: '0'.repeat(64) }, originalMetadata[1]!], retainedCatalogs));
    assert.throws(() => assertNativeSet(originalChildren,
      [{ ...originalMetadata[0]!, startIdentity: originalMetadata[0]!.startIdentity + '0' }, originalMetadata[1]!], retainedCatalogs));
    assert.throws(() => assertNativeSet([
      { ...originalChildren[0]!, pid: Number.MAX_SAFE_INTEGER, startIdentity: `${Number.MAX_SAFE_INTEGER}:1` },
      ...originalChildren.slice(1),
    ], originalMetadata, retainedCatalogs));
    await stop();
    await start();
    assert.deepEqual(value(await host!.rpc('management.credential.lookup', {
      commandId: rejected.commandId, profileId: rejected.profileId, configRevision: rejected.configRevision,
    })), rejectedReceipt, 'cold source recovery retains the immutable original rejected target');
    // A confirmed owned publication + qualified failed terminal admits an
    // explicit corrected key. This cannot authorize overwriting a foreign key.
    // Drop the original application acknowledgement; reconciliation uses its exact intent only.
    beginProbe(connect, 'connect', []);
    value<ProviderCredentialReceipt>(await host!.rpc('management.credential', connect));
    const original = value<ProviderCredentialReceipt>(await host!.rpc('management.credential.resume', connect));
    assert.equal(original.phase, 'completed');
    assert.deepEqual(value(await host!.rpc('management.credential', connect)), original);
    assert.deepEqual(await host!.rpc('management.credential.resume', { ...connect, key: 'TEST-changed-key' }),
      { ok: false, code: 'conflict' });
    assert.equal(requests.length, 2);
    assert.deepEqual(await children(), []);
    activeProbe = undefined;
    await observeNative([]);
    assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), {
      ...foreign, 'TEST-local': { type: 'api', key: selectedKey } });
    steps.push('native_key_one_verification_original_receipt_after_lost_ack');
    steps.push('native_401_saved_unverified_then_cold_explicit_corrected_key_succeeds');
    steps.push('runtime_source_revision_preserves_original_rejected_key_replacement_authority');
    await stop();
    await start();
    assert.deepEqual(value(await host!.rpc('management.credential.resume', connect)), original);
    const b2 = expectCatalog(target);
    const after = selected(await directory());
    assert.equal(after.source, 'api');
    assert.equal(after.configured, true);
    assert.equal(after.connected, true);
    assert.equal(requests.length, 2, 'cold inventory/readback cannot verify the model again');
    await observeNative([b2]);
    // Use the stored key in an explicit later Check, with no key in the request.
    const probe = { ...pending, commandId: 'TEST-saved-key-check', modelId: 'TEST-local/TEST-model' };
    const lookup = { ...target, commandId: probe.commandId };
    beginProbe(probe, 'check', [b2]);
    value<ProviderModelProbeSnapshot>(await host!.rpc('management.probe.start', probe));
    let snapshot: ProviderModelProbeSnapshot;
    const deadline = Date.now() + 45000;
    do {
      await tick();
      snapshot = value(await host!.rpc('management.probe.read', lookup));
    } while (snapshot.phase === 'running' && Date.now() < deadline);
    assert.equal(snapshot.phase, 'completed');
    assert.equal(snapshot.ok, true);
    assert.equal(requests.length, 3);
    activeProbe = undefined;
    await observeNative([b2]);
    steps.push('cold_directory_and_explicit_check_reuse_saved_selected_key');
    // A fresh explicit intent may follow completion, even for the same key.
    // A timed-out verification retains that new intent across restart.
    const unverified = { ...connect, commandId: 'TEST-unverified-connect' };
    beginProbe(unverified, 'connect', []);
    const retained = value<ProviderCredentialReceipt>(await host!.rpc('management.credential', unverified));
    assert.equal(retained.phase, 'held');
    assert.equal(retained.reason, undefined, 'timeout never becomes confirmed credential rejection');
    assert.equal(requests.length, 4);
    assert.deepEqual(await children(), []);
    activeProbe = undefined;
    await observeNative([]);
    await stop();
    await start();
    assert.deepEqual(value(await host!.rpc('management.credential.pending', pending)),
      { generation: 'v2', receipt: retained });
    assert.deepEqual(value(await host!.rpc('management.credential.resume', unverified)), retained);
    for (const changed of [{ ...unverified, key: 'TEST-changed-key' },
      { ...unverified, commandId: 'TEST-unsafe-new-intent' }])
      assert.deepEqual(await host!.rpc('management.credential', changed), { ok: false, code: 'conflict' });
    assert.deepEqual(await children(), []);
    assert.equal(requests.length, 4);
    const b3 = expectCatalog(target);
    const unverifiedCatalog = selected(await directory());
    assert.equal(unverifiedCatalog.configured, true);
    assert.equal(unverifiedCatalog.connected, false, 'an old success cannot hide a newer unverified intent');
    await observeNative([b3]);
    assert.equal(requests.length, 4);
    steps.push('cold_unverified_original_intent_blocks_changed_key_and_new_id_without_replay');
    await stop();
    const namespaces = (await readdir(join(root, 'data'))).filter(name => name.startsWith('agent-teams-v2-key-'));
    assert.equal(namespaces.length, 3);
    const nativeKeys: string[] = [];
    for (const namespace of namespaces) {
      const database = new DatabaseSync(join(root, 'data', namespace, 'catalog.sqlite'), { readOnly: true });
      try {
        const rows = database.prepare('SELECT integration_id, value FROM credential').all();
        assert.equal(rows.length, 1, 'one native key effect per original credential intent');
        assert.equal(rows[0]!.integration_id, 'TEST-local', 'ambient migration never imports foreign keys');
        const credential = JSON.parse(String(rows[0]!.value)) as Record<string, unknown>;
        assert.equal(credential.type, 'key');
        assert.ok(credential.key === selectedKey || credential.key === rejectedKey);
        nativeKeys.push(credential.key as string);
        nativeCredentialCount += rows.length;
      } finally { database.close(); }
    }
    assert.deepEqual(nativeKeys.sort(), [rejectedKey, selectedKey, selectedKey].sort());
    for (const name of await readdir(join(root, 'store/management-commands'))) {
      const body = await readFile(join(root, 'store/management-commands', name), 'utf8');
      for (const key of [selectedKey, rejectedKey, foreignKey]) assert.equal(body.includes(key), false);
    }
    steps.push('selected_native_db_only_foreign_auth_preserved_secret_free_receipts');
    assert.ok(hosts.every(row => row.exitCode === 0 && row.signalCode === null && row.stdoutValid));
    assert.deepEqual(failures, []);
    observerCurrent();
    assert.equal(epochs.length, 4);
    assert.equal(metadataCount, 10);
    assert.ok(catalogs.length === 5 && catalogs.every(item => item.ready && item.released));
    assert.ok(probes.length === 4 && probes.every(item => item.native && item.directories));
    assert.ok(epochs.every(item => item.discarded || !item.line ||
      !metadataPrefix.startsWith(item.line) && !item.line.startsWith(metadataPrefix)), 'TEST incomplete metadata line');
    await assertNativeV1Build(repo, sourceHead, build);
    passed = true;
  } catch (error) { originalFailure = error; }
  finally {
    if (host) try { await host.close(); }
    catch (error) { cleanupErrors.push(error); }
    finally {
      // Keep the original failure evidence even when its cleanup cannot qualify.
      hosts.push(host.facts());
      host = undefined;
    }
    model.closeAllConnections();
    await new Promise<void>(done => model.close(() => done()));
    for (const pid of nativePids) try {
      assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
    } catch (error) { cleanupErrors.push(error); }
    if (failures.length) originalFailure ??= Error('TEST native key oracle refused request');
    if (metadataFailure) originalFailure ??= metadataFailure;
    cleanup = cleanupErrors.length === 0;
    if (cleanup) try { await rm(root, { recursive: true, force: true }); }
    catch (error) { cleanup = false; cleanupErrors.push(error); }
    try {
      await writeFile(receiptPath, JSON.stringify({ kind: 'TEST_NATIVE_V2_CREDENTIAL', sourceHead,
        status: passed && cleanup && !originalFailure ? 'PASS' : 'INCOMPLETE', cleanup, version: '2.1.4',
        digests, steps, requests, nativeCredentialCount, nativeProcessCount: nativePids.size,
        hosts: hosts.map(({ exitCode, signalCode, stdoutValid, diagnosticBytes }) =>
          ({ exitCode, signalCode, stdoutValid, diagnosticBytes })),
        passiveNativeDiagnostics: passive.flatMap(diagnostics => diagnostics.entries),
        vendorAuthQualified: false, desktopQualified: false, releaseQualified: false }, null, 2) + '\n', { mode: 0o600 });
    } catch (error) { cleanupErrors.push(error); }
  }
  if (originalFailure && cleanupErrors.length) throw new AggregateError([originalFailure, ...cleanupErrors], 'TEST credential and cleanup failed');
  if (originalFailure) throw originalFailure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'TEST credential cleanup failed');
});
