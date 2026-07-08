import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codexGoalJobToArgs, createCodexGoalJob, listCodexGoalJobs, readCodexGoalJob, summarizeCodexGoalJob, updateCodexGoalJob, } from "../codex-goal-jobs.js";
import { collectCodexGoalStatus, listCodexGoalAccountStatuses, resolveCodexGoalWorkerLiveness, } from "../codex-goal-ops.js";
import { projectControlGenericScopeDenial, projectControlGenericToolDenial, } from "../project-control-scope-guard.js";
import { booleanValue, numberValue, requiredRawString, stringValue, } from "./codex-goal-input-values.js";
import { registryRootFromInput, } from "./codex-goal-use-case-inputs.js";
import { jobManifestInputFromArgs, jobManifestPatchFromArgs, } from "./codex-goal-manifest-input.js";
import { loadJobLaunch, } from "./codex-goal-job-launch-loader.js";
import { goalLaunchInput, } from "./codex-goal-launch-input.js";
import { codexGoalStatusInputFromLaunch as statusInput, } from "./codex-goal-status-input.js";
import { continueStoredJobLifecycle, maintenancePauseStoredJobLifecycle, reconcileStoredJobRuntimeResultLifecycle, stopStoredJobLifecycle, } from "./codex-goal-job-lifecycle-use-cases.js";
import { buildCodexGoalOverviewView, reconcilePreviewCodexGoalJobsView, } from "./codex-goal-overview.js";
import { buildCodexGoalBrief, } from "./codex-goal-brief.js";
import { codexGoalStateRootDir, } from "./codex-goal-worker-control.js";
import { optionalTargetCommit, targetCommitFromArgs, } from "./codex-goal-target-commit.js";
import { buildCodexGoalDecision, buildCodexGoalHandoff, isSafeStartAction, nextActionForStatus, } from "./codex-goal-decision.js";
export async function listCodexGoalJobsUseCase(args) {
    const registryRootDir = registryRootFromInput(args);
    const jobs = await listCodexGoalJobs({ registryRootDir });
    return { ok: true, registryRootDir, jobs };
}
export async function buildCodexGoalOverviewUseCase(args) {
    return buildCodexGoalOverviewView(args);
}
export async function reconcilePreviewCodexGoalJobsUseCase(args) {
    return reconcilePreviewCodexGoalJobsView(args, {
        continueStoredJob: continueStoredJobUseCase,
    });
}
export async function getCodexGoalJobUseCase(args) {
    const registryRootDir = registryRootFromInput(args);
    const manifest = await readCodexGoalJob({
        registryRootDir,
        jobId: requiredRawString(args.jobId, "jobId"),
    });
    return {
        ok: true,
        registryRootDir,
        manifest,
        summary: summarizeCodexGoalJob(manifest, registryRootDir),
    };
}
export async function createCodexGoalJobUseCase(args) {
    const registryRootDir = registryRootFromInput(args);
    const createManifest = jobManifestInputFromArgs(args);
    const projectControlDenial = await projectControlGenericScopeDenial({
        registryRootDir,
        jobId: createManifest.jobId,
        workspacePath: createManifest.workspacePath,
        accessBoundary: createManifest.accessBoundary,
        projectAccessScope: createManifest.projectAccessScope,
        requiredTool: "codex_goal_project_create_job",
        allowProjectScopedControlBootstrap: true,
        skipDirectProjectManifestDenial: true,
    });
    if (projectControlDenial)
        return projectControlDenial;
    const manifest = await createCodexGoalJob({
        registryRootDir,
        manifest: createManifest,
        overwrite: booleanValue(args.overwrite) ?? false,
    });
    return {
        ok: true,
        registryRootDir,
        manifest,
        summary: summarizeCodexGoalJob(manifest, registryRootDir),
    };
}
export async function updateCodexGoalJobUseCase(args) {
    const registryRootDir = registryRootFromInput(args);
    const existing = await readCodexGoalJob({
        registryRootDir,
        jobId: requiredRawString(args.jobId, "jobId"),
    });
    const patch = jobManifestPatchFromArgs(args);
    const projectControlDenial = projectControlGenericToolDenial({
        accessBoundary: existing.accessBoundary ?? patch.accessBoundary,
        projectAccessScope: existing.projectAccessScope ?? patch.projectAccessScope,
        jobId: existing.jobId,
        requiredTool: "brokered_project_manifest_repair",
    }) ?? await projectControlGenericScopeDenial({
        registryRootDir,
        jobId: existing.jobId,
        workspacePath: stringValue(patch.workspacePath) ?? existing.workspacePath,
        requiredTool: "brokered_project_manifest_repair",
    });
    if (projectControlDenial)
        return projectControlDenial;
    const manifest = await updateCodexGoalJob({
        registryRootDir,
        jobId: existing.jobId,
        patch,
    });
    return {
        ok: true,
        registryRootDir,
        manifest,
        summary: summarizeCodexGoalJob(manifest, registryRootDir),
    };
}
export async function getCodexGoalStatusByIdUseCase(args) {
    const registryRootDir = registryRootFromInput(args);
    const manifest = await readCodexGoalJob({
        registryRootDir,
        jobId: requiredRawString(args.jobId, "jobId"),
    });
    const launch = await goalLaunchInput(codexGoalJobToArgs(manifest));
    const status = await collectCodexGoalStatus(statusInput(launch));
    return {
        ok: true,
        registryRootDir,
        jobId: manifest.jobId,
        status,
        summary: summarizeCodexGoalJob(manifest, registryRootDir),
    };
}
export async function recommendCodexGoalNextActionUseCase(args) {
    const loaded = await loadJobLaunch(args);
    const status = await collectCodexGoalStatus(statusInput(loaded.launch));
    return {
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        status,
        next: nextActionForStatus(status.recommendedAction),
        summary: summarizeCodexGoalJob(loaded.manifest, loaded.registryRootDir),
    };
}
export async function assertSingleCodexWriterUseCase(args) {
    const loaded = await loadJobLaunch(args);
    const status = await collectCodexGoalStatus(statusInput(loaded.launch));
    const progressStale = status.progressHeartbeatAgeMs !== undefined &&
        status.progressHeartbeatAgeMs >
            (numberValue(args.staleAfterMs) ?? 10 * 60_000);
    const workerLiveness = resolveCodexGoalWorkerLiveness({
        status,
        progressStale,
    });
    const ok = !workerLiveness.alive && status.recommendedAction !== "wait_for_worker";
    return {
        ok,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        status,
        safeToStart: isSafeStartAction(status.recommendedAction),
        safeMessage: ok
            ? "No active tmux writer was found for this job."
            : "A writer appears to be active; do not start another writer in this worktree.",
    };
}
export async function reconcileStoredJobRuntimeResultUseCase(args) {
    return reconcileStoredJobRuntimeResultLifecycle(args, { loadJobLaunch });
}
export async function continueStoredJobUseCase(args, options) {
    return continueStoredJobLifecycle(args, options, { loadJobLaunch });
}
export async function stopStoredJobUseCase(args) {
    return stopStoredJobLifecycle(args, { loadJobLaunch });
}
export async function maintenancePauseStoredJobUseCase(args) {
    return maintenancePauseStoredJobLifecycle(args, { loadJobLaunch });
}
export async function markCodexGoalReviewedUseCase(args) {
    const loaded = await loadJobLaunch(args);
    const projectControlDenial = projectControlGenericToolDenial({
        accessBoundary: loaded.manifest.accessBoundary,
        projectAccessScope: loaded.manifest.projectAccessScope,
        jobId: loaded.manifest.jobId,
        requiredTool: "codex_goal_project_mark_reviewed",
    }) ?? await projectControlGenericScopeDenial({
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        workspacePath: loaded.launch.config.workspacePath,
        requiredTool: "codex_goal_project_mark_reviewed",
    });
    if (projectControlDenial)
        return projectControlDenial;
    await mkdir(loaded.launch.config.jobRootDir, { recursive: true, mode: 0o700 });
    const reviewPath = join(loaded.launch.config.jobRootDir, `${loaded.launch.config.taskId}.review.json`);
    const status = await collectCodexGoalStatus(statusInput(loaded.launch));
    await writeFile(reviewPath, `${JSON.stringify({
        schemaVersion: 1,
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        reviewedAt: new Date().toISOString(),
        note: stringValue(args.note) ?? "reviewed",
        status,
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return { ok: true, jobId: loaded.manifest.jobId, reviewPath, status };
}
export async function buildCodexGoalBriefUseCase(args) {
    const loaded = await loadJobLaunch(args);
    const status = await collectCodexGoalStatus(statusInput(loaded.launch));
    const accounts = await listCodexGoalAccountStatuses({
        authRootDir: loaded.launch.config.authRootDir,
        accounts: loaded.launch.config.accounts.map((account) => account.name),
        stateRootDir: loaded.launch.config.stateRootDir ??
            join(loaded.launch.config.jobRootDir, "state"),
    });
    const brief = await buildCodexGoalBrief({
        jobId: loaded.manifest.jobId,
        launch: loaded.launch,
        status,
        accounts,
        staleAfterMs: numberValue(args.staleAfterMs) ?? 10 * 60_000,
        tailLines: numberValue(args.tailLines) ?? 20,
        ...optionalTargetCommit(await targetCommitFromArgs(args)),
    });
    return {
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        brief,
        status,
    };
}
export async function buildCodexGoalDecisionUseCase(args) {
    const loaded = await loadJobLaunch(args);
    const status = await collectCodexGoalStatus(statusInput(loaded.launch));
    const accounts = await listCodexGoalAccountStatuses({
        authRootDir: loaded.launch.config.authRootDir,
        accounts: loaded.launch.config.accounts.map((account) => account.name),
        stateRootDir: codexGoalStateRootDir(loaded.launch),
    });
    const staleAfterMs = numberValue(args.staleAfterMs) ?? 10 * 60_000;
    const tailLines = numberValue(args.tailLines) ?? 20;
    const brief = await buildCodexGoalBrief({
        jobId: loaded.manifest.jobId,
        launch: loaded.launch,
        status,
        accounts,
        staleAfterMs,
        tailLines,
        ...optionalTargetCommit(await targetCommitFromArgs(args)),
    });
    const overview = booleanValue(args.includeRegistryConflicts) === false
        ? undefined
        : await buildCodexGoalOverviewUseCase({
            registryRootDir: loaded.registryRootDir,
            staleAfterMs,
            tailLines: Math.min(tailLines, 5),
        });
    const decision = buildCodexGoalDecision({
        registryRootDir: loaded.registryRootDir,
        manifest: loaded.manifest,
        launch: loaded.launch,
        status,
        accounts,
        brief,
        ...(overview ? { overview } : {}),
    });
    return {
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        decision,
        brief,
        status,
    };
}
export async function buildCodexGoalHandoffUseCase(args) {
    const loaded = await loadJobLaunch(args);
    const status = await collectCodexGoalStatus(statusInput(loaded.launch));
    const accounts = await listCodexGoalAccountStatuses({
        authRootDir: loaded.launch.config.authRootDir,
        accounts: loaded.launch.config.accounts.map((account) => account.name),
        stateRootDir: codexGoalStateRootDir(loaded.launch),
    });
    const brief = await buildCodexGoalBrief({
        jobId: loaded.manifest.jobId,
        launch: loaded.launch,
        status,
        accounts,
        staleAfterMs: numberValue(args.staleAfterMs) ?? 10 * 60_000,
        tailLines: numberValue(args.tailLines) ?? 20,
        ...optionalTargetCommit(await targetCommitFromArgs(args)),
    });
    const handoff = buildCodexGoalHandoff({
        registryRootDir: loaded.registryRootDir,
        manifest: loaded.manifest,
        launch: loaded.launch,
        brief,
        status,
        accounts,
        includeCliFallback: booleanValue(args.includeCliFallback) ?? true,
    });
    return {
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        handoff,
        brief,
        status,
    };
}
//# sourceMappingURL=codex-goal-job-use-cases.js.map