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
import type {
  WorkerControlContinuationBatch,
  WorkerControlTarget,
} from "./control";
import {
  SafeExecutionError,
  attemptFailureReasons,
  defaultSafeExecutionErrorClassifier,
  failureDetailsFromUnknown,
  normalizeSafeExecutionPolicy,
  prefixFailureDetails,
  runtimeInterruptClassification,
  safeExecutionAttemptMetadataFromError,
  safeExecutionDetailTail,
  safeExecutionErrorMessage,
  safeExecutionFinalStatusForFailure,
  safeExecutionWaitingStatusForBlockedFailure,
  safeExecutionWaitingStatusForFailure,
  shouldContinueSafeExecutionAfterFailure,
  shouldDeliverSafeExecutionControlForContinuation,
  withFailureDetails,
  type AttemptFailureReason,
  type ContinuationMode,
  type SafeExecutionFailureClassification,
  type SafeExecutionPolicy,
  type TaskEffectMode,
} from "./safe-execution/domain/safe-execution-policy";
import type {
  AttemptPatchStats,
  AttemptPatchStatsSource,
  AttemptRecord,
  AttemptStatus,
  AttemptUsage,
  AttemptUsageSource,
  ContinuationPacket,
  SafeExecutionTaskRecord,
  SafeExecutionTaskStatus,
  TaskRunId,
  WorkspaceDiffFileStat,
  WorkspaceLockHandle,
  WorkspaceLockRecord,
  WorkspaceRunId,
  WorkspaceSnapshot,
} from "./safe-execution/domain/safe-execution-task";
import type {
  AttemptJournal,
  ContinuationPacketBuilder,
  SafeExecutionRunInput,
  SafeExecutionRunnerOptions,
  SafeExecutionRunResult,
  WorkspaceLockStore,
  WorkspaceSnapshotter,
} from "./safe-execution/ports/safe-execution-ports";

export {
  SafeExecutionError,
  attemptFailureReasons,
  defaultSafeExecutionErrorClassifier,
  isSafeExecutionError,
  type AttemptFailureReason,
  type ContinuationMode,
  type SafeExecutionErrorCode,
  type SafeExecutionFailureClassification,
  type SafeExecutionPolicy,
  type TaskEffectMode,
} from "./safe-execution/domain/safe-execution-policy";
export type {
  AttemptPatchStats,
  AttemptPatchStatsSource,
  AttemptRecord,
  AttemptStatus,
  AttemptUsage,
  AttemptUsageSource,
  ContinuationPacket,
  ExistingLockedWorkspaceStrategy,
  SafeExecutionTaskRecord,
  SafeExecutionTaskStatus,
  TaskRunId,
  WorkspaceDiffFileStat,
  WorkspaceLockHandle,
  WorkspaceLockRecord,
  WorkspaceRunId,
  WorkspaceSnapshot,
  WorkspaceSnapshotMode,
  WorkspaceStrategy,
} from "./safe-execution/domain/safe-execution-task";
export type {
  AttemptJournal,
  ContinuationPacketBuilder,
  SafeExecutionRunInput,
  SafeExecutionRunnerOptions,
  SafeExecutionRunResult,
  SafeExecutionWorkerPool,
  WorkspaceLockStore,
  WorkspaceSnapshotter,
} from "./safe-execution/ports/safe-execution-ports";

