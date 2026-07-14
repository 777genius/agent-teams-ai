import {
  ProjectAdmissionWorkerRole,
  ReviewDecisionStatus,
  type ProjectAccessScope,
  type ProjectControlBroker,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexGoalJobToArgs,
  readCodexGoalJob,
  type CodexGoalJobManifest,
} from "./codex-goal-jobs";
import {
  buildCodexGoalNoTmuxCommand,
  buildCodexGoalStopTmuxCommand,
  buildCodexGoalTmuxCommand,
  collectCodexGoalStatus,
  listCodexGoalAccountStatuses,
  resolveCodexGoalWorkerLiveness,
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
import {
  assertReadablePrompt,
  createOrReuseProjectWorktree,
} from "./application/project-control/codex-goal-project-refill";
import {
  assertProjectPreStartAdmissionLaunchBinding,
  validateStoredProjectPreStartAdmission,
} from "./application/project-control/codex-goal-project-pre-start-admission";
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
import { resolveProjectSourceRevision } from "./application/project-control/codex-goal-project-source-revision";
import {
  writeCodexGoalStopEvent,
  writeCodexGoalStoppedProgress,
} from "./codex-goal-mcp-lifecycle-markers";
import { buildCodexGoalBrief } from "./codex-goal-mcp-brief";
import { codexGoalStateRootDir } from "./application/codex-goal-worker-control";
import { codexGoalStatusInputFromLaunch as statusInput } from "./codex-goal-mcp-status-input";
import { isSafeStartAction } from "./codex-goal-mcp-decision";
import { ensureTerminalCodexGoalHandoffArtifacts } from "./application/ensure-codex-goal-handoff-artifacts";
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
import { goalLaunchInput } from "./codex-goal-mcp-launch-input";
import {
  releaseCodexProjectAccount,
  reserveCodexProjectAccount,
} from "./application/project-control/codex-goal-project-account-reservation";
import { decideCodexGoalProjectStop } from "./application/project-control/codex-goal-project-stop-policy";
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
  try {
    await assertReadablePrompt({ promptPath: manifest.promptPath });
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error
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
  const progressStale =
    status.progressHeartbeatAgeMs !== undefined &&
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
  const reviewedOutputId = stringValue(args.reviewedOutputId);
  const dirtyContinuation = status.workspaceDirty === true;
  if (dirtyContinuation) {
    if (!args.forceStart) {
      throw new Error(
        "project_control_reviewed_dirty_continuation_force_required",
      );
    }
    if (!reviewedOutputId) {
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
      const lockedStatus = await collectCodexGoalStatus(
        statusInput(loaded.launch),
      );
      const lockedProgressStale =
        lockedStatus.progressHeartbeatAgeMs !== undefined &&
        lockedStatus.progressHeartbeatAgeMs > 10 * 60_000;
      if (
        resolveCodexGoalWorkerLiveness({
          status: lockedStatus,
          progressStale: lockedProgressStale,
        }).alive
      ) {
        return {
          ok: false,
          reason: "worker_already_running",
          controllerJobId: controller.controller.jobId,
          jobId: loaded.manifest.jobId,
          status: lockedStatus,
        };
      }
      if (lockedStatus.workspaceDirty === true !== dirtyContinuation) {
        throw new Error("project_control_workspace_state_changed_before_start");
      }
      if (
        !isSafeStartAction(lockedStatus.recommendedAction) &&
        !args.forceStart
      ) {
        return {
          ok: false,
          reason: "status_requires_review",
          controllerJobId: controller.controller.jobId,
          jobId: loaded.manifest.jobId,
          status: lockedStatus,
          requiredOverride: "forceStart",
        };
      }
      const reviewedOutputDeps = localReviewedWorkerOutputDeps({
        rootDir: reviewedWorkerOutputRoot(controller.registryRootDir),
        locks,
      });
      const reviewedContinuation = dirtyContinuation
        ? await resolveReviewedWorkerContinuation({
            store: reviewedOutputDeps.store,
            projectId: controller.scope.projectId,
            controllerJobId: controller.controller.jobId,
            workerJobId: loaded.manifest.jobId,
            taskId: loaded.launch.config.taskId,
            workspacePath: loaded.launch.config.workspacePath,
            reviewedOutputId: reviewedOutputId!,
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
      const dependencyPreflight = await runDependencyBootstrap({
        workspacePath: workspace.canonicalWorkspacePath,
        jobRootDir: loaded.manifest.jobRootDir,
        cacheNamespace: controller.scope.projectId,
        mode: projectControlDependencyBootstrapMode(args.dependencyBootstrap),
        confirmInstall:
          booleanValue(args.confirmDependencyBootstrap) === true,
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
      } else {
        await validateStoredProjectPreStartAdmission({
          manifest: loaded.manifest,
          scope: controller.scope,
        });
      }
      const canonicalLaunch: CodexGoalLaunchInput = {
        ...loaded.launch,
        config: {
          ...loaded.launch.config,
          workspacePath: workspace.canonicalWorkspacePath,
        },
      };
      const accountReservation = await reserveCodexProjectAccount({
        manifest: loaded.manifest,
        launch: canonicalLaunch,
      });
      const reservedLaunch = accountReservation.launch;
      let result;
      try {
        const broker = deps.codexProjectControlBroker({
          registryRootDir: controller.registryRootDir,
          controller: controller.controller,
          scope: controller.scope,
          startLaunch: reservedLaunch,
          startManifest: loaded.manifest,
          ...(reviewedContinuation
            ? {
                startAdmissionWorkspaceMode:
                  "reviewed_dirty_continuation" as const,
              }
            : {}),
          startWorkspaceLease: workspace,
          startSkipDoctor: booleanValue(args.skipDoctor) ?? false,
        });
        result = await broker.startWorker({
          jobId: loaded.manifest.jobId,
          registryRoot: controller.registryRootDir,
          workspacePath: loaded.manifest.workspacePath,
          ...(reservedLaunch.tmuxSession
            ? { tmuxSession: reservedLaunch.tmuxSession }
            : {}),
          accounts: [accountReservation.accountId],
          ...(dirtyContinuation
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
          accountId: accountReservation.accountId,
          fencingToken: accountReservation.fencingToken,
          expiresAt: accountReservation.expiresAt,
        },
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
  const worktreeAccessInput = {
    sourceWorkspacePath,
    ...(realSourceWorkspacePath ? { realSourceWorkspacePath } : {}),
    path,
    ...(realPath ? { realPath } : {}),
    ...(expectedRealPath ? { expectedRealPath } : {}),
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
    remoteTrackingRef: effectiveSourceRef ?? "HEAD",
    ...(expectedSourceCommit ? { expectedSourceCommit } : {}),
  });
  const createWorktreeInput: CodexGoalProjectCreateWorktreeInput = {
    ...worktreeAccessInput,
    expectedRevision: sourceRevision.revision,
    ...(sourceRevision.pinned ? { sourceRevisionPinned: true } : {}),
    expectedSourceRealPath: resolvedSource.sourceRealPath,
  };
  const broker = deps.codexProjectControlBroker({
    registryRootDir: controller.registryRootDir,
    controller: controller.controller,
    scope: controller.scope,
    createWorktreeInput,
  });
  const worktree = await createOrReuseProjectWorktree({
    broker,
    scope: controller.scope,
    createWorktreeInput,
  });
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
        confirmInstall:
          booleanValue(args.confirmDependencyBootstrap) === true,
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
      commandPreview: [
        "git",
        "-C",
        workspacePath,
        "cherry-pick",
        "--ff",
        commitSha,
      ],
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
  assertSafeGitRefName(branch, "branch");
  assertSafeGitRemoteName(remote, "remote");
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
  const progressStale =
    status.progressHeartbeatAgeMs !== undefined &&
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
  const stopPolicy = decideCodexGoalProjectStop({
    workerAlive: workerLiveness.alive,
    silentStale: brief.silentStale,
    heartbeatOnlyNoOutput: brief.heartbeatOnlyNoOutput,
    freshProgressAlive: workerLiveness.freshProgressAlive,
    progressCpuActive: status.progressCpuActive,
    appServerProcessAlive: status.appServerProcessAlive,
    recommendedAction: status.recommendedAction,
  });
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
  const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(
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
  const statusAfter = await collectCodexGoalStatus(statusInput(lockedLaunch));
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

export async function projectControlMarkReviewedView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlActionsDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const loaded = await deps.loadJobLaunch({
    registryRootDir: controller.registryRootDir,
    jobId: requiredRawString(args.jobId, "jobId"),
  });
  const captureReviewedOutput =
    booleanValue(args.captureReviewedOutput) === true;
  if (!captureReviewedOutput) {
    await ensureTerminalCodexGoalHandoffArtifacts({ launch: loaded.launch });
  }
  const reviewNote = stringValue(args.note) ?? "project_control_reviewed";
  return await withValidatedProjectWorkspaceLock({
    locks: projectControlWorkspaceLocks(controller.registryRootDir),
    scope: controller.scope,
    requestedWorkspacePath: loaded.manifest.workspacePath,
    owner:
      `project-review:${controller.controller.jobId}:${loaded.manifest.jobId}`,
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
    reviewLaunch: lockedLaunch,
    reviewWorkspaceLease: workspace,
    reviewNote,
    ...(captureReviewedOutput
      ? {
          reviewedOutputCapture: {
            projectId: controller.scope.projectId,
            controllerJobId: controller.controller.jobId,
            expectedPatchSha256: requiredRawString(
              args.expectedPatchSha256,
              "expectedPatchSha256",
            ),
            decision: requiredReviewDecision(args.reviewDecision),
            reviewedBy:
              stringValue(args.reviewedBy) ?? controller.controller.jobId,
            reason: stringValue(args.reviewReason) ?? reviewNote,
            approvedFiles: requiredStringArrayArg(
              args.approvedFiles,
              "approvedFiles",
            ),
            requiredChecks: parseProjectIntegrationChecks(args.requiredChecks),
            ...(args.merge
              ? { merge: parseReviewedOutputMerge(controller.scope, args.merge) }
              : {}),
          },
        }
      : {}),
  });
  const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(
    loaded.launch.config.workspacePath,
    controller.scope,
  );
  const result = await broker.writeReviewMarker({
    jobId: loaded.manifest.jobId,
    registryRoot: controller.registryRootDir,
    workspacePath: loaded.launch.config.workspacePath,
    ...(realWorkspacePath ? { realWorkspacePath } : {}),
    ...(loaded.launch.tmuxSession
      ? { tmuxSession: loaded.launch.tmuxSession }
      : {}),
    markerType: "review",
    note: reviewNote,
  });
  const accountReservationReleased = await releaseCodexProjectAccount({
    manifest: loaded.manifest,
    launch: lockedLaunch,
    reason: "worker_reviewed",
  });
  return {
    ok: true,
    mode: "project_control_mark_reviewed",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    auditPath: projectControlAuditPath(controller.controller),
    jobId: loaded.manifest.jobId,
    accountReservationReleased,
    ...(captureReviewedOutput && result.resourceId
      ? { reviewedOutputId: result.resourceId }
      : {}),
    result: result as unknown as JsonObject,
  };
    },
  });
}

function parseReviewedOutputMerge(
  scope: ProjectAccessScope,
  value: NonNullable<ProjectControlMcpArgs["merge"]>,
) {
  const sourceRemote = requiredRawString(value.sourceRemote, "merge.sourceRemote");
  const sourceBranch = requiredRawString(value.sourceBranch, "merge.sourceBranch");
  const sourceCommit = requiredRawString(value.sourceCommit, "merge.sourceCommit")
    .toLowerCase();
  const expectedTargetCommit = requiredRawString(
    value.expectedTargetCommit,
    "merge.expectedTargetCommit",
  ).toLowerCase();
  assertSafeGitRemoteName(sourceRemote, "merge.sourceRemote");
  assertSafeGitRefName(sourceBranch, "merge.sourceBranch");
  assertSafeGitCommitSha(sourceCommit);
  assertSafeGitCommitSha(expectedTargetCommit);
  if (!scope.allowedGitRemotes?.includes(sourceRemote)) {
    throw new Error("reviewed_worker_output_merge_source_remote_denied");
  }
  if (!scope.allowedBranches?.includes(sourceBranch)) {
    throw new Error("reviewed_worker_output_merge_source_branch_denied");
  }
  return { sourceRemote, sourceBranch, sourceCommit, expectedTargetCommit };
}

function requiredReviewDecision(value: unknown): ReviewDecisionStatus {
  if (value === "approved") return ReviewDecisionStatus.Approved;
  if (value === "rejected") return ReviewDecisionStatus.Rejected;
  if (value === "needs_human") return ReviewDecisionStatus.NeedsHuman;
  throw new Error("reviewed_worker_output_review_decision_required");
}
