import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isSubscriptionWorkerError } from "./errors";
import type { WorkerPoolRunOptions } from "./types";

const execFileAsync = promisify(execFile);

export type TaskRunId = string;
export type WorkspaceRunId = string;

export type TaskEffectMode =
  | "read_only"
  | "workspace_patch"
  | "external_side_effects";

export type ExistingLockedWorkspaceStrategy = {
  readonly mode: "existing_locked";
  readonly path: string;
  readonly staleLockMs?: number;
};

export type WorkspaceStrategy = ExistingLockedWorkspaceStrategy;

export type ContinuationMode = "packet_first" | "disabled";

export type SafeExecutionPolicy = {
  readonly retryOnCapacity?: boolean;
  readonly retryOnAccountUnavailable?: boolean;
  readonly retryOnReconnectRequired?: boolean;
  readonly retryUnknownCleanWorkspace?: boolean;
  readonly maxAttempts?: number;
  readonly continuationMode?: ContinuationMode;
};

export type AttemptFailureReason =
  | "quota_limited"
  | "capacity_unavailable"
  | "account_unavailable"
  | "reconnect_required"
  | "permission_required"
  | "user_abort"
  | "unknown_error";

export type AttemptStatus = "running" | "completed" | "blocked" | "failed";

export type SafeExecutionTaskStatus =
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "aborted";

export type WorkspaceSnapshotMode = "git" | "filesystem" | "unavailable";

export type WorkspaceSnapshot = {
  readonly mode: WorkspaceSnapshotMode;
  readonly workspacePath: string;
  readonly capturedAt: Date;
  readonly dirty: boolean;
  readonly changedFiles: readonly string[];
  readonly fingerprint: string;
  readonly summary: string;
  readonly diffStat?: string;
  readonly shortDiff?: string;
  readonly truncated?: boolean;
  readonly warnings?: readonly string[];
};

export type AttemptRecord = {
  readonly taskId: TaskRunId;
  readonly attemptNumber: number;
  readonly workerId?: string;
  readonly accountId?: string;
  readonly provider: string;
  readonly startedAt: Date;
  readonly finishedAt?: Date;
  readonly status: AttemptStatus;
  readonly failureReason?: AttemptFailureReason;
  readonly failureMessage?: string;
  readonly workspaceDirtyBefore: boolean;
  readonly workspaceDirtyAfter?: boolean;
  readonly changedFiles: readonly string[];
  readonly lastOutputSummary?: string;
};

export type ContinuationPacket = {
  readonly taskId: TaskRunId;
  readonly attemptNumber: number;
  readonly provider: string;
  readonly workspacePath: string;
  readonly originalPrompt: string;
  readonly previousFailureReason: AttemptFailureReason;
  readonly changedFiles: readonly string[];
  readonly workspaceSummary: string;
  readonly previousOutputSummary?: string;
  readonly message: string;
};

export type SafeExecutionTaskRecord = {
  readonly taskId: TaskRunId;
  readonly workspaceRunId: WorkspaceRunId;
  readonly workspacePath: string;
  readonly effectMode: TaskEffectMode;
  readonly provider: string;
  readonly status: SafeExecutionTaskStatus;
  readonly startedAt: Date;
  readonly updatedAt: Date;
  readonly attempts: readonly AttemptRecord[];
  readonly completedAt?: Date;
  readonly result?: unknown;
  readonly outputSummary?: string;
  readonly lastFailureReason?: AttemptFailureReason;
  readonly lastFailureMessage?: string;
};

export type WorkspaceLockRecord = {
  readonly taskId: TaskRunId;
  readonly workspacePath: string;
  readonly ownerId: string;
  readonly ownerPid?: number;
  readonly acquiredAt: Date;
  readonly staleLockMs?: number;
};

export type WorkspaceLockHandle = WorkspaceLockRecord & {
  release(): Promise<void>;
};

export interface WorkspaceLockStore {
  acquire(input: {
    readonly taskId: TaskRunId;
    readonly workspacePath: string;
    readonly ownerId: string;
    readonly ownerPid?: number;
    readonly staleLockMs?: number;
    readonly now?: Date;
  }): Promise<WorkspaceLockHandle>;
}

export interface AttemptJournal {
  readTask(input: { readonly taskId: TaskRunId }): Promise<SafeExecutionTaskRecord | null>;
  startTask(input: {
    readonly taskId: TaskRunId;
    readonly workspaceRunId: WorkspaceRunId;
    readonly workspacePath: string;
    readonly effectMode: TaskEffectMode;
    readonly provider: string;
    readonly now: Date;
  }): Promise<SafeExecutionTaskRecord>;
  appendAttempt(input: {
    readonly taskId: TaskRunId;
    readonly attempt: AttemptRecord;
    readonly now: Date;
  }): Promise<SafeExecutionTaskRecord>;
  completeTask(input: {
    readonly taskId: TaskRunId;
    readonly result: unknown;
    readonly outputSummary?: string;
    readonly now: Date;
  }): Promise<SafeExecutionTaskRecord>;
  markPartial(input: {
    readonly taskId: TaskRunId;
    readonly status: Exclude<SafeExecutionTaskStatus, "running" | "completed">;
    readonly reason: AttemptFailureReason;
    readonly message?: string;
    readonly now: Date;
  }): Promise<SafeExecutionTaskRecord>;
}

export interface WorkspaceSnapshotter {
  capture(input: {
    readonly workspacePath: string;
    readonly includeDiff?: boolean;
    readonly abortSignal?: AbortSignal;
  }): Promise<WorkspaceSnapshot>;
}

export interface ContinuationPacketBuilder {
  build(input: {
    readonly taskId: TaskRunId;
    readonly attemptNumber: number;
    readonly provider: string;
    readonly workspacePath: string;
    readonly originalPrompt: string;
    readonly previousFailureReason: AttemptFailureReason;
    readonly snapshot: WorkspaceSnapshot;
    readonly previousOutputSummary?: string;
  }): ContinuationPacket;
}

export type SafeExecutionErrorCode =
  | "safe_execution_invalid_task"
  | "safe_execution_workspace_locked"
  | "safe_execution_external_retry_disabled"
  | "safe_execution_continuation_disabled"
  | "safe_execution_attempts_exhausted";

export class SafeExecutionError extends Error {
  constructor(
    readonly code: SafeExecutionErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly details?: Readonly<Record<string, string>>;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SafeExecutionError";
    this.details = options.details ?? {};
  }

  readonly details: Readonly<Record<string, string>>;
}

export function isSafeExecutionError(
  error: unknown,
): error is SafeExecutionError {
  return error instanceof SafeExecutionError;
}

export type SafeExecutionFailureClassification = {
  readonly reason: AttemptFailureReason;
  readonly safeMessage: string;
  readonly retryable: boolean;
};

