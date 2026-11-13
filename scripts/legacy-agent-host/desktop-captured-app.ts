import assert from 'node:assert/strict';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { constants, realpathSync } from 'node:fs';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { checkpoint } from './desktop-resume-records.ts';
import { attachRendererDiagnostics } from './desktop-team-ui-smoke.ts';
import { assertFirstResumeMetadataAbsent } from './desktop-opencode-v2-cold-metadata.ts';
import { bounded } from './desktop-proof-bounds.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { assertOwnedCdpListener, command, processTable, selectedCdpPort, compiledBundleHashes, getTargets, portOccupied,
  readRendererBackendConnections, safeGroupSnapshot, settledGroupMembers, observeExitedAppGroup, observeOriginalAppReap, isCapturedOriginalNodeZombie, groupMembers } from './desktop-backend-observations.ts';
import type { ProcessIdentity } from './desktop-backend-observations.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { readCapturedCandidateElectron } from './candidate-electron.ts';
export interface DesktopCdpPort {
  on(method: string, listener: (value: unknown) => void): void;
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  evaluate(expression: string, timeoutMs?: number): Promise<unknown>;
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
  remainingStartupMs?: number;
} & ({ group: number; assertOwnedRenderer?: never } | { group?: never; assertOwnedRenderer(): void })): Promise<void> {
  const { cdp, group, mode, fixture, evidence, repo, packed } = options;
  const assertCurrent = options.assertOwnedRenderer ?? (() => { assert.ok(group !== undefined); assertOwnedCdpListener(group); });
  const bridgeDeadline = performance.now() + Math.min(60_000, options.remainingStartupMs ?? 60_000);
  let connections: Record<string, unknown> | undefined;
  let discoveryAttempts = 0;
  const transientDiscovery: string[] = [];
  while (performance.now() < bridgeDeadline) {
    assertCurrent();
    const discovery = await readRendererBackendConnections(cdp, options.remainingStartupMs === undefined
      ? undefined : Math.floor(bridgeDeadline - performance.now()));
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

/** Existing final captured app/group cleanup; preserves original identity and signal gates. */
export async function cleanupCapturedDesktopApp(options: {
  app: ChildProcess;
  group: number;
  fixture: Pick<Fixture, 'node' | 'hostEntry'>;
  evidence: Evidence;
  appIdentity: string;
  hostPid: number | undefined;
  packedRelaunchMode: boolean;
}) {
  const { app, group, fixture, evidence, appIdentity, packedRelaunchMode } = options;
  let hostPid = options.hostPid;
  let remaining: ProcessIdentity[] | null = null;
  let cleanupFailure: string | undefined;
  let capturedHostAbsent: boolean | null = null;
  try {
    // Yield for ChildProcess exit/reaping before inspecting a just-closed dev wrapper.
    await tick();
    const observationDeadline = Date.now() + 3000;
    remaining = group > 0 ? await settledGroupMembers(group, observationDeadline) : [];
    evidence.beforeHarnessCleanup = remaining;
    if (hostPid === undefined) {
      const hosts = remaining.filter(
        (row) => command(row.pid) === `${fixture.node} ${fixture.hostEntry}`
      );
      if (hosts.length === 1) {
        hostPid = hosts[0]!.pid;
        evidence.hostChildOnFailure = {
          ...hosts[0],
          command: `${fixture.node} ${fixture.hostEntry}`,
          observedBeforeHarnessCleanup: true,
        };
      }
    }
    if (!packedRelaunchMode && appIdentity && hostPid !== undefined && remaining.length &&
        !remaining.some((row) => row.pid === group)) {
      const observed = await observeExitedAppGroup({ child: app, group, hostPid,
        initialMembers: remaining, deadline: observationDeadline });
      evidence.originalExitedGroup = observed;
      if (observed.settled) remaining = observed.remaining!;
    }
    if (remaining.length) {
      assert.ok(!packedRelaunchMode, 'observer-only app relaunch keeps UNKNOWN debt; no old-group signal or retry');
      // A numeric PGID alone never authorizes signaling after its leader exits.
      assert.ok(
        appIdentity && remaining.some((row) => row.pid === group),
        'captured leader absent; retain cleanup debt without signaling'
      );
      const observedIdentity = execFileSync('/bin/ps', ['-p', String(group), '-o', 'lstart=,command='], {
        encoding: 'utf8', timeout: 3000,
      }).trim();
      if (observedIdentity !== appIdentity && hostPid !== undefined) {
        const reaped = await observeOriginalAppReap({ child: app, group, hostPid,
          initialMembers: remaining, expectedIdentity: appIdentity, observedIdentity,
          deadline: observationDeadline });
        evidence.originalAppReap = reaped;
        if (reaped.settled) remaining = reaped.remaining!;
      }
      if (remaining.length) {
        let originalZombie = false;
        if (observedIdentity !== appIdentity) {
          // Keep the original fail-closed signal boundary even for macOS's
          // defunct rendering: a leader is eligible only if its start time,
          // parent, process group and actual Z state still match this child.
          const state = execFileSync(
            '/bin/ps', ['-p', String(group), '-o', 'stat='],
            { encoding: 'utf8', timeout: 3000 }
          ).trim();
          originalZombie = isCapturedOriginalNodeZombie({
            expectedIdentity: appIdentity,
            observedIdentity,
            state,
            childPid: app.pid,
            group,
            leader: groupMembers(group).find((entry) => entry.pid === group),
            parentPid: process.pid,
          });
          if (originalZombie) {
            evidence.originalZombieGuard = { group, state, status: 'verified-original-zombie' };
          }
        }
        assert.ok(
          observedIdentity === appIdentity || originalZombie,
          'captured invocation identity remains current'
        );
        let groupSignalPermissionError: unknown;
        try {
          process.kill(-group, 'SIGTERM');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM') {
            // On macOS a group of exiting/zombie descendants may reject killpg.
            // Never infer success from EPERM or send a second, broader signal.
            // Only a fresh complete group-absence census can clear this debt.
            groupSignalPermissionError = error;
            evidence.originalGroupSignal = 'EPERM: observing actual group absence';
          } else if (code !== 'ESRCH') {
            throw error;
          }
        }
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && (remaining = groupMembers(group)).length) await tick();
        if (groupSignalPermissionError) {
          if (remaining.length > 0) throw groupSignalPermissionError;
          evidence.originalGroupSignal = 'EPERM followed by verified full group absence';
        }
      }
    }
    capturedHostAbsent =
      hostPid === undefined ? null : !processTable().some((row) => row.pid === hostPid);
  } catch (error) {
    cleanupFailure =
      error instanceof Error ? error.message.slice(0, 4000) : 'unclassified cleanup failure';
  }
  return { remaining, cleanupFailure, capturedHostAbsent, hostPid };
}