const execFileAsync = promisify(execFile);

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
            ...(input.attempt.failureDetails === undefined
              ? {}
              : { lastFailureDetails: input.attempt.failureDetails }),
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
    readonly details?: Readonly<Record<string, string>>;
    readonly now: Date;
  }): Promise<SafeExecutionTaskRecord> {
    const record = requireTaskRecord(this.records.get(input.taskId), input.taskId);
    const next: SafeExecutionTaskRecord = {
      ...record,
      status: input.status,
      updatedAt: input.now,
      lastFailureReason: input.reason,
      ...(input.message === undefined ? {} : { lastFailureMessage: input.message }),
      ...(input.details === undefined ? {} : { lastFailureDetails: input.details }),
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
            ...(input.attempt.failureDetails === undefined
              ? {}
              : { lastFailureDetails: input.attempt.failureDetails }),
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
    readonly details?: Readonly<Record<string, string>>;
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
      ...(input.details === undefined ? {} : { lastFailureDetails: input.details }),
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
    const gitWorkspace = await this.gitWorkspaceInfo(workspacePath);
    if (gitWorkspace) {
      return this.captureGit({
        ...input,
        workspacePath,
        capturedAt,
        workspaceRelativePrefix: gitWorkspace.relativePrefix,
        gitRootPath: gitWorkspace.rootPath,
      });
    }
    return this.captureFilesystem({ ...input, workspacePath, capturedAt });
  }

  private async captureGit(input: {
    readonly workspacePath: string;
    readonly includeDiff?: boolean;
    readonly abortSignal?: AbortSignal;
    readonly capturedAt: Date;
    readonly workspaceRelativePrefix: string;
    readonly gitRootPath: string;
  }): Promise<WorkspaceSnapshot> {
    const status = await this.git(input.workspacePath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      ".",
    ]);
    const statusEntries = status.stdout.split("\0").filter(Boolean);
    const headTree = await this.gitHeadTree(
      input.gitRootPath,
      input.workspaceRelativePrefix,
    );
    const changedFiles = mergeChangedFiles(
      gitStatusChangedFiles(statusEntries, input.workspaceRelativePrefix),
      await this.gitDiffNameOnly(input.workspacePath),
    );
    const diffStat = await this.gitDiffStat(input.workspacePath);
    const diffNumstat = await this.gitDiffNumstat(input.workspacePath);
    const shortDiff = input.includeDiff
      ? await this.shortGitDiff(input.workspacePath)
      : undefined;
    return {
      mode: "git",
      workspacePath: input.workspacePath,
      capturedAt: input.capturedAt,
      dirty: changedFiles.length > 0,
      changedFiles,
      ...(diffNumstat.length === 0 ? {} : { diffNumstat }),
      fingerprint: hashText([`head-tree:${headTree}`, ...statusEntries].join("\n")),
      summary: changedFiles.length === 0
        ? "Git workspace is clean."
        : `Git workspace has ${changedFiles.length} changed file(s).`,
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

  private async gitWorkspaceInfo(
    workspacePath: string,
  ): Promise<{
    readonly relativePrefix: string;
    readonly rootPath: string;
  } | null> {
    const result = await this.git(workspacePath, [
      "rev-parse",
      "--is-inside-work-tree",
      "--show-prefix",
      "--show-toplevel",
    ]).catch(() => null);
    const lines = result?.stdout.split("\n").map((line) => line.trimEnd()) ?? [];
    if (lines[0] !== "true") return null;
    const prefix = normalizeRelativePath(lines[1] ?? "").replace(/\/$/, "");
    return { relativePrefix: prefix, rootPath: lines[2] || workspacePath };
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
    const value = await this.gitDiffOutputs(workspacePath, []);
    if (value.length <= this.maxDiffBytes) {
      return { value, truncated: false };
    }
    return {
      value: value.slice(0, this.maxDiffBytes),
      truncated: true,
    };
  }

  private async gitDiffNameOnly(workspacePath: string): Promise<readonly string[]> {
    const value = await this.gitDiffOutputs(workspacePath, ["--name-only"]);
    return value
      .split("\n")
      .map((line) => normalizeRelativePath(line.trim()))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
  }

  private async gitDiffNumstat(
    workspacePath: string,
  ): Promise<readonly WorkspaceDiffFileStat[]> {
    return parseGitNumstat(
      await this.gitDiffOutputs(workspacePath, ["--numstat"]),
    );
  }

  private async gitHeadTree(
    workspacePath: string,
    workspaceRelativePrefix: string,
  ): Promise<string> {
    if (!workspaceRelativePrefix) {
      const result = await this.git(workspacePath, [
        "rev-parse",
        "HEAD^{tree}",
      ]).catch(() => ({ stdout: "", stderr: "" }));
      return result.stdout.trim();
    }

    const result = await this.git(workspacePath, [
      "ls-tree",
      "HEAD",
      "--",
      workspaceRelativePrefix,
    ]).catch(() => ({ stdout: "", stderr: "" }));
    const match = result.stdout.match(/\s([0-9a-f]{40,64})\t/);
    return match?.[1] ?? "";
  }

  private async gitDiffStat(workspacePath: string): Promise<string> {
    return (await this.gitDiffOutputs(workspacePath, ["--stat"])).trim();
  }

  private async gitDiffOutputs(
    workspacePath: string,
    args: readonly string[],
  ): Promise<string> {
    const outputs = [
      await this.gitDiffOutput(workspacePath, args, false),
      await this.gitDiffOutput(workspacePath, args, true),
    ];
    return outputs.filter(Boolean).join("\n");
  }

  private async gitDiffOutput(
    workspacePath: string,
    args: readonly string[],
    cached: boolean,
  ): Promise<string> {
    const result = await this.git(workspacePath, [
      "diff",
      "--relative",
      ...(cached ? ["--cached"] : []),
      ...args,
      "--no-ext-diff",
      "--",
      ".",
    ]).catch(() => ({ stdout: "", stderr: "" }));
    return result.stdout;
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
    readonly controlBatch?: WorkerControlContinuationBatch;
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
    const controlText = input.controlBatch?.message
      ? `\n${input.controlBatch.message}\n`
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
      controlText.trimEnd(),
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
      ...(input.controlBatch?.signalIds.length
        ? { workerControlSignalIds: input.controlBatch.signalIds }
        : {}),
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
      if (input.workspace.requireGitWorkspace) {
        try {
          await assertGitWorkspace(workspacePath);
        } catch (error) {
          return this.failStartedTask({ input, error });
        }
      }
      if (existing?.status === "running" && existing.attempts.length === 0) {
        let snapshot: WorkspaceSnapshot;
        try {
          snapshot = await this.snapshotter.capture({
            workspacePath,
            includeDiff: true,
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          });
        } catch (error) {
          return this.failStartedTask({ input, error });
        }
        if (snapshot.dirty) {
          const safeMessage =
            "Safe execution found an interrupted running task with unrecorded workspace changes.";
          task = await this.options.journal.markPartial({
            taskId: input.taskId,
            status: "partial",
            reason: "unknown_error",
            message: safeMessage,
            details: interruptedWorkspaceDetails(snapshot),
            now: this.clock.now(),
          });
          return {
            status: "partial",
            task,
            attempts: task.attempts,
            reason: "unknown_error",
            safeMessage,
            failureDetails: interruptedWorkspaceDetails(snapshot),
          };
        }
      }

      const policy = normalizeSafeExecutionPolicy(input);
      let job = input.job;
      let previousOutputSummary = task.outputSummary;
      const firstAttemptNumber = task.attempts.length + 1;

      if (
        task.attempts.length > 0 &&
        task.lastFailureReason &&
        policy.continuationMode !== "disabled"
      ) {
        let snapshot: WorkspaceSnapshot;
        try {
          snapshot = await this.snapshotter.capture({
            workspacePath,
            includeDiff: true,
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          });
        } catch (error) {
          return this.failStartedTask({ input, error });
        }
        const packet = await this.buildContinuationPacket({
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
          ...(input.controlTarget === undefined
            ? {}
            : { controlTarget: input.controlTarget }),
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
            ...(task.lastFailureDetails === undefined
              ? {}
              : { details: task.lastFailureDetails }),
            now: this.clock.now(),
          });
          return {
            status: "partial",
            task: partial,
            attempts: partial.attempts,
            reason: task.lastFailureReason,
            safeMessage,
            ...(task.lastFailureDetails === undefined
              ? {}
              : { failureDetails: task.lastFailureDetails }),
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

        let before: WorkspaceSnapshot;
        try {
          before = await this.snapshotter.capture({
            workspacePath,
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          });
        } catch (error) {
          return this.failStartedTask({ input, error });
        }
        const startedAt = this.clock.now();
        const attemptAbort = createAttemptAbortController(input.abortSignal);
        const attemptTarget = attemptControlTarget({
          input,
          workspacePath,
          attemptNumber,
        });
        const activeAttempt = this.options.activeAttemptRegistry?.register({
          taskId: input.taskId,
          attemptNumber,
          provider: input.provider,
          workspacePath,
          target: attemptTarget,
          startedAt,
          abortController: attemptAbort.controller,
        });

        try {
          const result = await input.pool.run(job, {
            idempotencyKey: `${input.taskId}:${attemptNumber}`,
            abortSignal: attemptAbort.controller.signal,
            retryPolicy: {
              maxAttempts: 1,
              retryOnSlotCapacityUnavailable: false,
            },
          });
          const after = await this.snapshotter.capture({
            workspacePath,
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          }).catch((error) =>
            unavailableWorkspaceSnapshot({ workspacePath, error }),
          );
          previousOutputSummary = input.summarizeResult?.(result);
          const usage = input.attemptUsage?.(result);
          const metadata = input.attemptMetadata?.({ result });
          const attempt = completeAttemptRecord({
            input,
            attemptNumber,
            startedAt,
            finishedAt: this.clock.now(),
            before,
            after,
            ...(metadata === undefined ? {} : { metadata }),
            ...(usage === undefined ? {} : { usage }),
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
          let afterCaptureError: unknown;
          const after = await this.snapshotter.capture({
            workspacePath,
            includeDiff: true,
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          }).catch((error) => {
            afterCaptureError = error;
            return unavailableWorkspaceSnapshot({ workspacePath, error });
          });
          const runtimeInterrupt = runtimeInterruptClassification(
            attemptAbort.controller.signal.reason,
          );
          const classification = withFailureDetails(
            runtimeInterrupt ??
              input.classifyError?.(error) ??
              defaultSafeExecutionErrorClassifier(error),
            afterCaptureError === undefined
              ? undefined
              : prefixFailureDetails(
                  "workspaceSnapshot",
                  failureDetailsFromUnknown(afterCaptureError),
                ),
          );
          const errorSummary = input.summarizeError?.(error);
          const errorOutputSummary = input.summarizeErrorOutput?.(error);
          const failureMessage = errorSummary ?? classification.safeMessage;
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
              safeExecutionAttemptMetadataFromError(error),
          });
          task = await this.options.journal.appendAttempt({
            taskId: input.taskId,
            attempt,
            now: this.clock.now(),
          });

          const changed = workspaceChanged(before, after);
          const canContinue = shouldContinueSafeExecutionAfterFailure({
            classification,
            policy,
            effectMode: input.effectMode,
            workspaceChanged: changed,
            attemptsRemaining: attemptNumber < policy.maxAttempts,
          });

          if (!canContinue.allowed) {
            const status =
              safeExecutionWaitingStatusForBlockedFailure({
                reason: classification.reason,
                workspaceChanged: changed,
              }) ?? safeExecutionFinalStatusForFailure(classification.reason);
            task = await this.options.journal.markPartial({
              taskId: input.taskId,
              status,
              reason: classification.reason,
              message: canContinue.safeMessage ?? failureMessage,
              ...(classification.details === undefined
                ? {}
                : { details: classification.details }),
              now: this.clock.now(),
            });
            return {
              status,
              task,
              attempts: task.attempts,
              reason: classification.reason,
              safeMessage: canContinue.safeMessage ?? failureMessage,
              ...(classification.details === undefined
                ? {}
                : { failureDetails: classification.details }),
              error,
            };
          }

          const continuationOutputSummary =
            previousOutputSummary ??
            (classification.reason === "goal_slice_exhausted"
              ? errorOutputSummary
              : undefined);
          const packet = await this.buildContinuationPacket({
            taskId: input.taskId,
            attemptNumber: attemptNumber + 1,
            provider: input.provider,
            workspacePath,
            originalPrompt: input.originalPrompt,
            previousFailureReason: classification.reason,
            snapshot: after,
            ...(continuationOutputSummary === undefined
              ? {}
              : { previousOutputSummary: continuationOutputSummary }),
            ...(input.controlTarget === undefined
              ? {}
              : { controlTarget: input.controlTarget }),
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
              ...(classification.details === undefined
                ? {}
                : { details: classification.details }),
              now: this.clock.now(),
            });
            return {
              status: "partial",
              task,
              attempts: task.attempts,
              reason: classification.reason,
              safeMessage,
              ...(classification.details === undefined
                ? {}
                : { failureDetails: classification.details }),
              error,
            };
          }
          job = continuationJob;
        } finally {
          activeAttempt?.release();
          attemptAbort.dispose();
        }
      }

      const exhausted = await this.options.journal.markPartial({
        taskId: input.taskId,
        status:
          safeExecutionWaitingStatusForFailure(task.lastFailureReason) ?? "partial",
        reason: task.lastFailureReason ?? "unknown_error",
        message: "Safe execution exhausted all configured attempts.",
        ...(task.lastFailureDetails === undefined
          ? {}
          : { details: task.lastFailureDetails }),
        now: this.clock.now(),
      });
      return {
        status:
          safeExecutionWaitingStatusForFailure(exhausted.lastFailureReason) ??
          "partial",
        task: exhausted,
        attempts: exhausted.attempts,
        reason: exhausted.lastFailureReason ?? "unknown_error",
        safeMessage: "Safe execution exhausted all configured attempts.",
        ...(exhausted.lastFailureDetails === undefined
          ? {}
          : { failureDetails: exhausted.lastFailureDetails }),
      };
    } finally {
      await lock.release();
    }
  }

  private async failStartedTask<Job, Result>(input: {
    readonly input: SafeExecutionRunInput<Job, Result>;
    readonly error: unknown;
  }): Promise<SafeExecutionRunResult<Result>> {
    const classification = defaultSafeExecutionErrorClassifier(input.error);
    const failureMessage =
      input.input.summarizeError?.(input.error) ?? classification.safeMessage;
    const status = safeExecutionFinalStatusForFailure(classification.reason);
    const task = await this.options.journal.markPartial({
      taskId: input.input.taskId,
      status,
      reason: classification.reason,
      message: failureMessage,
      ...(classification.details === undefined
        ? {}
        : { details: classification.details }),
      now: this.clock.now(),
    });
    return {
      status,
      task,
      attempts: task.attempts,
      reason: classification.reason,
      safeMessage: failureMessage,
      ...(classification.details === undefined
        ? {}
        : { failureDetails: classification.details }),
      error: input.error,
    };
  }

  private async buildContinuationPacket(input: {
    readonly taskId: TaskRunId;
    readonly attemptNumber: number;
    readonly provider: string;
    readonly workspacePath: string;
    readonly originalPrompt: string;
    readonly previousFailureReason: AttemptFailureReason;
    readonly snapshot: WorkspaceSnapshot;
    readonly previousOutputSummary?: string;
    readonly controlTarget?: WorkerControlTarget;
  }): Promise<ContinuationPacket> {
    const controlBatch = this.options.controlInbox &&
      shouldDeliverSafeExecutionControlForContinuation(input.previousFailureReason)
      ? await this.options.controlInbox.consumeForContinuation({
          target: input.controlTarget ?? {
            jobId: input.taskId,
            workspaceId: input.workspacePath,
          },
          deliveryAttemptId: `${input.taskId}:attempt-${input.attemptNumber}`,
          now: this.clock.now(),
        })
      : undefined;
    return this.continuationPacketBuilder.build({
      taskId: input.taskId,
      attemptNumber: input.attemptNumber,
      provider: input.provider,
      workspacePath: input.workspacePath,
      originalPrompt: input.originalPrompt,
      previousFailureReason: input.previousFailureReason,
      snapshot: input.snapshot,
      ...(input.previousOutputSummary === undefined
        ? {}
        : { previousOutputSummary: input.previousOutputSummary }),
      ...(controlBatch === undefined ? {} : { controlBatch }),
    });
  }
}

