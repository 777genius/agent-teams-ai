/** One explicit real Codex Update with retained A, fresh B and a zero-input cold successor. */
import assert from 'node:assert/strict';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { runtimeSourceRecordSchema } from '../../packages/legacy-agent-host/dist/adapters/profile/FileRuntimeSourceIndex.js';
import { runtimeCaptureSourceSchema } from '../../packages/legacy-agent-host/dist/composition/runtimeCaptureSource.js';
import { storedManagementCommandSchema } from '../../packages/legacy-agent-host/dist/management/commandRecords.js';
import { managementDigest } from '../../packages/legacy-agent-host/dist/management/identity.js';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { captureCodexCodeModeProcess, observeCodexCodeModeProcess } from '../../packages/legacy-agent-host/tests/fixtures/codex-native-closure.ts';
import { assertOwnedCdpListener, command, groupMembers, portOccupied, processTable } from './desktop-backend-observations.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { captureDesktopNativeExecutable, connectCapturedDesktopApp, selectedDesktopRuntime, verifyCapturedDesktopBinding } from './desktop-captured-app.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { bounded } from './desktop-proof-bounds.ts';
import { checkpoint, digest, record } from './desktop-resume-records.ts';
import { revealDesktopReply } from './desktop-reply-visibility.ts';
import { attachRendererDiagnostics } from './desktop-team-ui-smoke.ts';
import { createDesktopUiControls, desktopJsLiteral as literal } from './desktop-ui-controls.ts';
import type { restartCapturedDesktopApp } from './desktop-captured-app.ts';
import type { prepareDesktopProofFixture } from './desktop-proof-fixture.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { startCodexModel } from '../../packages/legacy-agent-host/tests/fixtures/native-codex-team/model.ts';

type Row = Record<string, unknown>;
type Fixture = Awaited<ReturnType<typeof prepareDesktopProofFixture>>;
type Model = Awaited<ReturnType<typeof startCodexModel>>;
type Restart = typeof restartCapturedDesktopApp;
type NativePair = readonly { path: string; sha256: string }[];
type CodeMode = Awaited<ReturnType<typeof captureCodexCodeModeProcess>>;
const rows = (value: unknown): Row[] => { assert.ok(Array.isArray(value)); return value.map(record); };
const text = (value: unknown): string => { assert.equal(typeof value, 'string'); return value as string; };
const hash = (value: unknown): string => { const result = text(value); assert.match(result, /^[a-f0-9]{64}$/); return result; };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 100));
const teamRoot = (root: string) => join(root, 'hoststore/teams/test-desktop-backend');

/** Read-only original snapshots. Never construct a store, recover a command or adopt a PID. */
function readJson(path: string, maximum = 8 * 1024 * 1024): Row {
  const before = lstatSync(path, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= BigInt(maximum));
  assert.equal(realpathSync(path), path);
  const same = (after: typeof before) => {
    for (const key of ['dev', 'ino', 'size', 'mode', 'uid', 'mtimeNs', 'ctimeNs'] as const)
      assert.equal(after[key], before[key], 'original bounded JSON snapshot remains current');
  };
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    same(fstatSync(fd, { bigint: true }));
    const bytes = readFileSync(fd); assert.equal(BigInt(bytes.length), before.size);
    same(fstatSync(fd, { bigint: true })); same(lstatSync(path, { bigint: true }));
    assert.equal(realpathSync(path), path);
    return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } finally { closeSync(fd); }
}

function runtimeRows(root: string): Row[] {
  const directory = join(root, 'hoststore/runtime-sessions');
  const namespaces = readdirSync(directory, { withFileTypes: true });
  assert.ok(namespaces.length <= 16 && namespaces.every(row => row.isDirectory() && /^[a-f0-9]{64}$/.test(row.name)));
  return namespaces.flatMap(namespace => {
    const path = join(directory, namespace.name), entries = readdirSync(path, { withFileTypes: true });
    assert.ok(entries.length <= 512);
    const files = entries.filter(row => /^[a-f0-9]{64}\.json$/.test(row.name));
    assert.ok(files.length <= 256 && files.every(row => row.isFile() && !row.isSymbolicLink()));
    assert.ok(entries.every(row => {
      if (/^[a-f0-9]{64}\.json$/.test(row.name) || /^\.tmp\.[a-f0-9-]{36}$/.test(row.name) ||
        /^member\.lock(?:\.candidate-[1-9]\d*-[a-f0-9-]{36})?$/.test(row.name)) return row.isFile() && !row.isSymbolicLink();
      return /^member\.lock-transition-v2(?:\.candidate-[1-9]\d*-[a-f0-9-]{36})?$/.test(row.name) && row.isDirectory() && !row.isSymbolicLink();
    }), 'only original Runtime namespace files and finite lock sidecars');
    return files.map(row => readJson(join(path, row.name)));
  });
}

