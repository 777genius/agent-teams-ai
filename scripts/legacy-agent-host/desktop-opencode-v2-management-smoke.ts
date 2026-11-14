import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileDigest } from './desktop-backend-fixture.ts';
import { assertDesktopProofEnvironment, assertOwnedCdpListener, groupMembers, portOccupied,
  processTable, selectedCdpPort } from './desktop-backend-observations.ts';
import { cleanupCapturedDesktopApp, connectCapturedDesktopApp, verifyCapturedDesktopBinding } from './desktop-captured-app.ts';
import { assertDesktopV2ManagementEnvironment, prepareDesktopV2ManagementFixture,
  verifyDesktopV2ManagementFixture } from './desktop-opencode-v2-management-fixture.ts';
import { startDesktopV2ManagementModel } from './desktop-opencode-v2-management-model.ts';
import { observeDesktopV2ManagementProcesses } from './desktop-opencode-v2-management-process.ts';
import { runDesktopV2ManagementUi } from './desktop-opencode-v2-management-ui.ts';
import { bounded } from './desktop-proof-bounds.ts';
import { desktopProofEvidence, verifyDesktopProofInputsAfterCleanup } from './desktop-proof-evidence.ts';
import { desktopProofSources } from './desktop-proof-sources.ts';
import { captureDesktopSourceHashes, verifyDesktopSourceFreeze } from './desktop-source-freeze.ts';
import { attachRendererDiagnostics } from './desktop-team-ui-smoke.ts';
import { requestObservedDesktopClose } from './startup-passive-observer.ts';
import type { DesktopCdpPort, DesktopCdpLibrary } from './desktop-captured-app.ts';

