import {
  AccessBoundary,
  ReviewDecisionStatus,
  applyWorkerOutput,
  commitApprovedChanges,
  openProjectIntegrationAttempt,
  pushApprovedCommit,
  rejectIntegrationAttempt,
  runRequiredChecks,
  type BaseRevisionStatus,
  type ProjectIntegrationCheckSpec,
  type ProjectIntegrationPolicy,
} from "@vioxen/subscription-runtime/worker-core";
import type {
  ProjectIntegrationMcpArgs,
  ProjectIntegrationMcpController,
  ProjectIntegrationMcpLoadController,
  ProjectIntegrationMcpResolvePathArg,
  ProjectIntegrationMcpToolHandlers,
  ProjectIntegrationMcpToolResponse,
} from "../ports/project-integration-mcp-tool-handlers";

type JsonObject = Readonly<Record<string, unknown>>;

export type ProjectIntegrationMcpUseCaseDeps =
  & Parameters<typeof openProjectIntegrationAttempt>[0]
  & Parameters<typeof applyWorkerOutput>[0]
  & Parameters<typeof runRequiredChecks>[0]
  & Parameters<typeof commitApprovedChanges>[0]
  & Parameters<typeof pushApprovedCommit>[0]
  & Parameters<typeof rejectIntegrationAttempt>[0];

export type CreateProjectIntegrationMcpToolHandlersOptions = {
  readonly loadController: ProjectIntegrationMcpLoadController;
  readonly resolvePathArg: ProjectIntegrationMcpResolvePathArg;
  readonly integrationDeps: (
    controller: ProjectIntegrationMcpController,
  ) => ProjectIntegrationMcpUseCaseDeps;
};

export function createProjectIntegrationMcpToolHandlers(
  options: CreateProjectIntegrationMcpToolHandlersOptions,
): ProjectIntegrationMcpToolHandlers {
  return {
    openAttempt: (args) =>
      projectIntegrationOpenAttempt(options, args as ProjectIntegrationMcpArgs),
    applyWorkerOutput: (args) =>
      projectIntegrationApplyWorkerOutput(options, args as ProjectIntegrationMcpArgs),
    runRequiredChecks: (args) =>
      projectIntegrationRunRequiredChecks(options, args as ProjectIntegrationMcpArgs),
    commitApprovedChanges: (args) =>
      projectIntegrationCommitApprovedChanges(
        options,
        args as ProjectIntegrationMcpArgs,
      ),
    pushApprovedCommit: (args) =>
      projectIntegrationPushApprovedCommit(options, args as ProjectIntegrationMcpArgs),
    rejectAttempt: (args) =>
      projectIntegrationRejectAttempt(options, args as ProjectIntegrationMcpArgs),
  };
}

async function projectIntegrationOpenAttempt(
  options: CreateProjectIntegrationMcpToolHandlersOptions,
  args: ProjectIntegrationMcpArgs,
): Promise<ProjectIntegrationMcpToolResponse> {
  const controller = await options.loadController(args);
  const attemptId = requiredRawString(args.attemptId, "attemptId");
  const workerJobId = requiredRawString(args.workerJobId, "workerJobId");
  const workerWorkspacePath = options.resolvePathArg(
    args,
    args.workerWorkspacePath ?? args.sourceWorkspacePath,
    "workerWorkspacePath",
  );
  const targetWorkspacePath = options.resolvePathArg(
    args,
    args.targetWorkspacePath ?? args.workspacePath,
    "targetWorkspacePath",
  );
  const targetBranch = requiredRawString(args.targetBranch ?? args.branch, "targetBranch");
  const targetRemote = stringValue(args.targetRemote ?? args.remote) ?? "origin";
  assertSafeGitRefName(targetBranch, "targetBranch");
  assertSafeGitRemoteName(targetRemote, "targetRemote");
  const commitSha = stringValue(args.workerCommitSha ?? args.commitSha);
  if (commitSha) assertSafeGitCommitSha(commitSha);
  const patchPath = stringValue(args.workerPatchPath);
  const summaryPath = stringValue(args.workerSummaryPath);
  const baseCommit = stringValue(args.workerBaseCommit);
  if (baseCommit) assertSafeGitCommitSha(baseCommit);
  const targetCommit = stringValue(args.targetCommit);
  if (targetCommit) assertSafeGitCommitSha(targetCommit);
  const baseStatus = optionalBaseRevisionStatus(args.baseStatus);
  const baseRevisionReasons = stringArrayArg(args.baseRevisionReasons);
  if (!commitSha && !patchPath) {
    throw new Error("project_integration_worker_output_source_required");
  }
  const changedFiles = requiredStringArrayArg(args.changedFiles, "changedFiles");
  const approvedFiles = stringArrayArg(args.approvedFiles);
  const requiredChecks = parseProjectIntegrationChecks(args.requiredChecks);
  const input = {
    policy: projectIntegrationPolicy(controller, args),
    attemptId,
    projectId: controller.scope.projectId,
    controllerJobId: controller.controller.jobId,
    sourceWorkspacePath: workerWorkspacePath,
    targetWorkspacePath,
    targetBranch,
    targetRemote,
    workerOutput: {
      workerJobId,
      workspacePath: workerWorkspacePath,
      ...(commitSha ? { commitSha } : {}),
      ...(patchPath ? { patchPath } : {}),
      ...(summaryPath ? { summaryPath } : {}),
      ...(baseCommit ? { baseCommit } : {}),
      ...(targetCommit ? { targetCommit } : {}),
      ...(baseStatus ? { baseStatus } : {}),
      ...(baseRevisionReasons.length ? { baseRevisionReasons } : {}),
      changedFiles,
    },
    reviewDecision: {
      reviewedBy: stringValue(args.reviewedBy) ?? controller.controller.jobId,
      decision: ReviewDecisionStatus.Approved,
      reason: stringValue(args.reviewReason) ?? "project_integration_reviewed",
      approvedFiles: approvedFiles.length ? approvedFiles : changedFiles,
      requiredChecks,
    },
  };

  if (!args.confirmOpen) {
    return mcpJson({
      ok: false,
      reason: "confirm_open_required",
      mode: "project_integration_open_attempt",
      controllerJobId: controller.controller.jobId,
      attemptId,
      attemptPreview: input as unknown as JsonObject,
    });
  }

  const attempt = await openProjectIntegrationAttempt(
    options.integrationDeps(controller),
    input,
  );
  return mcpJson({
    ok: true,
    mode: "project_integration_open_attempt",
    controllerJobId: controller.controller.jobId,
    attempt: attempt as unknown as JsonObject,
  });
}

