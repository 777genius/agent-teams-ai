import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { decideRunObservation, } from "@vioxen/subscription-runtime/worker-core";
import { FileClaudeRunArtifactStore, } from "./claude-run-artifacts.js";
const execFileAsync = promisify(execFile);
const defaultStaleAfterMs = 10 * 60_000;
const defaultTailLines = 20;
export class ClaudeRunObservationAdapter {
    options;
    store;
    staleAfterMs;
    tailLines;
    redactor = new DefaultRedactor();
    constructor(options = {}) {
        this.options = options;
        this.store = new FileClaudeRunArtifactStore({
            rootDir: resolveRunArtifactsRoot(options),
        });
        this.staleAfterMs = options.staleAfterMs ?? defaultStaleAfterMs;
        this.tailLines = options.tailLines ?? defaultTailLines;
    }
    listRunIds() {
        return this.store.listRunIds();
    }
    async observeRun(request) {
        const [manifest, progress, result, logStatus] = await Promise.all([
            this.store.readManifest(request.runId),
            this.store.readProgress(request.runId),
            this.store.readResult(request.runId),
            this.store.logStatus(request.runId),
        ]);
        const paths = this.store.paths(request.runId);
        const warnings = [];
        if (!progress) {
            warnings.push({
                code: "claude_progress_missing",
                message: "Claude run progress artifact is missing or unreadable",
                severity: "warning",
            });
        }
        const progressAgeMs = isoAgeMs(progress?.updatedAt);
        const progressStale = progressAgeMs !== undefined &&
            progressAgeMs > this.staleAfterMs;
        const logAgeMs = isoAgeMs(logStatus.updatedAt);
        const logStale = logAgeMs !== undefined && logAgeMs > this.staleAfterMs;
        if (progressAgeMs !== undefined && progressAgeMs < -5_000) {
            warnings.push({
                code: "clock_skew",
                message: "Claude run progress timestamp is in the future",
                severity: "warning",
            });
        }
        const workspace = await workspaceSnapshot(manifest, request);
        const status = claudeRunStatus({ progress, result });
        const silentStale = status === "running" && logStale && !progressStale;
        const logs = await this.logExcerpt({
            runId: request.runId,
            paths,
            logStatus,
            request,
            logAgeMs,
            logStale,
            warnings,
        });
        const liveness = claudeRunLiveness({ status, progress, progressStale });
        const capacity = capacityHints({ manifest, progress });
        const processAliveNow = progress?.pid === undefined
            ? false
            : processAlive(progress.pid);
        const snapshotBase = {
            runId: manifest.runId,
            providerKind: "claude",
            observedAt: new Date().toISOString(),
            status,
            liveness,
            ...(workspace === undefined ? {} : { workspace }),
            process: {
                supervisor: "process",
                ...(progress?.pid === undefined ? {} : { pid: progress.pid }),
                alive: processAliveNow,
            },
            progress: {
                ...(progress?.status === undefined ? {} : { status: progress.status }),
                ...(progress?.updatedAt === undefined ? {} : { updatedAt: progress.updatedAt }),
                ...(progressAgeMs === undefined ? {} : { heartbeatAgeMs: progressAgeMs }),
                staleAfterMs: this.staleAfterMs,
                stale: progressStale,
                silentStale,
                currentAccount: manifest.capacityAccountId ?? manifest.providerInstanceId,
            },
            result: {
                exists: result !== null,
                ...(result?.status === undefined ? {} : { status: result.status }),
                ...(result?.reason === undefined ? {} : { reason: result.reason }),
                ...(result?.failureDetails === undefined
                    ? {}
                    : { details: result.failureDetails }),
                ...(result?.updatedAt === undefined ? {} : { updatedAt: result.updatedAt }),
                path: paths.resultPath,
            },
            logs,
            artifacts: artifactSummaries({
                paths,
                progress,
                result,
                logStatus,
            }),
            capacity,
            manualReviewReasons: manualReviewReasons({ status, result, progress }),
            warnings,
        };
        return {
            ...snapshotBase,
            readOnlyDecision: decideRunObservation({
                status: snapshotBase.status,
                liveness: snapshotBase.liveness,
                ...(snapshotBase.workspace === undefined ? {} : { workspace: snapshotBase.workspace }),
                progress: snapshotBase.progress,
                result: snapshotBase.result,
                capacity: snapshotBase.capacity,
                manualReviewReasons: snapshotBase.manualReviewReasons,
                warnings: snapshotBase.warnings,
            }),
        };
    }
    async logExcerpt(input) {
        const log = {
            path: input.paths.logPath,
            exists: input.logStatus.exists,
            ...(input.logStatus.updatedAt === undefined
                ? {}
                : { updatedAt: input.logStatus.updatedAt }),
            ...(input.logAgeMs === undefined ? {} : { updatedAgeMs: input.logAgeMs }),
            staleAfterMs: this.staleAfterMs,
            stale: input.logStale,
            ...(input.logStatus.byteLength === undefined
                ? {}
                : { byteLength: input.logStatus.byteLength }),
        };
        if (!input.request.includeLogTail || !input.logStatus.exists)
            return log;
        try {
            const lines = input.request.tailLines ?? this.tailLines;
            const tail = await this.store.tailLog(input.runId, lines);
            const truncated = input.logStatus.byteLength === undefined
                ? undefined
                : Buffer.byteLength(tail, "utf8") < input.logStatus.byteLength;
            return {
                ...log,
                tailLines: lines,
                tail: this.redactor.redact(tail),
                ...(truncated === undefined ? {} : { truncated }),
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "log_tail_unreadable";
            input.warnings.push({
                code: "log_tail_unreadable",
                message,
                severity: "warning",
            });
            return {
                ...log,
                warning: message,
            };
        }
    }
}
function resolveRunArtifactsRoot(options) {
    if (options.runArtifactsRootDir)
        return resolve(options.runArtifactsRootDir);
    if (options.stateRootDir)
        return resolve(options.stateRootDir, "claude-run-artifacts");
    return resolve(process.cwd(), "claude-run-artifacts");
}
async function workspaceSnapshot(manifest, request) {
    if (!manifest.workspacePath)
        return undefined;
    const key = await safeWorkspaceKey(manifest.workspacePath);
    const exists = await pathExists(manifest.workspacePath);
    if (!exists) {
        return {
            path: manifest.workspacePath,
            key,
            exists: false,
            dirty: false,
            changedFilesCount: 0,
            ...(request.includeChangedFiles ? { changedFiles: [] } : {}),
            warning: "workspace_missing",
        };
    }
    const changedFiles = await gitChangedFiles(manifest.workspacePath);
    return {
        path: manifest.workspacePath,
        key,
        exists: true,
        dirty: changedFiles.length > 0,
        changedFilesCount: changedFiles.length,
        ...(request.includeChangedFiles ? { changedFiles } : {}),
    };
}
async function pathExists(path) {
    try {
        await stat(path);
        return true;
    }
    catch {
        return false;
    }
}
async function gitChangedFiles(path) {
    try {
        const { stdout } = await execFileAsync("git", [
            "-C",
            path,
            "status",
            "--porcelain",
        ]);
        return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    }
    catch {
        return [];
    }
}
async function safeWorkspaceKey(workspacePath) {
    try {
        return await realpath(workspacePath);
    }
    catch {
        return resolve(process.cwd(), workspacePath);
    }
}
function claudeRunStatus(input) {
    if (input.result?.status === "completed")
        return "completed";
    if (input.result?.status === "failed" || input.result?.status === "blocked") {
        return "failed";
    }
    if (input.progress?.status === "running")
        return "running";
    return "unknown";
}
function claudeRunLiveness(input) {
    if (input.status !== "running")
        return "dead";
    if (input.progressStale)
        return "stale";
    if (input.progress?.pid && processAlive(input.progress.pid))
        return "alive";
    return "unknown";
}
function capacityHints(input) {
    const capacity = input.progress?.capacity;
    if (!capacity)
        return [];
    return [{
            account: input.manifest.capacityAccountId ?? input.manifest.providerInstanceId,
            status: capacity.availability,
            availability: capacity.availability,
            ...(capacity.reason === undefined ? {} : { reason: capacity.reason }),
            ...(capacity.cooldownUntil === undefined
                ? {}
                : { cooldownUntil: capacity.cooldownUntil instanceof Date
                        ? capacity.cooldownUntil.toISOString()
                        : String(capacity.cooldownUntil) }),
        }];
}
function manualReviewReasons(input) {
    if (input.status === "failed") {
        return [input.result?.reason ?? "claude_run_failed"];
    }
    if (input.status === "unknown" && !input.progress)
        return ["claude_progress_missing"];
    return [];
}
function artifactSummaries(input) {
    return [
        {
            kind: "result",
            path: input.paths.resultPath,
            exists: input.result !== null,
            ...(input.result?.updatedAt === undefined ? {} : { updatedAt: input.result.updatedAt }),
        },
        {
            kind: "progress",
            path: input.paths.progressPath,
            exists: input.progress !== null,
            ...(input.progress?.updatedAt === undefined ? {} : { updatedAt: input.progress.updatedAt }),
        },
        {
            kind: "log",
            path: input.paths.logPath,
            exists: input.logStatus.exists,
            ...(input.logStatus.updatedAt === undefined
                ? {}
                : { updatedAt: input.logStatus.updatedAt }),
            ...(input.logStatus.byteLength === undefined
                ? {}
                : { byteLength: input.logStatus.byteLength }),
        },
    ];
}
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function isoAgeMs(value) {
    if (!value)
        return undefined;
    const time = Date.parse(value);
    return Number.isFinite(time) ? Date.now() - time : undefined;
}
//# sourceMappingURL=claude-run-observation.js.map