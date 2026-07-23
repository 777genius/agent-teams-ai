import {
  lstat,
  mkdir,
  realpath,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  AccessBoundary,
  NetworkAccessMode,
  type ProjectAccessScope,
  type ProjectControlBroker,
  type ProjectControlOperationResult,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexGoalJobToArgs,
  readCodexGoalJob,
  summarizeCodexGoalJob,
  type CodexGoalJobManifest,
  type CodexGoalJobManifestInput,
} from "./codex-goal-jobs";
import {
  runDependencyBootstrap,
  type DependencyPreflightResult,
} from "./dependency-bootstrap";
import {
  collectCodexGoalStatus,
  resolveCodexGoalWorkerLiveness,
} from "./codex-goal-ops";
import {
  type CodexGoalProjectCreateWorktreeInput,
  type CodexProjectControlBrokerInput,
  projectControlAuditPath,
} from "./codex-goal-mcp-project-broker";
import {
  createOrReuseProjectControlOperation,
  ProjectControlOperationStatus,
  projectControlOperationExecutionMode,
  projectControlOperationView,
  projectControlOperationsRoot,
  readProjectControlOperationById,
  recoverProjectControlOperations,
  startProjectControlOperationRunner,
  updateProjectControlOperation,
  type JsonRecord as ProjectControlOperationJsonRecord,
  type ProjectControlOperationToolName,
} from "./project-control-operation-lifecycle";
import { codexGoalAccountCapacityFacts } from "./codex-goal-mcp-account-capacity-facts";
import {
  projectControlDefaultAccountNames,
  projectControlRefillAccountNames,
  rotateProjectControlAccountNames,
} from "./codex-goal-mcp-project-accounts";
import {
  assertProjectControlCreateManifestPaths,
  assertProjectControlDependencyBootstrapReady,
  projectControlCanonicalWorkspacePath,
  projectControlChildScope,
  projectControlDependencyBootstrapMode,
  projectControlPathArg,
  projectControlRealPathIfExists,
  projectControlRealPathOutsideWorkspaceScope,
  projectControlWorkerRole,
} from "./codex-goal-mcp-project-scope";
import {
  assertSafeGitRefName,
  stagedPatchSha256ForRevision,
} from "./codex-goal-mcp-project-git";
import { publishImmutableTextArtifact } from "./local-immutable-text-artifact";
import {
  resolveProjectSourceReference,
  resolveProjectSourceRevision,
} from "./application/project-control/codex-goal-project-source-revision";
import {
  finalizeProjectMergeBoundSource,
  parseProjectMergeBindingRequest,
} from "./application/project-control/codex-goal-project-merge-binding";
import { assertProjectRefillInputPatchSource } from "./application/project-control/codex-goal-project-input-patch-policy";
import {
  matchesProjectControlPrefix,
  uniqueProjectControlStrings,
} from "./codex-goal-mcp-project-utils";
import {
  assertReadablePrompt,
  createOrReuseProjectJob,
  createOrReuseProjectWorktree,
  readTextFileIfExists,
  rollbackProjectRefillPartial,
} from "./application/project-control/codex-goal-project-refill";
import {
  assertProjectPreStartAdmissionSourceRevision,
  planProjectPreStartAdmission,
  prepareProjectPreStartAdmission,
  removeProjectPreStartAdmissionPaths,
} from "./application/project-control/codex-goal-project-pre-start-admission";
import {
  validateProjectRefillPreStartAdmission,
  validateProjectRefillPreStartAdmissionLocked,
} from "./application/project-control/codex-goal-project-refill-admission";
import { projectControlChildManifestInput } from "./application/project-control/codex-goal-project-child-manifest";
import {
  projectControlWorkspaceLocks,
  withValidatedProjectWorkspaceLock,
} from "./codex-goal-project-workspace-lock";
import {
  booleanValue,
  requiredRawString,
  stringValue,
  tagValues,
} from "./codex-goal-mcp-values";
import type {
  JobCreateMcpArgs,
  ProjectControlMcpArgs,
} from "./codex-goal-mcp-inputs";
import { goalLaunchInput } from "./codex-goal-mcp-launch-input";
import { ensureTerminalCodexGoalHandoffArtifacts } from "./application/ensure-codex-goal-handoff-artifacts";
import {
  readVerifiableProducerHandoff,
  readVerifiedProducerHandoff,
  type VerifiedProducerHandoff,
} from "./application/project-control/codex-goal-project-verifier-handoff";
import { codexGoalStatusInputFromLaunch } from "./application/codex-goal-status-input";
import {
  releaseCodexProjectAccount,
  reserveCodexProjectAccount,
  type CodexProjectAccountReservation,
} from "./application/project-control/codex-goal-project-account-reservation";
import {
  resolveReviewedOutputAggregate,
  reviewedOutputAggregateView,
  type ReviewedOutputAggregate,
} from "./application/project-control/reviewed-output-aggregate-materializer";
import {
  LocalReviewedWorkerOutputStore,
  reviewedWorkerOutputRoot,
} from "./reviewed-worker-output";
import {
  rejectedReviewedOutputRemediationView,
  resolveRejectedReviewedOutputRemediation,
} from "./application/project-control/rejected-reviewed-output-remediation";

type JsonObject = Readonly<Record<string, unknown>>;

type LoadedProjectControlController = {
  readonly registryRootDir: string;
  readonly controller: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
};

export type CodexGoalMcpProjectControlJobsDeps = {
  readonly loadProjectControlController: (
    args: ProjectControlMcpArgs,
  ) => Promise<LoadedProjectControlController>;
  readonly codexProjectControlBroker: (
    input: Omit<CodexProjectControlBrokerInput, "admissionDeps">,
  ) => ProjectControlBroker;
};

export { projectControlCreateCodexGoalJobView } from "./codex-goal-mcp-project-control-create-job";

