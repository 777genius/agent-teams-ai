/** Current macOS candidate: one finite SDK Launch/Stop, original app.relaunch and successor Quit. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertNativeV1Source } from '../../packages/legacy-agent-host/tests/opencode-v1-version-source.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { assertDesktopProofEnvironment, assertOwnedCdpListener, command, groupMembers,
  portOccupied, selectedCdpPort } from './desktop-backend-observations.ts';
import { captureDesktopRendererFailure, cleanupCapturedDesktopApp, connectCapturedDesktopApp,
  observePackedAppRelaunch, verifyCapturedDesktopBinding } from './desktop-captured-app.ts';
import type { DesktopCdpLibrary, DesktopCdpPort } from './desktop-captured-app.ts';
import { runDesktopEmulatedLifecycleUi } from './desktop-emulated-lifecycle-ui.ts';
import { observeDesktopEmulatedRuntimeChildren, observeDesktopEmulatedRuntimeCleanup, prepareDesktopEmulatedRuntimeFixture,
  readDesktopEmulatedRuntimeEffects, verifyDesktopEmulatedRuntimeFixture } from './desktop-emulated-runtime-fixture.ts';
import { desktopProofEvidence } from './desktop-proof-evidence.ts';
import { bounded } from './desktop-proof-bounds.ts';
import { desktopProofSources } from './desktop-proof-sources.ts';
import { captureDesktopSourceHashes, verifyDesktopSourceFreeze } from './desktop-source-freeze.ts';
import { readPackagedOpenCodeV2 } from './packaged-opencode-v2-inputs.ts';
import { requestObservedDesktopClose } from './startup-passive-observer.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Row;
};

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'One disposable packaged CI checkout');
  assert.equal(process.platform, 'darwin'); assert.ok(process.arch === 'arm64' || process.arch === 'x64');
  assert.equal(process.version, 'v24.21.0');
  assert.equal(process.env.LEGACY_DESKTOP_EMULATED_ONLY, '1');
  assert.equal(process.env.LEGACY_DESKTOP_PROOF_MODE, 'emulated-claude-lifecycle-ui');
  assertDesktopProofEnvironment(false);
  assert.equal(await portOccupied(), false, 'Original TEST renderer port must be vacant');
  const [bundleArgument, pnpmArgument, receiptPath, ...extra] = process.argv.slice(2);
  assert.ok(bundleArgument && pnpmArgument && receiptPath && extra.length === 0);
  const repo = await realpath(resolve(import.meta.dirname, '../..'));
  assert.equal(await realpath(process.env.GITHUB_WORKSPACE!), repo);
  const sourceHead = process.env.OPENCODE_V2_TEST_SOURCE_HEAD!;
  assertNativeV1Source(repo, sourceHead);
  const runnerTemp = await realpath(process.env.RUNNER_TEMP!);
  assert.ok(isAbsolute(receiptPath) && dirname(receiptPath) === runnerTemp);
  await assert.rejects(lstat(receiptPath), { code: 'ENOENT' });
  const bundle = await realpath(resolve(repo, bundleArgument));
  const within = relative(repo, bundle);
  assert.ok(within.startsWith(`release${sep}`) && !within.split(sep).includes('..') && bundle.endsWith('.app'));
  const executableDirectory = join(bundle, 'Contents/MacOS');
  const executables = await readdir(executableDirectory);
  assert.equal(executables.length, 1, 'One original candidate application executable');
  const executable = await realpath(join(executableDirectory, executables[0]!));
  assert.equal(executable, join(executableDirectory, executables[0]!));
  const executableInfo = await lstat(executable);
  assert.ok(executableInfo.isFile() && !executableInfo.isSymbolicLink() && (executableInfo.mode & 0o111));
  const resources = join(bundle, 'Contents/Resources'), appAsar = join(resources, 'app.asar');
  const capture = { resourcesRoot: join(resources, 'legacy-agent-host'), appAsar,
    appAsarSha256: await fileDigest(appAsar), manifestSha256: process.env.OPENCODE_V2_PACKAGED_MANIFEST_SHA256! };
  const candidate = await readPackagedOpenCodeV2(capture);
  assert.equal(candidate.manifest.sourceHead, sourceHead);
  assert.equal(candidate.manifest.platform, `${process.platform}-${process.arch}`);
  assert.ok(candidate.processCustody);
  const packed = { executable, executableSha256: await fileDigest(executable),
    appAsar, appAsarSha256: capture.appAsarSha256,
    rendererUrl: pathToFileURL(join(appAsar, 'out/renderer/index.html')).href };
  const pnpm = await realpath(pnpmArgument);
  assert.ok(pnpm.startsWith(runnerTemp + sep), 'Existing isolated pinned Corepack fixture');
  assert.equal(record(JSON.parse(await readFile(join(dirname(pnpm), '../package.json'), 'utf8'))).version, '0.36.0');
  const fixture = await prepareDesktopEmulatedRuntimeFixture(repo, pnpm, 'claude', 'lifecycle', {
    nodeExecutable: candidate.node, nodeVersion: 'v' + candidate.manifest.node.version,
    hostEntry: candidate.entry, processCustody: candidate.processCustody,
  });
  assert.equal(fixture.pins.nodeSha256, candidate.manifest.node.binarySha256);
  assert.equal(fixture.pins.hostEntrySha256, candidate.manifest.hostEntrySha256);
  const pins = await verifyDesktopEmulatedRuntimeFixture(fixture);
  const mode = 'emulated-claude-lifecycle-ui';
  const evidence = await desktopProofEvidence({ mode, fixture, pnpm, pnpmSha256: await fileDigest(pnpm),
    electron: executable, smokePath: import.meta.filename, conversationMode: false, nativeStopMode: false, uiMode: true });
  Object.assign(evidence, { kind: 'TEST_PACKAGED_APP_RELAUNCH', sourceHead, platform: `${process.platform}-${process.arch}`,
    scope: 'Actual packaged macOS Electron and bundled Host, one finite SDK Launch/Stop, automatic app.relaunch and one successor public Quit',
    excluded: ['Claude/Codex executable execution', 'vendor inference/authentication', 'full cold Resume/active Quit', 'release qualification'],
    packedCandidate: { ...packed, capture, node: candidate.node, hostEntry: candidate.entry },
    fixturePins: pins, realVendorExecutions: 0, nativeProviderQualified: false, releaseQualified: false });
  const sources = [...new Set([...desktopProofSources,
    'scripts/legacy-agent-host/desktop-packaged-relaunch-smoke.ts',
    'packages/legacy-agent-host/tests/opencode-v1-version-source.ts',
    'scripts/e2e/comment-notification/cdp.mjs'])];
  const sourceHashes = await captureDesktopSourceHashes(repo, sources);
  evidence.selectedSourceHashesBeforeApp = sourceHashes;
  await writeFile(receiptPath, JSON.stringify(evidence, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ phase: 'prepared', receipt: receiptPath, root: fixture.root }));
  const require = createRequire(import.meta.url);
  const cdpLibrary = require('../e2e/comment-notification/cdp.mjs') as DesktopCdpLibrary;
  const logPath = receiptPath.replace(/\.json$/u, '') + '.app.log';
  const log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
  const invocation = [executable, `--remote-debugging-port=${selectedCdpPort}`];
  const app = spawn(executable, invocation.slice(1), { cwd: fixture.root,
    env: { ...fixture.appEnvironment, NODE_ENV: 'production', PATH: join(fixture.root, 'bin') + ':/usr/bin:/bin' },
    detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.pipe(log, { end: false }); app.stderr.pipe(log, { end: false });
  let spawnError = false, appIdentity = '', hostPid: number | undefined, cdp: DesktopCdpPort | undefined;
  let originalFailure: unknown, quitRequested = false;
  app.once('error', () => { spawnError = true; });
  const group = app.pid ?? 0;
  const assertOwnedRenderer = () => assertOwnedCdpListener(group);
  const relaunchAttempted = () => evidence.packedAppRelaunch !== undefined &&
    record(evidence.packedAppRelaunch).relaunchAttempted === true;
  try {
    assert.ok(group > 0);
    appIdentity = execFileSync('/bin/ps', ['-p', String(group), '-o', 'lstart=,command='],
      { encoding: 'utf8', timeout: 3000 }).trim();
    evidence.app = { pid: group, processGroup: group, identity: appIdentity, invocation };
    const connected = await connectCapturedDesktopApp({ app, group, spawnError: () => spawnError, packed, cdpLibrary, evidence });
    cdp = connected.cdp;
    await verifyCapturedDesktopBinding({ cdp, group, mode, fixture, evidence, repo, packed });
    await observeDesktopEmulatedRuntimeChildren(group, fixture, 'after-team-read');
    await runDesktopEmulatedLifecycleUi(cdp, { fixture, evidence, assertOwnedRenderer, originalStopOnly: true,
      restartSameProfile: async () => { throw new Error('Automatic app.relaunch cannot become a harness restart'); } });
    assert.equal(record(evidence.emulatedLaunchStopUiProof).status, 'PASS');
    assert.equal(evidence.emulatedLifecycleUiProof, undefined, 'This scope does not qualify the full cold Resume journey');
    const originalEffects = await readDesktopEmulatedRuntimeEffects(fixture);
    const inputEffects = originalEffects.filter(row => row.event === 'input');
    assert.equal(inputEffects.filter(row => row.marker !== 'TEST_MODEL_PROBE').length, 1,
      'One original SDK business input before relaunch');
    await observeDesktopEmulatedRuntimeChildren(group, fixture, 'after-team-read');
    const hosts = groupMembers(group).filter(row => command(row.pid) === `${fixture.node} ${fixture.hostEntry}`);
    assert.equal(hosts.length, 1); hostPid = hosts[0]!.pid;
    evidence.hostChild = { ...hosts[0], observedBeforeShutdown: true };
    await observePackedAppRelaunch({ app, cdp, group, hostPid, packed, fixture, evidence, repo, cdpLibrary });
    assert.equal(record(evidence.packedAppRelaunch).status, 'PASS');
    assert.deepEqual((await readDesktopEmulatedRuntimeEffects(fixture)).filter(row => row.event === 'input'), inputEffects,
      'Automatic relaunch cannot replay or add business input');
    evidence.originalInputEffects = inputEffects;
    evidence.status = 'PASS';
  } catch (error) {
    originalFailure = error; evidence.status = 'INCOMPLETE';
    evidence.failure = error instanceof Error ? error.message.slice(0, 4000) : 'original packaged relaunch failed';
    if (cdp && !relaunchAttempted()) {
      await captureDesktopRendererFailure(cdp, { group, root: fixture.root,
        screenshotName: 'ui-packaged-relaunch-failure.png', evidence });
      await requestObservedDesktopClose(cdp, { assertOwnedRenderer, onAttempt: () => { quitRequested = true; },
        listenerPresent: () => groupMembers(group).some(row => row.pid === evidence.cdpListener), evidence,
        key: 'failureQuit' }).catch(() => { evidence.failureQuitUnconfirmed = true; });
    }
  } finally {
    if (cdp) await bounded(cdp.close(), 3000, 'disconnect original packaged renderer').catch(() => undefined);
    evidence.quitRequested = quitRequested;
    const cleanup = await cleanupCapturedDesktopApp({ app, group, fixture, evidence, appIdentity,
      hostPid, packedRelaunchMode: relaunchAttempted() });
    evidence.cleanup = cleanup;
    if (cleanup.cleanupFailure || cleanup.remaining === null || cleanup.remaining.length || !cleanup.capturedHostAbsent ||
      app.exitCode !== 0 || app.signalCode !== null) evidence.status = 'INCOMPLETE';
    try {
      const peers = await observeDesktopEmulatedRuntimeCleanup(fixture);
      evidence.emulatedRuntimeCleanup = peers; assert.equal(peers.absent, true);
      const census = (await readFile(fixture.sentinelLog, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error;
      })).trim().split('\n').filter(Boolean).map(line => record(JSON.parse(line)));
      evidence.finalSentinelCensus = census;
      assert.ok(census.every(row => row.executable === 'shell-env' ? row.allowed === true :
        row.allowed === false && row.argc === 1 && Array.isArray(row.flags) && row.flags.length === 1 && row.flags[0] === '--version'));
      assert.deepEqual(await verifyDesktopEmulatedRuntimeFixture(fixture), pins);
      assert.deepEqual(await readPackagedOpenCodeV2(capture), candidate);
      assert.equal(await fileDigest(executable), packed.executableSha256);
      evidence.packagedInputsUnchanged = true;
    } catch (error) {
      evidence.status = 'INCOMPLETE'; evidence.finalObservationFailure = error instanceof Error ? error.message.slice(0, 2000) : 'unknown';
    }
    await verifyDesktopSourceFreeze(repo, sources, sourceHashes, evidence);
    app.stdout.unpipe(log); app.stderr.unpipe(log); app.stdout.resume(); app.stderr.resume();
    await bounded(new Promise<void>(done => log.end(done)), 3000, 'close packaged relaunch log')
      .catch(() => { evidence.status = 'INCOMPLETE'; evidence.logCleanupFailed = true; });
    await writeFile(receiptPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ kind: evidence.kind, status: evidence.status, receipt: receiptPath, root: fixture.root }));
  }
  if (originalFailure) throw originalFailure;
  assert.equal(evidence.status, 'PASS', 'Original packaged relaunch and all cleanup must pass');
}

await main();
