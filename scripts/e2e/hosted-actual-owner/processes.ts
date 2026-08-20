import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { closeSync, createReadStream, openSync } from 'node:fs';
import { readFile, readlink, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';

import { drainHostedV1ProcessGroup } from '../hosted-v1/foregroundSubprocess';
import type { ActualOwnerProcessName } from './contracts';
import type { ActualOwnerProcessEvidence } from './evidence';
import type { ActualOwnerExecutableEvidence } from './preflight';
import {
  assertActualOwnerAnchorPathIdentity,
  type ActualOwnerLaunchAnchor,
  type ActualOwnerSourceAnchor,
} from './anchors';

export interface ActualOwnerManagedProcess {
  readonly anchors: readonly ProcessAnchor[];
  readonly child: ChildProcess;
  readonly evidence: ActualOwnerProcessEvidence;
  readonly stop: () => Promise<void>;
}

type ProcessAnchor = ActualOwnerLaunchAnchor | ActualOwnerSourceAnchor;

export function actualOwnerInheritedStdio(
  stdoutFd: number,
  stderrFd: number,
  launcherLeaseFd: number
): StdioOptions {
  return [
    'ignore',
    stdoutFd,
    stderrFd,
    'ignore',
    'ignore',
    'ignore',
    launcherLeaseFd,
    'pipe',
    'pipe',
  ];
}

export function actualOwnerBootstrapFrame(input: {
  readonly contractSha256: string;
  readonly ownerSessionId: string;
  readonly ownerToken: string;
  readonly runId: string;
}): Buffer {
  const unsigned = Object.freeze({
    schemaVersion: 1,
    purpose: 'agent-teams.hosted-actual-owner-e2e.bootstrap/v1',
    nonce: randomBytes(32).toString('hex'),
    contractSha256: input.contractSha256,
    ownerSessionId: input.ownerSessionId,
    runId: input.runId,
  });
  const authentication = createHmac('sha256', input.ownerToken)
    .update(JSON.stringify(unsigned))
    .digest('hex');
  return Buffer.from(`${JSON.stringify({ ...unsigned, authentication })}\n`);
}

export class ActualOwnerProcessCleanupUnprovedError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'ActualOwnerProcessCleanupUnprovedError';
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', rejectStream);
    stream.once('end', resolveStream);
  });
  return hash.digest('hex');
}

function processStartIdentity(stat: string): string {
  const close = stat.lastIndexOf(')');
  if (close < 1) throw new Error('hosted_actual_owner_process_stat_invalid');
  const fields = stat.slice(close + 2).split(' ');
  const startTime = fields[19];
  if (!startTime || !/^\d+$/u.test(startTime)) {
    throw new Error('hosted_actual_owner_process_stat_invalid');
  }
  return startTime;
}

async function readProcessStartIdentity(pid: number): Promise<string> {
  return processStartIdentity(await readFile(`/proc/${pid}/stat`, 'utf8'));
}