export type SafeExecutionWorkerPool<Job, Result> = {
  run(job: Job, options?: WorkerPoolRunOptions): Promise<Result>;
};

export type SafeExecutionRunInput<Job, Result> = {
  readonly taskId: TaskRunId;
  readonly workspace: WorkspaceStrategy;
  readonly effectMode: TaskEffectMode;
  readonly provider: string;
  readonly pool: SafeExecutionWorkerPool<Job, Result>;
  readonly job: Job;
  readonly originalPrompt: string;
  readonly continuationMode?: ContinuationMode;
  readonly policy?: SafeExecutionPolicy;
  readonly continuationJobFactory?: (input: {
    readonly job: Job;
    readonly continuationPacket: ContinuationPacket;
    readonly attemptNumber: number;
  }) => Job;
  readonly attemptMetadata?: (input: {
    readonly result?: Result;
    readonly error?: unknown;
  }) => {
    readonly workerId?: string;
    readonly accountId?: string;
  };
  readonly classifyError?: (
    error: unknown,
  ) => SafeExecutionFailureClassification;
  readonly summarizeResult?: (result: Result) => string | undefined;
  readonly summarizeError?: (error: unknown) => string | undefined;
  readonly abortSignal?: AbortSignal;
};

export type SafeExecutionRunResult<Result> =
  | {
      readonly status: "completed";
      readonly task: SafeExecutionTaskRecord;
      readonly result: Result;
      readonly attempts: readonly AttemptRecord[];
      readonly replayed: boolean;
    }
  | {
      readonly status: "partial" | "failed" | "aborted";
      readonly task: SafeExecutionTaskRecord;
      readonly attempts: readonly AttemptRecord[];
      readonly reason: AttemptFailureReason;
      readonly safeMessage: string;
      readonly error?: unknown;
    };

export type SafeExecutionRunnerOptions = {
  readonly lockStore: WorkspaceLockStore;
  readonly journal: AttemptJournal;
  readonly snapshotter?: WorkspaceSnapshotter;
  readonly continuationPacketBuilder?: ContinuationPacketBuilder;
  readonly ownerId?: string;
  readonly ownerPid?: number;
  readonly clock?: { now(): Date };
};

export class InMemoryWorkspaceLockStore implements WorkspaceLockStore {
  private readonly locks = new Map<string, WorkspaceLockRecord>();

  async acquire(input: {
    readonly taskId: TaskRunId;
    readonly workspacePath: string;
    readonly ownerId: string;
    readonly ownerPid?: number;
    readonly staleLockMs?: number;
    readonly now?: Date;
  }): Promise<WorkspaceLockHandle> {
    const workspacePath = await canonicalWorkspacePath(input.workspacePath);
    const key = workspaceLockKey(workspacePath);
    const now = input.now ?? new Date();
    const existing = this.locks.get(key);
    if (existing && !canReplaceLock(existing, now)) {
      throw workspaceLockedError(existing);
    }
    const record: WorkspaceLockRecord = {
      taskId: input.taskId,
      workspacePath,
      ownerId: input.ownerId,
      ...(input.ownerPid === undefined ? {} : { ownerPid: input.ownerPid }),
      acquiredAt: now,
      ...(input.staleLockMs === undefined ? {} : { staleLockMs: input.staleLockMs }),
    };
    this.locks.set(key, record);
    return {
      ...record,
      release: async () => {
        const current = this.locks.get(key);
        if (current?.ownerId === record.ownerId && current.taskId === record.taskId) {
          this.locks.delete(key);
        }
      },
    };
  }
}

export class LocalFileWorkspaceLockStore implements WorkspaceLockStore {
  constructor(private readonly rootDir: string) {}

  async acquire(input: {
    readonly taskId: TaskRunId;
    readonly workspacePath: string;
    readonly ownerId: string;
    readonly ownerPid?: number;
    readonly staleLockMs?: number;
    readonly now?: Date;
  }): Promise<WorkspaceLockHandle> {
    const workspacePath = await canonicalWorkspacePath(input.workspacePath);
    const key = workspaceLockKey(workspacePath);
    const lockDir = join(this.rootDir, "workspace-locks", key);
    const lockFile = join(lockDir, "lock.json");
    const now = input.now ?? new Date();
    await mkdir(dirname(lockDir), { recursive: true, mode: 0o700 });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await mkdir(lockDir, { mode: 0o700 });
        const record: WorkspaceLockRecord = {
          taskId: input.taskId,
          workspacePath,
          ownerId: input.ownerId,
          ...(input.ownerPid === undefined ? {} : { ownerPid: input.ownerPid }),
          acquiredAt: now,
          ...(input.staleLockMs === undefined
            ? {}
            : { staleLockMs: input.staleLockMs }),
        };
        await atomicWriteJson(lockFile, serializeLockRecord(record));
        return {
          ...record,
          release: async () => {
            await releaseFileLock(lockDir, lockFile, record);
          },
        };
      } catch (error) {
        if (!isNodeErrorCode(error, "EEXIST")) throw error;
        const existing = await readLockRecord(lockFile, workspacePath);
        if (existing && canReplaceLock(existing, now)) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
        throw workspaceLockedError(existing ?? {
          taskId: "unknown",
          workspacePath,
          ownerId: "unknown",
          acquiredAt: now,
        });
      }
    }

    throw new SafeExecutionError(
      "safe_execution_workspace_locked",
      "Workspace lock could not be acquired after stale cleanup.",
      { details: { workspacePath } },
    );
  }
}

export class InMemoryAttemptJournal implements AttemptJournal {
  private readonly records = new Map<string, SafeExecutionTaskRecord>();

  async readTask(input: {
    readonly taskId: TaskRunId;
  }): Promise<SafeExecutionTaskRecord | null> {
    return this.records.get(input.taskId) ?? null;
  }

  async startTask(input: {
    readonly taskId: TaskRunId;
    readonly workspaceRunId: WorkspaceRunId;
    readonly workspacePath: string;
    readonly effectMode: TaskEffectMode;
    readonly provider: string;
    readonly now: Date;
  }): Promise<SafeExecutionTaskRecord> {
    const existing = this.records.get(input.taskId);
    if (existing) {
      const next = {
        ...existing,
        status: existing.status === "completed" ? existing.status : "running",
        updatedAt: input.now,
      } satisfies SafeExecutionTaskRecord;
      this.records.set(input.taskId, next);
      return next;
    }
    const record: SafeExecutionTaskRecord = {
      taskId: input.taskId,
      workspaceRunId: input.workspaceRunId,
      workspacePath: input.workspacePath,
      effectMode: input.effectMode,
      provider: input.provider,
      status: "running",
      startedAt: input.now,
      updatedAt: input.now,
      attempts: [],
    };
    this.records.set(input.taskId, record);
    return record;
  }

