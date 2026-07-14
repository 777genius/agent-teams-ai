import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  AccessBoundary,
  assertFailedNoOutputEvidence,
  consumedOutputRecordFor,
  createAccessPolicyService,
  recordFailedNoOutput,
  recordTerminalOutputDecision,
  type ProjectAccessScope,
  type TerminalOutputBackup,
} from "@vioxen/subscription-runtime/worker-core";
import {
  captureLocalTerminalOutputBackup,
  LocalConsumedOutputLedgerWriter,
} from "@vioxen/subscription-runtime/worker-local";
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
  assertProjectPreStartAdmissionLaunchBinding,
} from "./application/project-control/codex-goal-project-pre-start-admission";
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
import {
  projectControlWorkspaceLocks,
  withValidatedProjectWorkspaceLock,
} from "./codex-goal-project-workspace-lock";

type JsonObject = Readonly<Record<string, unknown>>;
const MAX_PREEXISTING_WORKSPACE_PATCH_BYTES = 16 * 1024 * 1024;

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
  const preexistingWorkspacePatch = await requestedPreexistingWorkspacePatch(
    args,
    {
      scope: controller.scope,
      registryRootDir: controller.registryRootDir,
      jobId: loaded.manifest.jobId,
      jobRootDir: loaded.manifest.jobRootDir,
    },
  );
  const attemptId = requiredRawString(args.terminalAttemptId, "terminalAttemptId");
  const failureCategory = requiredRawString(args.failureCategory, "failureCategory");
  const failureCode = requiredRawString(args.failureCode, "failureCode");
  const note = stringValue(args.note) ??
    `Closed ${loaded.manifest.jobId} after infrastructure failure without authored output.`;
  if (!sourceRecord) {
    return await recordInitialFailedNoOutput({
      controller,
      loaded,
      ledgerRoots,
      ledgerRoot,
      attemptId,
      failureCategory,
      failureCode,
      note,
      confirmFailedNoOutput: args.confirmFailedNoOutput === true,
      confirmPreexistingWorkspacePatch:
        args.confirmPreexistingWorkspacePatch === true,
      ...(preexistingWorkspacePatch ? { preexistingWorkspacePatch } : {}),
    });
  }
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
        ...(preexistingWorkspacePatch ? { preexistingWorkspacePatch } : {}),
      },
    };
  }
  if (preexistingWorkspacePatch && !args.confirmPreexistingWorkspacePatch) {
    return {
      ok: false,
      reason: "confirm_preexisting_workspace_patch_required",
      mode: "project_control_record_failed_no_output",
      controllerJobId: controller.controller.jobId,
      jobId: loaded.manifest.jobId,
      requiredOverride: "confirmPreexistingWorkspacePatch",
      sourceRecord,
      status,
      workerLiveness,
      decisionPreview: {
        status: "failed_no_output",
        attemptId,
        closedAt,
        failure: { category: failureCategory, code: failureCode },
        note,
        preexistingWorkspacePatch,
      },
    };
  }

  return await withValidatedProjectWorkspaceLock({
    locks: projectControlWorkspaceLocks(controller.registryRootDir),
    scope: controller.scope,
    requestedWorkspacePath: loaded.manifest.workspacePath,
    owner:
      `project-failed-no-output-correction:${controller.controller.jobId}:` +
      loaded.manifest.jobId,
    effect: async (workspace) => {
      const lockedLedger = await readCodexGoalConsumedOutputLedgers({
        roots: ledgerRoots,
      });
      const lockedSourceRecord = consumedOutputRecordFor({
        ledger: lockedLedger,
        jobId: loaded.manifest.jobId,
        workspacePath: workspace.canonicalWorkspacePath,
      });
      if (!lockedSourceRecord) {
        throw new Error("failed_no_output_source_record_required");
      }
      await assertBackupPathsReadable(lockedSourceRecord.backup, {
        scope: controller.scope,
        registryRootDir: controller.registryRootDir,
        jobId: loaded.manifest.jobId,
        jobRootDir: loaded.manifest.jobRootDir,
      });
      if (
        lockedSourceRecord.valid &&
        lockedSourceRecord.status === "failed_no_output"
      ) {
        return {
          ok: true,
          mode: "project_control_record_failed_no_output",
          controllerJobId: controller.controller.jobId,
          jobId: loaded.manifest.jobId,
          ledgerPath: lockedSourceRecord.ledgerPath,
          idempotentReplay: true,
          alreadyTerminal: true,
        };
      }

      const lockedLaunch = {
        ...loaded.launch,
        config: {
          ...loaded.launch.config,
          workspacePath: workspace.canonicalWorkspacePath,
        },
      };
      const lockedStatus = await collectCodexGoalStatus(statusInput(lockedLaunch));
      const lockedProgressStale =
        lockedStatus.progressHeartbeatAgeMs !== undefined &&
        lockedStatus.progressHeartbeatAgeMs > 10 * 60_000;
      const lockedWorkerLiveness = resolveCodexGoalWorkerLiveness({
        status: lockedStatus,
        progressStale: lockedProgressStale,
      });
      const lockedClosedAt = failedNoOutputClosedAt(lockedSourceRecord.closedAt);
      const validationInput = {
        allowedLedgerRoots: ledgerRoots,
        ledgerRoot,
        sourceRecord: lockedSourceRecord,
        jobId: loaded.manifest.jobId,
        workspace: loaded.manifest.workspacePath,
        workerAlive: lockedWorkerLiveness.alive,
        workspaceDirty: lockedStatus.workspaceDirty,
        attemptId,
        closedAt: lockedClosedAt,
        failureCategory,
        failureCode,
        note,
        ...(preexistingWorkspacePatch
          ? { preexistingWorkspacePatch }
          : {}),
      };
      assertFailedNoOutputEvidence(validationInput);
      const archivedPreexistingWorkspacePatch = preexistingWorkspacePatch
        ? await archivePreexistingWorkspacePatch({
            source: preexistingWorkspacePatch,
            archivePath: dirname(lockedSourceRecord.backup!.statusPath),
          })
        : undefined;
      const accountReservationReleased = await releaseCodexProjectAccount({
        manifest: loaded.manifest,
        launch: lockedLaunch,
        reason: "worker_failed_no_output",
      });
      const receipt = await recordFailedNoOutput(
        { writer: new LocalConsumedOutputLedgerWriter() },
        {
          ...validationInput,
          ...(archivedPreexistingWorkspacePatch
            ? { preexistingWorkspacePatch: archivedPreexistingWorkspacePatch }
            : {}),
        },
      );
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
    },
  });
}

