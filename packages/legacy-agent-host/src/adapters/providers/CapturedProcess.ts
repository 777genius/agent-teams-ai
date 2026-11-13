import type {
  RegisteredProcessRootSource,
  RegisteredProcessCapture,
  RegistrarBinding,
} from '../../process/registeredProcessContracts.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { ChildProcess } from 'node:child_process';
import { WindowsCapturedProcess } from './WindowsCapturedProcess.js';

import type { NativeProcessProfile } from '../../composition/nativeProcessProfile.js';
import type { ObservableNativeProcess } from '../../owned-process/processFacade.js';
import type { OwnedLaunchPort } from '../../owned-process/contract.js';
import type { WindowsRegisteredProcessPort, WindowsServiceIntent } from '../../owned-process/retainedServiceContracts.js';

/** Process custody needs native selection only, independent of a Team member/session. */
export type CapturedProcessProfile = NativeProcessProfile & {
  provider: 'claude' | 'codex' | 'opencode';
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

/** Own only handles returned by this launch. A PID or an old record is never adopted. */
export interface CapturedProcessPort {
  launch(request: CapturedProcessLaunch): ObservableNativeProcess;
  captureRegisteredProcess?(pid: number, registrar: RegistrarBinding): RegisteredProcessCapture;
  prepareRegisteredWindowsProcess?(pid: number, registrar: RegistrarBinding): WindowsServiceIntent;
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

/** An original OS handle/tree captured synchronously before private child input. */
export interface CapturedProcessTree {
  readExecutable(): {
    executablePath: string;
    executableSha256: string;
    pid: number;
    startIdentity: string;
  };
  observe(): 'present' | 'absent' | 'unknown';
  terminate(): void;
}

export interface CapturedProcessTreeSource {
  capture(
    child: ChildProcess,
    executable: { path: string; sha256: string }
  ): CapturedProcessTree;
}

export class CapturedProcess implements CapturedProcessPort {
  private readonly processRoots = new Map<
    ChildProcess,
    ReturnType<RegisteredProcessRootSource['captureRoot']> | undefined
  >();
  private readonly children = new Set<ChildProcess>();
  private readonly failed = new Set<ChildProcess>();
  private readonly retired = new Set<ChildProcess>();
  private readonly nativeTrees = new Map<ChildProcess, CapturedProcessTree>();
  private readonly windows: WindowsCapturedProcess | undefined;
  private sealed = false;

  constructor(
    private readonly profile: CapturedProcessProfile,
    private readonly canAllocate: () => boolean = () => true,
    private readonly processCustody?: RegisteredProcessRootSource,
    private readonly canCaptureRegisteredProcess: () => boolean = canAllocate,
    private readonly processTreeSource?: CapturedProcessTreeSource,
    retainedWindowsPort?: OwnedLaunchPort & { readonly registeredProcesses?: WindowsRegisteredProcessPort }
  ) {
    this.profile = { provider: profile.provider, cwd: profile.cwd,
      environment: { ...profile.environment }, executable: { ...profile.executable },
      ...(profile.windowsBroker ? { windowsBroker: { ...profile.windowsBroker } } : {}) };
    this.verifyExecutable();
    this.verifyDirectories();
    this.windows = process.platform === 'win32' && !processTreeSource
      ? new WindowsCapturedProcess(this.profile, () => !this.sealed && this.canAllocate(), () => {
          this.verifyExecutable(); this.verifyDirectories();
        }, retainedWindowsPort)
      : undefined;
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
    this.windows?.seal();
  }

  readonly launch = (request: CapturedProcessLaunch): ObservableNativeProcess => {
    if (
      this.sealed ||
      !this.canAllocate() ||
      request.cwd !== this.profile.cwd ||
      request.command !== this.profile.executable.path
    )
      throw new Error('Native launch unavailable');
    this.verifyExecutable();
    this.verifyDirectories();
    if (this.windows) return this.windows.launch(request);
    const child = spawn(request.command, request.args, {
      cwd: this.profile.cwd,
      env: { ...this.profile.environment },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(request.signal ? { signal: request.signal } : {}),
      detached: process.platform !== 'win32',
    });
    this.children.add(child);
    child.once('error', () => {
      if (child.pid === undefined) this.failed.add(child);
    });
    // Consume diagnostics without retaining provider credentials, prompt or MCP capabilities.
    child.stderr.on('data', () => {});
    if (this.processTreeSource) {
      try {
        this.nativeTrees.set(child, this.processTreeSource.capture(child, this.profile.executable));
      } catch {
        // Never return an uncaptured child to the caller that owns its private
        // stdin. The original ChildProcess remains retained for cleanup; there
        // is no later PID lookup or attempt to acquire another process tree.
        this.seal();
        child.stdin.on('error', () => {});
        child.stdin.end();
        try { child.kill(); } catch { /* Unknown cleanup stays held. */ }
        throw new Error('Native process tree unavailable');
      }
    }
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
    return child;
  };

  readNativeExecutable(child: ObservableNativeProcess): ReturnType<CapturedProcessTree['readExecutable']> {
    if (!(child instanceof ChildProcess) || this.sealed || !this.canCaptureRegisteredProcess() || !this.children.has(child) || this.exited(child))
      throw new Error('Native executable observation unavailable');
    const tree = this.nativeTrees.get(child);
    if (!tree) throw new Error('Native executable observation unavailable');
    return tree.readExecutable();
  }

  prepareRegisteredWindowsProcess(pid: number, registrar: RegistrarBinding): WindowsServiceIntent {
    if (this.sealed || !this.canCaptureRegisteredProcess() || !this.windows) throw new Error('process:hold');
    return this.windows.prepareRegisteredProcess(pid, registrar);
  }

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
    if (this.windows) return this.windows.isRunning();
    return [...this.children].some((child) => child.pid !== undefined && !this.exited(child));
  }

  /** Read only the retained original tree; never issue another termination. */
  observeStopped(): boolean {
    if (this.windows) return this.windows.observeStopped();
    return [...this.children].every((child) => this.exited(child) && !this.groupPresent(child));
  }

  async confirmStopped(): Promise<boolean> {
    this.seal();
    if (this.windows) return this.windows.confirmStopped();
    if (await this.wait(1500)) return true;
    this.signal('SIGTERM');
    if (await this.wait(1000)) return true;
    this.signal('SIGKILL');
    return this.wait(1000);
  }

  private signal(signal: NodeJS.Signals): void {
    for (const child of this.children) {
      if (this.processTreeSource) {
        // The retained OS job still owns descendants after its original root
        // exits. It is never selected again by a numeric PID or process group.
        try { this.nativeTrees.get(child)?.terminate(); } catch { /* Recheck original handles. */ }
        continue;
      }
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
      if (this.observeStopped()) return true;
      await tick();
    } while (Date.now() < deadline);
    return this.observeStopped();
  }
  private groupPresent(child: ChildProcess): boolean {
    if (this.retired.has(child)) return false;
    if (child.pid === undefined) return !this.failed.has(child);
    if (this.processTreeSource) {
      try {
        const state = this.nativeTrees.get(child)?.observe();
        if (state === 'absent') {
          if (this.exited(child)) this.retired.add(child);
          return false;
        }
      } catch { /* Native query failures cannot prove cleanup. */ }
      return true;
    }
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