  async appendAttempt(input: {
    readonly taskId: TaskRunId;
    readonly attempt: AttemptRecord;
    readonly now: Date;
  }): Promise<SafeExecutionTaskRecord> {
    const record = requireTaskRecord(this.records.get(input.taskId), input.taskId);
    const next: SafeExecutionTaskRecord = {
      ...record,
      status: "running",
      updatedAt: input.now,
      attempts: [...record.attempts, input.attempt],
      ...(input.attempt.failureReason
        ? {
            lastFailureReason: input.attempt.failureReason,
            lastFailureMessage: input.attempt.failureMessage,
          }
        : {}),
    };
    this.records.set(input.taskId, next);
    return next;
  }

  async completeTask(input: {
    readonly taskId: TaskRunId;
    readonly result: unknown;
    readonly outputSummary?: string;
    readonly now: Date;
  }): Promise<SafeExecutionTaskRecord> {
    const record = requireTaskRecord(this.records.get(input.taskId), input.taskId);
    const next: SafeExecutionTaskRecord = {
      ...record,
      status: "completed",
      updatedAt: input.now,
      completedAt: input.now,
      result: input.result,
      ...(input.outputSummary === undefined
        ? {}
        : { outputSummary: input.outputSummary }),
    };
    this.records.set(input.taskId, next);
    return next;
  }

  async markPartial(input: {
    readonly taskId: TaskRunId;
    readonly status: Exclude<SafeExecutionTaskStatus, "running" | "completed">;
    readonly reason: AttemptFailureReason;
    readonly message?: string;
    readonly now: Date;
  }): Promise<SafeExecutionTaskRecord> {
    const record = requireTaskRecord(this.records.get(input.taskId), input.taskId);
    const next: SafeExecutionTaskRecord = {
      ...record,
      status: input.status,
      updatedAt: input.now,
      lastFailureReason: input.reason,
      ...(input.message === undefined ? {} : { lastFailureMessage: input.message }),
    };
    this.records.set(input.taskId, next);
    return next;
  }
}

export class LocalFileAttemptJournal implements AttemptJournal {
  constructor(private readonly rootDir: string) {}

