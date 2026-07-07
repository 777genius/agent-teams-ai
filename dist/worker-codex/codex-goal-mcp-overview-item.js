import { codexGoalJobToArgs, readCodexGoalJob, } from "./codex-goal-jobs.js";
import { collectCodexGoalStatus, listCodexGoalAccountStatuses, } from "./codex-goal-ops.js";
import { buildCodexGoalBrief } from "./codex-goal-mcp-brief.js";
import { goalLaunchInput } from "./codex-goal-mcp-launch-input.js";
import { codexGoalStateRootDir } from "./codex-goal-mcp-worker-control.js";
export async function buildCodexGoalOverviewItem(input) {
    try {
        const manifest = await readCodexGoalJob({
            registryRootDir: input.registryRootDir,
            jobId: input.jobId,
        });
        const launch = await goalLaunchInput(codexGoalJobToArgs(manifest));
        const status = await collectCodexGoalStatus(statusInput(launch));
        const accounts = await listCodexGoalAccountStatuses({
            authRootDir: launch.config.authRootDir,
            accounts: launch.config.accounts.map((account) => account.name),
            stateRootDir: codexGoalStateRootDir(launch),
        });
        const brief = await buildCodexGoalBrief({
            jobId: manifest.jobId,
            launch,
            status,
            accounts,
            staleAfterMs: input.staleAfterMs,
            tailLines: input.tailLines,
        });
        const registryArgs = {
            registryRootDir: input.registryRootDir,
            jobId: manifest.jobId,
        };
        const recommendedAction = brief.lifecycleMarkerTypes.includes("review") &&
            !status.resultExists &&
            !brief.workerAlive
            ? "review_completed"
            : status.recommendedAction;
        return {
            ok: true,
            jobId: manifest.jobId,
            description: manifest.description,
            tags: manifest.tags ?? [],
            workspacePath: launch.config.workspacePath,
            taskId: launch.config.taskId,
            tmuxSession: launch.tmuxSession,
            workerAlive: Boolean(brief.workerAlive),
            workerSupervisorKind: brief.workerSupervisorKind,
            workerAliveReason: brief.workerAliveReason,
            workerProcessAlive: brief.workerProcessAlive,
            workerFreshProgressAlive: brief.workerFreshProgressAlive,
            workerHealth: brief.workerHealth,
            activeWriterRisk: brief.activeWriterRisk,
            activeWriterRiskReasons: brief.activeWriterRiskReasons,
            statusView: brief.statusView,
            baseRevision: brief.baseRevision,
            baseRevisionStatus: brief.baseRevisionStatus,
            baseRevisionReasons: brief.baseRevisionReasons,
            recommendedAction,
            resultStatus: status.resultStatus,
            resultReason: status.resultReason,
            progressPath: status.progressPath,
            progressExists: status.progressExists,
            progressStatus: status.progressStatus,
            progressUpdatedAt: status.progressUpdatedAt,
            progressHeartbeatAgeMs: status.progressHeartbeatAgeMs,
            progressPid: status.progressPid,
            progressProcessAlive: status.progressProcessAlive,
            workspaceDirty: status.workspaceDirty,
            changedFilesCount: (status.changedFiles ?? []).length,
            changedFiles: status.changedFiles ?? [],
            lastProgressAt: brief.lastProgressAt,
            lastProgressAgeMs: brief.lastProgressAgeMs,
            isStale: brief.isStale,
            silentStale: brief.silentStale,
            heartbeatOnlyNoOutput: brief.heartbeatOnlyNoOutput,
            safeToContinue: brief.safeToContinue,
            hasAvailableAccount: brief.hasAvailableAccount,
            needsHumanRelogin: brief.needsHumanRelogin,
            capacityBlockedAccounts: brief.capacityBlockedAccounts,
            availableDedupedAccounts: brief.availableDedupedAccounts,
            invalidAccounts: brief.invalidAccounts,
            lifecycleMarkers: brief.lifecycleMarkers,
            lifecycleMarkerTypes: brief.lifecycleMarkerTypes,
            nextBestTool: brief.nextBestTool,
            nextBestReason: brief.nextBestReason,
            nextBestCommand: brief.nextBestCommand,
            commands: {
                brief: `codex_goal_brief(${JSON.stringify(registryArgs)})`,
                handoff: `codex_goal_handoff(${JSON.stringify(registryArgs)})`,
                accounts: `codex_goal_accounts_status(${JSON.stringify(registryArgs)})`,
                ...(brief.safeToContinue
                    ? {
                        continue: `codex_goal_continue(${JSON.stringify({ ...registryArgs, confirmContinue: true })})`,
                    }
                    : {}),
                ...(brief.silentStale
                    ? {
                        stop: `codex_goal_stop(${JSON.stringify({ ...registryArgs, confirmStop: true })})`,
                    }
                    : {}),
            },
        };
    }
    catch (error) {
        return {
            ok: false,
            jobId: input.jobId,
            safeMessage: error instanceof Error ? error.message : String(error),
        };
    }
}
function statusInput(launch) {
    return {
        jobRootDir: launch.config.jobRootDir,
        taskId: launch.config.taskId,
        ...(launch.config.outputPath ? { resultPath: launch.config.outputPath } : {}),
        workspacePath: launch.config.workspacePath,
        ...(launch.tmuxSession ? { tmuxSession: launch.tmuxSession } : {}),
        logPath: launch.logPath,
        ...(launch.config.progressPath ? { progressPath: launch.config.progressPath } : {}),
        ...(launch.config.accessBoundary === undefined
            ? {}
            : { accessBoundary: launch.config.accessBoundary }),
    };
}
//# sourceMappingURL=codex-goal-mcp-overview-item.js.map