/** Separate native OpenCode-only scope. The provider-emulation admission stays unchanged. */
async function main() {
  assertDesktopV2ManagementEnvironment(); assertDesktopProofEnvironment(true);
  assert.equal(await portOccupied(), false, 'selected TEST CDP port must be vacant');
  const repo = await realpath(join(import.meta.dirname, '../..'));
  const pnpm = await realpath(process.env.LEGACY_DESKTOP_PNPM_PATH!);
  const model = await startDesktopV2ManagementModel();
  let modelCloseAttempted = false;
  try {
    const fixture = await prepareDesktopV2ManagementFixture(repo, pnpm, model);
    const pins = await verifyDesktopV2ManagementFixture(fixture);
    const pnpmSha256 = await fileDigest(pnpm);
    assert.equal(await realpath(process.execPath), fixture.node);
    for (const [actual, expected] of [
      [fixture.pins.nodeSha256, process.env.LEGACY_DESKTOP_NODE_SHA256],
      [fixture.pins.hostEntrySha256, process.env.LEGACY_DESKTOP_HOST_ENTRY_SHA256],
      [pnpmSha256, process.env.LEGACY_DESKTOP_PNPM_SHA256],
      [fixture.pins.corepackPackageSha256, process.env.LEGACY_DESKTOP_COREPACK_PACKAGE_SHA256],
      [fixture.pins.corepackLibrarySha256, process.env.LEGACY_DESKTOP_COREPACK_LIBRARY_SHA256],
    ]) { assert.match(expected ?? '', /^[a-f0-9]{64}$/u); assert.equal(actual, expected); }
    const require = createRequire(import.meta.url);
    const cdpLibrary = require('../e2e/comment-notification/cdp.mjs') as DesktopCdpLibrary;
    const electron = await realpath(join(require.resolve('electron/package.json'), '../dist/electron'));
    const mode = 'opencode-v2-management-ui';
    const evidence = await desktopProofEvidence({ mode, fixture, pnpm, pnpmSha256, electron,
      smokePath: import.meta.filename, conversationMode: false, nativeStopMode: false, uiMode: true });
    Object.assign(evidence, {
      scope: 'Actual Electron Settings and captured native OpenCode V2 with five finite localhost model intents',
      excluded: ['Claude/Codex execution', 'vendor authentication/inference', 'native V2 OAuth/forget', 'release qualification'],
      source: {
        head: execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
        dirty: execFileSync('/usr/bin/git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim().length > 0,
      },
      nativeV2Input: pins, finiteModel: { requests: model.requests, failures: model.failures },
      ...(fixture.linuxChildExec ? { linuxChildExecInput: fixture.linuxChildExec } : {}),
    });
    const sources = [...new Set([...desktopProofSources, 'scripts/legacy-agent-host/verify-desktop-v2-management-receipt.ts', ...['fixture', 'model', 'process', 'smoke', 'ui']
      .map(name => `scripts/legacy-agent-host/desktop-opencode-v2-management-${name}.ts`)])];
    const sourceHashes = await captureDesktopSourceHashes(repo, sources);
    evidence.selectedSourceHashesBeforeApp = sourceHashes;
    const receiptPath = join(fixture.root, 'desktop-backend-receipt.json');
    await writeFile(receiptPath, JSON.stringify(evidence, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ phase: 'prepared', receipt: receiptPath }));
    const log = createWriteStream(join(fixture.root, 'desktop-backend-app.log'), { mode: 0o600 });
    const invocation = [fixture.node, pnpm, 'dev:mcp', '--remoteDebuggingPort', String(selectedCdpPort), '--noSandbox'];
    const app = spawn(invocation[0]!, invocation.slice(1), { cwd: repo, env: fixture.appEnvironment,
      detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let spawnError = false, appIdentity = '', quitRequested = false;
    let cdp: DesktopCdpPort | undefined;
    app.once('error', () => { spawnError = true; });
    app.stdout.pipe(log, { end: false }); app.stderr.pipe(log, { end: false });
    const group = app.pid ?? 0, native = observeDesktopV2ManagementProcesses(group, fixture);
    evidence.nativeProcesses = { children: native.children, probes: native.probes };
    const assertOwnedRenderer = () => { assertOwnedCdpListener(group); };
    const close = async (key: 'startupDiagnosticClose' | 'failureQuit') => {
      assert.ok(cdp);
      await requestObservedDesktopClose(cdp, { assertOwnedRenderer,
        onAttempt: () => { quitRequested = true; },
        listenerPresent: () => processTable().some(row => row.pid === evidence.cdpListener), evidence, key });
    };
    try {
      assert.ok(group > 0);
      appIdentity = execFileSync('/bin/ps', ['-p', String(group), '-o', 'lstart=,command='],
        { encoding: 'utf8', timeout: 3000 }).trim();
      evidence.app = { pid: group, processGroup: group, identity: appIdentity, invocation };
      const connected = await connectCapturedDesktopApp({ app, group, spawnError: () => spawnError,
        packed: undefined, cdpLibrary, evidence });
      cdp = connected.cdp;
      const remainingMs = () => connected.startupBudgetMs - (performance.now() - connected.startupStarted);
      await attachRendererDiagnostics(cdp, String(connected.target.url), evidence, { remainingMs: remainingMs(), assertOwnedRenderer });
      await verifyCapturedDesktopBinding({ cdp, group, mode, fixture, evidence, repo, packed: undefined, remainingStartupMs: remainingMs() });
      await native.observe();
      await runDesktopV2ManagementUi(cdp, { fixture, model, evidence, assertOwnedRenderer,
        observeNative: step => native.observe(step) });
      assert.equal(native.probes.length, 5);
      evidence.hostChild = { ...native.hostIdentity(), observedBeforeShutdown: true };
      // Passive native directory owners deliberately remain live until this Host closes.
      evidence.nativeBeforeClose = await native.remaining();
      await close('startupDiagnosticClose');
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && (groupMembers(group).length || app.exitCode === null))
        await new Promise<void>(resolve => setTimeout(resolve, 100));
      assert.equal(processTable().some(row => row.pid === native.hostPid()), false, 'original Host retired on app close');
      assert.deepEqual(await native.remaining(), [], 'original native directory and probe children retired on app close');
      evidence.originalClose = { appExitCode: app.exitCode, appSignalCode: app.signalCode,
        groupRemaining: groupMembers(group), hostAbsent: true, nativeRemaining: await native.remaining() };
      assert.deepEqual(groupMembers(group), [], 'original app close empties its group before harness cleanup');
      assert.equal(app.exitCode, 0); assert.equal(app.signalCode, null);
      evidence.status = 'PASS';
    } catch (error) {
      evidence.status = 'INCOMPLETE';
      evidence.failure = error instanceof Error ? { name: error.name, message: error.message.slice(0, 2000) } : 'original UI flow failed';
      if (cdp && !quitRequested) {
        try {
          assertOwnedRenderer();
          const capture = await bounded(cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }), 5000, 'failure screenshot') as { data: string };
          const path = join(fixture.root, 'ui-v2-management-failure.png');
          await writeFile(path, Buffer.from(capture.data, 'base64'), { mode: 0o600, flag: 'wx' });
          evidence.failureScreenshot = { path, sha256: await fileDigest(path) };
        } catch { evidence.failureScreenshotUnavailable = true; }
        await close('failureQuit').catch(() => { evidence.failureQuit = { attempted: quitRequested, unconfirmed: true }; });
      }
      throw error;
    } finally {
      evidence.quitRequested = quitRequested;
      if (cdp) await bounded(cdp.close(), 3000, 'disconnect TEST renderer').catch(() => undefined);
      evidence.cleanup = await cleanupCapturedDesktopApp({ app, group, fixture, evidence, appIdentity,
        hostPid: native.hostPid(), packedRelaunchMode: false });
      const cleanup = evidence.cleanup as Awaited<ReturnType<typeof cleanupCapturedDesktopApp>>;
      if (cleanup.cleanupFailure || cleanup.remaining === null || cleanup.remaining.length || !cleanup.capturedHostAbsent)
        evidence.status = 'INCOMPLETE';
      if (!Array.isArray(evidence.beforeHarnessCleanup) || evidence.beforeHarnessCleanup.length !== 0 ||
          app.exitCode !== 0 || app.signalCode !== null) evidence.status = 'INCOMPLETE';
      try {
        evidence.nativeRemaining = await native.remaining();
        assert.deepEqual(evidence.nativeRemaining, []);
        evidence.nativeV2InputAfterCleanup = await verifyDesktopV2ManagementFixture(fixture);
        const census = (await readFile(fixture.sentinelLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { allowed: boolean });
        evidence.finalSentinelCensus = census;
        assert.ok(census.length > 0 && census.every(row => row.allowed === true), 'only finite version/shell sentinels may execute');
      } catch { evidence.status = 'INCOMPLETE'; evidence.finalObservationFailed = true; }
      await verifyDesktopSourceFreeze(repo, sources, sourceHashes, evidence);
      await verifyDesktopProofInputsAfterCleanup([], fixture, evidence);
      try { model.assertComplete(); evidence.finiteModelCompleteAfterCleanup = true; }
      catch { evidence.status = 'INCOMPLETE'; evidence.finiteModelCompleteAfterCleanup = false; }
      modelCloseAttempted = true;
      try { await model.close(); evidence.modelServerClosed = true; }
      catch { evidence.status = 'INCOMPLETE'; evidence.modelServerClosed = false; }
      app.stdout.unpipe(log); app.stderr.unpipe(log); app.stdout.resume(); app.stderr.resume();
      await bounded(new Promise<void>(resolve => log.end(resolve)), 3000, 'close TEST log')
        .catch(() => { evidence.status = 'INCOMPLETE'; evidence.logCleanupFailed = true; });
      await writeFile(receiptPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ mode, status: evidence.status, receipt: receiptPath }));
    }
    assert.equal(evidence.status, 'PASS', 'original V2 UI proof and cleanup must both pass; inspect retained receipt');
  } finally { if (!modelCloseAttempted) await model.close(); }
}

await main();
