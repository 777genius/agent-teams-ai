#!/usr/bin/env node
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  NetworkAccessMode,
  evaluateProjectAdmission,
  type ProjectControlOperationResult,
  type ActiveAttemptRegistry,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexGoalJobToArgs,
  createCodexGoalJob,
  listCodexGoalJobs,
  readCodexGoalJob,
  resolveCodexGoalJobRegistryRoot,
  summarizeCodexGoalJob,
  updateCodexGoalJob,
  type CodexGoalJobManifestInput,
  type CodexGoalJobManifestPatch,
} from "./codex-goal-jobs";
import { upsertCodexGoalLaunchManifest } from "./codex-goal-launch-manifest";
import {
  runDependencyBootstrap,
  type DependencyBootstrapMode,
  type DependencyPreflightResult,
} from "./dependency-bootstrap";
import {
  codexGoalProgressPath,
} from "./codex-goal-runner";
import {
  buildCodexGoalNoTmuxCommand,
  buildCodexGoalStopTmuxCommand,
  buildCodexGoalTmuxCommand,
  collectCodexGoalStatus,
  doctorCodexGoal,
  listCodexGoalAccountStatuses,
  prepareCodexGoalLaunchPaths,
  reconcileCodexGoalRuntimeResult,
  resolveCodexGoalWorkerLiveness,
  startCodexGoalTmux,
  stopCodexGoalTmux,
  tailCodexGoalLog,
} from "./codex-goal-ops";
import {
  optionalCodexGoalAccessBoundary,
  optionalCodexGoalNetworkAccess,
  parseCodexGoalProjectAccessScope,
} from "./codex-goal-access-plan";
import {
  projectControlGenericScopeDenial,
  projectControlGenericToolDenial,
} from "./project-control-scope-guard";
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
import {
  booleanValue,
  dateValue,
  numberValue,
  positiveIntegerValue,
  requiredRawString,
  resolvePath,
  stringValue,
  stringsFromValue,
  tagValues,
} from "./codex-goal-mcp-values";
import {
  jobIdInputSchema,
  jobRegistryInputSchema,
  registryRootFromArgs,
  type GoalMcpArgs,
  type JobBriefMcpArgs,
  type JobCreateMcpArgs,
  type JobDecisionMcpArgs,
  type JobHandoffMcpArgs,
  type JobIdMcpArgs,
  type JobLifecycleMcpArgs,
  type JobOverviewMcpArgs,
  type JobRegistryMcpArgs,
  type JobResultReconcileMcpArgs,
  type JobUpdateMcpArgs,
  type JobWatchMcpArgs,
  type StartMcpArgs,
  type WorkerControlMcpArgs,
} from "./codex-goal-mcp-inputs";
import {
  accountOperatorLabel,
  availableCodexGoalAccountSlots,
  defaultCodexGoalAuthRoot,
  dedupeCodexGoalAccountSlots,
  visibleCodexGoalAccountPoolSlots,
} from "./codex-goal-mcp-accounts";
import {
  writeCodexGoalMaintenancePauseEvent,
  writeCodexGoalStopEvent,
  writeCodexGoalStoppedProgress,
} from "./codex-goal-mcp-lifecycle-markers";
import {
  matchesProjectControlPrefix,
  pathInsideAnyProjectRoot,
  uniqueProjectControlStrings,
} from "./codex-goal-mcp-project-utils";
import {
  codexGoalStateRootDir,
} from "./codex-goal-mcp-worker-control";
import { codexGoalAccountCapacityFacts } from "./codex-goal-mcp-account-capacity-facts";
import {
  applyWorkspaceConflictToOverviewJob,
  buildCodexGoalWorkspaceConflicts,
  workspaceConflictJobIds,
} from "./codex-goal-mcp-workspace-conflicts";
import { codexOverviewItemToWatchStatus } from "./codex-goal-mcp-watch-status";
import { buildCodexGoalBrief } from "./codex-goal-mcp-brief";
import {
  jobManifestInputFromArgs,
  jobManifestPatchFromArgs,
} from "./codex-goal-mcp-manifest-args";
import {
  mcpJson,
  withMcpErrors,
} from "./codex-goal-mcp-response";
import { registerCodexGoalPrompts } from "./codex-goal-mcp-prompts";
import { registerCodexGoalProjectControlTools } from "./codex-goal-mcp-project-control-tools";
import { registerCodexGoalRunEventTools } from "./codex-goal-mcp-run-event-tools";
import { registerCodexGoalWorkerControlTools } from "./codex-goal-mcp-worker-control-tools";
import { registerCodexGoalAccountTools } from "./codex-goal-mcp-account-tools";
import { loadJobLaunch } from "./codex-goal-mcp-project-control-deps";
import {
  optionalTargetCommit,
  targetCommitFromArgs,
} from "./codex-goal-mcp-target-commit";
import {
  goalInputSchema,
  statusInputSchema,
} from "./codex-goal-mcp-input-schemas";
export { buildCodexGoalBrief } from "./codex-goal-mcp-brief";
import {
  buildCodexGoalOverviewView,
  reconcilePreviewCodexGoalJobsView,
} from "./codex-goal-mcp-overview";
import {
  codexGoalStatusInputFromLaunch as statusInput,
} from "./codex-goal-mcp-status-input";
export {
  projectControllerPendingGuidancePromptContext,
} from "./codex-goal-mcp-project-controller-provider";
import {
  continueStoredJobLifecycle,
  maintenancePauseStoredJobLifecycle,
  reconcileStoredJobRuntimeResultLifecycle,
  stopStoredJobLifecycle,
} from "./codex-goal-mcp-job-lifecycle";
import {
  goalControlModesFromRecord,
  goalLaunchInput,
} from "./codex-goal-mcp-launch-input";
import {
  codexGoalLaunchSummary as launchSummary,
} from "./codex-goal-mcp-launch-summary";
import {
  CODEX_GOAL_CONTROL_SURFACE_SCHEMA,
  buildCodexGoalDecision,
  buildCodexGoalHandoff,
  isSafeStartAction,
  nextActionForStatus,
  redactText,
  truncateText,
} from "./codex-goal-mcp-decision";
import {
  assertSafeGitCommitSha,
  assertSafeGitRefName,
  assertSafeGitRemoteName,
} from "./codex-goal-mcp-project-git";
export {
  availableCodexGoalAccountSlots,
  dedupeCodexGoalAccountSlots,
  visibleCodexGoalAccountPoolSlots,
} from "./codex-goal-mcp-accounts";

