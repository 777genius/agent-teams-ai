import { assessBaseRevision, assessWorkerHealth, buildWorkerStatusView, } from "@vioxen/subscription-runtime/worker-core";
import { resolveCodexGoalWorkerLiveness, } from "../codex-goal-ops.js";
import { availableCodexGoalAccountSlots, dedupeCodexGoalAccountSlots, duplicateAccountGroups, } from "./codex-goal-accounts.js";
import { codexGoalBriefHealthStatus, isHeartbeatOnlyNoOutputBrief, isSafeStartAction, latestIsoDate, nextActionForStatus, nextBestCommand, } from "./codex-goal-decision.js";
import { extractRecentCommands, redactLogTail, } from "./codex-goal-log-view.js";
import { readCodexGoalLifecycleMarkers } from "./codex-goal-lifecycle-markers.js";
import { readRuntimeResultBrief, safeTail, } from "./codex-goal-runtime-result.js";
export async function buildCodexGoalBrief(input) {
    const result = input.status.resultPath
        ? await readRuntimeResultBrief(input.status.resultPath)
        : {};
    const baseRevision = assessBaseRevision({
        workerBase: result.baseCommit === undefined ? {} : { commit: result.baseCommit },
        ...(input.targetCommit === undefined
            ? {}
            : { target: { commit: input.targetCommit } }),
        outputChangedFiles: input.status.changedFiles ?? [],
        outputNoDiff: (input.status.changedFiles ?? []).length === 0 &&
            input.status.workspaceDirty !== true,
    });
    const lastProgressAt = latestIsoDate([
        input.status.progressUpdatedAt,
        input.status.logUpdatedAt,
        result.updatedAt,
    ]);
    const lastProgressMs = lastProgressAt ? Date.parse(lastProgressAt) : NaN;
    const lastProgressAgeMs = Number.isFinite(lastProgressMs)
        ? Date.now() - lastProgressMs
        : undefined;
    const isStale = Number.isFinite(lastProgressMs)
        ? (lastProgressAgeMs ?? 0) > input.staleAfterMs
        : false;
    const progressStale = input.status.progressHeartbeatAgeMs !== undefined &&
        input.status.progressHeartbeatAgeMs > input.staleAfterMs;
    const workerLiveness = resolveCodexGoalWorkerLiveness({
        status: input.status,
        progressStale,
    });
    const silentStale = Boolean(workerLiveness.alive &&
        input.status.recommendedAction === "wait_for_worker" &&
        isStale);
    const heartbeatOnlyNoOutput = isHeartbeatOnlyNoOutputBrief({
        status: input.status,
        staleAfterMs: input.staleAfterMs,
    });
    const workerHealth = assessWorkerHealth({
        status: codexGoalBriefHealthStatus({
            status: input.status,
            workerAlive: workerLiveness.alive,
        }),
        processAlive: workerLiveness.alive,
        liveness: silentStale ? "stale" : workerLiveness.alive ? "alive" : "dead",
        staleAfterMs: input.staleAfterMs,
        progressStale,
        silentStale,
        heartbeatOnlyNoOutput,
        changedFilesCount: (input.status.changedFiles ?? []).length,
        ...(input.status.progressStatus === undefined
            ? {}
            : { progressStatus: input.status.progressStatus }),
        ...(input.status.progressHeartbeatAgeMs === undefined
            ? {}
            : { progressHeartbeatAgeMs: input.status.progressHeartbeatAgeMs }),
        ...(input.status.resultExists === undefined
            ? {}
            : { resultExists: input.status.resultExists }),
        ...(input.status.resultStatus === undefined
            ? {}
            : { resultStatus: input.status.resultStatus }),
        ...(input.status.workspaceDirty === undefined
            ? {}
            : { workspaceDirty: input.status.workspaceDirty }),
    });
    const invalidAccounts = input.accounts.filter((slot) => slot.status !== "ready");
    const capacityBlockedAccounts = input.accounts.filter((slot) => slot.availability === "limited");
    const duplicateAccounts = duplicateAccountGroups(input.accounts);
    const dedupedAccounts = dedupeCodexGoalAccountSlots(input.accounts);
    const availableDedupedAccounts = availableCodexGoalAccountSlots(dedupedAccounts);
    const safeStatusToContinue = !workerLiveness.alive && isSafeStartAction(input.status.recommendedAction);
    const hasAvailableAccount = availableDedupedAccounts.length > 0;
    const lifecycleMarkers = await readCodexGoalLifecycleMarkers({
        jobRootDir: input.launch.config.jobRootDir,
        taskId: input.launch.config.taskId,
    });
    const lifecycleMarkerTypes = lifecycleMarkers
        .map((marker) => marker.type)
        .filter((type) => typeof type === "string");
    const reviewed = lifecycleMarkerTypes.includes("review");
    const reviewedStopped = Boolean(reviewed && !workerLiveness.alive);
    const reviewedWithoutResult = Boolean(reviewedStopped &&
        !input.status.resultExists &&
        !workerLiveness.alive);
    const stoppedWithoutResult = Boolean(lifecycleMarkerTypes.includes("stop_event") &&
        !input.status.resultExists &&
        !workerLiveness.alive);
    const maintenancePaused = Boolean(lifecycleMarkerTypes.includes("maintenance_pause") &&
        input.status.progressStatus === "maintenance_paused" &&
        !workerLiveness.alive);
    const strictResultExists = result.strict === true;
    const needsResultReconcile = Boolean(!workerLiveness.alive &&
        !strictResultExists &&
        ((stoppedWithoutResult && !maintenancePaused) ||
            input.status.workspaceDirty ||
            (result.strict === false && !safeStatusToContinue)));
    const next = workerLiveness.alive && !silentStale && !heartbeatOnlyNoOutput
        ? {
            tool: "codex_goal_brief",
            reason: "worker is already running",
        }
        : needsResultReconcile
            ? {
                tool: "codex_goal_reconcile_result",
                reason: result.strict === false
                    ? "non_strict_runtime_result"
                    : "missing_runtime_result",
            }
            : silentStale
                ? {
                    tool: "manual_review",
                    reason: "silent_stale_worker",
                }
                : heartbeatOnlyNoOutput
                    ? {
                        tool: "manual_review",
                        reason: "heartbeat_only_no_output",
                    }
                    : stoppedWithoutResult && !maintenancePaused
                        ? {
                            tool: "manual_review",
                            reason: "stopped_worker",
                        }
                        : safeStatusToContinue && !hasAvailableAccount
                            ? {
                                tool: "codex_goal_accounts_status",
                                reason: "no available account slots for this job",
                            }
                            : reviewedStopped
                                ? {
                                    tool: "manual_review",
                                    reason: reviewedWithoutResult ? "reviewed_no_result" : "reviewed_result",
                                }
                                : nextActionForStatus(input.status.recommendedAction);
    const recentLogTail = redactLogTail(await safeTail(input.launch.logPath, input.tailLines));
    const currentAccount = result.currentAccount ?? input.status.progressCurrentAccount;
    const statusView = buildWorkerStatusView({
        health: workerHealth,
        staleAfterMs: input.staleAfterMs,
        baseStatus: baseRevision.status,
        dirtyFilesCount: (input.status.changedFiles ?? []).length,
        nextBestActionHint: String(next.tool),
        ...(baseRevision.workerBaseCommit === undefined
            ? {}
            : { baseCommit: baseRevision.workerBaseCommit }),
        ...(baseRevision.targetCommit === undefined
            ? {}
            : { targetCommit: baseRevision.targetCommit }),
        ...(input.launch.config.model === undefined
            ? {}
            : { model: input.launch.config.model }),
        ...(input.launch.config.reasoningEffort === undefined
            ? {}
            : { effort: input.launch.config.reasoningEffort }),
        ...(input.launch.config.serviceTier === undefined
            ? {}
            : { serviceTier: input.launch.config.serviceTier }),
        ...(currentAccount === undefined ? {} : { account: currentAccount }),
        ...(input.launch.config.accessBoundary === undefined
            ? {}
            : { accessBoundary: input.launch.config.accessBoundary }),
        ...(lastProgressAgeMs === undefined ? {} : { freshAgeMs: lastProgressAgeMs }),
    });
    return {
        text: [
            workerLiveness.alive ? "worker alive" : "worker not running",
            `recommendedAction ${input.status.recommendedAction}`,
            lastProgressAt ? `lastProgressAt ${lastProgressAt}` : "lastProgressAt unknown",
            input.status.progressUpdatedAt
                ? `progressUpdatedAt ${input.status.progressUpdatedAt}`
                : "progressUpdatedAt unknown",
            input.status.progressStatus
                ? `progressStatus ${input.status.progressStatus}`
                : "progressStatus unknown",
            input.status.appServerProcessAlive === undefined
                ? "appServerProcessAlive unknown"
                : `appServerProcessAlive ${String(input.status.appServerProcessAlive)}`,
            input.status.workspaceDirty === undefined
                ? "workspace dirty unknown"
                : `workspace dirty ${input.status.workspaceDirty}`,
            input.status.changedFiles?.length
                ? `changed files ${input.status.changedFiles.length}`
                : "changed files 0",
            silentStale ? "silentStale true" : "silentStale false",
            heartbeatOnlyNoOutput
                ? "heartbeatOnlyNoOutput true"
                : "heartbeatOnlyNoOutput false",
            lifecycleMarkerTypes.length
                ? `lifecycle markers ${lifecycleMarkerTypes.join(",")}`
                : "lifecycle markers none",
            reviewedStopped ? "reviewedStopped true" : "reviewedStopped false",
            reviewedWithoutResult ? "reviewedWithoutResult true" : "reviewedWithoutResult false",
            stoppedWithoutResult ? "stoppedWithoutResult true" : "stoppedWithoutResult false",
            maintenancePaused ? "maintenancePaused true" : "maintenancePaused false",
        ].join(", "),
        lastProgressAt,
        lastProgressAgeMs,
        staleAfterMs: input.staleAfterMs,
        isStale,
        workerAlive: workerLiveness.alive,
        workerSupervisorKind: workerLiveness.supervisorKind,
        workerAliveReason: workerLiveness.aliveReason,
        workerProcessAlive: workerLiveness.processAlive,
        workerFreshProgressAlive: workerLiveness.freshProgressAlive,
        workerHealth,
        statusView,
        baseRevision,
        baseRevisionStatus: baseRevision.status,
        baseRevisionReasons: baseRevision.reasons,
        handoffArtifacts: result.artifacts ?? [],
        handoffBaseCommit: result.baseCommit,
        handoffPatchPath: result.patchPath,
        handoffSummaryPath: result.summaryPath,
        activeWriterRisk: workerHealth.activeWriterRisk.kind,
        activeWriterRiskReasons: workerHealth.activeWriterRisk.reasons,
        silentStale,
        heartbeatOnlyNoOutput,
        logExists: input.status.logExists,
        logByteLength: input.status.logByteLength,
        progressPath: input.status.progressPath,
        progressExists: input.status.progressExists,
        progressStatus: input.status.progressStatus,
        progressUpdatedAt: input.status.progressUpdatedAt,
        progressHeartbeatAgeMs: input.status.progressHeartbeatAgeMs,
        progressPid: input.status.progressPid,
        progressProcessAlive: input.status.progressProcessAlive,
        appServerProcessAlive: input.status.appServerProcessAlive,
        appServerProcessPid: input.status.appServerProcessPid,
        progressResultStatus: input.status.progressResultStatus,
        progressResultReason: input.status.progressResultReason,
        progressAttemptCount: input.status.progressAttemptCount,
        progressCurrentAccount: input.status.progressCurrentAccount,
        runtimeEventsPath: input.status.runtimeEventsPath,
        runtimeEventsExists: input.status.runtimeEventsExists,
        runtimeEventsByteLength: input.status.runtimeEventsByteLength,
        lastRuntimeEvent: input.status.lastRuntimeEvent,
        lastRuntimeEventAt: input.status.lastRuntimeEventAt,
        lastRuntimeEventLevel: input.status.lastRuntimeEventLevel,
        currentAccount: result.currentAccount,
        lastFailureReason: input.status.resultReason ?? result.lastFailureReason,
        changedFiles: input.status.changedFiles ?? [],
        safeToContinue: workerHealth.safeToContinue &&
            safeStatusToContinue &&
            hasAvailableAccount &&
            !reviewedStopped &&
            !reviewedWithoutResult &&
            (!stoppedWithoutResult || maintenancePaused),
        hasAvailableAccount,
        configuredAccounts: input.accounts.map((slot) => slot.name),
        dedupedAccounts: dedupedAccounts.map((slot) => slot.name),
        availableDedupedAccounts: availableDedupedAccounts.map((slot) => slot.name),
        needsHumanRelogin: invalidAccounts.length > 0,
        invalidAccounts: invalidAccounts.map((slot) => slot.name),
        duplicateAccounts,
        lifecycleMarkers,
        lifecycleMarkerTypes,
        maintenancePaused,
        capacityBlockedAccounts: capacityBlockedAccounts.map((slot) => ({
            name: slot.name,
            availability: slot.availability,
            reason: slot.capacityReason,
            cooldownUntil: slot.limitResetAt ?? slot.capacityCooldownUntil,
        })),
        recentCommands: extractRecentCommands(recentLogTail),
        nextBestTool: next.tool,
        nextBestReason: next.reason,
        nextBestCommand: nextBestCommand({
            jobId: input.jobId,
            action: next,
            status: input.status,
            launch: input.launch,
        }),
        recentLogTail,
    };
}
//# sourceMappingURL=codex-goal-brief.js.map