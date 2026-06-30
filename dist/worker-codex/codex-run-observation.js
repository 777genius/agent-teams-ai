import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { LocalFileWorkerControlInboxStore } from "@vioxen/subscription-runtime/store-local-file";
import { decideRunObservation, WorkerControlService, } from "@vioxen/subscription-runtime/worker-core";
import { codexGoalJobToArgs, listCodexGoalJobs, readCodexGoalJob, resolveCodexGoalJobRegistryRoot, } from "./codex-goal-jobs.js";
import { collectCodexGoalStatus, listCodexGoalAccountStatuses, tailCodexGoalLog, } from "./codex-goal-ops.js";
import { codexGoalProgressPath } from "./codex-goal-runner.js";
const defaultAuthRoot = "~/.cache/subscription-runtime/live-codex-auth";
const defaultStaleAfterMs = 10 * 60_000;
const defaultTailLines = 20;
const heartbeatOnlyNoOutputAfterMs = 2 * 60_000;
export class CodexRunObservationAdapter {
    options;
    cwd;
    registryRootDir;
    staleAfterMs;
    tailLines;
    redactor = new DefaultRedactor();
    constructor(options = {}) {
        this.options = options;
        this.cwd = options.cwd ?? process.cwd();
        this.registryRootDir = resolveCodexGoalJobRegistryRoot({
            cwd: this.cwd,
            ...(options.registryRootDir ? { registryRootDir: options.registryRootDir } : {}),
        });
        this.staleAfterMs = options.staleAfterMs ?? defaultStaleAfterMs;
        this.tailLines = options.tailLines ?? defaultTailLines;
    }
    async listRunIds() {
        return (await listCodexGoalJobs({
            registryRootDir: this.registryRootDir,
        })).map((job) => job.jobId);
    }
    async observeRun(request) {
        const manifest = await readCodexGoalJob({
            registryRootDir: this.registryRootDir,
            jobId: request.runId,
        });
        const paths = codexManifestPaths(manifest, this.cwd);
        const status = await collectCodexGoalStatus({
            jobRootDir: paths.jobRootDir,
            taskId: manifest.taskId,
            resultPath: paths.outputPath,
            workspacePath: paths.workspacePath,
            logPath: paths.logPath,
            progressPath: paths.progressPath,
            ...(manifest.tmuxSession ? { tmuxSession: manifest.tmuxSession } : {}),
        });
        const capacity = await this.capacityHints({ manifest, paths });
        const warnings = status.warnings.map((message) => ({
            code: "codex_status_warning",
            message,
            severity: "warning",
        }));
        const logUpdatedAgeMs = isoAgeMs(status.logUpdatedAt);
        const logStale = logUpdatedAgeMs !== undefined &&
            logUpdatedAgeMs > this.staleAfterMs;
        const logs = await this.logExcerpt({
            status,
            request,
            warnings,
            logUpdatedAgeMs,
            logStale,
        });
        const progressStale = status.progressHeartbeatAgeMs !== undefined &&
            status.progressHeartbeatAgeMs > this.staleAfterMs;
        const heartbeatOnlyNoOutput = isHeartbeatOnlyNoOutput({
            status,
            progressStale,
            logUpdatedAgeMs,
        });
        const silentStale = Boolean(status.tmuxAlive && (progressStale || logStale));
        if (status.tmuxAlive && logStale) {
            warnings.push({
                code: "log_stale_while_worker_alive",
                message: "worker appears alive but the log has not changed recently",
                severity: "warning",
            });
        }
        if (heartbeatOnlyNoOutput) {
            warnings.push({
                code: "heartbeat_only_no_output",
                message: "worker heartbeat is fresh, but there is no result, log output or workspace change",
                severity: "blocked",
            });
        }
        if ((status.progressHeartbeatAgeMs !== undefined &&
            status.progressHeartbeatAgeMs < -5_000) ||
            (logUpdatedAgeMs !== undefined && logUpdatedAgeMs < -5_000)) {
            warnings.push({
                code: "clock_skew",
                message: "observed progress or log timestamp is in the future",
                severity: "warning",
            });
        }
        const liveness = codexLiveness({
            status,
            silentStale,
        });
        const runStatus = codexRunStatus({ status });
        const changedFiles = status.changedFiles ?? [];
        const manualReviewReasons = codexManualReviewReasons(status);
        const workspaceKey = await safeWorkspaceKey(paths.workspacePath);
        const workspace = {
            path: paths.workspacePath,
            key: workspaceKey,
            changedFilesCount: changedFiles.length,
            ...(status.workspaceDirty === undefined ? {} : { dirty: status.workspaceDirty }),
            ...(request.includeChangedFiles ? { changedFiles } : {}),
        };
        const progress = {
            ...(status.progressStatus === undefined ? {} : { status: status.progressStatus }),
            ...(status.progressUpdatedAt === undefined
                ? {}
                : { updatedAt: status.progressUpdatedAt }),
            ...(status.progressHeartbeatAgeMs === undefined
                ? {}
                : { heartbeatAgeMs: status.progressHeartbeatAgeMs }),
            staleAfterMs: this.staleAfterMs,
            stale: progressStale,
            silentStale,
            heartbeatOnlyNoOutput,
            ...(status.progressAttemptCount === undefined
                ? {}
                : { attemptCount: status.progressAttemptCount }),
            ...(status.progressCurrentAccount === undefined
                ? {}
                : { currentAccount: status.progressCurrentAccount }),
        };
        const result = {
            ...(status.resultExists === undefined ? {} : { exists: status.resultExists }),
            ...(status.resultStatus === undefined ? {} : { status: status.resultStatus }),
            ...(status.resultReason === undefined ? {} : { reason: status.resultReason }),
            ...(status.resultPath === undefined ? {} : { path: status.resultPath }),
        };
        const artifacts = [
            artifactSummary("result", {
                path: status.resultPath,
                exists: status.resultExists,
            }),
            artifactSummary("progress", {
                path: status.progressPath,
                exists: status.progressExists,
                updatedAt: status.progressUpdatedAt,
            }),
            artifactSummary("log", {
                path: status.logPath,
                exists: status.logExists,
                updatedAt: status.logUpdatedAt,
                byteLength: status.logByteLength,
            }),
        ];
        const controlInbox = this.options.controlInboxReader
            ? await this.options.controlInboxReader({
                runId: manifest.jobId,
                manifest,
            })
            : await this.controlInboxSummary({ manifest, paths });
        const snapshotBase = {
            runId: manifest.jobId,
            providerKind: "codex",
            observedAt: new Date().toISOString(),
            status: runStatus,
            liveness,
            workspace,
            process: {
                supervisor: manifest.tmuxSession ? "tmux" : "none",
                ...(manifest.tmuxSession ? { sessionId: manifest.tmuxSession } : {}),
                ...(status.tmuxAlive === undefined ? {} : { alive: status.tmuxAlive }),
                ...(status.progressPid === undefined ? {} : { pid: status.progressPid }),
            },
            progress,
            result,
            logs,
            artifacts,
            capacity,
            ...(controlInbox === undefined ? {} : { controlInbox }),
            manualReviewReasons,
            warnings,
        };
        return {
            ...snapshotBase,
            readOnlyDecision: decideRunObservation({
                status: snapshotBase.status,
                liveness: snapshotBase.liveness,
                workspace: snapshotBase.workspace,
                progress: snapshotBase.progress,
                result: snapshotBase.result,
                capacity: snapshotBase.capacity,
                ...(snapshotBase.controlInbox === undefined
                    ? {}
                    : { controlInbox: snapshotBase.controlInbox }),
                manualReviewReasons: snapshotBase.manualReviewReasons,
                warnings: snapshotBase.warnings,
            }),
        };
    }
    async controlInboxSummary(input) {
        const control = new WorkerControlService({
            store: new LocalFileWorkerControlInboxStore({
                rootDir: input.paths.stateRootDir,
            }),
        });
        const target = {
            jobId: input.manifest.jobId,
            taskId: input.manifest.taskId,
            workspaceId: input.paths.workspacePath,
        };
        const [report, signals] = await Promise.all([
            control.reconcile({ target }),
            control.listSignals({ target, includeExpired: true, includeBodies: false }),
        ]);
        if (report.signalCount === 0)
            return undefined;
        const latestSignalAt = latestIso(signals.map((view) => view.signal.createdAt));
        const latestDeliveredAt = latestIso(signals
            .map((view) => view.latestReceipt?.deliveredAt)
            .filter((value) => value instanceof Date));
        return {
            pendingCount: report.pendingCount,
            acceptedCount: report.acceptedCount,
            deliverableCount: report.deliverableCount,
            deliveredCount: report.deliveredCount,
            failedCount: report.failedCount,
            blockedDeliveryCount: report.blockedCount,
            safeToContinue: report.blockedCount === 0,
            ...(latestSignalAt === undefined ? {} : { latestSignalAt }),
            ...(latestDeliveredAt === undefined ? {} : { latestDeliveredAt }),
        };
    }
    async capacityHints(input) {
        const accounts = await listCodexGoalAccountStatuses({
            authRootDir: input.paths.authRootDir,
            accounts: input.manifest.accounts,
            stateRootDir: input.paths.stateRootDir,
        });
        return accounts.map((account) => ({
            account: account.name,
            status: account.status,
            ...(account.capacityAvailability === undefined
                ? {}
                : { availability: account.capacityAvailability }),
            ...(account.capacityReason === undefined
                ? {}
                : { reason: account.capacityReason }),
            ...(account.capacityCooldownUntil === undefined
                ? {}
                : { cooldownUntil: account.capacityCooldownUntil }),
            ...(account.warnings.length ? { warning: account.warnings.join("; ") } : {}),
        }));
    }
    async logExcerpt(input) {
        const log = {
            ...(input.status.logPath === undefined ? {} : { path: input.status.logPath }),
            ...(input.status.logExists === undefined
                ? {}
                : { exists: input.status.logExists }),
            ...(input.status.logUpdatedAt === undefined
                ? {}
                : { updatedAt: input.status.logUpdatedAt }),
            ...(input.logUpdatedAgeMs === undefined
                ? {}
                : { updatedAgeMs: input.logUpdatedAgeMs }),
            staleAfterMs: this.staleAfterMs,
            stale: input.logStale,
            ...(input.status.logByteLength === undefined
                ? {}
                : { byteLength: input.status.logByteLength }),
        };
        if (!input.request.includeLogTail || !input.status.logPath)
            return log;
        try {
            const lines = input.request.tailLines ?? this.tailLines;
            return {
                ...log,
                tailLines: lines,
                tail: this.redactor.redact(await tailCodexGoalLog(input.status.logPath, lines)),
                ...(input.status.logByteLength === undefined
                    ? {}
                    : { truncated: input.status.logByteLength > 0 }),
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
function artifactSummary(kind, input) {
    return {
        kind,
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.exists === undefined ? {} : { exists: input.exists }),
        ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
        ...(input.byteLength === undefined ? {} : { byteLength: input.byteLength }),
    };
}
function codexManifestPaths(manifest, cwd) {
    const args = codexGoalJobToArgs(manifest);
    const jobRootDir = resolvePath(cwd, String(args.jobRootDir));
    const authRootDir = resolvePath(cwd, String(args.authRootDir ?? defaultAuthRoot));
    const workspacePath = resolvePath(cwd, String(args.workspacePath));
    const outputPath = resolvePath(cwd, String(args.outputPath ?? join(jobRootDir, `${manifest.taskId}.latest-result.json`)));
    const progressPath = resolvePath(cwd, String(args.progressPath ?? codexGoalProgressPath({
        jobRootDir,
        taskId: manifest.taskId,
    })));
    return {
        jobRootDir,
        authRootDir,
        stateRootDir: resolvePath(cwd, String(args.stateRootDir ?? join(jobRootDir, "state"))),
        workspacePath,
        outputPath,
        progressPath,
        logPath: resolvePath(cwd, String(args.logPath ?? join(jobRootDir, `${manifest.taskId}.log`))),
    };
}
function codexRunStatus(input) {
    if (input.status.resultStatus === "completed")
        return "completed";
    if (input.status.tmuxAlive === true)
        return "running";
    if (input.status.resultStatus === "failed" ||
        input.status.resultStatus === "partial" ||
        input.status.resultStatus === "aborted") {
        return "failed";
    }
    if (input.status.resultExists === false && input.status.tmuxAlive === false) {
        return "stopped";
    }
    return "unknown";
}
function codexLiveness(input) {
    if (input.silentStale)
        return "stale";
    if (input.status.tmuxAlive === true)
        return "alive";
    if (input.status.tmuxAlive === false)
        return "dead";
    return "unknown";
}
function codexManualReviewReasons(status) {
    if (status.recommendedAction === "inspect_dirty_workspace" ||
        status.recommendedAction === "inspect_dirty_failure" ||
        status.recommendedAction === "inspect_failure" ||
        status.recommendedAction === "check_log_or_result") {
        return [status.recommendedAction];
    }
    return [];
}
function isHeartbeatOnlyNoOutput(input) {
    const status = input.status;
    const noOutputAgeMs = input.logUpdatedAgeMs ?? status.progressHeartbeatAgeMs;
    return Boolean(status.tmuxAlive &&
        status.progressExists &&
        status.progressStatus === "running" &&
        !input.progressStale &&
        noOutputAgeMs !== undefined &&
        noOutputAgeMs >= heartbeatOnlyNoOutputAfterMs &&
        status.resultExists === false &&
        (status.logExists === false || status.logByteLength === 0) &&
        status.workspaceDirty === false &&
        (status.changedFiles ?? []).length === 0);
}
async function safeWorkspaceKey(workspacePath) {
    try {
        return await realpath(workspacePath);
    }
    catch {
        return resolve(process.cwd(), workspacePath);
    }
}
function resolvePath(cwd, value) {
    const expanded = value.startsWith("~/")
        ? join(homedir(), value.slice(2))
        : value;
    return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}
function isoAgeMs(value) {
    if (!value)
        return undefined;
    const time = Date.parse(value);
    return Number.isFinite(time) ? Date.now() - time : undefined;
}
function latestIso(values) {
    const latestTime = values
        .map((value) => value.getTime())
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => b - a)[0];
    return latestTime === undefined ? undefined : new Date(latestTime).toISOString();
}
//# sourceMappingURL=codex-run-observation.js.map