async function projectIntegrationApplyWorkerOutput(
  options: CreateProjectIntegrationMcpToolHandlersOptions,
  args: ProjectIntegrationMcpArgs,
): Promise<ProjectIntegrationMcpToolResponse> {
  const controller = await options.loadController(args);
  const attemptId = requiredRawString(args.attemptId, "attemptId");
  if (!args.confirmApply) {
    return mcpJson({
      ok: false,
      reason: "confirm_apply_required",
      mode: "project_integration_apply_worker_output",
      controllerJobId: controller.controller.jobId,
      attemptId,
    });
  }
  const attempt = await applyWorkerOutput(options.integrationDeps(controller), {
    attemptId,
    allowedPreExistingDirtyFiles: stringArrayArg(
      args.allowedPreExistingDirtyFiles,
    ),
  });
  return mcpJson({
    ok: true,
    mode: "project_integration_apply_worker_output",
    controllerJobId: controller.controller.jobId,
    attempt: attempt as unknown as JsonObject,
  });
}

async function projectIntegrationRunRequiredChecks(
  options: CreateProjectIntegrationMcpToolHandlersOptions,
  args: ProjectIntegrationMcpArgs,
): Promise<ProjectIntegrationMcpToolResponse> {
  const controller = await options.loadController(args);
  const attemptId = requiredRawString(args.attemptId, "attemptId");
  if (!args.confirmRunChecks) {
    return mcpJson({
      ok: false,
      reason: "confirm_run_checks_required",
      mode: "project_integration_run_required_checks",
      controllerJobId: controller.controller.jobId,
      attemptId,
    });
  }
  const attempt = await runRequiredChecks(options.integrationDeps(controller), {
    attemptId,
  });
  return mcpJson({
    ok: true,
    mode: "project_integration_run_required_checks",
    controllerJobId: controller.controller.jobId,
    attempt: attempt as unknown as JsonObject,
  });
}

async function projectIntegrationCommitApprovedChanges(
  options: CreateProjectIntegrationMcpToolHandlersOptions,
  args: ProjectIntegrationMcpArgs,
): Promise<ProjectIntegrationMcpToolResponse> {
  const controller = await options.loadController(args);
  const attemptId = requiredRawString(args.attemptId, "attemptId");
  const message = requiredRawString(args.message, "message");
  if (!args.confirmCommit) {
    return mcpJson({
      ok: false,
      reason: "confirm_commit_required",
      mode: "project_integration_commit_approved_changes",
      controllerJobId: controller.controller.jobId,
      attemptId,
      message,
    });
  }
  const attempt = await commitApprovedChanges(options.integrationDeps(controller), {
    attemptId,
    message,
    policy: projectIntegrationPolicy(controller, args),
  });
  return mcpJson({
    ok: true,
    mode: "project_integration_commit_approved_changes",
    controllerJobId: controller.controller.jobId,
    attempt: attempt as unknown as JsonObject,
  });
}