/** Original guarded same-profile cold startup. The caller immediately retains every new ChildProcess. */
export async function restartCapturedDesktopApp(options: {
  app: ChildProcess; cdp: DesktopCdpPort; group: number; fixture: Fixture; repo: string; mode: string;
  evidence: Evidence; cdpLibrary: DesktopCdpLibrary;
  provider: 'claude' | 'codex' | 'opencode';
  model: { observations: readonly unknown[]; failures: readonly string[] };
  boundary: 'resume-after-stop' | 'extensions-before-launch';
  markQuitRequested(): void;
  adoptRenderer(cdp: DesktopCdpPort | undefined, hostPid?: number): void;
  spawnNext(): { app: ChildProcess; group: number; identity: string; invocation: readonly string[];
    spawnError(): boolean };
}): Promise<DesktopCdpPort> {
  const { app, cdp, group, fixture, repo, mode, evidence, provider, model, cdpLibrary } = options;
  const initial = options.boundary === 'extensions-before-launch';
  assert.equal(mode, initial ? 'native-launch-ui' : 'native-resume-ui');
  if (initial) {
    assert.equal(process.env.LEGACY_DESKTOP_EXTENSIONS_CONSUMPTION_UI, '1');
    assert.equal(provider, 'claude');
  }
  const hosts = groupMembers(group).filter(row => command(row.pid) === fixture.node + ' ' + fixture.hostEntry);
  assert.equal(hosts.length, 1, 'capture original Host before guarded cold startup Quit');
  const originalHost = hosts[0]!;
  options.adoptRenderer(cdp, originalHost.pid);
  const proof: Evidence = { status: 'INCOMPLETE', provider,
    scope: initial ? 'Guarded same-profile cold startup after extension/skill mutations, before any native Launch'
      : 'Guarded app Quit and captured same-profile cold startup before explicit Resume',
    firstEpoch: { app: evidence.app, startup: evidence.startup, startupOutcome: evidence.startupOutcome,
      rendererTarget: evidence.rendererTarget, compiledBundleHashesAfterStartup: evidence.compiledBundleHashesAfterStartup,
      discovery: evidence.discovery, homePathProof: evidence.homePathProof, host: originalHost } };
  evidence[initial ? 'coldExtensionBoundary' : 'coldResumeBoundary'] = proof;
  const readSessions = () => readDesktopNativeStopSessions(fixture.root).catch(
    (error: NodeJS.ErrnoException & { path?: string }) => {
      if (initial && error.code === 'ENOENT' && error.path === join(fixture.root, 'hoststore/runtime-sessions'))
        return [];
      throw error;
    });
  const before = await readSessions();
  const sources = before.filter(row => Array.isArray(row.inputs) && row.inputs.length === 1);
  const profile = object(JSON.parse(await readFile(fixture.profilePath, 'utf8')));
  const definition = object((profile.teams as unknown[])[0]);
  if (initial) assert.equal((definition.members as unknown[]).length, 1);
  else assert.equal(sources.length, 1);
  const member = object(initial ? (definition.members as unknown[])[0]
    : (definition.members as unknown[]).find(value =>
      object(value).memberId === object(sources[0]!.binding).memberId));
  const { teamName: _teamName, ...descriptorBinding } = object(member.delivery);
  const assertNeverOpened = (row: Evidence) => {
    assert.deepEqual(row.binding, descriptorBinding);
    assert.deepEqual(row.inputs, []); assert.deepEqual(row.interactions, []);
    assert.equal(row.config, null); assert.equal(row.openFingerprint, null); assert.equal(row.nativeReady, false);
  };
  if (initial) {
    assert.ok(before.length <= 1, 'only the never-opened original static descriptor may exist');
    for (const row of before) assertNeverOpened(row);
    // Completed management mutations may be followed by finite metadata reads.
    // No Runtime session/input is opened; original Quit below must close the entire captured group.
    assert.equal(sources.length, 0);
  } else {
    assert.ok(before.length > 0 && before.every(row => row.phase === 'closed' && row.custody === 'released'));
    assert.equal(sources.length, 1);
    assert.equal(object(sources[0]!.binding).memberId, member.memberId);
  }
  const originalCheckpoint = initial ? undefined : await checkpoint(fixture.root, sources[0]!, provider);
  if (originalCheckpoint) proof.beforeQuitCheckpoint = { reference: originalCheckpoint.payload.reference,
    payloadFileSha256: originalCheckpoint.payloadFileSha256, historySha256: originalCheckpoint.historySha256 };
  const managementRecords = async () => {
    const directory = join(fixture.root, 'hoststore/management-commands');
    const names = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).sort();
    assert.ok(names.length <= 16);
    return Promise.all(names.map(async name => ({ name, sha256: await fileDigest(join(directory, name)) })));
  };
  const originalMutations = initial ? await managementRecords() : undefined;
  if (originalMutations) assert.equal(originalMutations.length, 4, 'one plugin install and three skill mutations');
  const bundleDirectory = join(fixture.root, initial ? 'cold-extension-epoch1-bundles' : 'cold-resume-epoch1-bundles');
  const bundlePins = evidence.compiledBundleHashesAfterStartup;
  assert.ok(Array.isArray(bundlePins) && bundlePins.length > 0 && bundlePins.length <= 4096);
  for (const raw of bundlePins) {
    const pin = object(raw), relative = String(pin.path), sha = String(pin.sha256);
    assert.ok(!relative.startsWith('/') && !relative.split('/').includes('..'));
    assert.match(relative, /\.(?:cjs|js)$/); assert.match(sha, /^[a-f0-9]{64}$/);
    const source = join(repo, 'dist-electron', relative), target = join(bundleDirectory, relative);
    assert.equal(await fileDigest(source), sha);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target, constants.COPYFILE_EXCL);
    assert.equal(await fileDigest(target), sha); assert.equal(await fileDigest(source), sha);
  }
  proof.epoch1BundleSnapshot = { directory: bundleDirectory, files: bundlePins };
  assert.equal(model.observations.length, initial ? 0 : 8);
  assertOwnedCdpListener(group);
  options.markQuitRequested(); // One original public Quit, fenced before its uncertain reply.
  const quitObservation: Evidence = { attempted: true }; proof.firstQuit = quitObservation;
  try {
    await bounded(cdp.evaluate('window.electronAPI.windowControls.close()'), 3000, 'original same-profile Quit');
    quitObservation.reply = 'acknowledged';
  } catch (error) {
    quitObservation.reply = 'unconfirmed';
    quitObservation.reason = /timed out/i.test(String(error)) ? 'timeout' : 'closed-or-rejected';
  }
  const until = Date.now() + 30_000;
  while (Date.now() < until && (app.exitCode === null || groupMembers(group).length)) await tick();
  const remaining = groupMembers(group), hostAbsent = !processTable().some(row => row.pid === originalHost.pid);
  const writerReleased = await lstat(join(fixture.root, 'hoststore/.legacy-agent-host-writer.lock'))
    .then(() => false, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return true; throw error; });
  proof.firstCleanup = { appExitCode: app.exitCode, appSignalCode: app.signalCode,
    remaining, capturedHostAbsent: hostAbsent, writerLockReleased: writerReleased };
  assert.equal(app.exitCode, 0, 'captured app exits normally before second spawn');
  assert.equal(app.signalCode, null);
  assert.deepEqual(remaining, [], 'no group cleanup fallback before cold startup');
  assert.equal(hostAbsent, true); assert.equal(writerReleased, true);
  if (!initial) assertFirstResumeMetadataAbsent(evidence);
  const postQuit = await readSessions();
  if (!initial) for (const original of before) {
    const matches = postQuit.filter(row => isDeepStrictEqual(row.binding, original.binding));
    assert.equal(matches.length, 1); assert.deepEqual(matches[0], original);
  }
  const added = initial ? postQuit : postQuit.filter(row =>
    !before.some(original => isDeepStrictEqual(row.binding, original.binding)));
  assert.ok(added.length <= 1, 'only one exact static descriptor tombstone may be added');
  for (const row of added) {
    assertNeverOpened(row);
    assert.equal(row.phase, 'closed'); assert.equal(row.custody, 'released'); assert.equal(row.sealed, true);
  }
  assert.equal(model.observations.length, initial ? 0 : 8, 'Quit cannot release a native input');
  await bounded(cdp.close(), 3000, 'disconnect original renderer');
  options.adoptRenderer(undefined);
  assert.equal(await portOccupied(), false);
  for (const [path, sha] of [[fixture.node, fixture.pins.nodeSha256], [fixture.hostEntry, fixture.pins.hostEntrySha256],
    [fixture.profilePath, fixture.pins.profileSha256], [fixture.descriptorPath, fixture.pins.descriptorSha256]])
    assert.equal(await fileDigest(path!), sha, 'same captured fixture pin before cold startup');
  const second: Evidence = { status: 'INCOMPLETE' }; proof.secondEpoch = second;
  const next = options.spawnNext(); // Caller adopts before any fallible startup observation.
  assert.ok(next.group > 0 && next.group !== group);
  second.app = { pid: next.app.pid, processGroup: next.group, identity: next.identity, invocation: next.invocation };
  const connected = await connectCapturedDesktopApp({
    app: next.app, group: next.group, spawnError: next.spawnError, packed: undefined, cdpLibrary, evidence: second });
  options.adoptRenderer(connected.cdp);
  await attachRendererDiagnostics(connected.cdp, String(connected.target.url), second, {
    remainingMs: connected.startupBudgetMs - (performance.now() - connected.startupStarted),
    assertOwnedRenderer: () => assertOwnedCdpListener(next.group) });
  await verifyCapturedDesktopBinding({ cdp: connected.cdp, group: next.group, mode, fixture, evidence: second, repo, packed: undefined });
  const currentHosts = groupMembers(next.group).filter(row => command(row.pid) === fixture.node + ' ' + fixture.hostEntry);
  assert.equal(currentHosts.length, 1, 'one new standalone Host after cold discovery');
  assert.notEqual(currentHosts[0]!.pid, originalHost.pid);
  options.adoptRenderer(connected.cdp, currentHosts[0]!.pid); second.host = currentHosts[0];
  assert.deepEqual(await readSessions(), postQuit);
  if (originalCheckpoint) {
    const cold = await checkpoint(fixture.root, sources[0]!, provider);
    assert.equal(cold.payloadFileSha256, originalCheckpoint.payloadFileSha256);
    assert.equal(cold.historySha256, originalCheckpoint.historySha256);
    second.checkpointAndHistoryUnchanged = true;
  }
  if (originalMutations) {
    assert.deepEqual(await managementRecords(), originalMutations);
    second.originalMutationRecordsUnchanged = originalMutations;
  }
  assert.equal(model.observations.length, initial ? 0 : 8, 'cold startup cannot release a prompt');
  assert.deepEqual(model.failures, []);
  second.status = 'PASS'; proof.status = 'PASS';
  return connected.cdp;
}