async function recordInitialFailedNoOutput(input: {
  readonly controller: Awaited<ReturnType<
    CodexGoalMcpProjectControlActionsDeps["loadProjectControlController"]
  >>;
  readonly loaded: Awaited<ReturnType<
    CodexGoalMcpProjectControlActionsDeps["loadJobLaunch"]
  >>;
  readonly ledgerRoots: readonly string[];
  readonly ledgerRoot: string;
  readonly attemptId: string;
  readonly failureCategory: string;
  readonly failureCode: string;
  readonly note: string;
  readonly confirmFailedNoOutput: boolean;
  readonly confirmPreexistingWorkspacePatch: boolean;
  readonly preexistingWorkspacePatch?: {
    readonly path: string;
    readonly sha256: string;
  };
}): Promise<JsonObject> {
  const status = await collectCodexGoalStatus(statusInput(input.loaded.launch));
  const progressStale = status.progressHeartbeatAgeMs !== undefined &&
    status.progressHeartbeatAgeMs > 10 * 60_000;
  const workerLiveness = resolveCodexGoalWorkerLiveness({ status, progressStale });
  const closedAt = new Date().toISOString();
  const decisionPreview = {
    status: "failed_no_output",
    attemptId: input.attemptId,
    closedAt,
    failure: { category: input.failureCategory, code: input.failureCode },
    note: input.note,
    ...(input.preexistingWorkspacePatch
      ? { preexistingWorkspacePatch: input.preexistingWorkspacePatch }
      : {}),
  };
  if (!input.confirmFailedNoOutput) {
    return {
      ok: false,
      reason: "confirm_failed_no_output_required",
      mode: "project_control_record_failed_no_output",
      controllerJobId: input.controller.controller.jobId,
      jobId: input.loaded.manifest.jobId,
      requiredOverride: "confirmFailedNoOutput",
      sourceRecord: null,
      status,
      workerLiveness,
      decisionPreview,
    };
  }
  if (
    input.preexistingWorkspacePatch &&
    !input.confirmPreexistingWorkspacePatch
  ) {
    return {
      ok: false,
      reason: "confirm_preexisting_workspace_patch_required",
      mode: "project_control_record_failed_no_output",
      controllerJobId: input.controller.controller.jobId,
      jobId: input.loaded.manifest.jobId,
      requiredOverride: "confirmPreexistingWorkspacePatch",
      sourceRecord: null,
      status,
      workerLiveness,
      decisionPreview,
    };
  }
  return await withValidatedProjectWorkspaceLock({
    locks: projectControlWorkspaceLocks(input.controller.registryRootDir),
    scope: input.controller.scope,
    requestedWorkspacePath: input.loaded.manifest.workspacePath,
    owner:
      `project-failed-no-output:${input.controller.controller.jobId}:` +
      input.loaded.manifest.jobId,
    effect: async (workspace) => {
      const lockedLaunch = {
        ...input.loaded.launch,
        config: {
          ...input.loaded.launch.config,
          workspacePath: workspace.canonicalWorkspacePath,
        },
      };
      const lockedStatus = await collectCodexGoalStatus(
        statusInput(lockedLaunch),
      );
      const lockedProgressStale =
        lockedStatus.progressHeartbeatAgeMs !== undefined &&
        lockedStatus.progressHeartbeatAgeMs > 10 * 60_000;
      const lockedWorkerLiveness = resolveCodexGoalWorkerLiveness({
        status: lockedStatus,
        progressStale: lockedProgressStale,
      });
      if (lockedWorkerLiveness.alive) {
        throw new Error("failed_no_output_worker_still_alive");
      }
      if (input.preexistingWorkspacePatch) {
        assertNoWorkerLaunchArtifacts(lockedStatus);
        if (lockedStatus.workspaceDirty !== true) {
          throw new Error(
            "failed_no_output_preexisting_patch_workspace_required",
          );
        }
        await assertProjectPreStartAdmissionLaunchBinding({
          manifest: input.loaded.manifest,
          scope: input.controller.scope,
          workspaceMode: "admitted_input_patch",
          expectedInputPatchArtifactSha256:
            input.preexistingWorkspacePatch.sha256,
        });
      } else if (lockedStatus.workspaceDirty !== false) {
        throw new Error("failed_no_output_clean_workspace_required");
      }
      const backup = await captureLocalTerminalOutputBackup({
        archiveRoot: join(input.loaded.manifest.jobRootDir, "archives"),
        archiveName:
          `${input.loaded.manifest.jobId}-failed-no-output-${input.attemptId}`,
        workspacePath: workspace.canonicalWorkspacePath,
        changedFiles: [],
      });
      const backupStatusDirty =
        (await readFile(backup.statusPath, "utf8")).trim().length > 0;
      if (
        backup.hasAuthoredOutput ||
        (input.preexistingWorkspacePatch
          ? !backupStatusDirty
          : backupStatusDirty)
      ) {
        throw new Error("failed_no_output_clean_workspace_required");
      }
      const archivedPreexistingWorkspacePatch =
        input.preexistingWorkspacePatch
          ? await archivePreexistingWorkspacePatch({
              source: input.preexistingWorkspacePatch,
              archivePath: backup.archivePath,
            })
          : undefined;
      if (input.preexistingWorkspacePatch) {
        await assertProjectPreStartAdmissionLaunchBinding({
          manifest: input.loaded.manifest,
          scope: input.controller.scope,
          workspaceMode: "admitted_input_patch",
          expectedInputPatchArtifactSha256:
            input.preexistingWorkspacePatch.sha256,
        });
      }
      const accountReservationReleased = await releaseCodexProjectAccount({
        manifest: input.loaded.manifest,
        launch: lockedLaunch,
        reason: "worker_failed_no_output",
      });
      const receipt = await recordTerminalOutputDecision(
        { writer: new LocalConsumedOutputLedgerWriter() },
        {
          allowedLedgerRoots: input.ledgerRoots,
          ledgerRoot: input.ledgerRoot,
          decision: {
            schemaVersion: 1,
            jobId: input.loaded.manifest.jobId,
            attemptId: input.attemptId,
            status: "failed_no_output",
            closedAt,
            archivePath: backup.archivePath,
            failure: {
              category: input.failureCategory,
              code: input.failureCode,
            },
            output: { authoredChanges: false, workspaceDirty: false },
            ...(archivedPreexistingWorkspacePatch
              ? {
                  preexistingWorkspacePatch:
                    archivedPreexistingWorkspacePatch,
                }
              : {}),
            note: input.note,
            backup: {
              workspace: input.loaded.manifest.workspacePath,
              statusPath: backup.statusPath,
              patchPath: backup.patchPath,
              numstatPath: backup.numstatPath,
            },
          },
        },
      );
      return {
        ok: true,
        mode: "project_control_record_failed_no_output",
        controllerJobId: input.controller.controller.jobId,
        registryRootDir: input.controller.registryRootDir,
        auditPath: projectControlAuditPath(input.controller.controller),
        jobId: input.loaded.manifest.jobId,
        ledgerPath: receipt.ledgerPath,
        idempotentReplay: receipt.idempotentReplay,
        accountReservationReleased,
        decision: receipt.decision,
      };
    },
  });
}

