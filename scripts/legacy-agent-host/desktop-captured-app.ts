import assert from 'node:assert/strict';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { bounded } from './desktop-proof-bounds.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { assertOwnedCdpListener, command, processTable, selectedCdpPort, compiledBundleHashes, getTargets, portOccupied,
  readRendererBackendConnections, safeGroupSnapshot } from './desktop-backend-observations.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { readCapturedCandidateElectron } from './candidate-electron.ts';
export interface DesktopCdpPort {
  on(method: string, listener: (value: unknown) => void): void;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  close(): Promise<void>;
}
export interface DesktopCdpLibrary { CdpClient: { connect(url: string): Promise<DesktopCdpPort> } }
type Evidence = Record<string, unknown>;
type Fixture = Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
type Packed = Awaited<ReturnType<typeof readCapturedCandidateElectron>> | undefined;
const object = (value: unknown): Evidence => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Evidence;
};
const tick = () => new Promise<void>(done => setTimeout(done, 100));
/** Existing bounded startup and CDP ownership checks shared by two captured TEST epochs. */
export async function connectCapturedDesktopApp(options: {
  app: ChildProcess; group: number; spawnError(): boolean; packed: Packed;
  cdpLibrary: DesktopCdpLibrary; evidence: Evidence;
}) {
  const { app, group, packed, cdpLibrary, evidence } = options;
  const startupStarted = performance.now();
  const startupBudgetMs = 180_000;
  const startupTimeline: Record<string, unknown>[] = [];
  evidence.startup = {
    budgetMs: startupBudgetMs,
    rationale:
      'Attempt3 measured main build41.75s and Electron launch about71s after invocation; former90s budget left about19s for app/CDP. Only dev startup/readiness budget extended.',
    clock: 'monotonic performance.now elapsed milliseconds',
    timeline: startupTimeline,
  };
  let lastStartupSample = -1000;
  let target: Record<string, unknown> | undefined;
  while (performance.now() - startupStarted < startupBudgetMs) {
    const phase: Record<string, unknown> = {
      portOccupied: null,
      targetCount: null,
      matchingMainCount: null,
    };
    try {
      assert.equal(options.spawnError(), false, 'captured pnpm launch failed');
      assert.equal(app.exitCode, null, 'captured app exited during startup');
      if (await portOccupied()) {
        phase.portOccupied = true;
        evidence.cdpListener = assertOwnedCdpListener(group);
        const targets = await getTargets();
        const pages = targets.filter(
          (row) =>
            row.type === 'page' &&
            typeof row.url === 'string' &&
            (packed ? row.url.split(/[?#]/u)[0] === packed.rendererUrl : /^http:\/\/localhost:\d+\/?(?:[#?].*)?$/.test(row.url))
        );
        phase.targetCount = targets.length;
        phase.matchingMainCount = pages.length;
        phase.hasMatchingMain = pages.length === 1;
        if (pages.length === 1) {
          target = pages[0];
          break;
        }
      } else phase.portOccupied = false;
    } catch (error) {
      phase.errorName = error instanceof Error ? error.name : 'unknown';
      if (error instanceof assert.AssertionError) throw error;
      // Read-only readiness discovery may race the test app's listener startup.
    } finally {
      const elapsedMs = Math.round(performance.now() - startupStarted);
      if (elapsedMs - lastStartupSample >= 1000 && startupTimeline.length < 180) {
        lastStartupSample = elapsedMs;
        let groupSnapshot: unknown;
        try {
          groupSnapshot = safeGroupSnapshot(group);
        } catch {
          groupSnapshot = { unavailable: true };
        }
        startupTimeline.push({
          elapsedMs,
          ...phase,
          processGroup: groupSnapshot,
          appExitCode: app.exitCode,
          appSignalCode: app.signalCode,
          spawnError: options.spawnError(),
        });
      }
    }
    await tick();
  }
  evidence.startupOutcome = {
    elapsedMs: Math.round(performance.now() - startupStarted),
    matchingMainFound: target !== undefined,
    appExitCode: app.exitCode,
    appSignalCode: app.signalCode,
    spawnError: options.spawnError(),
  };
  assert.ok(target, 'one main TEST renderer target becomes available');
  assert.equal(typeof target.webSocketDebuggerUrl, 'string');
  assertOwnedCdpListener(group);
  const cdp = await bounded(
    cdpLibrary.CdpClient.connect(String(target.webSocketDebuggerUrl)),
    5000,
    'attach captured renderer'
  );
  evidence.rendererTarget = { id: target.id, url: target.url };
  return { cdp, target, startupStarted, startupBudgetMs };
}
/** Existing descriptor, compiled bytes and safe HOME checks; no product mutation. */
export async function verifyCapturedDesktopBinding(options: {
  cdp: DesktopCdpPort; mode: string; fixture: Fixture; evidence: Evidence; repo: string; packed: Packed;
} & ({ group: number; assertOwnedRenderer?: never } | { group?: never; assertOwnedRenderer(): void })): Promise<void> {
  const { cdp, group, mode, fixture, evidence, repo, packed } = options;
  const assertCurrent = options.assertOwnedRenderer ?? (() => { assert.ok(group !== undefined); assertOwnedCdpListener(group); });
  const bridgeDeadline = Date.now() + 60_000;
  let connections: Record<string, unknown> | undefined;
  let discoveryAttempts = 0;
  const transientDiscovery: string[] = [];
  while (Date.now() < bridgeDeadline) {
    assertCurrent();
    const discovery = await readRendererBackendConnections(cdp);
    if (discovery.kind === 'read') {
      discoveryAttempts++;
      connections = object(discovery.value);
      if (connections.state === 'ready') break;
      assert.ok(
        ['hold', 'unconfigured'].includes(String(connections.state)),
        'unexpected discovery state'
      );
    } else if (transientDiscovery.length < 16) transientDiscovery.push(discovery.reason);
    await tick();
  }
  evidence.discoveryReadiness = { attempts: discoveryAttempts, transient: transientDiscovery };
  evidence.discovery = connections;
  assert.ok(connections, 'read-only backend discovery became available within its bound');
  assert.equal(connections.state, 'ready');
  assert.ok(Array.isArray(connections.bindings));
  assert.equal(connections.bindings.length, ['task-board-cross-team-ui', 'cross-team-ui'].includes(mode) ? 3 : 1);
  const binding = object(connections.bindings.find((value) => object(object(value).handle).handleId === fixture.handleId));
  assert.deepEqual(binding.handle, { handleId: fixture.handleId });
  assert.deepEqual(Object.keys(binding).sort(), ['handle', 'label', 'members', 'ownerResourceRef', 'teamResourceRef']);
  assert.match(String(binding.ownerResourceRef), /^[a-f0-9]{64}$/);
  assert.match(String(binding.teamResourceRef), /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  evidence.compiledBundleHashesAfterStartup = packed ? { appAsar: { path: packed.appAsar, sha256: await fileDigest(packed.appAsar) } } : await compiledBundleHashes(
    join(repo, 'dist-electron')
  );
  evidence.bundleProvenance =
    packed ? 'Actual captured packed executable/app.asar and candidate runtime census; no source bundle fallback' : 'Actual compiled main/preload JS bytes hashed after owned app startup; no claim of reproducible source-to-bundle rebuild';
  // Existing read-only API can witness Electron's native home resolution once
  // legacy config handlers are ready. Its absence is recorded without staging UI.
  try {
    const roots = object(
      await bounded(
        cdp.evaluate('window.electronAPI.config.getClaudeRootInfo()'),
        5000,
        'read safe root paths'
      )
    );
    evidence.homePathProof = roots;
    assert.equal(roots.resolvedPath, join(fixture.root, 'claude'));
    assert.equal(typeof roots.defaultPath, 'string');
    assert.equal(basename(String(roots.defaultPath)), '.claude');
    const canonicalDefault = join(await realpath(dirname(String(roots.defaultPath))), '.claude');
    const canonicalExpectedDefault = join(await realpath(join(fixture.root, 'home')), '.claude');
    assert.equal(canonicalDefault, canonicalExpectedDefault);
    evidence.homePathProof = { ...roots, canonicalDefaultPath: canonicalDefault };
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    evidence.homePathProof = {
      unavailable: error instanceof Error ? error.message.slice(0, 1000) : 'unavailable',
    };
  }
}

/** Observer-only automatic successor: public Quit authority is the current verified TEST CDP, never a PID. */
export async function observePackedAppRelaunch(options: {
  app: ChildProcess; cdp: DesktopCdpPort; group: number; hostPid: number;
  packed: NonNullable<Packed>; fixture: Fixture; evidence: Evidence; repo: string; cdpLibrary: DesktopCdpLibrary;
}): Promise<void> {
  const { app, cdp, packed, fixture, evidence, repo, cdpLibrary } = options;
  const proof: Evidence = { status: 'UNKNOWN', scope: 'Automatic packed app.relaunch, observer-only successor and one guarded public Quit', successorNativeCustody: false, numericPidSignalsAuthorized: false, providerRootCleanupQualification: 'outside this observer-only app lifecycle scope' };
  evidence.packedAppRelaunch = proof;
  const leasePath = join(fixture.root, 'hoststore/.legacy-agent-host-writer.lock');
  const lease = async () => {
    try {
      const info = await lstat(leasePath); assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 256);
      const match = /^([1-9][0-9]*)\n([0-9]+)\n([a-f0-9-]{36})\n$/.exec(await readFile(leasePath, 'utf8'));
      assert.ok(match); return { pid: Number(match[1]), token: match[3]!, dev: info.dev, ino: info.ino };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const listener = () => {
    try {
      const rows = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${selectedCdpPort}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 3000 }).trim().split('\n');
      assert.ok(rows.every(row => /^[1-9][0-9]*$/.test(row))); const pids = [...new Set(rows.map(Number))]; assert.equal(pids.length, 1); return pids[0]!;
    } catch (error) { const e = error as { status?: number; stdout?: string; stderr?: string }; if (e.status === 1 && !e.stdout?.trim() && !e.stderr?.trim()) return undefined; throw error; }
  };
  const identity = () => {
    const pid = listener(); assert.ok(pid && pid !== app.pid);
    const executablePath = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 3000 }).trim();
    assert.ok(executablePath === packed.executable, 'successor listener executable is not the captured candidate'); const executable = realpathSync(executablePath);
    const argv = command(pid); assert.ok(argv === `${packed.executable} --remote-debugging-port=${selectedCdpPort}`, 'successor argv differs from the original TEST invocation');
    return { pid, executable, argv, started: execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 3000 }).trim() };
  };
  let successor: DesktopCdpPort | undefined;
  try {
    assert.equal(app.exitCode, null); assert.equal(app.signalCode, null); assertOwnedCdpListener(options.group);
    const originalLease = await lease(); assert.ok(originalLease); assert.equal(originalLease.pid, options.hostPid); proof.originalLease = originalLease;
    const originalSessions = (await readDesktopNativeStopSessions(fixture.root)).filter(row => Array.isArray(row.inputs) && row.inputs.length > 0);
    assert.equal(originalSessions.length, 1); assert.ok(originalSessions.every(row => row.phase === 'closed' && row.custody === 'released')); proof.originalSessions = originalSessions;
    await writeFile(join(fixture.root, 'original-app-relaunch-intent.json'), JSON.stringify({ action: 'existing public app:relaunch once', originalAppPid: app.pid, originalHostPid: options.hostPid, originalLease }), { flag: 'wx', mode: 0o600 });
    proof.relaunchAttempted = true;
    try { await bounded(cdp.evaluate('window.electronAPI.windowControls.relaunch()'), 3000, 'one original public app relaunch'); proof.relaunchReply = 'acknowledged'; }
    catch { proof.relaunchReply = 'unconfirmed; original action is never repeated'; }
    await bounded(cdp.close(), 3000, 'disconnect original relaunch renderer').catch(() => undefined);
    const until = Date.now() + 180_000;
    while (app.exitCode === null && app.signalCode === null && Date.now() < until) await tick();
    proof.originalExit = { exitCode: app.exitCode, signalCode: app.signalCode, HostExitCode: 'unavailable', HostSignalCode: 'unavailable' };
    assert.equal(app.exitCode, 0, 'original captured app exits without a harness signal'); assert.equal(app.signalCode, null);
    assert.ok(!processTable().some(row => row.pid === options.hostPid), 'original Host must retire before successor qualification');
    const boundaryLease = await lease(); proof.leaseAfterOriginalExit = boundaryLease;
    assert.notEqual(boundaryLease?.token, originalLease.token, 'original writer token still published after shutdown; retain debt');
    while (listener() === undefined && Date.now() < until) await tick();
    assert.equal(await fileDigest(packed.executable), packed.executableSha256); assert.equal(await fileDigest(packed.appAsar), packed.appAsarSha256);
    const observed = identity(); proof.successorIdentity = { ...observed, observationOnly: true };
    const current = () => assert.deepEqual(identity(), observed, 'current successor listener remains the observed TEST process');
    let pages: Evidence[] = [];
    while (Date.now() < until) {
      current(); pages = (await getTargets()).filter(row => row.type === 'page' && typeof row.url === 'string' && row.url.split(/[?#]/u)[0] === packed.rendererUrl);
      assert.ok(pages.length <= 1); if (pages.length === 1) break; await tick();
    }
    assert.equal(pages.length, 1); assert.notEqual(pages[0]!.id, object(evidence.rendererTarget).id);
    successor = await bounded(cdpLibrary.CdpClient.connect(String(pages[0]!.webSocketDebuggerUrl)), 5000, 'connect observed successor');
    const homeExpression = `(async () => {
      if (document.readyState !== 'complete' || document.getElementById('splash') || !window.electronAPI?.config?.getClaudeRootInfo) return null;
      try { return await window.electronAPI.config.getClaudeRootInfo(); }
      catch (error) { if (/No handler registered for ['"]config:getClaudeRootInfo['"]/.test(String(error))) return null; throw error; }
    })()`;
    const controls = createDesktopUiControls(successor, { assertOwnedRenderer: current, step: () => undefined });
    const remainingStartupMs = Math.max(1, until - Date.now());
    const home = object(await bounded(controls.waitRead(homeExpression, 'successor preload/config readiness', remainingStartupMs), remainingStartupMs, 'successor TEST home before backend discovery'));
    assert.equal(home.resolvedPath, join(fixture.root, 'claude')); assert.equal(basename(String(home.defaultPath)), '.claude');
    assert.equal(join(await realpath(dirname(String(home.defaultPath))), '.claude'), join(await realpath(join(fixture.root, 'home')), '.claude'));
    proof.successorHomeBeforeBackend = home;
    const second: Evidence = { rendererTarget: { id: pages[0]!.id, url: pages[0]!.url } }; proof.successorBinding = second;
    await verifyCapturedDesktopBinding({ cdp: successor, mode: 'native-launch-ui', fixture, evidence: second, repo, packed, assertOwnedRenderer: current });
    assert.deepEqual(second.homePathProof, evidence.homePathProof); assert.deepEqual(object(second.discovery).bindings, object(evidence.discovery).bindings);
    const roots = object(second.homePathProof); assert.equal(roots.resolvedPath, join(fixture.root, 'claude'));
    assert.equal(roots.canonicalDefaultPath, join(await realpath(join(fixture.root, 'home')), '.claude'));
    const newLease = await lease(); assert.ok(newLease); assert.notEqual(newLease.token, originalLease.token); assert.notEqual(newLease.pid, originalLease.pid);
    const host = processTable().find(row => row.pid === newLease.pid); assert.ok(host && host.ppid === observed.pid); assert.equal(command(host.pid), `${fixture.node} ${fixture.hostEntry}`);
    proof.writerOrdering = { originalHostAbsent: true, originalLease, newExclusiveLease: newLease, rule: 'Existing no-replace PID/token publication forbids overlap; original release versus dead-owner recovery is not inferred from a missed absence sample' };
    current(); assert.deepEqual((await readDesktopNativeStopSessions(fixture.root)).filter(row => Array.isArray(row.inputs) && row.inputs.length > 0), originalSessions);
    const image = object(await successor.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
    await writeFile(join(fixture.root, 'ui-automatic-app-relaunch-successor.png'), Buffer.from(String(image.data), 'base64'), { flag: 'wx', mode: 0o600 });
    current(); assert.equal(String(await successor.evaluate('location.href')).split(/[?#]/u)[0], packed.rendererUrl);
    assert.equal(await fileDigest(packed.executable), packed.executableSha256); assert.equal(await fileDigest(packed.appAsar), packed.appAsarSha256);
    await writeFile(join(fixture.root, 'successor-public-quit-intent.json'), JSON.stringify({ action: 'current verified TEST successor public Quit once', observed }), { flag: 'wx', mode: 0o600 });
    current(); proof.successorQuitAttempted = true;
    try { await bounded(successor.evaluate('window.electronAPI.windowControls.close()'), 3000, 'one current successor guarded Quit'); proof.successorQuitReply = 'acknowledged'; }
    catch { proof.successorQuitReply = 'unconfirmed; no retry or signal'; }
    const closeUntil = Date.now() + 20_000;
    while (Date.now() < closeUntil && (listener() !== undefined || processTable().some(row => row.pid === observed.pid || row.pid === host.pid) || await lease())) await tick();
    proof.successorAbsence = { listenerAbsent: listener() === undefined, observedPidAbsent: !processTable().some(row => row.pid === observed.pid), HostPidAbsent: !processTable().some(row => row.pid === host.pid), writerLockAbsent: await lease() === null, exitCode: 'unavailable', signalCode: 'unavailable', naturalExitQualified: false };
    const absent = object(proof.successorAbsence); assert.ok(absent.listenerAbsent && absent.observedPidAbsent && absent.HostPidAbsent && absent.writerLockAbsent);
    const after = await readDesktopNativeStopSessions(fixture.root); assert.ok(after.every(row => row.phase === 'closed' && row.custody === 'released'));
    assert.deepEqual(after.filter(row => Array.isArray(row.inputs) && row.inputs.length > 0), originalSessions);
    proof.status = 'PASS';
  } catch (error) { proof.failure = error instanceof Error ? error.message.slice(0, 2000) : 'unknown successor'; throw error; }
  finally { await bounded(successor?.close() ?? Promise.resolve(), 3000, 'disconnect observed successor').catch(() => undefined); }
}
