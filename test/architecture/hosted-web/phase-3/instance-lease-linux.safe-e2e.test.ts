import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { Duplex } from 'node:stream';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const buildScript = resolve(repositoryRoot, 'scripts/hosted-web/build-instance-lock.mjs');
const adapterUrl = pathToFileURL(
  resolve(
    repositoryRoot,
    'src/features/instance-lease/main/adapters/output/NodeInheritedInstanceLease.ts'
  )
).href;
const guardUrl = pathToFileURL(
  resolve(repositoryRoot, 'src/features/instance-lease/core/domain/InstanceLeaseGuard.ts')
).href;
const canRunLinuxLeaseTests = process.platform === 'linux' && process.getuid?.() === 0;
const describeLinux = canRunLinuxLeaseTests ? describe : describe.skip;

interface LauncherExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface LauncherProcess {
  child: ChildProcess;
  exit: Promise<LauncherExit>;
  stderr: () => string;
  reapGate?: Duplex;
  forwardAudit: () => string;
  forwardAuditEnded: () => boolean;
}

interface StartLauncherOptions {
  inheritedBlockedSignals?: boolean;
  reapBoundaryHooks?: boolean;
}

interface AnchorFixture {
  parent: string;
  anchor: string;
  device: string;
  inode: string;
}

let sandboxRoot = '';
let launcherPath = '';
let testHookLauncherPath = '';
let controllerFixturePath = '';
let signalMaskWrapperPath = '';
const runningLaunchers = new Set<ChildProcess>();
const knownControllerPids = new Set<number>();

const controllerFixture = `
import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, writeFileSync } from 'node:fs';
import { InstanceLeaseGuard } from ${JSON.stringify(guardUrl)};
import {
  createInstanceLeaseChildStdioPolicy,
  openNodeInheritedInstanceLease,
} from ${JSON.stringify(adapterUrl)};

const [markerPath, mode, descendantMarker] = process.argv.slice(2);
const handle = openNodeInheritedInstanceLease();
const guard = InstanceLeaseGuard.takeOwnership(handle);

if (mode === 'inspect-release') {
  const before = guard.inspectForAdmission().status;
  guard.release();
  const after = guard.inspectForAdmission().status;
  writeFileSync(markerPath, JSON.stringify({ before, after }));
  process.exit(0);
}
if (mode === 'inspect-invalid') {
  closeSync(3);
  writeFileSync(markerPath, JSON.stringify({ status: guard.inspectForAdmission().status }));
  process.exit(0);
}
if (mode === 'close-node-half') {
  closeSync(3);
}
if (mode === 'descendant') {
  const childPolicy = createInstanceLeaseChildStdioPolicy(['ignore', 'ignore', 'inherit']);
  let probe;
  try {
    probe = spawnSync(
      process.execPath,
      [
        '-e',
        \`const { fstatSync, writeFileSync } = require('node:fs');
         let inherited = false;
         try {
           const stat = fstatSync(3, { bigint: true });
           inherited = stat.dev.toString() === process.argv[2] &&
             stat.ino.toString() === process.argv[3];
         } catch {}
         writeFileSync(process.argv[1], inherited ? 'inherited' : 'absent');\`,
        descendantMarker,
        guard.evidence.anchor.device,
        guard.evidence.anchor.inode,
      ],
      { stdio: childPolicy.stdio }
    );
  } finally {
    childPolicy.close();
  }
  if (probe.status !== 0) process.exit(90);
}
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  try { guard.release(); } catch {}
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
writeFileSync(markerPath, JSON.stringify({ pid: process.pid, launcherPid: process.ppid }));
if (mode === 'exit') {
  guard.release();
  process.exit(0);
}
setInterval(() => {
  if (mode !== 'close-node-half' && mode !== 'node-retains') guard.assertHeld();
}, 50).unref();
setInterval(() => {}, 1_000);
`;

const signalMaskWrapper = `
#define _POSIX_C_SOURCE 200809L

#include <signal.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2) return 64;
  sigset_t blocked;
  if (sigemptyset(&blocked) == -1 || sigaddset(&blocked, SIGTERM) == -1 ||
      sigaddset(&blocked, SIGINT) == -1 ||
      sigprocmask(SIG_BLOCK, &blocked, NULL) == -1) {
    return 65;
  }
  struct sigaction ignored;
  ignored.sa_handler = SIG_IGN;
  if (sigemptyset(&ignored.sa_mask) == -1) return 66;
  ignored.sa_flags = 0;
  if (sigaction(SIGCHLD, &ignored, NULL) == -1) return 67;
  execv(argv[1], &argv[1]);
  return 68;
}
`;