function attemptControlTarget<Job, Result>(input: {
  readonly input: SafeExecutionRunInput<Job, Result>;
  readonly workspacePath: string;
  readonly attemptNumber: number;
}): WorkerControlTarget {
  const base = input.input.controlTarget ?? {
    jobId: input.input.taskId,
    workspaceId: input.workspacePath,
  };
  return {
    ...base,
    taskId: base.taskId ?? input.input.taskId,
    workspaceId: base.workspaceId ?? input.workspacePath,
    attemptId: base.attemptId ?? `${input.input.taskId}:attempt-${input.attemptNumber}`,
  };
}

function createAttemptAbortController(
  parent: AbortSignal | undefined,
): {
  readonly controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  if (!parent) return { controller, dispose: () => undefined };
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(parent.reason);
    }
  };
  if (parent.aborted) {
    abort();
    return { controller, dispose: () => undefined };
  }
  parent.addEventListener("abort", abort, { once: true });
  return {
    controller,
    dispose: () => parent.removeEventListener("abort", abort),
  };
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
    normalizeSafeExecutionPolicy(input).maxAttempts > 1
  ) {
    throw new SafeExecutionError(
      "safe_execution_external_retry_disabled",
      "Safe execution does not retry external side effects by default.",
    );
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
  readonly usage?: AttemptUsage;
  readonly outputSummary?: string;
}): AttemptRecord {
  const patch = patchStatsBetween(input.before, input.after);
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
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(input.usage === undefined
      ? {}
      : { usageSource: "provider_structured" as const }),
    ...(patch === undefined ? {} : { patch }),
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
  const patch = patchStatsBetween(input.before, input.after);
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
    ...(input.classification.details === undefined
      ? {}
      : { failureDetails: input.classification.details }),
    workspaceDirtyBefore: input.before.dirty,
    workspaceDirtyAfter: input.after.dirty,
    changedFiles: changedFilesBetween(input.before, input.after),
    ...(patch === undefined ? {} : { patch }),
  };
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
  if (before.mode === after.mode) {
    return changedFilesDelta(before.changedFiles, after.changedFiles);
  }

  return changedFilesDelta(before.changedFiles, after.changedFiles);
}