export async function projectControlRefillWorkerView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlJobsDeps,
  boundedToolName: ProjectControlOperationToolName = "codex_goal_project_refill_worker",
): Promise<JsonObject> {
  const executionMode =
    args.executionMode ??
    (booleanValue(args.startWorker) === false ? "sync" : "bounded");
  if (projectControlOperationExecutionMode(executionMode) === "bounded") {
    return projectControlRefillWorkerBoundedView(args, deps, boundedToolName);
  }
  const controller = await deps.loadProjectControlController(args);
  if (args.projectAccessScope !== undefined) {
    throw new Error("project_control_child_scope_is_controller_owned");
  }
  if (args.allowDangerFullAccess === true) {
    throw new Error("project_control_child_danger_full_access_denied");
  }
  let promptBody = requiredRawString(args.promptBody, "promptBody");
  const sourceWorkspacePath = projectControlPathArg(
    args,
    args.sourceWorkspacePath,
    "sourceWorkspacePath",
  );

  const requested = projectControlChildManifestInput({
    args: args as JobCreateMcpArgs,
    scope: controller.scope,
    registryRootDir: controller.registryRootDir,
  });
  if (
    requested.accessBoundary === AccessBoundary.ProjectScopedControl ||
    requested.accessBoundary === AccessBoundary.DangerFullAccess
  ) {
    throw new Error("project_control_child_boundary_denied");
  }
  const accounts = await projectControlRefillAccountNames({
    ...(requested.authRootDir === undefined
      ? {}
      : { authRootDir: requested.authRootDir }),
    requestedAccounts: requested.accounts,
    allowedAccountIds: controller.scope.allowedAccountIds ?? [],
    rotationKey: requested.jobId,
  });
  if (!accounts.length) {
    throw new Error("project_control_refill_no_ready_account");
  }
  const role = projectControlWorkerRole(args.workerRole);
  const producerJobId = stringValue(args.producerJobId);
  const reviewedOutputId = stringValue(args.reviewedOutputId);
  const reviewedOutputIds = reviewedOutputIdValues(args.reviewedOutputIds);
  assertVerifierInputSource({
    operationToolName: boundedToolName,
    producerJobId,
    reviewedOutputIds,
  });
  const accessBoundary =
    requested.accessBoundary ?? AccessBoundary.IsolatedWorkspaceWrite;
  const baseCreateManifest: CodexGoalJobManifestInput = {
    ...requested,
    accounts,
    tags: uniqueProjectControlStrings([
      ...tagValues(requested.tags),
      "project-control-refill",
      `worker-role-${role}`,
    ]),
    accessBoundary,
    projectAccessScope: projectControlChildScope(
      controller.scope,
      requested.workspacePath,
    ),
    allowDangerFullAccess: false,
    networkAccess: requested.networkAccess ?? NetworkAccessMode.Restricted,
    reasoningEffort: requested.reasoningEffort ?? "high",
    serviceTier: requested.serviceTier ?? "default",
  };
  const mergeBinding = parseProjectMergeBindingRequest({
    value: args.mergeBinding,
    admission: args.preStartAdmission,
    requireCanonicalRemoteHead:
      booleanValue(args.requireCanonicalRemoteHead) === true,
    expectedSourceCommit: args.expectedSourceCommit,
  });

  const sourceRef = stringValue(args.sourceRef);
  if (sourceRef) assertSafeGitRefName(sourceRef, "sourceRef");
  const baseBranch = stringValue(args.baseBranch) ?? sourceRef ?? "origin/main";
  assertSafeGitRefName(baseBranch, "baseBranch");
  const expectedSourceCommit = stringValue(args.expectedSourceCommit);
  const newBranch = stringValue(args.newBranch);
  if (newBranch) assertSafeGitRefName(newBranch, "newBranch");
  const requestedOwnedPaths = projectControlAdmissionOwnedPaths(
    args.preStartAdmission,
  );
  const realSourceWorkspacePath =
    await projectControlRealPathOutsideWorkspaceScope(
      sourceWorkspacePath,
      controller.scope,
    );
  const realPath = await projectControlRealPathOutsideWorkspaceScope(
    baseCreateManifest.workspacePath,
    controller.scope,
  );
  const expectedRealPath = await projectControlRealPathIfExists(
    baseCreateManifest.workspacePath,
  );
  const requestedWorktreeAccessInput = {
    sourceWorkspacePath,
    ...(realSourceWorkspacePath ? { realSourceWorkspacePath } : {}),
    path: baseCreateManifest.workspacePath,
    ...(realPath ? { realPath } : {}),
    ...(expectedRealPath ? { expectedRealPath } : {}),
    baseBranch,
    ...(sourceRef ? { sourceRef } : {}),
    ...(newBranch ? { newBranch } : {}),
    workerRole: role,
    ...(baseCreateManifest.tags ? { tags: baseCreateManifest.tags } : {}),
    ...(requestedOwnedPaths
      ? { ownedPaths: requestedOwnedPaths }
      : {}),
  };

  if (!args.confirmRefill) {
    return {
      ok: false,
      reason: "confirm_refill_required",
      mode: "project_control_refill_worker",
      controllerJobId: controller.controller.jobId,
      targetJobId: baseCreateManifest.jobId,
      auditPath: projectControlAuditPath(controller.controller),
      workerRole: role,
      startWorker: booleanValue(args.startWorker) !== false,
      worktreePreview: requestedWorktreeAccessInput,
      manifestPreview: baseCreateManifest as unknown as JsonObject,
      promptPath: baseCreateManifest.promptPath,
    };
  }

  const resolverBroker = deps.codexProjectControlBroker({
    registryRootDir: controller.registryRootDir,
    controller: controller.controller,
    scope: controller.scope,
  });
  const canonicalSourceWorkspacePath =
    booleanValue(args.requireCanonicalRemoteHead) === true
      ? await projectControlCanonicalWorkspacePath(
          sourceWorkspacePath,
          controller.scope,
        )
      : undefined;
  const sourceReference = resolveProjectSourceReference({
    requestedRef: canonicalSourceWorkspacePath
      ? baseBranch
      : (sourceRef ?? baseBranch),
    scope: controller.scope,
    remoteVerificationRequired:
      canonicalSourceWorkspacePath !== undefined ||
      expectedSourceCommit !== undefined,
  });
  const worktreeAccessInput = sourceReference.remoteVerified
    ? {
        ...requestedWorktreeAccessInput,
        sourceRef: sourceReference.worktreeSourceRef,
      }
    : requestedWorktreeAccessInput;
  const resolvedSource =
    await resolverBroker.resolveWorktreeRevision(worktreeAccessInput);
  const finalizedSource = await finalizeProjectMergeBoundSource({
    binding: mergeBinding,
    jobRootDir: baseCreateManifest.jobRootDir,
    admission: args.preStartAdmission,
    resolvedSource,
    scope: controller.scope,
    targetRemoteTrackingRef: sourceReference.remoteTrackingRef,
    ...(expectedSourceCommit ? { expectedSourceCommit } : {}),
    requireRemoteHead: canonicalSourceWorkspacePath !== undefined,
  });
  const { merge, sourceRevision } = finalizedSource;
  const preStartAdmission = planProjectPreStartAdmission({
    value: finalizedSource.admission,
    confirmed: booleanValue(args.confirmPreStartAdmission) === true,
    scope: controller.scope,
    manifest: baseCreateManifest,
  });
  if (
    boundedToolName === "codex_goal_project_refill_worker" &&
    role !== "adoption"
  ) {
    assertProjectRefillInputPatchSource({
      contract: preStartAdmission?.contract,
      producerJobId,
      reviewedOutputId,
      workerRole: role,
    });
  }
  const createManifest: CodexGoalJobManifestInput = {
    ...baseCreateManifest,
    ...(preStartAdmission
      ? { projectPreStartAdmission: preStartAdmission.descriptor }
      : {}),
  };
  assertProjectControlCreateManifestPaths({
    scope: controller.scope,
    registryRootDir: controller.registryRootDir,
    manifest: createManifest,
  });
  promptBody += finalizedSource.promptSuffix;
  const producerHandoff = producerJobId && !reviewedOutputId
    ? await resolveProducerHandoffForVerifier({
        registryRootDir: controller.registryRootDir,
        producerJobId,
        expectedInputPatchHash: preStartAdmission?.contract.inputPatchHash,
        allowProviderOutputInvalid:
          boundedToolName === "codex_goal_project_prepare_verifier",
      })
    : undefined;
  const reviewedOutputAggregate = reviewedOutputIds
    ? await resolveLocalReviewedOutputAggregate({
        registryRootDir: controller.registryRootDir,
        projectId: controller.scope.projectId,
        reviewedOutputIds,
        expectedBaseCommit: sourceRevision.revision,
      })
    : undefined;
  const rejectedReviewedOutputStore = reviewedOutputId && producerJobId
    ? new LocalReviewedWorkerOutputStore({
        rootDir: reviewedWorkerOutputRoot(controller.registryRootDir),
      })
    : undefined;
  const rejectedReviewedOutput =
    reviewedOutputId && producerJobId && rejectedReviewedOutputStore
    ? await resolveRejectedReviewedOutputRemediation({
        store: rejectedReviewedOutputStore,
        readPatch: async (snapshot) =>
          await rejectedReviewedOutputStore.readPatch(snapshot),
        stagedPatchSha256ForRevision,
      }, {
        projectId: controller.scope.projectId,
        reviewedOutputId,
        expectedWorkerJobId: producerJobId,
        expectedBaseCommit: sourceRevision.revision,
        expectedPatchSha256: preStartAdmission?.contract.inputPatchHash,
        sourceWorkspacePath: resolvedSource.sourceRealPath,
      })
    : undefined;
  assertProjectPreStartAdmissionSourceRevision({
    plan: preStartAdmission,
    sourceRevision: sourceRevision.revision,
  });
  let aggregateArtifactCreatedPaths: readonly string[] = [];
  let aggregateInputPatch:
    | {
        readonly path: string;
        readonly sha256: string;
        readonly stagedSha256: string;
        readonly baseCommit: string;
        readonly changedPaths: readonly string[];
      }
    | undefined;
  if (reviewedOutputAggregate) {
    const artifacts = await materializeReviewedOutputAggregateArtifacts({
      jobRootDir: createManifest.jobRootDir,
      aggregate: reviewedOutputAggregate,
    });
    aggregateArtifactCreatedPaths = artifacts.createdPaths;
    try {
      aggregateInputPatch = {
        path: artifacts.patchPath,
        sha256: reviewedOutputAggregate.patchSha256,
        stagedSha256: await stagedPatchSha256ForRevision({
          workspacePath: resolvedSource.sourceRealPath,
          revision: sourceRevision.revision,
          patchPath: artifacts.patchPath,
        }),
        baseCommit: reviewedOutputAggregate.baseCommit,
        changedPaths: reviewedOutputAggregate.changedFiles,
      };
    } catch (error) {
      await removeReviewedOutputAggregateArtifacts(
        aggregateArtifactCreatedPaths,
      );
      throw error;
    }
  }
  const producerInputPatch =
    aggregateInputPatch ??
    rejectedReviewedOutput?.inputPatch ??
    (producerHandoff
      ? {
          path: producerHandoff.patchPath,
          sha256: producerHandoff.patchSha256,
          stagedSha256: await stagedPatchSha256ForRevision({
            workspacePath: resolvedSource.sourceRealPath,
            revision: sourceRevision.revision,
            patchPath: producerHandoff.patchPath,
          }),
          baseCommit: producerHandoff.baseCommit,
          changedPaths: producerHandoff.changedPaths,
        }
      : undefined);
  const createWorktreeInput: CodexGoalProjectCreateWorktreeInput = {
    jobId: requested.jobId,
    ...worktreeAccessInput,
    expectedRevision: sourceRevision.revision,
    ...(sourceRevision.pinned ? { sourceRevisionPinned: true } : {}),
    expectedSourceRealPath: resolvedSource.sourceRealPath,
    ...(producerInputPatch ? { inputPatch: producerInputPatch } : {}),
  };
  const worktreeBroker = deps.codexProjectControlBroker({
    registryRootDir: controller.registryRootDir,
    controller: controller.controller,
    scope: controller.scope,
    createWorktreeInput,
  });
  let worktreeCreated = false;
  let promptWritten = false;
  let admissionCreatedPaths: readonly string[] = [];
  let worktree: ProjectControlOperationResult;
  let createJob: ProjectControlOperationResult;
  let manifest: CodexGoalJobManifest;
  let expectedCanonicalWorkspacePath: string;
  let prompt: { readonly promptPath: string; readonly bytes: number };
  let dependencyPreflight: DependencyPreflightResult | undefined;
  try {
    const worktreeResult = await createOrReuseProjectWorktree({
      broker: worktreeBroker,
      scope: controller.scope,
      createWorktreeInput,
    });
    worktree = worktreeResult.result;
    worktreeCreated = worktreeResult.created;

    const existingPrompt = await readTextFileIfExists(
      createManifest.promptPath,
    );
    if (existingPrompt !== null && existingPrompt !== promptBody) {
      throw new Error("project_control_existing_prompt_mismatch");
    }
    if (existingPrompt === null) {
      await mkdir(dirname(createManifest.promptPath), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(createManifest.promptPath, promptBody, {
        encoding: "utf8",
        mode: 0o600,
      });
      promptWritten = true;
    }
    prompt = await assertReadablePrompt({
      promptPath: createManifest.promptPath,
      expectedBody: promptBody,
    });

    if (preStartAdmission) {
      let existingManifest: CodexGoalJobManifest | undefined;
      try {
        existingManifest = await readCodexGoalJob({
          registryRootDir: controller.registryRootDir,
          jobId: createManifest.jobId,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const prepared = await prepareProjectPreStartAdmission({
        plan: preStartAdmission,
        manifest: createManifest,
        scope: controller.scope,
        ...(existingManifest ? { existingManifest } : {}),
        ...(producerInputPatch
          ? {
              verifiedInputPatchArtifactSha256: producerInputPatch.sha256,
              verifiedInputPatchStagedSha256: producerInputPatch.stagedSha256,
            }
          : {}),
      });
      admissionCreatedPaths = prepared.createdPaths;
    }

    const createBroker = deps.codexProjectControlBroker({
      registryRootDir: controller.registryRootDir,
      controller: controller.controller,
      scope: controller.scope,
      createManifest,
      createOverwrite: booleanValue(args.overwrite) ?? false,
      ...(producerInputPatch
        ? {
            admittedInputPatchTarget: {
              jobId: createManifest.jobId,
              workspacePath: createManifest.workspacePath,
            },
          }
        : {}),
    });
    const createResult = await createOrReuseProjectJob({
      broker: createBroker,
      registryRootDir: controller.registryRootDir,
      scope: controller.scope,
      manifest: createManifest,
      promptBody,
      workerRole: role,
      ...(requestedOwnedPaths
        ? { ownedPaths: requestedOwnedPaths }
        : {}),
    });
    createJob = createResult.result;
    manifest = createResult.manifest;
    expectedCanonicalWorkspacePath = await projectControlCanonicalWorkspacePath(
      manifest.workspacePath,
      controller.scope,
    );
    await validateProjectRefillPreStartAdmission({
      registryRootDir: controller.registryRootDir,
      controllerJobId: controller.controller.jobId,
      scope: controller.scope,
      manifest,
      expectedCanonicalWorkspacePath,
      admittedInputPatch: Boolean(producerInputPatch),
    });
  } catch (error) {
    await removeProjectPreStartAdmissionPaths(admissionCreatedPaths);
    await removeReviewedOutputAggregateArtifacts(aggregateArtifactCreatedPaths);
    const rolledBack = await rollbackProjectRefillPartial({
      expectedSourceRealPath: createWorktreeInput.expectedSourceRealPath,
      workspacePath: createManifest.workspacePath,
      promptPath: createManifest.promptPath,
      registryRootDir: controller.registryRootDir,
      jobId: createManifest.jobId,
      worktreeCreated,
      promptWritten,
    });
    if (error instanceof Error && rolledBack.length > 0) {
      error.message = `${error.message}; rollback=${rolledBack.join(",")}`;
    }
    throw error;
  }

  const accountCapacityFacts = await codexGoalAccountCapacityFacts({
    manifest,
    loadLaunch: async (jobManifest) =>
      goalLaunchInput(codexGoalJobToArgs(jobManifest)),
  });
  let start: ProjectControlOperationResult | undefined;
  let accountReservation: CodexProjectAccountReservation | undefined;
  if (booleanValue(args.startWorker) !== false) {
    await assertReadablePrompt({ promptPath: manifest.promptPath });
    const launch = await goalLaunchInput(codexGoalJobToArgs(manifest));
    const started = await withValidatedProjectWorkspaceLock({
      locks: projectControlWorkspaceLocks(controller.registryRootDir),
      scope: controller.scope,
      requestedWorkspacePath: manifest.workspacePath,
      expectedCanonicalWorkspacePath,
      owner: `project-refill-start:${controller.controller.jobId}:${manifest.jobId}`,
      effect: async (workspace) => {
        dependencyPreflight = await runDependencyBootstrap({
          workspacePath: workspace.canonicalWorkspacePath,
          jobRootDir: manifest.jobRootDir,
          cacheNamespace: controller.scope.projectId,
          mode: projectControlDependencyBootstrapMode(args.dependencyBootstrap),
          confirmInstall:
            booleanValue(args.confirmDependencyBootstrap) === true,
        });
        assertProjectControlDependencyBootstrapReady(dependencyPreflight);
        const startAdmissionWorkspaceMode =
          await validateProjectRefillPreStartAdmissionLocked({
            manifest,
            scope: controller.scope,
            admittedInputPatch: Boolean(producerInputPatch),
          });
        const canonicalLaunch = {
          ...launch,
          config: {
            ...launch.config,
            workspacePath: workspace.canonicalWorkspacePath,
          },
        };
        const reservedAccount = await reserveCodexProjectAccount({
          manifest,
          launch: canonicalLaunch,
        });
        const reservedLaunch = reservedAccount.launch;
        try {
          const startBroker = deps.codexProjectControlBroker({
            registryRootDir: controller.registryRootDir,
            controller: controller.controller,
            scope: controller.scope,
            startLaunch: reservedLaunch,
            startManifest: manifest,
            ...(startAdmissionWorkspaceMode
              ? { startAdmissionWorkspaceMode }
              : {}),
            startWorkspaceLease: workspace,
            startSkipDoctor: booleanValue(args.skipDoctor) ?? false,
          });
          const startResult = await startBroker.startWorker({
            jobId: manifest.jobId,
            registryRoot: controller.registryRootDir,
            workspacePath: manifest.workspacePath,
            ...(reservedLaunch.tmuxSession
              ? { tmuxSession: reservedLaunch.tmuxSession }
              : {}),
            accounts: [reservedAccount.accountId],
            workerRole: role,
            ...(manifest.tags ? { tags: manifest.tags } : {}),
            ...(requestedOwnedPaths
              ? { ownedPaths: requestedOwnedPaths }
              : {}),
          });
          return {
            start: startResult,
            accountReservation: reservedAccount,
          };
        } catch (error) {
          await releaseCodexProjectAccount({
            manifest,
            launch: reservedLaunch,
            reason: "worker_start_failed",
          });
          throw error;
        }
      },
    });
    start = started.start;
    accountReservation = started.accountReservation;
  } else {
    dependencyPreflight = await withValidatedProjectWorkspaceLock({
      locks: projectControlWorkspaceLocks(controller.registryRootDir),
      scope: controller.scope,
      requestedWorkspacePath: manifest.workspacePath,
      expectedCanonicalWorkspacePath,
      owner: `project-refill-bootstrap:${controller.controller.jobId}:${manifest.jobId}`,
      effect: async (workspace) =>
        await runDependencyBootstrap({
          workspacePath: workspace.canonicalWorkspacePath,
          jobRootDir: manifest.jobRootDir,
          cacheNamespace: controller.scope.projectId,
          mode: projectControlDependencyBootstrapMode(args.dependencyBootstrap),
          confirmInstall:
            booleanValue(args.confirmDependencyBootstrap) === true,
        }),
    });
    assertProjectControlDependencyBootstrapReady(dependencyPreflight);
  }

  return {
    ok: true,
    mode: "project_control_refill_worker",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    auditPath: projectControlAuditPath(controller.controller),
    workerRole: role,
    targetJobId: manifest.jobId,
    baseBranch,
    ...(sourceRevision.remoteHead
      ? { canonicalRemoteHead: sourceRevision.remoteHead }
      : {}),
    ...(producerHandoff ? { producerHandoff } : {}),
    ...(reviewedOutputAggregate
      ? {
          reviewedOutputAggregate: reviewedOutputAggregateView(
            reviewedOutputAggregate,
          ),
        }
      : {}),
    ...(rejectedReviewedOutput
      ? {
          rejectedReviewedOutput: rejectedReviewedOutputRemediationView(
            rejectedReviewedOutput.snapshot,
          ),
        }
      : {}),
    prompt,
    accountCapacityFacts,
    ...(accountReservation
      ? {
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
        }
      : {}),
    dependencyPreflight: dependencyPreflight as unknown as JsonObject,
    jobId: manifest.jobId,
    worktree: worktree as unknown as JsonObject,
    createJob: createJob as unknown as JsonObject,
    ...(start
      ? { start: start as unknown as JsonObject }
      : { startSkipped: true }),
    manifest,
    summary: summarizeCodexGoalJob(manifest, controller.registryRootDir),
  };
}

export async function projectControlPrepareVerifierView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlJobsDeps,
): Promise<JsonObject> {
  const producerJobId = stringValue(args.producerJobId);
  const reviewedOutputIds = reviewedOutputIdValues(args.reviewedOutputIds);
  assertVerifierInputSource({
    operationToolName: "codex_goal_project_prepare_verifier",
    producerJobId,
    reviewedOutputIds,
  });
  if (reviewedOutputIds && booleanValue(args.confirmRefill) !== true) {
    const controller = await deps.loadProjectControlController(args);
    const aggregate = await resolveLocalReviewedOutputAggregate({
      registryRootDir: controller.registryRootDir,
      projectId: controller.scope.projectId,
      reviewedOutputIds,
    });
    return {
      ok: false,
      reason: "confirm_refill_required",
      mode: "project_control_prepare_verifier_preview",
      controllerJobId: controller.controller.jobId,
      targetJobId: stringValue(args.jobId),
      requiredInputPatchHash: aggregate.patchSha256,
      reviewedOutputAggregate: reviewedOutputAggregateView(aggregate),
      requiredConfirmation: "confirmRefill",
    };
  }
  if (args.preStartAdmission === undefined) {
    throw new Error("project_control_verifier_pre_start_admission_required");
  }
  const requestedRole = stringValue(args.workerRole) ?? "reviewer";
  if (requestedRole !== "reviewer" && requestedRole !== "fastgate") {
    throw new Error("project_control_verifier_role_required");
  }
  const result = await projectControlRefillWorkerView(
    {
      ...args,
      workerRole: requestedRole,
      requireCanonicalRemoteHead: true,
    },
    deps,
    "codex_goal_project_prepare_verifier",
  );
  return {
    ...result,
    mode: "project_control_prepare_verifier",
  };
}

function reviewedOutputIdValues(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("reviewed_output_aggregate_ids_invalid");
  }
  return value;
}

function assertVerifierInputSource(input: {
  readonly operationToolName: ProjectControlOperationToolName;
  readonly producerJobId: string | undefined;
  readonly reviewedOutputIds: readonly string[] | undefined;
}): void {
  if (input.operationToolName !== "codex_goal_project_prepare_verifier") {
    if (input.reviewedOutputIds) {
      throw new Error(
        "project_control_reviewed_output_aggregate_verifier_only",
      );
    }
    return;
  }
  if (input.producerJobId && input.reviewedOutputIds) {
    throw new Error("project_control_verifier_input_source_conflict");
  }
  if (!input.producerJobId && !input.reviewedOutputIds) {
    throw new Error("project_control_verifier_input_source_required");
  }
}

async function resolveLocalReviewedOutputAggregate(input: {
  readonly registryRootDir: string;
  readonly projectId: string;
  readonly reviewedOutputIds: readonly string[];
  readonly expectedBaseCommit?: string;
}): Promise<ReviewedOutputAggregate> {
  const store = new LocalReviewedWorkerOutputStore({
    rootDir: reviewedWorkerOutputRoot(input.registryRootDir),
  });
  return await resolveReviewedOutputAggregate(
    {
      store,
      readPatch: async (snapshot) => await store.readPatch(snapshot),
    },
    {
      projectId: input.projectId,
      reviewedOutputIds: input.reviewedOutputIds,
      ...(input.expectedBaseCommit
        ? { expectedBaseCommit: input.expectedBaseCommit }
        : {}),
    },
  );
}

async function materializeReviewedOutputAggregateArtifacts(input: {
  readonly jobRootDir: string;
  readonly aggregate: ReviewedOutputAggregate;
}): Promise<{
  readonly patchPath: string;
  readonly provenancePath: string;
  readonly createdPaths: readonly string[];
}> {
  const requestedJobRootParent = dirname(input.jobRootDir);
  const jobRootParentItem = await lstat(requestedJobRootParent);
  if (jobRootParentItem.isSymbolicLink() || !jobRootParentItem.isDirectory()) {
    throw new Error("reviewed_output_aggregate_artifact_root_unsafe");
  }
  const canonicalJobRootParent = await realpath(requestedJobRootParent);
  const requestedJobRoot = join(
    canonicalJobRootParent,
    basename(input.jobRootDir),
  );
  await mkdir(requestedJobRoot, { recursive: true, mode: 0o700 });
  const jobRootItem = await lstat(requestedJobRoot);
  if (jobRootItem.isSymbolicLink() || !jobRootItem.isDirectory()) {
    throw new Error("reviewed_output_aggregate_artifact_root_unsafe");
  }
  const canonicalJobRoot = await realpath(requestedJobRoot);
  if (dirname(canonicalJobRoot) !== canonicalJobRootParent) {
    throw new Error("reviewed_output_aggregate_artifact_root_unsafe");
  }
  const root = join(canonicalJobRoot, "reviewed-output-aggregate");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootItem = await lstat(root);
  if (rootItem.isSymbolicLink() || !rootItem.isDirectory()) {
    throw new Error("reviewed_output_aggregate_artifact_root_unsafe");
  }
  const canonicalRoot = await realpath(root);
  if (dirname(canonicalRoot) !== canonicalJobRoot) {
    throw new Error("reviewed_output_aggregate_artifact_root_unsafe");
  }
  const patchPath = join(canonicalRoot, "input.patch");
  const provenancePath = join(canonicalRoot, "provenance.json");
  const createdPaths: string[] = [];
  try {
    const patchArtifact = await publishImmutableTextArtifact({
      path: patchPath,
      content: input.aggregate.patch,
      existingPathUnsafeError: "reviewed_output_aggregate_artifact_unsafe",
      contentMismatchError: "reviewed_output_aggregate_immutable_conflict",
    });
    if (patchArtifact.created) {
      createdPaths.push(patchPath);
    }
    const provenance = `${JSON.stringify(
      reviewedOutputAggregateView(input.aggregate),
      null,
      2,
    )}\n`;
    const provenanceArtifact = await publishImmutableTextArtifact({
      path: provenancePath,
      content: provenance,
      existingPathUnsafeError: "reviewed_output_aggregate_artifact_unsafe",
      contentMismatchError: "reviewed_output_aggregate_immutable_conflict",
    });
    if (provenanceArtifact.created) {
      createdPaths.push(provenancePath);
    }
    return { patchPath, provenancePath, createdPaths };
  } catch (error) {
    await removeReviewedOutputAggregateArtifacts(createdPaths);
    throw error;
  }
}

async function removeReviewedOutputAggregateArtifacts(
  paths: readonly string[],
): Promise<void> {
  for (const path of [...paths].reverse()) await rm(path, { force: true });
  const root = paths[0] ? dirname(paths[0]) : undefined;
  if (root) await rmdir(root).catch(() => undefined);
}

async function resolveProducerHandoffForVerifier(input: {
  readonly registryRootDir: string;
  readonly producerJobId: string;
  readonly expectedInputPatchHash: unknown;
  readonly allowProviderOutputInvalid: boolean;
}): Promise<VerifiedProducerHandoff> {
  const producer = await readCodexGoalJob({
    registryRootDir: input.registryRootDir,
    jobId: input.producerJobId,
  });
  const launch = await goalLaunchInput(codexGoalJobToArgs(producer));
  const initialStatus = await collectCodexGoalStatus(
    codexGoalStatusInputFromLaunch(launch),
  );
  const status = await ensureTerminalCodexGoalHandoffArtifacts({
    launch,
    status: initialStatus,
  });
  if (resolveCodexGoalWorkerLiveness({ status }).alive) {
    throw new Error("project_control_verifier_producer_still_running");
  }
  const handoff = input.allowProviderOutputInvalid
    ? await readVerifiableProducerHandoff({ producer })
    : await readVerifiedProducerHandoff({ producer });
  if (
    typeof input.expectedInputPatchHash !== "string" ||
    input.expectedInputPatchHash.toLowerCase() !== handoff.patchSha256
  ) {
    throw new Error("project_control_verifier_admission_patch_hash_mismatch");
  }
  return handoff;
}

async function projectControlRefillWorkerBoundedView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlJobsDeps,
  operationToolName: ProjectControlOperationToolName,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  if (args.projectAccessScope !== undefined) {
    throw new Error("project_control_child_scope_is_controller_owned");
  }
  if (args.allowDangerFullAccess === true) {
    throw new Error("project_control_child_danger_full_access_denied");
  }
  if (!args.confirmRefill) {
    return {
      ok: false,
      reason: "confirm_refill_required",
      mode: "project_control_refill_worker_operation_preview",
      executionMode: "bounded",
      controllerJobId: controller.controller.jobId,
      auditPath: projectControlAuditPath(controller.controller),
      requiredConfirmation: "confirmRefill",
    };
  }
  requiredRawString(args.promptBody, "promptBody");
  const sourceWorkspacePath = projectControlPathArg(
    args,
    args.sourceWorkspacePath,
    "sourceWorkspacePath",
  );
  const requested = projectControlChildManifestInput({
    args: args as JobCreateMcpArgs,
    scope: controller.scope,
    registryRootDir: controller.registryRootDir,
  });
  if (
    requested.accessBoundary === AccessBoundary.ProjectScopedControl ||
    requested.accessBoundary === AccessBoundary.DangerFullAccess
  ) {
    throw new Error("project_control_child_boundary_denied");
  }
  const createManifest: CodexGoalJobManifestInput = {
    ...requested,
    accessBoundary:
      requested.accessBoundary ?? AccessBoundary.IsolatedWorkspaceWrite,
    projectAccessScope: projectControlChildScope(
      controller.scope,
      requested.workspacePath,
    ),
    allowDangerFullAccess: false,
    networkAccess: requested.networkAccess ?? NetworkAccessMode.Restricted,
  };
  const mergeBinding = parseProjectMergeBindingRequest({
    value: args.mergeBinding,
    admission: args.preStartAdmission,
    requireCanonicalRemoteHead:
      booleanValue(args.requireCanonicalRemoteHead) === true,
    expectedSourceCommit: args.expectedSourceCommit,
  });
  // Dynamic merge revisions are resolved by the immutable sync operation. The
  // bounded wrapper cannot materialize that contract before it has pinned both
  // remote heads, so it validates only the request shape here.
  const preStartAdmission = mergeBinding
    ? undefined
    : planProjectPreStartAdmission({
        value: args.preStartAdmission,
        confirmed: booleanValue(args.confirmPreStartAdmission) === true,
        scope: controller.scope,
        manifest: createManifest,
      });
  if (
    operationToolName === "codex_goal_project_refill_worker" &&
    !mergeBinding
  ) {
    assertProjectRefillInputPatchSource({
      contract: preStartAdmission?.contract,
      producerJobId: stringValue(args.producerJobId),
      reviewedOutputId: stringValue(args.reviewedOutputId),
      workerRole: projectControlWorkerRole(args.workerRole),
    });
  }
  assertProjectControlCreateManifestPaths({
    scope: controller.scope,
    registryRootDir: controller.registryRootDir,
    manifest: createManifest,
  });
  if (preStartAdmission) {
    const sourceRef = stringValue(args.sourceRef);
    if (sourceRef) assertSafeGitRefName(sourceRef, "sourceRef");
    const baseBranch = stringValue(args.baseBranch) ?? sourceRef ?? "origin/main";
    assertSafeGitRefName(baseBranch, "baseBranch");
    const expectedSourceCommit = stringValue(args.expectedSourceCommit);
    const newBranch = stringValue(args.newBranch);
    if (newBranch) assertSafeGitRefName(newBranch, "newBranch");
    const realSourceWorkspacePath =
      await projectControlRealPathOutsideWorkspaceScope(
        sourceWorkspacePath,
        controller.scope,
      );
    const realPath = await projectControlRealPathOutsideWorkspaceScope(
      requested.workspacePath,
      controller.scope,
    );
    const resolverBroker = deps.codexProjectControlBroker({
      registryRootDir: controller.registryRootDir,
      controller: controller.controller,
      scope: controller.scope,
    });
    const canonicalSourceWorkspacePath =
      booleanValue(args.requireCanonicalRemoteHead) === true
        ? await projectControlCanonicalWorkspacePath(
            sourceWorkspacePath,
            controller.scope,
          )
        : undefined;
    const requestedWorktreeAccessInput = {
      sourceWorkspacePath,
      ...(realSourceWorkspacePath ? { realSourceWorkspacePath } : {}),
      path: requested.workspacePath,
      ...(realPath ? { realPath } : {}),
      baseBranch,
      ...(sourceRef ? { sourceRef } : {}),
      ...(newBranch ? { newBranch } : {}),
    };
    const sourceReference = resolveProjectSourceReference({
      requestedRef: canonicalSourceWorkspacePath
        ? baseBranch
        : (sourceRef ?? baseBranch),
      scope: controller.scope,
      remoteVerificationRequired:
        canonicalSourceWorkspacePath !== undefined ||
        expectedSourceCommit !== undefined,
    });
    const worktreeAccessInput = sourceReference.remoteVerified
      ? {
          ...requestedWorktreeAccessInput,
          sourceRef: sourceReference.worktreeSourceRef,
        }
      : requestedWorktreeAccessInput;
    const resolvedSource =
      await resolverBroker.resolveWorktreeRevision(worktreeAccessInput);
    const sourceRevision = await resolveProjectSourceRevision({
      resolvedSource,
      remoteTrackingRef: sourceReference.remoteTrackingRef,
      ...(expectedSourceCommit ? { expectedSourceCommit } : {}),
      requireRemoteHead: canonicalSourceWorkspacePath !== undefined,
    });
    assertProjectPreStartAdmissionSourceRevision({
      plan: preStartAdmission,
      sourceRevision: sourceRevision.revision,
    });
  }
  const operationArgs = {
    ...jsonRecordFromProjectControlArgs(args),
    executionMode: "sync",
    confirmRefill: true,
  } satisfies ProjectControlOperationJsonRecord;
  const operationsRootDir = projectControlOperationsRoot(
    controller.controller.jobRootDir,
  );
  const creation = await createOrReuseProjectControlOperation({
    operationsRootDir,
    controllerJobId: controller.controller.jobId,
    toolName: operationToolName,
    args: operationArgs,
    targetJobId: createManifest.jobId,
  });
  if (!creation.created) {
    const existing = creation.operation;
    return {
      ok: true,
      mode: "project_control_refill_worker_operation_started",
      executionMode: "bounded",
      controllerJobId: controller.controller.jobId,
      registryRootDir: controller.registryRootDir,
      auditPath: projectControlAuditPath(controller.controller),
      operationId: existing.operationId,
      operationStatusTool: "codex_goal_project_operation_status",
      operationStatusArgs: {
        registryRootDir: controller.registryRootDir,
        controllerJobId: controller.controller.jobId,
        operationId: existing.operationId,
      },
      targetJobId: createManifest.jobId,
      ...(existing.runner ? { runnerPid: existing.runner.pid } : {}),
      operation: projectControlOperationView({ operation: existing }),
    };
  }
  const operation = creation.operation;
  const runner = await startProjectControlOperationRunner({
    operationFilePath: operation.operationFilePath,
    cwd: controller.controller.workspacePath,
  });
  const updated = await updateProjectControlOperation({
    operationFilePath: operation.operationFilePath,
    update: (current) =>
      current.status === ProjectControlOperationStatus.Queued &&
      current.runner === undefined
        ? {
            runner: {
              hostname: hostname(),
              pid: runner.pid,
              command: runner.command,
              startedAt: new Date().toISOString(),
            },
          }
        : {},
  });
  return {
    ok: true,
    mode: "project_control_refill_worker_operation_started",
    executionMode: "bounded",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    auditPath: projectControlAuditPath(controller.controller),
    operationId: updated.operationId,
    operationStatusTool: "codex_goal_project_operation_status",
    operationStatusArgs: {
      registryRootDir: controller.registryRootDir,
      controllerJobId: controller.controller.jobId,
      operationId: updated.operationId,
    },
    targetJobId: createManifest.jobId,
    runnerPid: runner.pid,
    operation: projectControlOperationView({ operation: updated }),
  };
}

export async function projectControlOperationStatusView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlJobsDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const operationId = requiredRawString(args.operationId, "operationId");
  const operation = await readProjectControlOperationById({
    operationsRootDir: projectControlOperationsRoot(
      controller.controller.jobRootDir,
    ),
    operationId,
  });
  return {
    ok: true,
    mode: "project_control_operation_status",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    operation: projectControlOperationView({
      operation,
      includeResult: booleanValue(args.includeResult) === true,
    }),
  };
}