function createAnchor(name: string): AnchorFixture {
  const parent = mkdtempSync(join(sandboxRoot, `${name}-`));
  const anchor = join(parent, 'instance.lock');
  writeFileSync(anchor, 'provisioned\n', { mode: 0o644 });
  chmodSync(anchor, 0o644);
  const stat = statSync(anchor, { bigint: true });
  return { parent, anchor, device: stat.dev.toString(), inode: stat.ino.toString() };
}

function startLauncher(
  fixture: AnchorFixture,
  markerPath: string,
  mode = 'hold',
  descendantMarker?: string,
  options: StartLauncherOptions = {}
): LauncherProcess {
  const launcherArgs = [
    fixture.parent,
    'instance.lock',
    fixture.device,
    fixture.inode,
    '--',
    process.execPath,
    '--import',
    'tsx',
    controllerFixturePath,
    markerPath,
    mode,
    ...(descendantMarker ? [descendantMarker] : []),
  ];
  const selectedLauncherPath = options.reapBoundaryHooks ? testHookLauncherPath : launcherPath;
  const executable = options.inheritedBlockedSignals ? signalMaskWrapperPath : selectedLauncherPath;
  const executableArgs = options.inheritedBlockedSignals
    ? [selectedLauncherPath, ...launcherArgs]
    : launcherArgs;
  const stdio: SpawnOptions['stdio'] = options.reapBoundaryHooks
    ? ['ignore', 'ignore', 'pipe', 'ignore', 'ignore', 'pipe', 'pipe']
    : ['ignore', 'ignore', 'pipe'];
  const child = spawn(executable, executableArgs, {
    cwd: repositoryRoot,
    env: options.reapBoundaryHooks
      ? {
          ...process.env,
          AGENT_TEAMS_TEST_REAP_GATE_FD: '5',
          AGENT_TEAMS_TEST_FORWARD_AUDIT_FD: '6',
        }
      : process.env,
    stdio,
  });
  runningLaunchers.add(child);
  let stderrText = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrText += chunk;
  });
  const childStdio = child.stdio as unknown as (Duplex | null)[];
  const reapGate = options.reapBoundaryHooks ? (childStdio[5] ?? undefined) : undefined;
  const forwardAuditStream = options.reapBoundaryHooks ? (childStdio[6] ?? undefined) : undefined;
  let forwardAuditText = '';
  forwardAuditStream?.setEncoding('utf8');
  forwardAuditStream?.on('data', (chunk: string) => {
    forwardAuditText += chunk;
  });
  const exit = new Promise<LauncherExit>((resolveExit) => {
    child.once('exit', (code, signal) => {
      runningLaunchers.delete(child);
      resolveExit({ code, signal });
    });
  });
  return {
    child,
    exit,
    stderr: () => stderrText,
    reapGate,
    forwardAudit: () => forwardAuditText,
    forwardAuditEnded: () => forwardAuditStream?.readableEnded ?? true,
  };
}

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`timed out: ${message}`);
}

function readControllerPid(markerPath: string): number {
  const marker = JSON.parse(String(requireFile(markerPath))) as { pid: number };
  knownControllerPids.add(marker.pid);
  return marker.pid;
}

function requireFile(path: string): Buffer {
  return readFileSync(path);
}

function requireFileText(path: string): string {
  return readFileSync(path, 'utf8');
}

async function terminateLauncher(
  launcher: LauncherProcess,
  signal: NodeJS.Signals = 'SIGTERM'
): Promise<LauncherExit> {
  if (launcher.child.exitCode !== null || launcher.child.signalCode !== null) {
    return launcher.exit;
  }
  launcher.child.kill('SIGCONT');
  launcher.child.kill(signal);
  const timeout = new Promise<LauncherExit>((resolveTimeout) => {
    setTimeout(() => resolveTimeout({ code: null, signal: 'SIGKILL' }), 4_000);
  });
  const first = await Promise.race([launcher.exit, timeout]);
  if (first.signal === 'SIGKILL' && launcher.child.exitCode === null) {
    launcher.child.kill('SIGKILL');
    return launcher.exit;
  }
  return first;
}

