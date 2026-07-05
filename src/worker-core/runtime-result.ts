import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultGitCommandTimeoutMs = 10_000;

export type RuntimeResultStatus = "done" | "partial" | "blocked" | "failed";

export type RuntimeRecommendedAction =
  | "wait"
  | "wait_with_limit"
  | "continue"
  | "recover"
  | "stop"
  | "preserve_patch"
  | "switch_account"
  | "ask_user"
  | "launch_next_slice"
  | "review_completed";

export type RunProgressClassification =
  | "productive"
  | "quiet_build"
  | "stale_no_progress"
  | "stale_with_dirty_patch"
  | "provider_capacity_unavailable"
  | "auth_or_quota_blocked"
  | "app_server_goal_blocked"
  | "zombie_orphan"
  | "unknown_error";

export type WorkerReport = {
  readonly outcome?: RuntimeResultStatus;
  readonly evidence?: readonly string[];
  readonly blockers?: readonly string[];
  readonly nextActionHint?: string;
  readonly summary?: string;
};

export type RuntimeResultArtifact = {
  readonly kind: string;
  readonly path?: string;
  readonly byteLength?: number;
};

export type RuntimeResultEnvelope = {
  readonly status: RuntimeResultStatus;
  readonly changedFiles: readonly string[];
  readonly evidence: readonly string[];
  readonly blockers: readonly string[];
  readonly nextAction: RuntimeRecommendedAction;
  readonly schemaVersion?: 1;
  readonly provider?: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly classification?: RunProgressClassification;
  readonly reason?: string;
  readonly details?: Readonly<Record<string, string>>;
  readonly artifacts?: readonly RuntimeResultArtifact[];
  readonly updatedAt?: string;
};

export type RuntimeResultWriterPort = {
  writeResult(input: {
    readonly path: string;
    readonly result: RuntimeResultEnvelope;
  }): Promise<void>;
};

export type RuntimeResultEnvelopeInput = {
  readonly status?: RuntimeResultStatus | undefined;
  readonly provider?: string | undefined;
  readonly runId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly classification?: RunProgressClassification | undefined;
  readonly reason?: string | undefined;
  readonly details?: Readonly<Record<string, string>> | undefined;
  readonly changedFiles?: readonly string[] | undefined;
  readonly evidence?: readonly string[] | undefined;
  readonly blockers?: readonly string[] | undefined;
  readonly nextAction?: RuntimeRecommendedAction | undefined;
  readonly workerReport?: WorkerReport | undefined;
  readonly artifacts?: readonly RuntimeResultArtifact[] | undefined;
  readonly updatedAt?: Date | undefined;
};

export type RuntimeRunStateInput = {
  readonly status?: string | undefined;
  readonly liveness?: string | undefined;
  readonly workspaceDirty?: boolean | undefined;
  readonly changedFilesCount?: number | undefined;
  readonly processAlive?: boolean | undefined;
  readonly processCpuActive?: boolean | undefined;
  readonly processCommand?: string | undefined;
  readonly progressStatus?: string | undefined;
  readonly progressStale?: boolean | undefined;
  readonly progressSilentStale?: boolean | undefined;
  readonly heartbeatOnlyNoOutput?: boolean | undefined;
  readonly resultExists?: boolean | undefined;
  readonly resultStatus?: string | undefined;
  readonly resultReason?: string | undefined;
  readonly logStale?: boolean | undefined;
  readonly logByteLength?: number | undefined;
  readonly logGrew?: boolean | undefined;
  readonly resultChanged?: boolean | undefined;
  readonly workspaceChanged?: boolean | undefined;
  readonly capacity?: readonly {
    readonly status?: string | undefined;
    readonly availability?: string | undefined;
    readonly reason?: string | undefined;
  }[] | undefined;
  readonly controlInboxPendingCount?: number | undefined;
};

export class AtomicJsonRuntimeResultWriter implements RuntimeResultWriterPort {
  async writeResult(input: {
    readonly path: string;
    readonly result: RuntimeResultEnvelope;
  }): Promise<void> {
    await writeAtomicJson(input.path, input.result);
  }
}

export class StrictResultRecorder {
  private readonly writer: RuntimeResultWriterPort;
  private readonly clock: { now(): Date };

