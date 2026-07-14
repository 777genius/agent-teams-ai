import { appendFile, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AccessBoundary,
  ProjectControlBroker,
  type ProjectAccessScope,
  type ProjectControlBrokerEvent,
  type ProjectControlBrokerPorts,
  type ProjectControlOperationResult,
} from "@vioxen/subscription-runtime/worker-core";
import {
  createCodexGoalJob,
  type CodexGoalJobManifest,
  type CodexGoalJobManifestInput,
} from "./codex-goal-jobs";
import {
  buildCodexGoalStopTmuxCommand,
  collectCodexGoalStatus,
  doctorCodexGoal,
  prepareCodexGoalLaunchPaths,
  resolveCodexGoalWorkerLiveness,
  startCodexGoalTmux,
  stopCodexGoalDirectProcess,
  stopCodexGoalTmux,
  type CodexGoalLaunchInput,
} from "./codex-goal-ops";
import { writeCodexGoalReviewMarker } from "./codex-goal-mcp-lifecycle-markers";
import { codexGoalStatusInputFromLaunch as statusInput } from "./codex-goal-mcp-status-input";
import {
  codexProjectAdmissionGate,
  type CodexProjectAdmissionDeps,
} from "./application/project-control/codex-goal-project-admission";
import {
  authorizeProjectPreStartAdmissionLaunch,
} from "./application/project-control/codex-goal-project-pre-start-admission";
import {
  assertCodexGoalProjectJobNotTerminal,
} from "./application/project-control/codex-goal-consumed-output-ledger-io";
import type {
  CaptureReviewedWorkerOutputInput,
  ReviewedWorkerOutputSnapshot,
} from "./reviewed-worker-output";
import {
  captureReviewedWorkerOutput,
  commitReviewedWorkerOutputReviewAttestation,
  localReviewedWorkerOutputDeps,
  reviewedWorkerOutputRoot,
  verifyReviewedWorkerOutputStillMatches,
} from "./reviewed-worker-output";
import type { ProjectControlWorkspaceLease } from "./codex-goal-project-workspace-lock";
import {
  noopOperationResult,
  type CodexGoalProjectCreateWorktreeInput,
} from "./application/project-control/codex-goal-project-control-contracts";
import { projectControlRealPathOutsideWorkspaceScope } from "./application/project-control/codex-goal-project-workspace-scope";
import {
  applyVerifiedInputPatch,
  assertGitCurrentBranch,
  execGit,
  execGitStdout,
} from "./codex-goal-mcp-project-git";

export type { CodexGoalProjectCreateWorktreeInput } from "./application/project-control/codex-goal-project-control-contracts";

export type CodexGoalProjectIntegrateCommitInput = {
  readonly workspacePath: string;
  readonly realWorkspacePath?: string;
  readonly branch: string;
  readonly commitSha: string;
};

export type CodexGoalProjectPushBranchInput = {
  readonly workspacePath: string;
  readonly realWorkspacePath?: string;
  readonly branch: string;
  readonly remote: string;
  readonly force: boolean;
};

export async function resolveBoundProjectWorktreeSource(input: {
  readonly sourceWorkspacePath: string;
  readonly expectedSourceRealPath: string;
  readonly scope: ProjectAccessScope;
}): Promise<string> {
  const sourceRealPath = await realpath(input.sourceWorkspacePath);
  if (sourceRealPath !== input.expectedSourceRealPath) {
    throw new Error("project_control_source_workspace_real_path_changed");
  }
  const outsideScope = await projectControlRealPathOutsideWorkspaceScope(
    sourceRealPath,
    input.scope,
  );
  if (outsideScope) {
    throw new Error("project_control_source_workspace_real_path_outside_scope");
  }
  return sourceRealPath;
}