async function projectIntegrationPushApprovedCommit(
  options: CreateProjectIntegrationMcpToolHandlersOptions,
  args: ProjectIntegrationMcpArgs,
): Promise<ProjectIntegrationMcpToolResponse> {
  const controller = await options.loadController(args);
  const attemptId = requiredRawString(args.attemptId, "attemptId");
  const branch = stringValue(args.branch);
  const remote = stringValue(args.remote);
  if (branch) assertSafeGitRefName(branch, "branch");
  if (remote) assertSafeGitRemoteName(remote, "remote");
  if (!args.confirmPush) {
    return mcpJson({
      ok: false,
      reason: "confirm_push_required",
      mode: "project_integration_push_approved_commit",
      controllerJobId: controller.controller.jobId,
      attemptId,
      ...(branch ? { branch } : {}),
      ...(remote ? { remote } : {}),
      force: booleanValue(args.force) ?? false,
    });
  }
  const attempt = await pushApprovedCommit(options.integrationDeps(controller), {
    attemptId,
    ...(remote ? { remote } : {}),
    ...(branch ? { branch } : {}),
    force: booleanValue(args.force) ?? false,
    policy: projectIntegrationPolicy(controller, args),
  });
  return mcpJson({
    ok: true,
    mode: "project_integration_push_approved_commit",
    controllerJobId: controller.controller.jobId,
    attempt: attempt as unknown as JsonObject,
  });
}

async function projectIntegrationRejectAttempt(
  options: CreateProjectIntegrationMcpToolHandlersOptions,
  args: ProjectIntegrationMcpArgs,
): Promise<ProjectIntegrationMcpToolResponse> {
  const controller = await options.loadController(args);
  const attemptId = requiredRawString(args.attemptId, "attemptId");
  const reason = requiredRawString(args.reason, "reason");
  if (!args.confirmReject) {
    return mcpJson({
      ok: false,
      reason: "confirm_reject_required",
      mode: "project_integration_reject_attempt",
      controllerJobId: controller.controller.jobId,
      attemptId,
      rejectionReason: reason,
    });
  }
  const attempt = await rejectIntegrationAttempt(options.integrationDeps(controller), {
    attemptId,
    reason,
  });
  return mcpJson({
    ok: true,
    mode: "project_integration_reject_attempt",
    controllerJobId: controller.controller.jobId,
    attempt: attempt as unknown as JsonObject,
  });
}

function projectIntegrationPolicy(
  controller: ProjectIntegrationMcpController,
  args: ProjectIntegrationMcpArgs,
): ProjectIntegrationPolicy {
  const allowedPathPrefixes = stringArrayArg(args.allowedPathPrefixes);
  const requiredCheckIds = stringArrayArg(args.requiredCheckIds);
  return {
    access: {
      boundary: AccessBoundary.ProjectScopedControl,
      scope: controller.scope,
    },
    ...(allowedPathPrefixes.length ? { allowedPathPrefixes } : {}),
    ...(requiredCheckIds.length ? { requiredCheckIds } : {}),
    ...(controller.scope.allowForcePush === true ? { allowForcePush: true } : {}),
    ...(args.allowStaleBase === true ? { allowStaleBase: true } : {}),
  };
}

function parseProjectIntegrationChecks(
  value: readonly unknown[] | undefined,
): readonly ProjectIntegrationCheckSpec[] {
  if (value === undefined) return [];
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`requiredChecks.${index}_invalid`);
    }
    const record = item as Record<string, unknown>;
    const timeoutMs = numberValue(record.timeoutMs);
    return {
      checkId: requiredRawString(record.checkId, `requiredChecks.${index}.checkId`),
      command: requiredStringArrayArg(
        record.command,
        `requiredChecks.${index}.command`,
      ),
      ...(record.cwd === undefined
        ? {}
        : { cwd: requiredRawString(record.cwd, `requiredChecks.${index}.cwd`) }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  });
}

function requiredStringArrayArg(value: unknown, fieldName: string): readonly string[] {
  const values = stringArrayArg(value);
  if (values.length === 0) throw new Error(`${fieldName}_required`);
  return values;
}

function stringArrayArg(value: unknown): readonly string[] {
  if (value === undefined) return [];
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values)) throw new Error("string_array_arg_invalid");
  return values.map((item) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error("string_array_arg_invalid");
    }
    return item;
  });
}

function optionalBaseRevisionStatus(
  value: string | undefined,
): BaseRevisionStatus | undefined {
  if (value === undefined) return undefined;
  if (
    value === "current" ||
    value === "stale" ||
    value === "needs_rebase_check" ||
    value === "unknown"
  ) {
    return value;
  }
  throw new Error("project_integration_base_status_invalid");
}

function assertSafeGitRefName(value: string, fieldName: string): void {
  if (
    value.startsWith("-") ||
    value.includes("..") ||
    /[\s~^:?*\\[\]\x00-\x1f\x7f]/.test(value) ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.length > 200
  ) {
    throw new Error(`project_control_${fieldName}_invalid`);
  }
}

function assertSafeGitRemoteName(value: string, fieldName: string): void {
  if (
    value.startsWith("-") ||
    !/^[A-Za-z0-9._-]+$/.test(value) ||
    value.length > 100
  ) {
    throw new Error(`project_control_${fieldName}_invalid`);
  }
}

function assertSafeGitCommitSha(value: string): void {
  if (!/^[0-9a-fA-F]{7,64}$/.test(value)) {
    throw new Error("project_control_commit_sha_invalid");
  }
}

function requiredRawString(value: unknown, name: string): string {
  const text = stringValue(value);
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function mcpJson(value: JsonObject): ProjectIntegrationMcpToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}