async function archivePreexistingWorkspacePatch(input: {
  readonly source: { readonly path: string; readonly sha256: string };
  readonly archivePath: string;
}): Promise<{ readonly path: string; readonly sha256: string }> {
  const contents = await readFile(input.source.path);
  if (contents.byteLength > MAX_PREEXISTING_WORKSPACE_PATCH_BYTES) {
    throw new Error("failed_no_output_preexisting_patch_too_large");
  }
  const actualSha256 = createHash("sha256").update(contents).digest("hex");
  if (actualSha256 !== input.source.sha256) {
    throw new Error("failed_no_output_preexisting_patch_sha256_mismatch");
  }
  const path = join(input.archivePath, "preexisting-workspace.patch");
  try {
    await writeFile(path, contents, { flag: "wx", mode: 0o400 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existingSha256 = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    if (existingSha256 !== input.source.sha256) {
      throw new Error("failed_no_output_preexisting_patch_archive_conflict");
    }
  }
  return { path, sha256: input.source.sha256 };
}

function assertNoWorkerLaunchArtifacts(
  status: Awaited<ReturnType<typeof collectCodexGoalStatus>>,
): void {
  if (
    status.tmuxAlive === true ||
    status.resultExists !== false ||
    status.progressExists !== false ||
    status.logExists !== false ||
    status.runtimeEventsExists !== false
  ) {
    throw new Error("failed_no_output_worker_launch_artifacts_present");
  }
}

async function requestedPreexistingWorkspacePatch(
  args: ProjectControlMcpArgs,
  input: {
    readonly scope: ProjectAccessScope;
    readonly registryRootDir: string;
    readonly jobId: string;
    readonly jobRootDir: string;
  },
): Promise<{ readonly path: string; readonly sha256: string } | undefined> {
  const path = stringValue(args.preexistingWorkspacePatchPath);
  const expectedSha256 = stringValue(args.preexistingWorkspacePatchSha256)?.toLowerCase();
  if (!path && !expectedSha256) return undefined;
  if (!path || !expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("failed_no_output_preexisting_patch_evidence_required");
  }
  await assertEvidencePathReadable(path, input);
  if ((await stat(path)).size > MAX_PREEXISTING_WORKSPACE_PATCH_BYTES) {
    throw new Error("failed_no_output_preexisting_patch_too_large");
  }
  const contents = await readFile(path);
  if (contents.byteLength > MAX_PREEXISTING_WORKSPACE_PATCH_BYTES) {
    throw new Error("failed_no_output_preexisting_patch_too_large");
  }
  const actualSha256 = createHash("sha256").update(contents).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error("failed_no_output_preexisting_patch_sha256_mismatch");
  }
  return { path, sha256: expectedSha256 };
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
  input: {
    readonly scope: ProjectAccessScope;
    readonly registryRootDir: string;
    readonly jobId: string;
    readonly jobRootDir: string;
  },
): Promise<void> {
  if (!backup) throw new Error("failed_no_output_source_backup_required");
  for (const path of [
    backup.statusPath,
    backup.patchPath,
    backup.numstatPath,
    backup.untrackedArchivePath,
  ]) {
    if (!path) continue;
    await assertEvidencePathReadable(path, input);
  }
}

async function assertEvidencePathReadable(
  path: string,
  input: {
    readonly scope: ProjectAccessScope;
    readonly registryRootDir: string;
    readonly jobId: string;
    readonly jobRootDir: string;
  },
): Promise<void> {
  const evidenceRoot = projectOwnedEvidenceRoot(path, input);
  const scope = evidenceRoot
    ? {
        ...input.scope,
        readRoots: Array.from(new Set([
          ...(input.scope.readRoots ?? []),
          evidenceRoot,
        ])),
      }
    : input.scope;
  const policy = createAccessPolicyService({
    boundary: AccessBoundary.ProjectScopedControl,
    scope,
  });
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

function projectOwnedEvidenceRoot(
  path: string,
  input: {
    readonly registryRootDir: string;
    readonly jobId: string;
    readonly jobRootDir: string;
  },
): string | undefined {
  const candidate = resolve(path);
  const jobRoot = resolve(input.jobRootDir);
  if (pathInsideOrEqual(candidate, jobRoot)) return jobRoot;

  const archiveRoot = join(dirname(resolve(input.registryRootDir)), "archives");
  const archiveRelative = relative(archiveRoot, candidate);
  if (
    !archiveRelative ||
    archiveRelative === ".." ||
    archiveRelative.startsWith(`..${sep}`)
  ) {
    return undefined;
  }
  const archiveName = archiveRelative.split(sep)[0]!;
  if (
    archiveName !== input.jobId &&
    !archiveName.startsWith(`${input.jobId}-`)
  ) {
    return undefined;
  }
  return join(archiveRoot, archiveName);
}

function pathInsideOrEqual(path: string, root: string): boolean {
  const relativePath = relative(root, path);
  return relativePath === "" ||
    relativePath !== ".." && !relativePath.startsWith(`..${sep}`);
}
