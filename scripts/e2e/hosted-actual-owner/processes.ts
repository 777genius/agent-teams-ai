import { spawn, type ChildProcess } from 'node:child_process';
import { appendFile, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ensurePrivateDirectory } from './secure-files';

const INHERITED_ENVIRONMENT = new Set([
  'NODE_ENV',
  'HOSTED_ACTUAL_OWNER_E2E',
  'HOSTED_ACTUAL_OWNER_E2E_NONCE',
  'HOSTED_ACTUAL_OWNER_E2E_SANDBOX',
  'HOSTED_ACTUAL_OWNER_E2E_EVIDENCE_ROOT',
  'HOSTED_ACTUAL_OWNER_E2E_BROWSER_MANIFEST',
  'HOSTED_ACTUAL_OWNER_E2E_OPENCODE_EXECUTABLE',
  'HOSTED_ACTUAL_OWNER_E2E_OPENCODE_SHA256',
  'HOSTED_ACTUAL_OWNER_E2E_PROVIDER_URL',
]);

export type OwnedProcess = Readonly<{
  role: string;
  child: ChildProcess;
  pid: number;
  startTime: string;
  stdoutPath: string;
  stderrPath: string;
}>;

export type ProcessStopResult = Readonly<{
  role: string;
  pid: number;
  signal: 'none' | 'SIGTERM' | 'SIGKILL';
  escalated: boolean;
  survivors: 0;
}>;

export type StopOwnedProcessOptions = Readonly<{
  forceImmediately?: boolean;
  gracefulTimeoutMs?: number;
  forcedTimeoutMs?: number;
}>;

function privateEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) => value !== undefined && INHERITED_ENVIRONMENT.has(key)
    )
  );
}

async function processStartTime(pid: number): Promise<string> {
  const value = await readFile(`/proc/${pid}/stat`, 'utf8');
  const close = value.lastIndexOf(')');
  const fields = value.slice(close + 2).split(' ');
  const start = fields[19];
  if (!start || !/^\d+$/u.test(start)) throw new Error('actual_owner_process_identity_invalid');
  return start;
}

/** Spawns one detached process group with private files, directories, and an explicit environment. */
export async function spawnOwnedProcess(input: {
  role: string;
  executable: string;
  argv: readonly string[];
  cwd: string;
  runRoot: string;
  environment: NodeJS.ProcessEnv;
}): Promise<OwnedProcess> {
  const privateRoot = join(input.runRoot, 'processes', input.role);
  const home = join(privateRoot, 'home');
  const config = join(privateRoot, 'config');
  const cache = join(privateRoot, 'cache');
  await Promise.all([
    ensurePrivateDirectory(home, input.runRoot),
    ensurePrivateDirectory(config, input.runRoot),
    ensurePrivateDirectory(cache, input.runRoot),
  ]);
  const stdoutPath = join(input.runRoot, `${input.role}.stdout.ndjson`);
  const stderrPath = join(input.runRoot, `${input.role}.stderr.log`);
  const [stdout, stderr] = await Promise.all([
    open(stdoutPath, 'wx', 0o600),
    open(stderrPath, 'wx', 0o600),
  ]);
  const child = spawn(input.executable, [...input.argv], {
    cwd: input.cwd,
    detached: true,
    env: {
      ...privateEnvironment(input.environment),
      PATH: '/usr/bin:/bin',
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
    },
    stdio: ['ignore', stdout.fd, stderr.fd],
  });
  const spawned = new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('error', (error) => {
      rejectSpawn(new Error(`actual_owner_${input.role}_spawn_failed`, { cause: error }));
    });
    child.once('spawn', resolveSpawn);
  });
  try {
    await spawned;
  } finally {
    await Promise.all([stdout.close(), stderr.close()]);
  }
  if (!child.pid) throw new Error(`actual_owner_${input.role}_spawn_failed`);
  const startTime = await processStartTime(child.pid);
  return Object.freeze({
    role: input.role,
    child,
    pid: child.pid,
    startTime,
    stdoutPath,
    stderrPath,
  });
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolveWait) => {
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off('exit', exited);
      resolveWait(value);
    };
    const exited = (): void => settle(true);
    const timeout = setTimeout(() => settle(false), timeoutMs);
    child.once('exit', exited);
    if (child.exitCode !== null || child.signalCode !== null) settle(true);
  });
}

/** Stops the anchored group, escalating through SIGKILL and proving that no group survives. */
export async function stopOwnedProcess(
  owned: OwnedProcess,
  options: StopOwnedProcessOptions = {}
): Promise<ProcessStopResult> {
  const current = await processStartTime(owned.pid).catch(() => null);
  if (current === null) {
    return Object.freeze({
      role: owned.role,
      pid: owned.pid,
      signal: 'none',
      escalated: false,
      survivors: 0,
    });
  }
  if (current !== owned.startTime) throw new Error('actual_owner_cleanup_identity_ambiguous');
  const forceImmediately = options.forceImmediately === true;
  const initialSignal = forceImmediately ? 'SIGKILL' : 'SIGTERM';
  process.kill(-owned.pid, initialSignal);
  await waitForExit(
    owned.child,
    forceImmediately ? (options.forcedTimeoutMs ?? 5_000) : (options.gracefulTimeoutMs ?? 15_000)
  );
  if (!processGroupExists(owned.pid)) {
    return Object.freeze({
      role: owned.role,
      pid: owned.pid,
      signal: initialSignal,
      escalated: forceImmediately,
      survivors: 0,
    });
  }
  process.kill(-owned.pid, 'SIGKILL');
  const deadline = Date.now() + (options.forcedTimeoutMs ?? 5_000);
  while (Date.now() < deadline) {
    if (!processGroupExists(owned.pid)) {
      return Object.freeze({
        role: owned.role,
        pid: owned.pid,
        signal: 'SIGKILL',
        escalated: true,
        survivors: 0,
      });
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error('actual_owner_cleanup_survivor');
}

/** Appends one process-producer cleanup acceptance record to supervisor evidence. */
export async function recordCleanupAcceptance(
  evidenceRoot: string,
  scenario: 'cleanup-normal' | 'cleanup-forced',
  recordId: string,
  result: ProcessStopResult
): Promise<void> {
  if (
    result.survivors !== 0 ||
    (scenario === 'cleanup-normal' && (result.signal !== 'SIGTERM' || result.escalated)) ||
    (scenario === 'cleanup-forced' && (result.signal !== 'SIGKILL' || !result.escalated))
  ) {
    throw new Error(`actual_owner_${scenario}_producer_invalid`);
  }
  await appendFile(
    join(evidenceRoot, 'supervisor.ndjson'),
    `${JSON.stringify({
      schemaVersion: 1,
      scenario,
      recordId,
      passed: true,
      effectCount: 0,
      raw: result,
    })}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
}