  async readTask(input: {
    readonly taskId: TaskRunId;
  }): Promise<SafeExecutionTaskRecord | null> {
    try {
      return parseTaskRecord(
        await readFile(this.taskPath(input.taskId), "utf8"),
      );
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  async startTask(input: {
    readonly taskId: TaskRunId;
    readonly workspaceRunId: WorkspaceRunId;
    readonly workspacePath: string;
    readonly effectMode: TaskEffectMode;
    readonly provider: string;
    readonly now: Date;
  }): Promise<SafeExecutionTaskRecord> {
    const existing = await this.readTask({ taskId: input.taskId });
    const record: SafeExecutionTaskRecord = existing
      ? {
          ...existing,
          status: existing.status === "completed" ? existing.status : "running",
          updatedAt: input.now,
        }
      : {
          taskId: input.taskId,
          workspaceRunId: input.workspaceRunId,
          workspacePath: input.workspacePath,
          effectMode: input.effectMode,
          provider: input.provider,
          status: "running",
          startedAt: input.now,
          updatedAt: input.now,
          attempts: [],
        };
    await this.writeTask(record);
    return record;
  }

  async appendAttempt(input: {
    readonly taskId: TaskRunId;
    readonly attempt: AttemptRecord;
    readonly now: Date;
  }): Promise<SafeExecutionTaskRecord> {
    const record = requireTaskRecord(
      await this.readTask({ taskId: input.taskId }),
      input.taskId,
    );
    const next: SafeExecutionTaskRecord = {
      ...record,
      status: "running",
      updatedAt: input.now,
      attempts: [...record.attempts, input.attempt],
      ...(input.attempt.failureReason
        ? {
            lastFailureReason: input.attempt.failureReason,
            lastFailureMessage: input.attempt.failureMessage,
          }
        : {}),
    };
    await this.writeTask(next);
    return next;
  }

  async completeTask(input: {
    readonly taskId: TaskRunId;
    readonly result: unknown;
    readonly outputSummary?: string;
    readonly now: Date;
  }): Promise<SafeExecutionTaskRecord> {
    const record = requireTaskRecord(
      await this.readTask({ taskId: input.taskId }),
      input.taskId,
    );
    const next: SafeExecutionTaskRecord = {
      ...record,
      status: "completed",
      updatedAt: input.now,
      completedAt: input.now,
      result: input.result,
      ...(input.outputSummary === undefined
        ? {}
        : { outputSummary: input.outputSummary }),
    };
    await this.writeTask(next);
    return next;
  }

  async markPartial(input: {
    readonly taskId: TaskRunId;
    readonly status: Exclude<SafeExecutionTaskStatus, "running" | "completed">;
    readonly reason: AttemptFailureReason;
    readonly message?: string;
    readonly now: Date;
  }): Promise<SafeExecutionTaskRecord> {
    const record = requireTaskRecord(
      await this.readTask({ taskId: input.taskId }),
      input.taskId,
    );
    const next: SafeExecutionTaskRecord = {
      ...record,
      status: input.status,
      updatedAt: input.now,
      lastFailureReason: input.reason,
      ...(input.message === undefined ? {} : { lastFailureMessage: input.message }),
    };
    await this.writeTask(next);
    return next;
  }

  private taskPath(taskId: TaskRunId): string {
    return join(this.rootDir, "attempt-journal", `${hashText(taskId)}.json`);
  }

  private async writeTask(record: SafeExecutionTaskRecord): Promise<void> {
    const path = this.taskPath(record.taskId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await atomicWriteJson(path, serializeTaskRecord(record));
  }
}

export type DefaultWorkspaceSnapshotterOptions = {
  readonly gitBinaryPath?: string;
  readonly commandTimeoutMs?: number;
  readonly maxDiffBytes?: number;
  readonly maxFilesystemEntries?: number;
  readonly ignoredDirectories?: readonly string[];
};

export class DefaultWorkspaceSnapshotter implements WorkspaceSnapshotter {
  private readonly gitBinaryPath: string;
  private readonly commandTimeoutMs: number;
  private readonly maxDiffBytes: number;
  private readonly maxFilesystemEntries: number;
  private readonly ignoredDirectories: readonly string[];

  constructor(options: DefaultWorkspaceSnapshotterOptions = {}) {
    this.gitBinaryPath = options.gitBinaryPath ?? "git";
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5_000;
    this.maxDiffBytes = options.maxDiffBytes ?? 24_000;
    this.maxFilesystemEntries = options.maxFilesystemEntries ?? 2_000;
    this.ignoredDirectories = options.ignoredDirectories ?? [
      ".git",
      "node_modules",
      "dist",
      ".next",
      ".turbo",
      "coverage",
    ];
  }

  async capture(input: {
    readonly workspacePath: string;
    readonly includeDiff?: boolean;
    readonly abortSignal?: AbortSignal;
  }): Promise<WorkspaceSnapshot> {
    const workspacePath = await canonicalWorkspacePath(input.workspacePath);
    const capturedAt = new Date();
    if (await this.isGitWorkspace(workspacePath)) {
      return this.captureGit({ ...input, workspacePath, capturedAt });
    }
    return this.captureFilesystem({ ...input, workspacePath, capturedAt });
  }

  private async captureGit(input: {
    readonly workspacePath: string;
    readonly includeDiff?: boolean;
    readonly abortSignal?: AbortSignal;
    readonly capturedAt: Date;
  }): Promise<WorkspaceSnapshot> {
    const status = await this.git(input.workspacePath, [
      "status",
      "--porcelain",
    ]);
    const statusLines = status.stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);
    const changedFiles = mergeChangedFiles(
      gitStatusChangedFiles(statusLines),
      await this.gitDiffNameOnly(input.workspacePath),
    );
    const diffStat = await this.git(input.workspacePath, [
      "diff",
      "--stat",
      "--no-ext-diff",
    ]).then(
      (result) => result.stdout.trim(),
      () => "",
    );
    const shortDiff = input.includeDiff
      ? await this.shortGitDiff(input.workspacePath)
      : undefined;
    return {
      mode: "git",
      workspacePath: input.workspacePath,
      capturedAt: input.capturedAt,
      dirty: changedFiles.length > 0,
      changedFiles,
      fingerprint: hashText(statusLines.join("\n")),
      summary: statusLines.length === 0
        ? "Git workspace is clean."
        : `Git workspace has ${statusLines.length} changed status entries.`,
      ...(diffStat ? { diffStat } : {}),
      ...(shortDiff === undefined ? {} : { shortDiff: shortDiff.value }),
      ...(shortDiff?.truncated ? { truncated: true } : {}),
    };
  }

  private async captureFilesystem(input: {
    readonly workspacePath: string;
    readonly capturedAt: Date;
  }): Promise<WorkspaceSnapshot> {
    const files = await this.scanFilesystem(input.workspacePath);
    return {
      mode: "filesystem",
      workspacePath: input.workspacePath,
      capturedAt: input.capturedAt,
      dirty: false,
      changedFiles: files.map((file) => file.path),
      fingerprint: hashText(
        files.map((file) => `${file.path}:${file.size}:${file.mtimeMs}`).join("\n"),
      ),
      summary: `Filesystem snapshot captured ${files.length} entries.`,
      ...(files.length >= this.maxFilesystemEntries
        ? {
            truncated: true,
            warnings: ["filesystem_snapshot_entry_limit_reached"],
          }
        : {}),
    };
  }

  private async isGitWorkspace(workspacePath: string): Promise<boolean> {
    const result = await this.git(workspacePath, [
      "rev-parse",
      "--is-inside-work-tree",
    ]).catch(() => null);
    return result?.stdout.trim() === "true";
  }

  private async git(
    cwd: string,
    args: readonly string[],
  ): Promise<{ readonly stdout: string; readonly stderr: string }> {
    const result = await execFileAsync(this.gitBinaryPath, [...args], {
      cwd,
      timeout: this.commandTimeoutMs,
      maxBuffer: Math.max(1024 * 1024, this.maxDiffBytes * 2),
    });
    return {
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  }

  private async shortGitDiff(
    workspacePath: string,
  ): Promise<{ readonly value: string; readonly truncated: boolean }> {
    const result = await this.git(workspacePath, [
      "diff",
      "--no-ext-diff",
      "--",
    ]).catch(() => ({ stdout: "", stderr: "" }));
    const value = result.stdout;
    if (value.length <= this.maxDiffBytes) {
      return { value, truncated: false };
    }
    return {
      value: value.slice(0, this.maxDiffBytes),
      truncated: true,
    };
  }

  private async gitDiffNameOnly(workspacePath: string): Promise<readonly string[]> {
    const result = await this.git(workspacePath, [
      "diff",
      "--name-only",
      "--no-ext-diff",
      "--",
    ]).catch(() => ({ stdout: "", stderr: "" }));
    return result.stdout
      .split("\n")
      .map((line) => normalizeRelativePath(line.trim()))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
  }

  private async scanFilesystem(
    workspacePath: string,
  ): Promise<readonly { readonly path: string; readonly size: number; readonly mtimeMs: number }[]> {
    const files: { path: string; size: number; mtimeMs: number }[] = [];
    const visit = async (dir: string): Promise<void> => {
      if (files.length >= this.maxFilesystemEntries) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (files.length >= this.maxFilesystemEntries) return;
        if (entry.isSymbolicLink()) continue;
        const fullPath = join(dir, entry.name);
        const rel = normalizeRelativePath(relative(workspacePath, fullPath));
        if (entry.isDirectory()) {
          if (this.ignoredDirectories.includes(entry.name)) continue;
          await visit(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;
        const fileStat = await stat(fullPath).catch(() => null);
        if (!fileStat) continue;
        files.push({
          path: rel,
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
        });
      }
    };
    await visit(workspacePath);
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }
}

export class DefaultContinuationPacketBuilder
  implements ContinuationPacketBuilder
{
  build(input: {
    readonly taskId: TaskRunId;
    readonly attemptNumber: number;
    readonly provider: string;
    readonly workspacePath: string;
    readonly originalPrompt: string;
    readonly previousFailureReason: AttemptFailureReason;
    readonly snapshot: WorkspaceSnapshot;
    readonly previousOutputSummary?: string;
  }): ContinuationPacket {
    const changedFiles = input.snapshot.changedFiles;
    const filesText =
      changedFiles.length === 0
        ? "No changed files were detected."
        : changedFiles.slice(0, 80).map((file) => `- ${file}`).join("\n");
    const previousOutputText = input.previousOutputSummary
      ? `\nPrevious output summary:\n${input.previousOutputSummary}\n`
      : "";
    const diffStatText = input.snapshot.diffStat
      ? `\nDiff stat:\n${input.snapshot.diffStat}\n`
      : "";
    const message = [
      "Continue the same task in the current workspace.",
      "",
      `Task id: ${input.taskId}`,
      `Attempt: ${input.attemptNumber}`,
      `Provider: ${input.provider}`,
      `Workspace: ${input.workspacePath}`,
      `Previous attempt stopped because: ${input.previousFailureReason}`,
      "",
      "Original task:",
      input.originalPrompt,
      previousOutputText.trimEnd(),
      "",
      "Current workspace summary:",
      input.snapshot.summary,
      diffStatText.trimEnd(),
      "",
      "Changed files:",
      filesText,
      "",
      "Important instruction:",
      "Do not restart from scratch. Inspect the current workspace state and continue from the existing partial changes.",
    ]
      .filter((line) => line !== "")
      .join("\n");

    return {
      taskId: input.taskId,
      attemptNumber: input.attemptNumber,
      provider: input.provider,
      workspacePath: input.workspacePath,
      originalPrompt: input.originalPrompt,
      previousFailureReason: input.previousFailureReason,
      changedFiles,
      workspaceSummary: input.snapshot.summary,
      ...(input.previousOutputSummary === undefined
        ? {}
        : { previousOutputSummary: input.previousOutputSummary }),
      message,
    };
  }
}

export class SafeExecutionRunner {
  private readonly snapshotter: WorkspaceSnapshotter;
  private readonly continuationPacketBuilder: ContinuationPacketBuilder;
  private readonly ownerId: string;
  private readonly ownerPid: number;
  private readonly clock: { now(): Date };

  constructor(private readonly options: SafeExecutionRunnerOptions) {
    this.snapshotter = options.snapshotter ?? new DefaultWorkspaceSnapshotter();
    this.continuationPacketBuilder =
      options.continuationPacketBuilder ?? new DefaultContinuationPacketBuilder();
    this.ownerId = options.ownerId ?? `safe-execution:${randomUUID()}`;
    this.ownerPid = options.ownerPid ?? process.pid;
    this.clock = options.clock ?? systemClock;
  }

  async run<Job, Result>(
    input: SafeExecutionRunInput<Job, Result>,
  ): Promise<SafeExecutionRunResult<Result>> {
    validateRunInput(input);
    const workspacePath = await canonicalWorkspacePath(input.workspace.path);
    const existing = await this.options.journal.readTask({
      taskId: input.taskId,
    });
    if (existing?.status === "completed") {
      return {
        status: "completed",
        task: existing,
        result: existing.result as Result,
        attempts: existing.attempts,
        replayed: true,
      };
    }

    const lock = await this.options.lockStore.acquire({
      taskId: input.taskId,
      workspacePath,
      ownerId: this.ownerId,
      ownerPid: this.ownerPid,
      ...(input.workspace.staleLockMs === undefined
        ? {}
        : { staleLockMs: input.workspace.staleLockMs }),
      now: this.clock.now(),
    });

    try {
      let task = await this.options.journal.startTask({
        taskId: input.taskId,
        workspaceRunId: workspaceRunId(workspacePath),
        workspacePath,
        effectMode: input.effectMode,
        provider: input.provider,
        now: this.clock.now(),
      });
      if (task.status === "completed") {
        return {
          status: "completed",
          task,
          result: task.result as Result,
          attempts: task.attempts,
          replayed: true,
        };
      }

      const policy = normalizePolicy(input);
      let job = input.job;
      let previousOutputSummary = task.outputSummary;
      const firstAttemptNumber = task.attempts.length + 1;

      if (
        task.attempts.length > 0 &&
        task.lastFailureReason &&
        policy.continuationMode !== "disabled"
      ) {
        const snapshot = await this.snapshotter.capture({
          workspacePath,
          includeDiff: true,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        });
        const packet = this.continuationPacketBuilder.build({
          taskId: input.taskId,
          attemptNumber: firstAttemptNumber,
          provider: input.provider,
          workspacePath,
          originalPrompt: input.originalPrompt,
          previousFailureReason: task.lastFailureReason,
          snapshot,
          ...(previousOutputSummary === undefined
            ? {}
            : { previousOutputSummary }),
        });
        const continuationJob = continuationJobFor({
          factory: input.continuationJobFactory,
          job,
          continuationPacket: packet,
          attemptNumber: firstAttemptNumber,
        });
        if (!continuationJob) {
          const safeMessage =
            "Safe execution needs a prompt job or continuationJobFactory to resume a partial task.";
          const partial = await this.options.journal.markPartial({
            taskId: input.taskId,
            status: "partial",
            reason: task.lastFailureReason,
            message: safeMessage,
            now: this.clock.now(),
          });
          return {
            status: "partial",
            task: partial,
            attempts: partial.attempts,
            reason: task.lastFailureReason,
            safeMessage,
          };
        }
        job = continuationJob;
      }

      for (
        let attemptNumber = firstAttemptNumber;
        attemptNumber <= policy.maxAttempts;
        attemptNumber += 1
      ) {
        if (input.abortSignal?.aborted) {
          const aborted = await this.options.journal.markPartial({
            taskId: input.taskId,
            status: "aborted",
            reason: "user_abort",
            message: "Safe execution run was aborted before the next attempt.",
            now: this.clock.now(),
          });
          return {
            status: "aborted",
            task: aborted,
            attempts: aborted.attempts,
            reason: "user_abort",
            safeMessage: "Safe execution run was aborted.",
          };
        }

        const before = await this.snapshotter.capture({
          workspacePath,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        });
        const startedAt = this.clock.now();

        try {
          const result = await input.pool.run(job, {
            idempotencyKey: `${input.taskId}:${attemptNumber}`,
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
            retryPolicy: {
              maxAttempts: 1,
              retryOnSlotCapacityUnavailable: false,
            },
          });
          const after = await this.snapshotter.capture({
            workspacePath,
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          });
          previousOutputSummary = input.summarizeResult?.(result);
          const metadata = input.attemptMetadata?.({ result });
          const attempt = completeAttemptRecord({
            input,
            attemptNumber,
            startedAt,
            finishedAt: this.clock.now(),
            before,
            after,
            ...(metadata === undefined ? {} : { metadata }),
            ...(previousOutputSummary === undefined
              ? {}
              : { outputSummary: previousOutputSummary }),
          });
          task = await this.options.journal.appendAttempt({
            taskId: input.taskId,
            attempt,
            now: this.clock.now(),
          });
          task = await this.options.journal.completeTask({
            taskId: input.taskId,
            result,
            ...(previousOutputSummary === undefined
              ? {}
              : { outputSummary: previousOutputSummary }),
            now: this.clock.now(),
          });
          return {
            status: "completed",
            task,
            result,
            attempts: task.attempts,
            replayed: false,
          };
        } catch (error) {
          const after = await this.snapshotter.capture({
            workspacePath,
            includeDiff: true,
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          });
          const classification =
            input.classifyError?.(error) ??
            defaultSafeExecutionErrorClassifier(error);
          const failureMessage =
            input.summarizeError?.(error) ?? classification.safeMessage;
          const attempt = failedAttemptRecord({
            input,
            attemptNumber,
            startedAt,
            finishedAt: this.clock.now(),
            before,
            after,
            classification,
            failureMessage,
            metadata: input.attemptMetadata?.({ error }) ??
              attemptMetadataFromError(error),
          });
          task = await this.options.journal.appendAttempt({
            taskId: input.taskId,
            attempt,
            now: this.clock.now(),
          });

          const canContinue = shouldContinueAfterFailure({
            classification,
            policy,
            effectMode: input.effectMode,
            workspaceChanged: workspaceChanged(before, after),
            attemptsRemaining: attemptNumber < policy.maxAttempts,
          });

          if (!canContinue.allowed) {
            const status = finalStatusForFailure(classification.reason);
            task = await this.options.journal.markPartial({
              taskId: input.taskId,
              status,
              reason: classification.reason,
              message: canContinue.safeMessage ?? failureMessage,
              now: this.clock.now(),
            });
            return {
              status,
              task,
              attempts: task.attempts,
              reason: classification.reason,
              safeMessage: canContinue.safeMessage ?? failureMessage,
              error,
            };
          }

          const packet = this.continuationPacketBuilder.build({
            taskId: input.taskId,
            attemptNumber: attemptNumber + 1,
            provider: input.provider,
            workspacePath,
            originalPrompt: input.originalPrompt,
            previousFailureReason: classification.reason,
            snapshot: after,
            ...(previousOutputSummary === undefined
              ? {}
              : { previousOutputSummary }),
          });
          const continuationJob = continuationJobFor({
            factory: input.continuationJobFactory,
            job,
            continuationPacket: packet,
            attemptNumber: attemptNumber + 1,
          });
          if (!continuationJob) {
            const safeMessage =
              "Safe execution needs a prompt job or continuationJobFactory before retrying a partial workspace.";
            task = await this.options.journal.markPartial({
              taskId: input.taskId,
              status: "partial",
              reason: classification.reason,
              message: safeMessage,
              now: this.clock.now(),
            });
            return {
              status: "partial",
              task,
              attempts: task.attempts,
              reason: classification.reason,
              safeMessage,
              error,
            };
          }
          job = continuationJob;
        }
      }

      const exhausted = await this.options.journal.markPartial({
        taskId: input.taskId,
        status: "partial",
        reason: task.lastFailureReason ?? "unknown_error",
        message: "Safe execution exhausted all configured attempts.",
        now: this.clock.now(),
      });
      return {
        status: "partial",
        task: exhausted,
        attempts: exhausted.attempts,
        reason: exhausted.lastFailureReason ?? "unknown_error",
        safeMessage: "Safe execution exhausted all configured attempts.",
      };
    } finally {
      await lock.release();
    }
  }
}

export function promptContinuationJobFactory<Job extends { readonly prompt: string }>(
  input: {
    readonly job: Job;
    readonly continuationPacket: ContinuationPacket;
  },
): Job {
  return {
    ...input.job,
    prompt: input.continuationPacket.message,
  };
}

export function defaultSafeExecutionErrorClassifier(
  error: unknown,
): SafeExecutionFailureClassification {
  const chain = errorChain(error);
  for (const item of chain) {
    if (!isSubscriptionWorkerError(item)) continue;
    if (item.code === "subscription_worker_pool_run_aborted") {
      return {
        reason: "user_abort",
        safeMessage: item.message,
        retryable: false,
      };
    }
    if (item.code === "subscription_worker_pool_capacity_unavailable") {
      return {
        reason: "capacity_unavailable",
        safeMessage: item.message,
        retryable: true,
      };
    }
    if (item.code === "subscription_worker_account_unavailable") {
      return {
        reason: "account_unavailable",
        safeMessage: item.message,
        retryable: true,
      };
    }
    const reason = item.details.reason ?? item.details.code;
    if (reason === "quota_limited") {
      return {
        reason: "quota_limited",
        safeMessage: item.message,
        retryable: true,
      };
    }
    if (reason === "provider_reconnect_required") {
      return {
        reason: "reconnect_required",
        safeMessage: item.message,
        retryable: true,
      };
    }
    if (reason === "permission_required") {
      return {
        reason: "permission_required",
        safeMessage: item.message,
        retryable: false,
      };
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/abort/i.test(message)) {
    return {
      reason: "user_abort",
      safeMessage: message,
      retryable: false,
    };
  }
  if (/quota|rate limit|allowance/i.test(message)) {
    return {
      reason: "quota_limited",
      safeMessage: message,
      retryable: true,
    };
  }
  return {
    reason: "unknown_error",
    safeMessage: message,
    retryable: false,
  };
}

function validateRunInput<Job, Result>(
  input: SafeExecutionRunInput<Job, Result>,
): void {
  if (!input.taskId.trim()) {
    throw new SafeExecutionError(
      "safe_execution_invalid_task",
      "Safe execution taskId is required.",
    );
  }
  if (!input.workspace.path.trim()) {
    throw new SafeExecutionError(
      "safe_execution_invalid_task",
      "Safe execution workspace path is required.",
    );
  }
  if (!input.provider.trim()) {
    throw new SafeExecutionError(
      "safe_execution_invalid_task",
      "Safe execution provider is required.",
    );
  }
  if (
    input.effectMode === "external_side_effects" &&
    normalizePolicy(input).maxAttempts > 1
  ) {
    throw new SafeExecutionError(
      "safe_execution_external_retry_disabled",
      "Safe execution does not retry external side effects by default.",
    );
  }
}

function normalizePolicy<Job, Result>(
  input: SafeExecutionRunInput<Job, Result>,
): Required<SafeExecutionPolicy> {
  const policy = input.policy ?? {};
  return {
    retryOnCapacity: policy.retryOnCapacity ?? true,
    retryOnAccountUnavailable: policy.retryOnAccountUnavailable ?? true,
    retryOnReconnectRequired: policy.retryOnReconnectRequired ?? true,
    retryUnknownCleanWorkspace: policy.retryUnknownCleanWorkspace ?? true,
    maxAttempts: Math.max(1, policy.maxAttempts ?? 1),
    continuationMode:
      input.continuationMode ?? policy.continuationMode ?? "packet_first",
  };
}

function shouldContinueAfterFailure(input: {
  readonly classification: SafeExecutionFailureClassification;
  readonly policy: Required<SafeExecutionPolicy>;
  readonly effectMode: TaskEffectMode;
  readonly workspaceChanged: boolean;
  readonly attemptsRemaining: boolean;
}): { readonly allowed: boolean; readonly safeMessage?: string } {
  if (!input.attemptsRemaining) {
    return {
      allowed: false,
      safeMessage: "Safe execution has no attempts remaining.",
    };
  }
  if (input.policy.continuationMode === "disabled") {
    return {
      allowed: false,
      safeMessage: "Safe execution continuation is disabled.",
    };
  }
  if (input.effectMode === "external_side_effects") {
    return {
      allowed: false,
      safeMessage: "Safe execution will not retry external side effects.",
    };
  }
  switch (input.classification.reason) {
    case "quota_limited":
    case "capacity_unavailable":
      return { allowed: input.policy.retryOnCapacity };
    case "account_unavailable":
      return { allowed: input.policy.retryOnAccountUnavailable };
    case "reconnect_required":
      return { allowed: input.policy.retryOnReconnectRequired };
    case "unknown_error":
      return {
        allowed:
          !input.workspaceChanged && input.policy.retryUnknownCleanWorkspace,
        ...(input.workspaceChanged
          ? {
              safeMessage:
                "Safe execution stopped after an unknown error changed the workspace.",
            }
          : {}),
      };
    case "permission_required":
    case "user_abort":
      return { allowed: false };
  }
}

function continuationJobFor<Job>(input: {
  readonly factory:
    | SafeExecutionRunInput<Job, unknown>["continuationJobFactory"]
    | undefined;
  readonly job: Job;
  readonly continuationPacket: ContinuationPacket;
  readonly attemptNumber: number;
}): Job | null {
  if (input.factory) {
    return input.factory({
      job: input.job,
      continuationPacket: input.continuationPacket,
      attemptNumber: input.attemptNumber,
    });
  }
  if (
    typeof input.job === "object" &&
    input.job !== null &&
    "prompt" in input.job &&
    typeof input.job.prompt === "string"
  ) {
    return promptContinuationJobFactory({
      job: input.job as { readonly prompt: string },
      continuationPacket: input.continuationPacket,
    }) as Job;
  }
  return null;
}

function completeAttemptRecord<Job, Result>(input: {
  readonly input: SafeExecutionRunInput<Job, Result>;
  readonly attemptNumber: number;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly before: WorkspaceSnapshot;
  readonly after: WorkspaceSnapshot;
  readonly metadata?: {
    readonly workerId?: string;
    readonly accountId?: string;
  };
  readonly outputSummary?: string;
}): AttemptRecord {
  return {
    taskId: input.input.taskId,
    attemptNumber: input.attemptNumber,
    ...(input.metadata?.workerId === undefined
      ? {}
      : { workerId: input.metadata.workerId }),
    ...(input.metadata?.accountId === undefined
      ? {}
      : { accountId: input.metadata.accountId }),
    provider: input.input.provider,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status: "completed",
    workspaceDirtyBefore: input.before.dirty,
    workspaceDirtyAfter: input.after.dirty,
    changedFiles: changedFilesBetween(input.before, input.after),
    ...(input.outputSummary === undefined
      ? {}
      : { lastOutputSummary: input.outputSummary }),
  };
}

function failedAttemptRecord<Job, Result>(input: {
  readonly input: SafeExecutionRunInput<Job, Result>;
  readonly attemptNumber: number;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly before: WorkspaceSnapshot;
  readonly after: WorkspaceSnapshot;
  readonly classification: SafeExecutionFailureClassification;
  readonly failureMessage: string;
  readonly metadata?: {
    readonly workerId?: string;
    readonly accountId?: string;
  };
}): AttemptRecord {
  return {
    taskId: input.input.taskId,
    attemptNumber: input.attemptNumber,
    ...(input.metadata?.workerId === undefined
      ? {}
      : { workerId: input.metadata.workerId }),
    ...(input.metadata?.accountId === undefined
      ? {}
      : { accountId: input.metadata.accountId }),
    provider: input.input.provider,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status: input.classification.retryable ? "blocked" : "failed",
    failureReason: input.classification.reason,
    failureMessage: input.failureMessage,
    workspaceDirtyBefore: input.before.dirty,
    workspaceDirtyAfter: input.after.dirty,
    changedFiles: changedFilesBetween(input.before, input.after),
  };
}

function finalStatusForFailure(
  reason: AttemptFailureReason,
): Exclude<SafeExecutionTaskStatus, "running" | "completed"> {
  if (reason === "user_abort") return "aborted";
  if (reason === "unknown_error" || reason === "permission_required") {
    return "failed";
  }
  return "partial";
}

function workspaceChanged(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): boolean {
  return before.fingerprint !== after.fingerprint || after.dirty;
}

function changedFilesBetween(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): readonly string[] {
  const files = new Set<string>();
  for (const file of before.changedFiles) files.add(file);
  for (const file of after.changedFiles) files.add(file);
  return [...files].sort((left, right) => left.localeCompare(right));
}

function requireTaskRecord(
  record: SafeExecutionTaskRecord | null | undefined,
  taskId: TaskRunId,
): SafeExecutionTaskRecord {
  if (record) return record;
  throw new SafeExecutionError(
    "safe_execution_invalid_task",
    "Safe execution task record is missing.",
    { details: { taskId } },
  );
}

function errorChain(error: unknown): readonly unknown[] {
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

function attemptMetadataFromError(error: unknown): {
  readonly workerId?: string;
  readonly accountId?: string;
} {
  let workerId: string | undefined;
  let accountId: string | undefined;
  for (const item of errorChain(error)) {
    if (!isSubscriptionWorkerError(item)) continue;
    workerId = workerId ?? item.details.workerId;
    accountId = accountId ?? item.details.accountId;
  }
  return {
    ...(workerId === undefined ? {} : { workerId }),
    ...(accountId === undefined ? {} : { accountId }),
  };
}

function gitStatusChangedFiles(lines: readonly string[]): readonly string[] {
  const files = new Set<string>();
  for (const line of lines) {
    const path = line.slice(3).trim();
    if (!path) continue;
    const renamed = path.includes(" -> ") ? path.split(" -> ").at(-1) : path;
    if (renamed) files.add(normalizeRelativePath(renamed));
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

function mergeChangedFiles(
  left: readonly string[],
  right: readonly string[],
): readonly string[] {
  return [...new Set([...left, ...right])]
    .filter(Boolean)
    .sort((leftFile, rightFile) => leftFile.localeCompare(rightFile));
}

async function canonicalWorkspacePath(path: string): Promise<string> {
  const resolved = resolve(path);
  return realpath(resolved).catch(() => resolved);
}

function workspaceRunId(workspacePath: string): WorkspaceRunId {
  return `workspace:${hashText(workspacePath).slice(0, 24)}`;
}

function workspaceLockKey(workspacePath: string): string {
  return hashText(workspacePath);
}

function canReplaceLock(record: WorkspaceLockRecord, now: Date): boolean {
  if (record.staleLockMs === undefined) return false;
  if (now.getTime() - record.acquiredAt.getTime() < record.staleLockMs) {
    return false;
  }
  if (record.ownerPid === undefined) return false;
  return !isProcessAlive(record.ownerPid);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ESRCH")) return false;
    return true;
  }
}

function workspaceLockedError(record: WorkspaceLockRecord): SafeExecutionError {
  return new SafeExecutionError(
    "safe_execution_workspace_locked",
    "Workspace is already locked by another safe execution task.",
    {
      details: {
        taskId: record.taskId,
        workspacePath: record.workspacePath,
        ownerId: record.ownerId,
        acquiredAt: record.acquiredAt.toISOString(),
      },
    },
  );
}

async function releaseFileLock(
  lockDir: string,
  lockFile: string,
  record: WorkspaceLockRecord,
): Promise<void> {
  const current = await readLockRecord(lockFile, record.workspacePath).catch(
    () => null,
  );
  if (current?.ownerId === record.ownerId && current.taskId === record.taskId) {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function readLockRecord(
  path: string,
  fallbackWorkspacePath: string,
): Promise<WorkspaceLockRecord | null> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const ownerPid = numberValue(raw.ownerPid);
    const staleLockMs = numberValue(raw.staleLockMs);
    return {
      taskId: stringValue(raw.taskId) ?? "unknown",
      workspacePath: stringValue(raw.workspacePath) ?? fallbackWorkspacePath,
      ownerId: stringValue(raw.ownerId) ?? "unknown",
      ...(ownerPid === undefined ? {} : { ownerPid }),
      acquiredAt: dateValue(raw.acquiredAt) ?? new Date(0),
      ...(staleLockMs === undefined ? {} : { staleLockMs }),
    };
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

function serializeLockRecord(
  record: WorkspaceLockRecord,
): Readonly<Record<string, unknown>> {
  return {
    taskId: record.taskId,
    workspacePath: record.workspacePath,
    ownerId: record.ownerId,
    ownerPid: record.ownerPid,
    acquiredAt: record.acquiredAt.toISOString(),
    staleLockMs: record.staleLockMs,
  };
}

function serializeTaskRecord(
  record: SafeExecutionTaskRecord,
): Readonly<Record<string, unknown>> {
  return {
    ...record,
    startedAt: record.startedAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    completedAt: record.completedAt?.toISOString(),
    attempts: record.attempts.map(serializeAttemptRecord),
  };
}

function serializeAttemptRecord(
  record: AttemptRecord,
): Readonly<Record<string, unknown>> {
  return {
    ...record,
    startedAt: record.startedAt.toISOString(),
    finishedAt: record.finishedAt?.toISOString(),
  };
}

function parseTaskRecord(raw: string): SafeExecutionTaskRecord {
  const value = JSON.parse(raw) as Record<string, unknown>;
  return {
    taskId: requireString(value.taskId, "taskId"),
    workspaceRunId: requireString(value.workspaceRunId, "workspaceRunId"),
    workspacePath: requireString(value.workspacePath, "workspacePath"),
    effectMode: requireEffectMode(value.effectMode),
    provider: requireString(value.provider, "provider"),
    status: requireTaskStatus(value.status),
    startedAt: requireDate(value.startedAt, "startedAt"),
    updatedAt: requireDate(value.updatedAt, "updatedAt"),
    attempts: arrayValue(value.attempts).map(parseAttemptRecord),
    ...(dateValue(value.completedAt) === undefined
      ? {}
      : { completedAt: requireDate(value.completedAt, "completedAt") }),
    ...(value.result === undefined ? {} : { result: value.result }),
    ...(stringValue(value.outputSummary) === undefined
      ? {}
      : { outputSummary: stringValue(value.outputSummary)! }),
    ...(isAttemptFailureReason(value.lastFailureReason)
      ? { lastFailureReason: value.lastFailureReason }
      : {}),
    ...(stringValue(value.lastFailureMessage) === undefined
      ? {}
      : { lastFailureMessage: stringValue(value.lastFailureMessage)! }),
  };
}

function parseAttemptRecord(value: unknown): AttemptRecord {
  const record = value as Record<string, unknown>;
  return {
    taskId: requireString(record.taskId, "attempt.taskId"),
    attemptNumber: requireNumber(record.attemptNumber, "attempt.attemptNumber"),
    ...(stringValue(record.workerId) === undefined
      ? {}
      : { workerId: stringValue(record.workerId)! }),
    ...(stringValue(record.accountId) === undefined
      ? {}
      : { accountId: stringValue(record.accountId)! }),
    provider: requireString(record.provider, "attempt.provider"),
    startedAt: requireDate(record.startedAt, "attempt.startedAt"),
    ...(dateValue(record.finishedAt) === undefined
      ? {}
      : { finishedAt: requireDate(record.finishedAt, "attempt.finishedAt") }),
    status: requireAttemptStatus(record.status),
    ...(isAttemptFailureReason(record.failureReason)
      ? { failureReason: record.failureReason }
      : {}),
    ...(stringValue(record.failureMessage) === undefined
      ? {}
      : { failureMessage: stringValue(record.failureMessage)! }),
    workspaceDirtyBefore: Boolean(record.workspaceDirtyBefore),
    ...(typeof record.workspaceDirtyAfter === "boolean"
      ? { workspaceDirtyAfter: record.workspaceDirtyAfter }
      : {}),
    changedFiles: arrayValue(record.changedFiles).map((item) =>
      requireString(item, "attempt.changedFiles"),
    ),
    ...(stringValue(record.lastOutputSummary) === undefined
      ? {}
      : { lastOutputSummary: stringValue(record.lastOutputSummary)! }),
  };
}

async function atomicWriteJson(
  path: string,
  value: Readonly<Record<string, unknown>>,
): Promise<void> {
  const targetDir = dirname(path);
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(join(targetDir, ".tmp-"));
  const tempPath = join(tempDir, basename(path));
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, path);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function requireString(value: unknown, field: string): string {
  const normalized = stringValue(value);
  if (normalized !== undefined) return normalized;
  throw new Error(`safe_execution_invalid_${field}`);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireNumber(value: unknown, field: string): number {
  const normalized = numberValue(value);
  if (normalized !== undefined) return normalized;
  throw new Error(`safe_execution_invalid_${field}`);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requireDate(value: unknown, field: string): Date {
  const normalized = dateValue(value);
  if (normalized !== undefined) return normalized;
  throw new Error(`safe_execution_invalid_${field}`);
}

function dateValue(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function requireEffectMode(value: unknown): TaskEffectMode {
  if (
    value === "read_only" ||
    value === "workspace_patch" ||
    value === "external_side_effects"
  ) {
    return value;
  }
  throw new Error("safe_execution_invalid_effectMode");
}

function requireTaskStatus(value: unknown): SafeExecutionTaskStatus {
  if (
    value === "running" ||
    value === "completed" ||
    value === "partial" ||
    value === "failed" ||
    value === "aborted"
  ) {
    return value;
  }
  throw new Error("safe_execution_invalid_status");
}

function requireAttemptStatus(value: unknown): AttemptStatus {
  if (
    value === "running" ||
    value === "completed" ||
    value === "blocked" ||
    value === "failed"
  ) {
    return value;
  }
  throw new Error("safe_execution_invalid_attempt_status");
}

function isAttemptFailureReason(value: unknown): value is AttemptFailureReason {
  return (
    value === "quota_limited" ||
    value === "capacity_unavailable" ||
    value === "account_unavailable" ||
    value === "reconnect_required" ||
    value === "permission_required" ||
    value === "user_abort" ||
    value === "unknown_error"
  );
}

const systemClock = {
  now(): Date {
    return new Date();
  },
};
