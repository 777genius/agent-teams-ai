import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  workerControlTargetMatches,
  type CapacityAwareSubscriptionWorker,
  type SubscriptionWorkerHealth,
  type SubscriptionWorkerPrewarmResult,
  type SubscriptionWorkerState,
  type WorkerCapacitySnapshot,
  type WorkerControlDeliveryReceipt,
  type WorkerControlInboxStore,
  type WorkerControlSignal,
  type WorkerControlTarget,
} from "../../index";

export const execFileAsync = promisify(execFile);

export type PromptJob = {
  readonly prompt: string;
  readonly workspacePath: string;
  readonly goalObjective?: string;
};

export type PromptResult = {
  readonly output: string;
};

export async function cleanupTemporaryPaths(paths: string[]): Promise<void> {
  while (paths.length > 0) {
    const path = paths.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
}

export async function tempPath(
  cleanupPaths: string[],
  prefix: string,
): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(path);
  return path;
}

export async function gitWorkspace(
  cleanupPaths: string[],
  prefix: string,
): Promise<string> {
  const workspacePath = await tempPath(cleanupPaths, prefix);
  await execFileAsync("git", ["init"], { cwd: workspacePath });
  await writeFile(join(workspacePath, "README.md"), "base\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: workspacePath });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Subscription Runtime Tests",
      "-c",
      "user.email=tests@example.com",
      "commit",
      "-m",
      "Initial commit",
    ],
    { cwd: workspacePath },
  );
  return workspacePath;
}

export class FakePromptWorker
  implements CapacityAwareSubscriptionWorker<PromptJob, PromptResult>
{
  state: SubscriptionWorkerState = "created";
  capacitySnapshot: WorkerCapacitySnapshot = { availability: "available" };

  constructor(
    readonly workerId: string,
    private readonly handler: (
      job: PromptJob,
      self: FakePromptWorker,
    ) => Promise<PromptResult>,
  ) {}

  async start(): Promise<void> {
    this.state = "started";
  }

  async prewarm(): Promise<SubscriptionWorkerPrewarmResult> {
    this.state = "ready";
    return {
      status: "ready",
      warmedAt: new Date(),
      warnings: [],
    };
  }

  run(job: PromptJob): Promise<PromptResult> {
    return this.handler(job, this);
  }

  async health(): Promise<SubscriptionWorkerHealth> {
    return {
      status: "healthy",
      state: this.state,
      checkedAt: new Date(),
      warnings: [],
    };
  }

  capacity(): WorkerCapacitySnapshot {
    return this.capacitySnapshot;
  }

  async dispose(): Promise<void> {
    this.state = "disposed";
  }
}

export function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

export class InMemoryWorkerControlInboxStore implements WorkerControlInboxStore {
  private readonly signals: WorkerControlSignal[] = [];
  private readonly receipts: WorkerControlDeliveryReceipt[] = [];

  async appendSignal(signal: WorkerControlSignal): Promise<WorkerControlSignal> {
    this.signals.push(signal);
    return signal;
  }

  async listSignals(input: {
    readonly target?: WorkerControlTarget;
    readonly signalIds?: readonly string[];
  } = {}): Promise<readonly WorkerControlSignal[]> {
    return this.signals.filter((signal) =>
      (!input.target || workerControlTargetMatches(input.target, signal.target)) &&
      (!input.signalIds || input.signalIds.includes(signal.signalId))
    );
  }

  async tryClaimDelivery(
    receipt: WorkerControlDeliveryReceipt,
  ): Promise<WorkerControlDeliveryReceipt | null> {
    if (
      this.receipts.some((existing) =>
        existing.signalId === receipt.signalId &&
        existing.state === "accepted" &&
        existing.deliveryAttemptId === receipt.deliveryAttemptId
      )
    ) {
      return null;
    }
    this.receipts.push(receipt);
    return receipt;
  }

  async releaseDeliveryClaim(input: {
    readonly target: WorkerControlTarget;
    readonly signalId: string;
    readonly deliveryAttemptId?: string;
  }): Promise<boolean> {
    const index = this.receipts.findIndex((receipt) =>
      receipt.signalId === input.signalId &&
      receipt.state === "accepted" &&
      (input.deliveryAttemptId === undefined ||
        receipt.deliveryAttemptId === input.deliveryAttemptId) &&
      workerControlTargetMatches(input.target, receipt.target)
    );
    if (index < 0) return false;
    this.receipts.splice(index, 1);
    return true;
  }

  async appendReceipt(
    receipt: WorkerControlDeliveryReceipt,
  ): Promise<WorkerControlDeliveryReceipt> {
    this.receipts.push(receipt);
    return receipt;
  }

  async appendReceipts(
    receipts: readonly WorkerControlDeliveryReceipt[],
  ): Promise<readonly WorkerControlDeliveryReceipt[]> {
    this.receipts.push(...receipts);
    return receipts;
  }

  async listReceipts(input: {
    readonly target?: WorkerControlTarget;
    readonly signalIds?: readonly string[];
  } = {}): Promise<readonly WorkerControlDeliveryReceipt[]> {
    return this.receipts.filter((receipt) =>
      (!input.target || workerControlTargetMatches(input.target, receipt.target)) &&
      (!input.signalIds || input.signalIds.includes(receipt.signalId))
    );
  }
}

export function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}
