import { createHash } from "node:crypto";
import { join } from "node:path";
import { LocalFileWorkerAccountCapacityStore } from "@vioxen/subscription-runtime/store-local-file";
import {
  accountCapacityAwareWorkerFactory,
  BoundedSubscriptionWorkerPool,
  LocalFileAttemptJournal,
  LocalFileWorkspaceLockStore,
  SafeExecutionRunner,
  SubscriptionWorkerError,
  type AttemptJournal,
  type SafeExecutionPolicy,
  type SafeExecutionRunResult,
  type TaskEffectMode,
  type WorkerAccountCapacityStore,
  type WorkerPoolHealth,
  type WorkerPoolSlotSnapshot,
  type WorkerPoolStats,
  type WorkspaceLockStore,
} from "@vioxen/subscription-runtime/worker-core";
import {
  FileBackendCodexWorker,
  type FileBackendCodexWorkerJob,
  type FileBackendCodexWorkerOptions,
  type FileBackendCodexWorkerResult,
} from "./file-backend-codex-worker";

export type FileBackendCodexSafeExecutorAccount = {
  readonly worker: Omit<
    FileBackendCodexWorkerOptions,
    "workspace" | "workspacePath"
  >;
  readonly codexAuthJson?: string;
  readonly codexAuthJsonPath?: string;
};

export type FileBackendCodexSafeExecutorOptions = {
  readonly executorId?: string;
  readonly stateRootDir: string;
  readonly workspacePath: string;
  readonly accounts: readonly FileBackendCodexSafeExecutorAccount[];
  readonly accountCapacityStore?: WorkerAccountCapacityStore;
  readonly lockStore?: WorkspaceLockStore;
  readonly journal?: AttemptJournal;
  readonly safeExecutionPolicy?: SafeExecutionPolicy;
  readonly maxAccountCycles?: number;
  readonly effectMode?: TaskEffectMode;
  readonly staleLockMs?: number;
  readonly prewarmOnStart?: boolean;
  readonly maxQueueSize?: number;
  readonly shutdownTimeoutMs?: number;
  readonly clock?: { now(): Date };
};

export type FileBackendCodexSafeExecutorRunInput = FileBackendCodexWorkerJob & {
  readonly taskId: string;
  readonly originalPrompt?: string;
  readonly effectMode?: TaskEffectMode;
  readonly staleLockMs?: number;
  readonly maxAccountCycles?: number;
  readonly safeExecutionPolicy?: SafeExecutionPolicy;
};

type WorkerAccount = {
  readonly account: FileBackendCodexSafeExecutorAccount;
  readonly worker: FileBackendCodexWorker;
};

const defaultMaxAccountCycles = 3;

