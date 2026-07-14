import { mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
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
  createProjectControlOperation,
  patchProjectControlOperation,
  projectControlOperationExecutionMode,
  projectControlOperationView,
  projectControlOperationsRoot,
  readProjectControlOperationById,
  recoverProjectControlOperations,
  startProjectControlOperationRunner,
  type JsonRecord as ProjectControlOperationJsonRecord,
} from "./project-control-operation-lifecycle";
import { codexGoalAccountCapacityFacts } from "./codex-goal-mcp-account-capacity-facts";
import {
  projectControlDefaultAccountNames,
  projectControlRefillAccountNames,
  rotateProjectControlAccountNames,
} from "./codex-goal-mcp-project-accounts";
import { projectAdmissionWorkerRoleArg } from "./application/project-control/codex-goal-project-admission";
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
  assertCanonicalRemoteRevision,
  assertSafeGitRefName,
  resolveCanonicalRemoteHead,
} from "./codex-goal-mcp-project-git";
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
  assertProjectPreStartAdmissionLaunchBinding,
  assertProjectPreStartAdmissionSourceRevision,
  planProjectPreStartAdmission,
  prepareProjectPreStartAdmission,
  removeProjectPreStartAdmissionPaths,
  validateStoredProjectPreStartAdmission,
} from "./application/project-control/codex-goal-project-pre-start-admission";
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
  readVerifiedProducerHandoff,
  type VerifiedProducerHandoff,
} from "./application/project-control/codex-goal-project-verifier-handoff";
import { codexGoalStatusInputFromLaunch } from "./application/codex-goal-status-input";
import {
  releaseCodexProjectAccount,
  reserveCodexProjectAccount,
  type CodexProjectAccountReservation,
} from "./application/project-control/codex-goal-project-account-reservation";

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

export async function projectControlCreateCodexGoalJobView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlJobsDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  if (args.projectAccessScope !== undefined) {
    throw new Error("project_control_child_scope_is_controller_owned");
  }
  if (args.allowDangerFullAccess === true) {
    throw new Error("project_control_child_danger_full_access_denied");
  }
  if (controller.scope.preStartAdmission?.required) {
    throw new Error("project_control_pre_start_admission_refill_required");
  }

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
  const accessBoundary =
    requested.accessBoundary ?? AccessBoundary.IsolatedWorkspaceWrite;
  const workerRole = projectAdmissionWorkerRoleArg(args.workerRole);
  const accounts = rotateProjectControlAccountNames(
    await projectControlDefaultAccountNames({
      ...(requested.authRootDir ? { authRootDir: requested.authRootDir } : {}),
      requestedAccounts: requested.accounts,
      allowedAccountIds: controller.scope.allowedAccountIds ?? [],
    }),
    requested.jobId,
  );
  const createManifest: CodexGoalJobManifestInput = {
    ...requested,
    accounts,
    accessBoundary,
    projectAccessScope: projectControlChildScope(
      controller.scope,
      requested.workspacePath,
    ),
    allowDangerFullAccess: false,
    networkAccess: requested.networkAccess ?? NetworkAccessMode.Restricted,
    ...(workerRole
      ? {
          tags: uniqueProjectControlStrings([
            ...tagValues(requested.tags),
            `worker-role-${workerRole}`,
          ]),
        }
      : {}),
  };
  assertProjectControlCreateManifestPaths({
    scope: controller.scope,
    registryRootDir: controller.registryRootDir,
    manifest: createManifest,
  });

  if (!args.confirmCreate) {
    return {
      ok: false,
      reason: "confirm_create_required",
      controllerJobId: controller.controller.jobId,
      targetJobId: createManifest.jobId,
      auditPath: projectControlAuditPath(controller.controller),
      manifestPreview: createManifest as unknown as JsonObject,
    };
  }

  const broker = deps.codexProjectControlBroker({
    registryRootDir: controller.registryRootDir,
    controller: controller.controller,
    scope: controller.scope,
    createManifest,
    createOverwrite: booleanValue(args.overwrite) ?? false,
  });
  const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(
    createManifest.workspacePath,
    controller.scope,
  );
  const result = await broker.createJob({
    jobId: createManifest.jobId,
    registryRoot: controller.registryRootDir,
    workspacePath: createManifest.workspacePath,
    ...(realWorkspacePath ? { realWorkspacePath } : {}),
    ...(createManifest.tmuxSession
      ? { tmuxSession: createManifest.tmuxSession }
      : {}),
    accounts: createManifest.accounts,
    ...(workerRole ? { workerRole } : {}),
    ...(createManifest.tags ? { tags: createManifest.tags } : {}),
  });
  const manifest = await readCodexGoalJob({
    registryRootDir: controller.registryRootDir,
    jobId: createManifest.jobId,
  });
  return {
    ok: true,
    mode: "project_control_create_job",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    auditPath: projectControlAuditPath(controller.controller),
    result: result as unknown as JsonObject,
    manifest,
    summary: summarizeCodexGoalJob(manifest, controller.registryRootDir),
  };
}