function patchStatsBetween(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): AttemptPatchStats | undefined {
  if (!before.diffNumstat || !after.diffNumstat) return undefined;
  const beforeByPath = diffNumstatByPath(before.diffNumstat);
  let additions = 0;
  let deletions = 0;
  for (const next of after.diffNumstat) {
    if (next.binary) continue;
    const previous = beforeByPath.get(next.path);
    additions += Math.max(0, next.additions - (previous?.additions ?? 0));
    deletions += Math.max(0, next.deletions - (previous?.deletions ?? 0));
  }
  if (additions === 0 && deletions === 0) return undefined;
  return {
    additions,
    deletions,
    source: before.dirty
      ? "git_numstat_delta_dirty_baseline"
      : "git_numstat_delta",
  };
}

function diffNumstatByPath(
  stats: readonly WorkspaceDiffFileStat[],
): Map<string, WorkspaceDiffFileStat> {
  const byPath = new Map<string, WorkspaceDiffFileStat>();
  for (const stat of stats) {
    byPath.set(stat.path, stat);
  }
  return byPath;
}

function changedFilesDelta(
  before: readonly string[],
  after: readonly string[],
): readonly string[] {
  const beforeFiles = new Set(before);
  return after
    .filter((file) => !beforeFiles.has(file))
    .sort((left, right) => left.localeCompare(right));
}