function isSignalBlocked(pid: number, signalNumber: number): boolean {
  const status = readFileSync(`/proc/${String(pid)}/status`, 'utf8');
  const match = /^SigBlk:\s+([0-9a-f]+)$/imu.exec(status);
  if (!match) throw new Error(`missing SigBlk for pid ${String(pid)}`);
  const blockedMask = BigInt(`0x${match[1]}`);
  return (blockedMask & (1n << BigInt(signalNumber - 1))) !== 0n;
}

async function waitForReapBoundary(launcher: LauncherProcess): Promise<void> {
  const gate = launcher.reapGate;
  if (!gate) throw new Error('reap boundary gate was not configured');
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error('timed out: unreaped child boundary'));
    }, 8_000);
    gate.once('data', (chunk: Buffer) => {
      clearTimeout(timeout);
      if (!chunk.includes('R'.charCodeAt(0))) {
        rejectReady(new Error(`unexpected reap boundary byte: ${String(chunk)}`));
        return;
      }
      resolveReady();
    });
  });
}

describeLinux('ADR-16 Linux instance lease sandbox', () => {
  beforeAll(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), 'agent-teams-instance-lease-'));
    launcherPath = join(sandboxRoot, 'agent-teams-instance-lock');
    testHookLauncherPath = join(sandboxRoot, 'agent-teams-instance-lock-test-hooks');
    controllerFixturePath = join(sandboxRoot, 'controller-fixture.mjs');
    signalMaskWrapperPath = join(sandboxRoot, 'signal-mask-wrapper');
    const signalMaskWrapperSourcePath = join(sandboxRoot, 'signal-mask-wrapper.c');
    writeFileSync(controllerFixturePath, controllerFixture, { mode: 0o600 });
    writeFileSync(signalMaskWrapperSourcePath, signalMaskWrapper, { mode: 0o600 });
    const build = spawnSync(process.execPath, [buildScript, '--output', launcherPath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    const testHookBuild = spawnSync(
      process.execPath,
      [buildScript, '--test-hooks', '--output', testHookLauncherPath],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
      }
    );
    expect(testHookBuild.status, `${testHookBuild.stdout}\n${testHookBuild.stderr}`).toBe(0);
    const wrapperBuild = spawnSync(
      process.env.CC ?? 'cc',
      [
        '-std=c17',
        '-pedantic-errors',
        '-Wall',
        '-Wextra',
        '-Wconversion',
        '-Werror',
        '-o',
        signalMaskWrapperPath,
        signalMaskWrapperSourcePath,
      ],
      { encoding: 'utf8' }
    );
    expect(wrapperBuild.status, `${wrapperBuild.stdout}\n${wrapperBuild.stderr}`).toBe(0);
  }, 20_000);

  afterEach(async () => {
    for (const child of runningLaunchers) {
      child.kill('SIGCONT');
      child.kill('SIGKILL');
    }
    for (const pid of knownControllerPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already reaped.
      }
    }
    runningLaunchers.clear();
    knownControllerPids.clear();
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  });

  afterAll(() => {
    if (sandboxRoot) rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it('admits one concurrent launcher and the loser exits before a Node marker', async () => {
    const fixture = createAnchor('concurrent');
    const markerA = join(fixture.parent, 'controller-a.marker');
    const markerB = join(fixture.parent, 'controller-b.marker');
    const launcherA = startLauncher(fixture, markerA);
    const launcherB = startLauncher(fixture, markerB);

    await waitUntil(
      () => Number(existsSync(markerA)) + Number(existsSync(markerB)) === 1,
      'one controller marker'
    );
    const winner = existsSync(markerA) ? launcherA : launcherB;
    const loser = existsSync(markerA) ? launcherB : launcherA;
    const loserMarker = existsSync(markerA) ? markerB : markerA;

    expect(await loser.exit).toEqual({ code: 73, signal: null });
    expect(existsSync(loserMarker)).toBe(false);
    expect(loser.stderr()).toContain('instance_lock:lease_busy');
    readControllerPid(existsSync(markerA) ? markerA : markerB);
    expect((await terminateLauncher(winner)).code).toBe(0);
  });

  it('does not infer takeover from a stopped winner or deleted diagnostics', async () => {
    const fixture = createAnchor('stopped');
    const winnerMarker = join(fixture.parent, 'winner.marker');
    const loserMarker = join(fixture.parent, 'loser.marker');
    const winner = startLauncher(fixture, winnerMarker);
    await waitUntil(() => existsSync(winnerMarker), 'winner marker');
    readControllerPid(winnerMarker);

    process.kill(winner.child.pid!, 'SIGSTOP');
    unlinkSync(winnerMarker);
    const loser = startLauncher(fixture, loserMarker);

    expect(await loser.exit).toEqual({ code: 73, signal: null });
    expect(existsSync(loserMarker)).toBe(false);
    expect((await terminateLauncher(winner)).code).toBe(0);
  });

  it('rejects a replacement anchor before the Node child can have effects', async () => {
    const fixture = createAnchor('replacement');
    const marker = join(fixture.parent, 'unexpected.marker');
    renameSync(fixture.anchor, join(fixture.parent, 'retired.lock'));
    writeFileSync(fixture.anchor, 'replacement\n', { mode: 0o644 });
    chmodSync(fixture.anchor, 0o644);

    const rejected = startLauncher(fixture, marker, 'exit');

    expect(await rejected.exit).toEqual({ code: 74, signal: null });
    expect(existsSync(marker)).toBe(false);
    expect(rejected.stderr()).toContain('instance_lock:anchor_rejected');
  });

  it('rejects writable or symlinked deployment shapes without starting Node', async () => {
    const fixture = createAnchor('unsafe-shapes');
    const writableMarker = join(fixture.parent, 'writable-parent.marker');
    chmodSync(fixture.parent, 0o777);

    const writableParent = startLauncher(fixture, writableMarker);
    expect(await writableParent.exit).toEqual({ code: 74, signal: null });
    expect(existsSync(writableMarker)).toBe(false);

    chmodSync(fixture.parent, 0o700);
    const realParent = fixture.parent;
    const parentLink = join(sandboxRoot, 'deployment-parent-link');
    symlinkSync(realParent, parentLink);
    const symlinkParentMarker = join(realParent, 'symlink-parent.marker');
    const symlinkParent = startLauncher({ ...fixture, parent: parentLink }, symlinkParentMarker);
    expect(await symlinkParent.exit).toEqual({ code: 74, signal: null });
    expect(existsSync(symlinkParentMarker)).toBe(false);

    renameSync(fixture.anchor, join(realParent, 'real-instance.lock'));
    symlinkSync('real-instance.lock', fixture.anchor);
    const symlinkAnchorMarker = join(realParent, 'symlink-anchor.marker');
    const symlinkAnchor = startLauncher(fixture, symlinkAnchorMarker);
    expect(await symlinkAnchor.exit).toEqual({ code: 74, signal: null });
    expect(existsSync(symlinkAnchorMarker)).toBe(false);
  });

  it('keeps ownership when either the Node or launcher half disappears', async () => {
    const fixture = createAnchor('halves');
    const nodeCloseMarker = join(fixture.parent, 'node-close.marker');
    const firstLoserMarker = join(fixture.parent, 'first-loser.marker');
    const nodeCloseWinner = startLauncher(fixture, nodeCloseMarker, 'close-node-half');
    await waitUntil(() => existsSync(nodeCloseMarker), 'Node-half close marker');
    readControllerPid(nodeCloseMarker);

    const firstLoser = startLauncher(fixture, firstLoserMarker);
    expect(await firstLoser.exit).toEqual({ code: 73, signal: null });
    expect(existsSync(firstLoserMarker)).toBe(false);
    await terminateLauncher(nodeCloseWinner);

    const launcherKillMarker = join(fixture.parent, 'launcher-kill.marker');
    const secondLoserMarker = join(fixture.parent, 'second-loser.marker');
    const launcherKillWinner = startLauncher(fixture, launcherKillMarker, 'node-retains');
    await waitUntil(() => existsSync(launcherKillMarker), 'launcher-half close marker');
    const orphanControllerPid = readControllerPid(launcherKillMarker);
    launcherKillWinner.child.kill('SIGKILL');
    expect((await launcherKillWinner.exit).signal).toBe('SIGKILL');

    const secondLoser = startLauncher(fixture, secondLoserMarker);
    expect(await secondLoser.exit).toEqual({ code: 73, signal: null });
    expect(existsSync(secondLoserMarker)).toBe(false);

    process.kill(orphanControllerPid, 'SIGTERM');
    await waitUntil(() => {
      try {
        const stat = readFileSync(`/proc/${String(orphanControllerPid)}/stat`, 'utf8');
        return stat.split(' ')[2] === 'Z';
      } catch {
        return true;
      }
    }, 'orphan controller exit');
  });

  it('reports held, released, and invalid admission evidence from real inherited descriptors', async () => {
    const releasedFixture = createAnchor('admission-release');
    const releasedMarker = join(releasedFixture.parent, 'released.marker');
    const released = startLauncher(releasedFixture, releasedMarker, 'inspect-release');

    expect(await released.exit).toEqual({ code: 0, signal: null });
    expect(JSON.parse(requireFileText(releasedMarker))).toEqual({
      before: 'held',
      after: 'released',
    });

    const invalidFixture = createAnchor('admission-invalid');
    const invalidMarker = join(invalidFixture.parent, 'invalid.marker');
    const invalid = startLauncher(invalidFixture, invalidMarker, 'inspect-invalid');

    expect(await invalid.exit).toEqual({ code: 0, signal: null });
    expect(JSON.parse(requireFileText(invalidMarker))).toEqual({ status: 'invalid' });
  });

  it('does not leak the lease to descendants and full exit admits exactly one successor', async () => {
    const fixture = createAnchor('handoff');
    const initialMarker = join(fixture.parent, 'initial.marker');
    const descendantMarker = join(fixture.parent, 'descendant.marker');
    const initial = startLauncher(fixture, initialMarker, 'descendant', descendantMarker);
    await waitUntil(
      () => existsSync(initialMarker) && existsSync(descendantMarker),
      'initial and descendant markers'
    );
    readControllerPid(initialMarker);
    expect(requireFileText(descendantMarker)).toBe('absent');
    expect((await terminateLauncher(initial)).code).toBe(0);

    const successorMarkerA = join(fixture.parent, 'successor-a.marker');
    const successorMarkerB = join(fixture.parent, 'successor-b.marker');
    const successorA = startLauncher(fixture, successorMarkerA);
    const successorB = startLauncher(fixture, successorMarkerB);
    await waitUntil(
      () => Number(existsSync(successorMarkerA)) + Number(existsSync(successorMarkerB)) === 1,
      'exactly one successor marker'
    );
    const winner = existsSync(successorMarkerA) ? successorA : successorB;
    const loser = existsSync(successorMarkerA) ? successorB : successorA;
    const loserMarker = existsSync(successorMarkerA) ? successorMarkerB : successorMarkerA;

    expect(await loser.exit).toEqual({ code: 73, signal: null });
    expect(existsSync(loserMarker)).toBe(false);
    readControllerPid(existsSync(successorMarkerA) ? successorMarkerA : successorMarkerB);
    expect((await terminateLauncher(winner)).code).toBe(0);
  });

  it('unblocks inherited SIGTERM and SIGINT masks in both launcher and controller', async () => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const fixture = createAnchor(`inherited-mask-${signal.toLowerCase()}`);
      const marker = join(fixture.parent, 'controller.marker');
      const launcher = startLauncher(fixture, marker, 'hold', undefined, {
        inheritedBlockedSignals: true,
      });
      await waitUntil(() => existsSync(marker), `${signal} controller marker`);
      const controllerPid = readControllerPid(marker);
      const launcherPid = launcher.child.pid!;

      expect(isSignalBlocked(launcherPid, osConstants.signals.SIGTERM)).toBe(false);
      expect(isSignalBlocked(launcherPid, osConstants.signals.SIGINT)).toBe(false);
      expect(isSignalBlocked(controllerPid, osConstants.signals.SIGTERM)).toBe(false);
      expect(isSignalBlocked(controllerPid, osConstants.signals.SIGINT)).toBe(false);
      expect(await terminateLauncher(launcher, signal)).toEqual({ code: 0, signal: null });
    }
  });

  it('does not forward a pending signal after crossing the unreaped child boundary', async () => {
    const fixture = createAnchor('reap-boundary');
    const marker = join(fixture.parent, 'controller.marker');
    const launcher = startLauncher(fixture, marker, 'exit', undefined, {
      reapBoundaryHooks: true,
    });
    await waitUntil(() => existsSync(marker), 'reap-boundary controller marker');
    const controllerPid = readControllerPid(marker);
    await waitForReapBoundary(launcher);

    const childStat = readFileSync(`/proc/${String(controllerPid)}/stat`, 'utf8');
    expect(childStat.split(' ')[2]).toBe('Z');
    expect(launcher.child.kill('SIGTERM')).toBe(true);
    launcher.reapGate!.write('G');

    expect(await launcher.exit).toEqual({ code: 0, signal: null });
    await waitUntil(() => launcher.forwardAuditEnded(), 'forward-audit pipe close');
    expect(launcher.forwardAudit()).toBe('');
    expect(existsSync(`/proc/${String(controllerPid)}`)).toBe(false);
    knownControllerPids.delete(controllerPid);
  });
});
