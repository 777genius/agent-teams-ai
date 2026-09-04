/**
 * The app's startup runtime sweep force-reaps managed OpenCode hosts for
 * several seconds after start, and it is fire-and-forget, so a team launch
 * requested inside that window used to race it: the sweep killed the launch's
 * own readiness-probe host, the launch was refused before any state-changing
 * bridge command ran, and the user saw a launch fail for no reason they could
 * see.
 *
 * This gate lets such a launch serialise behind the sweep instead of racing
 * it. It is belt and braces on top of the start-time fence the sweep itself
 * applies, because the sweep is reachable from more than one lifecycle path
 * and a fence can only protect processes that already exist when it is read.
 */

/** A stuck sweep must never park launches forever. */
export const OPEN_CODE_STARTUP_SWEEP_WAIT_TIMEOUT_MS = 60_000;

interface PendingStartupSweep {
  promise: Promise<void>;
  settle: () => void;
}

let pendingStartupSweep: PendingStartupSweep | null = null;

/**
 * Marks the startup runtime sweep as pending. Call it when the sweep is
 * scheduled, not when it starts running, so a launch requested during the
 * scheduling delay also waits. The returned callback must be invoked from a
 * `finally`: a sweep that throws still has to release the launches waiting on
 * it, and that is the only reason this is a callback rather than a promise the
 * gate awaits itself.
 */
export function beginOpenCodeStartupRuntimeSweep(): () => void {
  if (!pendingStartupSweep) {
    let settle!: () => void;
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    pendingStartupSweep = { promise, settle };
  }
  const current = pendingStartupSweep;
  return () => {
    current.settle();
    if (pendingStartupSweep === current) {
      pendingStartupSweep = null;
    }
  };
}

export interface WhenOpenCodeStartupRuntimeSweepSettledOptions {
  timeoutMs?: number;
  logWaited?: (message: string) => void;
  /** Runs only when the caller really parks, so it can report the wait. */
  onWaitStart?: () => void;
  nowMs?: () => number;
  setTimeoutImpl?: typeof setTimeout;
}

/**
 * Resolves immediately when no startup sweep is pending. Otherwise waits for
 * it and records the observed wait, so a launch that was slow because it
 * queued behind the sweep says so instead of leaving it to be inferred from
 * timestamps.
 */
export async function whenOpenCodeStartupRuntimeSweepSettled(
  options: WhenOpenCodeStartupRuntimeSweepSettledOptions = {}
): Promise<void> {
  const current = pendingStartupSweep;
  if (!current) {
    return;
  }
  options.onWaitStart?.();
  const nowMs = options.nowMs ?? (() => Date.now());
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
  const timeoutMs = options.timeoutMs ?? OPEN_CODE_STARTUP_SWEEP_WAIT_TIMEOUT_MS;
  const startedAtMs = nowMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    current.promise.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeoutImpl(() => resolve(true), timeoutMs);
    }),
  ]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  if (timedOut && pendingStartupSweep === current) {
    // Giving up once is enough: a sweep that already blew the bound would make
    // every later launch pay it again, which is exactly the forever-park this
    // gate exists to prevent. The sweep's own start-time fence stays in force.
    pendingStartupSweep = null;
  }
  const waitedMs = nowMs() - startedAtMs;
  options.logWaited?.(
    `opencode_startup_sweep_wait waitedMs=${waitedMs} settled=${String(!timedOut)}`
  );
}