export async function projectControlRefillWorkerView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlJobsDeps,
): Promise<JsonObject> {
  const executionMode =
    args.executionMode ??
    (booleanValue(args.startWorker) === false ? "sync" : "bounded");
  if (projectControlOperationExecutionMode(executionMode) === "bounded") {
    return projectControlRefillWorkerBoundedView(args, deps);
  }
  const controller = await deps.loadProjectControlController(args);
  if (args.projectAccessScope !== undefined) {
    throw new Error("project_control_child_scope_is_controller_owned");
  }
  if (args.allowDangerFullAccess === true) {
    throw new Error("project_control_child_danger_full_access_denied");
  }
  const promptBody = requiredRawString(args.promptBody, "promptBody");
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
  if (producerJobId && role === "producer") {
    throw new Error("project_control_verifier_role_required");
  }
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
  const preStartAdmission = planProjectPreStartAdmission({
    value: args.preStartAdmission,
    confirmed: booleanValue(args.confirmPreStartAdmission) === true,
    scope: controller.scope,
    manifest: baseCreateManifest,
  });
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

  const baseBranch = stringValue(args.baseBranch) ?? "origin/main";
  assertSafeGitRefName(baseBranch, "baseBranch");
  const sourceRef = stringValue(args.sourceRef);
  if (sourceRef) assertSafeGitRefName(sourceRef, "sourceRef");
  const newBranch = stringValue(args.newBranch);
  if (newBranch) assertSafeGitRefName(newBranch, "newBranch");
  const realSourceWorkspacePath =
    await projectControlRealPathOutsideWorkspaceScope(
      sourceWorkspacePath,
      controller.scope,
    );
  const realPath = await projectControlRealPathOutsideWorkspaceScope(
    createManifest.workspacePath,
    controller.scope,
  );
  const expectedRealPath = await projectControlRealPathIfExists(
    createManifest.workspacePath,
  );
  const worktreeAccessInput = {
    sourceWorkspacePath,
    ...(realSourceWorkspacePath ? { realSourceWorkspacePath } : {}),
    path: createManifest.workspacePath,
    ...(realPath ? { realPath } : {}),
    ...(expectedRealPath ? { expectedRealPath } : {}),
    baseBranch,
    ...(sourceRef ? { sourceRef } : {}),
    ...(newBranch ? { newBranch } : {}),
    workerRole: role,
    ...(createManifest.tags ? { tags: createManifest.tags } : {}),
  };

  if (!args.confirmRefill) {
    return {
      ok: false,
      reason: "confirm_refill_required",
      mode: "project_control_refill_worker",
      controllerJobId: controller.controller.jobId,
      targetJobId: createManifest.jobId,
      auditPath: projectControlAuditPath(controller.controller),
      workerRole: role,
      startWorker: booleanValue(args.startWorker) !== false,
      worktreePreview: worktreeAccessInput,
      manifestPreview: createManifest as unknown as JsonObject,
      promptPath: createManifest.promptPath,
    };
  }

  const resolverBroker = deps.codexProjectControlBroker({
    registryRootDir: controller.registryRootDir,
    controller: controller.controller,
    scope: controller.scope,
  });
  const resolvedSource =
    await resolverBroker.resolveWorktreeRevision(worktreeAccessInput);
  let canonicalRemoteHead;
  if (booleanValue(args.requireCanonicalRemoteHead) === true) {
    canonicalRemoteHead = await resolveCanonicalRemoteHead({
      workspacePath: resolvedSource.sourceRealPath,
      remoteTrackingRef: baseBranch,
    });
    assertCanonicalRemoteRevision({
      canonical: canonicalRemoteHead,
      resolvedRevision: resolvedSource.revision,
    });
  }
  const producerHandoff = producerJobId
    ? await resolveProducerHandoffForVerifier({
        registryRootDir: controller.registryRootDir,
        producerJobId,
        expectedInputPatchHash: preStartAdmission?.contract.inputPatchHash,
      })
    : undefined;
  assertProjectPreStartAdmissionSourceRevision({
    plan: preStartAdmission,
    sourceRevision: resolvedSource.revision,
  });
  const createWorktreeInput: CodexGoalProjectCreateWorktreeInput = {
    ...worktreeAccessInput,
    expectedRevision: resolvedSource.revision,
    expectedSourceRealPath: resolvedSource.sourceRealPath,
    ...(producerHandoff
      ? {
          inputPatch: {
            path: producerHandoff.patchPath,
            sha256: producerHandoff.patchSha256,
            baseCommit: producerHandoff.baseCommit,
            changedPaths: producerHandoff.changedPaths,
          },
        }
      : {}),
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
      const prepared = await prepareProjectPreStartAdmission({
        plan: preStartAdmission,
        manifest: createManifest,
        scope: controller.scope,
        ...(producerHandoff
          ? {
              verifiedInputPatchArtifactSha256: producerHandoff.patchSha256,
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
    });
    const createResult = await createOrReuseProjectJob({
      broker: createBroker,
      registryRootDir: controller.registryRootDir,
      scope: controller.scope,
      manifest: createManifest,
      promptBody,
      workerRole: role,
    });
    createJob = createResult.result;
    manifest = createResult.manifest;
    await validateStoredProjectPreStartAdmission({
      manifest,
      scope: controller.scope,
    });
    await assertProjectPreStartAdmissionLaunchBinding({
      manifest,
      scope: controller.scope,
    });
    expectedCanonicalWorkspacePath = await projectControlCanonicalWorkspacePath(
      manifest.workspacePath,
      controller.scope,
    );
  } catch (error) {
    await removeProjectPreStartAdmissionPaths(admissionCreatedPaths);
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
        await validateStoredProjectPreStartAdmission({
          manifest,
          scope: controller.scope,
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
    ...(canonicalRemoteHead ? { canonicalRemoteHead } : {}),
    ...(producerHandoff ? { producerHandoff } : {}),
    prompt,
    accountCapacityFacts,
    ...(accountReservation
      ? {
          accountReservation: {
            accountId: accountReservation.accountId,
            fencingToken: accountReservation.fencingToken,
            expiresAt: accountReservation.expiresAt,
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
  requiredRawString(args.producerJobId, "producerJobId");
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
  );
  return {
    ...result,
    mode: "project_control_prepare_verifier",
  };
}

async function resolveProducerHandoffForVerifier(input: {
  readonly registryRootDir: string;
  readonly producerJobId: string;
  readonly expectedInputPatchHash: unknown;
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
  const handoff = await readVerifiedProducerHandoff({ producer });
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
  const preStartAdmission = planProjectPreStartAdmission({
    value: args.preStartAdmission,
    confirmed: booleanValue(args.confirmPreStartAdmission) === true,
    scope: controller.scope,
    manifest: createManifest,
  });
  assertProjectControlCreateManifestPaths({
    scope: controller.scope,
    registryRootDir: controller.registryRootDir,
    manifest: createManifest,
  });
  if (preStartAdmission) {
    const baseBranch = stringValue(args.baseBranch) ?? "origin/main";
    assertSafeGitRefName(baseBranch, "baseBranch");
    const sourceRef = stringValue(args.sourceRef);
    if (sourceRef) assertSafeGitRefName(sourceRef, "sourceRef");
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
    const resolvedSource = await resolverBroker.resolveWorktreeRevision({
      sourceWorkspacePath,
      ...(realSourceWorkspacePath ? { realSourceWorkspacePath } : {}),
      path: requested.workspacePath,
      ...(realPath ? { realPath } : {}),
      baseBranch,
      ...(sourceRef ? { sourceRef } : {}),
      ...(newBranch ? { newBranch } : {}),
    });
    assertProjectPreStartAdmissionSourceRevision({
      plan: preStartAdmission,
      sourceRevision: resolvedSource.revision,
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
  const operation = await createProjectControlOperation({
    operationsRootDir,
    controllerJobId: controller.controller.jobId,
    toolName: "codex_goal_project_refill_worker",
    args: operationArgs,
    targetJobId: createManifest.jobId,
  });
  const runner = await startProjectControlOperationRunner({
    operationFilePath: operation.operationFilePath,
    cwd: controller.controller.workspacePath,
  });
  const updated = await patchProjectControlOperation({
    operationFilePath: operation.operationFilePath,
    patch: {
      runner: {
        hostname: hostname(),
        pid: runner.pid,
        command: runner.command,
        startedAt: new Date().toISOString(),
      },
    },
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
      if (toolName !== "codex_goal_project_refill_worker") {
        throw new Error("project_control_operation_tool_invalid");
      }
      return projectControlRefillWorkerView(
        operationArgs as ProjectControlMcpArgs,
        deps,
      );
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
