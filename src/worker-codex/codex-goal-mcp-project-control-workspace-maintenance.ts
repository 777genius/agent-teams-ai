import { createHash } from "node:crypto";
import { lstat, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  consumedOutputRecordFor,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import {
  listCodexGoalJobs,
  readCodexGoalJob,
  type CodexGoalJobManifest,
} from "./codex-goal-jobs";
import type { ProjectControlMcpArgs } from "./codex-goal-mcp-inputs";
import type { CodexGoalStatus } from "./codex-goal-ops";
import {
  collectCodexGoalStatus,
  resolveCodexGoalWorkerLiveness,
} from "./codex-goal-ops";
import { projectControlAuditPath } from "./codex-goal-mcp-project-broker";
import { execGitStdout } from "./codex-goal-mcp-project-git";
import type { CodexGoalMcpProjectControlActionsDeps } from "./codex-goal-mcp-project-control-actions";
import { codexGoalStatusInputFromLaunch as statusInput } from "./codex-goal-mcp-status-input";
import {
  projectControlWorkspaceLocks,
  withValidatedProjectWorkspaceLock,
} from "./codex-goal-project-workspace-lock";
import { readCodexGoalConsumedOutputLedgers } from "./application/project-control/codex-goal-consumed-output-ledger-io";
import { pathInsideAnyProjectRoot } from "./application/project-control/codex-goal-project-utils";
import { requiredRawString } from "./codex-goal-mcp-values";

type JsonObject = Readonly<Record<string, unknown>>;
const PRUNABLE_TERMINAL_STATUSES = new Set([
  "integrated",
  "rejected",
  "failed_no_output",
]);

export type CodexGoalMcpProjectControlWorkspaceMaintenanceDeps =
  CodexGoalMcpProjectControlActionsDeps & {
    readonly collectStatus?: typeof collectCodexGoalStatus;
    readonly listJobs?: typeof listCodexGoalJobs;
    readonly readJob?: typeof readCodexGoalJob;
    readonly readLedgers?: typeof readCodexGoalConsumedOutputLedgers;
  };

export async function projectControlPruneWorkspaceDependenciesView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlWorkspaceMaintenanceDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const jobId = requiredRawString(args.jobId, "jobId");
  const expectedWorkspacePath = requiredRawString(
    args.expectedWorkspacePath,
    "expectedWorkspacePath",
  );
  const loaded = await deps.loadJobLaunch({
    registryRootDir: controller.registryRootDir,
    jobId,
  });
  assertExpectedWorkspacePath(loaded.manifest, expectedWorkspacePath);

  return await withValidatedProjectWorkspaceLock({
    locks: projectControlWorkspaceLocks(controller.registryRootDir),
    scope: controller.scope,
    requestedWorkspacePath: loaded.manifest.workspacePath,
    owner:
      `project-prune-workspace-dependencies:${controller.controller.jobId}:` +
      jobId,
    effect: async (workspace) => {
      const readJob = deps.readJob ?? readCodexGoalJob;
      const lockedManifest = await readJob({
        registryRootDir: controller.registryRootDir,
        jobId,
      });
      assertExpectedWorkspacePath(lockedManifest, expectedWorkspacePath);
      if (
        resolve(lockedManifest.workspacePath) !==
        resolve(workspace.requestedWorkspacePath)
      ) {
        throw new Error("project_control_prune_workspace_binding_changed");
      }
      await assertWorkspaceInsideWorktreeRoots(
        workspace.canonicalWorkspacePath,
        controller.scope,
      );

      const readLedgers =
        deps.readLedgers ?? readCodexGoalConsumedOutputLedgers;
      const ledgerRoots = controller.scope.consumedOutputLedgerRoots ?? [];
      if (ledgerRoots.length !== 1) {
        throw new Error(
          "project_control_prune_consumed_output_ledger_required",
        );
      }
      const ledger = await readLedgers({ roots: ledgerRoots });
      const terminalRecord = consumedOutputRecordFor({
        ledger,
        jobId,
        workspacePath: workspace.canonicalWorkspacePath,
        resolvedWorkspacePath: workspace.canonicalWorkspacePath,
      });
      if (
        !terminalRecord?.valid ||
        !PRUNABLE_TERMINAL_STATUSES.has(terminalRecord.status)
      ) {
        throw new Error("project_control_prune_terminal_output_required");
      }

      const collectStatus = deps.collectStatus ?? collectCodexGoalStatus;
      const lockedLaunch = {
        ...loaded.launch,
        config: {
          ...loaded.launch.config,
          workspacePath: workspace.canonicalWorkspacePath,
        },
      };
      const status = await collectStatus(statusInput(lockedLaunch));
      assertWorkspaceDependenciesWorkerStopped(status);
      await assertNoSharedWorkspaceJob({
        registryRootDir: controller.registryRootDir,
        jobId,
        workspacePath: workspace.canonicalWorkspacePath,
        listJobs: deps.listJobs ?? listCodexGoalJobs,
      });

      const dependencyRoot = join(
        workspace.canonicalWorkspacePath,
        "node_modules",
      );
      const dependencyState = await inspectDependencyRoot(
        workspace.canonicalWorkspacePath,
        dependencyRoot,
      );
      const gitStatusBefore = await gitStatus(workspace.canonicalWorkspacePath);
      const preview = {
        jobId,
        expectedWorkspacePath,
        workspacePath: workspace.canonicalWorkspacePath,
        dependencyRoot,
        dependencyRootExists: dependencyState.exists,
        terminalStatus: terminalRecord.status,
        workerAlive: false,
        sharedWorkspaceJobIds: [] as readonly string[],
        gitStatusSha256: sha256(gitStatusBefore),
      };

      const broker = deps.codexProjectControlBroker({
        registryRootDir: controller.registryRootDir,
        controller: controller.controller,
        scope: controller.scope,
        pruneWorkspaceDependenciesEffect: async (authorizedWorkspacePath) => {
          if (
            resolve(authorizedWorkspacePath) !==
            resolve(workspace.canonicalWorkspacePath)
          ) {
            throw new Error(
              "project_control_prune_authorized_workspace_mismatch",
            );
          }
          if (args.confirmPrune !== true) {
            return {
              status: "noop",
              resourceId: dependencyRoot,
              safeMessage: "dependency prune requires explicit confirmation",
            };
          }
          if (!dependencyState.exists) {
            return {
              status: "noop",
              resourceId: dependencyRoot,
              safeMessage: "workspace dependency root is already absent",
            };
          }
          await rm(dependencyRoot, { recursive: true, force: false });
          const gitStatusAfter = await gitStatus(
            workspace.canonicalWorkspacePath,
          );
          if (gitStatusAfter !== gitStatusBefore) {
            throw new Error("project_control_prune_git_status_changed");
          }
          return { status: "applied", resourceId: dependencyRoot };
        },
      });
      const operation = await broker.pruneWorkspaceDependencies({
        jobId,
        registryRoot: controller.registryRootDir,
        workspacePath: workspace.canonicalWorkspacePath,
        realWorkspacePath: workspace.canonicalWorkspacePath,
        ...(lockedManifest.tmuxSession
          ? { tmuxSession: lockedManifest.tmuxSession }
          : {}),
      });

      if (args.confirmPrune !== true) {
        return {
          ok: false,
          reason: "confirm_prune_required",
          mode: "project_control_prune_workspace_dependencies",
          controllerJobId: controller.controller.jobId,
          auditPath: projectControlAuditPath(controller.controller),
          requiredOverride: "confirmPrune",
          preview,
          operation,
        };
      }
      return {
        ok: true,
        mode: "project_control_prune_workspace_dependencies",
        controllerJobId: controller.controller.jobId,
        auditPath: projectControlAuditPath(controller.controller),
        preview,
        operation,
        removed: operation.status === "applied",
        idempotentReplay: operation.status === "noop",
      };
    },
  });
}

