import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

export type ProjectControlOperationToolName =
  | "codex_goal_project_refill_worker";

export enum ProjectControlOperationStatus {
  Queued = "queued",
  Running = "running",
  Completed = "completed",
  Failed = "failed",
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
}): Promise<ProjectControlOperationRunResult> {
  const initial = await patchProjectControlOperation({
    operationFilePath: input.operationFilePath,
    patch: {
      status: ProjectControlOperationStatus.Running,
      runningAt: new Date().toISOString(),
      runner: {
        hostname: hostname(),
        pid: process.pid,
        command: process.argv,
        startedAt: new Date().toISOString(),
      },
    },
  });
  try {
    const result = await input.invokeTool(initial.toolName, {
      ...initial.args,
      executionMode: "sync",
    });
    const resultRecord = jsonRecordFromUnknown(result);
    await mkdir(dirname(initial.resultPath), { recursive: true, mode: 0o700 });
    await writeFile(initial.resultPath, `${JSON.stringify(resultRecord, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const ok = resultRecord.ok !== false;
    const finishedAt = new Date().toISOString();
    const operation = await patchProjectControlOperation({
      operationFilePath: input.operationFilePath,
      patch: {
        status: ok
          ? ProjectControlOperationStatus.Completed
          : ProjectControlOperationStatus.Failed,
        ...(ok ? { completedAt: finishedAt } : { failedAt: finishedAt }),
        result: resultRecord,
        ...(ok ? {} : { error: projectControlOperationError(resultRecord) }),
      },
    });
    return { ok, operation };
  } catch (error) {
    const operation = await patchProjectControlOperation({
      operationFilePath: input.operationFilePath,
      patch: {
        status: ProjectControlOperationStatus.Failed,
        failedAt: new Date().toISOString(),
        error: error instanceof Error
          ? error.message
          : "project_control_operation_failed",
      },
    });
    return { ok: false, operation };
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
  await mkdir(dirname(record.operationFilePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${record.operationFilePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmpPath, record.operationFilePath);
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
