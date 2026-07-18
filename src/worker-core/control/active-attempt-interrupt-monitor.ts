import type { ActiveAttemptRegistry, WorkerControlTarget } from "./types";
import { WorkerControlService } from "./worker-control-service";

export type ActiveAttemptInterruptMonitorOptions = {
  readonly control: Pick<WorkerControlService, "listSignals">;
  readonly activeAttemptRegistry: ActiveAttemptRegistry;
  readonly pollIntervalMs?: number;
};

/**
 * Bridges durable worker-control signals into the process-local abort registry.
 *
 * The sender and worker commonly run in different OS processes, so the sender's
 * in-memory registry cannot interrupt the provider turn directly. This monitor
 * owns no orchestration policy: it only applies an already-authorized
 * interrupt_then_continue signal to the matching active attempt.
 */
export class ActiveAttemptInterruptMonitor {
  private readonly pollIntervalMs: number;
  private readonly interruptedSignalIds = new Set<string>();
  private stopRequested = false;
  private runPromise: Promise<void> | null = null;

  constructor(private readonly options: ActiveAttemptInterruptMonitorOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new Error("active_attempt_interrupt_poll_interval_invalid");
    }
  }

  start(target: WorkerControlTarget): void {
    if (this.runPromise) {
      throw new Error("active_attempt_interrupt_monitor_already_started");
    }
    this.stopRequested = false;
    this.runPromise = this.run(target);
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    await this.runPromise;
    this.runPromise = null;
  }

  private async run(target: WorkerControlTarget): Promise<void> {
    while (!this.stopRequested) {
      try {
        const signals = await this.options.control.listSignals({
          target,
          states: ["pending"],
          includeExpired: false,
        });
        for (const view of signals) {
          if (
            view.signal.deliveryMode !== "interrupt_then_continue" ||
            this.interruptedSignalIds.has(view.signal.signalId)
          ) {
            continue;
          }
          const interrupt = await this.options.activeAttemptRegistry.interrupt(
            target,
            {
              code: "runtime_controlled_interrupt",
              safeMessage:
                "Runtime controlled interrupt requested by durable worker control inbox.",
              signalId: view.signal.signalId,
              requestedBy: view.signal.createdBy,
            },
          );
          if (interrupt.status === "interrupted") {
            this.interruptedSignalIds.add(view.signal.signalId);
          }
        }
      } catch {
        // A transient inbox read must not fail the worker run. The next poll
        // retries the same durable signal without changing its delivery state.
      }
      await delay(this.pollIntervalMs);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