const serverVersion = "0.1.0-main.2";

type JsonObject = Readonly<Record<string, unknown>>;

export type CodexGoalMcpServerOptions = {
  readonly activeAttemptRegistry?: ActiveAttemptRegistry;
};

export function createCodexGoalMcpServer(
  options: CodexGoalMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: "subscription-runtime-codex-goal",
    version: serverVersion,
  });

  server.registerResource(
    "codex-goal-job",
    new ResourceTemplate("codex-goal://jobs/{jobId}", {
      list: async () => {
        const registryRootDir = resolveCodexGoalJobRegistryRoot();
        const jobs = await listCodexGoalJobs({ registryRootDir });
        return {
          resources: jobs.map((job) => ({
            uri: `codex-goal://jobs/${job.jobId}`,
            name: job.jobId,
            description: job.description ?? job.workspacePath,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Codex Goal Job",
      description: "A stored Codex goal job manifest.",
      mimeType: "application/json",
    },
    async (uri, { jobId }) => {
      const registryRootDir = resolveCodexGoalJobRegistryRoot();
      const manifest = await readCodexGoalJob({
        registryRootDir,
        jobId: String(jobId),
      });
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({
            manifest,
            summary: summarizeCodexGoalJob(manifest, registryRootDir),
          }, null, 2),
        }],
      };
    },
  );

  registerCodexGoalPrompts(server);

  server.registerTool(
    "codex_goal_list_jobs",
    {
      title: "List Codex Goal Jobs",
      description: "List stored Codex goal job manifests.",
      inputSchema: jobRegistryInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const registryRootDir = registryRootFromArgs(args as JobRegistryMcpArgs);
      const jobs = await listCodexGoalJobs({ registryRootDir });
      return mcpJson({ ok: true, registryRootDir, jobs });
    }),
  );

  server.registerTool(
    "codex_goal_overview",
    {
      title: "Codex Goal Overview",
      description:
        "Summarize all stored Codex goal jobs with compact status, account and next-action hints.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        staleAfterMs: z.number().int().positive().optional(),
        tailLines: z.number().int().positive().optional(),
        limit: z.number().int().positive().optional(),
        jobIdPrefix: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const overview = await buildCodexGoalOverview(args as JobOverviewMcpArgs);
      return mcpJson(overview);
    }),
  );

  server.registerTool(
    "codex_goal_reconcile_preview",
    {
      title: "Codex Goal Reconcile Preview",
      description:
        "Run one safe reconciliation-preview pass over stored jobs. Dry-run by default; continues only when continueSafeJobs is true and each job is safe. This is not pure watch.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        staleAfterMs: z.number().int().positive().optional(),
        tailLines: z.number().int().positive().optional(),
        jobIds: z.union([z.string(), z.array(z.string())]).optional(),
        continueSafeJobs: z.boolean().optional(),
        maxContinuesPerRun: z.number().int().positive().optional(),
        skipDoctor: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const watch = await reconcilePreviewCodexGoalJobs(args as JobWatchMcpArgs);
      return mcpJson(watch);
    }),
  );

  registerCodexGoalRunEventTools(server);

  server.registerTool(
    "codex_goal_get_job",
    {
      title: "Get Codex Goal Job",
      description: "Read one Codex goal job manifest by jobId.",
      inputSchema: jobIdInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const registryRootDir = registryRootFromArgs(args as JobIdMcpArgs);
      const manifest = await readCodexGoalJob({
        registryRootDir,
        jobId: requiredRawString(args.jobId, "jobId"),
      });
      return mcpJson({
        ok: true,
        registryRootDir,
        manifest,
        summary: summarizeCodexGoalJob(manifest, registryRootDir),
      });
    }),
  );

  server.registerTool(
    "codex_goal_create_job",
    {
      title: "Create Codex Goal Job",
      description:
        "Create a versioned job.json manifest so future tools can operate by jobId.",
      inputSchema: {
        ...goalInputSchema(),
        ...jobIdInputSchema(),
        description: z.string().optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional(),
        overwrite: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const registryRootDir = registryRootFromArgs(args as JobCreateMcpArgs);
      const createManifest = jobManifestInputFromArgs(args as JobCreateMcpArgs);
      const projectControlDenial = await projectControlGenericScopeDenial({
        registryRootDir,
        jobId: createManifest.jobId,
        workspacePath: createManifest.workspacePath,
        accessBoundary: createManifest.accessBoundary,
        projectAccessScope: createManifest.projectAccessScope,
        requiredTool: "codex_goal_project_create_job",
        allowProjectScopedControlBootstrap: true,
        skipDirectProjectManifestDenial: true,
      });
      if (projectControlDenial) return mcpJson(projectControlDenial);
      const manifest = await createCodexGoalJob({
        registryRootDir,
        manifest: createManifest,
        overwrite: booleanValue(args.overwrite) ?? false,
      });
      return mcpJson({
        ok: true,
        registryRootDir,
        manifest,
        summary: summarizeCodexGoalJob(manifest, registryRootDir),
      });
    }),
  );

  server.registerTool(
    "codex_goal_update_job",
    {
      title: "Update Codex Goal Job",
      description: "Patch an existing job.json manifest by jobId.",
      inputSchema: {
        ...goalInputSchema(),
        ...jobIdInputSchema(),
        description: z.string().optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const updateArgs = args as JobUpdateMcpArgs;
      const registryRootDir = registryRootFromArgs(updateArgs);
      const existing = await readCodexGoalJob({
        registryRootDir,
        jobId: requiredRawString(updateArgs.jobId, "jobId"),
      });
      const patch = jobManifestPatchFromArgs(updateArgs);
      const projectControlDenial = projectControlGenericToolDenial({
        accessBoundary: existing.accessBoundary ?? patch.accessBoundary,
        projectAccessScope: existing.projectAccessScope ?? patch.projectAccessScope,
        jobId: existing.jobId,
        requiredTool: "brokered_project_manifest_repair",
      }) ?? await projectControlGenericScopeDenial({
        registryRootDir,
        jobId: existing.jobId,
        workspacePath: stringValue(patch.workspacePath) ?? existing.workspacePath,
        requiredTool: "brokered_project_manifest_repair",
      });
      if (projectControlDenial) return mcpJson(projectControlDenial);
      const manifest = await updateCodexGoalJob({
        registryRootDir,
        jobId: existing.jobId,
        patch,
      });
      return mcpJson({
        ok: true,
        registryRootDir,
        manifest,
        summary: summarizeCodexGoalJob(manifest, registryRootDir),
      });
    }),
  );

  server.registerTool(
    "codex_goal_status_by_id",
    {
      title: "Codex Goal Status By Job",
      description: "Inspect a stored Codex goal job using only jobId.",
      inputSchema: jobIdInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const registryRootDir = registryRootFromArgs(args as JobIdMcpArgs);
      const manifest = await readCodexGoalJob({
        registryRootDir,
        jobId: requiredRawString(args.jobId, "jobId"),
      });
      const launch = await goalLaunchInput(codexGoalJobToArgs(manifest));
      const status = await collectCodexGoalStatus(statusInput(launch));
      return mcpJson({
        ok: true,
        registryRootDir,
        jobId: manifest.jobId,
        status,
        summary: summarizeCodexGoalJob(manifest, registryRootDir),
      });
    }),
  );

  server.registerTool(
    "codex_goal_recommend_next_action",
    {
      title: "Recommend Codex Goal Action",
      description: "Return the next safe lifecycle action for a stored job.",
      inputSchema: jobIdInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as JobIdMcpArgs);
      const status = await collectCodexGoalStatus(statusInput(loaded.launch));
      return mcpJson({
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        status,
        next: nextActionForStatus(status.recommendedAction),
        summary: summarizeCodexGoalJob(loaded.manifest, loaded.registryRootDir),
      });
    }),
  );

  server.registerTool(
    "codex_goal_assert_single_writer",
    {
      title: "Assert Single Codex Writer",
      description:
        "Check whether starting another writer for this job would be safe.",
      inputSchema: jobIdInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as JobIdMcpArgs);
      const status = await collectCodexGoalStatus(statusInput(loaded.launch));
      const progressStale = status.progressHeartbeatAgeMs !== undefined &&
        status.progressHeartbeatAgeMs >
          (numberValue((args as Record<string, unknown>).staleAfterMs) ?? 10 * 60_000);
      const workerLiveness = resolveCodexGoalWorkerLiveness({
        status,
        progressStale,
      });
      const ok = !workerLiveness.alive && status.recommendedAction !== "wait_for_worker";
      return mcpJson({
        ok,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        status,
        safeToStart: isSafeStartAction(status.recommendedAction),
        safeMessage: ok
          ? "No active tmux writer was found for this job."
          : "A writer appears to be active; do not start another writer in this worktree.",
      });
    }),
  );

  server.registerTool(
    "codex_goal_reconcile_result",
    {
      title: "Reconcile Codex Goal Runtime Result",
      description:
        "Write a strict latest-result.json for a stopped or stale Codex goal when the worker crashed, was stopped, or left a non-strict result.",
      inputSchema: {
        ...jobIdInputSchema(),
        forceWrite: z.boolean().optional(),
        preservePatch: z.boolean().optional(),
        staleAfterMs: z.number().int().positive().optional(),
        tailLines: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      reconcileStoredJobRuntimeResult(args as JobResultReconcileMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_continue",
    {
      title: "Continue Codex Goal",
      description:
        "Safely continue a stored job by jobId when status allows continuation.",
      inputSchema: {
        ...jobIdInputSchema(),
        confirmContinue: z.boolean().optional(),
        skipDoctor: z.boolean().optional(),
        forceStart: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      continueStoredJob(args as JobLifecycleMcpArgs, {
        confirmKey: "confirmContinue",
        mode: "continue",
      }),
    ),
  );

  server.registerTool(
    "codex_goal_recover",
    {
      title: "Recover Codex Goal",
      description:
        "Recover a stored job after quota, auth, reconnect or timeout status.",
      inputSchema: {
        ...jobIdInputSchema(),
        confirmRecover: z.boolean().optional(),
        skipDoctor: z.boolean().optional(),
        forceStart: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      continueStoredJob(args as JobLifecycleMcpArgs, {
        confirmKey: "confirmRecover",
        mode: "recover",
      }),
    ),
  );

  server.registerTool(
    "codex_goal_stop",
    {
      title: "Stop Codex Goal Worker",
      description:
        "Stop a stored job's tmux worker after explicit confirmation. Default guard allows silent-stale workers only.",
      inputSchema: {
        ...jobIdInputSchema(),
        confirmStop: z.boolean().optional(),
        forceStop: z.boolean().optional(),
        staleAfterMs: z.number().int().positive().optional(),
        tailLines: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () => stopStoredJob(args as JobLifecycleMcpArgs)),
  );

  server.registerTool(
    "codex_goal_maintenance_pause",
    {
      title: "Maintenance Pause Codex Goal Worker",
      description:
        "Stop a stored job's tmux worker for planned maintenance without reconciling it as a runtime failure.",
      inputSchema: {
        ...jobIdInputSchema(),
        confirmPause: z.boolean().optional(),
        forcePause: z.boolean().optional(),
        reason: z.string().optional(),
        staleAfterMs: z.number().int().positive().optional(),
        tailLines: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      maintenancePauseStoredJob(args as JobLifecycleMcpArgs),
    ),
  );

  registerCodexGoalWorkerControlTools(server, options);

  server.registerTool(
    "codex_goal_mark_reviewed",
    {
      title: "Mark Codex Goal Reviewed",
      description:
        "Write a local review marker after a human or orchestrator has inspected the result.",
      inputSchema: {
        ...jobIdInputSchema(),
        note: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as JobIdMcpArgs);
      const projectControlDenial = projectControlGenericToolDenial({
        accessBoundary: loaded.manifest.accessBoundary,
        projectAccessScope: loaded.manifest.projectAccessScope,
        jobId: loaded.manifest.jobId,
        requiredTool: "codex_goal_project_mark_reviewed",
      }) ?? await projectControlGenericScopeDenial({
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        workspacePath: loaded.launch.config.workspacePath,
        requiredTool: "codex_goal_project_mark_reviewed",
      });
      if (projectControlDenial) return mcpJson(projectControlDenial);
      await mkdir(loaded.launch.config.jobRootDir, { recursive: true, mode: 0o700 });
      const reviewPath = join(
        loaded.launch.config.jobRootDir,
        `${loaded.launch.config.taskId}.review.json`,
      );
      const status = await collectCodexGoalStatus(statusInput(loaded.launch));
      await writeFile(
        reviewPath,
        `${JSON.stringify({
          schemaVersion: 1,
          jobId: loaded.manifest.jobId,
          taskId: loaded.launch.config.taskId,
          reviewedAt: new Date().toISOString(),
          note: stringValue(args.note) ?? "reviewed",
          status,
        }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      return mcpJson({ ok: true, jobId: loaded.manifest.jobId, reviewPath, status });
    }),
  );

  server.registerTool(
    "codex_goal_brief",
    {
      title: "Codex Goal Brief",
      description: "Return a compact agent-friendly status summary by jobId.",
      inputSchema: {
        ...jobIdInputSchema(),
        staleAfterMs: z.number().int().positive().optional(),
        tailLines: z.number().int().positive().optional(),
        targetCommit: z.string().optional(),
        targetWorkspacePath: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const briefArgs = args as JobBriefMcpArgs;
      const loaded = await loadJobLaunch(args as JobBriefMcpArgs);
      const status = await collectCodexGoalStatus(statusInput(loaded.launch));
      const accounts = await listCodexGoalAccountStatuses({
        authRootDir: loaded.launch.config.authRootDir,
        accounts: loaded.launch.config.accounts.map((account) => account.name),
        stateRootDir: loaded.launch.config.stateRootDir ??
          join(loaded.launch.config.jobRootDir, "state"),
      });
      const brief = await buildCodexGoalBrief({
        jobId: loaded.manifest.jobId,
        launch: loaded.launch,
        status,
        accounts,
        staleAfterMs: numberValue(briefArgs.staleAfterMs) ?? 10 * 60_000,
        tailLines: numberValue(briefArgs.tailLines) ?? 20,
        ...optionalTargetCommit(await targetCommitFromArgs(briefArgs)),
      });
      return mcpJson({
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        brief,
        status,
      });
    }),
  );

  server.registerTool(
    "codex_goal_decision",
    {
      title: "Codex Goal Decision",
      description:
        "Return a conservative agent decision report with blockers, evidence and exact next command.",
      inputSchema: {
        ...jobIdInputSchema(),
        staleAfterMs: z.number().int().positive().optional(),
        tailLines: z.number().int().positive().optional(),
        targetCommit: z.string().optional(),
        targetWorkspacePath: z.string().optional(),
        includeRegistryConflicts: z.boolean().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        registryRootDir: z.string(),
        jobId: z.string(),
        decision: z.object({
          controlSurface: CODEX_GOAL_CONTROL_SURFACE_SCHEMA,
        }).passthrough(),
        status: z.unknown().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const decisionArgs = args as JobDecisionMcpArgs;
      const loaded = await loadJobLaunch(decisionArgs);
      const status = await collectCodexGoalStatus(statusInput(loaded.launch));
      const accounts = await listCodexGoalAccountStatuses({
        authRootDir: loaded.launch.config.authRootDir,
        accounts: loaded.launch.config.accounts.map((account) => account.name),
        stateRootDir: codexGoalStateRootDir(loaded.launch),
      });
      const staleAfterMs = numberValue(decisionArgs.staleAfterMs) ?? 10 * 60_000;
      const tailLines = numberValue(decisionArgs.tailLines) ?? 20;
      const brief = await buildCodexGoalBrief({
        jobId: loaded.manifest.jobId,
        launch: loaded.launch,
        status,
        accounts,
        staleAfterMs,
        tailLines,
        ...optionalTargetCommit(await targetCommitFromArgs(decisionArgs)),
      });
      const overview = booleanValue(decisionArgs.includeRegistryConflicts) === false
        ? undefined
        : await buildCodexGoalOverview({
            registryRootDir: loaded.registryRootDir,
            staleAfterMs,
            tailLines: Math.min(tailLines, 5),
          });
      const decision = buildCodexGoalDecision({
        registryRootDir: loaded.registryRootDir,
        manifest: loaded.manifest,
        launch: loaded.launch,
        status,
        accounts,
        brief,
        ...(overview ? { overview } : {}),
      });
      return mcpJson({
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        decision,
        brief,
        status,
      });
    }),
  );

  server.registerTool(
    "codex_goal_handoff",
    {
      title: "Codex Goal Handoff",
      description:
        "Build a copy-paste safe handoff bundle for another agent by jobId.",
      inputSchema: {
        ...jobIdInputSchema(),
        staleAfterMs: z.number().int().positive().optional(),
        tailLines: z.number().int().positive().optional(),
        targetCommit: z.string().optional(),
        targetWorkspacePath: z.string().optional(),
        includeCliFallback: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as JobHandoffMcpArgs);
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
        staleAfterMs: numberValue((args as JobHandoffMcpArgs).staleAfterMs) ?? 10 * 60_000,
        tailLines: numberValue((args as JobHandoffMcpArgs).tailLines) ?? 20,
        ...optionalTargetCommit(await targetCommitFromArgs(args as JobHandoffMcpArgs)),
      });
      const handoff = buildCodexGoalHandoff({
        registryRootDir: loaded.registryRootDir,
        manifest: loaded.manifest,
        launch: loaded.launch,
        brief,
        status,
        accounts,
        includeCliFallback:
          booleanValue((args as JobHandoffMcpArgs).includeCliFallback) ?? true,
      });
      return mcpJson({
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        handoff,
        brief,
        status,
      });
    }),
  );

  registerCodexGoalAccountTools(server);

  server.registerTool(
    "codex_goal_dry_run",
    {
      title: "Codex Goal Dry Run",
      description:
        "Build the exact Codex goal worker command without starting a worker.",
      inputSchema: goalInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const launch = await goalLaunchInput(args as GoalMcpArgs);
      const noTmuxCommand = buildCodexGoalNoTmuxCommand(launch);
      const tmuxCommand = launch.tmuxSession
        ? buildCodexGoalTmuxCommand(launch)
        : undefined;
      return mcpJson({
        ok: true,
        taskId: launch.config.taskId,
        noTmuxCommand,
        ...(tmuxCommand ? { tmuxCommand: tmuxCommand.preview } : {}),
        summary: launchSummary(launch),
      });
    }),
  );

  server.registerTool(
    "codex_goal_start",
    {
      title: "Start Codex Goal Worker",
      description:
        "Start a detached tmux Codex goal worker after explicit confirmation.",
      inputSchema: {
        ...goalInputSchema(),
        registryRootDir: z.string().optional(),
        confirmStart: z.boolean().optional(),
        skipDoctor: z.boolean().optional(),
        forceStart: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const launch = await goalLaunchInput(args as StartMcpArgs);
      const projectControlDenial = projectControlGenericToolDenial({
        accessBoundary: launch.config.accessBoundary,
        projectAccessScope: launch.config.projectAccessScope,
      }) ?? await projectControlGenericScopeDenial({
        registryRootDir: registryRootFromArgs(args as StartMcpArgs),
        jobId: launch.config.jobId ?? launch.config.taskId,
        workspacePath: launch.config.workspacePath,
        requiredTool: "codex_goal_project_start",
      });
      if (projectControlDenial) return mcpJson(projectControlDenial);
      if (!launch.tmuxSession) {
        return mcpJson({
          ok: false,
          reason: "tmux_session_required",
          noTmuxCommand: buildCodexGoalNoTmuxCommand(launch),
        });
      }
      if ((args as StartMcpArgs).confirmStart) {
        await prepareCodexGoalLaunchPaths(launch);
      }
      const statusBefore = await collectCodexGoalStatus(statusInput(launch));
      if (statusBefore.tmuxAlive) {
        return mcpJson({
          ok: false,
          reason: "worker_already_running",
          status: statusBefore,
        });
      }
      if (
        !isSafeStartAction(statusBefore.recommendedAction) &&
        !(args as StartMcpArgs).forceStart
      ) {
        return mcpJson({
          ok: false,
          reason: "status_requires_review",
          status: statusBefore,
          requiredOverride: "forceStart",
        });
      }
      if (!(args as StartMcpArgs).confirmStart) {
        return mcpJson({
          ok: false,
          reason: "confirm_start_required",
          tmuxCommand: buildCodexGoalTmuxCommand(launch).preview,
          summary: launchSummary(launch),
        });
      }
      const registryRootDir = registryRootFromArgs(args as StartMcpArgs);
      const manifest = await upsertCodexGoalLaunchManifest({
        registryRootDir,
        launch,
      });
      if (!(args as StartMcpArgs).skipDoctor) {
        const doctor = await doctorCodexGoal({
          config: launch.config,
          tmuxSession: launch.tmuxSession,
        });
        if (!doctor.ok) {
          return mcpJson({
            ok: false,
            reason: "doctor_failed",
            doctor,
          });
        }
      }
      const command = await startCodexGoalTmux(launch);
      return mcpJson({
        ok: true,
        registryRootDir,
        jobId: manifest.jobId,
        taskId: launch.config.taskId,
        tmuxSession: launch.tmuxSession,
        tmuxCommand: command.preview,
        manifest,
        summary: launchSummary(launch),
      });
    }),
  );

  registerCodexGoalProjectControlTools(server);

  server.registerTool(
    "codex_goal_status",
    {
      title: "Codex Goal Status",
      description:
        "Inspect tmux, result JSON, log freshness and workspace dirtiness.",
      inputSchema: statusInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const cwd = resolvePath(
        process.cwd(),
        stringValue(args.cwd) ?? process.cwd(),
      );
      return mcpJson(await collectCodexGoalStatus({
        ...(stringValue(args.jobRootDir)
          ? { jobRootDir: resolvePath(cwd, stringValue(args.jobRootDir) as string) }
          : {}),
        ...(stringValue(args.taskId)
          ? { taskId: stringValue(args.taskId) as string }
          : {}),
        ...(stringValue(args.workspacePath)
          ? { workspacePath: resolvePath(cwd, stringValue(args.workspacePath) as string) }
          : {}),
        ...(stringValue(args.tmuxSession)
          ? { tmuxSession: stringValue(args.tmuxSession) as string }
          : {}),
        ...(stringValue(args.logPath)
          ? { logPath: resolvePath(cwd, stringValue(args.logPath) as string) }
          : {}),
        ...(stringValue(args.progressPath)
          ? { progressPath: resolvePath(cwd, stringValue(args.progressPath) as string) }
          : {}),
      }));
    }),
  );

  server.registerTool(
    "codex_goal_doctor",
    {
      title: "Codex Goal Doctor",
      description:
        "Validate prompt, job root, auth root, workspace and account auth files.",
      inputSchema: goalInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const launch = await goalLaunchInput(args as GoalMcpArgs);
      return mcpJson(await doctorCodexGoal({
        config: launch.config,
        ...(launch.tmuxSession ? { tmuxSession: launch.tmuxSession } : {}),
      }));
    }),
  );

  server.registerTool(
    "codex_goal_tail",
    {
      title: "Codex Goal Tail",
      description: "Read the last lines from a Codex goal worker log.",
      inputSchema: {
        jobRootDir: z.string().optional(),
        taskId: z.string().optional(),
        logPath: z.string().optional(),
        cwd: z.string().optional(),
        lines: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const cwd = resolvePath(
        process.cwd(),
        stringValue(args.cwd) ?? process.cwd(),
      );
      const logPath = stringValue(args.logPath) ??
        (stringValue(args.jobRootDir) && stringValue(args.taskId)
          ? join(
              resolvePath(cwd, stringValue(args.jobRootDir) as string),
              `${stringValue(args.taskId) as string}.log`,
            )
          : undefined);
      if (!logPath) throw new Error("logPath or jobRootDir with taskId is required");
      const resolvedLogPath = resolvePath(cwd, logPath);
      const text = await tailCodexGoalLog(
        resolvedLogPath,
        numberValue(args.lines) ?? 100,
      );
      return mcpJson({ ok: true, logPath: resolvedLogPath, text });
    }),
  );

  return server;
}

async function continueStoredJob(
  args: JobLifecycleMcpArgs,
  options: {
    readonly mode: "continue" | "recover";
    readonly confirmKey: "confirmContinue" | "confirmRecover";
  },
) {
  return mcpJson(await continueStoredJobLifecycle(args, options, { loadJobLaunch }));
}

async function reconcileStoredJobRuntimeResult(args: JobResultReconcileMcpArgs) {
  return mcpJson(await reconcileStoredJobRuntimeResultLifecycle(args, { loadJobLaunch }));
}

async function stopStoredJob(args: JobLifecycleMcpArgs) {
  return mcpJson(await stopStoredJobLifecycle(args, { loadJobLaunch }));
}

async function maintenancePauseStoredJob(args: JobLifecycleMcpArgs) {
  return mcpJson(await maintenancePauseStoredJobLifecycle(args, { loadJobLaunch }));
}

async function buildCodexGoalOverview(args: JobOverviewMcpArgs): Promise<JsonObject> {
  return buildCodexGoalOverviewView(args);
}

function codexGoalOverviewDeps() {
  return {
    continueStoredJob: async (
      args: JobLifecycleMcpArgs,
      options: {
        readonly mode: "continue" | "recover";
        readonly confirmKey: "confirmContinue" | "confirmRecover";
      },
    ) => {
      const response = await continueStoredJob(args, options);
      return response.structuredContent as JsonObject;
    },
  };
}

async function reconcilePreviewCodexGoalJobs(args: JobWatchMcpArgs): Promise<JsonObject> {
  return reconcilePreviewCodexGoalJobsView(args, codexGoalOverviewDeps());
}

if (await isMainModule()) {
  try {
    const server = createCodexGoalMcpServer();
    await server.connect(new StdioServerTransport());
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "codex goal mcp failed"}\n`,
    );
    process.exitCode = 1;
  }
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;
  try {
    return (await realpath(fileURLToPath(import.meta.url))) ===
      (await realpath(process.argv[1]));
  } catch {
    return fileURLToPath(import.meta.url) === process.argv[1];
  }
}
