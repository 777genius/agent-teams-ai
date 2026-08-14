import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, openSync } from 'node:fs';
import { readFile, readlink, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { drainHostedV1ProcessGroup } from '../hosted-v1/foregroundSubprocess';
import type { ActualOwnerProcessName } from './contracts';
import type { ActualOwnerProcessEvidence } from './evidence';

export interface ActualOwnerManagedProcess {
  readonly child: ChildProcess;
  readonly evidence: ActualOwnerProcessEvidence;
  readonly stop: () => Promise<void>;
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
}): Promise<ActualOwnerProcessEvidence> {
  const procExecutable = await readlink(`/proc/${input.pid}/exe`);
  if (procExecutable.endsWith(' (deleted)')) {
    throw new Error('hosted_actual_owner_process_executable_rotated');
  }
  const executable = procExecutable;
  const canonical = await realpath(executable);
  if (canonical !== executable) throw new Error('hosted_actual_owner_process_executable_not_canonical');
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
  return Object.freeze({
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
}): Promise<ActualOwnerManagedProcess> {
  if (process.platform !== 'linux') throw new Error('hosted_actual_owner_linux_process_identity_required');
  const stdoutFd = openSync(join(input.logRoot, `${input.name}.stdout.log`), 'wx', 0o600);
  const stderrFd = openSync(join(input.logRoot, `${input.name}.stderr.log`), 'wx', 0o600);
  let child: ChildProcess;
  try {
    child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      detached: true,
      env: input.environment,
      stdio: ['ignore', stdoutFd, stderrFd],
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || (pid ?? 0) < 1) {
    throw new Error(`hosted_actual_owner_${input.name}_pid_invalid`);
  }
  const earlyExit = new Promise<never>((_, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      reject(new Error(`hosted_actual_owner_${input.name}_early_exit_${code ?? signal ?? 'unknown'}`))
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
      throw new ActualOwnerProcessCleanupUnprovedError(
        `hosted_actual_owner_${input.name}_launch_cleanup_unproved`,
        new AggregateError([error, cleanupError])
      );
    }
    throw error;
  }
  let stopped = false;
  return Object.freeze({
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
    },
  });
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
