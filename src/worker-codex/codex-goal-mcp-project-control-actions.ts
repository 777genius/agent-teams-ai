import {
  ProjectAdmissionWorkerRole,
  type ProjectAccessScope,
  type ProjectControlBroker,
} from "@vioxen/subscription-runtime/worker-core";
import { readCodexGoalJob, type CodexGoalJobManifest } from "./codex-goal-jobs";
import {
  buildCodexGoalNoTmuxCommand,
  buildCodexGoalStopTmuxCommand,
  buildCodexGoalTmuxCommand,
  collectCodexGoalStatus,
  listCodexGoalAccountStatuses,
  type CodexGoalLaunchInput,
} from "./codex-goal-ops";
import { codexGoalProgressPath } from "./codex-goal-runner";
import { runDependencyBootstrap } from "./dependency-bootstrap";
import {
  type CodexGoalProjectCreateWorktreeInput,
  type CodexGoalProjectIntegrateCommitInput,
  type CodexGoalProjectPushBranchInput,
  type CodexProjectControlBrokerInput,
  projectControlAuditPath,
} from "./codex-goal-mcp-project-broker";
import { createOrReuseProjectWorktree } from "./application/project-control/codex-goal-project-refill";
import {
  assertProjectPreStartAdmissionLaunchBinding,
  validateStoredProjectPreStartAdmission,
} from "./application/project-control/codex-goal-project-pre-start-admission";
import {
  terminalHandoffDependencyRecoveryRequested,
  verifyTerminalHandoffRecovery,
} from "./application/project-control/codex-goal-project-terminal-handoff-recovery";
import { projectAdmissionWorkerRoleArg } from "./application/project-control/codex-goal-project-admission";
import {
  assertProjectControlDependencyBootstrapReady,
  projectControlCanonicalWorkspacePath,
  projectControlDependencyBootstrapMode,
  projectControlPathArg,
  projectControlRealPathIfExists,
  projectControlRealPathOutsideWorkspaceScope,
} from "./codex-goal-mcp-project-scope";
import {
  assertSafeGitCommitSha,
  assertSafeGitRefName,
  assertSafeGitRemoteName,
} from "./codex-goal-mcp-project-git";
import { resolveProjectExternalRewriteRecovery } from "./application/project-control/codex-goal-project-external-rewrite-recovery";
import {
  resolveProjectSourceReference,
  resolveProjectSourceRevision,
} from "./application/project-control/codex-goal-project-source-revision";
import {
  writeCodexGoalStopEvent,
  writeCodexGoalStoppedProgress,
} from "./codex-goal-mcp-lifecycle-markers";
import { buildCodexGoalBrief } from "./codex-goal-mcp-brief";
import {
  assertProjectPreStartContinuationEvidence,
  loadProjectPreStartObservation,
  observeProjectPreStartContinuation,
  projectConfirmStartRequiredView,
  projectPromptFailureView,
  projectStatusRequiresReviewView,
  projectTmuxSessionRequiredView,
  projectWorkerAlreadyRunningView,
  reapProjectPreStartCapacitySupervisor,
  sameProjectPreStartContinuation,
} from "./codex-goal-project-continuation-runtime";
import { isCapacityContinuationDecision } from "./application/project-control/codex-goal-project-pre-start-continuation";
import { codexGoalStateRootDir } from "./application/codex-goal-worker-control";
import { codexGoalStatusInputFromLaunch as statusInput } from "./codex-goal-mcp-status-input";
import { isSafeStartAction } from "./codex-goal-mcp-decision";
import {
  assertReviewedWorkerContinuationEnvironmentLocked,
  assertReviewedWorkerOutputStillMatchesLocked,
  localReviewedWorkerOutputDeps,
  resolveReviewedWorkerContinuation,
  reviewedWorkerOutputRoot,
  sanitizeReviewedWorkerContinuationEnvironmentLocked,
} from "./reviewed-worker-output";
import {
  booleanValue,
  requiredRawString,
  stringValue,
} from "./codex-goal-mcp-values";
import {
  parseProjectIntegrationChecks,
  requiredStringArrayArg,
} from "./project-integration-mcp/application/project-integration-mcp-values";
import type {
  JobIdMcpArgs,
  ProjectControlMcpArgs,
} from "./codex-goal-mcp-inputs";
import { localCodexProjectSafeExecutionJournal } from "./codex-goal-project-safe-execution-journal";
import {
  codexProjectContinuationReservationInput,
  releaseCodexProjectAccount,
  reserveCodexProjectAccount,
} from "./application/project-control/codex-goal-project-account-reservation";
import { decideCodexGoalProjectStop } from "./application/project-control/codex-goal-project-stop-policy";
import { withProjectContinuationAccounts } from "./application/project-control/codex-goal-project-continuation-accounts";
import {
  projectControlWorkspaceLocks,
  withValidatedProjectWorkspaceLock,
} from "./codex-goal-project-workspace-lock";
type JsonObject = Readonly<Record<string, unknown>>;
type LoadedProjectControlController = {
  readonly registryRootDir: string;
  readonly controller: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
};