export async function projectControlRecoverOperationsView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlJobsDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  if (booleanValue(args.confirmRecoverOperations) !== true) {
    return {
      ok: false,
      reason: "confirm_recover_operations_required",
      mode: "project_control_recover_operations",
      controllerJobId: controller.controller.jobId,
      registryRootDir: controller.registryRootDir,
    };
  }
  const summary = await recoverProjectControlOperations({
    operationsRootDir: projectControlOperationsRoot(
      controller.controller.jobRootDir,
    ),
    invokeTool: async (toolName, operationArgs) => {
      if (toolName === "codex_goal_project_prepare_verifier") {
        return projectControlPrepareVerifierView(
          operationArgs as ProjectControlMcpArgs,
          deps,
        );
      }
      if (toolName === "codex_goal_project_refill_worker") {
        return projectControlRefillWorkerView(
          operationArgs as ProjectControlMcpArgs,
          deps,
        );
      }
      throw new Error("project_control_operation_tool_invalid");
    },
  });
  return {
    ok: summary.failed === 0 && summary.invalid === 0,
    mode: "project_control_recover_operations",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    scanned: summary.scanned,
    attempted: summary.attempted,
    recovered: summary.recovered,
    reconciled: summary.reconciled,
    alreadyRunning: summary.alreadyRunning,
    terminal: summary.terminal,
    failed: summary.failed,
    invalid: summary.invalid,
    operations: summary.results.map((result) => ({
      ok: result.ok,
      disposition: result.disposition,
      operation: projectControlOperationView({ operation: result.operation }),
    })),
  };
}

function jsonRecordFromProjectControlArgs(
  args: ProjectControlMcpArgs,
): ProjectControlOperationJsonRecord {
  return JSON.parse(JSON.stringify(args)) as ProjectControlOperationJsonRecord;
}

function projectControlAdmissionOwnedPaths(value: unknown): readonly string[] | undefined {
  if (!value || typeof value !== "object" || !("contract" in value)) return undefined;
  const contract = value.contract;
  if (!contract || typeof contract !== "object" || !("ownedPaths" in contract)) {
    return undefined;
  }
  return Array.isArray(contract.ownedPaths) &&
      contract.ownedPaths.length > 0 &&
      contract.ownedPaths.every((path): path is string => typeof path === "string")
    ? contract.ownedPaths
    : undefined;
}
