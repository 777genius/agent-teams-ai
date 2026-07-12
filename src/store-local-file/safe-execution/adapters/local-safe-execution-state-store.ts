import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  SafeExecutionError,
  attemptFailureReasons,
  shouldReplaceSafeExecutionWorkspaceLock,
  type AttemptFailureReason,
  type AttemptJournal,
  type AttemptPatchStats,
  type AttemptRecord,
  type AttemptStatus,
  type AttemptUsage,
  type AttemptUsageSource,
  type SafeExecutionTaskRecord,
  type SafeExecutionTaskStatus,
  type TaskEffectMode,
  type TaskRunId,
  type WorkspaceLockHandle,
  type WorkspaceLockRecord,
  type WorkspaceLockStore,
  type WorkspaceRunId,
} from "@vioxen/subscription-runtime/worker-core";

export type LocalFileSafeExecutionStoreOptions = {
  readonly rootDir: string;
};

export type LocalFileSafeExecutionStores = {
  readonly lockStore: WorkspaceLockStore;
  readonly journal: AttemptJournal;
};

export function createLocalFileSafeExecutionStores(
  options: LocalFileSafeExecutionStoreOptions,
): LocalFileSafeExecutionStores {
  return {
    lockStore: new LocalFileWorkspaceLockStore(
      join(options.rootDir, "workspace-locks"),
    ),
    journal: new LocalFileAttemptJournal(
      join(options.rootDir, "attempt-journal"),
    ),
  };
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
        throw workspaceLockedError(
          existing ?? {
            taskId: "unknown",
            workspacePath,
            ownerId: "unknown",
            acquiredAt: now,
          },
        );
      }
    }

    throw new SafeExecutionError(
      "safe_execution_workspace_locked",
      "Workspace lock could not be acquired after stale cleanup.",
      { details: { workspacePath } },
    );
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
    readonly resumeCompleted?: boolean;
  }): Promise<SafeExecutionTaskRecord> {
    const existing = await this.readTask({ taskId: input.taskId });
    const record: SafeExecutionTaskRecord = existing
      ? resumedTaskRecord(existing, input.now, input.resumeCompleted === true)
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
      ...(input.message === undefined
        ? {}
        : { lastFailureMessage: input.message }),
      ...(input.details === undefined
        ? {}
        : { lastFailureDetails: input.details }),
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

function resumedTaskRecord(
  existing: SafeExecutionTaskRecord,
  now: Date,
  resumeCompleted: boolean,
): SafeExecutionTaskRecord {
  if (existing.status !== "completed" || !resumeCompleted) {
    return {
      ...existing,
      status: existing.status === "completed" ? "completed" : "running",
      updatedAt: now,
    };
  }
  const {
    completedAt: _completedAt,
    result: _result,
    lastFailureReason: _lastFailureReason,
    lastFailureMessage: _lastFailureMessage,
    lastFailureDetails: _lastFailureDetails,
    ...resumable
  } = existing;
  return {
    ...resumable,
    status: "running",
    updatedAt: now,
  };
}

async function canonicalWorkspacePath(path: string): Promise<string> {
  const resolved = resolve(path);
  return realpath(resolved).catch(() => resolved);
}

function workspaceLockKey(workspacePath: string): string {
  return hashText(workspacePath);
}

function canReplaceLock(record: WorkspaceLockRecord, now: Date): boolean {
  const ownerProcessAlive =
    record.ownerPid === undefined ? undefined : isProcessAlive(record.ownerPid);
  return shouldReplaceSafeExecutionWorkspaceLock({
    acquiredAt: record.acquiredAt,
    now,
    ...(record.staleLockMs === undefined
      ? {}
      : { staleLockMs: record.staleLockMs }),
    ...(record.ownerPid === undefined ? {} : { ownerPid: record.ownerPid }),
    ...(ownerProcessAlive === undefined ? {} : { ownerProcessAlive }),
  });
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
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
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

function parseAttemptPatchStats(value: unknown): AttemptPatchStats | undefined {
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

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
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
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
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
  throw new Error("safe_execution_invalid_attempt.status");
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
): value is AttemptPatchStats["source"] {
  return (
    value === "git_numstat_delta" ||
    value === "git_numstat_delta_dirty_baseline" ||
    value === "unavailable"
  );
}
