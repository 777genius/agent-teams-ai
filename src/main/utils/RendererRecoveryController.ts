interface RendererRecoveryPorts {
  canRecover: () => boolean;
  reload: () => void;
  onScheduled: (attempt: number, delayMs: number) => void;
  onLimitReached: () => void;
  onReloadError: (error: unknown) => void;
}

const MAX_RECOVERY_ATTEMPTS = 2;
const STABLE_RENDERER_MS = 60_000;

/** A window owns its retry budget until its renderer stays healthy for a full minute. */
export class RendererRecoveryController {
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private disposed = false;

  constructor(private readonly ports: RendererRecoveryPorts) {}

  get recoveryAttempts(): number {
    return this.attempts;
  }

  loadStarted(): void {
    this.clearTimers();
  }

  loadFinished(): void {
    this.clearTimers();
    if (!this.canRecover()) return;
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null;
      if (this.canRecover()) this.attempts = 0;
    }, STABLE_RENDERER_MS);
    this.stabilityTimer.unref?.();
  }

  processGone(): void {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
    if (!this.canRecover() || this.recoveryTimer) return;
    if (this.attempts >= MAX_RECOVERY_ATTEMPTS) {
      this.ports.onLimitReached();
      return;
    }
    const delayMs = ++this.attempts * 1000;
    this.ports.onScheduled(this.attempts, delayMs);
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (!this.canRecover()) return;
      try {
        this.ports.reload();
      } catch (error) {
        this.ports.onReloadError(error);
      }
    }, delayMs);
    this.recoveryTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  private canRecover(): boolean {
    return !this.disposed && this.ports.canRecover();
  }

  private clearTimers(): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.recoveryTimer = null;
    this.stabilityTimer = null;
  }
}
