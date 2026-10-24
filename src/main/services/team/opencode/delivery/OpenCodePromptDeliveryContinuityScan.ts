export const OPENCODE_PROMPT_DELIVERY_CONTINUITY_SCAN_INTERVAL_MS = 30_000;

export interface OpenCodePromptDeliveryContinuityScanPorts {
  isEnabled(): boolean;
  listLiveTeamNames(): Promise<readonly string[]> | readonly string[];
  scanTeam(teamName: string): Promise<unknown>;
  warn(message: string): void;
}

function unrefBackgroundTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeTimer = timer as { unref?: () => void };
  maybeTimer.unref?.();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Continuity backstop: the watchdog recovery scan rebuilds ledger records from unread inbox rows, but it ran only at startup, so a lost watcher trigger or a dropped wake orphaned the row forever.
export class OpenCodePromptDeliveryContinuityScan {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private scanInFlight = false;
  private readonly intervalMs: number;

  constructor(
    private readonly ports: OpenCodePromptDeliveryContinuityScanPorts,
    intervalMs: number = OPENCODE_PROMPT_DELIVERY_CONTINUITY_SCAN_INTERVAL_MS
  ) {
    this.intervalMs = Math.max(250, intervalMs);
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.arm();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private arm(): void {
    if (!this.started) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce();
    }, this.intervalMs);
    unrefBackgroundTimer(this.timer);
  }

  private async runOnce(): Promise<void> {
    if (!this.started) {
      return;
    }
    // Fixed-rate re-arm first so one slow scan cannot stall the chain.
    this.arm();
    if (this.scanInFlight || !this.ports.isEnabled()) {
      return;
    }
    this.scanInFlight = true;
    try {
      const teamNames = await this.ports.listLiveTeamNames();
      for (const teamName of teamNames) {
        if (!this.started) {
          return;
        }
        await this.scanTeamSafely(teamName);
      }
    } catch (error) {
      this.ports.warn(`OpenCode prompt delivery continuity scan failed: ${getErrorMessage(error)}`);
    } finally {
      this.scanInFlight = false;
    }
  }

  private async scanTeamSafely(teamName: string): Promise<void> {
    try {
      await this.ports.scanTeam(teamName);
    } catch (error) {
      this.ports.warn(
        `[${teamName}] OpenCode prompt delivery continuity scan failed: ${getErrorMessage(error)}`
      );
    }
  }
}
