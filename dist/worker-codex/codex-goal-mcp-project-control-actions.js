import { codexGoalJobToArgs, readCodexGoalJob, } from "./codex-goal-jobs.js";
import { buildCodexGoalNoTmuxCommand, buildCodexGoalStopTmuxCommand, buildCodexGoalTmuxCommand, collectCodexGoalStatus, listCodexGoalAccountStatuses, resolveCodexGoalWorkerLiveness, } from "./codex-goal-ops.js";
import { codexGoalProgressPath } from "./codex-goal-runner.js";
import { runDependencyBootstrap, } from "./dependency-bootstrap.js";
import { projectControlAuditPath, } from "./codex-goal-mcp-project-broker.js";
import { assertReadablePrompt, } from "./codex-goal-mcp-project-refill.js";
import { projectAdmissionWorkerRoleArg, } from "./codex-goal-mcp-project-admission.js";
import { assertProjectControlDependencyBootstrapReady, projectControlDependencyBootstrapMode, projectControlPathArg, projectControlRealPathOutsideWorkspaceScope, } from "./codex-goal-mcp-project-scope.js";
import { assertSafeGitCommitSha, assertSafeGitRefName, assertSafeGitRemoteName, } from "./codex-goal-mcp-project-git.js";
import { writeCodexGoalStopEvent, writeCodexGoalStoppedProgress, } from "./codex-goal-mcp-lifecycle-markers.js";
import { buildCodexGoalBrief } from "./codex-goal-mcp-brief.js";
import { codexGoalStateRootDir, } from "./codex-goal-mcp-worker-control.js";
import { codexGoalStatusInputFromLaunch as statusInput, } from "./codex-goal-mcp-status-input.js";
import { isSafeStartAction, } from "./codex-goal-mcp-decision.js";
import { booleanValue, requiredRawString, stringValue, } from "./codex-goal-mcp-values.js";
import { goalLaunchInput, } from "./codex-goal-mcp-launch-input.js";
export async function projectControlStartStoredJobView(args, deps) {
    const controller = await deps.loadProjectControlController(args);
    const jobId = requiredRawString(args.jobId, "jobId");
    const manifest = await readCodexGoalJob({
        registryRootDir: controller.registryRootDir,
        jobId,
    });
    try {
        await assertReadablePrompt({ promptPath: manifest.promptPath });
    }
    catch (error) {
        return {
            ok: false,
            reason: error instanceof Error
                ? error.message
                : "project_control_prompt_missing_before_start",
            mode: "project_control_start",
            controllerJobId: controller.controller.jobId,
            jobId: manifest.jobId,
            promptPath: manifest.promptPath,
        };
    }
    const loaded = {
        manifest,
        launch: await goalLaunchInput(codexGoalJobToArgs(manifest)),
    };
    const status = await collectCodexGoalStatus(statusInput(loaded.launch));
    const progressStale = status.progressHeartbeatAgeMs !== undefined &&
        status.progressHeartbeatAgeMs > 10 * 60_000;
    const workerLiveness = resolveCodexGoalWorkerLiveness({
        status,
        progressStale,
    });
    if (workerLiveness.alive) {
        return {
            ok: false,
            reason: "worker_already_running",
            controllerJobId: controller.controller.jobId,
            jobId: loaded.manifest.jobId,
            status,
        };
    }
    if (!loaded.launch.tmuxSession) {
        return {
            ok: false,
            reason: "tmux_session_required",
            controllerJobId: controller.controller.jobId,
            jobId: loaded.manifest.jobId,
            noTmuxCommand: buildCodexGoalNoTmuxCommand(loaded.launch),
        };
    }
    if (!isSafeStartAction(status.recommendedAction) && !args.forceStart) {
        return {
            ok: false,
            reason: "status_requires_review",
            controllerJobId: controller.controller.jobId,
            jobId: loaded.manifest.jobId,
            status,
            requiredOverride: "forceStart",
        };
    }
    if (!args.confirmStart) {
        return {
            ok: false,
            reason: "confirm_start_required",
            controllerJobId: controller.controller.jobId,
            jobId: loaded.manifest.jobId,
            auditPath: projectControlAuditPath(controller.controller),
            tmuxCommand: buildCodexGoalTmuxCommand(loaded.launch).preview,
            status,
        };
    }
    const dependencyPreflight = await runDependencyBootstrap({
        workspacePath: loaded.manifest.workspacePath,
        jobRootDir: loaded.manifest.jobRootDir,
        mode: projectControlDependencyBootstrapMode(args.dependencyBootstrap),
        confirmInstall: booleanValue(args.confirmDependencyBootstrap) === true,
    });
    assertProjectControlDependencyBootstrapReady(dependencyPreflight);
    const broker = deps.codexProjectControlBroker({
        registryRootDir: controller.registryRootDir,
        controller: controller.controller,
        scope: controller.scope,
        startLaunch: loaded.launch,
        startSkipDoctor: booleanValue(args.skipDoctor) ?? false,
    });
    const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(loaded.launch.config.workspacePath, controller.scope);
    const result = await broker.startWorker({
        jobId: loaded.manifest.jobId,
        registryRoot: controller.registryRootDir,
        workspacePath: loaded.launch.config.workspacePath,
        ...(realWorkspacePath ? { realWorkspacePath } : {}),
        tmuxSession: loaded.launch.tmuxSession,
        accounts: loaded.manifest.accounts,
        ...(loaded.manifest.tags ? { tags: loaded.manifest.tags } : {}),
    });
    return {
        ok: true,
        mode: "project_control_start",
        controllerJobId: controller.controller.jobId,
        registryRootDir: controller.registryRootDir,
        auditPath: projectControlAuditPath(controller.controller),
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        tmuxSession: loaded.launch.tmuxSession,
        statusBefore: status,
        dependencyPreflight: dependencyPreflight,
        result: result,
    };
}
export async function projectControlCreateWorktreeView(args, deps) {
    const controller = await deps.loadProjectControlController(args);
    const sourceWorkspacePath = projectControlPathArg(args, args.sourceWorkspacePath, "sourceWorkspacePath");
    const path = projectControlPathArg(args, args.path, "path");
    const baseBranch = stringValue(args.baseBranch);
    if (baseBranch)
        assertSafeGitRefName(baseBranch, "baseBranch");
    const sourceRef = stringValue(args.sourceRef);
    if (sourceRef)
        assertSafeGitRefName(sourceRef, "sourceRef");
    const newBranch = stringValue(args.newBranch);
    if (newBranch)
        assertSafeGitRefName(newBranch, "newBranch");
    const effectiveSourceRef = sourceRef ?? baseBranch;
    const workerRole = projectAdmissionWorkerRoleArg(args.workerRole);
    const realSourceWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(sourceWorkspacePath, controller.scope);
    const createWorktreeInput = {
        sourceWorkspacePath,
        ...(realSourceWorkspacePath ? { realSourceWorkspacePath } : {}),
        path,
        ...(baseBranch ? { baseBranch } : {}),
        ...(sourceRef ? { sourceRef } : {}),
        ...(newBranch ? { newBranch } : {}),
        ...(workerRole ? { workerRole } : {}),
    };
    if (!args.confirmCreateWorktree) {
        return {
            ok: false,
            reason: "confirm_create_worktree_required",
            controllerJobId: controller.controller.jobId,
            auditPath: projectControlAuditPath(controller.controller),
            commandPreview: [
                "git",
                "-C",
                sourceWorkspacePath,
                "worktree",
                "add",
                ...(newBranch ? ["-b", newBranch] : []),
                path,
                ...(effectiveSourceRef ? [effectiveSourceRef] : []),
            ],
        };
    }
    const broker = deps.codexProjectControlBroker({
        registryRootDir: controller.registryRootDir,
        controller: controller.controller,
        scope: controller.scope,
        createWorktreeInput,
    });
    const result = await broker.createWorktree(createWorktreeInput);
    const dependencyPreflight = await runDependencyBootstrap({
        workspacePath: path,
        mode: projectControlDependencyBootstrapMode(args.dependencyBootstrap),
        confirmInstall: booleanValue(args.confirmDependencyBootstrap) === true,
    });
    assertProjectControlDependencyBootstrapReady(dependencyPreflight);
    return {
        ok: true,
        mode: "project_control_create_worktree",
        controllerJobId: controller.controller.jobId,
        registryRootDir: controller.registryRootDir,
        auditPath: projectControlAuditPath(controller.controller),
        dependencyPreflight: dependencyPreflight,
        result: result,
    };
}
export async function projectControlIntegrateCommitView(args, deps) {
    const controller = await deps.loadProjectControlController(args);
    const workspacePath = projectControlPathArg(args, args.workspacePath, "workspacePath");
    const branch = requiredRawString(args.branch, "branch");
    const commitSha = requiredRawString(args.commitSha, "commitSha");
    assertSafeGitRefName(branch, "branch");
    assertSafeGitCommitSha(commitSha);
    const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(workspacePath, controller.scope);
    const integrateCommitInput = {
        workspacePath,
        ...(realWorkspacePath ? { realWorkspacePath } : {}),
        branch,
        commitSha,
    };
    if (!args.confirmIntegrate) {
        return {
            ok: false,
            reason: "confirm_integrate_required",
            controllerJobId: controller.controller.jobId,
            auditPath: projectControlAuditPath(controller.controller),
            commandPreview: ["git", "-C", workspacePath, "cherry-pick", "--ff", commitSha],
        };
    }
    const broker = deps.codexProjectControlBroker({
        registryRootDir: controller.registryRootDir,
        controller: controller.controller,
        scope: controller.scope,
        integrateCommitInput,
    });
    const result = await broker.integrateCommit(integrateCommitInput);
    return {
        ok: true,
        mode: "project_control_integrate_commit",
        controllerJobId: controller.controller.jobId,
        registryRootDir: controller.registryRootDir,
        auditPath: projectControlAuditPath(controller.controller),
        result: result,
    };
}
export async function projectControlPushBranchView(args, deps) {
    const controller = await deps.loadProjectControlController(args);
    const workspacePath = projectControlPathArg(args, args.workspacePath, "workspacePath");
    const branch = requiredRawString(args.branch, "branch");
    const remote = stringValue(args.remote) ?? "origin";
    const force = booleanValue(args.force) ?? false;
    assertSafeGitRefName(branch, "branch");
    assertSafeGitRemoteName(remote, "remote");
    const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(workspacePath, controller.scope);
    const pushBranchInput = {
        workspacePath,
        ...(realWorkspacePath ? { realWorkspacePath } : {}),
        branch,
        remote,
        force,
    };
    if (!args.confirmPush) {
        return {
            ok: false,
            reason: "confirm_push_required",
            controllerJobId: controller.controller.jobId,
            auditPath: projectControlAuditPath(controller.controller),
            commandPreview: [
                "git",
                "-C",
                workspacePath,
                "push",
                ...(force ? ["--force-with-lease"] : []),
                remote,
                branch,
            ],
        };
    }
    const broker = deps.codexProjectControlBroker({
        registryRootDir: controller.registryRootDir,
        controller: controller.controller,
        scope: controller.scope,
        pushBranchInput,
    });
    const result = await broker.pushBranch(pushBranchInput);
    return {
        ok: true,
        mode: "project_control_push_branch",
        controllerJobId: controller.controller.jobId,
        registryRootDir: controller.registryRootDir,
        auditPath: projectControlAuditPath(controller.controller),
        result: result,
    };
}
export async function projectControlStopStoredJobView(args, deps) {
    const controller = await deps.loadProjectControlController(args);
    const loaded = await deps.loadJobLaunch({
        registryRootDir: controller.registryRootDir,
        jobId: requiredRawString(args.jobId, "jobId"),
    });
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
        staleAfterMs: 10 * 60_000,
        tailLines: 20,
    });
    const progressStale = status.progressHeartbeatAgeMs !== undefined &&
        status.progressHeartbeatAgeMs > 10 * 60_000;
    const workerLiveness = resolveCodexGoalWorkerLiveness({
        status,
        progressStale,
    });
    const stopCommandPreview = loaded.launch.tmuxSession
        ? buildCodexGoalStopTmuxCommand(loaded.launch.tmuxSession).preview
        : status.progressPid === undefined
            ? "no direct process pid"
            : `kill -TERM ${status.progressPid}`;
    if (workerLiveness.alive &&
        !brief.silentStale &&
        !brief.heartbeatOnlyNoOutput &&
        !args.forceStop) {
        return {
            ok: false,
            reason: "worker_not_silent_stale_or_heartbeat_only_no_output",
            controllerJobId: controller.controller.jobId,
            jobId: loaded.manifest.jobId,
            ...(loaded.launch.tmuxSession ? { tmuxSession: loaded.launch.tmuxSession } : {}),
            requiredOverride: "forceStop",
            stopCommand: stopCommandPreview,
            status,
            brief,
        };
    }
    if (!args.confirmStop) {
        return {
            ok: false,
            reason: "confirm_stop_required",
            controllerJobId: controller.controller.jobId,
            jobId: loaded.manifest.jobId,
            ...(loaded.launch.tmuxSession ? { tmuxSession: loaded.launch.tmuxSession } : {}),
            stopCommand: stopCommandPreview,
            auditPath: projectControlAuditPath(controller.controller),
            status,
            brief,
        };
    }
    const broker = deps.codexProjectControlBroker({
        registryRootDir: controller.registryRootDir,
        controller: controller.controller,
        scope: controller.scope,
        stopLaunch: loaded.launch,
    });
    const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(loaded.launch.config.workspacePath, controller.scope);
    const result = await broker.stopWorker({
        jobId: loaded.manifest.jobId,
        registryRoot: controller.registryRootDir,
        workspacePath: loaded.launch.config.workspacePath,
        ...(realWorkspacePath ? { realWorkspacePath } : {}),
        ...(loaded.launch.tmuxSession ? { tmuxSession: loaded.launch.tmuxSession } : {}),
    });
    await writeCodexGoalStoppedProgress({
        progressPath: loaded.launch.config.progressPath ?? codexGoalProgressPath({
            jobRootDir: loaded.launch.config.jobRootDir,
            taskId: loaded.launch.config.taskId,
        }),
        taskId: loaded.launch.config.taskId,
        status: "stopped",
    });
    const statusAfter = await collectCodexGoalStatus(statusInput(loaded.launch));
    const stopEventPath = await writeCodexGoalStopEvent({
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        jobRootDir: loaded.launch.config.jobRootDir,
        ...(loaded.launch.tmuxSession ? { tmuxSession: loaded.launch.tmuxSession } : {}),
        stopCommand: String(result.resourceId ?? stopCommandPreview),
        forceStop: Boolean(args.forceStop),
        statusBefore: status,
        statusAfter,
        brief,
    });
    return {
        ok: true,
        mode: "project_control_stop",
        controllerJobId: controller.controller.jobId,
        registryRootDir: controller.registryRootDir,
        auditPath: projectControlAuditPath(controller.controller),
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        ...(loaded.launch.tmuxSession ? { tmuxSession: loaded.launch.tmuxSession } : {}),
        stopEventPath,
        statusBefore: status,
        statusAfter,
        result: result,
    };
}
export async function projectControlMarkReviewedView(args, deps) {
    const controller = await deps.loadProjectControlController(args);
    const loaded = await deps.loadJobLaunch({
        registryRootDir: controller.registryRootDir,
        jobId: requiredRawString(args.jobId, "jobId"),
    });
    const broker = deps.codexProjectControlBroker({
        registryRootDir: controller.registryRootDir,
        controller: controller.controller,
        scope: controller.scope,
        reviewLaunch: loaded.launch,
        reviewNote: stringValue(args.note) ?? "project_control_reviewed",
    });
    const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(loaded.launch.config.workspacePath, controller.scope);
    const result = await broker.writeReviewMarker({
        jobId: loaded.manifest.jobId,
        registryRoot: controller.registryRootDir,
        workspacePath: loaded.launch.config.workspacePath,
        ...(realWorkspacePath ? { realWorkspacePath } : {}),
        ...(loaded.launch.tmuxSession ? { tmuxSession: loaded.launch.tmuxSession } : {}),
        markerType: "review",
        note: stringValue(args.note) ?? "project_control_reviewed",
    });
    return {
        ok: true,
        mode: "project_control_mark_reviewed",
        controllerJobId: controller.controller.jobId,
        registryRootDir: controller.registryRootDir,
        auditPath: projectControlAuditPath(controller.controller),
        jobId: loaded.manifest.jobId,
        result: result,
    };
}
//# sourceMappingURL=codex-goal-mcp-project-control-actions.js.map