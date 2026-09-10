/** One admission clock shared by Windows startup preflight, registry and tail. */
export class OpenCodeStartupCleanupBudget {
  readonly deadlineUnixMs: number;
  private readonly deadlineMonotonicMs: number;

  constructor(
    deadlineUnixMs = Date.now() + 120_000,
    unixNowMs = Date.now(),
    private readonly monotonicNowMs: () => number = () => performance.now()
  ) {
    const remaining = deadlineUnixMs - unixNowMs;
    if (!Number.isFinite(deadlineUnixMs) || remaining <= 0 || remaining > 120_000) {
      throw new Error('Invalid OpenCode startup cleanup deadline');
    }
    this.deadlineUnixMs = deadlineUnixMs;
    this.deadlineMonotonicMs = monotonicNowMs() + remaining;
  }

  remainingMs(): number {
    return Math.max(0, Math.floor(this.deadlineMonotonicMs - this.monotonicNowMs()));
  }

  /** Never pass zero to a subprocess timeout (zero disables its timeout). */
  capMs(cap: number): number {
    const remaining = this.remainingMs();
    if (remaining === 0) throw new Error('OpenCode startup cleanup budget exhausted');
    return Math.min(cap, remaining);
  }

  assertCanTerminate(): void {
    // Reserve the existing five-second termination observation window.
    if (this.remainingMs() < 5_000) {
      throw new Error('OpenCode startup cleanup termination budget exhausted');
    }
  }
}