  constructor(private readonly options: {
    readonly outputPath: string;
    readonly writer?: RuntimeResultWriterPort;
    readonly clock?: { now(): Date };
  }) {
    if (!options.outputPath.trim()) {
      throw new Error("runtime_result_output_path_required");
    }
    this.writer = options.writer ?? new AtomicJsonRuntimeResultWriter();
    this.clock = options.clock ?? systemClock;
  }

  async record(input: RuntimeResultEnvelopeInput): Promise<RuntimeResultEnvelope> {
    const envelope = buildRuntimeResultEnvelope({
      ...input,
      updatedAt: input.updatedAt ?? this.clock.now(),
    });
    await this.recordEnvelope(envelope);
    return envelope;
  }

  async recordEnvelope(envelope: RuntimeResultEnvelope): Promise<void> {
    await this.writer.writeResult({
      path: this.options.outputPath,
      result: envelope,
    });
  }
}

export class GitPatchPreserver {
  constructor(private readonly options: {
    readonly gitBinaryPath?: string;
  } = {}) {}

  async preserve(input: {
    readonly workspacePath: string;
    readonly outputPath: string;
  }): Promise<RuntimeResultArtifact | null> {
    const gitBinaryPath = this.options.gitBinaryPath ?? "git";
    const hasHead = await gitHasHead({
      gitBinaryPath,
      workspacePath: input.workspacePath,
    });
    const trackedPatch = await gitDiff({
      gitBinaryPath,
      workspacePath: input.workspacePath,
      args: hasHead
        ? ["diff", "--binary", "HEAD", "--"]
        : ["diff", "--binary", "--"],
    });
    const untrackedPatch = await gitUntrackedPatch({
      gitBinaryPath,
      workspacePath: input.workspacePath,
    });
    const patch = [trackedPatch, untrackedPatch]
      .map((value) => value.trimEnd())
      .filter(Boolean)
      .join("\n");
    if (!patch.trim()) return null;
    await mkdir(dirname(input.outputPath), { recursive: true, mode: 0o700 });
    await writeFile(input.outputPath, `${patch}\n`, { encoding: "utf8", mode: 0o600 });
    const item = await stat(input.outputPath);
    return {
      kind: "patch",
      path: input.outputPath,
      byteLength: item.size,
    };
  }
}

