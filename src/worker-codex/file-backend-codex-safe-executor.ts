import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObservabilityPort } from "@vioxen/subscription-runtime/core";
import {
  validateCodexAuthJsonBytes,
  type ValidatedCodexAuthJson,
} from "@vioxen/subscription-runtime/provider-codex";
import {
  LocalFileWorkerAccountCapacityStore,
  LocalFileWorkerControlInboxStore,
  createLocalFileSafeExecutionStores,
} from "@vioxen/subscription-runtime/store-local-file";
import {
  accountCapacityAwareWorkerFactory,
  type ActiveAttemptRegistry,
  type AttemptUsage,
  BoundedSubscriptionWorkerPool,
  SafeExecutionRunner,
  SubscriptionWorkerError,
  WorkerControlService,
  type AttemptJournal,
  type SafeExecutionPolicy,
  type SafeExecutionRunResult,
  type SafeExecutionRuntime,
  type SafeExecutionWorkspaceAccess,
  type TaskEffectMode,
  type WorkerAccountCapacityStore,
  type WorkerControlContinuationBatch,
  type WorkerControlContinuationSource,
  type WorkerControlTarget,
  type WorkerPoolHealth,
  type WorkerPoolSlotSnapshot,
  type WorkerPoolStats,
  type WorkspaceLockStore,
  type WorkspaceSnapshotter,
} from "@vioxen/subscription-runtime/worker-core";
import {
  DefaultWorkspaceSnapshotter,
  NodeSafeExecutionRuntime,
  NodeSafeExecutionWorkspaceAccess,
} from "../worker-local/safe-execution";
import {
  FileBackendCodexWorker,
  type FileBackendCodexWorkerJob,
  type FileBackendCodexWorkerOptions,
  type FileBackendCodexWorkerResult,
} from "./file-backend-codex-worker";
import { CodexAccountCapacityRechecker } from "./application/codex-account-capacity-rechecker";
import { CodexAccountCapacityAliasStore } from "./application/codex-account-capacity-alias-store";

const REPLACEMENT_GOAL_OBJECTIVE =
  "Continue the same authorized task using broker-delivered replacement wording.";

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
  readonly authRootDir?: string;
  readonly workspacePath: string;
  readonly accounts: readonly FileBackendCodexSafeExecutorAccount[];
  /**
   * Safe default is false. Multiple slots for one Codex account can race the
   * same refresh chain and make every copy stale.
   */
  readonly allowDuplicateAccountIdentities?: boolean;
  readonly accountCapacityStore?: WorkerAccountCapacityStore;
  readonly observability?: ObservabilityPort;
  readonly controlInbox?: WorkerControlContinuationSource;
  readonly activeAttemptRegistry?: ActiveAttemptRegistry;
  readonly lockStore?: WorkspaceLockStore;
  readonly journal?: AttemptJournal;
  readonly snapshotter?: WorkspaceSnapshotter;
  readonly workspaceAccess?: SafeExecutionWorkspaceAccess;
  readonly runtime?: SafeExecutionRuntime;
  readonly safeExecutionPolicy?: SafeExecutionPolicy;
  /**
   * Defaults to true: the borrowed workspace must be an existing git worktree.
   * This prevents broad filesystem snapshots from being mistaken for worker
   * changes when callers accidentally point at a repo parent or temp folder.
   */
  readonly requireGitWorkspace?: boolean;
  readonly maxAccountCycles?: number;
  readonly effectMode?: TaskEffectMode;
  readonly staleLockMs?: number;
  readonly prewarmOnStart?: boolean;
  readonly maxQueueSize?: number;
  readonly startTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly outputSchemas?: Readonly<Record<string, unknown>>;
  readonly clock?: { now(): Date };
};

