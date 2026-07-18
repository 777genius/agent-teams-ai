import {
  ReviewDecisionStatus,
  type MergeIntegrationPlan,
  type ProjectAccessScope,
  type ProjectControlBroker,
} from "@vioxen/subscription-runtime/worker-core";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CodexGoalJobManifest } from "./codex-goal-jobs";
import type { CodexGoalLaunchInput } from "./codex-goal-ops";
import type { CodexProjectControlBrokerInput } from "./codex-goal-mcp-project-broker";
import { projectControlAuditPath } from "./codex-goal-mcp-project-broker";
import { ensureTerminalCodexGoalHandoffArtifacts } from "./application/ensure-codex-goal-handoff-artifacts";
import {
  localReviewedWorkerOutputDeps,
  reviewedWorkerOutputRoot,
} from "./reviewed-worker-output";
import { codexGoalStatusInputFromLaunch } from "./application/codex-goal-status-input";
import {
  booleanValue,
  requiredRawString,
  stringValue,
} from "./codex-goal-mcp-values";
import {
  parseProjectIntegrationChecks,
  requiredStringArrayArg,
  stringArrayArg,
} from "./project-integration-mcp/application/project-integration-mcp-values";
import type { ProjectControlMcpArgs } from "./codex-goal-mcp-inputs";
import { releaseCodexProjectAccount } from "./application/project-control/codex-goal-project-account-reservation";
import {
  projectControlWorkspaceLocks,
  withValidatedProjectWorkspaceLock,
} from "./codex-goal-project-workspace-lock";
import {
  parseReviewedOutputMerge,
  requiredReviewDecision,
} from "./codex-goal-mcp-project-control-reviewed-output";
import {
  recordRejectedReviewedOutput,
  recordRejectedUncapturedOutput,
} from "./codex-goal-mcp-project-control-reviewed-rejection";
import { projectControlRealPathOutsideWorkspaceScope } from "./codex-goal-mcp-project-scope";
import {
  collectCodexGoalStatus,
  resolveCodexGoalWorkerLiveness,
} from "./codex-goal-ops";

type JsonObject = Readonly<Record<string, unknown>>;

type LoadedController = {
  readonly registryRootDir: string;
  readonly controller: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
};

type LoadedJob = {
  readonly registryRootDir: string;
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
};

export type CodexGoalMcpProjectControlReviewDeps = {
  readonly loadProjectControlController: (
    args: ProjectControlMcpArgs,
  ) => Promise<LoadedController>;
  readonly loadJobLaunch: (input: {
    readonly registryRootDir: string;
    readonly jobId: string;
  }) => Promise<LoadedJob>;
  readonly codexProjectControlBroker: (
    input: Omit<CodexProjectControlBrokerInput, "admissionDeps">,
  ) => ProjectControlBroker;
};

