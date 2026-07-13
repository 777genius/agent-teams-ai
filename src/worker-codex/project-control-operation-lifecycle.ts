import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import {
  DurableJsonPublishStatus,
  type ProjectControlOperationClaimEnvironment,
  durablePublishJsonFile,
  durableReplaceJsonFile,
  tryAcquireProjectControlOperationClaim,
} from "./project-control-operation-file-store";

export {
  recoverProjectControlOperations,
  type ProjectControlOperationRecoverySummary,
} from "./project-control-operation-recovery";

export type ProjectControlOperationToolName =
  | "codex_goal_project_refill_worker";

export enum ProjectControlOperationStatus {
  Queued = "queued",
  Running = "running",
  Completed = "completed",
  Failed = "failed",
}

export enum ProjectControlOperationRunDisposition {
  Executed = "executed",
  Reconciled = "reconciled",
  AlreadyRunning = "already_running",
  TerminalReplay = "terminal_replay",
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonRecord = { readonly [key: string]: JsonValue };

export type ProjectControlOperationRecord = {
  readonly operationId: string;
  readonly toolName: ProjectControlOperationToolName;
  readonly status: ProjectControlOperationStatus;
  readonly controllerJobId: string;
  readonly targetJobId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly requestDigest: string;
  readonly args: JsonRecord;
  readonly operationFilePath: string;
  readonly resultPath: string;
  readonly logPath: string;
  readonly runner?: {
    readonly hostname: string;
    readonly pid: number;
    readonly command: readonly string[];
    readonly startedAt: string;
  };
  readonly runningAt?: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
  readonly attemptCount?: number;
  readonly lastAttempt?: {
    readonly attemptId: string;
    readonly claimId: string;
    readonly number: number;
    readonly startedAt: string;
    readonly recovery: boolean;
    readonly recoveredFromStatus?: ProjectControlOperationStatus;
  };
  readonly recovery?: {
    readonly count: number;
    readonly lastRecoveredAt: string;
    readonly lastRecoveredFromStatus: ProjectControlOperationStatus;
  };
  readonly result?: JsonRecord;
  readonly error?: string;
};

export type ProjectControlOperationView = Omit<
  ProjectControlOperationRecord,
  "args" | "result"
> & {
  readonly result?: JsonRecord;
};

export type ProjectControlOperationRunResult = {
  readonly ok: boolean;
  readonly operation: ProjectControlOperationRecord;
  readonly disposition?: ProjectControlOperationRunDisposition;
};

export function projectControlOperationsRoot(controllerJobRootDir: string): string {
  return join(controllerJobRootDir, "project-control-operations");
}

export function projectControlOperationFilePath(input: {
  readonly operationsRootDir: string;
  readonly operationId: string;
}): string {
  assertProjectControlOperationId(input.operationId);
  return join(input.operationsRootDir, input.operationId, "operation.json");
}

export async function createProjectControlOperation(input: {
  readonly operationsRootDir: string;
  readonly controllerJobId: string;
  readonly toolName: ProjectControlOperationToolName;
  readonly args: JsonRecord;
  readonly targetJobId?: string;
}): Promise<ProjectControlOperationRecord> {
  const requestDigest = projectControlOperationRequestDigest(input);
  // Structural launch failures are deterministic for an unchanged request.
  // External-state failures remain retryable; corrected input gets a new digest.
  const blockedBy = await identicalFailedOperation({
    operationsRootDir: input.operationsRootDir,
    requestDigest,
  });
  if (blockedBy) {
    throw new Error(
      `project_control_operation_identical_failed_request_blocked:${blockedBy.operationId}`,
    );
  }
  const operationId = `project-control-${compactTimestamp(new Date())}-${randomUUID().slice(0, 8)}`;
  const operationDir = join(input.operationsRootDir, operationId);
  const now = new Date().toISOString();
  const record: ProjectControlOperationRecord = {
    operationId,
    toolName: input.toolName,
    status: ProjectControlOperationStatus.Queued,
    controllerJobId: input.controllerJobId,
    ...(input.targetJobId === undefined ? {} : { targetJobId: input.targetJobId }),
    createdAt: now,
    updatedAt: now,
    requestDigest,
    args: input.args,
    operationFilePath: join(operationDir, "operation.json"),
    resultPath: join(operationDir, "result.json"),
    logPath: join(operationDir, "runner.log"),
  };
  await writeProjectControlOperation(record);
  return record;
}

export async function readProjectControlOperation(
  operationFilePath: string,
): Promise<ProjectControlOperationRecord> {
  return parseProjectControlOperationRecord(
    JSON.parse(await readFile(operationFilePath, "utf8")),
  );
}

export async function readProjectControlOperationById(input: {
  readonly operationsRootDir: string;
  readonly operationId: string;
}): Promise<ProjectControlOperationRecord> {
  return readProjectControlOperation(projectControlOperationFilePath(input));
}

export async function patchProjectControlOperation(input: {
  readonly operationFilePath: string;
  readonly patch: Partial<Omit<ProjectControlOperationRecord, "operationId" | "operationFilePath">>;
}): Promise<ProjectControlOperationRecord> {
  const current = await readProjectControlOperation(input.operationFilePath);
  const record: ProjectControlOperationRecord = {
    ...current,
    ...input.patch,
    operationId: current.operationId,
    operationFilePath: current.operationFilePath,
    updatedAt: new Date().toISOString(),
  };
  await writeProjectControlOperation(record);
  return record;
}

export async function startProjectControlOperationRunner(input: {
  readonly operationFilePath: string;
  readonly cwd?: string;
  readonly cliPath?: string;
}): Promise<{
  readonly pid: number;
  readonly command: readonly string[];
}> {
  const cliPath = input.cliPath ??
    process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_OPERATION_CLI_PATH ??
    defaultCodexGoalCliPath();
  const command = [
    execPath,
    cliPath,
    "project-control-operation-run",
    "--operation-file",
    input.operationFilePath,
    "--format",
    "json",
  ];
  const child = spawn(command[0] as string, command.slice(1), {
    cwd: input.cwd,
    detached: true,
    env: {
      ...process.env,
      SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_OPERATION_RUNNER: "1",
    },
    stdio: "ignore",
  });
  if (child.pid === undefined) {
    throw new Error("project_control_operation_runner_pid_missing");
  }
  child.unref();
  return { pid: child.pid, command };
}

export async function runProjectControlOperationFile(input: {
  readonly operationFilePath: string;
  readonly invokeTool: (
    toolName: ProjectControlOperationToolName,
    args: JsonRecord,
  ) => Promise<unknown>;
  readonly recovery?: boolean;
  readonly claimEnvironment?: ProjectControlOperationClaimEnvironment;
  readonly heartbeatIntervalMs?: number;
}): Promise<ProjectControlOperationRunResult> {
  const observed = await readProjectControlOperation(input.operationFilePath);
  if (operationIsTerminal(observed)) {
    return terminalReplay(observed);
  }
  if (operationRunnerIsActive(observed, input.claimEnvironment)) {
    return {
      ok: true,
      operation: observed,
      disposition: ProjectControlOperationRunDisposition.AlreadyRunning,
    };
  }

  const claim = await tryAcquireProjectControlOperationClaim({
    operationId: observed.operationId,
    operationFilePath: input.operationFilePath,
    ...(input.claimEnvironment === undefined
      ? {}
      : { environment: input.claimEnvironment }),
  });
  if (!claim) {
    return {
      ok: true,
      operation: await readProjectControlOperation(input.operationFilePath),
      disposition: ProjectControlOperationRunDisposition.AlreadyRunning,
    };
  }

  const leaseDurationMs = input.claimEnvironment?.leaseDurationMs ?? 5 * 60_000;
  const heartbeatIntervalMs = input.heartbeatIntervalMs ??
    Math.max(1_000, Math.floor(leaseDurationMs / 3));
  const heartbeat = setInterval(() => {
    void claim.renew().catch(() => undefined);
  }, heartbeatIntervalMs);
  heartbeat.unref();

  try {
    const current = await readProjectControlOperation(input.operationFilePath);
    if (operationIsTerminal(current)) return terminalReplay(current);

    const persistedResult = await readProjectControlOperationResult(current.resultPath);
    if (persistedResult) {
      const recoveredAt = operationNow(input.claimEnvironment).toISOString();
      const operation = await finalizeProjectControlOperation({
        operationFilePath: input.operationFilePath,
        result: persistedResult,
        recovery: {
          count: (current.recovery?.count ?? 0) + 1,
          lastRecoveredAt: recoveredAt,
          lastRecoveredFromStatus: current.status,
        },
        ...(input.claimEnvironment === undefined
          ? {}
          : { claimEnvironment: input.claimEnvironment }),
      });
      return {
        ok: operation.status === ProjectControlOperationStatus.Completed,
        operation,
        disposition: ProjectControlOperationRunDisposition.Reconciled,
      };
    }

    const startedAt = operationNow(input.claimEnvironment).toISOString();
    const recovery = input.recovery === true ||
      current.status === ProjectControlOperationStatus.Running ||
      (current.attemptCount ?? 0) > 0;
    const attemptNumber = (current.attemptCount ?? 0) + 1;
    const initial = await patchProjectControlOperation({
      operationFilePath: input.operationFilePath,
      patch: {
        status: ProjectControlOperationStatus.Running,
        runningAt: startedAt,
        attemptCount: attemptNumber,
        lastAttempt: {
          attemptId: randomUUID(),
          claimId: claim.record.claimId,
          number: attemptNumber,
          startedAt,
          recovery,
          ...(recovery ? { recoveredFromStatus: current.status } : {}),
        },
        ...(recovery
          ? {
              recovery: {
                count: (current.recovery?.count ?? 0) + 1,
                lastRecoveredAt: startedAt,
                lastRecoveredFromStatus: current.status,
              },
            }
          : {}),
        runner: {
          hostname: input.claimEnvironment?.hostname ?? hostname(),
          pid: input.claimEnvironment?.pid ?? process.pid,
          command: process.argv,
          startedAt,
        },
      },
    });
    let resultRecord: JsonRecord;
    try {
      const result = await input.invokeTool(initial.toolName, {
        ...initial.args,
        executionMode: "sync",
      });
      resultRecord = jsonRecordFromUnknown(result);
    } catch (error) {
      const operation = await patchProjectControlOperation({
        operationFilePath: input.operationFilePath,
        patch: {
          status: ProjectControlOperationStatus.Failed,
          failedAt: operationNow(input.claimEnvironment).toISOString(),
          error: error instanceof Error
            ? error.message
            : "project_control_operation_failed",
        },
      });
      return {
        ok: false,
        operation,
        disposition: ProjectControlOperationRunDisposition.Executed,
      };
    }

    const publication = await durablePublishJsonFile({
      path: initial.resultPath,
      value: resultRecord,
    });
    if (publication === DurableJsonPublishStatus.AlreadyExists) {
      resultRecord = await requiredProjectControlOperationResult(initial.resultPath);
    }
    const operation = await finalizeProjectControlOperation({
      operationFilePath: input.operationFilePath,
      result: resultRecord,
      ...(input.claimEnvironment === undefined
        ? {}
        : { claimEnvironment: input.claimEnvironment }),
    });
    return {
      ok: operation.status === ProjectControlOperationStatus.Completed,
      operation,
      disposition: ProjectControlOperationRunDisposition.Executed,
    };
  } finally {
    clearInterval(heartbeat);
    await claim.release();
  }
}

async function finalizeProjectControlOperation(input: {
  readonly operationFilePath: string;
  readonly result: JsonRecord;
  readonly claimEnvironment?: ProjectControlOperationClaimEnvironment;
  readonly recovery?: ProjectControlOperationRecord["recovery"];
}): Promise<ProjectControlOperationRecord> {
  const ok = input.result.ok !== false;
  const finishedAt = operationNow(input.claimEnvironment).toISOString();
  return patchProjectControlOperation({
    operationFilePath: input.operationFilePath,
    patch: {
      status: ok
        ? ProjectControlOperationStatus.Completed
        : ProjectControlOperationStatus.Failed,
      ...(ok ? { completedAt: finishedAt } : { failedAt: finishedAt }),
      ...(input.recovery === undefined ? {} : { recovery: input.recovery }),
      result: input.result,
      ...(ok ? {} : { error: projectControlOperationError(input.result) }),
    },
  });
}

async function readProjectControlOperationResult(
  resultPath: string,
): Promise<JsonRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(resultPath, "utf8")) as unknown;
    if (!isRecord(value)) {
      throw new Error("project_control_operation_result_invalid");
    }
    return jsonRecordFromUnknown(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function requiredProjectControlOperationResult(
  resultPath: string,
): Promise<JsonRecord> {
  const result = await readProjectControlOperationResult(resultPath);
  if (!result) throw new Error("project_control_operation_result_missing");
  return result;
}

function terminalReplay(
  operation: ProjectControlOperationRecord,
): ProjectControlOperationRunResult {
  return {
    ok: operation.status === ProjectControlOperationStatus.Completed,
    operation,
    disposition: ProjectControlOperationRunDisposition.TerminalReplay,
  };
}

function operationIsTerminal(operation: ProjectControlOperationRecord): boolean {
  return operation.status === ProjectControlOperationStatus.Completed ||
    operation.status === ProjectControlOperationStatus.Failed;
}

function operationRunnerIsActive(
  operation: ProjectControlOperationRecord,
  environment: ProjectControlOperationClaimEnvironment | undefined,
): boolean {
  if (!operation.runner) return false;
  const localHostname = environment?.hostname ?? hostname();
  const localPid = environment?.pid ?? process.pid;
  if (
    operation.runner.hostname === localHostname &&
    operation.runner.pid === localPid
  ) {
    return false;
  }
  if (operation.runner.hostname === localHostname) {
    return (environment?.isProcessAlive ?? localProcessIsAlive)(operation.runner.pid);
  }
  const leaseDurationMs = environment?.leaseDurationMs ?? 5 * 60_000;
  return Date.parse(operation.runner.startedAt) + leaseDurationMs >
    operationNow(environment).getTime();
}

function operationNow(
  environment: ProjectControlOperationClaimEnvironment | undefined,
): Date {
  return environment?.now?.() ?? new Date();
}

function localProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function projectControlOperationView(input: {
  readonly operation: ProjectControlOperationRecord;
  readonly includeResult?: boolean;
}): ProjectControlOperationView {
  const { args: _args, result, ...view } = input.operation;
  return {
    ...view,
    ...(input.includeResult === true && result !== undefined ? { result } : {}),
  };
}

export function projectControlOperationExecutionMode(value: unknown):
  | "sync"
  | "bounded" {
  if (value === undefined || value === "sync") return "sync";
  if (value === "bounded" || value === "async") return "bounded";
  throw new Error("executionMode must be sync, bounded or async");
}

function defaultCodexGoalCliPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "codex-goal-cli.js");
}

