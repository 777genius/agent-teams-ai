import { spawn, type ChildProcess } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicPrivateFile, canonicalJson, ensurePrivateDirectory } from './secure-files';

const SECRET = /(?:TOKEN|SECRET|PASSWORD|COOKIE|AUTH|CREDENTIAL|PROXY|GIT_|HOME|XDG_)/iu;

export type OwnedProcess = Readonly<{
  role: string;
  child: ChildProcess;
  pid: number;
  startTime: string;
  stdoutPath: string;
  stderrPath: string;
}>;

function privateEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(input).filter(([key, value]) => value !== undefined && !SECRET.test(key))
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
  await Promise.all([stdout.close(), stderr.close()]);
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

export async function stopOwnedProcess(owned: OwnedProcess, forced = false): Promise<void> {
  const current = await processStartTime(owned.pid).catch(() => null);
  if (current === null) return;
  if (current !== owned.startTime) throw new Error('actual_owner_cleanup_identity_ambiguous');
  process.kill(-owned.pid, forced ? 'SIGKILL' : 'SIGTERM');
  if (owned.child.exitCode === null && owned.child.signalCode === null) {
    await new Promise<void>((resolveWait, rejectWait) => {
      const timeout = setTimeout(
        () => rejectWait(new Error('actual_owner_cleanup_timeout')),
        forced ? 5_000 : 15_000
      );
      owned.child.once('exit', () => {
        clearTimeout(timeout);
        resolveWait();
      });
    });
  }
  const groupExists = (): boolean => {
    try {
      process.kill(-owned.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  if (!groupExists()) return;
  process.kill(-owned.pid, 'SIGKILL');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!groupExists()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error('actual_owner_cleanup_survivor');
}

export async function recordSupervisorEvent(runRoot: string, value: unknown): Promise<void> {
  await atomicPrivateFile(join(runRoot, 'supervisor.json'), canonicalJson(value), runRoot);
}
