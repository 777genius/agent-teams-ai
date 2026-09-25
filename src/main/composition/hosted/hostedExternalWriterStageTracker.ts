/** Receives one line of fixed codes about the external-writer supervisor; never paths or data. */
export type HostedExternalWriterDiagnosticReporter = (line: string) => void;

const STUCK_AFTER_MS = 5_000;
const WATCHDOG_INTERVAL_MS = 5_000;

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
  const message = error instanceof Error ? error.message : '';
  return /^[a-z0-9][a-z0-9:_-]{0,127}$/u.test(message) ? message : 'unknown';
}

/**
 * Hang diagnostics for the external-writer supervisor and its observer ports. The supervisor marks
 * which operation and stage it is in; wrapped ports record which call is still pending. A watchdog
 * reports an operation that stays in flight, together with the calls it is waiting on, once.
 */
export class HostedExternalWriterStageTracker {
  private active: ActiveOperation | null = null;
  private readonly calls = new Map<number, InFlightCall>();
  private nextCallId = 0;
  private lastFailure: string | null = null;
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

  /** Wraps every method of a port so a pending asynchronous call stays visible while it waits. */
  trackPort<T extends object>(name: string, port: T): T {
    return new Proxy(port, {
      get: (target, property) => {
        // The target stays the receiver so ports with private fields keep working.
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== 'function' || typeof property !== 'string') return value;
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(value, target, args);
          if (!(result instanceof Promise)) return result;
          const id = ++this.nextCallId;
          this.calls.set(id, { name: `${name}.${property}`, startedAtMs: this.nowMs() });
          return result.finally(() => this.calls.delete(id));
        };
      },
    });
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
