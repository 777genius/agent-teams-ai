import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AccessBoundary, ProjectControlBroker, } from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalJob, } from "./codex-goal-jobs.js";
import { buildCodexGoalStopTmuxCommand, collectCodexGoalStatus, doctorCodexGoal, prepareCodexGoalLaunchPaths, startCodexGoalTmux, stopCodexGoalDirectProcess, stopCodexGoalTmux, } from "./codex-goal-ops.js";
import { writeCodexGoalReviewMarker } from "./codex-goal-mcp-lifecycle-markers.js";
import { codexGoalStatusInputFromLaunch as statusInput, } from "./codex-goal-mcp-status-input.js";
import { codexProjectAdmissionGate, } from "./application/project-control/codex-goal-project-admission.js";
import { noopOperationResult, } from "./application/project-control/codex-goal-project-control-contracts.js";
import { assertGitCurrentBranch, execGit } from "./codex-goal-mcp-project-git.js";
export function createCodexProjectControlBroker(input) {
    return new ProjectControlBroker({
        boundary: AccessBoundary.ProjectScopedControl,
        scope: input.scope,
    }, {
        ...codexProjectControlPorts(input),
        admission: codexProjectAdmissionGate({
            registryRootDir: input.registryRootDir,
            scope: input.scope,
            deps: input.admissionDeps,
        }),
    });
}
function codexProjectControlPorts(input) {
    return {
        audit: {
            async record(event) {
                await appendProjectControlAuditEvent(input.controller, event);
            },
        },
        registry: {
            async createJob() {
                if (!input.createManifest) {
                    throw new Error("project_control_create_manifest_required");
                }
                const created = await createCodexGoalJob({
                    registryRootDir: input.registryRootDir,
                    manifest: input.createManifest,
                    overwrite: input.createOverwrite ?? false,
                });
                return operationResult(created.jobId);
            },
            async writeReviewMarker(marker) {
                if (!input.reviewLaunch) {
                    throw new Error("project_control_review_launch_required");
                }
                const status = await collectCodexGoalStatus(statusInput(input.reviewLaunch));
                const reviewPath = await writeCodexGoalReviewMarker({
                    jobId: marker.jobId,
                    taskId: input.reviewLaunch.config.taskId,
                    jobRootDir: input.reviewLaunch.config.jobRootDir,
                    note: input.reviewNote ?? marker.note ?? "project_control_reviewed",
                    status,
                });
                return operationResult(reviewPath);
            },
        },
        supervisor: {
            async startWorker() {
                if (!input.startLaunch) {
                    throw new Error("project_control_start_launch_required");
                }
                await prepareCodexGoalLaunchPaths(input.startLaunch);
                if (!input.startSkipDoctor) {
                    const doctor = await doctorCodexGoal({
                        config: input.startLaunch.config,
                        ...(input.startLaunch.tmuxSession
                            ? { tmuxSession: input.startLaunch.tmuxSession }
                            : {}),
                    });
                    if (!doctor.ok) {
                        throw new Error(`project_control_doctor_failed:${JSON.stringify(doctor)}`);
                    }
                }
                const previousBrokeredStart = process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START;
                process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START = "1";
                let command;
                try {
                    command = await startCodexGoalTmux(input.startLaunch);
                }
                finally {
                    if (previousBrokeredStart === undefined) {
                        delete process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START;
                    }
                    else {
                        process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START = previousBrokeredStart;
                    }
                }
                return operationResult(command.preview);
            },
            async stopWorker() {
                if (!input.stopLaunch) {
                    throw new Error("project_control_stop_launch_required");
                }
                const status = await collectCodexGoalStatus(statusInput(input.stopLaunch));
                if (input.stopLaunch.tmuxSession) {
                    if (status.tmuxAlive === false) {
                        return noopOperationResult(buildCodexGoalStopTmuxCommand(input.stopLaunch.tmuxSession).preview, "Worker tmux session is already gone.");
                    }
                    try {
                        const command = await stopCodexGoalTmux(input.stopLaunch.tmuxSession);
                        return operationResult(command.preview);
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        if (/can't find session|no server running/i.test(message)) {
                            return noopOperationResult(buildCodexGoalStopTmuxCommand(input.stopLaunch.tmuxSession).preview, "Worker tmux session is already gone.");
                        }
                        throw error;
                    }
                }
                const command = stopCodexGoalDirectProcess(status);
                if (command.status === "terminated") {
                    return operationResult(command.preview);
                }
                if (command.status === "process_gone" || command.status === "pid_missing") {
                    return noopOperationResult(command.preview, command.status === "process_gone"
                        ? "Worker process is already gone."
                        : "Worker has no direct process pid to stop.");
                }
                throw new Error("project_control_stop_untrusted_process");
            },
        },
        workspace: {
            async createWorktree() {
                if (!input.createWorktreeInput) {
                    throw new Error("project_control_worktree_input_required");
                }
                await mkdir(dirname(input.createWorktreeInput.path), {
                    recursive: true,
                    mode: 0o700,
                });
                const sourceRef = input.createWorktreeInput.sourceRef ?? input.createWorktreeInput.baseBranch;
                const args = [
                    "-C",
                    input.createWorktreeInput.sourceWorkspacePath,
                    "worktree",
                    "add",
                    ...(input.createWorktreeInput.newBranch
                        ? ["-b", input.createWorktreeInput.newBranch]
                        : []),
                    input.createWorktreeInput.path,
                    ...(sourceRef ? [sourceRef] : []),
                ];
                await execGit(args);
                return operationResult(input.createWorktreeInput.path);
            },
        },
        git: {
            async integrateCommit() {
                if (!input.integrateCommitInput) {
                    throw new Error("project_control_integrate_commit_input_required");
                }
                await assertGitCurrentBranch({
                    workspacePath: input.integrateCommitInput.workspacePath,
                    branch: input.integrateCommitInput.branch,
                });
                await execGit([
                    "-C",
                    input.integrateCommitInput.workspacePath,
                    "cherry-pick",
                    "--ff",
                    input.integrateCommitInput.commitSha,
                ]);
                return operationResult(input.integrateCommitInput.commitSha);
            },
            async pushBranch() {
                if (!input.pushBranchInput) {
                    throw new Error("project_control_push_branch_input_required");
                }
                await assertGitCurrentBranch({
                    workspacePath: input.pushBranchInput.workspacePath,
                    branch: input.pushBranchInput.branch,
                });
                await execGit([
                    "-C",
                    input.pushBranchInput.workspacePath,
                    "push",
                    ...(input.pushBranchInput.force ? ["--force-with-lease"] : []),
                    input.pushBranchInput.remote,
                    input.pushBranchInput.branch,
                ]);
                return operationResult(`${input.pushBranchInput.remote}/${input.pushBranchInput.branch}`);
            },
        },
    };
}
async function appendProjectControlAuditEvent(controller, event) {
    const auditPath = projectControlAuditPath(controller);
    await mkdir(dirname(auditPath), { recursive: true, mode: 0o700 });
    await appendFile(auditPath, `${JSON.stringify(event)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
}
export function projectControlAuditPath(controller) {
    return join(controller.jobRootDir, `${controller.taskId}.project-control-events.jsonl`);
}
function operationResult(resourceId) {
    return {
        status: "applied",
        resourceId,
    };
}
//# sourceMappingURL=codex-goal-mcp-project-broker.js.map