type LoadedCodexGoalJobLaunch = {
  readonly registryRootDir: string;
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
};

export type CodexGoalMcpProjectControlActionsDeps = {
  readonly loadProjectControlController: (
    args: ProjectControlMcpArgs,
  ) => Promise<LoadedProjectControlController>;
  readonly loadJobLaunch: (
    args: JobIdMcpArgs,
  ) => Promise<LoadedCodexGoalJobLaunch>;
  readonly codexProjectControlBroker: (
    input: Omit<CodexProjectControlBrokerInput, "admissionDeps">,
  ) => ProjectControlBroker;
  readonly dependencyBootstrap?: typeof runDependencyBootstrap;
  readonly safeExecutionJournal?: ReturnType<
    typeof localCodexProjectSafeExecutionJournal
  >;
  readonly listAccountStatuses?: typeof listCodexGoalAccountStatuses;
};

export async function projectControlStartStoredJobView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlActionsDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const jobId = requiredRawString(args.jobId, "jobId");
  const manifest = await readCodexGoalJob({
    registryRootDir: controller.registryRootDir,
    jobId,
  });
  const promptFailure = await projectPromptFailureView({
    controllerJobId: controller.controller.jobId,
    jobId: manifest.jobId,
    promptPath: manifest.promptPath,
  });
  if (promptFailure) return promptFailure;
  const reviewedOutputId = stringValue(args.reviewedOutputId);
  const loaded = await loadProjectPreStartObservation(
    manifest,
    reviewedOutputId,
  );
  const { status, decision: continuationDecision } = loaded;
  if (
    loaded.workerAlive &&
    !isCapacityContinuationDecision(continuationDecision)
  ) {
    return projectWorkerAlreadyRunningView({
      controllerJobId: controller.controller.jobId,
      jobId: loaded.manifest.jobId,
      status,
    });
  }
  if (!loaded.launch.tmuxSession) {
    return projectTmuxSessionRequiredView(
      controller.controller.jobId,
      loaded.manifest.jobId,
      buildCodexGoalNoTmuxCommand(loaded.launch),
    );
  }
  if (!isSafeStartAction(status.recommendedAction) && !args.forceStart) {
    return projectStatusRequiresReviewView({
      controllerJobId: controller.controller.jobId,
      jobId: loaded.manifest.jobId,
      status,
    });
  }
  if (!args.confirmStart) {
    return projectConfirmStartRequiredView(
      controller.controller.jobId,
      loaded.manifest.jobId,
      projectControlAuditPath(controller.controller),
      buildCodexGoalTmuxCommand(loaded.launch).preview,
      status,
    );
  }
  const workspaceDirty = status.workspaceDirty === true;
  const cleanExplicitContinuation =
    args.forceStart === true &&
    !workspaceDirty &&
    continuationDecision === undefined &&
    reviewedOutputId === undefined &&
    loaded.manifest.projectPreStartAdmission !== undefined;
  const terminalHandoffDependencyRecovery =
    terminalHandoffDependencyRecoveryRequested({
      status,
      ...(reviewedOutputId ? { reviewedOutputId } : {}),
      forceStart: args.forceStart === true,
      ...(typeof args.dependencyBootstrap === "string"
        ? { dependencyBootstrap: args.dependencyBootstrap }
        : {}),
      confirmDependencyBootstrap:
        booleanValue(args.confirmDependencyBootstrap) === true,
    });
  if (workspaceDirty && continuationDecision === undefined) {
    if (!args.forceStart) {
      throw new Error(
        "project_control_reviewed_dirty_continuation_force_required",
      );
    }
    if (!reviewedOutputId && !terminalHandoffDependencyRecovery) {
      throw new Error(
        "project_control_reviewed_dirty_continuation_output_required",
      );
    }
  } else if (reviewedOutputId) {
    throw new Error(
      "project_control_reviewed_dirty_continuation_clean_workspace",
    );
  }
  const locks = projectControlWorkspaceLocks(controller.registryRootDir);
  return await withValidatedProjectWorkspaceLock({
    locks,
    scope: controller.scope,
    requestedWorkspacePath: loaded.manifest.workspacePath,
    owner: `project-start:${controller.controller.jobId}:${loaded.manifest.jobId}`,
    effect: async (workspace) => {
      const lockedObservation = await observeProjectPreStartContinuation({
        manifest: loaded.manifest,
        launch: loaded.launch,
        ...(reviewedOutputId ? { reviewedOutputId } : {}),
      });
      const { status: lockedStatus, decision: lockedContinuationDecision } =
        lockedObservation;
      if (
        lockedObservation.workerAlive &&
        !isCapacityContinuationDecision(lockedContinuationDecision)
      ) {
        return projectWorkerAlreadyRunningView({
          controllerJobId: controller.controller.jobId,
          jobId: loaded.manifest.jobId,
          status: lockedStatus,
        });
      }
      if ((lockedStatus.workspaceDirty === true) !== workspaceDirty) {
        throw new Error("project_control_workspace_state_changed_before_start");
      }
      if (
        !sameProjectPreStartContinuation(
          lockedContinuationDecision,
          continuationDecision,
        )
      ) {
        throw new Error("project_control_workspace_state_changed_before_start");
      }
      if (
        terminalHandoffDependencyRecovery &&
        !terminalHandoffDependencyRecoveryRequested({
          status: lockedStatus,
          forceStart: args.forceStart === true,
          dependencyBootstrap: "install",
          confirmDependencyBootstrap: true,
        })
      ) {
        throw new Error(
          "project_control_terminal_handoff_recovery_status_changed",
        );
      }
      if (
        !isSafeStartAction(lockedStatus.recommendedAction) &&
        !args.forceStart
      ) {
        return projectStatusRequiresReviewView({
          controllerJobId: controller.controller.jobId,
          jobId: loaded.manifest.jobId,
          status: lockedStatus,
        });
      }
      const reviewedOutputDeps = localReviewedWorkerOutputDeps({
        rootDir: reviewedWorkerOutputRoot(controller.registryRootDir),
        locks,
      });
      const reviewedContinuation =
        workspaceDirty && reviewedOutputId
          ? await resolveReviewedWorkerContinuation({
              store: reviewedOutputDeps.store,
              projectId: controller.scope.projectId,
              controllerJobId: controller.controller.jobId,
              workerJobId: loaded.manifest.jobId,
              taskId: loaded.launch.config.taskId,
              workspacePath: workspace.canonicalWorkspacePath,
              reviewedOutputId,
            })
          : undefined;
      const terminalRecovery = terminalHandoffDependencyRecovery
        ? await verifyTerminalHandoffRecovery({
            producer: loaded.manifest,
            workspacePath: workspace.canonicalWorkspacePath,
            snapshotter: reviewedOutputDeps.snapshotter,
          })
        : undefined;
      if (reviewedContinuation) {
        const sanitized =
          await sanitizeReviewedWorkerContinuationEnvironmentLocked(
            reviewedOutputDeps,
            reviewedContinuation,
            workspace.lease,
          );
        if (sanitized.removedPaths.length > 0) {
          return {
            ok: false,
            reason:
              "project_control_dependency_environment_sanitized_recapture_required",
            controllerJobId: controller.controller.jobId,
            jobId: loaded.manifest.jobId,
            reviewedOutputId,
            sanitizedPaths: sanitized.removedPaths,
          };
        }
      }
      if (continuationDecision) {
        await assertProjectPreStartAdmissionLaunchBinding({
          manifest: loaded.manifest,
          scope: controller.scope,
          workspaceMode: continuationDecision.workspaceMode,
        });
      }
      const canonicalLaunch: CodexGoalLaunchInput = {
        ...loaded.launch,
        config: {
          ...loaded.launch.config,
          workspacePath: workspace.canonicalWorkspacePath,
        },
      };
      await assertProjectPreStartContinuationEvidence({
        decision: lockedContinuationDecision,
        manifest: loaded.manifest,
        launch: canonicalLaunch,
      });
      const capacitySupervisorReap =
        await reapProjectPreStartCapacitySupervisor({
          workerAlive: lockedObservation.workerAlive,
          decision: lockedContinuationDecision,
          createBroker: deps.codexProjectControlBroker,
          registryRootDir: controller.registryRootDir,
          controller: controller.controller,
          scope: controller.scope,
          manifest: loaded.manifest,
          launch: canonicalLaunch,
          workspace,
        });
      const dependencyPreflight = await (
        deps.dependencyBootstrap ?? runDependencyBootstrap
      )({
        workspacePath: workspace.canonicalWorkspacePath,
        jobRootDir: loaded.manifest.jobRootDir,
        cacheNamespace: controller.scope.projectId,
        mode: projectControlDependencyBootstrapMode(args.dependencyBootstrap),
        confirmInstall: booleanValue(args.confirmDependencyBootstrap) === true,
      });
      assertProjectControlDependencyBootstrapReady(dependencyPreflight);
      if (reviewedContinuation) {
        await assertReviewedWorkerOutputStillMatchesLocked(
          reviewedOutputDeps,
          reviewedContinuation,
          workspace.lease,
        );
        await assertReviewedWorkerContinuationEnvironmentLocked(
          reviewedOutputDeps,
          workspace.lease,
        );
        await assertProjectPreStartAdmissionLaunchBinding({
          manifest: loaded.manifest,
          scope: controller.scope,
          workspaceMode: "reviewed_dirty_continuation",
        });
      } else if (terminalRecovery) {
        await verifyTerminalHandoffRecovery({
          producer: loaded.manifest,
          workspacePath: workspace.canonicalWorkspacePath,
          snapshotter: reviewedOutputDeps.snapshotter,
          expected: terminalRecovery,
        });
        await assertReviewedWorkerContinuationEnvironmentLocked(
          reviewedOutputDeps,
          workspace.lease,
        );
        await assertProjectPreStartAdmissionLaunchBinding({
          manifest: loaded.manifest,
          scope: controller.scope,
          workspaceMode: "terminal_handoff_dependency_recovery",
        });
      } else if (continuationDecision || cleanExplicitContinuation) {
        await assertProjectPreStartAdmissionLaunchBinding({
          manifest: loaded.manifest,
          scope: controller.scope,
          workspaceMode:
            continuationDecision?.workspaceMode ??
            "clean_explicit_continuation",
        });
      } else {
        await validateStoredProjectPreStartAdmission({
          manifest: loaded.manifest,
          scope: controller.scope,
        });
      }
      const continuationReservation =
        await codexProjectContinuationReservationInput({
          status: lockedStatus,
          launch: canonicalLaunch,
          journal:
            deps.safeExecutionJournal ??
            localCodexProjectSafeExecutionJournal(canonicalLaunch),
        });
      const continuationLaunch = await withProjectContinuationAccounts({
        launch: canonicalLaunch,
        ...(args.continuationAccounts === undefined
          ? {}
          : {
              requestedAccounts:
                typeof args.continuationAccounts === "string"
                  ? [args.continuationAccounts]
                  : args.continuationAccounts,
            }),
        ...(continuationReservation.continuation
          ? { continuation: continuationReservation.continuation }
          : {}),
        excludedAccountIds: continuationReservation.excludedAccountIds,
        allowedAccountIds: controller.scope.allowedAccountIds ?? [],
        ...(deps.listAccountStatuses
          ? { listAccountStatuses: deps.listAccountStatuses }
          : {}),
      });
      const accountReservation = await reserveCodexProjectAccount({
        manifest: loaded.manifest,
        launch: continuationLaunch,
        ...continuationReservation,
      });
      const reservedLaunch = accountReservation.launch;
      const startAdmissionWorkspaceMode = reviewedContinuation
        ? ("reviewed_dirty_continuation" as const)
        : terminalRecovery
          ? ("terminal_handoff_dependency_recovery" as const)
          : (continuationDecision?.workspaceMode ??
            (cleanExplicitContinuation
              ? ("clean_explicit_continuation" as const)
              : undefined));
      let result;
      try {
        const broker = deps.codexProjectControlBroker({
          registryRootDir: controller.registryRootDir,
          controller: controller.controller,
          scope: controller.scope,
          startLaunch: reservedLaunch,
          startManifest: loaded.manifest,
          ...(startAdmissionWorkspaceMode
            ? { startAdmissionWorkspaceMode }
            : {}),
          startWorkspaceLease: workspace,
          startSkipDoctor: booleanValue(args.skipDoctor) ?? false,
          ...(reviewedContinuation ? { reviewedContinuation } : {}),
        });
        result = await broker.startWorker({
          jobId: loaded.manifest.jobId,
          registryRoot: controller.registryRootDir,
          workspacePath: loaded.manifest.workspacePath,
          ...(reservedLaunch.tmuxSession
            ? { tmuxSession: reservedLaunch.tmuxSession }
            : {}),
          accounts: [accountReservation.accountId],
          ...(reviewedContinuation || terminalRecovery
            ? { workerRole: ProjectAdmissionWorkerRole.Adoption }
            : {}),
          ...(loaded.manifest.tags ? { tags: loaded.manifest.tags } : {}),
        });
      } catch (error) {
        await releaseCodexProjectAccount({
          manifest: loaded.manifest,
          launch: reservedLaunch,
          reason: "worker_start_failed",
        });
        throw error;
      }
      return {
        ok: true,
        mode: "project_control_start",
        controllerJobId: controller.controller.jobId,
        registryRootDir: controller.registryRootDir,
        auditPath: projectControlAuditPath(controller.controller),
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        tmuxSession: loaded.launch.tmuxSession,
        statusBefore: lockedStatus,
        dependencyPreflight: dependencyPreflight as unknown as JsonObject,
        accountReservation: {
          mode: accountReservation.mode,
          accountId: accountReservation.accountId,
          ...(accountReservation.mode === "exclusive"
            ? {
                fencingToken: accountReservation.fencingToken,
                expiresAt: accountReservation.expiresAt,
              }
            : {}),
        },
        ...(capacitySupervisorReap
          ? {
              capacitySupervisorReap:
                capacitySupervisorReap as unknown as JsonObject,
            }
          : {}),
        result: result as unknown as JsonObject,
      };
    },
  });
}
export async function projectControlCreateWorktreeView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlActionsDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const sourceWorkspacePath = projectControlPathArg(
    args,
    args.sourceWorkspacePath,
    "sourceWorkspacePath",
  );
  const path = projectControlPathArg(args, args.path, "path");
  const baseBranch = stringValue(args.baseBranch);
  if (baseBranch) assertSafeGitRefName(baseBranch, "baseBranch");
  const sourceRef = stringValue(args.sourceRef);
  if (sourceRef) assertSafeGitRefName(sourceRef, "sourceRef");
  const newBranch = stringValue(args.newBranch);
  if (newBranch) assertSafeGitRefName(newBranch, "newBranch");
  const effectiveSourceRef = sourceRef ?? baseBranch;
  const expectedSourceCommit = stringValue(args.expectedSourceCommit);
  if (expectedSourceCommit && !effectiveSourceRef) {
    throw new Error("project_control_pinned_source_ref_required");
  }
  const expectedCurrentCommit = stringValue(args.expectedCurrentCommit);
  if (expectedCurrentCommit) assertSafeGitCommitSha(expectedCurrentCommit);
  const confirmFastForwardExisting =
    booleanValue(args.confirmFastForwardExisting) === true;
  if (confirmFastForwardExisting && !expectedCurrentCommit) {
    throw new Error("project_control_expected_current_commit_required");
  }
  if (expectedCurrentCommit && !expectedSourceCommit) {
    throw new Error("project_control_fast_forward_pinned_source_required");
  }
  if (expectedCurrentCommit && !newBranch) {
    throw new Error("project_control_fast_forward_branch_required");
  }
  const workerRole = projectAdmissionWorkerRoleArg(args.workerRole);
  const realSourceWorkspacePath =
    await projectControlRealPathOutsideWorkspaceScope(
      sourceWorkspacePath,
      controller.scope,
    );
  const realPath = await projectControlRealPathOutsideWorkspaceScope(
    path,
    controller.scope,
  );
  const expectedRealPath = await projectControlRealPathIfExists(path);
  const sourceReference = effectiveSourceRef
    ? resolveProjectSourceReference({
        requestedRef: effectiveSourceRef,
        scope: controller.scope,
        remoteVerificationRequired: expectedSourceCommit !== undefined,
      })
    : undefined;
  const worktreeAccessInput = {
    sourceWorkspacePath,
    ...(realSourceWorkspacePath ? { realSourceWorkspacePath } : {}),
    path,
    ...(realPath ? { realPath } : {}),
    ...(expectedRealPath ? { expectedRealPath } : {}),
    ...(baseBranch ? { baseBranch } : {}),
    ...(sourceReference?.remoteVerified
      ? { sourceRef: sourceReference.worktreeSourceRef }
      : sourceRef
        ? { sourceRef }
        : {}),
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
  if (expectedCurrentCommit && !confirmFastForwardExisting) {
    return {
      ok: false,
      reason: "confirm_fast_forward_existing_required",
      controllerJobId: controller.controller.jobId,
      auditPath: projectControlAuditPath(controller.controller),
      path,
      expectedCurrentCommit,
      expectedSourceCommit,
    };
  }

  const resolverBroker = deps.codexProjectControlBroker({
    registryRootDir: controller.registryRootDir,
    controller: controller.controller,
    scope: controller.scope,
  });
  const resolvedSource =
    await resolverBroker.resolveWorktreeRevision(worktreeAccessInput);
  assertSafeGitCommitSha(resolvedSource.revision);
  const sourceRevision = await resolveProjectSourceRevision({
    resolvedSource,
    remoteTrackingRef: sourceReference?.remoteTrackingRef ?? "HEAD",
    ...(expectedSourceCommit ? { expectedSourceCommit } : {}),
  });
  const createWorktreeInput: CodexGoalProjectCreateWorktreeInput = {
    ...worktreeAccessInput,
    expectedRevision: sourceRevision.revision,
    ...(sourceRevision.pinned ? { sourceRevisionPinned: true } : {}),
    ...(expectedCurrentCommit
      ? {
          fastForwardExisting: {
            expectedCurrentRevision: expectedCurrentCommit,
          },
        }
      : {}),
    expectedSourceRealPath: resolvedSource.sourceRealPath,
  };
  const broker = deps.codexProjectControlBroker({
    registryRootDir: controller.registryRootDir,
    controller: controller.controller,
    scope: controller.scope,
    createWorktreeInput,
  });
  const materialize = async () =>
    await createOrReuseProjectWorktree({
      broker,
      scope: controller.scope,
      createWorktreeInput,
    });
  const worktree = expectedCurrentCommit
    ? await withValidatedProjectWorkspaceLock({
        locks: projectControlWorkspaceLocks(controller.registryRootDir),
        scope: controller.scope,
        requestedWorkspacePath: path,
        owner: `project-worktree-fast-forward:${controller.controller.jobId}`,
        effect: materialize,
      })
    : await materialize();
  const result = worktree.result;
  const dependencyPreflight = await withValidatedProjectWorkspaceLock({
    locks: projectControlWorkspaceLocks(controller.registryRootDir),
    scope: controller.scope,
    requestedWorkspacePath: path,
    owner: `project-worktree-bootstrap:${controller.controller.jobId}`,
    effect: async (workspace) =>
      await runDependencyBootstrap({
        workspacePath: workspace.canonicalWorkspacePath,
        cacheNamespace: controller.scope.projectId,
        mode: projectControlDependencyBootstrapMode(args.dependencyBootstrap),
        confirmInstall: booleanValue(args.confirmDependencyBootstrap) === true,
      }),
  });
  assertProjectControlDependencyBootstrapReady(dependencyPreflight);
  return {
    ok: true,
    mode: "project_control_create_worktree",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    auditPath: projectControlAuditPath(controller.controller),
    dependencyPreflight: dependencyPreflight as unknown as JsonObject,
    result: result as unknown as JsonObject,
  };
}

