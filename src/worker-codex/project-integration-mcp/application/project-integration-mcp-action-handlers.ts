import {
  ReviewDecisionStatus,
  applyWorkerOutput,
  commitApprovedChanges,
  openProjectIntegrationAttempt,
  pushApprovedCommit,
  rejectIntegrationAttempt,
  runRequiredChecks,
} from "@vioxen/subscription-runtime/worker-core";
import type {
  ProjectIntegrationMcpArgs,
  ProjectIntegrationMcpToolResponse,
} from "../ports/project-integration-mcp-tool-handlers";
import type {
  CreateProjectIntegrationMcpToolHandlersOptions,
  JsonObject,
} from "./project-integration-mcp-handler-contracts";
import {
  assertSafeGitCommitSha,
  assertSafeGitRefName,
  assertSafeGitRemoteName,
  booleanValue,
  mcpJson,
  optionalBaseRevisionStatus,
  parseProjectIntegrationChecks,
  projectIntegrationPolicy,
  requiredRawString,
  requiredStringArrayArg,
  stringArrayArg,
  stringValue,
} from "./project-integration-mcp-values";

export async function projectIntegrationOpenAttempt(
  options: CreateProjectIntegrationMcpToolHandlersOptions,
  args: ProjectIntegrationMcpArgs,
): Promise<ProjectIntegrationMcpToolResponse> {
  const controller = await options.loadController(args);
  const attemptId = requiredRawString(args.attemptId, "attemptId");
  const reviewedOutputId = stringValue(args.reviewedOutputId);
  const expectedWorkerJobId = stringValue(args.workerJobId);
  if (reviewedOutputId) assertNoExplicitReviewedOutputSource(args);
  const resolvedReviewedOutput = reviewedOutputId
    ? await requiredReviewedOutputResolver(options)(controller, {
        reviewedOutputId,
        ...(expectedWorkerJobId
          ? { expectedWorkerJobId }
          : {}),
      })
    : undefined;
  const workerJobId = resolvedReviewedOutput?.workerOutput.workerJobId ??
    requiredRawString(args.workerJobId, "workerJobId");
  const workerWorkspacePath = resolvedReviewedOutput?.workerOutput.workspacePath ??
    options.resolvePathArg(
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
  const commitSha = resolvedReviewedOutput?.workerOutput.commitSha ??
    stringValue(args.workerCommitSha ?? args.commitSha);
  if (commitSha) assertSafeGitCommitSha(commitSha);
  const patchPath = resolvedReviewedOutput?.workerOutput.patchPath ??
    stringValue(args.workerPatchPath);
  const summaryPath = resolvedReviewedOutput?.workerOutput.summaryPath ??
    stringValue(args.workerSummaryPath);
  const handoffManifestPath = resolvedReviewedOutput?.workerOutput.handoffManifestPath ??
    stringValue(args.workerHandoffManifestPath);
  const handoffManifestSha256 =
    resolvedReviewedOutput?.workerOutput.handoffManifestSha256 ??
    stringValue(args.workerHandoffManifestSha256);
  const baseCommit = resolvedReviewedOutput?.workerOutput.baseCommit ??
    stringValue(args.workerBaseCommit);
  if (baseCommit) assertSafeGitCommitSha(baseCommit);
  const targetCommit = stringValue(args.targetCommit);
  if (targetCommit) assertSafeGitCommitSha(targetCommit);
  const baseStatus = optionalBaseRevisionStatus(args.baseStatus);
  const baseRevisionReasons = stringArrayArg(args.baseRevisionReasons);
  if (!commitSha && !patchPath) {
    throw new Error("project_integration_worker_output_source_required");
  }
  const changedFiles = resolvedReviewedOutput?.workerOutput.changedFiles ??
    requiredStringArrayArg(args.changedFiles, "changedFiles");
  const validatedHandoff = !resolvedReviewedOutput && args.confirmOpen && patchPath &&
      options.validateWorkerHandoffArtifact
    ? await options.validateWorkerHandoffArtifact({
        controller,
        attemptId,
        workerJobId,
        workspacePath: workerWorkspacePath,
        patchPath,
        ...(summaryPath ? { summaryPath } : {}),
        ...(handoffManifestPath ? { manifestPath: handoffManifestPath } : {}),
        ...(handoffManifestSha256
          ? { manifestSha256: handoffManifestSha256 }
          : {}),
        ...(baseCommit ? { baseCommit } : {}),
        changedPaths: changedFiles,
      })
    : undefined;
  const effectiveBaseCommit = baseCommit ?? validatedHandoff?.baseCommit;
  const effectivePatchPath = validatedHandoff?.patchPath ?? patchPath;
  const effectivePatchSha256 = resolvedReviewedOutput?.workerOutput.patchSha256 ??
    validatedHandoff?.patchSha256;
  const effectiveSummaryPath = summaryPath ?? validatedHandoff?.summaryPath;
  const effectiveManifestPath = handoffManifestPath ??
    validatedHandoff?.manifestPath;
  const approvedFiles = stringArrayArg(args.approvedFiles);
  const requiredChecks = parseProjectIntegrationChecks(args.requiredChecks);
  const reviewDecision = resolvedReviewedOutput?.snapshot.reviewDecision ?? {
    reviewedBy: stringValue(args.reviewedBy) ?? controller.controller.jobId,
    decision: ReviewDecisionStatus.Approved,
    reason: stringValue(args.reviewReason) ?? "project_integration_reviewed",
    approvedFiles: approvedFiles.length ? approvedFiles : changedFiles,
    requiredChecks,
  };
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
      ...(effectivePatchPath ? { patchPath: effectivePatchPath } : {}),
      ...(effectivePatchSha256 ? { patchSha256: effectivePatchSha256 } : {}),
      ...(patchPath && effectivePatchPath !== patchPath
        ? { sourcePatchPath: patchPath }
        : {}),
      ...(effectiveSummaryPath ? { summaryPath: effectiveSummaryPath } : {}),
      ...(effectiveManifestPath
        ? { handoffManifestPath: effectiveManifestPath }
        : {}),
      ...(handoffManifestSha256
        ? { handoffManifestSha256 }
        : {}),
      ...(effectiveBaseCommit ? { baseCommit: effectiveBaseCommit } : {}),
      ...(targetCommit ? { targetCommit } : {}),
      ...(baseStatus ? { baseStatus } : {}),
      ...(baseRevisionReasons.length ? { baseRevisionReasons } : {}),
      changedFiles,
    },
    reviewDecision,
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

function requiredReviewedOutputResolver(
  options: CreateProjectIntegrationMcpToolHandlersOptions,
): NonNullable<CreateProjectIntegrationMcpToolHandlersOptions["resolveReviewedOutput"]> {
  if (!options.resolveReviewedOutput) {
    throw new Error("reviewed_worker_output_resolver_unavailable");
  }
  return options.resolveReviewedOutput;
}

function assertNoExplicitReviewedOutputSource(args: ProjectIntegrationMcpArgs): void {
  const conflicting = [
    args.sourceWorkspacePath,
    args.workerWorkspacePath,
    args.commitSha,
    args.workerCommitSha,
    args.workerPatchPath,
    args.workerSummaryPath,
    args.workerHandoffManifestPath,
    args.workerHandoffManifestSha256,
    args.workerBaseCommit,
    args.changedFiles,
    args.approvedFiles,
    args.requiredChecks,
    args.reviewedBy,
    args.reviewReason,
  ].some((value) => value !== undefined);
  if (conflicting) {
    throw new Error("reviewed_worker_output_explicit_source_conflict");
  }
}

export async function projectIntegrationApplyWorkerOutput(
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

export async function projectIntegrationRunRequiredChecks(
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

export async function projectIntegrationCommitApprovedChanges(
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

export async function projectIntegrationPushApprovedCommit(
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

export async function projectIntegrationRejectAttempt(
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
  const result = await rejectIntegrationAttempt(options.integrationDeps(controller), {
    attemptId,
    reason,
  });
  const { consumedOutputLedger, ...attempt } = result;
  return mcpJson({
    ok: true,
    mode: "project_integration_reject_attempt",
    controllerJobId: controller.controller.jobId,
    attempt: attempt as unknown as JsonObject,
    consumedOutputLedger: consumedOutputLedger as unknown as JsonObject,
  });
}
