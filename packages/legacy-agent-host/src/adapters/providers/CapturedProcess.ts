import type {
  RegisteredProcessRootSource,
  RegisteredProcessCapture,
  RegistrarBinding,
} from '../../process/registeredProcessContracts.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';

import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import type { NativeProcessProfile } from '../../composition/nativeProcessProfile.js';

/** Process custody needs native selection only, independent of a Team member/session. */
export type CapturedProcessProfile = NativeProcessProfile & {
  provider: 'claude' | 'codex' | 'opencode';
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

/** Own only handles returned by this launch. A PID or an old record is never adopted. */
export interface CapturedProcessPort {
  launch(request: CapturedProcessLaunch): ChildProcessWithoutNullStreams;
  captureRegisteredProcess?(pid: number, registrar: RegistrarBinding): RegisteredProcessCapture;
  seal(): void;
  isRunning(): boolean;
  confirmStopped(): Promise<boolean>;
}

export interface CapturedProcessLaunch {
  command: string;
  args: string[];
  cwd?: string;
  signal?: AbortSignal;
}

export class CapturedProcess implements CapturedProcessPort {
  private readonly processRoots = new Map<
    ChildProcess,
    ReturnType<RegisteredProcessRootSource['captureRoot']> | undefined
  >();
  private readonly children = new Set<ChildProcess>();
  private readonly failed = new Set<ChildProcess>();
  private readonly retired = new Set<ChildProcess>();
  private sealed = false;

  constructor(
    private readonly profile: CapturedProcessProfile,
    private readonly canAllocate: () => boolean = () => true,
    private readonly processCustody?: RegisteredProcessRootSource,
    private readonly canCaptureRegisteredProcess: () => boolean = canAllocate
  ) {
    this.verifyExecutable();
    this.verifyDirectories();
  }

  private verifyDirectories(): void {
    for (const path of [
      this.profile.cwd,
      this.profile.environment.HOME,
      this.profile.provider === 'claude'
        ? this.profile.environment.CLAUDE_CONFIG_DIR
        : this.profile.environment.CODEX_HOME,
    ]) {
      if (path === undefined) continue;
      if (realpathSync(path) !== path || !statSync(path).isDirectory())
        throw new Error('Invalid native directory');
    }
  }

  seal(): void {
    this.sealed = true;
  }

  readonly launch = (request: CapturedProcessLaunch): ChildProcessWithoutNullStreams => {
    if (
      this.sealed ||
      !this.canAllocate() ||
      request.cwd !== this.profile.cwd ||
      request.command !== this.profile.executable.path
    )
      throw new Error('Native launch unavailable');
    this.verifyExecutable();
    this.verifyDirectories();
    const child = spawn(request.command, request.args, {
      cwd: this.profile.cwd,
      env: { ...this.profile.environment },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(request.signal ? { signal: request.signal } : {}),
      detached: process.platform !== 'win32',
    });
    this.children.add(child);
    // Capture only the actual original handle before the first yield. Denial is retained,
    // never repaired by adopting this numeric PID later or changing Team readiness.
    try {
      this.processRoots.set(
        child,
        this.processCustody?.captureRoot(
          child,
          () => !this.sealed && this.canCaptureRegisteredProcess()
        )
      );
    } catch {
      this.processRoots.set(child, undefined);
    }
    child.once('error', () => {
      if (child.pid === undefined) this.failed.add(child);
    });
    // Consume diagnostics without retaining provider credentials, prompt or MCP capabilities.
    child.stderr.on('data', () => {});
    return child;
  };

  captureRegisteredProcess(pid: number, registrar: RegistrarBinding): RegisteredProcessCapture {
    if (this.sealed || !this.canCaptureRegisteredProcess()) throw new Error('process:hold');
    const matches: RegisteredProcessCapture[] = [];
    for (const [child, original] of this.processRoots) {
      if (!original || this.exited(child)) continue;
      try {
        matches.push(original.capture(pid, registrar));
      } catch {
        /* This original root did not prove the target. */
      }
    }
    if (matches.length !== 1) throw new Error('process:hold');
    return matches[0]!;
  }

  isRunning(): boolean {
    return [...this.children].some((child) => child.pid !== undefined && !this.exited(child));
  }

  async confirmStopped(): Promise<boolean> {
    this.seal();
    if (await this.wait(1500)) return true;
    this.signal('SIGTERM');
    if (await this.wait(1000)) return true;
    this.signal('SIGKILL');
    return this.wait(1000);
  }

  private signal(signal: NodeJS.Signals): void {
    for (const child of this.children) {
      // After root reap, a positive numeric group probe may name a replacement.
      // Absence can still settle cleanup; surviving unverified groups stay held.
      if (this.exited(child)) continue;
      if (process.platform !== 'win32' && child.pid !== undefined && this.groupPresent(child)) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          /* Absence is rechecked; errors never prove cleanup. */
        }
      } else if (!this.exited(child)) child.kill(signal);
    }
  }
  private exited(child: ChildProcess): boolean {
    return this.failed.has(child) || child.exitCode !== null || child.signalCode !== null;
  }
  private async wait(timeout: number): Promise<boolean> {
    const deadline = Date.now() + timeout;
    do {
      if ([...this.children].every((child) => this.exited(child) && !this.groupPresent(child)))
        return true;
      await tick();
    } while (Date.now() < deadline);
    return [...this.children].every((child) => this.exited(child) && !this.groupPresent(child));
  }
  private groupPresent(child: ChildProcess): boolean {
    if (this.retired.has(child)) return false;
    if (child.pid === undefined) return !this.failed.has(child);
    // A Windows parent exit is insufficient proof for its native descendants.
    if (process.platform === 'win32') return true;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true;
      // Never reuse a numeric group identifier after its owned lifetime ended.
      if (this.exited(child)) this.retired.add(child);
      return false;
    }
  }
  private verifyExecutable(): void {
    const { path, sha256 } = this.profile.executable;
    const before = lstatSync(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      realpathSync(path) !== path ||
      createHash('sha256').update(readFileSync(path)).digest('hex') !== sha256
    )
      throw new Error('Native executable unavailable');
    const after = lstatSync(path);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new Error('Native executable changed');
  }
}