export async function projectControlIntegrateCommitView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlActionsDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const workspacePath = projectControlPathArg(
    args,
    args.workspacePath,
    "workspacePath",
  );
  const branch = requiredRawString(args.branch, "branch");
  const commitSha = requiredRawString(args.commitSha, "commitSha");
  assertSafeGitRefName(branch, "branch");
  assertSafeGitCommitSha(commitSha);
  const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(
    workspacePath,
    controller.scope,
  );
  const integrateCommitInput: CodexGoalProjectIntegrateCommitInput = {
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
      integrationStrategy: "fast_forward_descendant_or_cherry_pick_commit",
      commandPreview: {
        ancestryCheck: [
          "git",
          "-C",
          workspacePath,
          "merge-base",
          "--is-ancestor",
          "HEAD",
          commitSha,
        ],
        descendant: [
          "git",
          "-C",
          workspacePath,
          "merge",
          "--ff-only",
          commitSha,
        ],
        nonDescendant: [
          "git",
          "-C",
          workspacePath,
          "cherry-pick",
          "--ff",
          commitSha,
        ],
      },
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
    result: result as unknown as JsonObject,
  };
}

export async function projectControlPushBranchView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlActionsDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const workspacePath = projectControlPathArg(
    args,
    args.workspacePath,
    "workspacePath",
  );
  const branch = requiredRawString(args.branch, "branch");
  const remote = stringValue(args.remote) ?? "origin";
  const force = booleanValue(args.force) ?? false;
  const expectedRemoteCommit = stringValue(args.expectedRemoteCommit);
  const expectedLocalCommit = stringValue(args.expectedLocalCommit);
  const confirmExternalRewriteRecovery =
    booleanValue(args.confirmExternalRewriteRecovery) ?? false;
  assertSafeGitRefName(branch, "branch");
  assertSafeGitRemoteName(remote, "remote");
  const recovery = resolveProjectExternalRewriteRecovery({
    force,
    expectedRemoteCommit,
    expectedLocalCommit,
    confirmExternalRewriteRecovery,
  });
  const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(
    workspacePath,
    controller.scope,
  );
  const pushBranchInput: CodexGoalProjectPushBranchInput = {
    workspacePath,
    ...(realWorkspacePath ? { realWorkspacePath } : {}),
    branch,
    remote,
    force,
    ...(expectedRemoteCommit ? { expectedRemoteCommit } : {}),
    ...(expectedLocalCommit ? { expectedLocalCommit } : {}),
    ...(confirmExternalRewriteRecovery
      ? { confirmExternalRewriteRecovery: true }
      : {}),
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
        ...(recovery
          ? [
              `--force-with-lease=refs/heads/${branch}:${recovery.expectedRemoteCommit}`,
            ]
          : force
            ? ["--force-with-lease"]
            : []),
        remote,
        `HEAD:refs/heads/${branch}`,
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
    result: result as unknown as JsonObject,
  };
}

