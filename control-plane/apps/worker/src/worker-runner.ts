import { Inject, Injectable } from "@nestjs/common";

import { OutboxWorkerService } from "@agent-teams-control-plane/features-outbox/interface/nest";
import { ControlPlaneConfigService } from "@agent-teams-control-plane/platform-config";
import {
  CONTROL_PLANE_LOGGER,
  type ControlPlaneLogger,
} from "@agent-teams-control-plane/platform-logger";
import { toSafeError } from "@agent-teams-control-plane/shared";

export type WorkerRunMode = "serve" | "smoke";

export type WorkerRunResult = Readonly<{
  mode: WorkerRunMode;
  status: "idle" | "processed-once";
  outboxSkipped: boolean;
}>;

@Injectable()
export class WorkerRunner {
  private readonly logger: ControlPlaneLogger;
  private stopRequested = false;
  private wakeDelay: (() => void) | undefined;

  public constructor(
    @Inject(ControlPlaneConfigService)
    private readonly configService: ControlPlaneConfigService,
    @Inject(OutboxWorkerService)
    private readonly outboxWorker: OutboxWorkerService,
    @Inject(CONTROL_PLANE_LOGGER) logger: ControlPlaneLogger,
  ) {
    this.logger = logger.child("worker");
  }

  public async run(mode: WorkerRunMode): Promise<WorkerRunResult> {
    this.stopRequested = false;
    const summary = this.configService.getSafeSummary();

    this.logger.info("Worker booted", {
      controlPlaneMode: summary.mode,
      workerMode: mode,
    });

    if (mode === "serve") {
      return this.runServeLoop();
    }

    const outboxResult = await this.outboxWorker.runOnce();

    return {
      mode,
      outboxSkipped: outboxResult.skipped,
      status: outboxResult.skipped ? "idle" : "processed-once",
    };
  }

  public requestStop(): void {
    this.stopRequested = true;
    this.wakeDelay?.();
  }

  public async stop(
    runPromise: Promise<WorkerRunResult>,
    input: { timeoutMs?: number } = {},
  ): Promise<WorkerRunResult | undefined> {
    this.requestStop();
    const timeoutMs = input.timeoutMs ?? this.getShutdownTimeoutMs();
    const result = await withTimeout(runPromise, timeoutMs);
    if (result === undefined) {
      this.logger.warn("Worker shutdown timeout elapsed", { timeoutMs });
    }
    return result;
  }

  private async runServeLoop(): Promise<WorkerRunResult> {
    let processed = false;
    let outboxSkipped = false;
    let consecutiveFailures = 0;

    while (!this.stopRequested) {
      try {
        const outboxResult = await this.outboxWorker.runOnce();
        if (outboxResult.skipped) {
          outboxSkipped = true;
          break;
        }
        processed = processed || hasOutboxActivity(outboxResult);
        consecutiveFailures = 0;

        if (!this.stopRequested) {
          await this.delay(this.getPollIntervalMs());
        }
      } catch (error) {
        consecutiveFailures += 1;
        const safeError = toSafeError(error);
        this.logger.warn("Worker loop failed", {
          errorCategory: safeError.category,
          errorCode: safeError.code,
          retryable: safeError.retryable,
        });

        if (!this.stopRequested) {
          await this.delay(this.getBackoffMs(consecutiveFailures));
        }
      }
    }

    return {
      mode: "serve",
      outboxSkipped,
      status: processed ? "processed-once" : "idle",
    };
  }

  private getPollIntervalMs(): number {
    return this.configService.getSafeSummary().outbox.pollIntervalMs;
  }

  private getShutdownTimeoutMs(): number {
    return this.configService.getSafeSummary().outbox.shutdownTimeoutMs;
  }

  private getBackoffMs(consecutiveFailures: number): number {
    const baseMs = Math.min(
      30_000,
      this.getPollIntervalMs() * 2 ** Math.min(consecutiveFailures, 5),
    );
    return baseMs + Math.floor(Math.random() * 250);
  }

  private async delay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.stopRequested) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        this.wakeDelay = undefined;
        resolve();
      }, milliseconds);
      this.wakeDelay = () => {
        clearTimeout(timeout);
        this.wakeDelay = undefined;
        resolve();
      };
    });
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function hasOutboxActivity(
  result: Awaited<ReturnType<OutboxWorkerService["runOnce"]>>,
): boolean {
  return (
    result.claimed > 0 ||
    result.completed > 0 ||
    result.deadLettered > 0 ||
    result.retried > 0 ||
    result.staleClaims > 0
  );
}