async function collectProcessEvidence(input: {
  readonly args: readonly string[];
  readonly name: ActualOwnerProcessName;
  readonly pid: number;
  readonly sourceRef: string;
  readonly expectedExecutable?: ActualOwnerExecutableEvidence;
}): Promise<ActualOwnerProcessEvidence> {
  const procExecutable = await readlink(`/proc/${input.pid}/exe`);
  if (procExecutable.endsWith(' (deleted)')) {
    throw new Error('hosted_actual_owner_process_executable_rotated');
  }
  const executable = procExecutable;
  const canonical = await realpath(executable);
  if (canonical !== executable)
    throw new Error('hosted_actual_owner_process_executable_not_canonical');
  const procExecutablePath = `/proc/${input.pid}/exe`;
  const [procStat, executableSha256, startIdentity, status] = await Promise.all([
    stat(procExecutablePath, { bigint: true }),
    sha256File(procExecutablePath),
    readProcessStartIdentity(input.pid),
    readFile(`/proc/${input.pid}/status`, 'utf8'),
  ]);
  const uidMatch = /^Uid:\s+(\d+)/mu.exec(status);
  if (!procStat.isFile() || !uidMatch) {
    throw new Error('hosted_actual_owner_process_identity_invalid');
  }
  const evidence = Object.freeze({
    args: Object.freeze([...input.args]),
    executable,
    executableDevice: procStat.dev.toString(),
    executableInode: procStat.ino.toString(),
    executableSha256,
    name: input.name,
    pid: input.pid,
    processStartIdentity: startIdentity,
    sourceRef: input.sourceRef,
    uid: Number(uidMatch[1]),
  });
  if (
    input.expectedExecutable &&
    (evidence.executable !== input.expectedExecutable.executable ||
      evidence.executableDevice !== input.expectedExecutable.device ||
      evidence.executableInode !== input.expectedExecutable.inode ||
      evidence.executableSha256 !== input.expectedExecutable.sha256)
  ) {
    throw new Error(`hosted_actual_owner_${input.name}_preflight_executable_rotated`);
  }
  return evidence;
}

function groupOperations(pid: number) {
  const send = (signal: 0 | 'SIGKILL' | 'SIGTERM'): boolean => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { readonly code?: unknown }).code === 'ESRCH'
      ) {
        return false;
      }
      throw error;
    }
  };
  return Object.freeze({
    exists: () => send(0),
    send: (signal: 'SIGKILL' | 'SIGTERM') => send(signal),
  });
}