export class FileBackendCodexSafeExecutor {
  readonly accountCapacityStore: WorkerAccountCapacityStore;
  private readonly executorId: string;
  private readonly workerAccounts: WorkerAccount[] = [];
  private roundRobinSlotCursor = 0;
  private readonly pool: BoundedSubscriptionWorkerPool<
    FileBackendCodexWorkerJob,
    FileBackendCodexWorkerResult
  >;
  private readonly runner: SafeExecutionRunner;
  private startPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly options: FileBackendCodexSafeExecutorOptions) {
    assertSafeExecutorOptions(options);
    this.executorId =
      options.executorId ??
      `file-backend-codex-safe:${hashText(options.workspacePath).slice(0, 12)}`;
    this.accountCapacityStore =
      options.accountCapacityStore ??
      new LocalFileWorkerAccountCapacityStore({
        rootDir: join(options.stateRootDir, "worker-account-capacity"),
      });
    this.pool = new BoundedSubscriptionWorkerPool({
      poolId: this.executorId,
      slots: options.accounts.length,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.maxQueueSize === undefined
        ? {}
        : { maxQueueSize: options.maxQueueSize }),
      ...(options.shutdownTimeoutMs === undefined
        ? {}
        : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
      retryPolicy: {
        maxAttempts: options.accounts.length,
        retryOnSlotCapacityUnavailable: true,
      },
      slotSelector: ({ slots }) => this.selectRoundRobinSlot(slots),
      workerFactory: accountCapacityAwareWorkerFactory({
        accountCapacityStore: this.accountCapacityStore,
        ...(options.clock ? { clock: options.clock } : {}),
        workerFactory: ({ slotIndex, workerId }) => {
          const account = options.accounts[slotIndex];
          if (!account) {
            throw new Error("file_backend_codex_safe_account_missing");
          }
          const worker = new FileBackendCodexWorker({
            ...account.worker,
            workerId: account.worker.workerId ?? workerId,
            workspacePath: options.workspacePath,
          });
          this.workerAccounts.push({ account, worker });
          return worker;
        },
      }),
    });
    this.runner = new SafeExecutionRunner({
      lockStore:
        options.lockStore ??
        new LocalFileWorkspaceLockStore(join(options.stateRootDir, "workspace-locks")),
      journal:
        options.journal ??
        new LocalFileAttemptJournal(join(options.stateRootDir, "attempt-journal")),
      ...(options.clock ? { clock: options.clock } : {}),
      ownerId: this.executorId,
    });
  }

  start(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(
        new SubscriptionWorkerError(
          "subscription_worker_disposed",
          "Codex safe executor has been disposed.",
        ),
      );
    }
    if (!this.startPromise) {
      this.startPromise = this.startOnce().catch((error) => {
        this.startPromise = null;
        throw error;
      });
    }
    return this.startPromise;
  }

  async prewarm(): Promise<void> {
    await this.start();
    await this.pool.prewarm();
  }

  async run(
    input: FileBackendCodexSafeExecutorRunInput,
  ): Promise<SafeExecutionRunResult<FileBackendCodexWorkerResult>> {
    await this.start();
    const {
      job,
      taskId,
      originalPrompt,
      effectMode,
      staleLockMs,
      maxAccountCycles,
      policy,
    } =
      codexSafeExecutionInput(input);
    return this.runner.run({
      taskId,
      workspace: {
        mode: "existing_locked",
        path: this.options.workspacePath,
        ...(staleLockMs === undefined ? {} : { staleLockMs }),
      },
      effectMode:
        effectMode ??
        this.options.effectMode ??
        codexEffectModeFromJobControls(job),
      provider: "codex",
      pool: this.pool,
      job,
      originalPrompt,
      policy: mergedSafeExecutionPolicy({
        base: this.options.safeExecutionPolicy,
        override: policy,
        defaultMaxAttempts: accountCycleAttemptLimit({
          accountCount: this.options.accounts.length,
          maxAccountCycles:
            maxAccountCycles ??
            this.options.maxAccountCycles ??
            defaultMaxAccountCycles,
        }),
      }),
      continuationJobFactory: ({ job: previousJob, continuationPacket, attemptNumber }) => ({
        ...previousJob,
        runId: `${taskId}:attempt-${attemptNumber}`,
        prompt: continuationPacket.message,
      }),
      summarizeResult: (result) => result.outputText,
      ...(job.abortSignal ? { abortSignal: job.abortSignal } : {}),
    });
  }

  health(): Promise<WorkerPoolHealth> {
    return this.pool.health();
  }

  stats(): WorkerPoolStats {
    return this.pool.stats();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.pool.dispose();
  }

  private async startOnce(): Promise<void> {
    await this.pool.start();
    await this.seedAccounts();
    if (this.options.prewarmOnStart) {
      await this.pool.prewarm();
    }
  }

  private async seedAccounts(): Promise<void> {
    for (const { account, worker } of this.workerAccounts) {
      if (account.codexAuthJsonPath) {
        await worker.seedCodexAuthJsonFile(account.codexAuthJsonPath);
      }
      if (account.codexAuthJson) {
        await worker.seedCodexAuthJson(account.codexAuthJson);
      }
    }
  }

  private selectRoundRobinSlot(
    slots: readonly WorkerPoolSlotSnapshot[],
  ): WorkerPoolSlotSnapshot | null {
    const available = slots.filter(
      (slot) => !slot.busy && slot.capacity.availability === "available",
    );
    if (available.length === 0) return null;

    for (let offset = 0; offset < slots.length; offset += 1) {
      const index = (this.roundRobinSlotCursor + offset) % slots.length;
      const slot = slots.find((candidate) => candidate.slotIndex === index);
      if (!slot || slot.busy || slot.capacity.availability !== "available") {
        continue;
      }
      this.roundRobinSlotCursor = (index + 1) % slots.length;
      return slot;
    }

    const fallback = available[0]!;
    this.roundRobinSlotCursor = (fallback.slotIndex + 1) % slots.length;
    return fallback;
  }
}