async function gitHasHead(input: {
  readonly gitBinaryPath: string;
  readonly workspacePath: string;
}): Promise<boolean> {
  try {
    await execFileAsync(input.gitBinaryPath, [
      "-C",
      input.workspacePath,
      "rev-parse",
      "--verify",
      "HEAD",
    ], { timeout: defaultGitCommandTimeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function gitDiff(input: {
  readonly gitBinaryPath: string;
  readonly workspacePath: string;
  readonly args: readonly string[];
}): Promise<string> {
  try {
    const { stdout } = await execFileAsync(input.gitBinaryPath, [
      "-C",
      input.workspacePath,
      ...input.args,
    ], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: defaultGitCommandTimeoutMs,
    });
    return stdout;
  } catch (error) {
    if (isExecErrorWithStdout(error)) return error.stdout;
    throw error;
  }
}

async function gitUntrackedPatch(input: {
  readonly gitBinaryPath: string;
  readonly workspacePath: string;
}): Promise<string> {
  const { stdout } = await execFileAsync(input.gitBinaryPath, [
    "-C",
    input.workspacePath,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: defaultGitCommandTimeoutMs,
  });
  const paths = stdout.split("\0").filter(Boolean);
  const patches = await Promise.all(paths.map((path) =>
    gitDiff({
      gitBinaryPath: input.gitBinaryPath,
      workspacePath: input.workspacePath,
      args: ["diff", "--binary", "--no-index", "--", "/dev/null", path],
    })
  ));
  return patches.join("\n");
}

export function buildRuntimeResultEnvelope(
  input: RuntimeResultEnvelopeInput,
): RuntimeResultEnvelope {
  const status = input.status ??
    input.workerReport?.outcome ??
    statusFromClassification(input.classification);
  const changedFiles = uniqueStrings(input.changedFiles ?? []);
  const evidence = uniqueStrings([
    ...(input.evidence ?? []),
    ...(input.workerReport?.summary ? [input.workerReport.summary] : []),
    ...(input.workerReport?.evidence ?? []),
  ]);
  const blockers = status === "done"
    ? []
    : uniqueStrings([
        ...(input.blockers ?? []),
        ...(input.workerReport?.blockers ?? []),
      ]);
  const nextAction = input.nextAction ??
    actionForRuntimeState({
      status,
      classification: input.classification,
      reason: input.reason,
      changedFilesCount: changedFiles.length,
      workerHint: input.workerReport?.nextActionHint,
    });
  return {
    status,
    changedFiles,
    evidence,
    blockers,
    nextAction,
    schemaVersion: 1,
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.classification === undefined
      ? {}
      : { classification: input.classification }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.details === undefined ? {} : { details: input.details }),
    ...(input.artifacts === undefined || input.artifacts.length === 0
      ? {}
      : { artifacts: input.artifacts }),
    updatedAt: (input.updatedAt ?? new Date()).toISOString(),
  };
}

export function normalizeWorkerReport(value: unknown): WorkerReport | undefined {
  if (!isRecord(value)) return undefined;
  const outcome = runtimeResultStatus(value.outcome);
  const evidence = stringArray(value.evidence);
  const blockers = stringArray(value.blockers);
  const nextActionHint = typeof value.nextActionHint === "string"
    ? value.nextActionHint.trim()
    : undefined;
  const summary = typeof value.summary === "string"
    ? value.summary.trim()
    : undefined;
  if (
    outcome === undefined &&
    evidence === undefined &&
    blockers === undefined &&
    nextActionHint === undefined &&
    summary === undefined
  ) {
    return undefined;
  }
  return {
    ...(outcome === undefined ? {} : { outcome }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(blockers === undefined ? {} : { blockers }),
    ...(nextActionHint === undefined ? {} : { nextActionHint }),
    ...(summary === undefined ? {} : { summary }),
  };
}

export function classifyRuntimeRunState(
  input: RuntimeRunStateInput,
): RunProgressClassification {
  if (
    input.status === "completed" ||
    input.resultStatus === "done" ||
    input.resultStatus === "completed"
  ) {
    return "productive";
  }
  if (input.capacity && hasOnlyAuthOrQuotaBlockedCapacity(input.capacity)) {
    return "auth_or_quota_blocked";
  }
  if (input.capacity && hasOnlyBlockedCapacity(input.capacity)) {
    return "provider_capacity_unavailable";
  }
  if (
    input.resultStatus === "waiting_for_input" ||
    input.resultStatus === "blocked" ||
    input.resultReason === "app_server_goal_blocked" ||
    input.progressStatus === "blocked" ||
    (input.controlInboxPendingCount ?? 0) > 0
  ) {
    return "app_server_goal_blocked";
  }

  const dirty = Boolean(input.workspaceDirty || (input.changedFilesCount ?? 0) > 0);
  const stale = Boolean(
    input.progressSilentStale ||
      input.progressStale ||
      (input.logStale && input.liveness === "stale"),
  );
  const buildLikeCpuActive = Boolean(
    input.processAlive &&
      input.processCpuActive &&
      input.logStale &&
      isBuildLikeCommand(input.processCommand),
  );
  const observedGrowth = Boolean(
    input.logGrew ||
      input.resultChanged ||
      input.workspaceChanged,
  );

  if (
    input.processAlive &&
    input.resultExists === false &&
    input.progressStatus === undefined &&
    input.logStale
  ) {
    return "zombie_orphan";
  }
  if (buildLikeCpuActive) return "quiet_build";
  if (observedGrowth) return "productive";
  if (input.heartbeatOnlyNoOutput) return dirty
    ? "stale_with_dirty_patch"
    : "stale_no_progress";
  if (stale && dirty) return "stale_with_dirty_patch";
  if (stale) return "stale_no_progress";
  if (
    input.status === "running" ||
    input.liveness === "alive" ||
    input.progressStatus === "running" ||
    input.processCpuActive
  ) {
    return "productive";
  }
  return "unknown_error";
}

export function actionForRuntimeState(input: {
  readonly status: RuntimeResultStatus;
  readonly classification?: RunProgressClassification | undefined;
  readonly reason?: string | undefined;
  readonly changedFilesCount?: number | undefined;
  readonly workerHint?: string | undefined;
}): RuntimeRecommendedAction {
  if (input.status === "done") return "review_completed";
  switch (input.classification) {
    case "productive":
      return "wait";
    case "quiet_build":
      return "wait_with_limit";
    case "stale_with_dirty_patch":
      return "preserve_patch";
    case "stale_no_progress":
    case "zombie_orphan":
      return "recover";
    case "provider_capacity_unavailable":
    case "auth_or_quota_blocked":
      return "switch_account";
    case "app_server_goal_blocked":
      return "ask_user";
    case "unknown_error":
    case undefined:
      break;
  }
  if (isCapacityReason(input.reason)) return "switch_account";
  if (input.reason === "permission_required") return "ask_user";
  if ((input.changedFilesCount ?? 0) > 0) return "preserve_patch";
  if (input.status === "blocked") return "ask_user";
  if (input.workerHint === "launch_next_slice") return "launch_next_slice";
  return input.status === "failed" ? "recover" : "continue";
}

export async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = join(
    dirname(path),
    `.${Date.now()}-${process.pid}-${randomUUID()}-${basenameForTemp(path)}.tmp`,
  );
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempPath, path);
}

function statusFromClassification(
  classification: RunProgressClassification | undefined,
): RuntimeResultStatus {
  switch (classification) {
    case "provider_capacity_unavailable":
    case "auth_or_quota_blocked":
    case "app_server_goal_blocked":
      return "blocked";
    case "stale_with_dirty_patch":
      return "partial";
    case "stale_no_progress":
    case "zombie_orphan":
    case "unknown_error":
      return "failed";
    case "productive":
    case "quiet_build":
    case undefined:
      return "blocked";
  }
}

function runtimeResultStatus(value: unknown): RuntimeResultStatus | undefined {
  return value === "done" ||
      value === "partial" ||
      value === "blocked" ||
      value === "failed"
    ? value
    : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return uniqueStrings(value);
}

function uniqueStrings(values: readonly unknown[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function isBlockedCapacity(hint: {
  readonly status?: string | undefined;
  readonly availability?: string | undefined;
}): boolean {
  return hint.availability === "cooldown" ||
    hint.availability === "quota_exhausted" ||
    hint.availability === "disabled";
}

function isAuthOrQuotaBlockedCapacity(hint: {
  readonly status?: string | undefined;
  readonly availability?: string | undefined;
  readonly reason?: string | undefined;
}): boolean {
  return hint.status === "auth_missing" ||
    hint.status === "auth_invalid" ||
    hint.availability === "quota_exhausted" ||
    hint.reason === "quota_limited" ||
    hint.reason === "account_unavailable" ||
    hint.reason === "reconnect_required";
}

function hasOnlyBlockedCapacity(
  capacity: readonly {
    readonly status?: string | undefined;
    readonly availability?: string | undefined;
    readonly reason?: string | undefined;
  }[],
): boolean {
  return capacity.length > 0 && capacity.every((hint) => isBlockedCapacity(hint));
}

function hasOnlyAuthOrQuotaBlockedCapacity(
  capacity: readonly {
    readonly status?: string | undefined;
    readonly availability?: string | undefined;
    readonly reason?: string | undefined;
  }[],
): boolean {
  return capacity.length > 0 &&
    capacity.every((hint) => isAuthOrQuotaBlockedCapacity(hint));
}

function isCapacityReason(reason: string | undefined): boolean {
  return reason === "quota_limited" ||
    reason === "capacity_unavailable" ||
    reason === "account_unavailable" ||
    reason === "reconnect_required";
}

function isBuildLikeCommand(command: string | undefined): boolean {
  return command === undefined ||
    /\b(build|test|check|lint|tsc|vite|vitest|jest|pytest|cargo|gradle|mvn)\b/i
      .test(command);
}

function basenameForTemp(path: string): string {
  return path.split(/[\\/]/).at(-1)?.replace(/[^A-Za-z0-9_.-]/g, "_") ||
    "runtime-result";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExecErrorWithStdout(error: unknown): error is { readonly stdout: string } {
  return isRecord(error) && typeof error.stdout === "string";
}

const systemClock = {
  now(): Date {
    return new Date();
  },
};