export type CodexProjectControlBrokerInput = {
  readonly registryRootDir: string;
  readonly controller: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
  readonly admissionDeps: CodexProjectAdmissionDeps;
  readonly createManifest?: CodexGoalJobManifestInput;
  readonly createOverwrite?: boolean;
  readonly createWorktreeInput?: CodexGoalProjectCreateWorktreeInput;
  readonly integrateCommitInput?: CodexGoalProjectIntegrateCommitInput;
  readonly pushBranchInput?: CodexGoalProjectPushBranchInput;
  readonly startLaunch?: CodexGoalLaunchInput;
  readonly startManifest?: CodexGoalJobManifest;
  readonly startAdmissionWorkspaceMode?: "reviewed_dirty_continuation";
  readonly startWorkspaceLease?: ProjectControlWorkspaceLease;
  readonly startSkipDoctor?: boolean;
  readonly stopLaunch?: CodexGoalLaunchInput;
  readonly reviewLaunch?: CodexGoalLaunchInput;
  readonly reviewNote?: string;
  readonly reviewedOutputCapture?: Omit<
    CaptureReviewedWorkerOutputInput,
    "workerJobId" | "taskId" | "workspacePath"
  >;
  readonly reviewedContinuation?: ReviewedWorkerOutputSnapshot;
};

export function createCodexProjectControlBroker(
  input: CodexProjectControlBrokerInput,
): ProjectControlBroker {
  return new ProjectControlBroker(
    {
      boundary: AccessBoundary.ProjectScopedControl,
      scope: input.scope,
    },
    {
      ...codexProjectControlPorts(input),
      admission: codexProjectAdmissionGate({
        registryRootDir: input.registryRootDir,
        scope: input.scope,
        deps: input.admissionDeps,
      }),
    },
  );
}