export async function projectControlStopStoredJobView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlActionsDeps,
): Promise<JsonObject> {
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
  const stopCommandPreview = loaded.launch.tmuxSession
    ? buildCodexGoalStopTmuxCommand(loaded.launch.tmuxSession).preview
    : status.progressPid === undefined
      ? "no direct process pid"
      : `kill -TERM ${status.progressPid}`;
  const stopPolicy = decideCodexGoalProjectStop(brief.workerHealth);
  if (!stopPolicy.allowed) {
    return {
      ok: false,
      reason: stopPolicy.reason,
      controllerJobId: controller.controller.jobId,
      jobId: loaded.manifest.jobId,
      ...(loaded.launch.tmuxSession
        ? { tmuxSession: loaded.launch.tmuxSession }
        : {}),
      requiredState: stopPolicy.requiredState,
      stopCommand: stopCommandPreview,
      status,
      brief,
      safeMessage: stopPolicy.safeMessage,
    };
  }
  if (!args.confirmStop) {
    return {
      ok: false,
      reason: "confirm_stop_required",
      controllerJobId: controller.controller.jobId,
      jobId: loaded.manifest.jobId,
      ...(loaded.launch.tmuxSession
        ? { tmuxSession: loaded.launch.tmuxSession }
        : {}),
      stopCommand: stopCommandPreview,
      auditPath: projectControlAuditPath(controller.controller),
      status,
      brief,
    };
  }

  return await withValidatedProjectWorkspaceLock({
    locks: projectControlWorkspaceLocks(controller.registryRootDir),
    scope: controller.scope,
    requestedWorkspacePath: loaded.manifest.workspacePath,
    owner: `project-stop:${controller.controller.jobId}:${loaded.manifest.jobId}`,
    effect: async (workspace) => {
      const lockedLaunch: CodexGoalLaunchInput = {
        ...loaded.launch,
        config: {
          ...loaded.launch.config,
          workspacePath: workspace.canonicalWorkspacePath,
        },
      };
      const broker = deps.codexProjectControlBroker({
        registryRootDir: controller.registryRootDir,
        controller: controller.controller,
        scope: controller.scope,
        stopLaunch: lockedLaunch,
      });
      const realWorkspacePath =
        await projectControlRealPathOutsideWorkspaceScope(
          loaded.launch.config.workspacePath,
          controller.scope,
        );
      const result = await broker.stopWorker({
        jobId: loaded.manifest.jobId,
        registryRoot: controller.registryRootDir,
        workspacePath: loaded.launch.config.workspacePath,
        ...(realWorkspacePath ? { realWorkspacePath } : {}),
        ...(loaded.launch.tmuxSession
          ? { tmuxSession: loaded.launch.tmuxSession }
          : {}),
      });
      await writeCodexGoalStoppedProgress({
        progressPath:
          loaded.launch.config.progressPath ??
          codexGoalProgressPath({
            jobRootDir: loaded.launch.config.jobRootDir,
            taskId: loaded.launch.config.taskId,
          }),
        taskId: loaded.launch.config.taskId,
        status: "stopped",
      });
      const statusAfter = await collectCodexGoalStatus(
        statusInput(lockedLaunch),
      );
      const stopEventPath = await writeCodexGoalStopEvent({
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        jobRootDir: loaded.launch.config.jobRootDir,
        ...(loaded.launch.tmuxSession
          ? { tmuxSession: loaded.launch.tmuxSession }
          : {}),
        stopCommand: String(result.resourceId ?? stopCommandPreview),
        forceStop: Boolean(args.forceStop),
        statusBefore: status,
        statusAfter,
        brief,
      });
      const accountReservationReleased = await releaseCodexProjectAccount({
        manifest: loaded.manifest,
        launch: lockedLaunch,
        reason: "worker_stopped",
      });
      return {
        ok: true,
        mode: "project_control_stop",
        controllerJobId: controller.controller.jobId,
        registryRootDir: controller.registryRootDir,
        auditPath: projectControlAuditPath(controller.controller),
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        ...(loaded.launch.tmuxSession
          ? { tmuxSession: loaded.launch.tmuxSession }
          : {}),
        stopEventPath,
        accountReservationReleased,
        statusBefore: status,
        statusAfter,
        result: result as unknown as JsonObject,
      };
    },
  });
}
