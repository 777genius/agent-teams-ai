import { appendFile, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
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
import { buildCodexGoalBrief } from "./codex-goal-mcp-brief";
import { codexGoalStatusInputFromLaunch as statusInput } from "./codex-goal-mcp-status-input";
import {
  codexProjectAdmissionGate,
  type CodexProjectAdmissionDeps,
} from "./application/project-control/codex-goal-project-admission";
import {
  withProjectPreStartAdmissionLaunchAuthorization,
} from "./application/project-control/codex-goal-project-pre-start-launch-authorization";
import type { ProjectPreStartAdmissionLaunchWorkspaceMode } from "./application/project-control/codex-goal-project-pre-start-admission";
import {
  assertCodexGoalProjectJobNotTerminal,
} from "./application/project-control/codex-goal-consumed-output-ledger-io";
import { decideCodexGoalProjectStop } from "./application/project-control/codex-goal-project-stop-policy";
import type {
  CaptureReviewedWorkerOutputInput,
  ReviewedWorkerOutputSnapshot,
} from "./reviewed-worker-output";
import {
  assertReviewedWorkerOutputStillMatchesLocked,
  captureReviewedWorkerOutputLocked,
  commitReviewedWorkerOutputReviewAttestation,
  localReviewedWorkerOutputDeps,
  reviewedWorkerOutputRoot,
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
  isGitAncestor,
} from "./codex-goal-mcp-project-git";
import { pushProjectBranch } from "./application/project-control/codex-goal-project-external-rewrite-recovery";

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
  readonly expectedRemoteCommit?: string;
  readonly expectedLocalCommit?: string;
  readonly confirmExternalRewriteRecovery?: boolean;
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
  readonly admittedInputPatchTarget?: {
    readonly jobId: string;
    readonly workspacePath: string;
  };
  readonly integrateCommitInput?: CodexGoalProjectIntegrateCommitInput;
  readonly pushBranchInput?: CodexGoalProjectPushBranchInput;
  readonly startLaunch?: CodexGoalLaunchInput;
  readonly startManifest?: CodexGoalJobManifest;
  readonly startAdmissionWorkspaceMode?: ProjectPreStartAdmissionLaunchWorkspaceMode;
  readonly startWorkspaceLease?: ProjectControlWorkspaceLease;
  readonly startSkipDoctor?: boolean;
  readonly stopLaunch?: CodexGoalLaunchInput;
  readonly reviewLaunch?: CodexGoalLaunchInput;
  readonly reviewWorkspaceLease?: ProjectControlWorkspaceLease;
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
  const admittedInputPatchTarget =
    input.admittedInputPatchTarget ??
    ((input.startAdmissionWorkspaceMode === "admitted_input_patch" &&
        input.startManifest &&
        input.startWorkspaceLease) ||
      (input.createWorktreeInput?.inputPatch && input.createWorktreeInput.jobId)
      ? {
          jobId: input.startManifest?.jobId ??
            input.createWorktreeInput?.jobId ?? "",
          workspacePath: input.startWorkspaceLease?.canonicalWorkspacePath ??
            input.createWorktreeInput?.path ?? "",
        }
      : undefined);
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
        ...((input.startAdmissionWorkspaceMode ===
              "admitted_input_patch_continuation" ||
            input.startAdmissionWorkspaceMode ===
              "admitted_input_patch_runtime_continuation" ||
            input.startAdmissionWorkspaceMode ===
              "clean_capacity_continuation") &&
            input.startManifest &&
            input.startWorkspaceLease
          ? {
              capacityContinuationTarget: {
                jobId: input.startManifest.jobId,
                workspacePath:
                  input.startWorkspaceLease.canonicalWorkspacePath,
              },
            }
          : {}),
        ...(admittedInputPatchTarget
          ? { admittedInputPatchTarget }
          : {}),
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
        if (
          !input.reviewWorkspaceLease ||
          input.reviewWorkspaceLease.canonicalWorkspacePath !==
            input.reviewLaunch.config.workspacePath
        ) {
          throw new Error("project_control_review_workspace_lease_required");
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
          await reviewedOutputDeps.continuationEnvironment.sanitizeDependencyRootLinks({
            workspacePath: input.reviewLaunch.config.workspacePath,
          });
          reviewedOutput = await captureReviewedWorkerOutputLocked(
            reviewedOutputDeps,
            {
              ...input.reviewedOutputCapture,
              workerJobId: marker.jobId,
              taskId: input.reviewLaunch.config.taskId,
              workspacePath: input.reviewLaunch.config.workspacePath,
            },
            input.reviewWorkspaceLease.lease,
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
          await assertReviewedWorkerOutputStillMatchesLocked(
            reviewedOutputDeps,
            reviewedOutput,
            input.reviewWorkspaceLease.lease,
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
            projectId: input.scope.projectId,
            controllerJobId: input.controller.jobId,
            jobId: input.startManifest?.jobId ?? startLaunch.config.taskId,
            taskId: startLaunch.config.taskId,
            workspacePath: startLaunch.config.workspacePath,
            ...(input.reviewedContinuation
              ? { reviewedContinuation: input.reviewedContinuation }
              : {}),
            ...(input.startAdmissionWorkspaceMode ===
                "admitted_input_patch_continuation" ||
              input.startAdmissionWorkspaceMode ===
                "clean_capacity_continuation"
              ? { capacityContinuation: true as const }
              : {}),
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
          if (!input.startManifest && input.scope.preStartAdmission?.required) {
            throw new Error("project_control_start_manifest_required");
          }
          const previousBrokeredStart =
            process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START;
          process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START = "1";
          let command: Awaited<ReturnType<typeof startCodexGoalTmux>>;
          try {
            command = input.startManifest
              ? await withProjectPreStartAdmissionLaunchAuthorization(
                {
                  manifest: input.startManifest,
                  scope: input.scope,
                  ...(input.startAdmissionWorkspaceMode
                    ? { workspaceMode: input.startAdmissionWorkspaceMode }
                    : {}),
                },
                async () => await startCodexGoalTmux(startLaunch),
              )
              : await startCodexGoalTmux(startLaunch);
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
        const brief = await buildCodexGoalBrief({
          jobId: input.stopLaunch.config.taskId,
          launch: input.stopLaunch,
          status,
          accounts: [],
          staleAfterMs: 10 * 60_000,
          tailLines: 20,
        });
        const capacityContinuation =
          input.startAdmissionWorkspaceMode ===
            "admitted_input_patch_continuation" ||
          input.startAdmissionWorkspaceMode === "clean_capacity_continuation";
        const stopPolicy = decideCodexGoalProjectStop({
          ...brief.workerHealth,
          terminalCapacityPause: capacityContinuation,
        });
        if (!stopPolicy.allowed) {
          throw new Error(stopPolicy.reason);
        }
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
          if (input.createWorktreeInput.fastForwardExisting) {
            const fastForwarded = await fastForwardExistingProjectWorktree({
              input: input.createWorktreeInput,
              scope: input.scope,
            });
            if (fastForwarded) {
              return operationResult(input.createWorktreeInput.path);
            }
          }
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
        const targetIsDescendant = await isGitAncestor({
          workspacePath: input.integrateCommitInput.workspacePath,
          ancestor: "HEAD",
          descendant: input.integrateCommitInput.commitSha,
        });
        await execGit([
          "-C",
          input.integrateCommitInput.workspacePath,
          ...(targetIsDescendant
            ? ["merge", "--ff-only", input.integrateCommitInput.commitSha]
            : ["cherry-pick", "--ff", input.integrateCommitInput.commitSha]),
        ]);
        return operationResult(input.integrateCommitInput.commitSha);
      },
      async pushBranch() {
        if (!input.pushBranchInput) {
          throw new Error("project_control_push_branch_input_required");
        }
        await pushProjectBranch(input.pushBranchInput);
        return operationResult(
          `${input.pushBranchInput.remote}/${input.pushBranchInput.branch}`,
        );
      },
    },
  };
}

export async function fastForwardExistingProjectWorktree(input: {
  readonly input: CodexGoalProjectCreateWorktreeInput;
  readonly scope: ProjectAccessScope;
  readonly afterFastForwardForTest?: () => Promise<void>;
}): Promise<boolean> {
  const request = input.input;
  const fastForward = request.fastForwardExisting;
  if (!fastForward) return false;
  if (!request.sourceRevisionPinned) {
    throw new Error("project_control_existing_worktree_fast_forward_unpinned");
  }
  if (!request.newBranch || request.sourceRef !== request.newBranch) {
    throw new Error("project_control_existing_worktree_fast_forward_branch_required");
  }
  if (request.inputPatch) {
    throw new Error("project_control_existing_worktree_fast_forward_patch_forbidden");
  }
  const materializedRealPath = await realpath(request.path);
  if (!request.expectedRealPath || materializedRealPath !== request.expectedRealPath) {
    throw new Error("project_control_existing_worktree_fast_forward_real_path_changed");
  }
  if (
    await projectControlRealPathOutsideWorkspaceScope(
      materializedRealPath,
      input.scope,
    )
  ) {
    throw new Error("project_control_existing_worktree_real_path_outside_scope");
  }
  const [sourceCommonDir, worktreeCommonDir] = await Promise.all([
    resolveGitCommonDir(request.expectedSourceRealPath),
    resolveGitCommonDir(materializedRealPath),
  ]);
  if (sourceCommonDir !== worktreeCommonDir) {
    throw new Error("project_control_existing_worktree_foreign_repository");
  }
  const statusBefore = await execGitStdout([
    "-C",
    materializedRealPath,
    "status",
    "--porcelain",
  ]);
  if (statusBefore.trim().length > 0) {
    throw new Error("project_control_existing_worktree_fast_forward_dirty");
  }
  await assertGitCurrentBranch({
    workspacePath: materializedRealPath,
    branch: request.newBranch,
  });
  const current = (
    await execGitStdout(["-C", materializedRealPath, "rev-parse", "HEAD"])
  ).trim().toLowerCase();
  const expectedCurrent = fastForward.expectedCurrentRevision.toLowerCase();
  const expectedNext = request.expectedRevision.toLowerCase();
  if (current === expectedNext) {
    if (expectedCurrent === expectedNext) return false;
    try {
      if (await isGitAncestor({
        workspacePath: materializedRealPath,
        ancestor: expectedCurrent,
        descendant: expectedNext,
      })) return false;
    } catch {
      // The regular current-mismatch error below is the stable public result.
    }
  }
  if (current !== expectedCurrent) {
    throw new Error("project_control_existing_worktree_fast_forward_current_mismatch");
  }
  if (!await isGitAncestor({
    workspacePath: materializedRealPath,
    ancestor: expectedCurrent,
    descendant: expectedNext,
  })) {
    throw new Error("project_control_existing_worktree_fast_forward_non_ancestor");
  }
  await execGit([
    "-c",
    "core.hooksPath=/dev/null",
    "-C",
    materializedRealPath,
    "merge",
    "--ff-only",
    "--no-stat",
    expectedNext,
  ]);
  await input.afterFastForwardForTest?.();
  try {
    const confirmed = (
      await execGitStdout(["-C", materializedRealPath, "rev-parse", "HEAD"])
    ).trim().toLowerCase();
    const statusAfter = await execGitStdout([
      "-C",
      materializedRealPath,
      "status",
      "--porcelain",
    ]);
    if (confirmed !== expectedNext || statusAfter.trim().length > 0) {
      throw new Error("project_control_existing_worktree_fast_forward_verification_failed");
    }
  } catch (error) {
    const rollback = await rollbackFastForwardRevision({
      workspacePath: materializedRealPath,
      expectedCurrent,
      expectedNext,
    });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}; rollback=${rollback}`);
  }
  return true;
}

async function resolveGitCommonDir(workspacePath: string): Promise<string> {
  const commonDir = (
    await execGitStdout(["-C", workspacePath, "rev-parse", "--git-common-dir"])
  ).trim();
  return await realpath(
    isAbsolute(commonDir) ? commonDir : join(workspacePath, commonDir),
  );
}

async function rollbackFastForwardRevision(input: {
  readonly workspacePath: string;
  readonly expectedCurrent: string;
  readonly expectedNext: string;
}): Promise<string> {
  const observed = (
    await execGitStdout(["-C", input.workspacePath, "rev-parse", "HEAD"])
  ).trim().toLowerCase();
  if (observed !== input.expectedNext) return "skipped_head_changed";
  const status = await execGitStdout([
    "-C",
    input.workspacePath,
    "status",
    "--porcelain",
  ]);
  if (status.trim().length > 0) return "skipped_dirty";
  try {
    await execGit([
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      input.workspacePath,
      "reset",
      "--merge",
      input.expectedCurrent,
    ]);
  } catch {
    return "failed_preserved";
  }
  const restored = (
    await execGitStdout(["-C", input.workspacePath, "rev-parse", "HEAD"])
  ).trim().toLowerCase();
  return restored === input.expectedCurrent ? "revision" : "failed_preserved";
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