export type FileBackendCodexSafeExecutorRunInput = FileBackendCodexWorkerJob & {
  readonly jobId?: string;
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

type CodexAccountIdentity = {
  readonly label: string;
  readonly key: string;
  readonly hash: string;
  readonly source: string;
};

const defaultMaxAccountCycles = 5;

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
    const observability =
      options.observability ??
      options.accounts.find((account) => account.worker.observability)?.worker
        .observability;
    const baseAccountCapacityStore =
      options.accountCapacityStore ??
      new LocalFileWorkerAccountCapacityStore({
        rootDir: join(options.stateRootDir, "worker-account-capacity"),
        ...(observability ? { observability } : {}),
      });
    const aliasedAccountCapacityStore = new CodexAccountCapacityAliasStore({
      authRootDir: options.authRootDir ?? options.stateRootDir,
      store: baseAccountCapacityStore,
      authJsonPaths: Object.fromEntries(
        options.accounts.flatMap((account, index) =>
          account.codexAuthJsonPath
            ? [
                [
                  safeExecutorAccountLabel(account, index),
                  account.codexAuthJsonPath,
                ],
              ]
            : [],
        ),
      ),
      authJsonByAlias: Object.fromEntries(
        options.accounts.flatMap((account, index) =>
          account.codexAuthJson !== undefined
            ? [
                [
                  safeExecutorAccountLabel(account, index),
                  account.codexAuthJson,
                ],
              ]
            : [],
        ),
      ),
    });
    this.accountCapacityStore = aliasedAccountCapacityStore;
    this.pool = new BoundedSubscriptionWorkerPool({
      poolId: this.executorId,
      slots: options.accounts.length,
      ...(observability ? { observability } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.maxQueueSize === undefined
        ? {}
        : { maxQueueSize: options.maxQueueSize }),
      ...(options.startTimeoutMs === undefined
        ? {}
        : { startTimeoutMs: options.startTimeoutMs }),
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
        accountWideLimitReasons: ["quota_limited"],
        requireCapacityRecheckWhenDue: true,
        recheckClaimTtlMs: 5 * 60_000,
        recheckFailureCooldownMs: 60_000,
        capacityRecheckerFactory: ({ slotIndex }) => {
          const account = options.accounts[slotIndex];
          if (!account?.codexAuthJsonPath) return undefined;
          return new CodexAccountCapacityRechecker({
            accountId:
              account.worker.capacityAccountId ??
              account.worker.providerInstanceId,
            authJsonPath: account.codexAuthJsonPath,
            codexBinaryPath: account.worker.codexBinaryPath,
            timeoutMs: account.worker.appServerStartupTimeoutMs ?? 30_000,
          });
        },
        ...(options.clock ? { clock: options.clock } : {}),
        workerFactory: ({ slotIndex, workerId }) => {
          const account = options.accounts[slotIndex];
          if (!account) {
            throw new Error("file_backend_codex_safe_account_missing");
          }
          const worker = new FileBackendCodexWorker({
            ...account.worker,
            capacityAccountId:
              account.worker.capacityAccountId ??
              safeExecutorAccountLabel(account, slotIndex),
            ...(account.worker.observability || !observability
              ? {}
              : { observability }),
            workerId: account.worker.workerId ?? workerId,
            workspacePath: options.workspacePath,
            ...(options.outputSchemas === undefined
              ? {}
              : { outputSchemas: options.outputSchemas }),
          });
          this.workerAccounts.push({ account, worker });
          return worker;
        },
      }),
    });
    const localSafeExecutionStores = createLocalFileSafeExecutionStores({
      rootDir: options.stateRootDir,
    });
    this.runner = new SafeExecutionRunner({
      lockStore: options.lockStore ?? localSafeExecutionStores.lockStore,
      journal: options.journal ?? localSafeExecutionStores.journal,
      controlInbox:
        options.controlInbox ??
        new WorkerControlService({
          store: new LocalFileWorkerControlInboxStore({
            rootDir: options.stateRootDir,
          }),
          ...(options.clock ? { clock: options.clock } : {}),
        }),
      ...(options.activeAttemptRegistry === undefined
        ? {}
        : { activeAttemptRegistry: options.activeAttemptRegistry }),
      snapshotter: options.snapshotter ?? new DefaultWorkspaceSnapshotter(),
      workspaceAccess:
        options.workspaceAccess ?? new NodeSafeExecutionWorkspaceAccess(),
      runtime: options.runtime ?? new NodeSafeExecutionRuntime(),
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
    // Provider setup is not a task attempt. A prewarm failure must surface once
    // instead of consuming the account-rotation retry budget.
    if (this.options.prewarmOnStart) await this.start();
    const {
      job,
      jobId,
      taskId,
      originalPrompt,
      effectMode,
      staleLockMs,
      maxAccountCycles,
      policy,
    } = codexSafeExecutionInput(input);
    return this.runner.run({
      taskId,
      workspace: {
        mode: "existing_locked",
        path: this.options.workspacePath,
        ...(staleLockMs === undefined ? {} : { staleLockMs }),
        ...(this.options.requireGitWorkspace === false
          ? {}
          : { requireGitWorkspace: true }),
      },
      effectMode:
        effectMode ??
        this.options.effectMode ??
        codexEffectModeFromJobControls(job),
      provider: "codex",
      pool: {
        run: async (runJob, runOptions) => {
          await this.start();
          return this.pool.run(runJob, runOptions);
        },
      },
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
      continuationJobFactory: ({
        job: previousJob,
        continuationPacket,
        attemptNumber,
      }) => ({
        ...previousJob,
        runId: `${taskId}:attempt-${attemptNumber}`,
        prompt: continuationPacket.message,
      }),
      controlContinuationJobFactory: ({
        job: currentJob,
        originalPrompt: currentOriginalPrompt,
        controlBatch,
        attemptNumber,
        previousFailureDetails,
      }) => {
        const replaceRejectedPrompt = isCodexProviderContentPolicyRejection(
          previousFailureDetails,
        );
        const prompt = codexStartupControlPrompt({
          originalPrompt: currentOriginalPrompt,
          controlBatch,
          replaceRejectedPrompt,
        });
        return {
          job: {
            ...currentJob,
            runId: `${taskId}:attempt-${attemptNumber}`,
            prompt,
            ...(replaceRejectedPrompt
              ? {
                  metadata: {
                    ...currentJob.metadata,
                    codexGoalObjective: REPLACEMENT_GOAL_OBJECTIVE,
                  },
                }
              : {}),
          },
          ...(replaceRejectedPrompt
            ? {
                replaceContinuationContext: {
                  originalPrompt: prompt,
                  resetPreviousOutputSummary: true,
                },
              }
            : { originalPrompt: prompt }),
        };
      },
      summarizeResult: (result) => result.outputText,
      summarizeErrorOutput: codexWorkerErrorOutputSummary,
      attemptUsage: codexWorkerResultUsage,
      controlTarget: codexControlTarget({
        jobId,
        taskId,
        workspacePath: this.options.workspacePath,
      }),
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
    await assertUniqueCodexAccountIdentities(this.options);
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

    const reconnectRetry = available.find(
      (slot) => slot.capacity.reason === "reconnect_retry_pending",
    );
    if (reconnectRetry) return reconnectRetry;

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

function codexWorkerResultUsage(
  result: FileBackendCodexWorkerResult,
): AttemptUsage | undefined {
  const usage = result.usage;
  if (!usage) return undefined;
  return {
    ...(usage.inputTokens === undefined
      ? {}
      : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined
      ? {}
      : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined
      ? {}
      : { totalTokens: usage.totalTokens }),
  };
}

function codexWorkerErrorOutputSummary(error: unknown): string | undefined {
  for (const item of errorCauseChain(error)) {
    if (!(item instanceof SubscriptionWorkerError)) continue;
    const lastOutputTail = item.details.lastOutputTail?.trim();
    if (lastOutputTail) {
      return `Last Codex output before slice boundary:\n${lastOutputTail}`;
    }
  }
  return undefined;
}

function errorCauseChain(error: unknown): readonly unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current =
      current instanceof Error
        ? (current as Error & { cause?: unknown }).cause
        : undefined;
  }
  return chain;
}

function codexSafeExecutionInput(input: FileBackendCodexSafeExecutorRunInput): {
  readonly jobId?: string;
  readonly taskId: string;
  readonly job: FileBackendCodexWorkerJob;
  readonly originalPrompt: string;
  readonly effectMode?: TaskEffectMode;
  readonly staleLockMs?: number;
  readonly maxAccountCycles?: number;
  readonly policy?: SafeExecutionPolicy;
} {
  const {
    jobId,
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
    ...(jobId === undefined ? {} : { jobId }),
    taskId,
    job,
    originalPrompt: originalPrompt ?? job.prompt,
    ...(effectMode === undefined ? {} : { effectMode }),
    ...(staleLockMs === undefined ? {} : { staleLockMs }),
    ...(maxAccountCycles === undefined ? {} : { maxAccountCycles }),
    ...(safeExecutionPolicy === undefined
      ? {}
      : { policy: safeExecutionPolicy }),
  };
}

export function codexStartupControlPrompt(input: {
  readonly originalPrompt: string;
  readonly controlBatch: WorkerControlContinuationBatch;
  readonly replaceRejectedPrompt?: boolean;
}): string {
  if (
    !input.controlBatch.message ||
    input.controlBatch.signalIds.length === 0
  ) {
    return input.originalPrompt;
  }
  if (input.replaceRejectedPrompt) {
    return [
      "Continue the same authorized task in the current workspace.",
      "",
      "The previous provider input was rejected by content policy before a usable result.",
      "Use the broker-delivered guidance below as replacement task wording. Do not repeat or reconstruct the rejected wording.",
      "",
      input.controlBatch.message,
      "",
      "Apply the delivered runtime guidance now. Preserve useful existing work and do not restart from scratch.",
    ].join("\n");
  }
  return [
    "Continue the same task in the current workspace.",
    "",
    "Original task:",
    input.originalPrompt,
    "",
    input.controlBatch.message,
    "",
    "Apply the delivered runtime guidance now. Preserve useful existing work and do not restart from scratch.",
  ].join("\n");
}

export function isCodexProviderContentPolicyRejection(
  details: Readonly<Record<string, string>> | undefined,
): boolean {
  const rawCause = details?.rawCause?.toLowerCase();
  return Boolean(
    rawCause?.includes("codex_app_server_error:") &&
    rawCause.includes("content was flagged") &&
    rawCause.includes("cybersecurity"),
  );
}

function codexControlTarget(input: {
  readonly jobId: string | undefined;
  readonly taskId: string;
  readonly workspacePath: string;
}): WorkerControlTarget {
  return {
    jobId: input.jobId ?? input.taskId,
    taskId: input.taskId,
    workspaceId: input.workspacePath,
  };
}

function codexEffectModeFromJobControls(
  job: FileBackendCodexWorkerJob,
): TaskEffectMode {
  return job.controls?.editMode === "allow-edits"
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
    retryUnknownCleanWorkspace: false,
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
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new Error("file_backend_codex_safe_max_account_cycles_invalid");
  }
}

async function assertUniqueCodexAccountIdentities(
  options: FileBackendCodexSafeExecutorOptions,
): Promise<void> {
  if (options.allowDuplicateAccountIdentities) return;

  const identities = (
    await Promise.all(
      options.accounts.map(async (account, index) =>
        codexAccountIdentityFromSafeExecutorAccount(account, index),
      ),
    )
  ).filter((identity): identity is CodexAccountIdentity => identity !== null);

  const byKey = new Map<string, CodexAccountIdentity[]>();
  for (const identity of identities) {
    const existing = byKey.get(identity.key);
    if (existing) {
      existing.push(identity);
    } else {
      byKey.set(identity.key, [identity]);
    }
  }

  const duplicateGroups = [...byKey.values()].filter(
    (group) => group.length > 1,
  );
  if (duplicateGroups.length === 0) return;

  const firstGroup = duplicateGroups[0]!;
  const duplicateLabels = firstGroup
    .map((identity) => identity.label)
    .join(",");
  throw new SubscriptionWorkerError(
    "subscription_worker_start_failed",
    `Duplicate Codex account identity across safe executor accounts: ${duplicateLabels}. Re-login duplicate slots with different accounts or remove them from the pool.`,
    {
      details: {
        code: "file_backend_codex_duplicate_account_identity",
        accounts: duplicateLabels,
        identityHash: firstGroup[0]!.hash,
        identitySource: firstGroup[0]!.source,
      },
    },
  );
}

async function codexAccountIdentityFromSafeExecutorAccount(
  account: FileBackendCodexSafeExecutorAccount,
  index: number,
): Promise<CodexAccountIdentity | null> {
  const authJson = await readSafeExecutorAccountAuthJson(account);
  if (!authJson) return null;
  try {
    return codexAccountIdentityFromAuthJson({
      authJson,
      label: safeExecutorAccountLabel(account, index),
    });
  } catch {
    return null;
  }
}

async function readSafeExecutorAccountAuthJson(
  account: FileBackendCodexSafeExecutorAccount,
): Promise<string | null> {
  if (account.codexAuthJson !== undefined) return account.codexAuthJson;
  if (account.codexAuthJsonPath !== undefined) {
    return readFile(account.codexAuthJsonPath, "utf8");
  }
  return null;
}

function safeExecutorAccountLabel(
  account: FileBackendCodexSafeExecutorAccount,
  index: number,
): string {
  return (
    account.worker.capacityAccountId?.trim() ||
    account.worker.providerInstanceId.trim() ||
    `slot-${index + 1}`
  );
}

function codexAccountIdentityFromAuthJson(input: {
  readonly authJson: string;
  readonly label: string;
}): CodexAccountIdentity {
  const validation = validateCodexAuthJsonBytes({
    authJsonBytes: input.authJson,
  });
  const identity = resolveCodexAccountIdentity(validation.parsed);
  return {
    label: input.label,
    key: identity.key,
    hash: hashText(identity.key).slice(0, 16),
    source: identity.source,
  };
}

function resolveCodexAccountIdentity(authJson: ValidatedCodexAuthJson): {
  readonly key: string;
  readonly source: string;
} {
  const directAccountId = firstNonEmptyString(
    authJson.tokens.account_id,
    authJson.tokens.chatgpt_account_id,
    authJson.account_id,
    authJson.chatgpt_account_id,
  );
  if (directAccountId) {
    return {
      key: `account:${directAccountId.toLowerCase()}`,
      source: "auth_json_account_id",
    };
  }

  const idTokenClaims = decodeJwtClaims(authJson.tokens.id_token);
  if (idTokenClaims) {
    const authNamespace = objectClaim(
      idTokenClaims["https://api.openai.com/auth"],
    );
    const accountId = firstNonEmptyString(
      idTokenClaims["https://api.openai.com/auth.chatgpt_account_id"],
      idTokenClaims["chatgpt_account_id"],
      idTokenClaims["account_id"],
      authNamespace?.chatgpt_account_id,
      authNamespace?.account_id,
      idTokenClaims["sub"],
    );
    if (accountId) {
      return {
        key: `account:${accountId.toLowerCase()}`,
        source: "id_token_account_id",
      };
    }

    const email = firstNonEmptyString(
      idTokenClaims["https://api.openai.com/profile.email"],
      idTokenClaims["email"],
      authNamespace?.email,
    );
    if (email) {
      return {
        key: `email:${email.toLowerCase()}`,
        source: "id_token_email",
      };
    }
  }

  return {
    key: `refresh:${hashText(authJson.tokens.refresh_token)}`,
    source: "refresh_token_hash",
  };
}

function decodeJwtClaims(
  token: string | undefined,
): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split(".");
  const payload = parts[1];
  if (!payload) return null;
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function objectClaim(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function firstNonEmptyString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
