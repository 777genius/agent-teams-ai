/** Receives one line of fixed codes about the external-writer supervisor; never paths or data. */
export type HostedExternalWriterDiagnosticReporter = (line: string) => void;

const STUCK_AFTER_MS = 5_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const STRUCTURED_FAILURE_CODES = new Set([
  'EACCES',
  'EIO',
  'EISDIR',
  'EMFILE',
  'ENOENT',
  'ENOTDIR',
  'EPERM',
  'ETIMEDOUT',
  'already_started',
  'catalog_invalid',
  'checkpoint_invalid',
  'close_failed',
  'duplicate_alias',
  'duplicate_registration',
  'epoch_not_quiescent',
  'epoch_stale',
  'invalid_max_bytes',
  'invalid_registration',
  'limit_invalid',
  'not_running',
  'options_invalid',
  'outside_containment',
  'oversized',
  'path_not_absolute',
  'path_outside_root',
  'root_not_directory',
  'self_write_limit_exceeded',
  'sequence_exhausted',
  'start_failed',
  'symlink_not_allowed',
  'tracked_state_limit_exceeded',
  'unstable',
  'unsupported_file_type',
  'watch_invalidated',
]);

interface ActiveOperation {
  readonly op: string;
  readonly startedAtMs: number;
  stage: string;
  reportedStuck: boolean;
}

interface InFlightCall {
  readonly name: string;
  readonly startedAtMs: number;
}

function failureCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown';
  try {
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    return typeof code === 'string' && STRUCTURED_FAILURE_CODES.has(code) ? code : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Diagnostics for the external-writer supervisor and its observer ports. The supervisor marks
 * which operation and stage it is in; wrapped ports record pending calls and safe failure codes.
 * A watchdog reports an operation that stays in flight with the calls it is waiting on, once.
 */
export class HostedExternalWriterStageTracker {
  private active: ActiveOperation | null = null;
  private readonly calls = new Map<number, InFlightCall>();
  private nextCallId = 0;
  private lastFailure: string | null = null;
  private readonly reportedPortFailures = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly report: HostedExternalWriterDiagnosticReporter,
    private readonly nowMs: () => number = Date.now
  ) {}

  async run<T>(op: string, operation: () => Promise<T>): Promise<T> {
    const active: ActiveOperation = {
      op,
      startedAtMs: this.nowMs(),
      stage: 'start',
      reportedStuck: false,
    };
    this.active = active;
    try {
      return await operation();
    } catch (error) {
      // Periodic convergence can fail the same way every few seconds; report each cause once.
      const failure = `failed op=${op} stage=${active.stage} code=${failureCode(error)}`;
      if (failure !== this.lastFailure) this.emit(failure);
      this.lastFailure = failure;
      throw error;
    } finally {
      if (active.reportedStuck) {
        this.emit(`recovered op=${op} ms=${this.nowMs() - active.startedAtMs}`);
      }
      if (this.active === active) this.active = null;
    }
  }

  mark(stage: string): void {
    if (this.active !== null) this.active.stage = stage;
  }

  /** Wraps every method of a port so pending calls and rejected calls stay visible. */
  trackPort<T extends object>(name: string, port: T): T {
    // Frozen ports need an unfrozen proxy target: returning a method wrapper from a
    // frozen method property otherwise violates the Proxy get invariant.
    return new Proxy({} as T, {
      get: (_facade, property) => {
        const value: unknown = Reflect.get(port, property, port);
        if (typeof value !== 'function' || typeof property !== 'string') return value;
        return (...args: unknown[]) => {
          const call = `${name}.${property}`;
          let result: unknown;
          try {
            result = Reflect.apply(value, port, args);
          } catch (error) {
            this.reportPortFailure(call, error);
            throw error;
          }
          if (!(result instanceof Promise)) return result;
          const id = ++this.nextCallId;
          this.calls.set(id, { name: call, startedAtMs: this.nowMs() });
          return result.then(
            (value) => {
              this.calls.delete(id);
              return value;
            },
            (error: unknown) => {
              this.calls.delete(id);
              this.reportPortFailure(call, error);
              throw error;
            }
          );
        };
      },
    });
  }

  private reportPortFailure(call: string, error: unknown): void {
    const failure = `rejected call=${call} reason=${failureCode(error)}`;
    if (this.reportedPortFailures.has(failure)) return;
    this.reportedPortFailures.add(failure);
    this.emit(failure);
  }

  startWatchdog(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.check(), WATCHDOG_INTERVAL_MS);
    this.timer.unref?.();
  }

  stopWatchdog(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  check(): void {
    const active = this.active;
    const now = this.nowMs();
    if (active === null || active.reportedStuck || now - active.startedAtMs < STUCK_AFTER_MS) {
      return;
    }
    active.reportedStuck = true;
    const waiting = [...new Set([...this.calls.values()].map(({ name }) => name))].sort();
    this.emit(
      `stuck op=${active.op} stage=${active.stage} ms=${now - active.startedAtMs} waiting=${
        waiting.length === 0 ? 'none' : waiting.join(',')
      }`
    );
  }

  private emit(line: string): void {
    try {
      this.report(`Hosted external writer: ${line}`);
    } catch {
      // Diagnostics never change the supervisor result.
    }
  }
}
