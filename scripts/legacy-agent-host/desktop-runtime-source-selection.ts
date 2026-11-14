/** Original visible source Install/Update/Repair, four native inputs and same-profile cold history. */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runtimeSourceRecordSchema } from '../../packages/legacy-agent-host/dist/adapters/profile/FileRuntimeSourceIndex.js';
import { runtimeCaptureSourceSchema } from '../../packages/legacy-agent-host/dist/composition/runtimeCaptureSource.js';
import { storedManagementCommandSchema } from '../../packages/legacy-agent-host/dist/management/commandRecords.js';
import { managementDigest } from '../../packages/legacy-agent-host/dist/management/identity.js';
import { deliveryFingerprint, normalizeBinding, runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { verifyOpenCodeV2EmbeddedGraph } from '../../packages/legacy-agent-host/dist/adapters/providers/OpenCodeV2EmbeddedGraph.js';
import { processFacts } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import { captureDesktopSourceMetadataLineage, desktopMetadataProfileHash } from './desktop-opencode-metadata-lineage.ts';
import type { DesktopSourceMetadataLineage } from './desktop-opencode-metadata-lineage.ts';
import { hostTeamSelectionKey } from '../../src/features/agent-backend/contracts/teamSelection.ts';
import { waitFor } from '../e2e/release-updater/cdp.mts';
import { fileDigest, prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import { openOriginalCreateForm } from './desktop-create-config-ui-smoke.ts';
import { readDesktopNativeHostProcesses, readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { linuxProcessIdentity, originalLinuxProcessPresent, startRetainedOpenCodeApp,
  testNamespaceLinuxProcesses } from './desktop-retained-opencode-app.ts';
import { SOURCE_SELECTION_MARKERS, startRetainedOpenCodeModel } from './desktop-retained-opencode-model.ts';
import { createDesktopUiControls, desktopJsLiteral as literal } from './desktop-ui-controls.ts';
import type { snapshotLinuxProcesses } from './desktop-retained-opencode-app.ts';
import type { RuntimeBinding, RuntimeDelivery } from '../../packages/legacy-agent-host/dist/runtime/contracts.js';

type Row = Record<string, unknown>;
type Source = ReturnType<typeof runtimeSourceRecordSchema.parse>;
type Fixture = Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
type App = Awaited<ReturnType<typeof startRetainedOpenCodeApp>>;
type Birth = ReturnType<typeof linuxProcessIdentity>;
type Marker = (typeof SOURCE_SELECTION_MARKERS)[number];
const A = '538fcb1b6408c8d4608822acee19f7ff5b3a3eb3383c0633c4f06170857312a7';
const B = '7df4e4136301f16589b0f30bf91a61380fca5f8ef22dd36570f5ebe1d4ec802c';
const record = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
const text = (value: unknown): string => { assert.equal(typeof value, 'string'); return value as string; };
const rows = (value: unknown): Row[] => { assert.ok(Array.isArray(value)); return value.map(record); };
const hash = (value: unknown): string => { const result = text(value); assert.match(result, /^[a-f0-9]{64}$/); return result; };
const binding = (value: unknown) => normalizeBinding(record(value) as unknown as RuntimeBinding);
const birthKey = (value: Birth) => `${value.pid}:${value.birth}`;

/** A discarded observation may be reread only by the existing bounded poll. */
class SnapshotChanged extends Error {}

/** Bounded original-file snapshots only; no Host store constructor or recovery is invoked. */
async function readJson(path: string, maximum = 8 * 1024 * 1024): Promise<Row> {
  const before = await lstat(path, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n &&
    before.size <= BigInt(maximum));
  assert.equal(await realpath(path), path);
  const same = (value: typeof before) => {
    assert.ok(value.isFile() && !value.isSymbolicLink() && value.nlink <= 1n &&
      value.size <= BigInt(maximum), 'original JSON path remains a bounded regular file');
    for (const key of ['dev', 'ino', 'size', 'mode', 'nlink', 'uid', 'mtimeNs', 'ctimeNs'] as const)
      if (value[key] !== before[key]) throw new SnapshotChanged('Original JSON snapshot changed');
  };
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    same(await file.stat({ bigint: true }));
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    assert.equal(BigInt(offset), before.size);
    same(await file.stat({ bigint: true })); same(await lstat(path, { bigint: true }));
    assert.equal(await realpath(path), path);
    return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))));
  } finally { await file.close(); }
}

async function originalCmdline(pid: number): Promise<string[]> {
  const file = await open('/proc/' + pid + '/cmdline', constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(8193);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    assert.ok(offset <= 8192, 'bounded original native command line');
    const argv = bytes.subarray(0, offset).toString('utf8').split('\0');
    if (argv.at(-1) === '') argv.pop();
    return argv;
  } finally { await file.close(); }
}

async function sourceIndex(root: string, allowMissing = false, observed?: () => void) {
  const path = join(root, 'hoststore/runtime-sources/index.json');
  try { await lstat(path); }
  catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return { records: [] as Source[], current: [] as Row[] };
    throw error;
  }
  const { digest, ...body } = await readJson(path);
  assert.equal(digest, runtimeDigest(body));
  assert.deepEqual(Object.keys(body).sort(), ['current', 'records', 'schemaVersion']);
  assert.equal(body.schemaVersion, 1);
  const records = rows(body.records).map(value => runtimeSourceRecordSchema.parse(value));
  const current = rows(body.current);
  assert.ok(records.length <= 1024 && current.length <= 256);
  assert.equal(new Set(records.map(value => value.revision)).size, records.length);
  assert.equal(new Set(records.map(value => value.commandId)).size, records.length);
  assert.equal(new Set(current.map(value => value.sourceId)).size, current.length);
  for (const { revision, ...selection } of records) assert.equal(revision, runtimeDigest(selection));
  for (const pointer of current) {
    assert.deepEqual(Object.keys(pointer).sort(), ['commandId', 'revision', 'sourceId']);
    const selected = records.find(value => value.revision === hash(pointer.revision));
    assert.ok(selected); assert.equal(selected.commandId, pointer.commandId);
    assert.equal(selected.grant.targetId, hash(pointer.sourceId));
  }
  observed?.();
  return { records, current };
}