function codexProjectControlPorts(
  input: CodexProjectControlBrokerInput,
): ProjectControlBrokerPorts {
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
        const status = await collectCodexGoalStatus(
          statusInput(input.reviewLaunch),
        );
        let reviewedOutput: ReviewedWorkerOutputSnapshot | undefined;
        const reviewedOutputDeps = localReviewedWorkerOutputDeps({
          rootDir: reviewedWorkerOutputRoot(input.registryRootDir),
        });
        if (input.reviewedOutputCapture) {
          assertReviewedOutputWorkerStopped(input.reviewLaunch, status);
          reviewedOutput = await captureReviewedWorkerOutput(
            reviewedOutputDeps,
            {
              ...input.reviewedOutputCapture,
              workerJobId: marker.jobId,
              taskId: input.reviewLaunch.config.taskId,
              workspacePath: input.reviewLaunch.config.workspacePath,
            },
          );
          const statusAfterCapture = await collectCodexGoalStatus(
            statusInput(input.reviewLaunch),
          );
          assertReviewedOutputWorkerStopped(
            input.reviewLaunch,
            statusAfterCapture,
          );
        }
        const reviewPath = await writeCodexGoalReviewMarker({
          jobId: marker.jobId,
          taskId: input.reviewLaunch.config.taskId,
          jobRootDir: input.reviewLaunch.config.jobRootDir,
          note: input.reviewNote ?? marker.note ?? "project_control_reviewed",
          status,
          ...(reviewedOutput ? { reviewedOutput } : {}),
        });
        if (reviewedOutput) {
          await verifyReviewedWorkerOutputStillMatches(
            reviewedOutputDeps,
            reviewedOutput,
          );
          const statusBeforeAttestation = await collectCodexGoalStatus(
            statusInput(input.reviewLaunch),
          );
          assertReviewedOutputWorkerStopped(
            input.reviewLaunch,
            statusBeforeAttestation,
          );
          await commitReviewedWorkerOutputReviewAttestation({
            store: reviewedOutputDeps.store,
            markerVerifier: reviewedOutputDeps.markerVerifier,
            snapshot: reviewedOutput,
            reviewMarkerPath: reviewPath,
          });
        }
        return operationResult(reviewedOutput?.reviewedOutputId ?? reviewPath);
      },
    },
    supervisor: {
      async startWorker() {
        if (!input.startLaunch) {
          throw new Error("project_control_start_launch_required");
        }
        const startLaunch = input.startLaunch;
        if (!input.startWorkspaceLease) {
          throw new Error("project_control_start_workspace_lease_required");
        }
        if (
          input.startWorkspaceLease.canonicalWorkspacePath !==
          startLaunch.config.workspacePath
        ) {
          throw new Error("project_control_start_workspace_lease_mismatch");
        }
        const start = async () => {
          await assertCodexGoalProjectJobNotTerminal({
            roots: input.scope.consumedOutputLedgerRoots ?? [],
            jobId: input.startManifest?.jobId ?? startLaunch.config.taskId,
            workspacePath: startLaunch.config.workspacePath,
          });
          await prepareCodexGoalLaunchPaths(startLaunch);
          if (!input.startSkipDoctor) {
            const doctor = await doctorCodexGoal({
              config: startLaunch.config,
              ...(startLaunch.tmuxSession
                ? { tmuxSession: startLaunch.tmuxSession }
                : {}),
            });
            if (!doctor.ok) {
              throw new Error(
                `project_control_doctor_failed:${JSON.stringify(doctor)}`,
              );
            }
          }
          if (input.startManifest) {
            await authorizeProjectPreStartAdmissionLaunch({
              manifest: input.startManifest,
              scope: input.scope,
              ...(input.startAdmissionWorkspaceMode
                ? { workspaceMode: input.startAdmissionWorkspaceMode }
                : {}),
            });
          } else if (input.scope.preStartAdmission?.required) {
            throw new Error("project_control_start_manifest_required");
          }
          const previousBrokeredStart =
            process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START;
          process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START = "1";
          let command: Awaited<ReturnType<typeof startCodexGoalTmux>>;
          try {
            command = await startCodexGoalTmux(startLaunch);
          } finally {
            if (previousBrokeredStart === undefined) {
              delete process.env
                .SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START;
            } else {
              process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START =
                previousBrokeredStart;
            }
          }
          return operationResult(command.preview);
        };
        return await start();
      },
      async stopWorker() {
        if (!input.stopLaunch) {
          throw new Error("project_control_stop_launch_required");
        }
        const status = await collectCodexGoalStatus(
          statusInput(input.stopLaunch),
        );
        if (input.stopLaunch.tmuxSession) {
          if (status.tmuxAlive === false) {
            return noopOperationResult(
              buildCodexGoalStopTmuxCommand(input.stopLaunch.tmuxSession)
                .preview,
              "Worker tmux session is already gone.",
            );
          }
          try {
            const command = await stopCodexGoalTmux(
              input.stopLaunch.tmuxSession,
            );
            return operationResult(command.preview);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (/can't find session|no server running/i.test(message)) {
              return noopOperationResult(
                buildCodexGoalStopTmuxCommand(input.stopLaunch.tmuxSession)
                  .preview,
                "Worker tmux session is already gone.",
              );
            }
            throw error;
          }
        }
        const command = stopCodexGoalDirectProcess(status);
        if (command.status === "terminated") {
          return operationResult(command.preview);
        }
        if (
          command.status === "process_gone" ||
          command.status === "pid_missing"
        ) {
          return noopOperationResult(
            command.preview,
            command.status === "process_gone"
              ? "Worker process is already gone."
              : "Worker has no direct process pid to stop.",
          );
        }
        throw new Error("project_control_stop_untrusted_process");
      },
    },
    workspace: {
      async resolveRevision(worktreeInput) {
        const sourceWorkspacePath = await realpath(
          worktreeInput.sourceWorkspacePath ?? input.controller.workspacePath,
        );
        const outsideScope = await projectControlRealPathOutsideWorkspaceScope(
          sourceWorkspacePath,
          input.scope,
        );
        if (outsideScope) {
          throw new Error(
            "project_control_source_workspace_real_path_outside_scope",
          );
        }
        const sourceRef =
          worktreeInput.sourceRef ?? worktreeInput.baseBranch ?? "HEAD";
        const revision = (
          await execGitStdout([
            "-C",
            sourceWorkspacePath,
            "rev-parse",
            "--verify",
            `${sourceRef}^{commit}`,
          ])
        ).trim();
        return { revision, sourceRealPath: sourceWorkspacePath };
      },
      async createWorktree() {
        if (!input.createWorktreeInput) {
          throw new Error("project_control_worktree_input_required");
        }
        if (
          await codexProjectControlPathExists(input.createWorktreeInput.path)
        ) {
          return noopOperationResult(
            input.createWorktreeInput.path,
            "existing worktree candidate delegated for exact identity validation",
          );
        }
        const sourceWorkspacePath = await resolveBoundProjectWorktreeSource({
          sourceWorkspacePath: input.createWorktreeInput.sourceWorkspacePath,
          expectedSourceRealPath:
            input.createWorktreeInput.expectedSourceRealPath,
          scope: input.scope,
        });
        await mkdir(dirname(input.createWorktreeInput.path), {
          recursive: true,
          mode: 0o700,
        });
        const newBranch = input.createWorktreeInput.newBranch;
        const existingBranch = newBranch
          ? (
              await execGitStdout([
                "-C",
                sourceWorkspacePath,
                "for-each-ref",
                "--format=%(refname)",
                `refs/heads/${newBranch}`,
              ])
            ).trim()
          : "";
        const args = [
          "-C",
          sourceWorkspacePath,
          "worktree",
          "add",
          ...(newBranch && !existingBranch ? ["-b", newBranch] : []),
          input.createWorktreeInput.path,
          ...(existingBranch && newBranch
            ? [newBranch]
            : newBranch
              ? [input.createWorktreeInput.expectedRevision]
              : input.createWorktreeInput.sourceRevisionPinned
                ? [input.createWorktreeInput.expectedRevision]
                : [
                    input.createWorktreeInput.sourceRef ??
                      input.createWorktreeInput.baseBranch ??
                      input.createWorktreeInput.expectedRevision,
                  ]),
        ];
        await execGit(args);
        if (input.createWorktreeInput.inputPatch) {
          try {
            await applyVerifiedInputPatch({
              workspacePath: input.createWorktreeInput.path,
              patchPath: input.createWorktreeInput.inputPatch.path,
              expectedSha256: input.createWorktreeInput.inputPatch.sha256,
              expectedBaseCommit:
                input.createWorktreeInput.inputPatch.baseCommit,
              expectedTargetCommit: input.createWorktreeInput.expectedRevision,
              changedPaths: input.createWorktreeInput.inputPatch.changedPaths,
            });
          } catch (error) {
            await execGit([
              "-C",
              sourceWorkspacePath,
              "worktree",
              "remove",
              "--force",
              input.createWorktreeInput.path,
            ]).catch(() => undefined);
            throw error;
          }
        }
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
        return operationResult(
          `${input.pushBranchInput.remote}/${input.pushBranchInput.branch}`,
        );
      },
    },
  };
}

