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
  startProjectControlOperationRunner,
  type JsonRecord as ProjectControlOperationJsonRecord,
} from "./project-control-operation-lifecycle";
import { codexGoalAccountCapacityFacts } from "./codex-goal-mcp-account-capacity-facts";
import {
  projectControlDefaultAccountNames,
  projectControlRefillAccountNames,
  rotateProjectControlAccountNames,
} from "./codex-goal-mcp-project-accounts";
import {
  projectAdmissionWorkerRoleArg,
} from "./application/project-control/codex-goal-project-admission";
import {
  assertProjectControlCreateManifestPaths,
  assertProjectControlDependencyBootstrapReady,
  projectControlChildScope,
  projectControlDependencyBootstrapMode,
  projectControlPathArg,
  projectControlRealPathOutsideWorkspaceScope,
  projectControlWorkerRole,
} from "./codex-goal-mcp-project-scope";
import {
  assertSafeGitRefName,
} from "./codex-goal-mcp-project-git";
import { execGitStdout } from "./application/project-control/codex-goal-project-git";
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
import {
  projectControlChildManifestInput,
} from "./application/project-control/codex-goal-project-child-manifest";
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
import {
  goalLaunchInput,
} from "./codex-goal-mcp-launch-input";

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
    args.executionMode ?? (booleanValue(args.startWorker) === false ? "sync" : "bounded");
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
  const realSourceWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(
    sourceWorkspacePath,
    controller.scope,
  );
  const sourceRevision = (await execGitStdout([
    "-C",
    sourceWorkspacePath,
    "rev-parse",
    sourceRef ?? baseBranch,
  ])).trim();
  assertProjectPreStartAdmissionSourceRevision({
    plan: preStartAdmission,
    sourceRevision,
  });
  const createWorktreeInput: CodexGoalProjectCreateWorktreeInput = {
    sourceWorkspacePath,
    ...(realSourceWorkspacePath ? { realSourceWorkspacePath } : {}),
    path: createManifest.workspacePath,
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
      worktreePreview: createWorktreeInput,
      manifestPreview: createManifest as unknown as JsonObject,
      promptPath: createManifest.promptPath,
    };
  }

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
  let prompt: { readonly promptPath: string; readonly bytes: number };
  let dependencyPreflight: DependencyPreflightResult | undefined;
  try {
    const worktreeResult = await createOrReuseProjectWorktree({
      broker: worktreeBroker,
      createWorktreeInput,
    });
    worktree = worktreeResult.result;
    worktreeCreated = worktreeResult.created;

    const existingPrompt = await readTextFileIfExists(createManifest.promptPath);
    if (existingPrompt !== null && existingPrompt !== promptBody) {
      throw new Error("project_control_existing_prompt_mismatch");
    }
    if (existingPrompt === null) {
      await mkdir(dirname(createManifest.promptPath), { recursive: true, mode: 0o700 });
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
    dependencyPreflight = await runDependencyBootstrap({
      workspacePath: manifest.workspacePath,
      jobRootDir: manifest.jobRootDir,
      cacheNamespace: controller.scope.projectId,
      mode: projectControlDependencyBootstrapMode(args.dependencyBootstrap),
      confirmInstall: booleanValue(args.confirmDependencyBootstrap) === true,
    });
    assertProjectControlDependencyBootstrapReady(dependencyPreflight);
  } catch (error) {
    await removeProjectPreStartAdmissionPaths(admissionCreatedPaths);
    const rolledBack = await rollbackProjectRefillPartial({
      sourceWorkspacePath,
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
  if (booleanValue(args.startWorker) !== false) {
    await assertReadablePrompt({ promptPath: manifest.promptPath });
    await validateStoredProjectPreStartAdmission({
      manifest,
      scope: controller.scope,
    });
    const launch = await goalLaunchInput(codexGoalJobToArgs(manifest));
    const startBroker = deps.codexProjectControlBroker({
      registryRootDir: controller.registryRootDir,
      controller: controller.controller,
      scope: controller.scope,
      startLaunch: launch,
      startSkipDoctor: booleanValue(args.skipDoctor) ?? false,
    });
    const realLaunchWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(
      launch.config.workspacePath,
      controller.scope,
    );
    await validateStoredProjectPreStartAdmission({
      manifest,
      scope: controller.scope,
    });
    start = await startBroker.startWorker({
      jobId: manifest.jobId,
      registryRoot: controller.registryRootDir,
      workspacePath: launch.config.workspacePath,
      ...(realLaunchWorkspacePath ? { realWorkspacePath: realLaunchWorkspacePath } : {}),
      ...(launch.tmuxSession ? { tmuxSession: launch.tmuxSession } : {}),
      accounts: manifest.accounts,
      workerRole: role,
      ...(manifest.tags ? { tags: manifest.tags } : {}),
    });
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
    prompt,
    accountCapacityFacts,
    dependencyPreflight: dependencyPreflight as unknown as JsonObject,
    jobId: manifest.jobId,
    worktree: worktree as unknown as JsonObject,
    createJob: createJob as unknown as JsonObject,
    ...(start ? { start: start as unknown as JsonObject } : { startSkipped: true }),
    manifest,
    summary: summarizeCodexGoalJob(manifest, controller.registryRootDir),
  };
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
    accessBoundary: requested.accessBoundary ?? AccessBoundary.IsolatedWorkspaceWrite,
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
    await projectControlRealPathOutsideWorkspaceScope(
      sourceWorkspacePath,
      controller.scope,
    );
    const sourceRevision = (await execGitStdout([
      "-C",
      sourceWorkspacePath,
      "rev-parse",
      sourceRef ?? baseBranch,
    ])).trim();
    assertProjectPreStartAdmissionSourceRevision({
      plan: preStartAdmission,
      sourceRevision,
    });
  }
  const operationArgs = {
    ...jsonRecordFromProjectControlArgs(args),
    executionMode: "sync",
    confirmRefill: true,
  } satisfies ProjectControlOperationJsonRecord;
  const operationsRootDir = projectControlOperationsRoot(controller.controller.jobRootDir);
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
    operationsRootDir: projectControlOperationsRoot(controller.controller.jobRootDir),
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

function jsonRecordFromProjectControlArgs(
  args: ProjectControlMcpArgs,
): ProjectControlOperationJsonRecord {
  return JSON.parse(JSON.stringify(args)) as ProjectControlOperationJsonRecord;
}