async function writeProjectControlOperation(
  record: ProjectControlOperationRecord,
): Promise<void> {
  await durableReplaceJsonFile({
    path: record.operationFilePath,
    value: record,
  });
}

function parseProjectControlOperationRecord(
  value: unknown,
): ProjectControlOperationRecord {
  if (!isRecord(value)) throw new Error("project_control_operation_invalid");
  const operationId = requiredString(value.operationId, "operationId");
  assertProjectControlOperationId(operationId);
  const status = projectControlOperationStatus(value.status);
  const toolName = projectControlOperationToolName(value.toolName);
  return {
    operationId,
    toolName,
    status,
    controllerJobId: requiredString(value.controllerJobId, "controllerJobId"),
    ...(typeof value.targetJobId === "string" ? { targetJobId: value.targetJobId } : {}),
    createdAt: requiredString(value.createdAt, "createdAt"),
    updatedAt: requiredString(value.updatedAt, "updatedAt"),
    requestDigest: typeof value.requestDigest === "string"
      ? value.requestDigest
      : projectControlOperationRequestDigest({
          toolName,
          controllerJobId: requiredString(
            value.controllerJobId,
            "controllerJobId",
          ),
          ...(typeof value.targetJobId === "string"
            ? { targetJobId: value.targetJobId }
            : {}),
          args: jsonRecordFromUnknown(value.args),
        }),
    args: jsonRecordFromUnknown(value.args),
    operationFilePath: requiredString(value.operationFilePath, "operationFilePath"),
    resultPath: requiredString(value.resultPath, "resultPath"),
    logPath: requiredString(value.logPath, "logPath"),
    ...(isRecord(value.runner)
      ? {
          runner: {
            hostname: requiredString(value.runner.hostname, "runner.hostname"),
            pid: requiredNumber(value.runner.pid, "runner.pid"),
            command: jsonStringArray(value.runner.command, "runner.command"),
            startedAt: requiredString(value.runner.startedAt, "runner.startedAt"),
          },
        }
      : {}),
    ...(typeof value.runningAt === "string" ? { runningAt: value.runningAt } : {}),
    ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}),
    ...(typeof value.failedAt === "string" ? { failedAt: value.failedAt } : {}),
    ...(typeof value.attemptCount === "number"
      ? { attemptCount: requiredNonNegativeInteger(value.attemptCount, "attemptCount") }
      : {}),
    ...(isRecord(value.lastAttempt)
      ? {
          lastAttempt: {
            attemptId: requiredString(
              value.lastAttempt.attemptId,
              "lastAttempt.attemptId",
            ),
            claimId: requiredString(
              value.lastAttempt.claimId,
              "lastAttempt.claimId",
            ),
            number: requiredPositiveInteger(
              value.lastAttempt.number,
              "lastAttempt.number",
            ),
            startedAt: requiredString(
              value.lastAttempt.startedAt,
              "lastAttempt.startedAt",
            ),
            recovery: requiredBoolean(
              value.lastAttempt.recovery,
              "lastAttempt.recovery",
            ),
            ...(value.lastAttempt.recoveredFromStatus === undefined
              ? {}
              : {
                  recoveredFromStatus: projectControlOperationStatus(
                    value.lastAttempt.recoveredFromStatus,
                  ),
                }),
          },
        }
      : {}),
    ...(isRecord(value.recovery)
      ? {
          recovery: {
            count: requiredPositiveInteger(
              value.recovery.count,
              "recovery.count",
            ),
            lastRecoveredAt: requiredString(
              value.recovery.lastRecoveredAt,
              "recovery.lastRecoveredAt",
            ),
            lastRecoveredFromStatus: projectControlOperationStatus(
              value.recovery.lastRecoveredFromStatus,
            ),
          },
        }
      : {}),
    ...(isRecord(value.result) ? { result: jsonRecordFromUnknown(value.result) } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

function projectControlOperationStatus(value: unknown): ProjectControlOperationStatus {
  if (
    value === ProjectControlOperationStatus.Queued ||
    value === ProjectControlOperationStatus.Running ||
    value === ProjectControlOperationStatus.Completed ||
    value === ProjectControlOperationStatus.Failed
  ) {
    return value;
  }
  throw new Error("project_control_operation_status_invalid");
}

function projectControlOperationToolName(value: unknown): ProjectControlOperationToolName {
  if (value === "codex_goal_project_refill_worker") return value;
  throw new Error("project_control_operation_tool_invalid");
}

function projectControlOperationError(result: JsonRecord): string {
  if (typeof result.error === "string") return result.error;
  if (typeof result.reason === "string") return result.reason;
  return "project_control_operation_result_not_ok";
}

async function identicalFailedOperation(input: {
  readonly operationsRootDir: string;
  readonly requestDigest: string;
}): Promise<ProjectControlOperationRecord | undefined> {
  let entries;
  try {
    entries = await readdir(input.operationsRootDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const candidates = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      try {
        return await readProjectControlOperation(
          join(input.operationsRootDir, entry.name, "operation.json"),
        );
      } catch {
        return undefined;
      }
    }));
  return candidates
    .filter((candidate): candidate is ProjectControlOperationRecord =>
      candidate !== undefined &&
      candidate.status === ProjectControlOperationStatus.Failed &&
      candidate.requestDigest === input.requestDigest &&
      retryProtectedOperationError(candidate.error)
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function retryProtectedOperationError(error: string | undefined): boolean {
  return typeof error === "string" &&
    (
      error.startsWith("worker_launch_") ||
      error.startsWith("project_control_pre_start_builtin_materialization_") ||
      error.startsWith("project_control_pre_start_contract_") ||
      error.startsWith("project_control_pre_start_state_") ||
      error === "project_control_pre_start_serial_maxInFlight_expected_1" ||
      error === "project_control_pre_start_serial_single_record_required"
    );
}

function projectControlOperationRequestDigest(input: {
  readonly controllerJobId: string;
  readonly toolName: ProjectControlOperationToolName;
  readonly targetJobId?: string;
  readonly args: JsonRecord;
}): string {
  return createHash("sha256").update(stableJson({
    controllerJobId: input.controllerJobId,
    toolName: input.toolName,
    targetJobId: input.targetJobId ?? null,
    args: input.args,
  })).digest("hex");
}

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key] as JsonValue)}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function jsonRecordFromUnknown(value: unknown): JsonRecord {
  if (!isRecord(value)) return { value: String(value) };
  return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

function jsonStringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${name}_invalid`);
  }
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name}_required`);
  }
  return value;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name}_required`);
  }
  return value;
}

function requiredNonNegativeInteger(value: unknown, name: string): number {
  const parsed = requiredNumber(value, name);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name}_invalid`);
  return parsed;
}

function requiredPositiveInteger(value: unknown, name: string): number {
  const parsed = requiredNumber(value, name);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name}_invalid`);
  return parsed;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name}_required`);
  return value;
}

function assertProjectControlOperationId(value: string): void {
  if (!/^[A-Za-z0-9_.:-]+$/.test(value)) {
    throw new Error("project_control_operation_id_invalid");
  }
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "").replace("T", "T").replace("Z", "Z");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