function codexSafeExecutionInput(input: FileBackendCodexSafeExecutorRunInput): {
  readonly taskId: string;
  readonly job: FileBackendCodexWorkerJob;
  readonly originalPrompt: string;
  readonly effectMode?: TaskEffectMode;
  readonly staleLockMs?: number;
  readonly maxAccountCycles?: number;
  readonly policy?: SafeExecutionPolicy;
} {
  const {
    taskId,
    originalPrompt,
    effectMode,
    staleLockMs,
    maxAccountCycles,
    safeExecutionPolicy,
    ...jobInput
  } = input;
  assertMaxAccountCycles(maxAccountCycles);
  const job: FileBackendCodexWorkerJob = {
    ...jobInput,
    runId: jobInput.runId ?? taskId,
  };
  return {
    taskId,
    job,
    originalPrompt: originalPrompt ?? job.prompt,
    ...(effectMode === undefined ? {} : { effectMode }),
    ...(staleLockMs === undefined ? {} : { staleLockMs }),
    ...(maxAccountCycles === undefined ? {} : { maxAccountCycles }),
    ...(safeExecutionPolicy === undefined ? {} : { policy: safeExecutionPolicy }),
  };
}

function codexEffectModeFromJobControls(
  job: FileBackendCodexWorkerJob,
): TaskEffectMode {
  return job.controls?.permissionMode === "allow-edits"
    ? "workspace_patch"
    : "read_only";
}

function mergedSafeExecutionPolicy(input: {
  readonly base: SafeExecutionPolicy | undefined;
  readonly override: SafeExecutionPolicy | undefined;
  readonly defaultMaxAttempts: number;
}): SafeExecutionPolicy {
  return {
    maxAttempts: input.defaultMaxAttempts,
    retryOnCapacity: true,
    retryOnAccountUnavailable: true,
    retryOnReconnectRequired: true,
    retryUnknownCleanWorkspace: true,
    retryUnknownChangedWorkspace: false,
    continuationMode: "packet_first",
    ...(input.base ?? {}),
    ...(input.override ?? {}),
  };
}

function accountCycleAttemptLimit(input: {
  readonly accountCount: number;
  readonly maxAccountCycles: number;
}): number {
  assertMaxAccountCycles(input.maxAccountCycles);
  return input.accountCount * input.maxAccountCycles;
}

function assertSafeExecutorOptions(
  options: FileBackendCodexSafeExecutorOptions,
): void {
  if (!options.stateRootDir.trim()) {
    throw new Error("file_backend_codex_safe_state_root_required");
  }
  if (!options.workspacePath.trim()) {
    throw new Error("file_backend_codex_safe_workspace_required");
  }
  if (options.accounts.length === 0) {
    throw new Error("file_backend_codex_safe_accounts_required");
  }
  assertMaxAccountCycles(options.maxAccountCycles);
  for (const account of options.accounts) {
    if (account.codexAuthJson && account.codexAuthJsonPath) {
      throw new Error("file_backend_codex_safe_account_seed_conflict");
    }
  }
}

function assertMaxAccountCycles(value: number | undefined): void {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value <= 0)
  ) {
    throw new Error("file_backend_codex_safe_max_account_cycles_invalid");
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