export async function launchActualOwnerProcess(input: {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly logRoot: string;
  readonly name: ActualOwnerProcessName;
  readonly shutdownMs: number;
  readonly sourceRef: string;
  readonly expectedExecutable?: ActualOwnerExecutableEvidence;
  readonly anchors?: readonly ProcessAnchor[];
  readonly inheritedFds?: Readonly<{
    readonly launcherLeaseFd: number;
    readonly bootstrapFrame: Buffer;
  }>;
}): Promise<ActualOwnerManagedProcess> {
  if (process.platform !== 'linux')
    throw new Error('hosted_actual_owner_linux_process_identity_required');
  const stdoutFd = openSync(join(input.logRoot, `${input.name}.stdout.log`), 'wx', 0o600);
  const stderrFd = openSync(join(input.logRoot, `${input.name}.stderr.log`), 'wx', 0o600);
  let child: ChildProcess | null = null;
  try {
    await Promise.all((input.anchors ?? []).map(assertActualOwnerAnchorPathIdentity));
    const stdio: StdioOptions = input.inheritedFds
      ? actualOwnerInheritedStdio(stdoutFd, stderrFd, input.inheritedFds.launcherLeaseFd)
      : ['ignore', stdoutFd, stderrFd];
    child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      detached: true,
      env: input.environment,
      stdio,
    });
    if (input.inheritedFds) {
      const inheritedSockets = child.stdio as unknown as readonly (Duplex | null)[];
      const liveness = inheritedSockets[7];
      const bootstrap = inheritedSockets[8];
      if (!liveness || !bootstrap || typeof bootstrap.end !== 'function') {
        throw new Error('hosted_actual_owner_inherited_socket_setup_failed');
      }
      await new Promise<void>((resolveWrite, rejectWrite) => {
        bootstrap.once('error', rejectWrite);
        bootstrap.end(input.inheritedFds?.bootstrapFrame, resolveWrite);
      });
    }
  } catch (error) {
    if (child?.pid && Number.isSafeInteger(child.pid)) {
      try {
        await drainHostedV1ProcessGroup({
          operations: groupOperations(child.pid),
          termGraceMs: input.shutdownMs,
          killGraceMs: input.shutdownMs,
        });
      } catch (cleanupError) {
        await Promise.allSettled((input.anchors ?? []).map(({ handle }) => handle.close()));
        throw new ActualOwnerProcessCleanupUnprovedError(
          `hosted_actual_owner_${input.name}_bootstrap_cleanup_unproved`,
          new AggregateError([error, cleanupError])
        );
      }
    }
    await Promise.allSettled((input.anchors ?? []).map(({ handle }) => handle.close()));
    throw error;
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  if (!child) throw new Error(`hosted_actual_owner_${input.name}_spawn_missing`);
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || (pid ?? 0) < 1) {
    throw new Error(`hosted_actual_owner_${input.name}_pid_invalid`);
  }
  const earlyExit = new Promise<never>((_, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      reject(
        new Error(`hosted_actual_owner_${input.name}_early_exit_${code ?? signal ?? 'unknown'}`)
      )
    );
  });
  let evidence: ActualOwnerProcessEvidence;
  try {
    evidence = await Promise.race([
      collectProcessEvidence({
        args: input.args,
        name: input.name,
        pid: pid as number,
        sourceRef: input.sourceRef,
        expectedExecutable: input.expectedExecutable,
      }),
      earlyExit,
    ]);
  } catch (error) {
    try {
      await drainHostedV1ProcessGroup({
        operations: groupOperations(pid as number),
        termGraceMs: input.shutdownMs,
        killGraceMs: input.shutdownMs,
      });
    } catch (cleanupError) {
      await Promise.allSettled((input.anchors ?? []).map(({ handle }) => handle.close()));
      throw new ActualOwnerProcessCleanupUnprovedError(
        `hosted_actual_owner_${input.name}_launch_cleanup_unproved`,
        new AggregateError([error, cleanupError])
      );
    }
    await Promise.allSettled((input.anchors ?? []).map(({ handle }) => handle.close()));
    throw error;
  }
  let stopped = false;
  const closeAnchors = async () => {
    await Promise.allSettled((input.anchors ?? []).map(({ handle }) => handle.close()));
  };
  return Object.freeze({
    anchors: Object.freeze([...(input.anchors ?? [])]),
    child,
    evidence,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      let current: string;
      try {
        current = await readProcessStartIdentity(evidence.pid);
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { readonly code?: unknown }).code === 'ENOENT'
        ) {
          if (groupOperations(evidence.pid).exists()) {
            throw new Error(`hosted_actual_owner_${input.name}_leader_missing_with_live_group`);
          }
          await closeAnchors();
          return;
        }
        throw error;
      }
      if (current !== evidence.processStartIdentity) {
        throw new Error(`hosted_actual_owner_${input.name}_pid_reuse_refused`);
      }
      await drainHostedV1ProcessGroup({
        operations: groupOperations(evidence.pid),
        termGraceMs: input.shutdownMs,
        killGraceMs: input.shutdownMs,
      });
      await closeAnchors();
    },
  });
}

export async function assertActualOwnerManagedProcessIdentity(
  managed: ActualOwnerManagedProcess
): Promise<void> {
  await Promise.all(managed.anchors.map(assertActualOwnerAnchorPathIdentity));
  const current = await collectProcessEvidence({
    args: managed.evidence.args,
    name: managed.evidence.name,
    pid: managed.evidence.pid,
    sourceRef: managed.evidence.sourceRef,
  });
  if (
    current.processStartIdentity !== managed.evidence.processStartIdentity ||
    current.executable !== managed.evidence.executable ||
    current.executableDevice !== managed.evidence.executableDevice ||
    current.executableInode !== managed.evidence.executableInode ||
    current.executableSha256 !== managed.evidence.executableSha256
  ) {
    throw new Error(`hosted_actual_owner_${managed.evidence.name}_process_rotated_before_case`);
  }
}

export async function stopActualOwnerProcesses(
  processes: readonly ActualOwnerManagedProcess[]
): Promise<void> {
  const errors: unknown[] = [];
  for (const managed of [...processes].reverse()) {
    try {
      await managed.stop();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new ActualOwnerProcessCleanupUnprovedError(
      'hosted_actual_owner_process_cleanup_failed',
      new AggregateError(errors)
    );
  }
}