function interruptedWorkspaceDetails(
  snapshot: WorkspaceSnapshot,
): Readonly<Record<string, string>> {
  return {
    workspaceMode: snapshot.mode,
    changedFileCount: String(snapshot.changedFiles.length),
    changedFiles: snapshot.changedFiles.slice(0, 20).join(","),
  };
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

function unavailableWorkspaceSnapshot(input: {
  readonly workspacePath: string;
  readonly error: unknown;
}): WorkspaceSnapshot {
  const capturedAt = new Date();
  const message = safeExecutionErrorMessage(input.error);
  return {
    mode: "unavailable",
    workspacePath: input.workspacePath,
    capturedAt,
    dirty: true,
    changedFiles: [],
    fingerprint: `unavailable:${hashText(
      `${input.workspacePath}:${capturedAt.toISOString()}:${message}`,
    )}`,
    summary: `Workspace snapshot unavailable: ${safeExecutionDetailTail(
      message || "unknown error",
    )}`,
    warnings: ["workspace_snapshot_unavailable"],
  };
}

function gitStatusChangedFiles(
  entries: readonly string[],
  workspaceRelativePrefix = "",
): readonly string[] {
  const files = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    if (status.includes("R") || status.includes("C")) {
      index += 1;
    }
    const relativePath = stripWorkspacePrefix(path, workspaceRelativePrefix);
    if (relativePath) files.add(relativePath);
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

function stripWorkspacePrefix(
  path: string,
  workspaceRelativePrefix: string,
): string | null {
  const normalizedPath = normalizeRelativePath(path);
  const normalizedPrefix = normalizeRelativePath(workspaceRelativePrefix);
  if (!normalizedPrefix) return normalizedPath;
  if (normalizedPath === normalizedPrefix) return basename(normalizedPath);
  const prefix = `${normalizedPrefix}/`;
  if (!normalizedPath.startsWith(prefix)) return null;
  return normalizedPath.slice(prefix.length);
}

function mergeChangedFiles(
  left: readonly string[],
  right: readonly string[],
): readonly string[] {
  return [...new Set([...left, ...right])]
    .filter(Boolean)
    .sort((leftFile, rightFile) => leftFile.localeCompare(rightFile));
}

function parseGitNumstat(value: string): readonly WorkspaceDiffFileStat[] {
  const byPath = new Map<string, WorkspaceDiffFileStat>();
  for (const line of value.split("\n")) {
    if (!line.trim()) continue;
    const [rawAdditions, rawDeletions, ...pathParts] = line.split("\t");
    const path = normalizeRelativePath(pathParts.join("\t").trim());
    if (!path) continue;
    const binary = rawAdditions === "-" || rawDeletions === "-";
    const additions = binary ? 0 : Number(rawAdditions);
    const deletions = binary ? 0 : Number(rawDeletions);
    if (
      !binary &&
      (!Number.isFinite(additions) || !Number.isFinite(deletions))
    ) {
      continue;
    }
    const existing = byPath.get(path);
    byPath.set(path, {
      path,
      additions: (existing?.additions ?? 0) + additions,
      deletions: (existing?.deletions ?? 0) + deletions,
      ...(binary || existing?.binary ? { binary: true } : {}),
    });
  }
  return [...byPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

async function canonicalWorkspacePath(path: string): Promise<string> {
  const resolved = resolve(path);
  return realpath(resolved).catch(() => resolved);
}

async function assertGitWorkspace(workspacePath: string): Promise<void> {
  const result = await execFileAsync("git", [
    "rev-parse",
    "--is-inside-work-tree",
  ], {
    cwd: workspacePath,
    timeout: 5_000,
  }).catch(() => null);
  if (result?.stdout.toString().trim() === "true") return;
  throw new SafeExecutionError(
    "safe_execution_workspace_not_git",
    "Safe execution requires a git worktree workspace.",
    { details: { workspacePath } },
  );
}

function workspaceRunId(workspacePath: string): WorkspaceRunId {
  return `workspace:${hashText(workspacePath).slice(0, 24)}`;
}

function workspaceLockKey(workspacePath: string): string {
  return hashText(workspacePath);
}

function canReplaceLock(record: WorkspaceLockRecord, now: Date): boolean {
  if (record.ownerPid !== undefined && !isProcessAlive(record.ownerPid)) {
    return true;
  }
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
    ...(stringRecordValue(value.lastFailureDetails) === undefined
      ? {}
      : { lastFailureDetails: stringRecordValue(value.lastFailureDetails)! }),
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
    ...(stringRecordValue(record.failureDetails) === undefined
      ? {}
      : { failureDetails: stringRecordValue(record.failureDetails)! }),
    workspaceDirtyBefore: Boolean(record.workspaceDirtyBefore),
    ...(typeof record.workspaceDirtyAfter === "boolean"
      ? { workspaceDirtyAfter: record.workspaceDirtyAfter }
      : {}),
    changedFiles: arrayValue(record.changedFiles).map((item) =>
      requireString(item, "attempt.changedFiles"),
    ),
    ...(parseAttemptUsage(record.usage) === undefined
      ? {}
      : { usage: parseAttemptUsage(record.usage)! }),
    ...(isAttemptUsageSource(record.usageSource)
      ? { usageSource: record.usageSource }
      : {}),
    ...(parseAttemptPatchStats(record.patch) === undefined
      ? {}
      : { patch: parseAttemptPatchStats(record.patch)! }),
    ...(stringValue(record.lastOutputSummary) === undefined
      ? {}
      : { lastOutputSummary: stringValue(record.lastOutputSummary)! }),
  };
}

function parseAttemptUsage(value: unknown): AttemptUsage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const inputTokens = numberValue(record.inputTokens);
  const outputTokens = numberValue(record.outputTokens);
  const totalTokens = numberValue(record.totalTokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function parseAttemptPatchStats(
  value: unknown,
): AttemptPatchStats | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const additions = numberValue(record.additions);
  const deletions = numberValue(record.deletions);
  const source = record.source;
  if (
    additions === undefined ||
    deletions === undefined ||
    !isAttemptPatchStatsSource(source)
  ) {
    return undefined;
  }
  return { additions, deletions, source };
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

function stringRecordValue(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, string> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested !== "string") return undefined;
    record[key] = nested;
  }
  return record;
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
    value === "waiting_capacity" ||
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
    typeof value === "string" &&
    attemptFailureReasons.includes(value as AttemptFailureReason)
  );
}

function isAttemptUsageSource(value: unknown): value is AttemptUsageSource {
  return (
    value === "provider_structured" ||
    value === "legacy_text_reported" ||
    value === "unavailable"
  );
}

function isAttemptPatchStatsSource(
  value: unknown,
): value is AttemptPatchStatsSource {
  return (
    value === "git_numstat_delta" ||
    value === "git_numstat_delta_dirty_baseline" ||
    value === "unavailable"
  );
}

const systemClock = {
  now(): Date {
    return new Date();
  },
};
