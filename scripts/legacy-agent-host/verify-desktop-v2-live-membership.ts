/** Read only the new original P11 receipt; never launch, replay or repair a provider. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';
import { compiledBundleHashes } from './desktop-backend-observations.ts';
import { readDesktopNativeProviderArtifact } from './desktop-native-stop-fixture.ts';
import { desktopProofSources } from './desktop-proof-sources.ts';
import { readDesktopFiniteMembershipPeers } from './desktop-live-membership-controlled.ts';
import type { DesktopFiniteMembership } from './desktop-live-membership-controlled.ts';
import { processFacts } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { verifyOpenCodeV2EmbeddedGraph } from '../../packages/legacy-agent-host/dist/adapters/providers/OpenCodeV2EmbeddedGraph.js';
import { verifyLinuxChildExecInput } from '../../src/main/utils/linuxChildLaunchSelection.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Row; };
const rows = (value: unknown): Row[] => { assert.ok(Array.isArray(value) && value.length <= 4096); return value.map(record); };
const text = (value: unknown): string => { assert.equal(typeof value, 'string'); return value as string; };
async function json(path: string, maximum = 32 * 1024 * 1024) {
  assert.equal(await realpath(path), path);
  const before = await lstat(path); assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= maximum);
  const bytes = await readFile(path); assert.ok(bytes.length <= maximum); assert.equal(bytes.length, before.size);
  return record(JSON.parse(bytes.toString('utf8')));
}
async function originalReceipt(temporary: string, name: string) {
  const bytes = await readFile(join(temporary, name), 'utf8'); assert.ok(Buffer.byteLength(bytes) <= 32 * 1024 * 1024);
  const prepared = bytes.split('\n').flatMap(line => {
    try { const value = record(JSON.parse(line)); return value.phase === 'prepared' ? [value] : []; }
    catch { return []; }
  });
  assert.equal(prepared.length, 1, 'one original case without replay');
  const path = await realpath(text(prepared[0]!.receipt));
  assert.equal(basename(path), 'desktop-backend-receipt.json'); assert.match(basename(dirname(path)), /^TEST-desktop-backend-[A-Za-z0-9]+$/u);
  return { path, root: dirname(path), value: await json(path) };
}
const repo = await realpath(join(import.meta.dirname, '../..')), temporary = await realpath(process.env.RUNNER_TEMP!);
const head = process.env.HOST_EMULATED_SOURCE_HEAD!;
assert.match(head, /^[a-f0-9]{40}$/u); assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
assert.equal(execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), head);
const input = await json(join(temporary, 'host-emulated-inputs.json'));
assert.equal(input.sourceHead, head); assert.equal(input.nativeProviders, 'OpenCode V2 with finite localhost model only');
const engine = await json(join(temporary, 'host-emulated-opencode-v2-inputs.json'));
assert.equal(engine.kind, 'TEST_NATIVE_V2_EMBEDDED_INPUTS'); assert.equal(engine.status, 'READY');
assert.equal(engine.sourceHead, head); assert.equal(engine.platform, 'linux-x64'); assert.equal(engine.nodeVersion, 'v24.21.0');
assert.equal(engine.stage, 'prepared'); assert.equal(record(engine.bun).version, '1.3.11');
const management = await originalReceipt(temporary, 'host-emulated-opencode-v2-management-ui.log');
const current = await originalReceipt(temporary, 'host-emulated-opencode-v2-live-membership-ui.log');
assert.notEqual(current.root, management.root, 'management retains its separate no-Runtime TEST root');
assert.equal(management.value.mode, 'opencode-v2-management-ui'); assert.equal(management.value.status, 'PASS');
const receipt = current.value, source = record(receipt.source), pins = record(receipt.pins), paths = record(receipt.paths);
assert.equal(source.head, head); assert.equal(source.dirty, false); assert.equal(receipt.root, current.root);
assert.equal(current.path, join(current.root, 'desktop-backend-receipt.json'));
assert.equal(paths.profile, join(current.root, 'host-profile.json')); assert.equal(paths.descriptor, join(current.root, 'desktop-descriptor.json'));
assert.equal(receipt.mode, 'native-mixed-create-launch-ui'); assert.equal(receipt.status, 'PASS');
assert.equal(receipt.scope, 'Original P11 Add/Remove/Restore/Stop/cold with captured OpenCode V2 and finite initial Claude/Codex protocol peers');
assert.deepEqual(receipt.excluded, ['Claude/Codex vendor execution', 'vendor authentication/inference', 'full mixed native qualification', 'release/default activation']);
for (const key of ['failure', 'sourceFreezeFailure', 'nativeInputFreezeFailure', 'logCleanupFailure', 'sentinelCensusFailure']) assert.equal(receipt[key], undefined);
assert.deepEqual(receipt.selectedSourceHashesAfterFlow, receipt.selectedSourceHashesBeforeApp);
const sources = rows(receipt.selectedSourceHashesBeforeApp);
assert.equal(sources.length, new Set(sources.map(row => row.path)).size);
assert.deepEqual(sources.map(row => row.path).sort(), [...desktopProofSources].sort());
for (const row of sources) assert.equal(await fileDigest(join(repo, text(row.path))), row.sha256);
for (const [key, pin] of [['profile', 'profileSha256'], ['descriptor', 'descriptorSha256'], ['node', 'nodeSha256'], ['hostEntry', 'hostEntrySha256'], ['pnpm', 'pnpmSha256']])
  assert.equal(await fileDigest(text(paths[key!])), pins[pin!]);
const selectedNode = await realpath(process.execPath); assert.equal(paths.node, selectedNode); assert.equal(process.version, 'v24.21.0');
const inputValues = record(input.values), packageManager = record(receipt.packageManager);
for (const [pin, inputName] of [['nodeSha256', 'NODE'], ['hostEntrySha256', 'HOST_ENTRY'], ['pnpmSha256', 'PNPM'],
  ['corepackPackageSha256', 'COREPACK_PACKAGE'], ['corepackLibrarySha256', 'COREPACK_LIBRARY']])
  assert.equal(pins[pin!], inputValues[`LEGACY_DESKTOP_${inputName}_SHA256`]);
assert.equal(await fileDigest(text(packageManager.packagePath)), pins.corepackPackageSha256);
assert.equal(await fileDigest(text(packageManager.libraryPath)), pins.corepackLibrarySha256);
const electron = await realpath(join(createRequire(import.meta.url).resolve('electron/package.json'), '../dist/electron'));
assert.equal(await fileDigest(electron), pins.electronSha256);
assert.equal(await fileDigest(join(repo, (await readDesktopNativeProviderArtifact(repo)).path)), pins.providerArchiveSha256);
assert.deepEqual(await compiledBundleHashes(join(repo, 'dist-electron')), receipt.compiledBundleHashesAfterStartup);
const linuxChildExec = verifyLinuxChildExecInput(input.linuxChildExec as Parameters<typeof verifyLinuxChildExecInput>[0]);
assert.deepEqual(receipt.linuxChildExecInput, linuxChildExec); assert.equal(receipt.linuxChildExecInputVerifiedAfterCleanup, true);
const profile = readTeamHostProfile(text(paths.profile), text(pins.profileSha256));
const templates = profile.runtime?.providerTemplates; assert.ok(templates && templates.length === 3);
const v2 = templates.find(row => row.provider === 'opencode'); assert.ok(v2?.provider === 'opencode');
assert.equal(v2.nativeGeneration, 'v2'); assert.equal(v2.protocolRevision, '2.1.4'); assert.ok(v2.embedded);
assert.deepEqual(v2.executable, { path: record(engine.bun).path, sha256: record(engine.bun).sha256 });
assert.equal(v2.embedded.manifestSha256, engine.manifestSha256); await verifyOpenCodeV2EmbeddedGraph(v2.embedded);
const selected = record(receipt.finiteInitialPeers);
assert.equal(selected.kind, 'finite-initial-peers-native-v2'); assert.equal(selected.businessInputs, 0);
assert.equal(selected.nativeQualification, false); assert.equal(selected.linuxIdentity, 'captured ps plus exact proc executable/argv/starttime');
const peers = rows(selected.peers); assert.deepEqual(peers.map(row => row.provider), ['claude', 'codex']);
for (const peer of peers) {
  assert.equal(peer.root, join(current.root, 'TEST-peer-' + peer.provider + '-scope'));
  const provider: NonNullable<typeof templates>[number] | undefined = templates.find(row => row.provider === peer.provider); assert.ok(provider);
  assert.deepEqual(provider.executable, peer.executable); assert.equal(provider.environment.TEST_EMULATED_DESKTOP_PROVIDER, '1');
  assert.equal(provider.environment.TEST_PEER_ROLE, 'runtime'); assert.equal(provider.environment.TEST_DESKTOP_COLLABORATION, undefined);
  assert.equal(provider.environment.TEST_DESKTOP_PEER_ROOT, peer.root);
}
const expectedSources = ['claudeProviderPeer.mjs', 'providerPeer.mjs', 'providerDesktopPeer.mjs'].map(name => join(repo, 'tools/owned-process-broker/fixtures', name));
assert.deepEqual(rows(selected.sources).map(row => row.path), expectedSources);
const finite = await readDesktopFiniteMembershipPeers(selected as unknown as Pick<DesktopFiniteMembership, 'sources' | 'peers'>);
const proof = record(receipt.liveMembershipProof), cold = record(receipt.coldMembershipBoundary);
assert.equal(proof.kind, 'mixed-live-membership'); assert.equal(proof.status, 'PASS'); assert.equal(proof.openCodeGeneration, 'v2');
assert.equal(proof.initialPeers, selected.kind); assert.equal(proof.fullMixedNativeQualification, false);
assert.deepEqual(proof.counts, { ordinaryProbes: 2, businessRequests: 4, inputs: 2, runtimeGenerations: 4 });
assert.deepEqual(proof.coldHistory, { unchanged: true, noPreparation: true, noInput: true, noRuntimeAllocation: true });
const epochs = rows(proof.physicalEpochs); assert.equal(epochs.length, 2); assert.ok(epochs.every(row => row.released === true));
assert.equal(record(proof.removed).released, true);
const added = record(proof.added), restored = record(proof.restored);
assert.equal(record(added.identity).memberId, record(restored.identity).memberId);
for (const key of ['principalId', 'sessionId']) assert.notEqual(record(added.identity)[key], record(restored.identity)[key]);
assert.notEqual(record(record(added.identity).binding).generation, record(record(restored.identity).binding).generation);
assert.notEqual(record(added.physical).pid, record(restored.physical).pid);
const stopped = rows(record(proof.beforeCold).sessions); assert.equal(stopped.length, 4);
assert.ok(stopped.every(row => row.phase === 'closed' && row.custody === 'released'));
assert.equal(stopped.reduce((count, row) => count + rows(row.inputs).length, 0), 2);
const models = await json(join(current.root, 'mixed-models.json'));
assert.equal(models.schemaVersion, 1); assert.equal(models.phase, 'before-model-close'); assert.equal(models.root, current.root);
const providers = record(models.providers);
for (const name of ['claude', 'codex', 'opencode']) {
  assert.deepEqual(record(providers[name]).failures, []); assert.deepEqual(record(providers[name]).notificationObservations ?? [], []);
}
for (const name of ['claude', 'codex']) {
  assert.deepEqual(record(providers[name]).observations, []); assert.deepEqual(record(providers[name]).probes, []);
}
assert.deepEqual(record(proof.initial).probeCounts, finite.probeCounts);
assert.ok(finite.probeCounts[0]! >= 1 && finite.probeCounts[0]! <= 9 && finite.probeCounts[1]! >= 1 && finite.probeCounts[1]! <= 8);
const native = record(providers.opencode);
assert.equal(rows(native.probes).length, 2); assert.ok(rows(native.probes).every(row => row.settingsStep === undefined));
assert.deepEqual(rows(native.observations).map(row => [row.turn, row.step]),
  [['TEST_LIVE_MEMBERSHIP_ADD', 0], ['TEST_LIVE_MEMBERSHIP_ADD', 1], ['TEST_LIVE_MEMBERSHIP_RESTORE', 0], ['TEST_LIVE_MEMBERSHIP_RESTORE', 1]]);
assert.equal(cold.status, 'PASS'); assert.equal(record(cold.secondEpoch).status, 'PASS');
assert.equal(record(cold.firstQuit).attempted, true); assert.equal(record(cold.firstCleanup).writerLockReleased, true);
assert.equal(cold.originalHistoryDigest, record(cold.secondEpoch).originalHistoryDigest);
assert.deepEqual(rows(cold.originalSavedTeamBindings).map(row => rows(row.members).length).sort(), [1, 3]);
for (const cleanup of [cold.firstCleanup, cold.secondCleanup, receipt.cleanup].map(record)) {
  assert.equal(cleanup.appExitCode, 0); assert.equal(cleanup.appSignalCode, null);
  assert.equal(cleanup.capturedHostAbsent, true); assert.deepEqual(cleanup.remaining, []); assert.equal(cleanup.cleanupFailure, undefined);
}
const cleanup = record(receipt.finiteInitialPeersAfterCleanup);
assert.equal(cleanup.absent, true); assert.deepEqual(cleanup.remaining, []); assert.deepEqual(cleanup.effects, finite.effects);
const table = processFacts(), originalPids = new Set(finite.effects.filter(row => row.event === 'launch').map(row => row.pid));
for (const epoch of epochs) {
  originalPids.add(record(epoch.host).pid);
  for (const partition of rows(record(epoch.lineage).partitions)) for (const birth of rows(partition.births)) originalPids.add(birth.pid);
}
for (const session of rows(record(proof.beforeCold).nativeBirthsAbsent)) originalPids.add(session.pid);
assert.ok([...originalPids].every(pid => !table.some(row => row.pid === pid)));
assert.deepEqual(record(receipt.finalSentinelCensus).refusedInvocations, []);
const screenshot = record(proof.screenshot); assert.equal(await fileDigest(text(screenshot.path)), screenshot.sha256);
await writeFile(join(temporary, 'host-emulated-opencode-v2-live-membership-summary.json'), JSON.stringify({
  status: 'PASS', sourceHead: head, managementReceipt: management.path, receipt: current.path,
  scope: receipt.scope, counts: proof.counts, fullMixedNativeQualification: false,
  vendorAuthQualified: false, releaseQualified: false, screenshot: screenshot.sha256,
}, null, 2), { mode: 0o600, flag: 'wx' });