export function assertWorkspaceDependenciesWorkerStopped(
  status: CodexGoalStatus,
): void {
  const progressStale =
    status.progressHeartbeatAgeMs !== undefined &&
    status.progressHeartbeatAgeMs > 10 * 60_000;
  if (resolveCodexGoalWorkerLiveness({ status, progressStale }).alive) {
    throw new Error("project_control_prune_worker_still_alive");
  }
}

function assertExpectedWorkspacePath(
  manifest: CodexGoalJobManifest,
  expectedWorkspacePath: string,
): void {
  if (resolve(manifest.workspacePath) !== resolve(expectedWorkspacePath)) {
    throw new Error("project_control_prune_expected_workspace_mismatch");
  }
}

async function assertWorkspaceInsideWorktreeRoots(
  workspacePath: string,
  scope: ProjectAccessScope,
): Promise<void> {
  const roots: string[] = [];
  for (const root of scope.worktreeRoots ?? []) {
    try {
      const status = await lstat(root);
      if (!status.isDirectory() || status.isSymbolicLink()) continue;
      roots.push(await realpath(root));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (
    !roots.some(
      (root) =>
        workspacePath !== root &&
        pathInsideAnyProjectRoot(workspacePath, [root]),
    )
  ) {
    throw new Error("project_control_prune_worktree_root_required");
  }
}

async function assertNoSharedWorkspaceJob(input: {
  readonly registryRootDir: string;
  readonly jobId: string;
  readonly workspacePath: string;
  readonly listJobs: typeof listCodexGoalJobs;
}): Promise<void> {
  const shared: string[] = [];
  for (const job of await input.listJobs({
    registryRootDir: input.registryRootDir,
  })) {
    if (job.jobId === input.jobId) continue;
    try {
      if ((await realpath(job.workspacePath)) === input.workspacePath) {
        shared.push(job.jobId);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (shared.length > 0) {
    throw new Error(
      `project_control_prune_shared_workspace_job:${shared.sort().join(",")}`,
    );
  }
}

async function inspectDependencyRoot(
  workspacePath: string,
  dependencyRoot: string,
): Promise<{ readonly exists: boolean }> {
  const tracked = await execGitStdout([
    "-C",
    workspacePath,
    "ls-files",
    "--",
    "node_modules",
  ]);
  if (tracked.trim().length > 0) {
    throw new Error("project_control_prune_tracked_dependency_root_denied");
  }
  const visible = await execGitStdout([
    "-C",
    workspacePath,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    "node_modules",
  ]);
  if (visible.length > 0) {
    throw new Error("project_control_prune_git_visible_dependency_root_denied");
  }
  let status;
  try {
    status = await lstat(dependencyRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("project_control_prune_dependency_root_invalid");
  }
  if ((await realpath(dependencyRoot)) !== dependencyRoot) {
    throw new Error("project_control_prune_dependency_root_escaped");
  }
  return { exists: true };
}

async function gitStatus(workspacePath: string): Promise<string> {
  return await execGitStdout([
    "-C",
    workspacePath,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