/** Exact current A/B actor for the original model oracle, with the stopped predecessor retained. */
export function readCodexSourceSelectionPrincipal(root: string): string {
  const state = readJson(join(teamRoot(root), '.host-owner/state.json'));
  const captures = rows(state.runtimeCaptures); assert.ok(captures.length === 1 || captures.length === 2);
  const capture = captures.at(-1)!, members = rows(capture.members); assert.equal(members.length, 1);
  const member = members[0]!; assert.equal(member.memberId, 'alice-id');
  const current = rows(state.members).filter(row => row.memberId === member.memberId);
  assert.equal(current.length, 1); assert.deepEqual(current[0]!.delivery, member.delivery);
  const grants = rows(state.grants).filter(row => row.principalId === member.principalId && row.revoked !== true);
  assert.equal(grants.length, 1); assert.equal(grants[0]!.memberName, current[0]!.name);
  assert.ok(Array.isArray(grants[0]!.permissions) && grants[0]!.permissions.includes('message.write'));
  const principal = text(member.principalId); assert.match(principal, /^agent:/);
  if (captures.length === 2) {
    const first = captures[0]!; assert.notEqual(first.launchId, capture.launchId);
    assert.notEqual(rows(first.members)[0]!.principalId, principal);
    const original = runtimeRows(root).filter(row => record(row.binding).runId === first.launchId);
    assert.equal(original.length, 1); assert.equal(original[0]!.phase, 'closed');
    assert.equal(original[0]!.custody, 'released');
    const inputs = rows(original[0]!.inputs); assert.equal(inputs.length, 1);
    assert.equal(inputs[0]!.phase, 'terminal'); assert.equal(inputs[0]!.terminal, 'succeeded');
  }
  return principal;
}

function sourceIndex(root: string, allowMissing = false) {
  let value: Row;
  try { value = readJson(join(root, 'hoststore/runtime-sources/index.json')); }
  catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], current: [] };
    throw error;
  }
  const { digest: expected, ...body } = value;
  assert.equal(expected, runtimeDigest(body));
  assert.deepEqual(Object.keys(body).sort(), ['current', 'records', 'schemaVersion']); assert.equal(body.schemaVersion, 1);
  const records = rows(body.records).map(row => runtimeSourceRecordSchema.parse(row)), current = rows(body.current);
  assert.ok(records.length <= 1024 && current.length <= 256);
  assert.equal(new Set(records.map(row => row.revision)).size, records.length);
  assert.equal(new Set(records.map(row => row.commandId)).size, records.length);
  assert.equal(new Set(current.map(row => row.sourceId)).size, current.length);
  for (const { revision, ...selection } of records) assert.equal(revision, runtimeDigest(selection));
  for (const pointer of current) {
    assert.deepEqual(Object.keys(pointer).sort(), ['commandId', 'revision', 'sourceId']);
    const selected = records.filter(row => row.revision === hash(pointer.revision));
    assert.equal(selected.length, 1); assert.equal(selected[0]!.commandId, pointer.commandId);
    assert.equal(selected[0]!.grant.targetId, hash(pointer.sourceId));
  }
  return { records, current };
}

function managementRows(root: string) {
  const directory = join(root, 'hoststore/management-commands'), names = readdirSync(directory);
  assert.ok(names.length <= 256);
  return names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort().map(name => {
    const { digest: expected, ...body } = readJson(join(directory, name), 4 * 1024 * 1024);
    assert.equal(expected, managementDigest(body));
    const parsed = storedManagementCommandSchema.parse(body);
    assert.equal(name, managementDigest(parsed.commandId) + '.json');
    return { name, sha256: digest(JSON.stringify(body)), value: parsed };
  });
}

function capturedSource(root: string, capture: Row) {
  const launch = readJson(join(teamRoot(root), '.host-owner/launches', runtimeDigest(capture.launchId) + '.json'));
  const source = runtimeCaptureSourceSchema.parse(record(launch.definition).capture);
  assert.equal(source.savedSettings.providerId, 'codex'); assert.equal(source.savedSettings.cwd, join(root, 'workspace'));
  assert.equal(source.members.length, 1); assert.equal(source.members[0]!.memberId, 'alice-id');
  return source;
}

async function registrySelection() {
  const read = async (url: string) => {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
    assert.equal(response.status, 200); assert.ok(response.body);
    const chunks: Uint8Array[] = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; assert.ok(bytes <= 1024 * 1024); chunks.push(chunk); }
    return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
  };
  const root = await read('https://registry.npmjs.org/%40openai%2Fcodex/latest');
  const platform = await read('https://registry.npmjs.org/%40openai%2Fcodex/0.169.0-darwin-arm64');
  assert.equal(root.name, '@openai/codex'); assert.equal(root.version, '0.169.0');
  assert.equal(record(root.optionalDependencies)['@openai/codex-darwin-arm64'], 'npm:@openai/codex@0.169.0-darwin-arm64');
  assert.equal(platform.name, '@openai/codex'); assert.equal(platform.version, '0.169.0-darwin-arm64');
  const rootDist = record(root.dist), platformDist = record(platform.dist);
  assert.equal(rootDist.tarball, 'https://registry.npmjs.org/@openai/codex/-/codex-0.169.0.tgz');
  assert.equal(rootDist.integrity, 'sha512-KhzYlkKPxoNssR8CEm45IjqnFWn7UtlF4CiD3tOJPea51xBs7MaHy0UQG9GSbCqk6Lrjn5QdJDV0QD1/FgWlGw==');
  assert.equal(platformDist.tarball, 'https://registry.npmjs.org/@openai/codex/-/codex-0.169.0-darwin-arm64.tgz');
  assert.equal(platformDist.integrity, 'sha512-5WsWFBbVP78D+6FvNo1MMVxLPZdmcoQlqVJFrF4qx/TmvneLnMQKtLyXkUo54XOTDfoYKpNouTJ/F7gTVA8FnQ==');
  assert.equal(platformDist.fileCount, 43);
  return { root: { version: root.version, tarball: rootDist.tarball, integrity: rootDist.integrity },
    platform: { version: platform.version, tarball: platformDist.tarball, integrity: platformDist.integrity, files: platformDist.fileCount } };
}