export async function projectControlMarkReviewedView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlReviewDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const loaded = await deps.loadJobLaunch({
    registryRootDir: controller.registryRootDir,
    jobId: requiredRawString(args.jobId, "jobId"),
  });
  const captureReviewedOutput =
    booleanValue(args.captureReviewedOutput) === true;
  const reviewDecision =
    args.reviewDecision === undefined
      ? undefined
      : requiredReviewDecision(args.reviewDecision);
  if (captureReviewedOutput && reviewDecision === undefined) {
    throw new Error("review_decision_required");
  }
  if (
    !captureReviewedOutput &&
    reviewDecision !== undefined &&
    reviewDecision !== ReviewDecisionStatus.Rejected
  ) {
    throw new Error("project_control_reviewed_output_capture_required");
  }
  const reviewNote = stringValue(args.note) ?? "project_control_reviewed";
  return await withValidatedProjectWorkspaceLock({
    locks: projectControlWorkspaceLocks(controller.registryRootDir),
    scope: controller.scope,
    requestedWorkspacePath: loaded.manifest.workspacePath,
    owner:
      `project-review:${controller.controller.jobId}:` + loaded.manifest.jobId,
    effect: async (workspace) => {
      const lockedLaunch: CodexGoalLaunchInput = {
        ...loaded.launch,
        config: {
          ...loaded.launch.config,
          workspacePath: workspace.canonicalWorkspacePath,
        },
      };
      const terminalStatus = captureReviewedOutput
        ? undefined
        : reviewDecision === ReviewDecisionStatus.Rejected
          ? await collectCodexGoalStatus(
              codexGoalStatusInputFromLaunch(lockedLaunch),
            )
          : await ensureTerminalCodexGoalHandoffArtifacts({
              launch: lockedLaunch,
            });
      if (reviewDecision === ReviewDecisionStatus.Rejected && terminalStatus) {
        if (resolveCodexGoalWorkerLiveness({ status: terminalStatus }).alive) {
          throw new Error("uncaptured_rejected_output_worker_still_alive");
        }
        if (
          terminalStatus.workspaceDirty !== true ||
          (terminalStatus.changedFiles ?? []).length === 0
        ) {
          throw new Error(
            "uncaptured_rejected_output_authored_output_required",
          );
        }
      }
      const admittedMerge = captureReviewedOutput
        ? await readAdmittedMergeBinding(loaded.manifest, controller.scope)
        : undefined;
      const requestedMerge = args.merge
        ? parseReviewedOutputMerge(controller.scope, args.merge)
        : undefined;
      const selectedMerge = selectReviewedOutputMerge(
        admittedMerge,
        requestedMerge,
      );
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
                decision: reviewDecision!,
                reviewedBy:
                  stringValue(args.reviewedBy) ?? controller.controller.jobId,
                reason: stringValue(args.reviewReason) ?? reviewNote,
                approvedFiles: args.merge
                  ? stringArrayArg(args.approvedFiles)
                  : requiredStringArrayArg(
                      args.approvedFiles,
                      "approvedFiles",
                    ),
                requiredChecks: parseProjectIntegrationChecks(
                  args.requiredChecks,
                ),
                ...(selectedMerge
                  ? { merge: selectedMerge }
                  : {}),
              },
            }
          : {}),
      });
      const realWorkspacePath =
        await projectControlRealPathOutsideWorkspaceScope(
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
      let consumedOutputLedger;
      if (
        captureReviewedOutput &&
        reviewDecision === ReviewDecisionStatus.Rejected &&
        result.resourceId
      ) {
        const reviewedOutputDeps = localReviewedWorkerOutputDeps({
          rootDir: reviewedWorkerOutputRoot(controller.registryRootDir),
        });
        const snapshot = await reviewedOutputDeps.store.get(result.resourceId);
        if (!snapshot) throw new Error("reviewed_worker_output_not_found");
        consumedOutputLedger = await recordRejectedReviewedOutput({
          scope: controller.scope,
          jobRootDir: loaded.manifest.jobRootDir,
          workspacePath: workspace.canonicalWorkspacePath,
          snapshot,
        });
      } else if (
        !captureReviewedOutput &&
        reviewDecision === ReviewDecisionStatus.Rejected
      ) {
        consumedOutputLedger = await recordRejectedUncapturedOutput({
          scope: controller.scope,
          jobId: loaded.manifest.jobId,
          jobRootDir: loaded.manifest.jobRootDir,
          workspacePath: workspace.canonicalWorkspacePath,
          closedAt: loaded.manifest.updatedAt,
          reason: stringValue(args.reviewReason) ?? reviewNote,
        });
      }
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
        ...(consumedOutputLedger ? { consumedOutputLedger } : {}),
        result: result as unknown as JsonObject,
      };
    },
  });
}

export async function readAdmittedMergeBinding(
  manifest: CodexGoalJobManifest,
  scope: ProjectAccessScope,
): Promise<MergeIntegrationPlan | undefined> {
  const descriptor = manifest.projectPreStartAdmission;
  if (!descriptor || !("mode" in descriptor) || descriptor.mode !== "serial-builtin") {
    return undefined;
  }
  let receipt: unknown;
  let contractBody: Buffer;
  try {
    receipt = JSON.parse(await readFile(descriptor.receiptPath, "utf8"));
    contractBody = await readFile(descriptor.contractPath);
  } catch {
    throw new Error("project_control_review_merge_receipt_invalid");
  }
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) {
    throw new Error("project_control_review_merge_receipt_invalid");
  }
  const receiptRecord = receipt as Readonly<Record<string, unknown>>;
  const merge = receiptRecord.merge;
  if (merge === undefined) return undefined;
  const contractSha256 = createHash("sha256").update(contractBody).digest("hex");
  if (receiptRecord.contractSha256 !== contractSha256) {
    throw new Error("project_control_review_merge_receipt_invalid");
  }
  let contract: unknown;
  try {
    contract = JSON.parse(contractBody.toString("utf8"));
  } catch {
    throw new Error("project_control_review_merge_receipt_invalid");
  }
  if (
    typeof contract !== "object" || contract === null || Array.isArray(contract) ||
    JSON.stringify((contract as Readonly<Record<string, unknown>>).merge) !==
      JSON.stringify(merge)
  ) {
    throw new Error("project_control_review_merge_receipt_invalid");
  }
  try {
    return parseReviewedOutputMerge(
      scope,
      merge as NonNullable<ProjectControlMcpArgs["merge"]>,
    );
  } catch {
    throw new Error("project_control_review_merge_receipt_invalid");
  }
}

export function selectReviewedOutputMerge(
  admitted: MergeIntegrationPlan | undefined,
  requested: MergeIntegrationPlan | undefined,
): MergeIntegrationPlan | undefined {
  if (admitted && requested && JSON.stringify(admitted) !== JSON.stringify(requested)) {
    throw new Error("project_control_review_merge_binding_mismatch");
  }
  return admitted ?? requested;
}