async function codexProjectControlPathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function assertReviewedOutputWorkerStopped(
  launch: CodexGoalLaunchInput,
  status: Awaited<ReturnType<typeof collectCodexGoalStatus>>,
): void {
  const progressStale =
    status.progressHeartbeatAgeMs !== undefined &&
    status.progressHeartbeatAgeMs > 10 * 60_000;
  const liveness = resolveCodexGoalWorkerLiveness({ status, progressStale });
  if (liveness.alive) {
    throw new Error("reviewed_worker_output_worker_still_running");
  }
  if (launch.tmuxSession && status.tmuxAlive === true) {
    throw new Error("reviewed_worker_output_worker_still_running");
  }
}

async function appendProjectControlAuditEvent(
  controller: CodexGoalJobManifest,
  event: ProjectControlBrokerEvent,
): Promise<void> {
  const auditPath = projectControlAuditPath(controller);
  await mkdir(dirname(auditPath), { recursive: true, mode: 0o700 });
  await appendFile(auditPath, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function projectControlAuditPath(
  controller: CodexGoalJobManifest,
): string {
  return join(
    controller.jobRootDir,
    `${controller.taskId}.project-control-events.jsonl`,
  );
}

function operationResult(resourceId: string): ProjectControlOperationResult {
  return {
    status: "applied",
    resourceId,
  };
}