export function createDesktopCodexSourceSelection(cdp: UiCdpPort, options: {
  fixture: Fixture; model: Model; seed: { subject: string }; evidence: Row;
  assertOwnedRenderer(): void; capturedGroup(): number;
  restartSameProfile: ((restart?: Restart) => Promise<UiCdpPort>) | undefined;
}) {
  const { fixture, model, evidence } = options, codex = fixture.codexResume;
  assert.ok(codex?.sourceSelection && options.restartSameProfile);
  assert.equal(process.env.LEGACY_DESKTOP_CODEX_SOURCE_SELECTION, '1');
  const { candidate, preApp, alias } = codex.sourceSelection, root = fixture.root;
  assert.deepEqual(preApp.map(row => row.purpose), ['metadata', 'catalog']);
  assert.ok(preApp.every(row => row.cleanup === true && rows(row.children).length === 1));
  const steps: Row[] = [], progress: Row[] = [], nativeObservations: Row[] = [];
  const proof: Row = { status: 'INCOMPLETE', preApp, candidate: candidate.evidence, pathAlias: alias.evidence,
    steps, progress, nativeObservations };
  evidence.codexSourceSelectionProof = proof;
  const firstGroup = options.capturedGroup(), pairs = new Map<string, ReturnType<typeof captureDesktopNativeExecutable>>();
  const remember = (path: string) => {
    if (!pairs.has(path)) pairs.set(path, captureDesktopNativeExecutable(path, firstGroup));
  };
  for (const value of codex.nativeInputs) remember(value.path);
  const manifestPath = join(root, 'userData/data/runtimes/codex/current.json');
  const managed = () => {
    const row = readJson(manifestPath, 64 * 1024);
    assert.equal(row.schemaVersion, 1); assert.equal(row.rootVersion, '0.169.0');
    assert.equal(row.platformVersion, '0.169.0-darwin-arm64'); assert.equal(row.platformTarget, 'aarch64-apple-darwin');
    assert.equal(row.integrity, 'sha512-5WsWFBbVP78D+6FvNo1MMVxLPZdmcoQlqVJFrF4qx/TmvneLnMQKtLyXkUo54XOTDfoYKpNouTJ/F7gTVA8FnQ==');
    const path = text(row.binaryPath), prefix = join(root, 'userData/data/runtimes/codex/versions/0.169.0-darwin-arm64');
    assert.ok(path.startsWith(prefix + '/'));
    assert.match(path.slice(prefix.length), /^\/aarch64-apple-darwin-[a-f0-9-]{36}\/bin\/codex$/);
    assert.equal(realpathSync(path), path); return { row, path };
  };
  const observe = () => {
    options.assertOwnedRenderer(); assert.deepEqual(model.failures, []);
    try {
      const { path } = managed(); remember(path); remember(join(dirname(path), 'codex-code-mode-host'));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const [path, census] of pairs) {
      const prior = new Set(census.captured().map(row => row.pid + ':' + row.birth)); census.observe();
      for (const child of census.captured()) if (!prior.has(child.pid + ':' + child.birth)) {
        assert.ok(nativeObservations.length < 128);
        nativeObservations.push({ path, child, businessRequests: model.observations.length, probes: model.probes.length });
      }
    }
  };
  const ui = createDesktopUiControls(cdp, { assertOwnedRenderer: observe, step: value => steps.push(value) });
  const state = () => readJson(join(teamRoot(root), '.host-owner/state.json'));
  const host = () => {
    const found = groupMembers(firstGroup).filter(row => command(row.pid) === fixture.node + ' ' + fixture.hostEntry);
    assert.equal(found.length, 1); return found[0]!;
  };
  const poll = async <T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string) => {
    const until = Date.now() + 60000; let value: T;
    do { observe(); value = await read(); if (accept(value)) return value; await tick(); } while (Date.now() < until);
    assert.ok(accept(value!), label); return value!;
  };
  const status = async () => {
    const value = await cdp.evaluate(`(()=>{const s=window.__agentTeamsDevStore?.getState();const r=s?.codexRuntimeStatus;
      return r?{installed:r.installed,source:r.source,state:r.state,version:r.version??null,latestVersion:r.latestVersion??null,
      sourceRevision:r.sourceRevision??null,updateAvailable:r.updateAvailable,progress:r.progress??null,
      loading:s.codexRuntimeStatusLoading,error:s.codexRuntimeError??null,provider:s.cliStatus?.providers?.find(x=>x.providerId==='codex')??null}:null})()`);
    if (value === null) return null;
    const row = record(value); assert.equal(row.error, null); assert.notEqual(row.state, 'failed');
    if (row.progress) {
      const p = record(row.progress), observed = { state: row.state, sourceRevision: row.sourceRevision,
        phase: p.phase, percent: p.percent ?? null, downloadedBytes: p.downloadedBytes ?? null, totalBytes: p.totalBytes ?? null };
      if (!isDeepStrictEqual(progress.at(-1), observed)) { assert.ok(progress.length < 256); progress.push(observed); }
    }
    return row;
  };
  let first: { capture: Row; source: ReturnType<typeof capturedSource>; native: CodeMode; revision: string } | undefined;
  let selected: ReturnType<typeof sourceIndex> | undefined, bPair: NativePair | undefined;
  return {
    observe,
    async beforeTerminal(capture: Row) {
      await alias.verify();
      await poll(async () => model.firstFinalHeld(), Boolean, 'same original A final response held');
      assert.equal(model.observations.length, 8); assert.equal(model.probes.length, 1);
      assert.deepEqual(rows(state().runtimeCaptures), [capture]);
      const sessions = (await readDesktopNativeStopSessions(root)).filter(row => record(row.binding).runId === capture.launchId);
      assert.equal(sessions.length, 1); assert.equal(rows(sessions[0]!.inputs).length, 1);
      assert.notEqual(rows(sessions[0]!.inputs)[0]!.phase, 'terminal');
      const source = capturedSource(root, capture), native = await captureCodexCodeModeProcess(host().pid, codex.nativeInputs);
      assert.ok(pairs.get(codex.nativeInputs[0]!.path)!.captured().some(row => row.pid === native.codex.pid));
      const before = sourceIndex(root, true);
      await ui.click('button[aria-label="More actions"]', 'open original Settings menu');
      await ui.click('button', 'open original Settings', 'Settings');
      await ui.scrollTo('[data-testid="settings-nav-providers"]', 'original Providers tab');
      await ui.click('[data-testid="settings-nav-providers"]', 'open original Providers tab');
      await ui.waitRead(`Boolean(document.querySelector('[data-testid="provider-settings-page"]'))`, 'original Providers page');
      const expand = '[role="button"][aria-label="Expand provider details"]';
      if (await cdp.evaluate(`Boolean(document.querySelector(${literal(expand)}))`)) await ui.click(expand, 'expand original provider details');
      const original = await poll(status, row => row?.version === '0.162.0' && row.latestVersion === '0.169.0' &&
        row.updateAvailable === true && row.loading === false && row.provider !== null &&
        record(row.provider).modelCatalogRefreshState === 'ready' && record(record(row.provider).modelCatalog).status === 'ready',
        'actual A status offers qualified B');
      assert.ok(original); const revision = hash(original.sourceRevision);
      first = { capture: structuredClone(capture), source, native, revision };
      assert.ok(nativeObservations.some(row => row.path === codex.nativeInputs[0]!.path && row.businessRequests === 0),
        'actual A metadata/preflight child observed before the original business input');
      proof.originalA = { capture, source, native, status: original };
      await candidate.verifyCandidate(); await alias.verify(); proof.registryBeforeUpdate = await registrySelection();
      const card = '[data-testid="provider-settings-page"] div.grid:has(> div > div > button[data-testid="runtime-manage-codex"])';
      const label = 'Update v0.162.0 → v0.169.0';
      await ui.scrollTo(card + ' button', 'real Codex Update notice', label);
      await ui.click(card + ' button', 'open real Codex Update confirmation', label);
      await ui.waitRead(`Boolean(document.querySelector('[role="dialog"]'))&&document.querySelector('[role="dialog"]').innerText.includes('Codex')`, 'original Update dialog');
      const priorCatalogTime = text(record(record(original.provider).modelCatalog).fetchedAt);
      await ui.click('[role="dialog"] button', 'one original stock Update action', label);
      const ready = await poll(status, row => row?.installed === true && row.version === '0.169.0' &&
        row.source === 'app-managed' && row.state === 'ready' && row.loading === false &&
        row.updateAvailable === false && row.progress !== null && record(row.progress).phase === 'ready' &&
        row.provider !== null && record(row.provider).modelCatalogRefreshState === 'ready' &&
        record(record(row.provider).modelCatalog).status === 'ready' &&
        record(record(row.provider).modelCatalog).fetchedAt !== priorCatalogTime, 'published B and original metadata refresh complete');
      assert.ok(ready); assert.notEqual(hash(ready.sourceRevision), revision);
      const installed = managed(); bPair = await candidate.verifyInstalled(installed.path);
      const catalog = record(record(ready.provider).modelCatalog);
      assert.equal(catalog.providerId, 'codex'); assert.equal(catalog.source, 'app-server');
      assert.ok(Date.parse(text(catalog.fetchedAt)) > Date.parse(priorCatalogTime));
      assert.ok(rows(catalog.models).some(row => row.launchModel === codex.model && row.source === 'app-server'));
      assert.ok(pairs.get(bPair[0]!.path)!.captured().length > 0, 'actual B metadata/version child observed before B Runtime');
      assert.ok(progress.some(row => ['checking', 'downloading', 'installing'].includes(String(row.phase))));
      selected = sourceIndex(root); assert.equal(selected.records.length, before.records.length + 1);
      for (const row of before.records) assert.ok(selected.records.some(next => isDeepStrictEqual(next, row)));
      const additions = selected.records.filter(row => !before.records.some(old => old.revision === row.revision));
      assert.equal(additions.length, 1); const publication = additions[0]!;
      assert.equal(publication.revision, ready.sourceRevision); assert.equal(publication.previousRevision, revision);
      assert.equal(publication.candidate.sourceKind, 'app-managed'); assert.deepEqual(publication.candidate.executable, bPair[0]);
      assert.equal(publication.candidate.nativeCli?.version, '0.169.0'); assert.deepEqual(publication.candidate.nativeCli?.executable, bPair[0]);
      const descriptor = readJson(fixture.descriptorPath), management = rows(descriptor.management);
      assert.equal(management.length, 1); const entry = management[0]!, owner = record(entry.owner);
      assert.equal(publication.grant.runtimeId, 'codex'); assert.equal(publication.grant.ownerId, owner.ownerId);
      assert.equal(publication.grant.ownerRevision, owner.revision); assert.equal(publication.grant.contextId, entry.contextId);
      assert.equal(publication.grant.projectPath, entry.projectPath); assert.equal(publication.grant.profileId, entry.profileId);
      assert.equal(publication.grant.configRevision, entry.configRevision);
      const profile = readJson(fixture.profilePath), scope = record(rows(profile.teams)[0]!.scope);
      assert.ok(publication.grant.teamScopes.some(row => row.teamId === scope.teamId &&
        row.projectId === scope.projectId && row.workspaceId === scope.workspaceId));
      if (source.recipeSources) assert.deepEqual(source.recipeSources, [{ memberId: 'alice-id',
        sourceId: publication.grant.targetId, revision }]);
      assert.equal(selected.current.filter(row => row.sourceId === publication.grant.targetId && row.revision === publication.revision).length, 1);
      const receipt = managementRows(root).map(row => row.value).filter(row => row.kind === 'runtime.source' && row.commandId === publication.commandId);
      assert.equal(receipt.length, 1); const originalCommand = receipt[0]!;
      assert.equal(originalCommand.kind, 'runtime.source');
      if (originalCommand.kind !== 'runtime.source') throw new Error('Exact source publication receipt missing');
      assert.equal(originalCommand.phase, 'published'); assert.equal(originalCommand.resourceHeld, false);
      assert.equal(originalCommand.expectedRevision, revision); assert.equal(originalCommand.revision, publication.revision);
      assert.equal(originalCommand.sourceId, publication.grant.targetId); assert.equal(originalCommand.nativeVersion, '0.169.0');
      assert.deepEqual(rows(state().runtimeCaptures), [capture]); assert.deepEqual(capturedSource(root, capture), source);
      const stillA = await captureCodexCodeModeProcess(host().pid, codex.nativeInputs);
      assert.deepEqual(stillA.codex, native.codex); assert.deepEqual(stillA.helper, native.helper);
      assert.equal(model.firstFinalHeld(), true); assert.equal(model.probes.length, 1); assert.equal(model.observations.length, 8);
      const pending = (await readDesktopNativeStopSessions(root)).filter(row => record(row.binding).runId === capture.launchId);
      assert.equal(pending.length, 1); assert.equal(pending[0]!.sessionRef, sessions[0]!.sessionRef);
      assert.deepEqual(pending[0]!.binding, sessions[0]!.binding); assert.deepEqual(pending[0]!.config, sessions[0]!.config);
      assert.equal(rows(pending[0]!.inputs).length, 1); assert.notEqual(rows(pending[0]!.inputs)[0]!.phase, 'terminal');
      proof.update = { status: ready, manifest: installed.row, publication, receipt: originalCommand,
        nativeInputs: bPair, AStillOriginal: stillA, sourceIndex: selected };
      await ui.waitRead(`document.querySelector('[role="dialog"]')?.innerText.includes('Update Ready')`, 'actual Update Ready');
      await ui.click('[role="dialog"] button', 'close completed Update dialog', 'Close');
      await ui.clickSidebar(options.seed.subject);
      model.releaseFirstFinal(); assert.equal(model.firstFinalHeld(), false);
    },
    async afterStop(input: { capture: Row; session: Row; saved: Row; nativeTask: Row; helper: CodeMode }) {
      await alias.verify();
      assert.ok(first && selected && bPair); assert.deepEqual(input.capture, first.capture);
      assert.deepEqual(input.helper.codex, first.native.codex); assert.deepEqual(input.helper.helper, first.native.helper);
      assert.equal(input.session.phase, 'closed'); assert.equal(input.session.custody, 'released');
      assert.equal(observeCodexCodeModeProcess(first.native).state, 'absent');
      const firstCheckpoint = await checkpoint(root, input.session, 'codex');
      assert.equal(model.observations.length, 8); assert.equal(model.probes.length, 1);
      assert.deepEqual(capturedSource(root, first.capture), first.source);
      await ui.clickSidebar(options.seed.subject);
      await ui.scrollTo('button', 'original Launch after A Stop', 'Launch');
      await ui.click('button', 'original Fresh Launch dialog', 'Launch');
      const prompt = '[role="dialog"] #dialog-prompt';
      await ui.waitRead(`Boolean(document.querySelector(${literal(prompt)}))`, 'original Launch dialog');
      await ui.waitRead(`document.querySelector('#launch-continuation-mode')?.textContent.includes('Fresh Launch')`, 'original explicit Fresh Launch mode');
      await ui.scrollTo(prompt, 'original fresh B prompt'); await ui.click(prompt, 'focus original fresh B prompt');
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'] });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
      await cdp.send('Input.insertText', { text: 'CODEX_TEAM_TWO' });
      await ui.waitRead(`document.querySelector(${literal(prompt)})?.value==='CODEX_TEAM_TWO'`, 'fresh B prompt typed');
      await ui.scrollTo('[role="dialog"] button', 'original fresh B Launch team', 'Launch team');
      await ui.click('[role="dialog"] button', 'one original fresh B Launch team', 'Launch team');
      await ui.waitRead(`!document.querySelector(${literal(prompt)})`, 'fresh B dialog closes', 60000);
      const current = await poll(state, value => rows(value.runtimeCaptures).length === 2, 'exactly A and fresh B captures');
      const captures = rows(current.runtimeCaptures); assert.deepEqual(captures[0], first.capture);
      const second = captures[1]!; assert.notEqual(second.launchId, first.capture.launchId);
      assert.deepEqual(current.savedSettings, { ...input.saved, prompt: 'CODEX_TEAM_TWO' });
      const oldMember = rows(first.capture.members)[0]!, newMembers = rows(second.members); assert.equal(newMembers.length, 1);
      const newMember = newMembers[0]!; assert.equal(newMember.memberId, oldMember.memberId);
      assert.notEqual(newMember.principalId, oldMember.principalId);
      assert.notEqual(record(newMember.delivery).generation, record(oldMember.delivery).generation);
      const sourceB = capturedSource(root, second);
      const active = selected.current.filter(row => row.revision === record(record(proof.update).status).sourceRevision);
      assert.equal(active.length, 1);
      assert.deepEqual(sourceB.recipeSources, [{ memberId: 'alice-id', sourceId: active[0]!.sourceId, revision: active[0]!.revision }]);
      const captured = async () => (await readDesktopNativeStopSessions(root)).filter(row => captures.some(value => value.launchId === record(row.binding).runId));
      const terminal = await poll(captured, values => values.length === 2 && values.every(row => rows(row.inputs).length === 1 &&
        rows(row.inputs).every(value => value.phase === 'terminal' && value.terminal === 'succeeded')), 'exact A8 and fresh B3 terminal inputs');
      const old = terminal.find(row => record(row.binding).runId === first!.capture.launchId)!;
      const fresh = terminal.find(row => record(row.binding).runId === second.launchId)!;
      assert.deepEqual(old, input.session); assert.equal(fresh.restoredFrom, undefined);
      assert.equal(model.observations.length, 11); assert.equal(model.probes.length, 2);
      const requests = model.observations.filter(row => row.turn === 'CODEX_TEAM_TWO');
      assert.equal(requests.length, 3); assert.deepEqual(requests.map(row => row.step), [0, 1, 2]);
      assert.ok(requests.every(row => !row.priorTurn && row.contextEffective && row.requestedModel === codex.model && row.requestedEffort === 'medium'));
      assert.equal(await readFile(join(root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\nTWO\n');
      assert.deepEqual(readJson(join(root, 'hoststore/tasks/test-desktop-backend', text(input.nativeTask.id) + '.json')), input.nativeTask);
      const inbox = JSON.parse(await readFile(join(teamRoot(root), 'inboxes/user.json'), 'utf8'));
      for (const reply of ['REPLY_CODEX_ONE', 'REPLY_CODEX_TWO'])
        assert.equal(rows(inbox).filter(row => row.text === reply && row.from === 'alice').length, 1);
      if (!(await cdp.evaluate(`Boolean(document.querySelector('.message-composer-flat-layout textarea'))`)))
        await ui.click('button[aria-label^="alice,"]', 'open original alice chat after B');
      for (const reply of ['REPLY_CODEX_TWO', 'REPLY_CODEX_ONE'])
        await revealDesktopReply(cdp, reply, { assertOwnedRenderer: observe, step: value => steps.push(value) });
      const nativeB = await captureCodexCodeModeProcess(host().pid, bPair);
      assert.notEqual(nativeB.codex.pid, first.native.codex.pid); observe();
      await alias.verify();
      await ui.scrollTo('button[aria-label="Stop"]', 'original B Stop');
      await ui.click('button[aria-label="Stop"]', 'one original B Stop', 'Stop');
      const stopped = await poll(captured, values => values.length === 2 && values.every(row => row.phase === 'closed' && row.custody === 'released'), 'A and B released before Quit');
      await poll(async () => ({ helper: observeCodexCodeModeProcess(nativeB), rows: processTable() }), value =>
        value.helper.state === 'absent' && !value.rows.some(row => row.pid === nativeB.codex.pid), 'original B root and helper physically absent');
      const secondSession = stopped.find(row => record(row.binding).runId === second.launchId)!;
      const secondCheckpoint = await checkpoint(root, secondSession, 'codex');
      assert.notEqual(secondCheckpoint.nativeSession, firstCheckpoint.nativeSession);
      const aAgain = await checkpoint(root, input.session, 'codex');
      assert.equal(aAgain.payloadFileSha256, firstCheckpoint.payloadFileSha256); assert.equal(aAgain.historySha256, firstCheckpoint.historySha256);
      assert.deepEqual(sourceIndex(root), selected); assert.deepEqual(capturedSource(root, first.capture), first.source);
      proof.freshB = { capture: second, source: sourceB, native: nativeB, session: secondSession,
        requests, probes: model.probes.length, businessRequests: model.observations.length,
        nativeThread: secondCheckpoint.nativeSession, originalAThread: firstCheckpoint.nativeSession };
      const witnesses = [firstCheckpoint, secondCheckpoint].map(row => ({ path: row.path, sha256: row.payloadFileSha256,
        historyPath: row.historyPath, historySha256: row.historySha256, nativeThread: row.nativeSession }));
      const frozen = { captures, sources: [first.source, sourceB], index: selected,
        commands: managementRows(root).map(({ name, sha256 }) => ({ name, sha256 })), witnesses };
      const restart: Restart = value => restartCodexSourceSelection(value, {
        proof, pairs, model, frozen, nativePairs: [codex.nativeInputs, bPair!], verifyAlias: alias.verify,
        verifyInstalled: () => candidate.verifyInstalled(bPair![0]!.path),
      });
      const cold = await options.restartSameProfile!(restart);
      const coldUi = createDesktopUiControls(cold, { assertOwnedRenderer: options.assertOwnedRenderer, step: value => steps.push(value) });
      await coldUi.clickSidebar(options.seed.subject);
      await coldUi.waitRead(`Boolean(document.querySelector('button[aria-label^="alice,"]'))`, 'same saved Team after cold discovery');
      await coldUi.click('button[aria-label^="alice,"]', 'read retained original A/B product history');
      for (const reply of ['REPLY_CODEX_ONE', 'REPLY_CODEX_TWO'])
        await revealDesktopReply(cold, reply, { assertOwnedRenderer: options.assertOwnedRenderer, step: value => steps.push(value) });
      assert.equal(model.observations.length, 11); assert.equal(model.probes.length, 2); assert.deepEqual(model.failures, []);
      proof.status = 'PASS';
    },
  };
}

/** Dedicated eleven-round boundary; the original eight-round Resume helper is unchanged. */
async function restartCodexSourceSelection(options: Parameters<Restart>[0], input: {
  proof: Row; pairs: Map<string, ReturnType<typeof captureDesktopNativeExecutable>>; model: Model;
  frozen: { captures: Row[]; sources: ReturnType<typeof capturedSource>[]; index: ReturnType<typeof sourceIndex>;
    commands: { name: string; sha256: string }[]; witnesses: { path: string; sha256: string; historyPath: string; historySha256: string; nativeThread: unknown }[] };
  nativePairs: NativePair[]; verifyAlias(): Promise<void>; verifyInstalled(): Promise<NativePair>;
}) {
  const { app, cdp, group, fixture, repo, evidence, cdpLibrary } = options;
  assert.equal(options.mode, 'native-resume-ui'); assert.equal(options.provider, 'codex');
  assert.equal(options.boundary, 'resume-after-stop'); assert.equal(options.checkpointUpgrade, undefined);
  assert.equal(options.createdHandleId, undefined); assert.equal(options.afterOriginalSettingsQuit, undefined); assert.equal(options.afterOriginalMembershipQuit, undefined);
  assert.equal(options.model, input.model);
  const hosts = groupMembers(group).filter(row => command(row.pid) === fixture.node + ' ' + fixture.hostEntry);
  assert.equal(hosts.length, 1); const originalHost = hosts[0]!; options.adoptRenderer(cdp, originalHost.pid);
  const proof: Row = { status: 'INCOMPLETE', firstEpoch: { app: evidence.app, host: originalHost, rendererTarget: evidence.rendererTarget } };
  input.proof.cold = proof; proof.originalCheckpointsAndHistories = input.frozen.witnesses;
  const unchanged = async () => {
    await input.verifyAlias();
    assert.deepEqual(rows(readJson(join(teamRoot(fixture.root), '.host-owner/state.json')).runtimeCaptures), input.frozen.captures);
    input.frozen.captures.forEach((capture, index) => assert.deepEqual(capturedSource(fixture.root, capture), input.frozen.sources[index]));
    assert.deepEqual(sourceIndex(fixture.root), input.frozen.index);
    assert.deepEqual(managementRows(fixture.root).map(({ name, sha256 }) => ({ name, sha256 })), input.frozen.commands);
    for (const witness of input.frozen.witnesses) {
      assert.equal(await fileDigest(witness.path), witness.sha256); assert.equal(await fileDigest(witness.historyPath), witness.historySha256);
    }
    for (const pair of input.nativePairs) for (const value of pair) assert.equal(await fileDigest(value.path), value.sha256);
    await input.verifyInstalled();
    assert.equal(input.model.observations.length, 11); assert.equal(input.model.probes.length, 2); assert.deepEqual(input.model.failures, []);
  };
  const before = await readDesktopNativeStopSessions(fixture.root);
  const business = before.filter(row => rows(row.inputs).length > 0);
  assert.equal(business.length, 2); assert.ok(before.every(row => row.phase === 'closed' && row.custody === 'released'));
  for (const row of business) {
    assert.ok(input.frozen.captures.some(capture => capture.launchId === record(row.binding).runId));
    assert.equal(rows(row.inputs).length, 1); assert.equal(rows(row.inputs)[0]!.terminal, 'succeeded');
  }
  const profile = readJson(fixture.profilePath), member = rows(rows(profile.teams)[0]!.members)[0]!;
  const { teamName: _teamName, ...descriptorBinding } = record(member.delivery);
  const neverOpened = (row: Row) => {
    assert.deepEqual(row.binding, descriptorBinding); assert.deepEqual(row.inputs, []); assert.deepEqual(row.interactions, []);
    assert.equal(row.config, null); assert.equal(row.openFingerprint, null); assert.equal(row.nativeReady, false);
    assert.equal(row.phase, 'closed'); assert.equal(row.custody, 'released');
  };
  const staticRows = before.filter(row => !business.includes(row)); assert.ok(staticRows.length <= 1); staticRows.forEach(neverOpened);
  await unchanged();
  const bundleDirectory = join(fixture.root, 'cold-codex-source-epoch1-bundles'), pins = rows(evidence.compiledBundleHashesAfterStartup);
  assert.ok(pins.length > 0 && pins.length <= 4096);
  for (const pin of pins) {
    const relative = text(pin.path), sha = hash(pin.sha256);
    assert.ok(!relative.startsWith('/') && !relative.split('/').includes('..')); assert.match(relative, /\.(?:cjs|js)$/);
    const source = join(repo, 'dist-electron', relative), target = join(bundleDirectory, relative);
    assert.equal(await fileDigest(source), sha); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target, constants.COPYFILE_EXCL);
    assert.equal(await fileDigest(target), sha); assert.equal(await fileDigest(source), sha);
  }
  proof.epoch1BundleSnapshot = { directory: bundleDirectory, files: pins };
  assertOwnedCdpListener(group); for (const census of input.pairs.values()) census.observe();
  options.markQuitRequested(); const quit: Row = { attempted: true }; proof.firstQuit = quit;
  try { await bounded(cdp.evaluate('window.electronAPI.windowControls.close()'), 3000, 'original Codex source Quit'); quit.reply = 'acknowledged'; }
  catch (error) { quit.reply = 'unconfirmed'; quit.reason = /timed out/i.test(String(error)) ? 'timeout' : 'closed-or-rejected'; }
  const until = Date.now() + 30000;
  while (Date.now() < until && (app.exitCode === null || groupMembers(group).length)) await tick();
  const remaining = groupMembers(group), absent = !processTable().some(row => row.pid === originalHost.pid);
  const writerReleased = await lstat(join(fixture.root, 'hoststore/.legacy-agent-host-writer.lock')).then(() => false,
    (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return true; throw error; });
  proof.firstCleanup = { appExitCode: app.exitCode, appSignalCode: app.signalCode, remaining, capturedHostAbsent: absent, writerLockReleased: writerReleased };
  assert.equal(app.exitCode, 0); assert.equal(app.signalCode, null); assert.deepEqual(remaining, []); assert.ok(absent && writerReleased);
  const native = [...input.pairs].map(([path, census]) => ({ path, children: census.captured(), remaining: census.remaining(), selected: selectedDesktopRuntime(path) }));
  for (const row of native) { assert.deepEqual(row.remaining, []); assert.deepEqual(row.selected, []); }
  proof.originalNativeAbsence = native;
  const after = await readDesktopNativeStopSessions(fixture.root);
  for (const row of before) { const matches = after.filter(value => isDeepStrictEqual(value.binding, row.binding)); assert.equal(matches.length, 1); assert.deepEqual(matches[0], row); }
  const added = after.filter(row => !before.some(value => isDeepStrictEqual(value.binding, row.binding)));
  assert.ok(added.length <= 1); added.forEach(row => { neverOpened(row); assert.equal(row.sealed, true); });
  await unchanged(); await bounded(cdp.close(), 3000, 'disconnect original Codex source renderer'); options.adoptRenderer(undefined);
  assert.equal(await portOccupied(), false);
  for (const [path, sha] of [[fixture.node, fixture.pins.nodeSha256], [fixture.hostEntry, fixture.pins.hostEntrySha256],
    [fixture.profilePath, fixture.pins.profileSha256], [fixture.descriptorPath, fixture.pins.descriptorSha256]]) assert.equal(await fileDigest(path!), sha);
  const next = options.spawnNext(fixture); assert.ok(next.group > 0 && next.group !== group);
  const second: Row = { status: 'INCOMPLETE', app: { pid: next.app.pid, processGroup: next.group, identity: next.identity, invocation: next.invocation } };
  proof.secondEpoch = second;
  const connected = await connectCapturedDesktopApp({ app: next.app, group: next.group, spawnError: next.spawnError,
    packed: undefined, cdpLibrary, evidence: second });
  options.adoptRenderer(connected.cdp);
  await attachRendererDiagnostics(connected.cdp, String(connected.target.url), second, {
    remainingMs: connected.startupBudgetMs - (performance.now() - connected.startupStarted), assertOwnedRenderer: () => assertOwnedCdpListener(next.group) });
  await verifyCapturedDesktopBinding({ cdp: connected.cdp, group: next.group, mode: options.mode, fixture, evidence: second, repo, packed: undefined });
  const newHosts = groupMembers(next.group).filter(row => command(row.pid) === fixture.node + ' ' + fixture.hostEntry);
  assert.equal(newHosts.length, 1); assert.notEqual(newHosts[0]!.pid, originalHost.pid);
  options.adoptRenderer(connected.cdp, newHosts[0]!.pid); second.host = newHosts[0];
  const coldCensus = [...input.pairs.keys()].map(path => ({ path, census: captureDesktopNativeExecutable(path, next.group) }));
  const coldUntil = Math.min(performance.now() + 30000, connected.startupStarted + connected.startupBudgetMs);
  do {
    assertOwnedCdpListener(next.group);
    for (const row of coldCensus) row.census.observe();
    if (coldCensus.every(row => selectedDesktopRuntime(row.path).length === 0)) break;
    await tick();
  } while (performance.now() < coldUntil);
  for (const row of coldCensus) { assert.deepEqual(row.census.remaining(), []); assert.deepEqual(selectedDesktopRuntime(row.path), []); }
  second.nativeObservations = coldCensus.map(row => ({ path: row.path, children: row.census.captured(), remaining: row.census.remaining() }));
  assert.deepEqual(await readDesktopNativeStopSessions(fixture.root), after); await unchanged();
  second.businessRequests = input.model.observations.length; second.probes = input.model.probes.length;
  second.status = 'PASS'; proof.status = 'PASS'; return connected.cdp;
}
