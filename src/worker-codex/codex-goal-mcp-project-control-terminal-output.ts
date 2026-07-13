import {
  AccessBoundary,
  consumedOutputRecordFor,
  createAccessPolicyService,
  recordFailedNoOutput,
  type AccessPolicyService,
  type ProjectAccessScope,
  type TerminalOutputBackup,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalConsumedOutputLedgerWriter } from "@vioxen/subscription-runtime/worker-local";
import type { ProjectControlMcpArgs } from "./codex-goal-mcp-inputs";
import {
  collectCodexGoalStatus,
  resolveCodexGoalWorkerLiveness,
} from "./codex-goal-ops";
import {
  releaseCodexProjectAccount,
} from "./application/project-control/codex-goal-project-account-reservation";
import {
  readCodexGoalConsumedOutputLedgers,
} from "./application/project-control/codex-goal-consumed-output-ledger-io";
import {
  projectControlRealPathOutsideReadScope,
  projectControlRealPathOutsideWorkspaceScope,
} from "./codex-goal-mcp-project-scope";
import {
  projectControlAuditPath,
} from "./codex-goal-mcp-project-broker";
import {
  codexGoalStatusInputFromLaunch as statusInput,
} from "./codex-goal-mcp-status-input";
import {
  requiredRawString,
  stringValue,
} from "./codex-goal-mcp-values";
import type {
  CodexGoalMcpProjectControlActionsDeps,
} from "./codex-goal-mcp-project-control-actions";

type JsonObject = Readonly<Record<string, unknown>>;

export async function projectControlRecordFailedNoOutputView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlActionsDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const loaded = await deps.loadJobLaunch({
    registryRootDir: controller.registryRootDir,
    jobId: requiredRawString(args.jobId, "jobId"),
  });
  const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(
    loaded.launch.config.workspacePath,
    controller.scope,
  );
  const policy = createAccessPolicyService({
    boundary: AccessBoundary.ProjectScopedControl,
    scope: controller.scope,
  });
  const access = policy.canStopWorker({
    jobId: loaded.manifest.jobId,
    registryRoot: controller.registryRootDir,
    workspacePath: loaded.launch.config.workspacePath,
    ...(realWorkspacePath ? { realWorkspacePath } : {}),
    ...(loaded.launch.tmuxSession ? { tmuxSession: loaded.launch.tmuxSession } : {}),
  });
  if (!access.allowed) {
    throw new Error(`project_control_record_failed_no_output_denied:${access.reason}`);
  }
  const ledgerRoots = controller.scope.consumedOutputLedgerRoots ?? [];
  if (ledgerRoots.length !== 1) {
    throw new Error("project_control_consumed_output_ledger_required");
  }
  const ledgerRoot = ledgerRoots[0]!;
  const ledger = await readCodexGoalConsumedOutputLedgers({ roots: ledgerRoots });
  const sourceRecord = consumedOutputRecordFor({
    ledger,
    jobId: loaded.manifest.jobId,
    workspacePath: loaded.manifest.workspacePath,
  });
  if (!sourceRecord) {
    throw new Error("failed_no_output_source_record_required");
  }
  await assertBackupPathsReadable(sourceRecord.backup, policy, controller.scope);
  if (sourceRecord.valid && sourceRecord.status === "failed_no_output") {
    return {
      ok: true,
      mode: "project_control_record_failed_no_output",
      controllerJobId: controller.controller.jobId,
      jobId: loaded.manifest.jobId,
      ledgerPath: sourceRecord.ledgerPath,
      idempotentReplay: true,
      alreadyTerminal: true,
    };
  }
  const status = await collectCodexGoalStatus(statusInput(loaded.launch));
  const progressStale = status.progressHeartbeatAgeMs !== undefined &&
    status.progressHeartbeatAgeMs > 10 * 60_000;
  const workerLiveness = resolveCodexGoalWorkerLiveness({ status, progressStale });
  const attemptId = requiredRawString(args.terminalAttemptId, "terminalAttemptId");
  const failureCategory = requiredRawString(args.failureCategory, "failureCategory");
  const failureCode = requiredRawString(args.failureCode, "failureCode");
  const note = stringValue(args.note) ??
    `Closed ${loaded.manifest.jobId} after infrastructure failure without authored output.`;
  const closedAt = failedNoOutputClosedAt(sourceRecord.closedAt);

  if (!args.confirmFailedNoOutput) {
    return {
      ok: false,
      reason: "confirm_failed_no_output_required",
      mode: "project_control_record_failed_no_output",
      controllerJobId: controller.controller.jobId,
      jobId: loaded.manifest.jobId,
      requiredOverride: "confirmFailedNoOutput",
      sourceRecord,
      status,
      workerLiveness,
      decisionPreview: {
        status: "failed_no_output",
        attemptId,
        closedAt,
        failure: { category: failureCategory, code: failureCode },
        note,
      },
    };
  }

  const receipt = await recordFailedNoOutput(
    { writer: new LocalConsumedOutputLedgerWriter() },
    {
      allowedLedgerRoots: ledgerRoots,
      ledgerRoot,
      sourceRecord,
      jobId: loaded.manifest.jobId,
      workspace: loaded.manifest.workspacePath,
      workerAlive: workerLiveness.alive,
      workspaceDirty: status.workspaceDirty,
      attemptId,
      closedAt,
      failureCategory,
      failureCode,
      note,
    },
  );
  const accountReservationReleased = await releaseCodexProjectAccount({
    manifest: loaded.manifest,
    launch: loaded.launch,
    reason: "worker_failed_no_output",
  });
  return {
    ok: true,
    mode: "project_control_record_failed_no_output",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    auditPath: projectControlAuditPath(controller.controller),
    jobId: loaded.manifest.jobId,
    ledgerPath: receipt.ledgerPath,
    idempotentReplay: receipt.idempotentReplay,
    accountReservationReleased,
    decision: receipt.decision,
  };
}

function failedNoOutputClosedAt(sourceClosedAt: string | undefined): string {
  const sourceTime = sourceClosedAt ? Date.parse(sourceClosedAt) : Number.NaN;
  if (Number.isNaN(sourceTime)) {
    throw new Error("failed_no_output_source_closed_at_invalid");
  }
  return new Date(Math.max(Date.now(), sourceTime + 1)).toISOString();
}

async function assertBackupPathsReadable(
  backup: TerminalOutputBackup | undefined,
  policy: AccessPolicyService,
  scope: ProjectAccessScope,
): Promise<void> {
  if (!backup) throw new Error("failed_no_output_source_backup_required");
  for (const path of [
    backup.statusPath,
    backup.patchPath,
    backup.numstatPath,
    backup.untrackedArchivePath,
  ]) {
    if (!path) continue;
    const realPath = await projectControlRealPathOutsideReadScope(path, scope);
    const decision = policy.canReadPath({
      path,
      ...(realPath ? { realPath } : {}),
    });
    if (!decision.allowed) {
      throw new Error(
        `project_control_failed_no_output_backup_denied:${decision.reason}`,
      );
    }
  }
}
