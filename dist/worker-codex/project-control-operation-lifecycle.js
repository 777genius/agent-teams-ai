import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
export var ProjectControlOperationStatus;
(function (ProjectControlOperationStatus) {
    ProjectControlOperationStatus["Queued"] = "queued";
    ProjectControlOperationStatus["Running"] = "running";
    ProjectControlOperationStatus["Completed"] = "completed";
    ProjectControlOperationStatus["Failed"] = "failed";
})(ProjectControlOperationStatus || (ProjectControlOperationStatus = {}));
export function projectControlOperationsRoot(controllerJobRootDir) {
    return join(controllerJobRootDir, "project-control-operations");
}
export function projectControlOperationFilePath(input) {
    assertProjectControlOperationId(input.operationId);
    return join(input.operationsRootDir, input.operationId, "operation.json");
}
export async function createProjectControlOperation(input) {
    const operationId = `project-control-${compactTimestamp(new Date())}-${randomUUID().slice(0, 8)}`;
    const operationDir = join(input.operationsRootDir, operationId);
    const now = new Date().toISOString();
    const record = {
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
export async function readProjectControlOperation(operationFilePath) {
    return parseProjectControlOperationRecord(JSON.parse(await readFile(operationFilePath, "utf8")));
}
export async function readProjectControlOperationById(input) {
    return readProjectControlOperation(projectControlOperationFilePath(input));
}
export async function patchProjectControlOperation(input) {
    const current = await readProjectControlOperation(input.operationFilePath);
    const record = {
        ...current,
        ...input.patch,
        operationId: current.operationId,
        operationFilePath: current.operationFilePath,
        updatedAt: new Date().toISOString(),
    };
    await writeProjectControlOperation(record);
    return record;
}
export async function startProjectControlOperationRunner(input) {
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
    const child = spawn(command[0], command.slice(1), {
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
export async function runProjectControlOperationFile(input) {
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
    }
    catch (error) {
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
export function projectControlOperationView(input) {
    const { args: _args, result, ...view } = input.operation;
    return {
        ...view,
        ...(input.includeResult === true && result !== undefined ? { result } : {}),
    };
}
export function projectControlOperationExecutionMode(value) {
    if (value === undefined || value === "sync")
        return "sync";
    if (value === "bounded" || value === "async")
        return "bounded";
    throw new Error("executionMode must be sync, bounded or async");
}
function defaultCodexGoalCliPath() {
    return join(dirname(fileURLToPath(import.meta.url)), "codex-goal-cli.js");
}
async function writeProjectControlOperation(record) {
    await mkdir(dirname(record.operationFilePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${record.operationFilePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    await rename(tmpPath, record.operationFilePath);
}
function parseProjectControlOperationRecord(value) {
    if (!isRecord(value))
        throw new Error("project_control_operation_invalid");
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
function projectControlOperationStatus(value) {
    if (value === ProjectControlOperationStatus.Queued ||
        value === ProjectControlOperationStatus.Running ||
        value === ProjectControlOperationStatus.Completed ||
        value === ProjectControlOperationStatus.Failed) {
        return value;
    }
    throw new Error("project_control_operation_status_invalid");
}
function projectControlOperationToolName(value) {
    if (value === "codex_goal_project_refill_worker")
        return value;
    throw new Error("project_control_operation_tool_invalid");
}
function projectControlOperationError(result) {
    if (typeof result.error === "string")
        return result.error;
    if (typeof result.reason === "string")
        return result.reason;
    return "project_control_operation_result_not_ok";
}
function jsonRecordFromUnknown(value) {
    if (!isRecord(value))
        return { value: String(value) };
    return JSON.parse(JSON.stringify(value));
}
function jsonStringArray(value, name) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        throw new Error(`${name}_invalid`);
    }
    return value;
}
function requiredString(value, name) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${name}_required`);
    }
    return value;
}
function requiredNumber(value, name) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${name}_required`);
    }
    return value;
}
function assertProjectControlOperationId(value) {
    if (!/^[A-Za-z0-9_.:-]+$/.test(value)) {
        throw new Error("project_control_operation_id_invalid");
    }
}
function compactTimestamp(date) {
    return date.toISOString().replace(/[-:.]/g, "").replace("T", "T").replace("Z", "Z");
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=project-control-operation-lifecycle.js.map