async function managementRows(root: string) {
  const directory = join(root, 'hoststore/management-commands');
  const names = await readdir(directory);
  assert.ok(names.length <= 256, 'bounded original source/probe management journal');
  const selected = [];
  for (const name of names.filter(value => /^[a-f0-9]{64}\.json$/.test(value))) {
    const { digest, ...body } = await readJson(join(directory, name), 4 * 1024 * 1024);
    assert.equal(digest, managementDigest(body));
    const parsed = storedManagementCommandSchema.parse(body);
    assert.equal(name, managementDigest(parsed.commandId) + '.json'); selected.push(parsed);
  }
  return selected;
}

async function reservePort(port = 0) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function sessionIdentity(session: Row) {
  return { binding: binding(session.binding), profileId: session.profileId, config: session.config,
    openFingerprint: session.openFingerprint, sessionRef: session.sessionRef,
    hostIncarnation: session.hostIncarnation };
}

export async function runDesktopRuntimeSourceSelection(input: {
  repo: string; sourceHead: string; build: unknown; node: string; receiptPath: string;
  processBaseline: Awaited<ReturnType<typeof snapshotLinuxProcesses>>; assertSource(): void;
}) {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v24.21.0'); assert.equal(await realpath(process.execPath), input.node);
  const v2 = process.env.OPENCODE_V2_UI_SOURCE_SELECTION_GO === '1';
  assert.ok(!v2 || process.env.OPENCODE_V1_UI_SOURCE_SELECTION_GO !== '1');
  const inputsPath = (v2 ? process.env.OPENCODE_V2_UI_SOURCE_INPUTS_RECEIPT : process.env.OPENCODE_V1_UI_SOURCE_INPUTS_RECEIPT)!;
  assert.ok(inputsPath && isAbsolute(inputsPath));
  const inputs = await readJson(inputsPath, 64 * 1024), original = record(v2 ? inputs.v2 : inputs.v1), next = record(inputs.next);
  assert.equal(inputs.kind, v2 ? 'TEST_DESKTOP_V2_SOURCE_INPUTS' : 'TEST_DESKTOP_V1_SOURCE_INPUTS');
  assert.equal(inputs.status, 'READY');
  assert.equal(inputs.sourceHead, input.sourceHead);
  const versionA = v2 ? '2.0.21' : '1.19.4', versionB = v2 ? '2.3.0' : '1.19.5';
  const digestA = v2 ? hash(original.sha256) : A, digestB = v2 ? hash(next.executableSha256) : B;
  assert.equal(original.version, versionA); assert.equal(original.sha256, digestA);
  assert.equal(next.version, versionB); assert.equal(next.executableSha256, digestB);
  assert.equal(next.packageName, v2 ? '@opencode/cli-linux-x64' : 'opencode-linux-x64');
  const engine = v2 ? record(inputs.engine) : undefined, bun = engine && record(engine.bun);
  if (engine) assert.equal(engine.version, '2.1.4');
  assert.match(text(next.integrity), /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  const aPath = text(original.path), packages = text(original.packageDirectory);
  const corepack = record(inputs.corepack);
  assert.equal(corepack.version, '0.36.0');
  const immutablePins = [original, record(original.rootManifest), record(original.rootLauncher),
    record(original.nativeManifest), record(v2 ? original.packageLock : inputs.packageLock), corepack,
    ...(v2 ? [next, record(next.rootManifest), record(next.rootLauncher), record(next.nativeManifest),
      record(next.packageLock), bun!, record(engine!.manifest)] : [])];
  const verifyInputs = async () => {
    input.assertSource();
    for (const pin of immutablePins) {
      const path = text(pin.path);
      assert.equal(await realpath(path), path); assert.equal(await fileDigest(path), hash(pin.sha256));
    }
  };
  await verifyInputs();
  const model = await startRetainedOpenCodeModel({ sourceSelection: true });
  const namespaces: Row[] = [], steps: Row[] = [], originals = new Map<string, Birth>();
  const roots: string[] = [], installed = new Map<string, string>();
  const metadata = new Map<string, { root: string; lineage: DesktopSourceMetadataLineage }>();
  const proof: Row = { kind: 'TEST_NATIVE_OPENCODE_SOURCE_SELECTION_DESKTOP', sourceHead: input.sourceHead,
    generation: v2 ? 'v2' : 'v1',
    platform: 'linux-x64', status: 'INCOMPLETE', build: input.build, inputs, namespaces, steps,
    businessInputs: [...SOURCE_SELECTION_MARKERS], vendorAuthQualified: false, releaseQualified: false };
  let app: App | undefined, fixture: Fixture | undefined;
  let failure: unknown, passed = false, cleanup = false, epoch = 0;
  const cleanupErrors: string[] = [];
  const save = () => writeFile(input.receiptPath, JSON.stringify({ ...proof, cleanup,
    originalNativeBirths: [...originals.values()], metadataLineages: [...metadata.values()], modelObservations: model.observations,
    modelFailures: model.failures, cleanupErrors }, null, 2), { mode: 0o600 });
  const current = () => { assert.ok(app); app.assertCurrent(); assert.deepEqual(model.failures, []); };
  const remember = (values: Birth[]) => {
    for (const value of values) originals.set(birthKey(value), Object.freeze({ ...value }));
    assert.ok(originals.size <= 64, 'bounded actual original native births');
  };
  const observe = async () => {
    assert.ok(app); current();
    for (const path of [aPath, ...installed.keys(), ...(bun ? [text(bun.path)] : [])])
      remember(await app.nativeChildren(path));
  };
  const pins = async () => {
    assert.ok(fixture);
    assert.equal(await fileDigest(fixture.profilePath), fixture.pins.profileSha256);
    assert.equal(await fileDigest(fixture.descriptorPath), fixture.pins.descriptorSha256);
    assert.equal(await fileDigest(input.node), fixture.pins.nodeSha256);
    assert.equal(await fileDigest(fixture.hostEntry), fixture.pins.hostEntrySha256);
  };
  const released = async (root: string) => {
    assert.equal([...originals.values()].some(originalLinuxProcessPresent), false,
      'every retained original native birth is absent');
    assert.deepEqual(await testNamespaceLinuxProcesses(root, input.processBaseline), [],
      'no unmatched original TEST namespace child');
    for (const [key, value] of metadata) if (value.root === root) {
      const lineage = captureDesktopSourceMetadataLineage({ root, host: value.lineage.host,
        profileHashes: value.lineage.profileHashes, observed: processFacts(), executable: text(bun!.path),
        original: value.lineage, released: true });
      metadata.set(key, { root, lineage });
    }
    assert.ok([...metadata.values()].reduce((sum, value) => sum + value.lineage.events.length, 0) <= 128);
    const commands = await managementRows(root);
    assert.ok(commands.every(row => !row.resourceHeld), 'all original management cleanup debt settled');
    return commands.map(row => ({ commandId: row.commandId, kind: row.kind, phase: row.phase,
      resourceHeld: row.resourceHeld }));
  };
  try {
    await save();
    for (const initial of ['missing', 'path'] as const) {
      await verifyInputs();
      const memberPort = await reservePort(), metadataPort = await reservePort();
      assert.notEqual(memberPort, metadataPort); assert.equal(await reservePort(9222), 9222);
      const endpoint = `http://127.0.0.1:${memberPort}`;
      fixture = await prepareDesktopBackendFixture(input.repo, { pnpmEntry: text(corepack.path),
        seedUiTask: true, seedUiPreferences: true, creation: true,
        nativeOpenCodeSourceSelection: { packageDirectory: packages, executable: { path: aPath, sha256: digestA },
          modelUrl: model.url, endpoint, managementEndpoint: `http://127.0.0.1:${metadataPort}`, initial,
          ...(engine ? { v2: { bunPath: text(bun!.path), bunSha256: hash(bun!.sha256),
            engineDirectory: text(engine.directory) } } : {}) } });
      roots.push(fixture.root);
      const selectedFixture = fixture, root = fixture.root;
      const phase: Row = { initial, root, status: 'INCOMPLETE', memberPort, metadataPort,
        profileSha256: fixture.pins.profileSha256, descriptorSha256: fixture.pins.descriptorSha256 };
      namespaces.push(phase);
      const profile = await readJson(fixture.profilePath), owner = record(profile.owner);
      const descriptor = await readJson(fixture.descriptorPath), management = rows(descriptor.management);
      assert.equal(management.length, 1); assert.equal(management[0]!.projectPath, null);
      assert.equal(management[0]!.profileId, 'TEST-opencode-source-management');
      assert.equal(management[0]!.configRevision, 'TEST-opencode-management');
      const embeddedEntry = v2 ? await realpath(join(dirname(fixture.hostEntry), 'adapters/providers/OpenCodeV2EmbeddedChild.js')) : '';
      if (v2) immutablePins.push({ path: embeddedEntry, sha256: await fileDigest(embeddedEntry) });
      let retainedIndex: Awaited<ReturnType<typeof sourceIndex>> | undefined;
      let sourceMetadata: DesktopSourceMetadataLineage | undefined;
      const start = async () => {
        await pins(); assert.equal(await reservePort(9222), 9222);
        const value = await startRetainedOpenCodeApp({ repo: input.repo, root, node: input.node,
          env: selectedFixture.appEnvironment, port: 9222, epoch: ++epoch });
        phase.appEpochs = [...(phase.appEpochs as unknown[] ?? []),
          { epoch, original: value.original, electron: value.electron }];
        return value;
      };
      app = await start();
      let ui = createDesktopUiControls(app.cdp, {
        assertOwnedRenderer: current,
        step: value => { assert.ok(steps.length < 512); steps.push({ initial, epoch,
          monotonicMs: Math.round(performance.now()), ...value }); },
      });
      await ui.observeInput();
      const poll = <T>(read: () => Promise<T>, accepts: (value: T) => boolean, label: string) =>
        waitFor(async () => {
          current();
          try { const value = await read(); return accepts(value) ? { value } : null; }
          catch (error) { if (error instanceof SnapshotChanged) return null; throw error; }
        }, label, 90_000).then(result => result.value);
      const own = (value: unknown, key: string): unknown => value && typeof value === 'object'
        ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
      const bool = (value: unknown) => typeof value === 'boolean' ? value : null;
      const choice = (value: unknown, allowed: readonly string[]) =>
        typeof value === 'string' && allowed.includes(value) ? value : null;
      const eventKinds = ['Runtime.executionContextCreated', 'Runtime.executionContextDestroyed',
        'Runtime.executionContextsCleared', 'Runtime.exceptionThrown', 'Runtime.consoleAPICalled', 'Log.entryAdded',
        'Page.frameNavigated', 'Page.frameDetached', 'Page.loadEventFired', 'Inspector.detached', 'Inspector.targetCrashed'];
      const closedStatus = (value: unknown, purpose: string, attempt: number, expected?: string): Row => {
        const version = own(value, 'version'), revision = own(value, 'sourceRevision'), scope = own(value, 'scopeRevision');
        const revisionPresent = revision === null ? false : typeof revision === 'string' && revision.length > 0 ? true : null;
        return { purpose, attempt, present: value === null ? false : value && typeof value === 'object' && !Array.isArray(value) ? true : null,
          installed: bool(own(value, 'installed')), loading: bool(own(value, 'loading')),
          state: choice(own(value, 'state'), ['idle', 'checking', 'downloading', 'installing', 'ready', 'failed']),
          source: choice(own(value, 'source'), ['missing', 'path', 'override', 'app-managed', 'captured-host']),
          version: typeof version !== 'string' || !version ? null : version === versionA ? 'a' : version === versionB ? 'b' : version === '2.1.4' ? 'engine' : 'other',
          revisionPresent, revisionMatches: expected === undefined || revisionPresent === null ? null : revision === expected,
          scopeRevision: typeof scope === 'number' && Number.isSafeInteger(scope) && scope >= 0 ? scope : null };
      };
      let statusAttempts = 0, statusAttemptOverflow = false, statusFailureCaptured = false, lastStatus: Row | null = null;
      let lastStatusOwner: App | undefined;
      const status = async (purpose: 'published-source' | 'missing-before-install' | 'path-before-support' |
        'path-before-refresh' | 'repair-before-confirm' | 'repair-completion', expectedRevision?: string) => {
        if (statusAttempts < 1024) statusAttempts++; else statusAttemptOverflow = true;
        const attempt = statusAttempts, captured = app!, events = captured.cdp.events, offset = events.length;
        const prefix = events[offset - 1], started = performance.now();
        if (lastStatusOwner !== captured) { lastStatus = null; lastStatusOwner = captured; }
        try {
          const value = await captured.cdp.evaluate<Row | null>(`(()=>{
        const s=window.__agentTeamsDevStore?.getState().openCodeRuntimeStatus;
        return s?{installed:s.installed,source:s.source,state:s.state,version:s.version??null,
          sourceRevision:s.sourceRevision??null,updateAvailable:s.updateAvailable??false,
          engineVersion:s.engineVersion??null,v2Support:s.v2Support??null,maintenance:s.v2Maintenance??null,
          loading:window.__agentTeamsDevStore.getState().openCodeRuntimeStatusLoading,
          scopeRevision:window.__agentTeamsDevStore.getState().cliProviderStatusScopeRevision}:null})()`);
          try { lastStatus = closedStatus(value, purpose, attempt, expectedRevision); } catch { lastStatus = null; }
          return value;
        } catch (error) {
          if (!statusFailureCaptured) {
            statusFailureCaptured = true;
            try {
              const interval = captured.cdp.events === events && events.length >= offset &&
                (offset === 0 || events[offset - 1] === prefix);
              const count = interval ? events.length - offset : null, elapsed = performance.now() - started;
              const message = own(error, 'message');
              const observation = { purpose, attempt, attemptOverflow: statusAttemptOverflow,
                elapsedMs: Math.max(0, Math.min(900000, Math.round(elapsed))), elapsedCapped: elapsed > 900000,
                reportedError: message === 'CDP timeout: Runtime.evaluate' ? 'cdp-timeout' : message === 'Native CDP closed' ? 'cdp-closed' : 'other',
                lastResult: lastStatus, eventCount: count === null ? null : Math.min(count, 1024),
                eventCountOverflow: count === null ? null : count > 1024, eventsTruncated: count === null ? null : count > 16,
                eventKinds: count === null ? null : events.slice(Math.max(offset, events.length - 16))
                  .map(event => choice(own(event, 'method'), eventKinds) ?? 'other') };
              phase.statusFailureObservation = Buffer.byteLength(JSON.stringify(observation), 'utf8') <= 2048 ? observation : { unavailable: true };
            } catch { phase.statusFailureObservation = { unavailable: true }; }
          }
          throw error;
        }
      };
      const openSettings = async () => {
        await ui.click('button[aria-label="More actions"]', 'open original Settings menu');
        await ui.click('button', 'open original Settings', 'Settings');
        await ui.scrollTo('[data-testid="settings-nav-providers"]', 'original Providers tab');
        await ui.click('[data-testid="settings-nav-providers"]', 'open original Providers tab');
        await ui.waitRead(`Boolean(document.querySelector('[data-testid="provider-settings-page"]'))`,
          'original Providers page');
        const expand = '[role="button"][aria-label="Expand provider details"]';
        if (await app!.cdp.evaluate<boolean>(`Boolean(document.querySelector(${literal(expand)}))`)) {
          await ui.scrollTo(expand, 'original provider status details');
          await ui.click(expand, 'expand original provider status details');
        }
      };
      const card = '[data-testid="provider-settings-page"] div.grid:has(> div > div > button[data-testid="runtime-manage-opencode"])';
      const maintenance = async (label: string) => {
        await ui.scrollTo(card + ' button', 'original OpenCode maintenance control', label);
        await ui.click(card + ' button', 'one original OpenCode maintenance action', label);
      };
      const census = async () => {
        assert.ok(v2 && bun && retainedIndex);
        current();
        const before = await sourceIndex(root), commands = await managementRows(root);
        assert.deepEqual(before, retainedIndex, 'no source publication during the physical witness');
        if (commands.some(row => row.resourceHeld)) throw new SnapshotChanged('Original management cleanup is pending');
        const captured = readDesktopNativeHostProcesses(selectedFixture, app!.original.group);
        const natives = await app!.nativeChildren(text(bun.path)); remember(natives);
        const lineage = captureDesktopSourceMetadataLineage({ root, host: captured.host,
          profileHashes: before.records.map(row => desktopMetadataProfileHash({
            profileId: 'runtime-source:' + row.revision, configRevision: 'runtime-source:' + row.revision })),
          observed: processFacts(), executable: text(bun.path), ...(sourceMetadata ? { original: sourceMetadata } : {}) });
        const direct = natives.filter(row => row.ppid === captured.host.pid);
        assert.deepEqual(direct.map(row => row.pid).sort(), captured.children
          .filter(row => row.command === bun.path).map(row => row.pid).sort());
        for (const native of direct) {
          assert.equal(originalLinuxProcessPresent(native), true); assert.equal(native.group, native.pid);
          assert.deepEqual(await originalCmdline(native.pid),
            [text(bun.path), '--no-env-file', '--config=/dev/null', '--no-install', embeddedEntry]);
          assert.equal(originalLinuxProcessPresent(native), true);
        }
        for (const birth of lineage.live) {
          const native = direct.find(row => row.pid === birth.pid); assert.ok(native);
          const ready = lineage.events.find(row => row.pid === birth.pid && row.stage === 'ready'); assert.ok(ready);
          assert.equal(ready.startIdentityHash, createHash('sha256').update(birthKey(native)).digest('hex'),
            'actual Linux pid:startTicks, never ps lstart');
        }
        assert.deepEqual(await sourceIndex(root), before); current();
        if (runtimeDigest(await managementRows(root)) !== runtimeDigest(commands))
          throw new SnapshotChanged('Original management snapshot changed');
        sourceMetadata = lineage;
        metadata.set(`${root}:${captured.host.pid}:${captured.host.birth}`, { root, lineage });
        assert.ok([...metadata.values()].reduce((sum, value) => sum + value.lineage.events.length, 0) <= 128);
        return direct.filter(row => !lineage.live.some(value => value.pid === row.pid));
      };
      const support = async (selected: Source) => {
        const embedded = selected.candidate.embedded; assert.ok(embedded);
        assert.equal(embedded.version, '2.1.4'); assert.equal(embedded.manifestSha256, hash(engine!.manifestSha256));
        assert.ok(embedded.directory.startsWith(join(root, 'userData/data/runtimes/opencode-v2') + '/'));
        await verifyOpenCodeV2EmbeddedGraph(embedded);
        const receipt = await readJson(join(dirname(embedded.directory), 'installed.json'), 4096);
        assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.instance, basename(embedded.directory));
        assert.equal(receipt.manifestSha256, embedded.manifestSha256);
        return { embedded, receipt };
      };
      const selection = async (version: string | null, count: number) => {
        let indexObserved = false;
        let originalSelection: { commandId: string; revision: string } | undefined;
        const { index, selected, command } = await poll(async () => {
          const index = await sourceIndex(root, count === 1 && !indexObserved, () => { indexObserved = true; });
          const selected = index.current.length === 1
            ? index.records.find(row => row.revision === index.current[0]!.revision) : undefined;
          if (originalSelection) {
            assert.ok(selected, 'original publication remains selected');
            assert.equal(selected.commandId, originalSelection.commandId);
            assert.equal(selected.revision, originalSelection.revision);
          } else if (selected !== undefined && index.records.length === count && (version === null ? selected.intent === 'configuration' : selected.candidate.nativeCli?.version === version)) {
            originalSelection = { commandId: selected.commandId, revision: selected.revision };
          }
          const command = selected !== undefined && index.records.length === count && (version === null ? selected.intent === 'configuration' : selected.candidate.nativeCli?.version === version)
            ? (await managementRows(root)).find(row => row.commandId === selected.commandId) : undefined;
          return { index, selected, command };
        }, value => value.index.records.length === count && value.index.current.length === 1 &&
          (version === null ? value.selected?.intent === 'configuration' : value.selected?.candidate.nativeCli?.version === version) && value.command?.kind === 'runtime.source' &&
          value.command.phase === 'published' && value.command.resourceHeld === false,
        'original native source publication');
        assert.ok(selected);
        assert.equal(selected.intent, version === null ? 'configuration' : undefined);
        if (retainedIndex) assert.deepEqual(index.records.slice(0, retainedIndex.records.length), retainedIndex.records);
        retainedIndex = index;
        assert.equal(selected.grant.ownerId, owner.ownerId); assert.equal(selected.grant.ownerRevision, owner.revision);
        assert.equal(selected.grant.contextId, 'local'); assert.equal(selected.grant.projectPath, null);
        assert.equal(selected.grant.runtimeId, 'opencode');
        assert.equal(selected.grant.profileId, 'TEST-opencode-source-management');
        assert.equal(selected.grant.configRevision, 'TEST-opencode-management');
        const cli = selected.candidate.nativeCli;
        if (version === null) {
          assert.equal(cli, undefined); assert.equal(selected.candidate.sourceKind, 'captured');
          assert.ok(selected.candidate.openCodeConfiguration); assert.equal(selected.candidate.embedded, undefined);
        } else {
          assert.ok(cli); assert.equal(cli.generation, v2 ? 'v2' : 'v1'); assert.equal(cli.version, version);
          assert.equal(cli.executable.sha256, version === versionA ? digestA : digestB);
          assert.equal(await realpath(cli.executable.path), cli.executable.path);
          assert.equal(await fileDigest(cli.executable.path), cli.executable.sha256);
          if (version === versionA) {
            assert.equal(selected.candidate.sourceKind, 'path'); assert.equal(cli.executable.path, aPath);
          } else {
            assert.equal(selected.candidate.sourceKind, 'app-managed');
            const manifest = await readJson(join(root, 'userData/data/runtimes/opencode/current.json'), 64 * 1024);
            assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.version, versionB);
            assert.equal(manifest.platformPackage, next.packageName); assert.equal(manifest.integrity, next.integrity);
            assert.equal(await realpath(text(manifest.binaryPath)), cli.executable.path);
            assert.ok(cli.executable.path.startsWith(join(root, 'userData/data/runtimes/opencode') + '/'));
            installed.set(cli.executable.path, digestB); phase.installedManifest = manifest;
          }
          if (v2) phase.support = await support(selected);
          else { assert.deepEqual(selected.candidate.executable, cli.executable); assert.equal(selected.candidate.embedded, undefined); }
        }
        if (v2) assert.deepEqual(selected.candidate.executable, { path: bun!.path, sha256: bun!.sha256 });
        assert.ok(command?.kind === 'runtime.source'); assert.equal(command.phase, 'published');
        assert.equal(command.resourceHeld, false); assert.equal(command.nativeVersion, version ?? undefined);
        assert.equal(command.sourceId, selected.grant.targetId); assert.equal(command.revision, selected.revision);
        assert.equal(command.expectedRevision, selected.previousRevision);
        const publication = record(JSON.parse(command.publicationJson!));
        assert.deepEqual(publication.grant, selected.grant); assert.deepEqual(publication.candidate, selected.candidate);
        assert.equal(publication.commandId, command.commandId);
        assert.equal(publication.expectedRevision, selected.previousRevision);
        assert.equal(command.fingerprint, runtimeDigest(publication));
        phase.currentStatus = await poll(() => status('published-source', selected.revision), value => value?.installed === true &&
          value.state === 'ready' && value.version === (version ?? '2.1.4') && value.sourceRevision === selected.revision &&
          (!v2 || (value.engineVersion === '2.1.4' && value.v2Support === 'ready')),
          'original visible runtime status follows the published source');
        await observe(); await pins();
        return { index, selected, command };
      };
      const memberBirth = async (selected: Source) => {
        if (v2) return (await poll(census, values => values.length === 1,
          'one original member Bun after subtracting proved metadata births'))[0]!;
        const path = selected.candidate.nativeCli!.executable.path;
        const found = await poll(async () => {
          await observe(); const candidates = await app!.nativeChildren(path); remember(candidates);
          const matches: Birth[] = [];
          for (const candidate of candidates) {
            if (!originalLinuxProcessPresent(candidate)) continue;
            let argv: string[];
            try { argv = await originalCmdline(candidate.pid); }
            catch (error) {
              if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '') &&
                  !originalLinuxProcessPresent(candidate)) continue;
              throw error;
            }
            if (!originalLinuxProcessPresent(candidate)) continue;
            if (argv.length === 6 && argv[0] === path && argv[1] === 'serve' &&
                argv[2] === '--hostname' && argv[3] === '127.0.0.1' && argv[4] === '--port' &&
                argv[5] === String(memberPort)) matches.push(candidate);
          }
          assert.ok(matches.length <= 1, 'one original member endpoint, separate from metadata');
          return matches;
        }, value => value.length === 1, 'actual selected member executable and fixed endpoint');
        return found[0]!;
      };
      const teamState = (name: string) => readJson(join(root, 'hoststore/teams', name, '.host-owner/state.json'));
      const launchRecord = (name: string, launchId: string) =>
        readJson(join(root, 'hoststore/teams', name, '.host-owner/launches', runtimeDigest(launchId) + '.json'));
      const session = async (launchId: string, expectedInputs: number, stopped = false) => {
        const values = await poll(() => readDesktopNativeStopSessions(root),
          value => value.filter(row => record(row.binding).runId === launchId).length === 1 &&
            value.filter(row => record(row.binding).runId === launchId).every(row =>
              rows(row.inputs).length === expectedInputs && rows(row.inputs).every(item =>
                item.phase === 'terminal' && item.terminal === 'succeeded') &&
              (stopped ? row.phase === 'closed' && row.custody === 'released' :
                row.phase === 'allocated' && row.custody === 'owned' && row.nativeReady === true)),
          stopped ? 'original Runtime Stop release' : 'original native input terminal');
        const result = values.find(row => record(row.binding).runId === launchId)!;
        const inputs = rows(result.inputs);
        assert.equal(new Set(inputs.map(row => record(row.intent).inputId)).size, expectedInputs);
        assert.equal(new Set(inputs.map(row => row.operationRef)).size, expectedInputs);
        for (const row of inputs) {
          const intent = record(row.intent);
          assert.deepEqual(binding(intent.binding), binding(result.binding));
          for (const key of ['deliveryId', 'inputId', 'messageId', 'content']) assert.ok(text(intent[key]));
          assert.ok(text(row.operationRef));
          assert.equal(row.fingerprint, deliveryFingerprint(intent as unknown as RuntimeDelivery));
        }
        assert.ok(record(result.config)); assert.equal(result.sealed, stopped);
        assert.ok(text(result.sessionRef)); assert.match(text(result.openFingerprint), /^[a-f0-9]{64}$/);
        return result;
      };
      const showTeam = async (key: string) => {
        await ui.click('button[aria-label="More actions"]', 'open original Teams menu');
        await ui.click('button', 'open original Teams list', 'Teams');
        const selector = `[data-team-name=${JSON.stringify(key)}][role="button"]`;
        await ui.scrollTo(selector, 'original captured Team card');
        await ui.click(selector, 'open original captured Team');
        await ui.click('button[aria-label^="lead,"]', 'open original lead thread');
      };
      const readData = async (key: string) => {
        const data = record(await app!.call(`window.__TEST_retainedApi.teams.getData(${literal(key)})`));
        assert.ok(Array.isArray(data.tasks) && Array.isArray(data.messages));
        return data;
      };
      const prepareCreate = async (name: string) => {
        await openOriginalCreateForm(app!.cdp, ui, join(root, 'workspace'), name);
        assert.equal((await readdir(join(root, 'hoststore/teams'))).includes(name), false);
        const lead = '[data-testid="create-team-page"] button[aria-label*=" provider,"]';
        await ui.scrollTo(lead, 'original Create lead model');
        await ui.click(lead, 'expand original Create lead model');
      };
      const create = async (name: string, marker: Marker, selected: Source, prepared = false) => {
        if (!prepared) await prepareCreate(name);
        const provider = '[data-testid="create-team-page"] [data-testid="team-model-selector-provider-nav-opencode"]';
        await ui.scrollTo(provider, 'original OpenCode provider');
        await ui.click(provider, 'select original OpenCode provider');
        const option = '[data-testid="create-team-page"] [data-testid="team-model-selector-model-option"][aria-label^="TEST-model"]';
        await ui.scrollTo(option, 'original TEST-model');
        await ui.click(option, 'select original TEST-model');
        const optional = record(await ui.waitRead(`(()=>{
          const values=[...document.querySelectorAll('[data-testid="create-team-page"] button[aria-controls]')]
            .filter(e=>e.textContent.includes('Optional launch settings'));
          return values.length===1?{id:values[0].getAttribute('aria-controls'),
            expanded:values[0].getAttribute('aria-expanded')}:null})()`, 'original Create optional settings'));
        if (optional.expanded !== 'true') {
          const selector = `[data-testid="create-team-page"] button[aria-controls=${JSON.stringify(optional.id)}]`;
          await ui.scrollTo(selector, 'original Create details');
          await ui.click(selector, 'expand original Create details');
        }
        const prompt = '[data-testid="create-team-page"] #team-prompt';
        await ui.scrollTo(prompt, 'original Create initial prompt');
        await ui.click(prompt, 'focus original Create initial prompt');
        await app!.cdp.send('Input.insertText', { text: marker });
        await ui.waitRead(`document.querySelector(${literal(prompt)})?.value===${literal(marker)}`,
          'original initial prompt retained');
        assert.equal(await app!.cdp.evaluate(`document.querySelector('[data-testid="create-team-page"] #launch-team')?.getAttribute('data-state')`), 'checked');
        if (v2) await poll(census, values => values.length === 0, 'zero unclassified Bun before original Create');
        model.expectSourceInput(marker);
        await ui.scrollTo('[data-testid="create-team-page"] button', 'original Create submit', 'Create');
        await ui.click('[data-testid="create-team-page"] button', 'one original Create and initial input', 'Create');
        await ui.waitRead(`!document.querySelector('[data-testid="create-team-page"] #team-name')`,
          'original Create closes after admitted launch', 90_000);
        const state = await poll(() => teamState(name), value => rows(value.runtimeCaptures).length === 1,
          'one original created capture');
        const registration = rows(state.runtimeCaptures)[0]!, launchId = text(registration.launchId);
        const saved = record(state.savedSettings);
        assert.equal(saved.providerId, 'opencode'); assert.equal(saved.model, 'test-local/TEST-model');
        assert.equal(saved.prompt, marker); assert.equal(saved.cwd, join(root, 'workspace'));
        assert.ok(saved.allowExperimentalLocalModels === undefined || saved.allowExperimentalLocalModels === false,
          'test-local uses original completed Host readiness without a local-model override');
        const runtime = await session(launchId, 1);
        const launch = await launchRecord(name, launchId), definition = record(launch.definition);
        assert.equal(launch.fingerprint, runtimeDigest(definition)); assert.equal(definition.launchId, launchId);
        assert.ok(typeof launch.startedAtMs === 'number' && launch.startedAtMs > 0 && text(launch.startCommandId));
        assert.equal(rows(definition.members).length, 1); assert.equal(rows(launch.members).length, 1);
        const expected = rows(definition.members)[0]!;
        assert.deepEqual(binding(expected.binding), binding(runtime.binding));
        const source = runtimeCaptureSourceSchema.parse(definition.capture);
        assert.equal(source.commandId, registration.commandId);
        assert.equal(source.configurationRevision, registration.configurationRevision);
        assert.deepEqual(source.recipeSources, [{ memberId: expected.memberId,
          sourceId: selected.grant.targetId, revision: selected.revision }]);
        assert.equal(source.members.length, 1); assert.equal(source.members[0]!.role, 'lead');
        assert.deepEqual(source.savedSettings, saved);
        const attempts = rows(rows(launch.members)[0]!.attempts);
        assert.equal(attempts.length, 1); assert.equal(attempts[0]!.status, 'ready');
        assert.equal(attempts[0]!.nativeReady, true); assert.equal(attempts[0]!.contextApplied, true);
        const initialInput = rows(runtime.inputs)[0]!, intent = record(initialInput.intent);
        assert.ok(text(intent.content).includes(marker));
        assert.deepEqual(binding(intent.binding), binding(runtime.binding));
        const registry = join(root, 'hoststore/.host-team-registry/records');
        const names = await readdir(registry);
        assert.ok(names.length <= 8);
        const entries = await Promise.all(names.filter(value => /^[a-f0-9]{64}\.json$/.test(value))
          .map(value => readJson(join(registry, value), 2 * 1024 * 1024)));
        const matching = entries.filter(value => record(value.record).teamName === name);
        assert.equal(matching.length, 1); assert.equal(matching[0]!.phase, 'published');
        const handle = text(record(record(matching[0]!.record).binding).handleId), key = hostTeamSelectionKey(handle);
        const native = await memberBirth(selected);
        assert.equal(model.observations.filter(value => value.marker === marker).length, 1);
        await ui.click('button[aria-label^="lead,"]', 'open created original lead thread');
        await ui.waitRead(`document.body.innerText.includes(${literal('REPLY_' + marker)})`,
          'actual first native reply visible', 90_000);
        const result = { name, key, marker, registration, launch, runtime, native, source: selected };
        phase.teams = [...(phase.teams as unknown[] ?? []), result]; await pins(); await save();
        return result;
      };
      const stop = async (team: Awaited<ReturnType<typeof create>>, count: number) => {
        await ui.scrollTo('button[aria-label="Stop"]', 'original Team Stop');
        await ui.click('button[aria-label="Stop"]', 'Stop original Team once', 'Stop');
        const final = await session(text(team.registration.launchId), count, true);
        assert.deepEqual(sessionIdentity(final), sessionIdentity(team.runtime));
        await poll(async () => originalLinuxProcessPresent(team.native), value => !value,
          'original member birth absent before another capture');
        return { runtime: final, history: await readData(team.key) };
      };
      if (v2) {
        await openSettings();
        phase.configuration = await selection(null, 1);
        await poll(census, values => values.length === 0, 'original configuration metadata before Install');
        for (const folder of ['opencode', 'opencode-v2'])
          await assert.rejects(lstat(join(root, 'userData/data/runtimes', folder)), { code: 'ENOENT' });
      } else assert.deepEqual(await sourceIndex(root, true), { records: [], current: [] });
      if (initial === 'missing') {
        if (!v2) await openSettings();
        const missing = await poll(() => status('missing-before-install'), value => v2 ? value?.maintenance != null && record(value.maintenance).kind === 'missing' :
          value?.installed === false && value.source === 'missing', 'original stock discovery is missing before Install');
        phase.before = missing; await observe();
        await maintenance(v2 ? 'Install V2 2.1.4' : 'Install OpenCode V1');
        const selected = await selection(versionB, v2 ? 2 : 1); phase.publication = selected;
        const team = await create('test-source-install-b', SOURCE_SELECTION_MARKERS[0], selected.selected);
        phase.stopped = await stop(team, 1);
      } else {
        if (v2) {
          phase.before = await poll(() => status('path-before-support'), value => value?.maintenance != null &&
            record(value.maintenance).kind === 'installed' && record(value.maintenance).cliVersion === versionA &&
            record(value.maintenance).support === 'required', 'genuine PATH A needs support before first Install');
          await maintenance('Finish OpenCode V2 setup');
        } else {
          await prepareCreate('test-source-path-a');
          phase.before = await poll(() => status('path-before-refresh'), value => value?.installed === true && value.source === 'path' &&
            value.version === versionA, 'original PATH A is Ready before healthy Refresh');
          await observe();
          const refresh = '[data-testid="create-team-page"] [data-testid="team-model-selector-refresh-providers"]';
          await ui.scrollTo(refresh, 'original healthy Create Refresh');
          await ui.click(refresh, 'one original healthy Create Refresh');
        }
        const selectedA = await selection(versionA, v2 ? 2 : 1); phase.publicationA = selectedA;
        const teamA = await create('test-source-path-a', SOURCE_SELECTION_MARKERS[1], selectedA.selected, !v2);
        const aInputs = rows(teamA.runtime.inputs);
        await openSettings();
        await maintenance(`Update v${versionA} → v${versionB}`);
        const selectedB = await selection(versionB, v2 ? 3 : 2); phase.publicationB = selectedB;
        assert.deepEqual(selectedB.index.records.slice(0, selectedA.index.records.length), selectedA.index.records);
        assert.equal(selectedB.selected.previousRevision, selectedA.selected.revision);
        assert.equal(originalLinuxProcessPresent(teamA.native), true, 'live A survives B source publication');
        assert.deepEqual(await launchRecord(teamA.name, text(teamA.registration.launchId)), teamA.launch);
        const afterPublish = await session(text(teamA.registration.launchId), 1);
        assert.deepEqual(sessionIdentity(afterPublish), sessionIdentity(teamA.runtime));
        assert.deepEqual(afterPublish.inputs, aInputs);
        if (v2) {
          const beforeRepair = await support(selectedB.selected);
          assert.deepEqual(beforeRepair, await support(selectedA.selected), 'healthy update retains the same support instance');
          await maintenance('Reinstall V2 support');
          await ui.waitRead("Boolean(document.querySelector('[data-testid=\"opencode-v2-reinstall-dialog\"]'))", 'original support Repair dialog');
          const beforeStatus = record(await status('repair-before-confirm')); assert.equal(beforeStatus.loading, false);
          assert.ok(Number.isSafeInteger(beforeStatus.scopeRevision));
          await ui.click('[data-testid="opencode-v2-reinstall-confirm"]', 'one original healthy support Repair confirmation');
          await ui.waitRead("!document.querySelector('[data-testid=\"opencode-v2-reinstall-dialog\"]')", 'original Repair dialog closes');
          const completed = await poll(() => status('repair-completion'), value => value?.loading === false &&
            value.scopeRevision === Number(beforeStatus.scopeRevision) + 1, 'original Repair operation completes');
          assert.equal(completed?.state, 'ready'); assert.equal(completed?.sourceRevision, selectedB.selected.revision);
          assert.deepEqual(await sourceIndex(root), selectedB.index); assert.deepEqual(await support(selectedB.selected), beforeRepair);
          assert.equal(await fileDigest(selectedB.selected.candidate.nativeCli!.executable.path), digestB);
          assert.deepEqual((await managementRows(root)).find(row => row.commandId === selectedB.command!.commandId), selectedB.command);
          assert.deepEqual(await memberBirth(selectedA.selected), teamA.native);
          phase.repair = { verified: true, newInstance: false, samePublication: true, support: beforeRepair, completed };
        }
        await showTeam(teamA.key);
        const composer = '.message-composer-flat-layout textarea', marker = SOURCE_SELECTION_MARKERS[2];
        await ui.scrollTo(composer, 'original A Composer'); await ui.click(composer, 'focus original A Composer');
        await app.cdp.send('Input.insertText', { text: marker });
        await ui.waitRead(`document.querySelector(${literal(composer)})?.value===${literal(marker)}`,
          'one original A continuation draft');
        model.expectSourceInput(marker);
        await ui.click('button.message-composer-send-button', 'one original A Send after update', 'Send');
        await ui.waitRead(`document.querySelector(${literal(composer)})?.value===''`, 'original A input accepted');
        const continued = await session(text(teamA.registration.launchId), 2);
        assert.deepEqual(sessionIdentity(continued), sessionIdentity(teamA.runtime));
        assert.deepEqual(rows(continued.inputs)[0], aInputs[0]);
        assert.ok(text(record(rows(continued.inputs)[1]!.intent).content).includes(marker));
        assert.equal(originalLinuxProcessPresent(teamA.native), true);
        assert.deepEqual(await memberBirth(selectedA.selected), teamA.native);
        assert.equal(model.observations.filter(value => value.marker === marker).length, 1);
        await ui.waitRead(`document.body.innerText.includes(${literal('REPLY_' + marker)})`,
          'same original A native continuation visible', 90_000);
        phase.retainedAAfterUpdate = { runtime: continued, native: teamA.native };
        const stoppedA = await stop(teamA, 2);
        const teamB = await create('test-source-update-b', SOURCE_SELECTION_MARKERS[3], selectedB.selected);
        assert.notDeepEqual(binding(teamB.runtime.binding), binding(teamA.runtime.binding));
        assert.notEqual(teamB.runtime.sessionRef, teamA.runtime.sessionRef);
        assert.notEqual(birthKey(teamB.native), birthKey(teamA.native));
        const stoppedB = await stop(teamB, 1);
        phase.stopped = { A: stoppedA, B: stoppedB };
        const indexBeforeCold = await sourceIndex(root), callsBeforeCold = model.observations.length;
        if (v2) await poll(census, values => values.length === 0, 'warm metadata accounted before Quit');
        await observe(); await pins(); await app.close(); app = undefined;
        phase.warmCleanup = await released(root); await verifyInputs();
        sourceMetadata = undefined;
        app = await start();
        ui = createDesktopUiControls(app.cdp, { assertOwnedRenderer: current,
          step: value => { assert.ok(steps.length < 512); steps.push({ initial, epoch, ...value }); } });
        await ui.observeInput();
        for (const [team, stopped] of [[teamA, stoppedA], [teamB, stoppedB]] as const) {
          await showTeam(team.key);
          await ui.waitRead(`document.body.innerText.includes(${literal('REPLY_' + team.marker)})`,
            'same-profile cold UI retains original reply', 90_000);
          const data = await readData(team.key);
          assert.deepEqual(data.tasks, stopped.history.tasks); assert.deepEqual(data.messages, stopped.history.messages);
          const retained = await session(text(team.registration.launchId), team === teamA ? 2 : 1, true);
          assert.deepEqual(sessionIdentity(retained), sessionIdentity(stopped.runtime));
          assert.deepEqual(retained.inputs, stopped.runtime.inputs);
          assert.deepEqual(await launchRecord(team.name, text(team.registration.launchId)), team.launch);
        }
        if (v2) await poll(census, values => values.length === 0, 'cold metadata never creates a member');
        assert.deepEqual(await sourceIndex(root), indexBeforeCold);
        assert.equal(model.observations.length, callsBeforeCold, 'cold readback never replays a native input');
        phase.cold = { originalProfile: true, historyEqual: true, callsBefore: callsBeforeCold,
          callsAfter: model.observations.length, sourceIndex: indexBeforeCold };
      }
      if (v2) await poll(census, values => values.length === 0, 'original metadata accounted before Quit');
      await observe(); await pins(); await app.close(); app = undefined;
      phase.cleanup = await released(root); await verifyInputs(); phase.status = 'PASS'; await save();
    }
    assert.deepEqual([...model.markers], [...SOURCE_SELECTION_MARKERS]);
    assert.equal(model.observations.filter(value => value.marker).length, 4);
    assert.ok(model.observations.length <= 32);
    assert.ok(model.observations.filter(value => value.marker === null).every(value => value.sourcePreflight));
    assert.deepEqual(model.failures, []);
    for (const [path, expected] of installed) assert.equal(await fileDigest(path), expected);
    passed = true;
  } catch (error) {
    failure = error; proof.failure = error instanceof Error ? error.message : String(error);
    if (error instanceof AggregateError && /original app cleanup unknown/.test(error.message))
      cleanupErrors.push('Original startup custody remains unknown');
  } finally {
    if (app) {
      try {
        if (originalLinuxProcessPresent(app.original) && originalLinuxProcessPresent(app.electron)) await observe();
      } catch (error) { cleanupErrors.push(String(error)); }
      try { if (!await app.cleanup()) cleanupErrors.push('Original app cleanup unknown'); }
      catch (error) { cleanupErrors.push(String(error)); }
      app = undefined;
    }
    for (const root of roots) {
      try { await released(root); }
      catch (error) { cleanupErrors.push(String(error)); }
    }
    try { await model.close(); } catch (error) { cleanupErrors.push(String(error)); }
    cleanup = cleanupErrors.length === 0;
    proof.status = passed && cleanup ? 'PASS' : 'INCOMPLETE';
    await save();
  }
  if (failure) throw failure;
  assert.ok(passed && cleanup, 'original UI source selection and complete cleanup');
}
