import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { fileDigest } from './desktop-backend-fixture.ts';
import { assertOwnedCdpListener, command, groupMembers, portOccupied, processTable } from './desktop-backend-observations.ts';
import { connectCapturedDesktopApp, verifyCapturedDesktopBinding } from './desktop-captured-app.ts';
import { readDesktopEmulatedRuntimeEffects, observeDesktopEmulatedRuntimeCleanup, verifyDesktopEmulatedRuntimeFixture } from './desktop-emulated-runtime-fixture.ts';
import { lifecycleRows, readEmulatedClaudeCheckpoint, readEmulatedLifecycleProduct } from './desktop-emulated-lifecycle-records.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { bounded } from './desktop-proof-bounds.ts';
import { json, record } from './desktop-resume-records.ts';
import { attachRendererDiagnostics } from './desktop-team-ui-smoke.ts';
import type { ChildProcess } from 'node:child_process';
import type { DesktopCdpLibrary, DesktopCdpPort } from './desktop-captured-app.ts';
import type { EmulatedLifecycleFixture, EmulatedLifecycleRow } from './desktop-emulated-lifecycle-records.ts';

/** Real app/Host retirement and a second captured Electron epoch; never a renderer-only reload. */
export async function restartDesktopEmulatedRuntimeApp(options: {
  app: ChildProcess; cdp: DesktopCdpPort; group: number; fixture: EmulatedLifecycleFixture;
  repo: string; mode: string; evidence: EmulatedLifecycleRow; cdpLibrary: DesktopCdpLibrary;
  markQuitRequested(): void;
  adoptRenderer(cdp: DesktopCdpPort | undefined, hostPid?: number): void;
  spawnNext(fixture: EmulatedLifecycleFixture): { app: ChildProcess; group: number; identity: string;
    invocation: readonly string[]; spawnError(): boolean };
}): Promise<DesktopCdpPort> {
  const { app, cdp, group, fixture, repo, mode, evidence, cdpLibrary } = options;
  assert.equal(mode, 'emulated-claude-lifecycle-ui');
  assert.equal(fixture.emulatedRuntime.provider, 'claude'); assert.equal(fixture.emulatedRuntime.variant, 'lifecycle');
  await verifyDesktopEmulatedRuntimeFixture(fixture);
  assertOwnedCdpListener(group);
  const hosts = groupMembers(group).filter(row => command(row.pid) === `${fixture.node} ${fixture.hostEntry}`);
  assert.equal(hosts.length, 1); const originalHost = hosts[0]!;
  options.adoptRenderer(cdp, originalHost.pid);
  const before = await readDesktopNativeStopSessions(fixture.root);
  const sources = before.filter(row => lifecycleRows(row.inputs).length > 0);
  assert.equal(sources.length, 1);
  const source = sources[0]!;
  assert.equal(source.phase, 'closed'); assert.equal(source.custody, 'released');
  assert.equal(lifecycleRows(source.inputs).length, 1);
  assert.equal(lifecycleRows(source.inputs)[0]!.terminal, 'succeeded');
  const originalCheckpoint = await readEmulatedClaudeCheckpoint(fixture, source);
  const product = await readEmulatedLifecycleProduct(fixture);
  const effects = await readDesktopEmulatedRuntimeEffects(fixture);
  const inputs = effects.filter(row => row.event === 'input');
  const proof: EmulatedLifecycleRow = { status: 'INCOMPLETE', provider: 'claude', nativeQualification: false,
    scope: 'Original guarded Quit and captured same-profile cold startup with peer-written provider history',
    firstEpoch: { app: evidence.app, rendererTarget: evidence.rendererTarget, host: originalHost,
      discovery: evidence.discovery, compiledBundleHashesAfterStartup: evidence.compiledBundleHashesAfterStartup },
    beforeQuitCheckpoint: { reference: originalCheckpoint.payload.reference,
      payloadFileSha256: originalCheckpoint.payloadFileSha256, historySha256: originalCheckpoint.historySha256 } };
  evidence.emulatedColdResumeBoundary = proof;
  const bundlePins = lifecycleRows(evidence.compiledBundleHashesAfterStartup);
  assert.ok(bundlePins.length > 0 && bundlePins.length <= 4096);
  const directory = join(fixture.root, 'emulated-cold-resume-epoch1-bundles');
  for (const pin of bundlePins) {
    const relative = String(pin.path), sha = String(pin.sha256);
    assert.ok(!relative.startsWith('/') && !relative.split('/').includes('..'));
    assert.match(relative, /\.(?:cjs|js)$/); assert.match(sha, /^[a-f0-9]{64}$/);
    const original = join(repo, 'dist-electron', relative), target = join(directory, relative);
    assert.equal(await fileDigest(original), sha); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(original, target, constants.COPYFILE_EXCL); assert.equal(await fileDigest(target), sha);
  }
  proof.epoch1BundleSnapshot = { directory, files: bundlePins };
  const quit: EmulatedLifecycleRow = { attempted: true }; proof.firstQuit = quit;
  options.markQuitRequested();
  try { await bounded(cdp.evaluate('window.electronAPI.windowControls.close()'), 3000, 'original finite-peer cold-boundary Quit'); quit.reply = 'acknowledged'; }
  catch (error) { quit.reply = 'unconfirmed'; quit.reason = /timed out/i.test(String(error)) ? 'timeout' : 'closed-or-rejected'; }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && (app.exitCode === null || groupMembers(group).length))
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  assert.equal(app.exitCode, 0); assert.equal(app.signalCode, null);
  assert.deepEqual(groupMembers(group), []); assert.equal(processTable().some(row => row.pid === originalHost.pid), false);
  await assert.rejects(lstat(join(fixture.root, 'hoststore/.legacy-agent-host-writer.lock')), { code: 'ENOENT' });
  const cleanup = await observeDesktopEmulatedRuntimeCleanup(fixture);
  assert.equal(cleanup.absent, true, 'original Host releases every captured detached peer before the next epoch');
  proof.firstCleanup = { appExitCode: app.exitCode, appSignalCode: app.signalCode,
    remaining: [], capturedHostAbsent: true, writerLockReleased: true, peerCleanup: cleanup };
  const afterQuit = await readDesktopNativeStopSessions(fixture.root);
  const retained = afterQuit.filter(row => isDeepStrictEqual(row.binding, source.binding));
  assert.deepEqual(retained, [source]);
  const profile = await json(fixture.profilePath), definition = record(lifecycleRows(profile.teams)[0]);
  const member = lifecycleRows(definition.members).find(row => row.memberId === 'alice-id')!;
  const { teamName: _teamName, ...descriptorBinding } = record(member.delivery);
  const predecessors = afterQuit.filter(row => !isDeepStrictEqual(row.binding, source.binding));
  assert.ok(predecessors.length <= 1, 'only the exact original static descriptor can gain a tombstone on Quit');
  for (const row of predecessors) {
    assert.deepEqual(row.binding, descriptorBinding);
    assert.deepEqual(row.inputs, []); assert.equal(row.config, null);
    assert.equal(row.phase, 'closed'); assert.equal(row.custody, 'released');
    assert.equal(row.openFingerprint, null); assert.equal(row.nativeReady, false); assert.equal(row.sealed, true);
  }
  assert.deepEqual(await readEmulatedLifecycleProduct(fixture), product);
  assert.deepEqual((await readDesktopEmulatedRuntimeEffects(fixture)).filter(row => row.event === 'input'), inputs);
  await bounded(cdp.close(), 3000, 'disconnect original finite-peer renderer'); options.adoptRenderer(undefined);
  assert.equal(await portOccupied(), false); await verifyDesktopEmulatedRuntimeFixture(fixture);
  const second: EmulatedLifecycleRow = { status: 'INCOMPLETE' }; proof.secondEpoch = second;
  const next = options.spawnNext(fixture);
  assert.ok(next.group > 0 && next.group !== group);
  second.app = { pid: next.app.pid, processGroup: next.group, identity: next.identity, invocation: next.invocation };
  const connected = await connectCapturedDesktopApp({ app: next.app, group: next.group,
    spawnError: next.spawnError, packed: undefined, cdpLibrary, evidence: second });
  options.adoptRenderer(connected.cdp);
  await attachRendererDiagnostics(connected.cdp, String(connected.target.url), second, {
    remainingMs: connected.startupBudgetMs - (performance.now() - connected.startupStarted),
    assertOwnedRenderer: () => assertOwnedCdpListener(next.group) });
  await verifyCapturedDesktopBinding({ cdp: connected.cdp, group: next.group, mode, fixture, evidence: second, repo, packed: undefined });
  const currentHosts = groupMembers(next.group).filter(row => command(row.pid) === `${fixture.node} ${fixture.hostEntry}`);
  assert.equal(currentHosts.length, 1); assert.notEqual(currentHosts[0]!.pid, originalHost.pid);
  options.adoptRenderer(connected.cdp, currentHosts[0]!.pid); second.host = currentHosts[0];
  assert.deepEqual(await readDesktopNativeStopSessions(fixture.root), afterQuit);
  assert.deepEqual(await readEmulatedLifecycleProduct(fixture), product);
  const cold = await readEmulatedClaudeCheckpoint(fixture, source);
  assert.equal(cold.payloadFileSha256, originalCheckpoint.payloadFileSha256);
  assert.equal(cold.historySha256, originalCheckpoint.historySha256);
  const coldEffects = await readDesktopEmulatedRuntimeEffects(fixture);
  assert.deepEqual(coldEffects.filter(row => row.event === 'input'), inputs);
  assert.deepEqual(coldEffects.filter(row => row.event === 'mcp-connected'), effects.filter(row => row.event === 'mcp-connected'));
  assert.deepEqual(record(second.discovery).bindings, record(evidence.discovery).bindings);
  assert.deepEqual(second.compiledBundleHashesAfterStartup, bundlePins);
  second.checkpointAndHistoryUnchanged = true; second.originalProductUnchanged = true;
  second.runtimeAllocations = 0; second.promptReplays = 0; second.status = 'PASS'; proof.status = 'PASS';
  return connected.cdp;
}
