import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { encodeLaunch } from '../../owned-process/codec.js';
import { createWindowsOwnedLaunchPort, verifyStagedBroker } from '../../owned-process/windowsBroker.js';
import { OwnedProcessFacade } from '../../owned-process/processFacade.js';
import { isCanonicalNativePath } from '../../owned-process/nativePath.js';

import type { NativeProcessProfile } from '../../composition/nativeProcessProfile.js';
import type { PendingOwnedProcess, PreparedOwnedProcess, ProcessOwner, ResolvedLaunchSpec } from '../../owned-process/contract.js';
import type { CapturedProcessLaunch } from './CapturedProcess.js';

/** CreateProcessW argv quoting. No cmd.exe, PATH resolution or shell metacharacter expansion. */
export function windowsLaunchSpec(profile: NativeProcessProfile, args: readonly string[]): ResolvedLaunchSpec {
  const quote = (value: string) => `"${value
    .replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
  const result = Object.freeze({ executable: profile.executable.path,
    commandLine: [profile.executable.path, ...args].map(quote).join(' '), cwd: profile.cwd,
    environment: Object.freeze(Object.entries(profile.environment).map(([key, value]) => `${key}=${value}`)) });
  encodeLaunch(result); // Reject aliases/duplicate environment and bounded wire failures before allocation.
  return result;
}

interface Allocation {
  pending: PendingOwnedProcess;
  prepared?: PreparedOwnedProcess;
  child?: OwnedProcessFacade;
  installed: boolean;
  stopped: boolean;
  cleanup?: Promise<boolean>;
  cleanupResult?: boolean;
  attempts: number;
}

/** One custody owner. Prepared root capability, broker transport and SDK facade are distinct. */
export class WindowsCapturedProcess {
  private readonly allocations = new Set<Allocation>();
  private readonly incarnation = randomUUID();
  private readonly profile: NativeProcessProfile;
  private readonly port: ReturnType<typeof createWindowsOwnedLaunchPort>;
  private sealed = false;

  constructor(profile: NativeProcessProfile, private readonly current: () => boolean,
    private readonly verifyTarget: () => void) {
    this.profile = structuredClone(profile);
    this.verifyBroker();
    this.port = createWindowsOwnedLaunchPort(this.profile.windowsBroker!.path);
  }

  private verifyBroker(): void {
    const broker = this.profile.windowsBroker;
    if (process.platform !== 'win32' || !broker || broker.arch !== process.arch || broker.protocol !== 1 ||
      !isCanonicalNativePath(`win32-${process.arch}`, broker.path))
      throw new Error('Windows native custody unavailable');
    const before = lstatSync(broker.path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 16n * 1024n * 1024n ||
      realpathSync(broker.path) !== broker.path) throw new Error('Windows native custody unavailable');
    verifyStagedBroker(broker.path, broker.arch);
    if (createHash('sha256').update(readFileSync(broker.path)).digest('hex') !== broker.sha256)
      throw new Error('Windows native custody unavailable');
    const after = lstatSync(broker.path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
      throw new Error('Windows native custody unavailable');
  }

  private assertCurrent(): void {
    if (this.sealed || !this.current()) throw new Error('Native launch unavailable');
  }

  launch(request: CapturedProcessLaunch): OwnedProcessFacade {
    this.assertCurrent();
    if (request.command !== this.profile.executable.path || request.cwd !== this.profile.cwd)
      throw new Error('Native launch unavailable');
    this.verifyBroker(); this.verifyTarget();
    const spec = windowsLaunchSpec(this.profile, request.args);
    const owner: ProcessOwner = Object.freeze({ teamIncarnation: this.incarnation,
      runId: this.incarnation, laneId: 'provider-native', processGeneration: randomUUID() });
    const allocation: Allocation = { pending: this.port.allocate(owner), installed: false,
      stopped: false, attempts: 0 };
    this.allocations.add(allocation); // Retain original pending cleanup authority before any async work.
    const child = new OwnedProcessFacade({ owner,
      current: () => !this.sealed && this.current(),
      prepare: async () => {
        this.assertCurrent(); this.verifyBroker(); this.verifyTarget();
        const preparation = await this.port.prepare(allocation.pending, spec);
        if (preparation.kind === 'prepared') allocation.prepared = preparation.process;
        return preparation;
      },
      installOwner: async (prepared) => {
        this.assertCurrent(); this.verifyBroker(); this.verifyTarget();
        if (allocation.prepared !== prepared || allocation.installed)
          throw new Error('Native root authority unavailable');
        // The original capability and its observers are installed while the root is
        // suspended. No numeric PID is adopted and the legacy Darwin source is not called.
        allocation.installed = true;
      },
      requestStop: () => { void this.stop(allocation); return true; },
      ...(request.signal ? { signal: request.signal } : {}),
    });
    allocation.child = child;
    child.stderr.on('data', () => {}); // Diagnostics are private, consumed without retaining credentials.
    return child;
  }

  seal(): void { this.sealed = true; }

  isRunning(): boolean {
    return [...this.allocations].some(value => !value.stopped && value.child?.exitCode === null);
  }

  observeStopped(): boolean { return [...this.allocations].every(value => value.stopped); }

  async confirmStopped(): Promise<boolean> {
    this.seal();
    const results = await Promise.all([...this.allocations].map(allocation => {
      // A later explicit close may reconcile fresh native accounting on the same
      // retained capability. Concurrent close/kill still shares one attempt.
      if (allocation.cleanupResult === false && allocation.attempts < 4) {
        delete allocation.cleanup;
        delete allocation.cleanupResult;
      }
      return this.stop(allocation);
    }));
    return results.every(Boolean);
  }

  private stop(allocation: Allocation): Promise<boolean> {
    if (allocation.stopped) return Promise.resolve(true);
    if (allocation.cleanup) return allocation.cleanup;
    allocation.attempts++;
    allocation.cleanup = (async () => {
      try {
        const outcome = await allocation.pending.stop({ expectedOwner: allocation.pending.owner,
          attemptId: `provider-close-${allocation.attempts}`, mode: 'force',
          deadlineMs: performance.now() + 10000 });
        if (outcome.kind !== 'confirmed') return false;
        // Drain is separately bounded. An incomplete tail is never root/tree proof;
        // only the genuine Stop receipt and full release ACK/exit settle custody.
        await allocation.pending.drain(performance.now() + 3000);
        await allocation.pending.release(outcome.receipt, 'job-membership');
        allocation.stopped = true;
        return true;
      } catch { return false; }
    })().then(result => { allocation.cleanupResult = result; return result; });
    return allocation.cleanup;
  }
}
