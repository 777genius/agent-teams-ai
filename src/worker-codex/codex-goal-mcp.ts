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
  AccessBoundary,
  NetworkAccessMode,
  ProjectAdmissionWorkerRole,
  InterruptAndContinueWorkerUseCase,
  RunEventProviderKind,
  evaluateProjectAdmission,
  reconcileRunPreview,
  ProjectOperation,
  type ProjectAccessScope,
  type ProjectControlBroker,
  type ProjectControlOperationResult,
  type RunReconcilePreviewDecision,
  type ActiveAttemptRegistry,
  type WorkerControlActor,
  type WorkerControlDeliveryMode,
  type WorkerControlIntent,
  type WorkerControlPriority,
  type ControlledAgentSession,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexGoalJobToArgs,
  createCodexGoalJob,
  listCodexGoalJobs,
  readCodexGoalJob,
  resolveCodexGoalJobRegistryRoot,
  summarizeCodexGoalJob,
  updateCodexGoalJob,
  type CodexGoalJobManifest,
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
  type CodexGoalLaunchInput,
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
  registerProjectIntegrationMcpTools,
  type ProjectIntegrationMcpArgs,
} from "./project-integration-mcp";
import {
  createLocalProjectIntegrationMcpToolHandlers,
} from "./project-integration-mcp/adapters/local-project-integration-mcp-tool-handlers";
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
  accountNames,
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
  type AccountPoolMcpArgs,
  type AgentRunEventCompactionMcpArgs,
  type AgentRunEventsMcpArgs,
  type AgentRunProjectEventsMcpArgs,
  type AgentRunStateMcpArgs,
  type AgentRunWatchMcpArgs,
  type GoalMcpArgs,
  type JobAccountPoolMcpArgs,
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
  type ProjectControllerLaunchPlanMcpArgs,
  type ProjectControlMcpArgs,
  type StartMcpArgs,
  type WorkerControlMcpArgs,
} from "./codex-goal-mcp-inputs";
import {
  accountOperatorLabel,
  accountAuthRootFromArgs,
  accountPoolRootFromArgs,
  availableCodexGoalAccountSlots,
  codexAccountReloginInstructions,
  codexAccountStatusPayload,
  defaultCodexGoalAuthRoot,
  dedupeCodexGoalAccountSlots,
  listAccountPools,
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
  projectControlDefaultAccountNames,
  projectControlRefillAccountNames,
} from "./codex-goal-mcp-project-accounts";
import {
  buildCodexProjectAdmissionSnapshot,
  codexProjectAdmissionGate,
  optionalRealPathForAdmission,
  projectAdmissionDetailView,
  projectAdmissionOperation,
  projectAdmissionWorkerRoleArg,
  type CodexProjectAdmissionDeps,
} from "./codex-goal-mcp-project-admission";
import {
  jobIdsFromValue,
  parseIsoDate,
  signalIdList,
  workerControlCallerArgs,
  workerControlDecisionJson,
  workerControlReceiptJson,
  workerControlSignalJson,
  workerControlSignalViewJson,
} from "./codex-goal-mcp-worker-control-view";
import {
  codexGoalAccountStatusPayload,
  codexGoalStateRootDir,
  codexGoalWorkerControlService,
  codexGoalWorkerControlTarget,
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
import {
  optionalTargetCommit,
  targetCommitFromArgs,
} from "./codex-goal-mcp-target-commit";
import {
  goalInputSchema,
  statusInputSchema,
} from "./codex-goal-mcp-input-schemas";
export { buildCodexGoalBrief } from "./codex-goal-mcp-brief";
import { buildCodexGoalOverviewItem } from "./codex-goal-mcp-overview-item";
import {
  codexGoalStatusInputFromLaunch as statusInput,
} from "./codex-goal-mcp-status-input";
import {
  createCodexProjectControlBroker,
  noopOperationResult,
  projectControlAuditPath,
  type CodexGoalProjectCreateWorktreeInput,
  type CodexGoalProjectIntegrateCommitInput,
  type CodexGoalProjectPushBranchInput,
  type CodexProjectControlBrokerInput,
} from "./codex-goal-mcp-project-broker";
import {
  assertReadablePrompt,
  createOrReuseProjectJob,
  createOrReuseProjectWorktree,
  readTextFileIfExists,
  rollbackProjectRefillPartial,
} from "./codex-goal-mcp-project-refill";
import {
  projectControllerConsumeGuidanceView,
  projectControllerLaunchPlanView,
  projectControllerReconcileView,
  projectControllerStartView,
  projectControllerStatusView,
  projectControllerStopView,
} from "./codex-goal-mcp-project-controller";
export {
  projectControllerPendingGuidancePromptContext,
} from "./codex-goal-mcp-project-controller-provider";
import {
  compactAgentRunEvents,
  planAgentRunEventCompaction,
  projectAgentRunEvents,
  readAgentRunEvents,
  readAgentRunState,
  watchAgentRuns,
} from "./codex-goal-mcp-run-events";
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
import {
  assertProjectControlCreateManifestPaths,
  assertProjectControlDependencyBootstrapReady,
  assertProjectControlScopeRepairAllowed,
  projectControlChildScope,
  projectControlDependencyBootstrapMode,
  projectControlPathArg,
  projectControlRealPathOutsideWorkspaceScope,
  projectControlWorkerRole,
  projectScopeFieldFingerprint,
} from "./codex-goal-mcp-project-scope";
import {
  projectIntegrationPushApprovedCommitWithConsumedLedger,
} from "./codex-goal-mcp-project-integration-ledger";
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

  const agentRunWatchTool = {
    title: "Agent Run Watch",
    description:
      "Read-only provider-neutral run observation. Reports status, liveness, progress, logs, workspace changes, capacity hints and read-only recommendations without starting, stopping or continuing workers.",
    inputSchema: {
      ...jobRegistryInputSchema(),
      providerKind: z.string().optional(),
      jobId: z.string().optional(),
      jobIds: z.union([z.string(), z.array(z.string())]).optional(),
      stateRootDir: z.string().optional(),
      runArtifactsRootDir: z.string().optional(),
      staleAfterMs: z.number().int().positive().optional(),
      tailLines: z.number().int().positive().optional(),
      limit: z.number().int().positive().optional(),
      includeChangedFiles: z.boolean().optional(),
      includeLogTail: z.boolean().optional(),
    },
  };

  server.registerTool(
    "agent_run_watch",
    agentRunWatchTool,
    async (args) => withMcpErrors(async () => {
      const watch = await watchAgentRuns(args as AgentRunWatchMcpArgs);
      return mcpJson(watch);
    }),
  );

  server.registerTool(
    "codex_goal_run_watch",
    {
      ...agentRunWatchTool,
      title: "Codex Goal Run Watch",
      description:
        "Codex-scoped read-only run observation. Reports status, liveness, progress, logs, workspace changes, capacity hints and read-only recommendations without starting, stopping or continuing workers.",
    },
    async (args) => withMcpErrors(async () => {
      const watch = await watchAgentRuns(args as AgentRunWatchMcpArgs);
      return mcpJson(watch);
    }),
  );

  const agentRunEventsTool = {
    title: "Agent Run Events",
    description:
      "Read normalized durable run events from the local outbox. This is read-only and does not observe, start, stop, continue or recover workers.",
    inputSchema: {
      ...jobRegistryInputSchema(),
      providerKind: z.string().optional(),
      jobId: z.string().optional(),
      eventRootDir: z.string().optional(),
      cursor: z.string().optional(),
      type: z.union([z.string(), z.array(z.string())]).optional(),
      types: z.union([z.string(), z.array(z.string())]).optional(),
      limit: z.number().int().positive().optional(),
    },
  };

  server.registerTool(
    "agent_run_events",
    agentRunEventsTool,
    async (args) => withMcpErrors(async () => {
      const events = await readAgentRunEvents(args as AgentRunEventsMcpArgs);
      return mcpJson(events);
    }),
  );

  server.registerTool(
    "codex_goal_events",
    {
      ...agentRunEventsTool,
      title: "Codex Goal Events",
      description:
        "Read normalized durable Codex goal run events from the local outbox. This is read-only and does not observe, start, stop, continue or recover workers.",
    },
    async (args) => withMcpErrors(async () => {
      const events = await readAgentRunEvents({
        ...(args as AgentRunEventsMcpArgs),
        providerKind: "codex",
      });
      return mcpJson(events);
    }),
  );

  const agentRunStateTool = {
    title: "Agent Run State",
    description:
      "Read projected run read-model state from the local event projection store. This is read-only and does not observe, start, stop, continue or recover workers.",
    inputSchema: {
      ...jobRegistryInputSchema(),
      providerKind: z.string().optional(),
      jobId: z.string(),
      eventRootDir: z.string().optional(),
    },
  };

  server.registerTool(
    "agent_run_state",
    agentRunStateTool,
    async (args) => withMcpErrors(async () => {
      const state = await readAgentRunState(args as AgentRunStateMcpArgs);
      return mcpJson(state);
    }),
  );

  server.registerTool(
    "codex_goal_state",
    {
      ...agentRunStateTool,
      title: "Codex Goal State",
      description:
        "Read projected Codex goal run read-model state from the local event projection store. This is read-only and does not observe, start, stop, continue or recover workers.",
    },
    async (args) => withMcpErrors(async () => {
      const state = await readAgentRunState({
        ...(args as AgentRunStateMcpArgs),
        providerKind: "codex",
      });
      return mcpJson(state);
    }),
  );

  const agentRunEventCompactionTool = {
    title: "Agent Run Event Compaction",
    description:
      "Plan or run explicit local RunEvent JSONL compaction. This touches only the event outbox and delivery cursors; it does not observe, start, stop, continue or recover workers.",
    inputSchema: {
      ...jobRegistryInputSchema(),
      eventRootDir: z.string().optional(),
      keepEventsAfter: z.string().optional(),
      keepLatestEventsPerRun: z.number().int().positive().optional(),
      compactDeliveredEvents: z.boolean().optional(),
      dropInvalidLines: z.boolean().optional(),
      safetyMode: z.string().optional(),
      confirmCompact: z.boolean().optional(),
    },
  };

  server.registerTool(
    "agent_run_event_compaction_plan",
    {
      ...agentRunEventCompactionTool,
      title: "Agent Run Event Compaction Plan",
      description:
        "Read-only plan for local RunEvent JSONL compaction. No files are rewritten.",
    },
    async (args) => withMcpErrors(async () => {
      const plan = await planAgentRunEventCompaction(
        args as AgentRunEventCompactionMcpArgs,
      );
      return mcpJson(plan);
    }),
  );

  server.registerTool(
    "agent_run_event_compact",
    {
      ...agentRunEventCompactionTool,
      title: "Agent Run Event Compact",
      description:
        "Run explicit local RunEvent JSONL compaction. Requires confirmCompact=true and never controls workers.",
    },
    async (args) => withMcpErrors(async () => {
      const result = await compactAgentRunEvents(
        args as AgentRunEventCompactionMcpArgs,
      );
      return mcpJson(result);
    }),
  );

  const agentRunProjectEventsTool = {
    title: "Agent Run Project Events",
    description:
      "Observe runs and project normalized durable RunEvent records into the local outbox. This writes event/projection state only; it does not start, stop, continue or recover workers.",
    inputSchema: {
      ...agentRunWatchTool.inputSchema,
      eventRootDir: z.string().optional(),
      hostId: z.string().optional(),
      type: z.union([z.string(), z.array(z.string())]).optional(),
      types: z.union([z.string(), z.array(z.string())]).optional(),
    },
  };

  server.registerTool(
    "agent_run_project_events",
    agentRunProjectEventsTool,
    async (args) => withMcpErrors(async () => {
      const projected = await projectAgentRunEvents(args as AgentRunProjectEventsMcpArgs);
      return mcpJson(projected);
    }),
  );

  server.registerTool(
    "codex_goal_project_events",
    {
      ...agentRunProjectEventsTool,
      title: "Codex Goal Project Events",
      description:
        "Observe Codex goal runs and project normalized durable RunEvent records into the local outbox. This writes event/projection state only; it does not start, stop, continue or recover workers.",
    },
    async (args) => withMcpErrors(async () => {
      const projected = await projectAgentRunEvents({
        ...(args as AgentRunProjectEventsMcpArgs),
        providerKind: "codex",
      });
      return mcpJson(projected);
    }),
  );

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

  server.registerTool(
    "codex_goal_pause",
    {
      title: "Soft Pause Codex Goal",
      description:
        "Write a soft pause request marker. This never kills a running worker.",
      inputSchema: jobIdInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as JobIdMcpArgs);
      await mkdir(loaded.launch.config.jobRootDir, { recursive: true, mode: 0o700 });
      const pausePath = join(
        loaded.launch.config.jobRootDir,
        `${loaded.launch.config.taskId}.pause-request.json`,
      );
      const status = await collectCodexGoalStatus(statusInput(loaded.launch));
      const controlSignal = await codexGoalWorkerControlService(loaded.launch)
        .enqueueSignal({
          target: codexGoalWorkerControlTarget(loaded),
          intent: "pause_requested",
          deliveryMode: "next_safe_point",
          body:
            "Soft pause was requested by the operator. Pause at the next safe point if the provider/session supports it; otherwise preserve this request in the continuation context.",
          createdBy: "operator",
          priority: "normal",
        });
      await writeFile(
        pausePath,
        `${JSON.stringify({
          schemaVersion: 1,
          jobId: loaded.manifest.jobId,
          taskId: loaded.launch.config.taskId,
          requestedAt: new Date().toISOString(),
          mode: "soft_pause_only",
          note: "The running worker is not terminated by this marker.",
        }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      return mcpJson({
        ok: true,
        jobId: loaded.manifest.jobId,
        pausePath,
        controlSignal: workerControlSignalJson(controlSignal, false),
        status,
        safeMessage:
          "Soft pause marker written. No tmux session or worker process was killed.",
      });
    }),
  );

  server.registerTool(
    "codex_goal_send_guidance",
    {
      title: "Send Codex Goal Guidance",
      description:
        "Durably send guidance to a Codex goal. Requests interrupt-then-continue when the active attempt is locally controllable; otherwise it safely falls back to next safe continuation.",
      inputSchema: {
        ...jobIdInputSchema(),
        message: z.string(),
        callerKind: z.enum(["user", "operator", "orchestrator", "runtime", "agent"]).optional(),
        callerActor: z.enum(["user", "operator", "orchestrator", "runtime", "agent"]).optional(),
        callerId: z.string().optional(),
        priority: z.enum(["low", "normal", "high"]).optional(),
        idempotencyKey: z.string().optional(),
        expiresAt: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const controlArgs = args as WorkerControlMcpArgs & {
        readonly message?: string;
      };
      const loaded = await loadJobLaunch(controlArgs);
      const control = codexGoalWorkerControlService(loaded.launch);
      const useCase = new InterruptAndContinueWorkerUseCase({
        control,
        ...(options.activeAttemptRegistry === undefined
          ? {}
          : { activeAttemptRegistry: options.activeAttemptRegistry }),
      });
      const result = await useCase.execute({
        target: codexGoalWorkerControlTarget(loaded),
        message: requiredRawString(controlArgs.message, "message"),
        ...workerControlCallerArgs(controlArgs),
        ...(stringValue(controlArgs.priority)
          ? { priority: stringValue(controlArgs.priority) as WorkerControlPriority }
          : {}),
        ...(stringValue(controlArgs.idempotencyKey)
          ? { idempotencyKey: stringValue(controlArgs.idempotencyKey) as string }
          : {}),
        ...(stringValue(controlArgs.expiresAt)
          ? { expiresAt: parseIsoDate(stringValue(controlArgs.expiresAt) as string, "expiresAt") }
          : {}),
      });
      const decision = await control.getDecision({
        target: codexGoalWorkerControlTarget(loaded),
      });
      return mcpJson({
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        status: result.status,
        signal: workerControlSignalJson(result.signal, false),
        decision: workerControlDecisionJson(decision, false),
        safeMessage: result.safeMessage,
      });
    }),
  );

  server.registerTool(
    "codex_goal_control_enqueue",
    {
      title: "Enqueue Codex Goal Control Signal",
      description:
        "Durably enqueue guidance or a control request for a stored Codex goal job. Default delivery is next safe continuation.",
      inputSchema: {
        ...jobIdInputSchema(),
        intent: z.enum([
          "guidance",
          "pause_requested",
          "stop_requested",
          "cancel_requested",
          "resume_requested",
          "repair_requested",
          "policy_update",
          "operator_note",
        ]),
        deliveryMode: z.enum([
          "record_only",
          "next_safe_point",
          "pause_then_continue",
          "interrupt_then_continue",
          "idle_turn_if_supported",
          "live_if_supported",
        ]).optional(),
        body: z.string(),
        createdBy: z.enum(["user", "operator", "orchestrator", "runtime", "agent"]).optional(),
        callerKind: z.enum(["user", "operator", "orchestrator", "runtime", "agent"]).optional(),
        callerActor: z.enum(["user", "operator", "orchestrator", "runtime", "agent"]).optional(),
        callerId: z.string().optional(),
        priority: z.enum(["low", "normal", "high"]).optional(),
        idempotencyKey: z.string().optional(),
        expiresAt: z.string().optional(),
        supersedesSignalIds: z.union([z.string(), z.array(z.string())]).optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as WorkerControlMcpArgs);
      const control = codexGoalWorkerControlService(loaded.launch);
      const controlArgs = args as WorkerControlMcpArgs;
      const enqueueInput = {
        target: codexGoalWorkerControlTarget(loaded),
        intent: requiredRawString(controlArgs.intent, "intent") as WorkerControlIntent,
        ...(stringValue(controlArgs.deliveryMode)
          ? {
              deliveryMode: stringValue(controlArgs.deliveryMode) as WorkerControlDeliveryMode,
            }
          : {}),
        body: requiredRawString(controlArgs.body, "body"),
        ...(stringValue(controlArgs.createdBy)
          ? { createdBy: stringValue(controlArgs.createdBy) as WorkerControlActor }
          : {}),
        ...workerControlCallerArgs(controlArgs),
        ...(stringValue(controlArgs.priority)
          ? { priority: stringValue(controlArgs.priority) as WorkerControlPriority }
          : {}),
        ...(stringValue(controlArgs.idempotencyKey)
          ? { idempotencyKey: stringValue(controlArgs.idempotencyKey) as string }
          : {}),
        ...(stringValue(controlArgs.expiresAt)
          ? { expiresAt: parseIsoDate(stringValue(controlArgs.expiresAt) as string, "expiresAt") }
          : {}),
        supersedesSignalIds: signalIdList(controlArgs.supersedesSignalIds),
      };
      const signal = await control.enqueueSignal(enqueueInput);
      const decision = await control.getDecision({
        target: codexGoalWorkerControlTarget(loaded),
      });
      return mcpJson({
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        signal: workerControlSignalJson(signal, false),
        decision: workerControlDecisionJson(decision, false),
      });
    }),
  );

  server.registerTool(
    "codex_goal_control_list",
    {
      title: "List Codex Goal Control Signals",
      description:
        "List durable control inbox signals for a stored Codex goal job.",
      inputSchema: {
        ...jobIdInputSchema(),
        includeBodies: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as WorkerControlMcpArgs);
      const control = codexGoalWorkerControlService(loaded.launch);
      const includeBodies =
        booleanValue((args as WorkerControlMcpArgs).includeBodies) ?? false;
      const signals = await control.listSignals({
        target: codexGoalWorkerControlTarget(loaded),
        includeBodies,
        includeExpired: true,
      });
      return mcpJson({
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        signals: signals.map((view) => workerControlSignalViewJson(view, includeBodies)),
      });
    }),
  );

  server.registerTool(
    "codex_goal_control_decision",
    {
      title: "Codex Goal Control Decision",
      description:
        "Inspect pending control inbox signals and whether they are safe for next continuation.",
      inputSchema: jobIdInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as WorkerControlMcpArgs);
      const control = codexGoalWorkerControlService(loaded.launch);
      const decision = await control.getDecision({
        target: codexGoalWorkerControlTarget(loaded),
      });
      return mcpJson({
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        decision: workerControlDecisionJson(decision, false),
      });
    }),
  );

  server.registerTool(
    "codex_goal_control_reconcile",
    {
      title: "Reconcile Codex Goal Control Inbox",
      description:
        "Return derived control inbox counts for a stored Codex goal job. With repair, stale accepted local delivery claims can be released back to pending.",
      inputSchema: {
        ...jobIdInputSchema(),
        repair: z.boolean().optional(),
        acceptedStaleAfterMs: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const controlArgs = args as WorkerControlMcpArgs;
      const loaded = await loadJobLaunch(controlArgs);
      const control = codexGoalWorkerControlService(loaded.launch);
      const report = await control.reconcile({
        target: codexGoalWorkerControlTarget(loaded),
        ...(controlArgs.repair === undefined ? {} : { repair: controlArgs.repair }),
        ...(controlArgs.acceptedStaleAfterMs === undefined
          ? {}
          : { acceptedStaleAfterMs: controlArgs.acceptedStaleAfterMs }),
      });
      return mcpJson({
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        report,
      });
    }),
  );

  server.registerTool(
    "codex_goal_control_supersede",
    {
      title: "Supersede Codex Goal Control Signal",
      description:
        "Mark a pending control inbox signal as superseded for a stored Codex goal job.",
      inputSchema: {
        ...jobIdInputSchema(),
        signalId: z.string(),
        supersededBySignalId: z.string().optional(),
        reason: z.string().optional(),
        callerKind: z.enum(["user", "operator", "orchestrator", "runtime", "agent"]).optional(),
        callerActor: z.enum(["user", "operator", "orchestrator", "runtime", "agent"]).optional(),
        callerId: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as WorkerControlMcpArgs);
      const control = codexGoalWorkerControlService(loaded.launch);
      const receipt = await control.markSuperseded({
        target: codexGoalWorkerControlTarget(loaded),
        signalId: requiredRawString((args as WorkerControlMcpArgs).signalId, "signalId"),
        ...(stringValue((args as WorkerControlMcpArgs).supersededBySignalId)
          ? {
              supersededBySignalId: stringValue((args as WorkerControlMcpArgs).supersededBySignalId) as string,
            }
          : {}),
        ...(stringValue((args as WorkerControlMcpArgs).reason)
          ? { reason: stringValue((args as WorkerControlMcpArgs).reason) as string }
          : {}),
        ...workerControlCallerArgs(args as WorkerControlMcpArgs),
      });
      return mcpJson({
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        receipt: workerControlReceiptJson(receipt),
      });
    }),
  );

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

  server.registerTool(
    "codex_goal_accounts_status",
    {
      title: "Codex Goal Account Status",
      description:
        "Inspect a stored job's configured account slots by jobId, including job-specific capacity cooldowns.",
      inputSchema: {
        ...jobIdInputSchema(),
        liveCheck: z.boolean().optional(),
        codexBinaryPath: z.string().optional(),
        liveCheckTimeoutMs: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as JobIdMcpArgs);
      return mcpJson({
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        ...(await codexGoalAccountStatusPayload(loaded.launch, {
          liveCheck: booleanValue(args.liveCheck) ?? false,
          ...(stringValue(args.codexBinaryPath)
            ? { codexBinaryPath: stringValue(args.codexBinaryPath) as string }
            : {}),
          ...(numberValue(args.liveCheckTimeoutMs)
            ? { liveCheckTimeoutMs: numberValue(args.liveCheckTimeoutMs) as number }
            : {}),
        })),
      });
    }),
  );

  server.registerTool(
    "codex_goal_accounts_list_pools",
    {
      title: "Codex Goal Account Pools",
      description:
        "List account pools for a stored job by jobId using the job state root for capacity-aware counts.",
      inputSchema: {
        ...jobIdInputSchema(),
        poolRootDir: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as JobAccountPoolMcpArgs);
      const poolRootDir = resolvePath(
        process.cwd(),
        stringValue((args as JobAccountPoolMcpArgs).poolRootDir) ??
          dirname(loaded.launch.config.authRootDir),
      );
      const stateRootDir = codexGoalStateRootDir(loaded.launch);
      const pools = await listAccountPools(poolRootDir, stateRootDir);
      return mcpJson({
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        poolRootDir,
        selectedAuthRootDir: loaded.launch.config.authRootDir,
        stateRootDir,
        capacityAware: true,
        pools,
      });
    }),
  );

  server.registerTool(
    "codex_goal_accounts_relogin_instructions",
    {
      title: "Codex Goal Account Relogin Instructions",
      description:
        "Return safe manual relogin commands for a stored job's account slot by jobId.",
      inputSchema: {
        ...jobIdInputSchema(),
        account: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as JobAccountPoolMcpArgs);
      const status = await codexGoalAccountStatusPayload(loaded.launch);
      const requestedAccount = stringValue((args as JobAccountPoolMcpArgs).account);
      const targetAccounts = requestedAccount
        ? [requestedAccount]
        : status.slots
            .filter((slot) => slot.status !== "ready")
            .map((slot) => slot.name);
      const instructionsByAccount = Object.fromEntries(
        targetAccounts.map((account) => [
          account,
          codexAccountReloginInstructions({
            authRootDir: loaded.launch.config.authRootDir,
            account,
            afterLoginInstruction:
              "After login, run codex_goal_accounts_status for the job before starting workers.",
          }),
        ]),
      );
      return mcpJson({
        ok: targetAccounts.length > 0,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        authRootDir: loaded.launch.config.authRootDir,
        stateRootDir: codexGoalStateRootDir(loaded.launch),
        targetAccounts,
        reason: targetAccounts.length
          ? "manual_relogin_commands_ready"
          : "no_invalid_account_slots_detected",
        accountStatus: status,
        instructionsByAccount,
        instructions: targetAccounts.length
          ? Object.values(instructionsByAccount).flat()
          : [
              "No invalid account slots were detected for this job. Pass account if you want instructions for a specific slot.",
            ],
      });
    }),
  );

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

  server.registerTool(
    "codex_goal_project_create_job",
    {
      title: "Project Control Create Codex Goal Job",
      description:
        "Create a child Codex goal job through a ProjectScopedControl controller manifest and broker policy.",
      inputSchema: {
        ...goalInputSchema(),
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        description: z.string().optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional(),
        workerRole: z.enum([
          ProjectAdmissionWorkerRole.Producer,
          ProjectAdmissionWorkerRole.Fastgate,
          ProjectAdmissionWorkerRole.Reviewer,
          ProjectAdmissionWorkerRole.Integration,
          ProjectAdmissionWorkerRole.Adoption,
          ProjectAdmissionWorkerRole.ReadOnly,
        ]).optional(),
        overwrite: z.boolean().optional(),
        confirmCreate: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlCreateCodexGoalJob(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_refill_worker",
    {
      title: "Project Control Refill Worker",
      description:
        "Create a scoped worktree, write a prompt, create a child job and optionally start it through one ProjectScopedControl broker flow.",
      inputSchema: {
        ...goalInputSchema(),
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        sourceWorkspacePath: z.string().optional(),
        baseBranch: z.string().optional(),
        promptBody: z.string().optional(),
        workerRole: z.enum(["producer", "fastgate", "reviewer"]).optional(),
        description: z.string().optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional(),
        overwrite: z.boolean().optional(),
        skipDoctor: z.boolean().optional(),
        startWorker: z.boolean().optional(),
        dependencyBootstrap: z.enum(["off", "preflight", "install"]).optional(),
        confirmDependencyBootstrap: z.boolean().optional(),
        executionMode: z.enum(["sync", "bounded", "async"]).optional(),
        confirmRefill: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlRefillWorker(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_operation_status",
    {
      title: "Project Control Operation Status",
      description:
        "Read a durable async ProjectScopedControl operation status handle created by bounded project-control tools.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        operationId: z.string(),
        includeResult: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlOperationStatus(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_admission_snapshot",
    {
      title: "Project Admission Snapshot",
      description:
        "Read project output debt used by the ProjectScopedControl admission gate. This is read-only.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        operation: z.enum([
          ProjectOperation.CreateJob,
          ProjectOperation.StartWorker,
          ProjectOperation.CreateWorktree,
        ]).optional(),
        workerRole: z.enum([
          ProjectAdmissionWorkerRole.Producer,
          ProjectAdmissionWorkerRole.Fastgate,
          ProjectAdmissionWorkerRole.Reviewer,
          ProjectAdmissionWorkerRole.Integration,
          ProjectAdmissionWorkerRole.Adoption,
          ProjectAdmissionWorkerRole.ReadOnly,
        ]).optional(),
        includeDetails: z.boolean().optional(),
        maxDebtItems: z.number().int().min(0).optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlAdmissionSnapshot(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_update_controller_scope",
    {
      title: "Project Control Update Controller Scope",
      description:
        "Safely repair limited ProjectScopedControl controller scope fields through a brokered manifest update path.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        projectAccessScope: z.record(z.string(), z.unknown()).optional(),
        confirmUpdate: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlUpdateControllerScope(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "brokered_project_manifest_repair",
    {
      title: "Brokered Project Manifest Repair",
      description:
        "Safely repair limited project-owned child job manifest fields through a ProjectScopedControl controller.",
      inputSchema: {
        ...jobIdInputSchema(),
        controllerJobId: z.string().optional(),
        accounts: z.union([z.string(), z.array(z.string())]).optional(),
        description: z.string().optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional(),
        confirmRepair: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlRepairJobManifest(args as ProjectControlMcpArgs & JobUpdateMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_controller_launch_plan",
    {
      title: "Project Controller Controlled-Agent Launch Plan",
      description:
        "Build a fail-closed broker-only LLM controller launch plan for a ProjectScopedControl controller manifest. Does not start an LLM.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        providerKind: z.enum([RunEventProviderKind.Codex, RunEventProviderKind.Claude]).optional(),
        stateDir: z.string().optional(),
        sessionArtifactPath: z.string().optional(),
        claudePath: z.string().optional(),
        mcpServerName: z.string().optional(),
        mcpCommand: z.string().optional(),
        mcpArgs: z.union([z.string(), z.array(z.string())]).optional(),
        mcpCwd: z.string().optional(),
        rawShellMode: z.enum([
          "disabled-by-provider",
          "sandboxed-deny-rules-only",
        ]).optional(),
        maxGoalTurns: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControllerLaunchPlan(args as ProjectControllerLaunchPlanMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_controller_start",
    {
      title: "Project Controller Controlled-Agent Start",
      description:
        "Start a broker-only LLM controller when the provider adapter can enforce the controlled-agent launch plan. Fails closed when no safe provider runner is available.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        providerKind: z.enum([RunEventProviderKind.Codex, RunEventProviderKind.Claude]).optional(),
        stateDir: z.string().optional(),
        sessionArtifactPath: z.string().optional(),
        claudePath: z.string().optional(),
        mcpServerName: z.string().optional(),
        mcpCommand: z.string().optional(),
        mcpArgs: z.union([z.string(), z.array(z.string())]).optional(),
        mcpCwd: z.string().optional(),
        rawShellMode: z.enum([
          "disabled-by-provider",
          "sandboxed-deny-rules-only",
        ]).optional(),
        maxGoalTurns: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControllerStart(args as ProjectControllerLaunchPlanMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_controller_status",
    {
      title: "Project Controller Controlled-Agent Status",
      description:
        "Read the persisted controlled-agent controller session/run state for a ProjectScopedControl manifest.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        providerKind: z.enum([RunEventProviderKind.Codex, RunEventProviderKind.Claude]).optional(),
        stateDir: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControllerStatus(args as ProjectControllerLaunchPlanMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_controller_consume_guidance",
    {
      title: "Project Controller Consume Guidance",
      description:
        "Consume pending control guidance for the ProjectScopedControl controller's own inbox and record delivery receipts. Does not consume child-worker inboxes.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        deliveryAttemptId: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControllerConsumeGuidance(args as ProjectControllerLaunchPlanMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_controller_stop",
    {
      title: "Project Controller Controlled-Agent Stop",
      description:
        "Stop a broker-only LLM controller through its provider adapter. Fails closed while no safe provider runner is connected.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        providerKind: z.enum([RunEventProviderKind.Codex, RunEventProviderKind.Claude]).optional(),
        stateDir: z.string().optional(),
        reason: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControllerStop(args as ProjectControllerLaunchPlanMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_controller_reconcile",
    {
      title: "Project Controller Controlled-Agent Reconcile",
      description:
        "Reconcile a broker-only LLM controller run through its provider adapter. Fails closed while no safe provider runner is connected.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        providerKind: z.enum([RunEventProviderKind.Codex, RunEventProviderKind.Claude]).optional(),
        stateDir: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControllerReconcile(args as ProjectControllerLaunchPlanMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_start",
    {
      title: "Project Control Start Codex Goal Worker",
      description:
        "Start a stored Codex goal worker through a ProjectScopedControl controller manifest and broker policy.",
      inputSchema: {
        ...jobIdInputSchema(),
        controllerJobId: z.string().optional(),
        confirmStart: z.boolean().optional(),
        forceStart: z.boolean().optional(),
        skipDoctor: z.boolean().optional(),
        dependencyBootstrap: z.enum(["off", "preflight", "install"]).optional(),
        confirmDependencyBootstrap: z.boolean().optional(),
        staleAfterMs: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlStartStoredJob(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_create_worktree",
    {
      title: "Project Control Create Git Worktree",
      description:
        "Create a project git worktree through a ProjectScopedControl controller manifest and broker policy.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        sourceWorkspacePath: z.string().optional(),
        path: z.string().optional(),
        baseBranch: z.string().optional(),
        sourceRef: z.string().optional(),
        newBranch: z.string().optional(),
        workerRole: z.enum([
          ProjectAdmissionWorkerRole.Producer,
          ProjectAdmissionWorkerRole.Fastgate,
          ProjectAdmissionWorkerRole.Reviewer,
          ProjectAdmissionWorkerRole.Integration,
          ProjectAdmissionWorkerRole.Adoption,
          ProjectAdmissionWorkerRole.ReadOnly,
        ]).optional(),
        dependencyBootstrap: z.enum(["off", "preflight", "install"]).optional(),
        confirmDependencyBootstrap: z.boolean().optional(),
        confirmCreateWorktree: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlCreateWorktree(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_integrate_commit",
    {
      title: "Project Control Integrate Git Commit",
      description:
        "Cherry-pick a reviewed commit into a scoped project worktree through broker policy.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        workspacePath: z.string().optional(),
        branch: z.string().optional(),
        commitSha: z.string().optional(),
        confirmIntegrate: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlIntegrateCommit(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_push_branch",
    {
      title: "Project Control Push Git Branch",
      description:
        "Push an allowed project branch through broker policy. Force uses --force-with-lease and must be allowed by scope.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        workspacePath: z.string().optional(),
        branch: z.string().optional(),
        remote: z.string().optional(),
        force: z.boolean().optional(),
        confirmPush: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlPushBranch(args as ProjectControlMcpArgs),
    ),
  );

  const projectIntegrationHandlers = createLocalProjectIntegrationMcpToolHandlers({
    loadController: loadProjectControlController,
    resolvePathArg: projectControlPathArg,
  });
  registerProjectIntegrationMcpTools(server, {
    openAttempt: (args) => withMcpErrors(async () =>
      projectIntegrationHandlers.openAttempt(args),
    ),
    applyWorkerOutput: (args) => withMcpErrors(async () =>
      projectIntegrationHandlers.applyWorkerOutput(args),
    ),
    runRequiredChecks: (args) => withMcpErrors(async () =>
      projectIntegrationHandlers.runRequiredChecks(args),
    ),
    commitApprovedChanges: (args) => withMcpErrors(async () =>
      projectIntegrationHandlers.commitApprovedChanges(args),
    ),
    pushApprovedCommit: (args) => withMcpErrors(async () =>
      projectIntegrationPushApprovedCommitWithConsumedLedger({
        args,
        loadController: loadProjectControlController,
        pushApprovedCommitHandler: projectIntegrationHandlers.pushApprovedCommit,
      }),
    ),
    rejectAttempt: (args) => withMcpErrors(async () =>
      projectIntegrationHandlers.rejectAttempt(args),
    ),
  });

  server.registerTool(
    "codex_goal_project_stop",
    {
      title: "Project Control Stop Codex Goal Worker",
      description:
        "Stop a stored Codex goal worker through a ProjectScopedControl controller manifest and broker policy.",
      inputSchema: {
        ...jobIdInputSchema(),
        controllerJobId: z.string().optional(),
        confirmStop: z.boolean().optional(),
        forceStop: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlStopStoredJob(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_mark_reviewed",
    {
      title: "Project Control Mark Codex Goal Reviewed",
      description:
        "Write a review marker for a stored job through a ProjectScopedControl controller manifest and broker policy.",
      inputSchema: {
        ...jobIdInputSchema(),
        controllerJobId: z.string().optional(),
        note: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlMarkReviewed(args as ProjectControlMcpArgs),
    ),
  );

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

  server.registerTool(
    "codex_accounts_list_pools",
    {
      title: "List Codex Account Pools",
      description:
        "List account auth pools under a root directory without printing tokens.",
      inputSchema: {
        poolRootDir: z.string().optional(),
        stateRootDir: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const poolRootDir = accountPoolRootFromArgs(args as AccountPoolMcpArgs);
      const stateRootDir = stringValue(args.stateRootDir)
        ? resolvePath(process.cwd(), stringValue(args.stateRootDir) as string)
        : undefined;
      const pools = await listAccountPools(poolRootDir, stateRootDir);
      return mcpJson({
        ok: true,
        poolRootDir,
        capacityAware: Boolean(stateRootDir),
        ...(stateRootDir ? { stateRootDir } : {}),
        pools,
      });
    }),
  );

  server.registerTool(
    "codex_accounts_status",
    {
      title: "Codex Account Slot Status",
      description:
        "Inspect Codex account slot auth files without printing tokens.",
      inputSchema: {
        poolRootDir: z.string().optional(),
        pool: z.string().optional(),
        authRootDir: z.string().optional(),
        stateRootDir: z.string().optional(),
        accounts: z.union([z.string(), z.array(z.string())]).optional(),
        liveCheck: z.boolean().optional(),
        codexBinaryPath: z.string().optional(),
        liveCheckTimeoutMs: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const authRootDir = accountAuthRootFromArgs(args as AccountPoolMcpArgs);
      const accounts = accountNames(args.accounts);
      return mcpJson(await codexAccountStatusPayload({
        authRootDir,
        ...(accounts.length ? { accounts } : {}),
        ...(stringValue(args.stateRootDir)
          ? { stateRootDir: resolvePath(process.cwd(), stringValue(args.stateRootDir) as string) }
          : {}),
        liveCheck: booleanValue(args.liveCheck) ?? false,
        ...(stringValue(args.codexBinaryPath)
          ? { codexBinaryPath: stringValue(args.codexBinaryPath) as string }
          : {}),
        ...(numberValue(args.liveCheckTimeoutMs)
          ? { liveCheckTimeoutMs: numberValue(args.liveCheckTimeoutMs) as number }
          : {}),
      }));
    }),
  );

  server.registerTool(
    "codex_accounts_relogin_instructions",
    {
      title: "Codex Account Relogin Instructions",
      description:
        "Return safe manual relogin commands for account slots. Does not perform login.",
      inputSchema: {
        poolRootDir: z.string().optional(),
        pool: z.string().optional(),
        authRootDir: z.string().optional(),
        account: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const authRootDir = accountAuthRootFromArgs(args as AccountPoolMcpArgs);
      const account = stringValue(args.account) ?? "<account-slot>";
      return mcpJson({
        ok: true,
        authRootDir,
        account,
        instructions: codexAccountReloginInstructions({
          authRootDir,
          account,
          afterLoginInstruction:
            "After login, run codex_accounts_status for this pool before starting workers.",
        }),
      });
    }),
  );

  return server;
}

async function loadJobLaunch(args: JobIdMcpArgs): Promise<{
  readonly registryRootDir: string;
  readonly manifest: Awaited<ReturnType<typeof readCodexGoalJob>>;
  readonly launch: CodexGoalLaunchInput;
}> {
  const registryRootDir = registryRootFromArgs(args);
  const manifest = await readCodexGoalJob({
    registryRootDir,
    jobId: requiredRawString(args.jobId, "jobId"),
  });
  return {
    registryRootDir,
    manifest,
    launch: await goalLaunchInput(codexGoalJobToArgs(manifest)),
  };
}

async function loadProjectControlController(args: ProjectControlMcpArgs): Promise<{
  readonly registryRootDir: string;
  readonly controller: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
}> {
  const registryRootDir = registryRootFromArgs(args);
  const controller = await readCodexGoalJob({
    registryRootDir,
    jobId: requiredRawString(args.controllerJobId, "controllerJobId"),
  });
  if (controller.accessBoundary !== AccessBoundary.ProjectScopedControl) {
    throw new Error("project_control_controller_boundary_required");
  }
  if (!controller.projectAccessScope) {
    throw new Error("project_control_controller_scope_required");
  }
  return {
    registryRootDir,
    controller,
    scope: controller.projectAccessScope,
  };
}

const codexProjectAdmissionDeps: CodexProjectAdmissionDeps = {
  listJobs: listCodexGoalJobs,
  buildOverviewItem: (input) =>
    buildCodexGoalOverviewItem(input),
};

async function projectControlAdmissionSnapshot(
  args: ProjectControlMcpArgs,
) {
  const controller = await loadProjectControlController(args);
  const snapshot = await buildCodexProjectAdmissionSnapshot({
    registryRootDir: controller.registryRootDir,
    scope: controller.scope,
    deps: codexProjectAdmissionDeps,
  });
  const operation = projectAdmissionOperation(args.operation);
  const workerRole = projectAdmissionWorkerRoleArg(args.workerRole);
  const decision = operation
    ? evaluateProjectAdmission({
        request: {
          operation,
          projectId: controller.scope.projectId,
          ...(workerRole ? { workerRole } : {}),
        },
        snapshot,
      })
    : undefined;
  const detailView = projectAdmissionDetailView({
    snapshot,
    ...(decision ? { decision } : {}),
    includeDetails: args.includeDetails === true,
    ...(args.maxDebtItems === undefined ? {} : { maxDebtItems: args.maxDebtItems }),
  });
  return mcpJson({
    ok: true,
    mode: "project_admission_snapshot",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    snapshot: detailView.snapshot,
    ...(detailView.decision ? { decision: detailView.decision } : {}),
  });
}

async function projectControlUpdateControllerScope(
  args: ProjectControlMcpArgs,
) {
  const controller = await loadProjectControlController(args);
  const proposedScope = parseCodexGoalProjectAccessScope(
    args.projectAccessScope,
    "projectAccessScope",
  );
  if (!proposedScope) {
    throw new Error("project_control_project_access_scope_required");
  }
  assertProjectControlScopeRepairAllowed({
    existing: controller.scope,
    proposed: proposedScope,
  });

  if (booleanValue(args.confirmUpdate) !== true) {
    return mcpJson({
      ok: false,
      reason: "confirm_update_required",
      mode: "project_control_update_controller_scope",
      controllerJobId: controller.controller.jobId,
      registryRootDir: controller.registryRootDir,
      auditPath: projectControlAuditPath(controller.controller),
      currentConsumedOutputLedgerRoots:
        controller.scope.consumedOutputLedgerRoots ?? [],
      proposedConsumedOutputLedgerRoots:
        proposedScope.consumedOutputLedgerRoots ?? [],
    });
  }

  const manifest = await updateCodexGoalJob({
    registryRootDir: controller.registryRootDir,
    jobId: controller.controller.jobId,
    patch: { projectAccessScope: proposedScope },
  });
  return mcpJson({
    ok: true,
    mode: "project_control_update_controller_scope",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    auditPath: projectControlAuditPath(controller.controller),
    manifest,
    summary: summarizeCodexGoalJob(manifest, controller.registryRootDir),
  });
}

async function projectControlRepairJobManifest(
  args: ProjectControlMcpArgs & JobUpdateMcpArgs,
) {
  const controller = await loadProjectControlController(args);
  const jobId = requiredRawString(args.jobId, "jobId");
  if (jobId === controller.controller.jobId) {
    return mcpJson({
      ok: false,
      error: "project_control_controller_manifest_repair_unsupported",
      requiredTool: "codex_goal_project_update_controller_scope",
      safeMessage:
        "Controller manifests use codex_goal_project_update_controller_scope for scoped repairs.",
    });
  }

  const existing = await readCodexGoalJob({
    registryRootDir: controller.registryRootDir,
    jobId,
  });
  assertProjectControlRepairJobOwned({
    controllerScope: controller.scope,
    job: existing,
  });

  const patch: Record<string, unknown> = {};
  if (args.accounts !== undefined) {
    const requestedAccounts = accountNames(args.accounts);
    if (requestedAccounts.length === 0) {
      throw new Error("project_control_repair_accounts_required");
    }
    assertProjectControlRepairAccountsAllowed({
      accounts: requestedAccounts,
      allowedAccountIds: controller.scope.allowedAccountIds ?? [],
    });
    patch.accounts = requestedAccounts;
  } else {
    const repairedAccounts = await projectControlDefaultAccountNames({
      ...(existing.authRootDir ? { authRootDir: existing.authRootDir } : {}),
      requestedAccounts: existing.accounts,
      allowedAccountIds: controller.scope.allowedAccountIds ?? [],
    });
    if (projectScopeFieldFingerprint(existing.accounts) !==
      projectScopeFieldFingerprint(repairedAccounts)) {
      patch.accounts = repairedAccounts;
    }
  }
  if (args.description !== undefined) {
    patch.description = stringValue(args.description) ?? "";
  }
  if (args.tags !== undefined) {
    patch.tags = tagValues(args.tags);
  }

  if (Object.keys(patch).length === 0) {
    return mcpJson({
      ok: true,
      mode: "brokered_project_manifest_repair",
      reason: "no_repair_needed",
      controllerJobId: controller.controller.jobId,
      registryRootDir: controller.registryRootDir,
      manifest: existing,
      summary: summarizeCodexGoalJob(existing, controller.registryRootDir),
    });
  }

  if (booleanValue(args.confirmRepair) !== true) {
    return mcpJson({
      ok: false,
      reason: "confirm_repair_required",
      mode: "brokered_project_manifest_repair",
      controllerJobId: controller.controller.jobId,
      registryRootDir: controller.registryRootDir,
      jobId: existing.jobId,
      auditPath: projectControlAuditPath(controller.controller),
      proposedPatch: patch as unknown as JsonObject,
    });
  }

  const manifest = await updateCodexGoalJob({
    registryRootDir: controller.registryRootDir,
    jobId: existing.jobId,
    patch: patch as CodexGoalJobManifestPatch,
  });
  return mcpJson({
    ok: true,
    mode: "brokered_project_manifest_repair",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    auditPath: projectControlAuditPath(controller.controller),
    manifest,
    summary: summarizeCodexGoalJob(manifest, controller.registryRootDir),
  });
}

function assertProjectControlRepairJobOwned(input: {
  readonly controllerScope: ProjectAccessScope;
  readonly job: CodexGoalJobManifest;
}): void {
  if (input.job.accessBoundary === AccessBoundary.ProjectScopedControl) {
    throw new Error("project_control_repair_child_job_required");
  }
  if (input.job.projectAccessScope?.projectId !== input.controllerScope.projectId) {
    throw new Error("project_control_repair_project_scope_mismatch");
  }
  const jobMatches = matchesProjectControlPrefix(
    input.job.jobId,
    input.controllerScope.jobIdPrefixes ?? [],
  );
  const workspaceMatches = pathInsideAnyProjectRoot(
    input.job.workspacePath,
    [
      ...(input.controllerScope.workspaceRoots ?? []),
      ...(input.controllerScope.worktreeRoots ?? []),
      ...(input.controllerScope.isolatedWorkspaceRoot
        ? [input.controllerScope.isolatedWorkspaceRoot]
        : []),
    ],
  );
  if (!jobMatches && !workspaceMatches) {
    throw new Error("project_control_repair_job_scope_mismatch");
  }
}

function assertProjectControlRepairAccountsAllowed(input: {
  readonly accounts: readonly string[];
  readonly allowedAccountIds: readonly string[];
}): void {
  const allowed = new Set(input.allowedAccountIds);
  if (allowed.size === 0) return;
  const denied = input.accounts.filter((account) => !allowed.has(account));
  if (denied.length > 0) {
    throw new Error("project_control_repair_account_outside_scope");
  }
}

function codexProjectControlBroker(
  input: Omit<CodexProjectControlBrokerInput, "admissionDeps">,
): ProjectControlBroker {
  return createCodexProjectControlBroker({
    ...input,
    admissionDeps: codexProjectAdmissionDeps,
  });
}

function projectControllerDeps() {
  return {
    loadProjectControlController,
    runtimeVersion: serverVersion,
  };
}

async function projectControllerLaunchPlan(args: ProjectControllerLaunchPlanMcpArgs) {
  return mcpJson(await projectControllerLaunchPlanView(args, projectControllerDeps()));
}

async function projectControllerStart(args: ProjectControllerLaunchPlanMcpArgs) {
  return mcpJson(await projectControllerStartView(args, projectControllerDeps()));
}

async function projectControllerStatus(args: ProjectControllerLaunchPlanMcpArgs) {
  return mcpJson(await projectControllerStatusView(args, projectControllerDeps()));
}

async function projectControllerConsumeGuidance(args: ProjectControllerLaunchPlanMcpArgs) {
  return mcpJson(await projectControllerConsumeGuidanceView(args, projectControllerDeps()));
}

async function projectControllerStop(args: ProjectControllerLaunchPlanMcpArgs) {
  return mcpJson(await projectControllerStopView(args, projectControllerDeps()));
}

async function projectControllerReconcile(args: ProjectControllerLaunchPlanMcpArgs) {
  return mcpJson(await projectControllerReconcileView(args, projectControllerDeps()));
}

async function projectControlCreateCodexGoalJob(args: ProjectControlMcpArgs) {
  const controller = await loadProjectControlController(args);
  if (args.projectAccessScope !== undefined) {
    throw new Error("project_control_child_scope_is_controller_owned");
  }
  if (args.allowDangerFullAccess === true) {
    throw new Error("project_control_child_danger_full_access_denied");
  }

  const requested = jobManifestInputFromArgs(args as JobCreateMcpArgs);
  if (
    requested.accessBoundary === AccessBoundary.ProjectScopedControl ||
    requested.accessBoundary === AccessBoundary.DangerFullAccess
  ) {
    throw new Error("project_control_child_boundary_denied");
  }
  const accessBoundary =
    requested.accessBoundary ?? AccessBoundary.IsolatedWorkspaceWrite;
  const workerRole = projectAdmissionWorkerRoleArg(args.workerRole);
  const accounts = await projectControlDefaultAccountNames({
    ...(requested.authRootDir ? { authRootDir: requested.authRootDir } : {}),
    requestedAccounts: requested.accounts,
    allowedAccountIds: controller.scope.allowedAccountIds ?? [],
  });
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
    return mcpJson({
      ok: false,
      reason: "confirm_create_required",
      controllerJobId: controller.controller.jobId,
      targetJobId: createManifest.jobId,
      auditPath: projectControlAuditPath(controller.controller),
      manifestPreview: createManifest as unknown as JsonObject,
    });
  }

  const broker = codexProjectControlBroker({
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
  return mcpJson({
    ok: true,
    mode: "project_control_create_job",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    auditPath: projectControlAuditPath(controller.controller),
    result: result as unknown as JsonObject,
    manifest,
    summary: summarizeCodexGoalJob(manifest, controller.registryRootDir),
  });
}

async function projectControlRefillWorker(args: ProjectControlMcpArgs) {
  if (projectControlOperationExecutionMode(args.executionMode) === "bounded") {
    return projectControlRefillWorkerBounded(args);
  }
  const controller = await loadProjectControlController(args);
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

  const requested = jobManifestInputFromArgs(args as JobCreateMcpArgs);
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
  });
  if (!accounts.length) {
    throw new Error("project_control_refill_no_ready_account");
  }
  const role = projectControlWorkerRole(args.workerRole);
  const accessBoundary =
    requested.accessBoundary ?? AccessBoundary.IsolatedWorkspaceWrite;
  const createManifest: CodexGoalJobManifestInput = {
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
    return mcpJson({
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
    });
  }

  const worktreeBroker = codexProjectControlBroker({
    registryRootDir: controller.registryRootDir,
    controller: controller.controller,
    scope: controller.scope,
    createWorktreeInput,
  });
  let worktreeCreated = false;
  let promptWritten = false;
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

    const createBroker = codexProjectControlBroker({
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
    dependencyPreflight = await runDependencyBootstrap({
      workspacePath: manifest.workspacePath,
      jobRootDir: manifest.jobRootDir,
      mode: projectControlDependencyBootstrapMode(args.dependencyBootstrap),
      confirmInstall: booleanValue(args.confirmDependencyBootstrap) === true,
    });
    assertProjectControlDependencyBootstrapReady(dependencyPreflight);
  } catch (error) {
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
    const launch = await goalLaunchInput(codexGoalJobToArgs(manifest));
    const startBroker = codexProjectControlBroker({
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

  return mcpJson({
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
  });
}

async function projectControlRefillWorkerBounded(args: ProjectControlMcpArgs) {
  const controller = await loadProjectControlController(args);
  if (args.projectAccessScope !== undefined) {
    throw new Error("project_control_child_scope_is_controller_owned");
  }
  if (args.allowDangerFullAccess === true) {
    throw new Error("project_control_child_danger_full_access_denied");
  }
  if (!args.confirmRefill) {
    return mcpJson({
      ok: false,
      reason: "confirm_refill_required",
      mode: "project_control_refill_worker_operation_preview",
      executionMode: "bounded",
      controllerJobId: controller.controller.jobId,
      auditPath: projectControlAuditPath(controller.controller),
      requiredConfirmation: "confirmRefill",
    });
  }
  requiredRawString(args.promptBody, "promptBody");
  projectControlPathArg(args, args.sourceWorkspacePath, "sourceWorkspacePath");
  const requested = jobManifestInputFromArgs(args as JobCreateMcpArgs);
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
  assertProjectControlCreateManifestPaths({
    scope: controller.scope,
    registryRootDir: controller.registryRootDir,
    manifest: createManifest,
  });
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
  return mcpJson({
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
  });
}

async function projectControlOperationStatus(args: ProjectControlMcpArgs) {
  const controller = await loadProjectControlController(args);
  const operationId = requiredRawString(args.operationId, "operationId");
  const operation = await readProjectControlOperationById({
    operationsRootDir: projectControlOperationsRoot(controller.controller.jobRootDir),
    operationId,
  });
  return mcpJson({
    ok: true,
    mode: "project_control_operation_status",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    operation: projectControlOperationView({
      operation,
      includeResult: booleanValue(args.includeResult) === true,
    }),
  });
}

async function projectControlStartStoredJob(args: ProjectControlMcpArgs) {
  const controller = await loadProjectControlController(args);
  const jobId = requiredRawString(args.jobId, "jobId");
  const manifest = await readCodexGoalJob({
    registryRootDir: controller.registryRootDir,
    jobId,
  });
  try {
    await assertReadablePrompt({ promptPath: manifest.promptPath });
  } catch (error) {
    return mcpJson({
      ok: false,
      reason: error instanceof Error
        ? error.message
        : "project_control_prompt_missing_before_start",
      mode: "project_control_start",
      controllerJobId: controller.controller.jobId,
      jobId: manifest.jobId,
      promptPath: manifest.promptPath,
    });
  }
  const loaded = {
    manifest,
    launch: await goalLaunchInput(codexGoalJobToArgs(manifest)),
  };
  const status = await collectCodexGoalStatus(statusInput(loaded.launch));
  const progressStale = status.progressHeartbeatAgeMs !== undefined &&
    status.progressHeartbeatAgeMs > 10 * 60_000;
  const workerLiveness = resolveCodexGoalWorkerLiveness({
    status,
    progressStale,
  });
  if (workerLiveness.alive) {
    return mcpJson({
      ok: false,
      reason: "worker_already_running",
      controllerJobId: controller.controller.jobId,
      jobId: loaded.manifest.jobId,
      status,
    });
  }
  if (!loaded.launch.tmuxSession) {
    return mcpJson({
      ok: false,
      reason: "tmux_session_required",
      controllerJobId: controller.controller.jobId,
      jobId: loaded.manifest.jobId,
      noTmuxCommand: buildCodexGoalNoTmuxCommand(loaded.launch),
    });
  }
  if (!isSafeStartAction(status.recommendedAction) && !args.forceStart) {
    return mcpJson({
      ok: false,
      reason: "status_requires_review",
      controllerJobId: controller.controller.jobId,
      jobId: loaded.manifest.jobId,
      status,
      requiredOverride: "forceStart",
    });
  }
  if (!args.confirmStart) {
    return mcpJson({
      ok: false,
      reason: "confirm_start_required",
      controllerJobId: controller.controller.jobId,
      jobId: loaded.manifest.jobId,
      auditPath: projectControlAuditPath(controller.controller),
      tmuxCommand: buildCodexGoalTmuxCommand(loaded.launch).preview,
      status,
    });
  }
  const dependencyPreflight = await runDependencyBootstrap({
    workspacePath: loaded.manifest.workspacePath,
    jobRootDir: loaded.manifest.jobRootDir,
    mode: projectControlDependencyBootstrapMode(args.dependencyBootstrap),
    confirmInstall: booleanValue(args.confirmDependencyBootstrap) === true,
  });
  assertProjectControlDependencyBootstrapReady(dependencyPreflight);

  const broker = codexProjectControlBroker({
    registryRootDir: controller.registryRootDir,
    controller: controller.controller,
    scope: controller.scope,
    startLaunch: loaded.launch,
    startSkipDoctor: booleanValue(args.skipDoctor) ?? false,
  });
  const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(
    loaded.launch.config.workspacePath,
    controller.scope,
  );
  const result = await broker.startWorker({
    jobId: loaded.manifest.jobId,
    registryRoot: controller.registryRootDir,
    workspacePath: loaded.launch.config.workspacePath,
    ...(realWorkspacePath ? { realWorkspacePath } : {}),
    tmuxSession: loaded.launch.tmuxSession,
    accounts: loaded.manifest.accounts,
    ...(loaded.manifest.tags ? { tags: loaded.manifest.tags } : {}),
  });
  return mcpJson({
    ok: true,
    mode: "project_control_start",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    auditPath: projectControlAuditPath(controller.controller),
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    tmuxSession: loaded.launch.tmuxSession,
    statusBefore: status,
    dependencyPreflight: dependencyPreflight as unknown as JsonObject,
    result: result as unknown as JsonObject,
  });
}

async function projectControlCreateWorktree(args: ProjectControlMcpArgs) {
  const controller = await loadProjectControlController(args);
  const sourceWorkspacePath = projectControlPathArg(
    args,
    args.sourceWorkspacePath,
    "sourceWorkspacePath",
  );
  const path = projectControlPathArg(args, args.path, "path");
  const baseBranch = stringValue(args.baseBranch);
  if (baseBranch) assertSafeGitRefName(baseBranch, "baseBranch");
  const sourceRef = stringValue(args.sourceRef);
  if (sourceRef) assertSafeGitRefName(sourceRef, "sourceRef");
  const newBranch = stringValue(args.newBranch);
  if (newBranch) assertSafeGitRefName(newBranch, "newBranch");
  const effectiveSourceRef = sourceRef ?? baseBranch;
  const workerRole = projectAdmissionWorkerRoleArg(args.workerRole);
  const realSourceWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(
    sourceWorkspacePath,
    controller.scope,
  );
  const createWorktreeInput: CodexGoalProjectCreateWorktreeInput = {
    sourceWorkspacePath,
    ...(realSourceWorkspacePath ? { realSourceWorkspacePath } : {}),
    path,
    ...(baseBranch ? { baseBranch } : {}),
    ...(sourceRef ? { sourceRef } : {}),
    ...(newBranch ? { newBranch } : {}),
    ...(workerRole ? { workerRole } : {}),
  };

  if (!args.confirmCreateWorktree) {
    return mcpJson({
      ok: false,
      reason: "confirm_create_worktree_required",
      controllerJobId: controller.controller.jobId,
      auditPath: projectControlAuditPath(controller.controller),
      commandPreview: [
        "git",
        "-C",
        sourceWorkspacePath,
        "worktree",
        "add",
        ...(newBranch ? ["-b", newBranch] : []),
        path,
        ...(effectiveSourceRef ? [effectiveSourceRef] : []),
      ],
    });
  }

  const broker = codexProjectControlBroker({
    registryRootDir: controller.registryRootDir,
    controller: controller.controller,
    scope: controller.scope,
    createWorktreeInput,
  });
  const result = await broker.createWorktree(createWorktreeInput);
  const dependencyPreflight = await runDependencyBootstrap({
    workspacePath: path,
    mode: projectControlDependencyBootstrapMode(args.dependencyBootstrap),
    confirmInstall: booleanValue(args.confirmDependencyBootstrap) === true,
  });
  assertProjectControlDependencyBootstrapReady(dependencyPreflight);
  return mcpJson({
    ok: true,
    mode: "project_control_create_worktree",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    auditPath: projectControlAuditPath(controller.controller),
    dependencyPreflight: dependencyPreflight as unknown as JsonObject,
    result: result as unknown as JsonObject,
  });
}

async function projectControlIntegrateCommit(args: ProjectControlMcpArgs) {
  const controller = await loadProjectControlController(args);
  const workspacePath = projectControlPathArg(
    args,
    args.workspacePath,
    "workspacePath",
  );
  const branch = requiredRawString(args.branch, "branch");
  const commitSha = requiredRawString(args.commitSha, "commitSha");
  assertSafeGitRefName(branch, "branch");
  assertSafeGitCommitSha(commitSha);
  const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(
    workspacePath,
    controller.scope,
  );
  const integrateCommitInput: CodexGoalProjectIntegrateCommitInput = {
    workspacePath,
    ...(realWorkspacePath ? { realWorkspacePath } : {}),
    branch,
    commitSha,
  };

  if (!args.confirmIntegrate) {
    return mcpJson({
      ok: false,
      reason: "confirm_integrate_required",
      controllerJobId: controller.controller.jobId,
      auditPath: projectControlAuditPath(controller.controller),
      commandPreview: ["git", "-C", workspacePath, "cherry-pick", "--ff", commitSha],
    });
  }

  const broker = codexProjectControlBroker({
    registryRootDir: controller.registryRootDir,
    controller: controller.controller,
    scope: controller.scope,
    integrateCommitInput,
  });
  const result = await broker.integrateCommit(integrateCommitInput);
  return mcpJson({
    ok: true,
    mode: "project_control_integrate_commit",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    auditPath: projectControlAuditPath(controller.controller),
    result: result as unknown as JsonObject,
  });
}

async function projectControlPushBranch(args: ProjectControlMcpArgs) {
  const controller = await loadProjectControlController(args);
  const workspacePath = projectControlPathArg(
    args,
    args.workspacePath,
    "workspacePath",
  );
  const branch = requiredRawString(args.branch, "branch");
  const remote = stringValue(args.remote) ?? "origin";
  const force = booleanValue(args.force) ?? false;
  assertSafeGitRefName(branch, "branch");
  assertSafeGitRemoteName(remote, "remote");
  const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(
    workspacePath,
    controller.scope,
  );
  const pushBranchInput: CodexGoalProjectPushBranchInput = {
    workspacePath,
    ...(realWorkspacePath ? { realWorkspacePath } : {}),
    branch,
    remote,
    force,
  };

  if (!args.confirmPush) {
    return mcpJson({
      ok: false,
      reason: "confirm_push_required",
      controllerJobId: controller.controller.jobId,
      auditPath: projectControlAuditPath(controller.controller),
      commandPreview: [
        "git",
        "-C",
        workspacePath,
        "push",
        ...(force ? ["--force-with-lease"] : []),
        remote,
        branch,
      ],
    });
  }

  const broker = codexProjectControlBroker({
    registryRootDir: controller.registryRootDir,
    controller: controller.controller,
    scope: controller.scope,
    pushBranchInput,
  });
  const result = await broker.pushBranch(pushBranchInput);
  return mcpJson({
    ok: true,
    mode: "project_control_push_branch",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    auditPath: projectControlAuditPath(controller.controller),
    result: result as unknown as JsonObject,
  });
}

async function projectControlStopStoredJob(args: ProjectControlMcpArgs) {
  const controller = await loadProjectControlController(args);
  const loaded = await loadJobLaunch({
    registryRootDir: controller.registryRootDir,
    jobId: requiredRawString(args.jobId, "jobId"),
  });
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
    staleAfterMs: 10 * 60_000,
    tailLines: 20,
  });
  const progressStale = status.progressHeartbeatAgeMs !== undefined &&
    status.progressHeartbeatAgeMs > 10 * 60_000;
  const workerLiveness = resolveCodexGoalWorkerLiveness({
    status,
    progressStale,
  });
  const stopCommandPreview = loaded.launch.tmuxSession
    ? buildCodexGoalStopTmuxCommand(loaded.launch.tmuxSession).preview
    : status.progressPid === undefined
    ? "no direct process pid"
    : `kill -TERM ${status.progressPid}`;
  if (
    workerLiveness.alive &&
    !brief.silentStale &&
    !brief.heartbeatOnlyNoOutput &&
    !args.forceStop
  ) {
    return mcpJson({
      ok: false,
      reason: "worker_not_silent_stale_or_heartbeat_only_no_output",
      controllerJobId: controller.controller.jobId,
      jobId: loaded.manifest.jobId,
      ...(loaded.launch.tmuxSession ? { tmuxSession: loaded.launch.tmuxSession } : {}),
      requiredOverride: "forceStop",
      stopCommand: stopCommandPreview,
      status,
      brief,
    });
  }
  if (!args.confirmStop) {
    return mcpJson({
      ok: false,
      reason: "confirm_stop_required",
      controllerJobId: controller.controller.jobId,
      jobId: loaded.manifest.jobId,
      ...(loaded.launch.tmuxSession ? { tmuxSession: loaded.launch.tmuxSession } : {}),
      stopCommand: stopCommandPreview,
      auditPath: projectControlAuditPath(controller.controller),
      status,
      brief,
    });
  }

  const broker = codexProjectControlBroker({
    registryRootDir: controller.registryRootDir,
    controller: controller.controller,
    scope: controller.scope,
    stopLaunch: loaded.launch,
  });
  const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(
    loaded.launch.config.workspacePath,
    controller.scope,
  );
  const result = await broker.stopWorker({
    jobId: loaded.manifest.jobId,
    registryRoot: controller.registryRootDir,
    workspacePath: loaded.launch.config.workspacePath,
    ...(realWorkspacePath ? { realWorkspacePath } : {}),
    ...(loaded.launch.tmuxSession ? { tmuxSession: loaded.launch.tmuxSession } : {}),
  });
  await writeCodexGoalStoppedProgress({
    progressPath: loaded.launch.config.progressPath ?? codexGoalProgressPath({
      jobRootDir: loaded.launch.config.jobRootDir,
      taskId: loaded.launch.config.taskId,
    }),
    taskId: loaded.launch.config.taskId,
    status: "stopped",
  });
  const statusAfter = await collectCodexGoalStatus(statusInput(loaded.launch));
  const stopEventPath = await writeCodexGoalStopEvent({
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    jobRootDir: loaded.launch.config.jobRootDir,
    ...(loaded.launch.tmuxSession ? { tmuxSession: loaded.launch.tmuxSession } : {}),
    stopCommand: String(result.resourceId ?? stopCommandPreview),
    forceStop: Boolean(args.forceStop),
    statusBefore: status,
    statusAfter,
    brief,
  });
  return mcpJson({
    ok: true,
    mode: "project_control_stop",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    auditPath: projectControlAuditPath(controller.controller),
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    ...(loaded.launch.tmuxSession ? { tmuxSession: loaded.launch.tmuxSession } : {}),
    stopEventPath,
    statusBefore: status,
    statusAfter,
    result: result as unknown as JsonObject,
  });
}

async function projectControlMarkReviewed(args: ProjectControlMcpArgs) {
  const controller = await loadProjectControlController(args);
  const loaded = await loadJobLaunch({
    registryRootDir: controller.registryRootDir,
    jobId: requiredRawString(args.jobId, "jobId"),
  });
  const broker = codexProjectControlBroker({
    registryRootDir: controller.registryRootDir,
    controller: controller.controller,
    scope: controller.scope,
    reviewLaunch: loaded.launch,
    reviewNote: stringValue(args.note) ?? "project_control_reviewed",
  });
  const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(
    loaded.launch.config.workspacePath,
    controller.scope,
  );
  const result = await broker.writeReviewMarker({
    jobId: loaded.manifest.jobId,
    registryRoot: controller.registryRootDir,
    workspacePath: loaded.launch.config.workspacePath,
    ...(realWorkspacePath ? { realWorkspacePath } : {}),
    ...(loaded.launch.tmuxSession ? { tmuxSession: loaded.launch.tmuxSession } : {}),
    markerType: "review",
    note: stringValue(args.note) ?? "project_control_reviewed",
  });
  return mcpJson({
    ok: true,
    mode: "project_control_mark_reviewed",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    auditPath: projectControlAuditPath(controller.controller),
    jobId: loaded.manifest.jobId,
    result: result as unknown as JsonObject,
  });
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
  const registryRootDir = registryRootFromArgs(args);
  const summaries = await listCodexGoalJobs({ registryRootDir });
  const jobIdPrefix = stringValue(args.jobIdPrefix);
  const matchingSummaries = jobIdPrefix
    ? summaries.filter((summary) => summary.jobId.startsWith(jobIdPrefix))
    : summaries;
  const limit = numberValue(args.limit);
  const selectedSummaries = limit ? matchingSummaries.slice(0, limit) : matchingSummaries;
  const staleAfterMs = numberValue(args.staleAfterMs) ?? 10 * 60_000;
  const tailLines = numberValue(args.tailLines) ?? 5;
  const rawJobs = await Promise.all(
    selectedSummaries.map((summary) =>
      buildCodexGoalOverviewItem({
        registryRootDir,
        jobId: summary.jobId,
        staleAfterMs,
        tailLines,
      }),
    ),
  );
  const workspaceConflicts = await buildCodexGoalWorkspaceConflicts(rawJobs);
  const conflictJobIds = workspaceConflictJobIds(workspaceConflicts);
  const jobs = rawJobs.map((job) => applyWorkspaceConflictToOverviewJob({
    job,
    conflictJobIds,
  }));
  const okJobs = jobs.filter((job) => job.ok);
  return {
    ok: jobs.every((job) => job.ok),
    safeToOperate: workspaceConflicts.length === 0,
    registryRootDir,
    ...(jobIdPrefix ? { jobIdPrefix } : {}),
    totalJobs: summaries.length,
    ...(jobIdPrefix ? { matchedJobs: matchingSummaries.length } : {}),
    returnedJobs: jobs.length,
    truncated: selectedSummaries.length < matchingSummaries.length,
    summary: {
      running: okJobs.filter((job) => job.workerAlive).length,
      silentStale: okJobs.filter((job) => job.silentStale).length,
      safeToContinue: okJobs.filter((job) => job.safeToContinue).length,
      needsHumanRelogin: okJobs.filter((job) => job.needsHumanRelogin).length,
      manualReview: okJobs.filter((job) => job.nextBestTool === "manual_review").length,
      completed: okJobs.filter((job) => job.resultStatus === "completed").length,
      workspaceConflicts: workspaceConflicts.length,
      blockedBySingleWriter: okJobs.filter((job) => job.blockedBySingleWriter).length,
      unavailable: jobs.filter((job) => !job.ok).length,
    },
    workspaceConflicts,
    jobs,
  };
}

async function reconcilePreviewCodexGoalJobs(args: JobWatchMcpArgs): Promise<JsonObject> {
  const registryRootDir = registryRootFromArgs(args);
  const staleAfterMs = numberValue(args.staleAfterMs) ?? 10 * 60_000;
  const tailLines = numberValue(args.tailLines) ?? 5;
  const explicitJobIds = jobIdsFromValue(args.jobIds);
  const result = await reconcileRunPreview({
    ...(explicitJobIds.length ? { runIds: explicitJobIds } : {}),
    policy: {
      continueSafeRuns: booleanValue(args.continueSafeJobs) === true,
      maxContinuesPerRun: numberValue(args.maxContinuesPerRun) ?? 1,
    },
    backend: {
      async listRunIds() {
        return (await listCodexGoalJobs({ registryRootDir }))
          .map((summary) => summary.jobId);
      },
      async inspectRun(jobId) {
        const item = await buildCodexGoalOverviewItem({
          registryRootDir,
          jobId,
          staleAfterMs,
          tailLines,
        });
        return codexOverviewItemToWatchStatus(item);
      },
      async continueRun(jobId) {
        const response = await continueStoredJob({
          registryRootDir,
          jobId,
          confirmContinue: true,
          ...(booleanValue(args.skipDoctor) === true ? { skipDoctor: true } : {}),
        }, {
          confirmKey: "confirmContinue",
          mode: "continue",
        });
        const summary = response.structuredContent;
        return {
          ok: summary.ok === true,
          ...(typeof summary.reason === "string" ? { reason: summary.reason } : {}),
          summary,
        };
      },
    },
  });
  return {
    ok: true,
    safeToOperate: result.ok,
    registryRootDir,
    mode: booleanValue(args.continueSafeJobs) === true
      ? "continue_safe_jobs"
      : "dry_run",
    checked: result.checked,
    continued: result.continued,
    decisions: result.decisions.map(reconcilePreviewDecisionJson),
  };
}

function reconcilePreviewDecisionJson(
  decision: RunReconcilePreviewDecision,
): JsonObject {
  if ("status" in decision) {
    return {
      ...decision,
      jobId: decision.runId,
      status: {
        ...decision.status,
        jobId: decision.runId,
      },
    };
  }
  return {
    ...decision,
    jobId: decision.runId,
  };
}

function jsonRecordFromProjectControlArgs(
  args: ProjectControlMcpArgs,
): ProjectControlOperationJsonRecord {
  return JSON.parse(JSON.stringify(args)) as ProjectControlOperationJsonRecord;
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
