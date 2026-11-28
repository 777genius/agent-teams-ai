import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import { pause } from './packaged-default-cdp.ts';
// @ts-expect-error Existing shared JavaScript process-identity helpers have no declarations.
import { ownedTree, processes, sameIdentity } from '../opencode-diagnostics/platform.mjs';

export interface ProcessIdentity {
  pid: number;
  parent: number;
  birth: string;
  executable?: string;
}
/** Inventory failure grants fallback authority only over our own spawned handle. */
export async function stopUnregisteredApp(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  let timeout: NodeJS.Timeout | undefined;
  try {
    child.kill('SIGTERM');
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Owned app handle did not close after inventory failure')),
          10_000
        );
      }),
    ]);
  } finally {
    clearTimeout(force);
    clearTimeout(timeout);
  }
}
export class DefaultProcessLedger {
  readonly observed = new Map<string, ProcessIdentity>();
  readonly roots: ProcessIdentity[] = [];
  readonly commands: {
    executable: string;
    args: string[];
    pid?: number;
    exitCode?: number | null;
    signal?: string | null;
    stdout?: string;
    stderr?: string;
  }[] = [];
  private timer?: NodeJS.Timeout;
  private samplingError?: unknown;
  private failureCleanupDeadline?: number;
  private readonly readProcesses: (requiredPids?: number[]) => ProcessIdentity[];
  private readonly killProcess: (pid: number, signal: NodeJS.Signals) => boolean;
  constructor(
    readProcesses: (requiredPids?: number[]) => ProcessIdentity[] = processes,
    killProcess: (pid: number, signal: NodeJS.Signals) => boolean = process.kill
  ) {
    this.readProcesses = readProcesses;
    this.killProcess = killProcess;
  }
  private key(p: ProcessIdentity) {
    return `${p.pid}:${p.birth}`;
  }
  async register(child: ChildProcess) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const identity = this.readProcesses().find((p) => p.pid === child.pid);
      if (identity) {
        this.roots.push(identity);
        this.observed.set(this.key(identity), identity);
        this.sample();
        return identity;
      }
      assert(child.exitCode === null, 'Owned process exited before identity capture');
      await pause(100);
    }
    throw new Error('Owned process identity unavailable');
  }
  sample() {
    const requiredPids = [...new Set([...this.observed.values()].map((p) => p.pid))];
    return this.sampleObserved(requiredPids);
  }
  private sampleObserved(requiredPids: number[]) {
    const snapshot = this.readProcesses(requiredPids);
    for (const root of [...this.roots, ...this.observed.values()]) {
      if (!snapshot.some((p) => this.key(p) === this.key(root))) continue;
      for (const p of ownedTree(snapshot, root) as ProcessIdentity[])
        this.observed.set(this.key(p), p);
    }
    return snapshot.filter((p) => this.observed.has(this.key(p)));
  }
  start() {
    this.timer = setInterval(() => {
      try {
        this.sample();
      } catch (error) {
        this.samplingError = error;
      }
    }, 1000);
  }
  async runtimeQuiet(appExecutable: string) {
    const current = this.sample();
    const active = [];
    for (const identity of current) {
      let executable = identity.executable;
      if (!executable && process.platform === 'linux') {
        executable = await readlink(`/proc/${identity.pid}/exe`).catch(() => undefined);
      }
      if (executable && executable.toLowerCase() === appExecutable.toLowerCase()) continue;
      // A process may have exited after the snapshot. Unknown live children fail closed.
      if (this.readProcesses([identity.pid]).some((p) => this.key(p) === this.key(identity)))
        active.push({ ...identity, executable });
    }
    return active;
  }
  async command(
    executable: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
    timeout = 30_000
  ) {
    const entry: (typeof this.commands)[number] = { executable, args };
    this.commands.push(entry);
    const child = spawn(executable, args, {
      env,
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    entry.pid = child.pid;
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 1_048_576) stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 1_048_576) stderr += String(chunk);
    });
    const completion = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        entry.exitCode = code;
        entry.signal = signal;
        resolve();
      });
    });
    // Very short --version commands can exit before OS inventory sees them;
    // ChildProcess still supplies their exact PID, close event and exit status.
    const identity = this.readProcesses().find((p) => p.pid === child.pid);
    if (identity) {
      this.roots.push(identity);
      this.observed.set(this.key(identity), identity);
    }
    this.sample();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Bundled command timed out after ${timeout}ms`));
      }, timeout);
    });
    try {
      await Promise.race([completion, deadline]);
    } finally {
      clearTimeout(timer);
      entry.stdout = stdout;
      entry.stderr = stderr;
    }
    assert.equal(entry.exitCode, 0, `Bounded bundled command failed: ${stderr}`);
    assert.equal(entry.signal, null);
    return { stdout, stderr, pid: child.pid };
  }
  async stop({ requireQuiet = false }: { requireQuiet?: boolean } = {}) {
    if (this.timer) clearInterval(this.timer);
    if (requireQuiet) {
      const current = this.sample();
      // Qualification may only observe natural retirement. Ordinary failure
      // cleanup below is never allowed to manufacture a successful final census.
      assert.equal(current.length, 0, 'Owned processes did not settle naturally');
      assert(!this.samplingError, `Process inventory failed: ${this.samplingError}`);
      return { remaining: current, observed: [...this.observed.values()], commands: this.commands };
    }
    let current = this.cleanupSample();
    const rootKeys = new Set(this.roots.map((p) => this.key(p)));
    // First ask each owned app root to stop; descendants may then exit normally.
    for (const p of current.filter((p) => rootKeys.has(this.key(p)))) this.signal(p);
    for (let attempt = 0; attempt < 10 && current.length; attempt++) {
      this.checkCleanupDeadline();
      await pause(300);
      current = this.cleanupSample();
    }
    for (const p of current.reverse()) this.signal(p, 'SIGKILL');
    for (let attempt = 0; attempt < 20 && current.length; attempt++) {
      this.checkCleanupDeadline();
      await pause(300);
      current = this.cleanupSample();
    }
    this.checkCleanupDeadline();
    assert.equal(current.length, 0, 'Owned packaged/runtime processes remain after cleanup');
    assert(!this.samplingError, `Process inventory failed: ${this.samplingError}`);
    return { remaining: current, observed: [...this.observed.values()], commands: this.commands };
  }
  private checkCleanupDeadline() {
    if (this.samplingError === undefined) return;
    const now = Date.now();
    // Start one failure-only budget; an in-flight Windows census is capped at 30s.
    this.failureCleanupDeadline ??= now + 10_000;
    if (now >= this.failureCleanupDeadline) throw this.samplingError;
  }
  private cleanupSample() {
    this.checkCleanupDeadline();
    try {
      try {
        return this.sample();
      } catch (error) {
        // A captured PID with an unreadable birth must fail qualification, but
        // cannot prevent cleanup of other independently verified identities.
        this.samplingError ??= error;
        this.checkCleanupDeadline();
        return this.sampleObserved([]);
      }
    } finally {
      this.checkCleanupDeadline();
    }
  }
  private signal(expected: ProcessIdentity, signal: NodeJS.Signals = 'SIGTERM') {
    this.checkCleanupDeadline();
    try {
      const current = this.readProcesses([expected.pid]).find((p) => p.pid === expected.pid);
      this.checkCleanupDeadline();
      if (!current) return;
      sameIdentity(expected, current);
      this.killProcess(expected.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.samplingError ??= error;
    } finally {
      this.checkCleanupDeadline();
    }
  }
}
