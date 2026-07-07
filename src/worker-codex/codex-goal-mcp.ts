#!/usr/bin/env node
import { appendFile, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  DefaultRedactor,
  type SessionArtifact,
} from "@vioxen/subscription-runtime/core";
import { sessionArtifactFromCodexAuthJson } from "@vioxen/subscription-runtime/provider-codex";
import {
  LocalFileRunEventProjectionStateStore,
  LocalFileRunEventStore,
  LocalFileWorkerControlInboxStore,
  LocalControlledAgentStateStore,
} from "@vioxen/subscription-runtime/store-local-file";
import {
  buildLocalClaudeControlledAgentProfile,
  createLocalClaudeControlledAgentProvider,
  loadScopedClaudeSessionArtifact,
  watchClaudeRuns,
  type ClaudeRunWatchArgs,
} from "@vioxen/subscription-runtime/worker-local";
import {
  AccessBoundary,
  LaunchPlanStatus,
  NetworkAccessMode,
  ProjectAdmissionWorkerRole,
  RunObservationService,
  InterruptAndContinueWorkerUseCase,
  ProjectControlBroker,
  RunEventProviderKind,
  WorkerControlService,
  assessBaseRevision,
  assessWorkerHealth,
  buildControlledAgentLaunchPlan,
  buildControlledAgentLiveControllerState,
  buildControlledAgentProcessOwner,
  getControlledAgentStatus,
  reconcileControlledAgentRun,
  startControlledAgentRun,
  stopControlledAgentRun,
  buildWorkerStatusView,
  decideRunObservation,
  evaluateProjectAdmission,
  projectRunObservationEvents,
  projectRunReadModelsFromEvents,
  reconcileRunPreview,
  readTargetRevision,
  runEventProviderKindFromString,
  ProjectOperation,
  type BaseRevisionStatus,
  type RunEventReadResult,
  type RunObservationSnapshot,
  type ProjectAccessScope,
  type ProjectControlBrokerEvent,
  type ProjectControlBrokerPorts,
  type ProjectControlOperationResult,
  type RunReconcilePreviewDecision,
  type RunReconcilePreviewStatus,
  type ActiveAttemptRegistry,
  type WorkerControlActor,
  type WorkerControlDeliveryMode,
  type WorkerControlIntent,
  type WorkerControlPriority,
  type WorkerControlTarget,
  type ControlledAgentProcessOwner,
  type ControlledAgentProviderPort,
  type ControlledAgentSession,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexGoalJobToArgs,
  codexGoalObjectiveMaxChars,
  createCodexGoalJob,
  defaultCodexGoalJobRoot,
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
  codexGoalAccountSlots,
  codexGoalProgressPath,
  type CodexGoalRunConfig,
} from "./codex-goal-runner";
import {
  assertCodexGoalProviderSandboxModeAllowed,
  optionalCodexGoalEditMode,
  optionalCodexGoalProviderSandboxMode,
  parseCodexGoalEditMode,
} from "./codex-goal-control-modes";
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
  stopCodexGoalDirectProcess,
  stopCodexGoalTmux,
  tailCodexGoalLog,
  type CodexGoalLaunchInput,
  type CodexGoalOutputFormat,
} from "./codex-goal-ops";
import { CodexRunObservationAdapter } from "./codex-run-observation";
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
import { LocalGitRevisionReader } from "./codex-goal-git-revision";
import {
  buildCodexControlledAgentProfile,
  CodexControlledAgentProvider,
} from "./controlled-agent";
import {
  projectControllerCapacityDemand,
  recordProjectControllerCapacitySignal,
} from "./project-controller-capacity";
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
  putIfDefined,
  requiredRawString,
  requiredString,
  resolvePath,
  stringValue,
  stringsFromValue,
  tagValues,
  workerReportModeValue,
} from "./codex-goal-mcp-values";
import {
  jobIdInputSchema,
  jobRegistryInputSchema,
  optionalRunEventProviderKind,
  registryRootFromArgs,
  runEventRetentionPolicyFromArgs,
  runEventRootFromArgs,
  runEventTypeFilter,
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
  duplicateAccountGroups,
  listAccountPools,
  visibleCodexGoalAccountPoolSlots,
} from "./codex-goal-mcp-accounts";
import {
  readRuntimeResultBrief,
  safeTail,
} from "./codex-goal-mcp-runtime-result";
import {
  readCodexGoalLifecycleMarkers,
  writeCodexGoalMaintenancePauseEvent,
  writeCodexGoalReviewMarker,
  writeCodexGoalStopEvent,
  writeCodexGoalStoppedProgress,
} from "./codex-goal-mcp-lifecycle-markers";
import {
  matchesProjectControlPrefix,
  nodeErrorCode,
  pathInsideAnyProjectRoot,
  stringArrayArg,
  uniqueProjectControlStrings,
} from "./codex-goal-mcp-project-utils";
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
  CODEX_GOAL_CONTROL_SURFACE_SCHEMA,
  CODEX_GOAL_EXECUTION_ENGINE_SCHEMA,
  buildCodexGoalDecision,
  buildCodexGoalHandoff,
  codexGoalBriefHealthStatus,
  isHeartbeatOnlyNoOutputBrief,
  isSafeStartAction,
  latestIsoDate,
  nextActionForStatus,
  nextBestCommand,
  redactText,
  truncateText,
} from "./codex-goal-mcp-decision";
import {
  extractRecentCommands,
  redactLogTail,
} from "./codex-goal-mcp-log-view";
import {
  assertGitCurrentBranch,
  assertSafeGitCommitSha,
  assertSafeGitRefName,
  assertSafeGitRemoteName,
  execGit,
  execGitStdout,
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
const defaultAuthRoot = defaultCodexGoalAuthRoot;
const defaultTimeoutMs = 72 * 60 * 60 * 1000;
const controlledAgentProcessOwner = buildControlledAgentProcessOwner({
  runtimeVersion: serverVersion,
  ...(process.env.SUBSCRIPTION_RUNTIME_RELEASE_SHA === undefined
    ? {}
    : { runtimeSha: process.env.SUBSCRIPTION_RUNTIME_RELEASE_SHA }),
  pid: process.pid,
});
const controlledAgentProviders = new Map<string, ControlledAgentProviderPort>();

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

async function goalLaunchInput(args: GoalMcpArgs): Promise<CodexGoalLaunchInput> {
  const cwd = resolvePath(process.cwd(), args.cwd ?? process.cwd());
  const fileConfig = args.configPath
    ? await readGoalConfigFile(resolvePath(cwd, args.configPath))
    : {};
  const merged = mergeDefined(fileConfig, args);
  const jobRootDir = requiredString(merged.jobRootDir, "jobRootDir", cwd);
  const taskId = requiredRawString(merged.taskId, "taskId");
  const jobId = stringValue(merged.jobId);
  const authRootDir = resolvePath(
    cwd,
    stringValue(merged.authRootDir) ?? defaultAuthRoot,
  );
  const workspacePath = requiredString(merged.workspacePath, "workspacePath", cwd);
  const promptPath = requiredString(merged.promptPath, "promptPath", cwd);
  const accounts = codexGoalAccountSlots(accountNames(merged.accounts));
  if (!accounts.length) throw new Error("accounts are required");
  const controlModes = goalControlModesFromRecord(merged);
  const accessBoundary = optionalCodexGoalAccessBoundary(merged.accessBoundary);
  const projectAccessScope = parseCodexGoalProjectAccessScope(
    merged.projectAccessScope,
  );
  const networkAccess = optionalCodexGoalNetworkAccess(merged.networkAccess);
  const taskTimeoutMs = positiveIntegerValue(merged.taskTimeoutMs, "taskTimeoutMs") ??
    defaultTimeoutMs;
  const appServerStartupTimeoutMs = positiveIntegerValue(
    merged.appServerStartupTimeoutMs,
    "appServerStartupTimeoutMs",
  );
  const progressHeartbeatMs = positiveIntegerValue(
    merged.progressHeartbeatMs,
    "progressHeartbeatMs",
  ) ?? 60_000;
  const staleLockMs = positiveIntegerValue(merged.staleLockMs, "staleLockMs");
  const maxAccountCycles = positiveIntegerValue(
    merged.maxAccountCycles,
    "maxAccountCycles",
  ) ?? 5;
  const config: CodexGoalRunConfig = {
    ...(jobId === undefined ? {} : { jobId }),
    jobRootDir,
    authRootDir,
    workspacePath,
    promptPath,
    ...(stringValue(merged.codexGoalObjective)
      ? { codexGoalObjective: stringValue(merged.codexGoalObjective) as string }
      : {}),
    taskId,
    accounts,
    outputPath: resolvePath(
      cwd,
      stringValue(merged.outputPath) ??
        join(jobRootDir, `${taskId}.latest-result.json`),
    ),
    progressPath: resolvePath(
      cwd,
      stringValue(merged.progressPath) ??
        codexGoalProgressPath({ jobRootDir, taskId }),
    ),
    model: stringValue(merged.model) ?? "gpt-5.5",
    reasoningEffort:
      (stringValue(merged.reasoningEffort) ?? "high") as NonNullable<CodexGoalRunConfig["reasoningEffort"]>,
    serviceTier:
      (stringValue(merged.serviceTier) ?? "default") as NonNullable<CodexGoalRunConfig["serviceTier"]>,
    executionEngine:
      (stringValue(merged.executionEngine) ?? "app-server-goal") as NonNullable<CodexGoalRunConfig["executionEngine"]>,
    codexBinaryPath: stringValue(merged.codexBinaryPath) ?? "codex",
    ...controlModes,
    ...(accessBoundary === undefined ? {} : { accessBoundary }),
    ...(projectAccessScope === undefined ? {} : { projectAccessScope }),
    allowDangerFullAccess: booleanValue(merged.allowDangerFullAccess) ?? false,
    ...(networkAccess === undefined ? {} : { networkAccess }),
    taskTimeoutMs,
    ...(appServerStartupTimeoutMs === undefined
      ? {}
      : { appServerStartupTimeoutMs }),
    progressHeartbeatMs,
    ...(staleLockMs === undefined ? {} : { staleLockMs }),
    maxAccountCycles,
    allowDuplicateAccountIdentities:
      booleanValue(merged.allowDuplicateAccountIdentities) ?? false,
    requireGitWorkspace: booleanValue(merged.requireGitWorkspace) ?? true,
    prewarmOnStart: booleanValue(merged.prewarmOnStart) ?? false,
    ...(workerReportModeValue(merged.workerReportMode) === undefined
      ? {}
      : { workerReportMode: workerReportModeValue(merged.workerReportMode) }),
  };
  const stateRootDir = stringValue(merged.stateRootDir);
  const finalConfig = stateRootDir
    ? { ...config, stateRootDir: resolvePath(cwd, stateRootDir) }
    : config;
  return {
    config: finalConfig,
    ...(stringValue(merged.tmuxSession)
      ? { tmuxSession: stringValue(merged.tmuxSession) as string }
      : {}),
    cwd,
    logPath: resolvePath(
      cwd,
      stringValue(merged.logPath) ?? join(jobRootDir, `${taskId}.log`),
    ),
    format: (stringValue(merged.outputFormat) ?? "json") as CodexGoalOutputFormat,
    cliCommand: defaultCliCommand(import.meta.url),
  };
}

function goalControlModesFromRecord(
  value: JsonObject,
): Pick<CodexGoalRunConfig, "editMode" | "providerSandboxMode"> {
  const editModeValue = stringValue(value.editMode);
  const legacyPermissionModeValue = stringValue(value.permissionMode);
  const editMode = parseCodexGoalEditMode(
    editModeValue ?? legacyPermissionModeValue ?? "allow-edits",
    editModeValue === undefined && legacyPermissionModeValue !== undefined
      ? "permissionMode"
      : "editMode",
  );
  const providerSandboxMode = optionalCodexGoalProviderSandboxMode(
    stringValue(value.providerSandboxMode),
    "providerSandboxMode",
  );
  assertCodexGoalProviderSandboxModeAllowed({
    editMode,
    providerSandboxMode,
    fieldName: "providerSandboxMode",
  });
  return {
    editMode,
    ...(providerSandboxMode === undefined ? {} : { providerSandboxMode }),
  };
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

type CodexGoalProjectCreateWorktreeInput = {
  readonly sourceWorkspacePath: string;
  readonly realSourceWorkspacePath?: string;
  readonly path: string;
  readonly baseBranch?: string;
  readonly sourceRef?: string;
  readonly newBranch?: string;
  readonly workerRole?: ProjectAdmissionWorkerRole | `${ProjectAdmissionWorkerRole}`;
  readonly tags?: readonly string[];
};

type CodexGoalProjectIntegrateCommitInput = {
  readonly workspacePath: string;
  readonly realWorkspacePath?: string;
  readonly branch: string;
  readonly commitSha: string;
};

type CodexGoalProjectPushBranchInput = {
  readonly workspacePath: string;
  readonly realWorkspacePath?: string;
  readonly branch: string;
  readonly remote: string;
  readonly force: boolean;
};

function codexProjectControlBroker(input: {
  readonly registryRootDir: string;
  readonly controller: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
  readonly createManifest?: CodexGoalJobManifestInput;
  readonly createOverwrite?: boolean;
  readonly createWorktreeInput?: CodexGoalProjectCreateWorktreeInput;
  readonly integrateCommitInput?: CodexGoalProjectIntegrateCommitInput;
  readonly pushBranchInput?: CodexGoalProjectPushBranchInput;
  readonly startLaunch?: CodexGoalLaunchInput;
  readonly startSkipDoctor?: boolean;
  readonly stopLaunch?: CodexGoalLaunchInput;
  readonly reviewLaunch?: CodexGoalLaunchInput;
  readonly reviewNote?: string;
}): ProjectControlBroker {
  return new ProjectControlBroker({
    boundary: AccessBoundary.ProjectScopedControl,
    scope: input.scope,
  }, {
    ...codexProjectControlPorts(input),
    admission: codexProjectAdmissionGate({
      registryRootDir: input.registryRootDir,
      scope: input.scope,
      deps: codexProjectAdmissionDeps,
    }),
  });
}

function codexProjectControlPorts(input: {
  readonly registryRootDir: string;
  readonly controller: CodexGoalJobManifest;
  readonly createManifest?: CodexGoalJobManifestInput;
  readonly createOverwrite?: boolean;
  readonly createWorktreeInput?: CodexGoalProjectCreateWorktreeInput;
  readonly integrateCommitInput?: CodexGoalProjectIntegrateCommitInput;
  readonly pushBranchInput?: CodexGoalProjectPushBranchInput;
  readonly startLaunch?: CodexGoalLaunchInput;
  readonly startSkipDoctor?: boolean;
  readonly stopLaunch?: CodexGoalLaunchInput;
  readonly reviewLaunch?: CodexGoalLaunchInput;
  readonly reviewNote?: string;
}): ProjectControlBrokerPorts {
  return {
    audit: {
      async record(event) {
        await appendProjectControlAuditEvent(input.controller, event);
      },
    },
    registry: {
      async createJob() {
        if (!input.createManifest) {
          throw new Error("project_control_create_manifest_required");
        }
        const created = await createCodexGoalJob({
          registryRootDir: input.registryRootDir,
          manifest: input.createManifest,
          overwrite: input.createOverwrite ?? false,
        });
        return operationResult(created.jobId);
      },
      async writeReviewMarker(marker) {
        if (!input.reviewLaunch) {
          throw new Error("project_control_review_launch_required");
        }
        const status = await collectCodexGoalStatus(statusInput(input.reviewLaunch));
        const reviewPath = await writeCodexGoalReviewMarker({
          jobId: marker.jobId,
          taskId: input.reviewLaunch.config.taskId,
          jobRootDir: input.reviewLaunch.config.jobRootDir,
          note: input.reviewNote ?? marker.note ?? "project_control_reviewed",
          status,
        });
        return operationResult(reviewPath);
      },
    },
    supervisor: {
      async startWorker() {
        if (!input.startLaunch) {
          throw new Error("project_control_start_launch_required");
        }
        await prepareCodexGoalLaunchPaths(input.startLaunch);
        if (!input.startSkipDoctor) {
          const doctor = await doctorCodexGoal({
            config: input.startLaunch.config,
            ...(input.startLaunch.tmuxSession
              ? { tmuxSession: input.startLaunch.tmuxSession }
              : {}),
          });
          if (!doctor.ok) {
            throw new Error(`project_control_doctor_failed:${JSON.stringify(doctor)}`);
          }
        }
        const previousBrokeredStart =
          process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START;
        process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START = "1";
        let command: Awaited<ReturnType<typeof startCodexGoalTmux>>;
        try {
          command = await startCodexGoalTmux(input.startLaunch);
        } finally {
          if (previousBrokeredStart === undefined) {
            delete process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START;
          } else {
            process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START = previousBrokeredStart;
          }
        }
        return operationResult(command.preview);
      },
      async stopWorker() {
        if (!input.stopLaunch) {
          throw new Error("project_control_stop_launch_required");
        }
        const status = await collectCodexGoalStatus(statusInput(input.stopLaunch));
        if (input.stopLaunch.tmuxSession) {
          if (status.tmuxAlive === false) {
            return noopOperationResult(
              buildCodexGoalStopTmuxCommand(input.stopLaunch.tmuxSession).preview,
              "Worker tmux session is already gone.",
            );
          }
          try {
            const command = await stopCodexGoalTmux(input.stopLaunch.tmuxSession);
            return operationResult(command.preview);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/can't find session|no server running/i.test(message)) {
              return noopOperationResult(
                buildCodexGoalStopTmuxCommand(input.stopLaunch.tmuxSession).preview,
                "Worker tmux session is already gone.",
              );
            }
            throw error;
          }
        }
        const command = stopCodexGoalDirectProcess(status);
        if (command.status === "terminated") {
          return operationResult(command.preview);
        }
        if (command.status === "process_gone" || command.status === "pid_missing") {
          return noopOperationResult(
            command.preview,
            command.status === "process_gone"
              ? "Worker process is already gone."
              : "Worker has no direct process pid to stop.",
          );
        }
        throw new Error("project_control_stop_untrusted_process");
      },
    },
    workspace: {
      async createWorktree() {
        if (!input.createWorktreeInput) {
          throw new Error("project_control_worktree_input_required");
        }
        await mkdir(dirname(input.createWorktreeInput.path), {
          recursive: true,
          mode: 0o700,
        });
        const sourceRef =
          input.createWorktreeInput.sourceRef ?? input.createWorktreeInput.baseBranch;
        const args = [
          "-C",
          input.createWorktreeInput.sourceWorkspacePath,
          "worktree",
          "add",
          ...(input.createWorktreeInput.newBranch
            ? ["-b", input.createWorktreeInput.newBranch]
            : []),
          input.createWorktreeInput.path,
          ...(sourceRef ? [sourceRef] : []),
        ];
        await execGit(args);
        return operationResult(input.createWorktreeInput.path);
      },
    },
    git: {
      async integrateCommit() {
        if (!input.integrateCommitInput) {
          throw new Error("project_control_integrate_commit_input_required");
        }
        await assertGitCurrentBranch({
          workspacePath: input.integrateCommitInput.workspacePath,
          branch: input.integrateCommitInput.branch,
        });
        await execGit([
          "-C",
          input.integrateCommitInput.workspacePath,
          "cherry-pick",
          "--ff",
          input.integrateCommitInput.commitSha,
        ]);
        return operationResult(input.integrateCommitInput.commitSha);
      },
      async pushBranch() {
        if (!input.pushBranchInput) {
          throw new Error("project_control_push_branch_input_required");
        }
        await assertGitCurrentBranch({
          workspacePath: input.pushBranchInput.workspacePath,
          branch: input.pushBranchInput.branch,
        });
        await execGit([
          "-C",
          input.pushBranchInput.workspacePath,
          "push",
          ...(input.pushBranchInput.force ? ["--force-with-lease"] : []),
          input.pushBranchInput.remote,
          input.pushBranchInput.branch,
        ]);
        return operationResult(
          `${input.pushBranchInput.remote}/${input.pushBranchInput.branch}`,
        );
      },
    },
  };
}

async function appendProjectControlAuditEvent(
  controller: CodexGoalJobManifest,
  event: ProjectControlBrokerEvent,
): Promise<void> {
  const auditPath = join(
    controller.jobRootDir,
    `${controller.taskId}.project-control-events.jsonl`,
  );
  await mkdir(dirname(auditPath), { recursive: true, mode: 0o700 });
  await appendFile(auditPath, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function projectControlAuditPath(controller: CodexGoalJobManifest): string {
  return join(
    controller.jobRootDir,
    `${controller.taskId}.project-control-events.jsonl`,
  );
}

function operationResult(resourceId: string): ProjectControlOperationResult {
  return {
    status: "applied",
    resourceId,
  };
}

function noopOperationResult(
  resourceId: string,
  safeMessage: string,
): ProjectControlOperationResult {
  return {
    status: "noop",
    resourceId,
    safeMessage,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function readTextFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function assertReadablePrompt(input: {
  readonly promptPath: string;
  readonly expectedBody?: string;
}): Promise<{ readonly promptPath: string; readonly bytes: number }> {
  const body = await readTextFileIfExists(input.promptPath);
  if (body === null || body.trim().length === 0) {
    throw new Error("project_control_prompt_missing_before_start");
  }
  if (input.expectedBody !== undefined && body !== input.expectedBody) {
    throw new Error("project_control_prompt_mismatch");
  }
  return {
    promptPath: input.promptPath,
    bytes: Buffer.byteLength(body, "utf8"),
  };
}

async function createOrReuseProjectWorktree(input: {
  readonly broker: ProjectControlBroker;
  readonly createWorktreeInput: CodexGoalProjectCreateWorktreeInput;
}): Promise<{
  readonly result: ProjectControlOperationResult;
  readonly created: boolean;
}> {
  if (await pathExists(input.createWorktreeInput.path)) {
    await assertReusableProjectWorktree(input.createWorktreeInput.path);
    return {
      result: noopOperationResult(
        input.createWorktreeInput.path,
        "existing clean git worktree reused for idempotent refill",
      ),
      created: false,
    };
  }
  try {
    return {
      result: await input.broker.createWorktree(input.createWorktreeInput),
      created: true,
    };
  } catch (error) {
    if (await pathExists(input.createWorktreeInput.path)) {
      await assertReusableProjectWorktree(input.createWorktreeInput.path);
      return {
        result: noopOperationResult(
          input.createWorktreeInput.path,
          "existing clean git worktree reused after create race",
        ),
        created: false,
      };
    }
    throw error;
  }
}

async function assertReusableProjectWorktree(path: string): Promise<void> {
  try {
    await execGitStdout(["-C", path, "rev-parse", "--show-toplevel"]);
    const status = await execGitStdout(["-C", path, "status", "--porcelain"]);
    if (status.trim().length > 0) {
      throw new Error("project_control_existing_worktree_dirty");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "project_control_existing_worktree_dirty"
    ) {
      throw error;
    }
    throw new Error("project_control_existing_worktree_invalid");
  }
}

async function rollbackProjectRefillPartial(input: {
  readonly sourceWorkspacePath: string;
  readonly workspacePath: string;
  readonly promptPath: string;
  readonly registryRootDir: string;
  readonly jobId: string;
  readonly worktreeCreated: boolean;
  readonly promptWritten: boolean;
}): Promise<readonly string[]> {
  const rolledBack: string[] = [];
  if (input.promptWritten) {
    await rm(input.promptPath, { force: true });
    rolledBack.push("prompt");
  }
  await removeEmptyDir(dirname(input.promptPath));
  await removeEmptyDir(join(input.registryRootDir, input.jobId));
  if (input.worktreeCreated) {
    try {
      await execGit([
        "-C",
        input.sourceWorkspacePath,
        "worktree",
        "remove",
        "--force",
        input.workspacePath,
      ]);
      rolledBack.push("worktree");
    } catch {
      rolledBack.push("worktree-remove-failed");
    }
  }
  return rolledBack;
}

async function createOrReuseProjectJob(input: {
  readonly broker: ProjectControlBroker;
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly manifest: CodexGoalJobManifestInput;
  readonly promptBody: string;
  readonly workerRole?: ProjectAdmissionWorkerRole | `${ProjectAdmissionWorkerRole}`;
}): Promise<{
  readonly result: ProjectControlOperationResult;
  readonly manifest: CodexGoalJobManifest;
}> {
  const existing = await readExistingCodexGoalJob({
    registryRootDir: input.registryRootDir,
    jobId: input.manifest.jobId,
  });
  if (existing) {
    await assertExistingRefillJobMatches({
      existing,
      expected: input.manifest,
      promptBody: input.promptBody,
    });
    return {
      result: noopOperationResult(
        existing.jobId,
        "existing job manifest and prompt reused for idempotent refill",
      ),
      manifest: existing,
    };
  }
  const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(
    input.manifest.workspacePath,
    input.scope,
  );
  const result = await input.broker.createJob({
    jobId: input.manifest.jobId,
    registryRoot: input.registryRootDir,
    workspacePath: input.manifest.workspacePath,
    ...(realWorkspacePath ? { realWorkspacePath } : {}),
    ...(input.manifest.tmuxSession
      ? { tmuxSession: input.manifest.tmuxSession }
      : {}),
    accounts: input.manifest.accounts,
    ...(input.workerRole ? { workerRole: input.workerRole } : {}),
    ...(input.manifest.tags ? { tags: input.manifest.tags } : {}),
  });
  return {
    result,
    manifest: await readCodexGoalJob({
      registryRootDir: input.registryRootDir,
      jobId: input.manifest.jobId,
    }),
  };
}

async function readExistingCodexGoalJob(input: {
  readonly registryRootDir: string;
  readonly jobId: string;
}): Promise<CodexGoalJobManifest | null> {
  try {
    return await readCodexGoalJob(input);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function assertExistingRefillJobMatches(input: {
  readonly existing: CodexGoalJobManifest;
  readonly expected: CodexGoalJobManifestInput;
  readonly promptBody: string;
}): Promise<void> {
  const mismatches = projectRefillJobMismatches(input.existing, input.expected);
  if (mismatches.length > 0) {
    throw new Error(`project_control_existing_job_mismatch:${mismatches.join(",")}`);
  }
  await assertReadablePrompt({
    promptPath: input.expected.promptPath,
    expectedBody: input.promptBody,
  });
}

function projectRefillJobMismatches(
  existing: CodexGoalJobManifest,
  expected: CodexGoalJobManifestInput,
): readonly string[] {
  const mismatches: string[] = [];
  const checks: Array<readonly [string, unknown, unknown]> = [
    ["jobRootDir", existing.jobRootDir, expected.jobRootDir],
    ["workspacePath", existing.workspacePath, expected.workspacePath],
    ["promptPath", existing.promptPath, expected.promptPath],
    ["taskId", existing.taskId, expected.taskId],
    ["tmuxSession", existing.tmuxSession, expected.tmuxSession],
    ["accessBoundary", existing.accessBoundary, expected.accessBoundary],
    ["networkAccess", existing.networkAccess, expected.networkAccess],
    ["allowDangerFullAccess", existing.allowDangerFullAccess, expected.allowDangerFullAccess],
    ["accounts", existing.accounts, expected.accounts],
    ["projectAccessScope", existing.projectAccessScope, expected.projectAccessScope],
  ];
  for (const [field, left, right] of checks) {
    if (JSON.stringify(left ?? null) !== JSON.stringify(right ?? null)) {
      mismatches.push(field);
    }
  }
  return mismatches;
}

async function removeEmptyDir(path: string): Promise<void> {
  try {
    const entries = await readdir(path);
    if (entries.length === 0) await rmdir(path);
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT" && nodeErrorCode(error) !== "ENOTDIR") {
      throw error;
    }
  }
}

async function projectControllerLaunchPlan(args: ProjectControllerLaunchPlanMcpArgs) {
  const controller = await loadProjectControlController(args);
  const state = projectControllerState(args, controller);
  const profile = projectControllerProfile(args, state);
  const plan = projectControllerLaunchInput(controller, state, profile);
  const ready = plan.status === LaunchPlanStatus.Ready;
  return mcpJson({
    ok: ready,
    mode: "project_controller_launch_plan",
    controllerJobId: controller.controller.jobId,
    providerKind: profile.providerKind,
    registryRootDir: controller.registryRootDir,
    stateDir: state.stateDir,
    sessionId: state.sessionId,
    rawShellMode: args.rawShellMode ?? "disabled-by-provider",
    status: plan.status,
    ...(ready
      ? {
          session: plan.session,
          ...projectControllerProfileReadyJson(profile),
          evidence: plan.evidence,
        }
      : {
          reason: plan.reason,
          accessReason: plan.accessReason,
          evidence: plan.evidence,
          allowedTools: projectControllerAllowedTools(profile),
          safeMessage:
            "Controlled LLM controller launch is blocked until the provider can enforce broker-only tools without raw shell.",
        }),
  });
}

async function projectControllerStart(args: ProjectControllerLaunchPlanMcpArgs) {
  const controller = await loadProjectControlController(args);
  const state = projectControllerState(args, controller);
  const profile = projectControllerProfile(args, state);
  const plan = projectControllerLaunchInput(controller, state, profile);
  if (plan.status === LaunchPlanStatus.Blocked) {
    return mcpJson({
      ok: false,
      mode: "project_controller_start",
      controllerJobId: controller.controller.jobId,
      providerKind: profile.providerKind,
      registryRootDir: controller.registryRootDir,
      stateDir: state.stateDir,
      sessionId: state.sessionId,
      status: plan.status,
      reason: plan.reason,
      accessReason: plan.accessReason,
      evidence: plan.evidence,
      safeMessage:
        "Controlled LLM controller start is blocked by the fail-closed launch plan.",
    });
  }
  const launch = await goalLaunchInput(codexGoalJobToArgs(controller.controller));
  const providerInput = await projectControllerProvider({
    args,
    controller,
    launch,
    profile,
    state,
  });
  const capacityAccountId = stringValue(providerInput.account?.name);
  const result = await startControlledAgentRun({
    controllerJobId: controller.controller.jobId,
    sessionId: state.sessionId,
    stateDir: state.stateDir,
    boundary: AccessBoundary.ProjectScopedControl,
    projectAccessScope: controller.scope,
    provider: profile.enforcement,
    networkAccess: NetworkAccessMode.Restricted,
  }, {
    provider: providerInput.provider,
    stateStore: state.store,
    events: state.store,
    owner: controlledAgentProcessOwner,
    ownerLiveness: { isLive: controlledAgentOwnerIsLive },
    recoverOwnerlessActiveRunAfterMs: 10 * 60 * 1000,
    ...(capacityAccountId === undefined ? {} : {
      capacity: {
        accountId: capacityAccountId,
        demand: projectControllerCapacityDemand(launch.config),
      },
    }),
  });
  if (!result.ok) {
    if ("reason" in result) {
      return mcpJson({
        ok: false,
        mode: "project_controller_start",
        controllerJobId: controller.controller.jobId,
        providerKind: profile.providerKind,
        registryRootDir: controller.registryRootDir,
        stateDir: state.stateDir,
        sessionId: state.sessionId,
        reason: result.reason,
        session: result.session,
        run: result.run,
        safeMessage:
          "Controlled LLM controller already has an active run. Use status, stop or reconcile before starting another run.",
      });
    }
    return mcpJson({
      ok: false,
      mode: "project_controller_start",
      controllerJobId: controller.controller.jobId,
      providerKind: profile.providerKind,
      registryRootDir: controller.registryRootDir,
      stateDir: state.stateDir,
      sessionId: state.sessionId,
      status: result.plan.status,
      reason: result.plan.reason,
      evidence: result.plan.evidence,
      safeMessage:
        "Controlled LLM controller start was blocked by the controlled-agent use case.",
    });
  }
  controlledAgentProviders.set(state.sessionId, providerInput.provider);
  return mcpJson({
    ok: true,
    mode: "project_controller_start",
    controllerJobId: controller.controller.jobId,
    providerKind: profile.providerKind,
    registryRootDir: controller.registryRootDir,
    stateDir: state.stateDir,
    sessionId: state.sessionId,
    status: result.run.status,
    run: result.run,
    provider: result.provider,
    liveController: buildControlledAgentLiveControllerState({
      session: result.session,
      providerAttached: true,
      currentOwner: controlledAgentProcessOwner,
    }),
    ...(providerInput.account === undefined ? {} : { account: providerInput.account }),
    ...(providerInput.sessionArtifact === undefined
      ? {}
      : { sessionArtifact: providerInput.sessionArtifact }),
    allowedTools: projectControllerAllowedTools(profile),
    safeMessage: providerInput.safeMessage,
    evidence: plan.evidence,
  });
}

async function projectControllerStatus(args: ProjectControllerLaunchPlanMcpArgs) {
  const controller = await loadProjectControlController(args);
  const state = projectControllerState(args, controller);
  const result = await getControlledAgentStatus(state.sessionId, {
    stateStore: state.store,
  });
  const provider = controlledAgentProviders.get(state.sessionId);
  let observed: Awaited<ReturnType<ControlledAgentProviderPort["status"]>> | undefined;
  let providerStatusError: string | undefined;
  if (result.ok && provider) {
    try {
      observed = await provider.status({ session: result.session, run: result.run });
    } catch (error) {
      providerStatusError = safeObservationErrorMessage(error);
    }
  }
  const liveController = result.ok
    ? buildControlledAgentLiveControllerState({
        session: result.session,
        providerAttached: provider !== undefined,
        currentOwner: controlledAgentProcessOwner,
        providerObservedStatus: observed?.status,
        providerStatusFailed: providerStatusError !== undefined,
      })
    : buildControlledAgentLiveControllerState({
      providerAttached: false,
      currentOwner: controlledAgentProcessOwner,
    });
  return mcpJson({
    ok: result.ok,
    mode: "project_controller_status",
    controllerJobId: controller.controller.jobId,
    providerKind: projectControllerProviderKind(args),
    registryRootDir: controller.registryRootDir,
    stateDir: state.stateDir,
    sessionId: state.sessionId,
    reason: providerStatusError === undefined ? result.reason : "provider_status_failed",
    ...(result.session === undefined ? {} : { session: result.session }),
    ...(result.ok && "run" in result ? { run: result.run } : {}),
    ...(observed === undefined ? {} : { providerObserved: observed }),
    ...(providerStatusError === undefined
      ? {}
      : { providerObservedError: { safeMessage: providerStatusError } }),
    liveController,
    safeMessage: providerStatusError !== undefined
      ? "Controller state is persisted, but provider status failed in this MCP process."
      : result.ok
      ? provider
        ? "Controller state is persisted and provider liveness was observed in this MCP process."
        : "Controller state is persisted, but provider liveness is unavailable in this MCP process."
      : "No persisted controlled-agent session/run exists for this controller.",
  });
}

async function projectControllerConsumeGuidance(args: ProjectControllerLaunchPlanMcpArgs) {
  const controller = await loadProjectControlController(args);
  const launch = await goalLaunchInput(codexGoalJobToArgs(controller.controller));
  const control = codexGoalWorkerControlService(launch);
  const target = codexGoalWorkerControlTarget({
    manifest: controller.controller,
    launch,
  });
  const deliveryAttemptId = stringValue(args.deliveryAttemptId) ??
    `${controller.controller.jobId}:controller-guidance:${new Date().toISOString()}`;
  const batch = await control.consumeForContinuation({
    target,
    deliveryAttemptId,
  });
  const decision = await control.getDecision({ target });
  return mcpJson({
    ok: true,
    mode: "project_controller_consume_guidance",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    deliveryAttemptId: batch.deliveryAttemptId,
    consumedCount: batch.signalIds.length,
    signalIds: batch.signalIds,
    ...(batch.message === undefined ? {} : { message: batch.message }),
    decision: workerControlDecisionJson(decision, false),
  });
}

async function projectControllerStop(args: ProjectControllerLaunchPlanMcpArgs) {
  const controller = await loadProjectControlController(args);
  const state = projectControllerState(args, controller);
  const result = await getControlledAgentStatus(state.sessionId, {
    stateStore: state.store,
  });
  const provider = controlledAgentProviders.get(state.sessionId);
  if (result.ok && provider) {
    const stopped = await stopControlledAgentRun({
      sessionId: state.sessionId,
      reason: stringValue(args.reason) ?? "project_controller_stop",
    }, {
      stateStore: state.store,
      provider,
      events: state.store,
    });
    if (stopped.ok) controlledAgentProviders.delete(state.sessionId);
    return mcpJson({
      ok: stopped.ok,
      mode: "project_controller_stop",
      controllerJobId: controller.controller.jobId,
      providerKind: projectControllerProviderKind(args),
      registryRootDir: controller.registryRootDir,
      stateDir: state.stateDir,
      sessionId: state.sessionId,
      reason: stopped.reason,
      ...(stopped.ok ? { session: stopped.session, run: stopped.run } : {}),
      liveController: buildControlledAgentLiveControllerState({
        session: stopped.ok ? stopped.session : result.session,
        providerAttached: false,
        currentOwner: controlledAgentProcessOwner,
      }),
      safeMessage: stopped.ok
        ? "Controlled-agent provider stopped through the safe provider adapter."
        : "Controlled-agent stop failed before reaching provider stop.",
    });
  }
  return mcpJson({
    ok: false,
    mode: "project_controller_stop",
    controllerJobId: controller.controller.jobId,
    providerKind: projectControllerProviderKind(args),
    registryRootDir: controller.registryRootDir,
    stateDir: state.stateDir,
    sessionId: state.sessionId,
    reason: result.ok
      ? "controlled_agent_provider_runner_not_connected"
      : result.reason,
    ...(result.ok ? { session: result.session, run: result.run } : {}),
    liveController: buildControlledAgentLiveControllerState({
      session: result.ok ? result.session : undefined,
      providerAttached: false,
      currentOwner: controlledAgentProcessOwner,
    }),
    safeMessage: result.ok
      ? "A safe provider runner is required to stop a live controlled-agent controller. Do not kill unrelated processes or use danger_full_access from this tool."
      : "No persisted controlled-agent run exists to stop.",
  });
}

async function projectControllerReconcile(args: ProjectControllerLaunchPlanMcpArgs) {
  const controller = await loadProjectControlController(args);
  const state = projectControllerState(args, controller);
  const result = await getControlledAgentStatus(state.sessionId, {
    stateStore: state.store,
  });
  const provider = controlledAgentProviders.get(state.sessionId);
  if (result.ok && provider) {
    const reconciled = await reconcileControlledAgentRun(state.sessionId, {
      stateStore: state.store,
      provider,
      events: state.store,
    });
    if (reconciled.ok) {
      const launch = await goalLaunchInput(codexGoalJobToArgs(controller.controller));
      recordControllerCapacitySignal({
        launch,
        controllerJobId: controller.controller.jobId,
        run: reconciled.run,
      });
    }
    return mcpJson({
      ok: reconciled.ok,
      mode: "project_controller_reconcile",
      controllerJobId: controller.controller.jobId,
      providerKind: projectControllerProviderKind(args),
      registryRootDir: controller.registryRootDir,
      stateDir: state.stateDir,
      sessionId: state.sessionId,
      reason: reconciled.reason,
      ...(reconciled.session === undefined ? {} : { session: reconciled.session }),
      ...(reconciled.run === undefined ? {} : { run: reconciled.run }),
      liveController: buildControlledAgentLiveControllerState({
        session: reconciled.session,
        providerAttached: true,
        currentOwner: controlledAgentProcessOwner,
      }),
      ...(reconciled.ok || reconciled.safeMessage === undefined ? {} : {
        safeMessage: reconciled.safeMessage,
      }),
    });
  }
  return mcpJson({
    ok: false,
    mode: "project_controller_reconcile",
    controllerJobId: controller.controller.jobId,
    providerKind: projectControllerProviderKind(args),
    registryRootDir: controller.registryRootDir,
    stateDir: state.stateDir,
    sessionId: state.sessionId,
    reason: result.ok
      ? "controlled_agent_provider_runner_not_connected"
      : result.reason,
    ...(result.ok ? { session: result.session, run: result.run } : {}),
    liveController: buildControlledAgentLiveControllerState({
      session: result.ok ? result.session : undefined,
      providerAttached: false,
      currentOwner: controlledAgentProcessOwner,
    }),
    safeMessage: result.ok
      ? "A safe provider runner is required to reconcile provider liveness. Persisted state is available, but runtime liveness cannot be asserted."
      : "No persisted controlled-agent run exists to reconcile.",
  });
}

function recordControllerCapacitySignal(input: {
  readonly launch: CodexGoalLaunchInput;
  readonly controllerJobId: string;
  readonly run: Parameters<typeof recordProjectControllerCapacitySignal>[0]["run"];
}): void {
  recordProjectControllerCapacitySignal({
    stateRootDir: codexGoalStateRootDir(input.launch),
    controllerJobId: input.controllerJobId,
    config: input.launch.config,
    run: input.run,
  });
}

function projectControllerState(
  args: ProjectControllerLaunchPlanMcpArgs,
  controller: {
    readonly controller: CodexGoalJobManifest;
  },
): {
  readonly stateDir: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly store: LocalControlledAgentStateStore;
} {
  const cwd = resolvePath(process.cwd(), stringValue(args.cwd) ?? process.cwd());
  const stateDir = resolvePath(
    cwd,
    stringValue(args.stateDir) ??
      join(controller.controller.jobRootDir, "controlled-agent"),
  );
  return {
    cwd,
    stateDir,
    sessionId: projectControllerSessionId(
      controller.controller.jobId,
      projectControllerProviderKind(args),
    ),
    store: new LocalControlledAgentStateStore({ rootDir: stateDir }),
  };
}

type ProjectControllerProviderKind =
  | RunEventProviderKind.Codex
  | RunEventProviderKind.Claude;

type ProjectControllerProfile =
  | ReturnType<typeof buildCodexControlledAgentProfile>
  | ReturnType<typeof buildLocalClaudeControlledAgentProfile>;

function projectControllerProviderKind(
  args: ProjectControllerLaunchPlanMcpArgs,
): ProjectControllerProviderKind {
  const providerKind = optionalRunEventProviderKind(args.providerKind) ??
    RunEventProviderKind.Codex;
  if (
    providerKind === RunEventProviderKind.Codex ||
    providerKind === RunEventProviderKind.Claude
  ) {
    return providerKind;
  }
  throw new Error(`project_controller_provider_kind_unsupported:${providerKind}`);
}

function projectControllerSessionId(
  controllerJobId: string,
  providerKind: ProjectControllerProviderKind,
): string {
  if (providerKind === RunEventProviderKind.Codex) {
    return `${controllerJobId}:controlled-agent`;
  }
  return `${controllerJobId}:controlled-agent:${providerKind}`;
}

function projectControllerProfile(
  args: ProjectControllerLaunchPlanMcpArgs,
  state: {
    readonly stateDir: string;
    readonly cwd: string;
  },
): ProjectControllerProfile {
  const common = {
    stateDir: state.stateDir,
    ...(stringValue(args.mcpServerName) === undefined
      ? {}
      : { mcpServerName: stringValue(args.mcpServerName) as string }),
    ...(stringValue(args.mcpCommand) === undefined
      ? {}
      : { mcpCommand: stringValue(args.mcpCommand) as string }),
    ...(args.mcpArgs === undefined ? {} : { mcpArgs: stringArrayArg(args.mcpArgs) }),
    ...(stringValue(args.mcpCwd) === undefined
      ? {}
      : { mcpCwd: resolvePath(state.cwd, stringValue(args.mcpCwd) as string) }),
  };
  if (projectControllerProviderKind(args) === RunEventProviderKind.Claude) {
    return buildLocalClaudeControlledAgentProfile(common);
  }
  return buildCodexControlledAgentProfile({
    ...common,
    rawShellMode: args.rawShellMode ?? "disabled-by-provider",
  });
}

function projectControllerLaunchInput(
  controller: {
    readonly controller: CodexGoalJobManifest;
    readonly scope: ProjectAccessScope;
  },
  state: {
    readonly sessionId: string;
    readonly stateDir: string;
  },
  profile: ProjectControllerProfile,
) {
  return buildControlledAgentLaunchPlan({
    controllerJobId: controller.controller.jobId,
    sessionId: state.sessionId,
    stateDir: state.stateDir,
    boundary: AccessBoundary.ProjectScopedControl,
    projectAccessScope: controller.scope,
    provider: profile.enforcement,
    networkAccess: NetworkAccessMode.Restricted,
  });
}

function projectControllerAllowedTools(
  profile: ProjectControllerProfile,
): readonly string[] {
  return profile.providerKind === RunEventProviderKind.Codex
    ? profile.enabledTools
    : profile.allowedTools;
}

function projectControllerProfileReadyJson(
  profile: ProjectControllerProfile,
): JsonObject {
  if (profile.providerKind === RunEventProviderKind.Codex) {
    return {
      allowedTools: profile.enabledTools,
      codexHome: profile.codexHome,
      configToml: profile.configToml,
      rulesText: profile.rulesText,
    };
  }
  return {
    allowedTools: profile.allowedTools,
    disallowedTools: profile.disallowedTools,
    configDir: profile.configDir,
    mcpConfig: profile.mcpConfig,
    strictMcpConfig: profile.strictMcpConfig,
    appendSystemPrompt: profile.appendSystemPrompt,
  };
}

async function projectControllerProvider(input: {
  readonly args: ProjectControllerLaunchPlanMcpArgs;
  readonly controller: {
    readonly controller: CodexGoalJobManifest;
    readonly registryRootDir: string;
    readonly scope: ProjectAccessScope;
  };
  readonly launch: CodexGoalLaunchInput;
  readonly profile: ProjectControllerProfile;
  readonly state: {
    readonly cwd: string;
  };
}): Promise<{
  readonly provider: ControlledAgentProviderPort;
  readonly account?: JsonObject;
  readonly sessionArtifact?: JsonObject;
  readonly safeMessage: string;
}> {
  if (input.profile.providerKind === RunEventProviderKind.Claude) {
    const loaded = await controlledAgentClaudeSessionArtifact(input);
    const controllerObjective = await projectControllerObjectiveWithPendingGuidance(
      input.controller,
      input.launch,
    );
    return {
      provider: createLocalClaudeControlledAgentProvider({
        profile: input.profile,
        sessionArtifact: loaded.sessionArtifact,
        workspacePath: input.launch.config.workspacePath,
        ...(stringValue(input.args.claudePath) === undefined
          ? {}
          : { claudePath: stringValue(input.args.claudePath) as string }),
        ...(input.launch.config.model === undefined ? {} : { model: input.launch.config.model }),
        ...(input.args.maxGoalTurns === undefined
          ? {}
          : { maxTurns: input.args.maxGoalTurns }),
        controllerObjective,
      }),
      sessionArtifact: {
        path: loaded.path,
        sha256Prefix: loaded.sha256Prefix,
      },
      safeMessage:
        "Claude broker-only controlled-agent provider started with strict MCP broker tools.",
    };
  }

  const account = await controlledAgentCodexAccount({
    controller: input.controller,
    launch: input.launch,
  });
  const controllerObjective = await projectControllerObjectiveWithPendingGuidance(
    input.controller,
    input.launch,
  );
  return {
    provider: new CodexControlledAgentProvider({
      profile: input.profile,
      sessionArtifact: account.sessionArtifact,
      workspacePath: input.launch.config.workspacePath,
      codexBinaryPath: input.launch.config.codexBinaryPath ?? "codex",
      controllerObjective,
      ...(input.launch.config.model === undefined ? {} : { model: input.launch.config.model }),
      ...(input.launch.config.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: input.launch.config.reasoningEffort }),
      ...(input.launch.config.serviceTier === undefined
        ? {}
        : { serviceTier: input.launch.config.serviceTier }),
      ...(input.args.maxGoalTurns === undefined
        ? {}
        : { maxGoalTurns: input.args.maxGoalTurns }),
    }),
    account: {
      name: account.name,
      ...(account.authJsonSha256Prefix === undefined
        ? {}
        : { authJsonSha256Prefix: account.authJsonSha256Prefix }),
    },
    safeMessage:
      "Codex broker-only controlled-agent provider started with native app-server environments disabled.",
  };
}

async function projectControllerObjectiveWithPendingGuidance(
  controller: {
    readonly controller: CodexGoalJobManifest;
  },
  launch: CodexGoalLaunchInput,
): Promise<string> {
  const baseObjective = await readFile(launch.config.promptPath, "utf8");
  const guidanceContext = await projectControllerPendingGuidanceContext(controller, launch);
  return guidanceContext === undefined
    ? baseObjective
    : `${baseObjective}\n\n${guidanceContext}`;
}

async function projectControllerPendingGuidanceContext(
  controller: {
    readonly controller: CodexGoalJobManifest;
  },
  launch: CodexGoalLaunchInput,
): Promise<string | undefined> {
  try {
    const control = codexGoalWorkerControlService(launch);
    const target = codexGoalWorkerControlTarget({
      manifest: controller.controller,
      launch,
    });
    const decision = await control.getDecision({ target });
    return projectControllerPendingGuidancePromptContext({
      pendingCount: decision.pendingSignals.length,
      deliverableSignals: decision.deliverableSignals,
    });
  } catch {
    return undefined;
  }
}

export function projectControllerPendingGuidancePromptContext(input: {
  readonly pendingCount: number;
  readonly deliverableSignals: readonly {
    readonly signal: {
      readonly createdAt: Date;
      readonly createdBy: string;
      readonly priority: string;
      readonly body: string;
    };
  }[];
}): string | undefined {
  const deliverable = input.deliverableSignals
    .slice()
    .sort((left, right) =>
      right.signal.createdAt.getTime() - left.signal.createdAt.getTime()
    )
    .slice(0, 5);
  if (deliverable.length === 0) return undefined;

  const lines = [
    "Pending controller guidance from durable inbox:",
    "- Treat this as read-only context for this run.",
    "- Before applying it, call codex_goal_project_controller_consume_guidance for your controller job so the inbox records delivery.",
    `- pendingCount=${input.pendingCount} deliverableCount=${input.deliverableSignals.length}`,
  ];
  for (const view of deliverable) {
    const signal = view.signal;
    lines.push(
      `- ${signal.createdAt.toISOString()} ${signal.createdBy}/${signal.priority}: ${
        truncateText(redactPromptGuidanceText(signal.body), 800)
      }`,
    );
  }
  if (input.deliverableSignals.length > deliverable.length) {
    lines.push(
      `- ${input.deliverableSignals.length - deliverable.length} older deliverable guidance item(s) omitted from prompt context.`,
    );
  }
  return lines.join("\n");
}

function redactPromptGuidanceText(value: string): string {
  return redactText(value).replace(/[A-Za-z0-9_=-]{32,}/g, "[redacted]");
}

async function controlledAgentCodexAccount(input: {
  readonly controller: {
    readonly scope: ProjectAccessScope;
  };
  readonly launch: CodexGoalLaunchInput;
}): Promise<{
  readonly name: string;
  readonly authJsonSha256Prefix?: string;
  readonly sessionArtifact: SessionArtifact;
}> {
  if (!input.controller.scope.authRoot) {
    throw new Error("project_control_controller_auth_root_scope_required");
  }
  if (resolve(input.launch.config.authRootDir) !== resolve(input.controller.scope.authRoot)) {
    throw new Error("project_control_controller_auth_root_outside_scope");
  }
  const slots = await listCodexGoalAccountStatuses({
    authRootDir: input.launch.config.authRootDir,
    accounts: input.launch.config.accounts.map((account) => account.name),
    stateRootDir: codexGoalStateRootDir(input.launch),
  });
  const allowedAccountIds = input.controller.scope.allowedAccountIds;
  const available = availableCodexGoalAccountSlots(dedupeCodexGoalAccountSlots(slots))
    .filter((slot) =>
      allowedAccountIds === undefined ||
      allowedAccountIds.includes(slot.name),
    );
  const selected = available[0];
  if (!selected) {
    throw new Error("project_control_controller_no_available_account");
  }
  const authJsonBytes = await readFile(selected.authJsonPath, "utf8");
  return {
    name: selected.name,
    ...(selected.authJsonSha256Prefix === undefined
      ? {}
      : { authJsonSha256Prefix: selected.authJsonSha256Prefix }),
    sessionArtifact: sessionArtifactFromCodexAuthJson(authJsonBytes),
  };
}

async function controlledAgentClaudeSessionArtifact(input: {
  readonly args: ProjectControllerLaunchPlanMcpArgs;
  readonly controller: {
    readonly scope: ProjectAccessScope;
  };
  readonly state: {
    readonly cwd: string;
  };
}): Promise<{
  readonly path: string;
  readonly sha256Prefix: string;
  readonly sessionArtifact: SessionArtifact;
}> {
  if (!input.controller.scope.authRoot) {
    throw new Error("project_control_controller_auth_root_scope_required");
  }
  const rawPath = stringValue(input.args.sessionArtifactPath);
  if (rawPath === undefined) {
    throw new Error("project_control_controller_session_artifact_path_required");
  }
  return loadScopedClaudeSessionArtifact({
    sessionArtifactPath: rawPath,
    authRoot: input.controller.scope.authRoot,
    cwd: input.state.cwd,
  });
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

  const accountCapacityFacts = await codexGoalAccountCapacityFacts(manifest);
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

function codexGoalWorkerControlService(
  launch: CodexGoalLaunchInput,
): WorkerControlService {
  return new WorkerControlService({
    store: new LocalFileWorkerControlInboxStore({
      rootDir: codexGoalStateRootDir(launch),
    }),
  });
}

function codexGoalWorkerControlTarget(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
}): WorkerControlTarget {
  return {
    jobId: input.manifest.jobId,
    taskId: input.launch.config.taskId,
    workspaceId: input.launch.config.workspacePath,
  };
}

function codexGoalStateRootDir(launch: CodexGoalLaunchInput): string {
  return launch.config.stateRootDir ?? join(launch.config.jobRootDir, "state");
}

async function codexGoalAccountStatusPayload(
  launch: CodexGoalLaunchInput,
  options: {
    readonly liveCheck?: boolean;
    readonly codexBinaryPath?: string;
    readonly liveCheckTimeoutMs?: number;
  } = {},
) {
  return codexAccountStatusPayload({
    authRootDir: launch.config.authRootDir,
    stateRootDir: codexGoalStateRootDir(launch),
    accounts: launch.config.accounts.map((account) => account.name),
    ...options,
  });
}

async function codexGoalAccountCapacityFacts(
  manifest: CodexGoalJobManifest,
): Promise<JsonObject> {
  try {
    const launch = await goalLaunchInput(codexGoalJobToArgs(manifest));
    const payload = await codexGoalAccountStatusPayload(launch, {
      liveCheck: false,
    });
    const capacityBlockedAccounts = payload.accounts.filter((slot) =>
      slot.capacityAvailability && slot.capacityAvailability !== "available"
    );
    return {
      ok: true,
      capacityAware: payload.capacityAware,
      summary: payload.summary,
      capacityBlockedAccounts: capacityBlockedAccounts.map((slot) => ({
        name: slot.name,
        availability: slot.capacityAvailability,
        reason: slot.capacityReason,
        cooldownUntil: slot.capacityCooldownUntil,
      })),
      availableDedupedAccountNames: payload.availableDedupedAccountNames,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "account_capacity_facts_unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function continueStoredJob(
  args: JobLifecycleMcpArgs,
  options: {
    readonly mode: "continue" | "recover";
    readonly confirmKey: "confirmContinue" | "confirmRecover";
  },
) {
  const loaded = await loadJobLaunch(args);
  const projectControlDenial = projectControlGenericToolDenial({
    accessBoundary: loaded.manifest.accessBoundary,
    projectAccessScope: loaded.manifest.projectAccessScope,
    jobId: loaded.manifest.jobId,
  }) ?? await projectControlGenericScopeDenial({
    registryRootDir: loaded.registryRootDir,
    jobId: loaded.manifest.jobId,
    workspacePath: loaded.launch.config.workspacePath,
    requiredTool: "codex_goal_project_start",
  });
  if (projectControlDenial) return mcpJson(projectControlDenial);
  const status = await collectCodexGoalStatus(statusInput(loaded.launch));
  const progressStale = status.progressHeartbeatAgeMs !== undefined &&
    status.progressHeartbeatAgeMs > (numberValue(args.staleAfterMs) ?? 10 * 60_000);
  const workerLiveness = resolveCodexGoalWorkerLiveness({
    status,
    progressStale,
  });
  if (workerLiveness.alive) {
    return mcpJson({
      ok: false,
      reason: "worker_already_running",
      jobId: loaded.manifest.jobId,
      status,
      workerSupervisorKind: workerLiveness.supervisorKind,
      workerAliveReason: workerLiveness.aliveReason,
    });
  }
  if (
    !isSafeStartAction(status.recommendedAction) &&
    !args.forceStart
  ) {
    return mcpJson({
      ok: false,
      reason: "status_requires_review",
      jobId: loaded.manifest.jobId,
      status,
      next: nextActionForStatus(status.recommendedAction),
      requiredOverride: "forceStart",
    });
  }
  if (!args[options.confirmKey]) {
    return mcpJson({
      ok: false,
      reason: `${options.confirmKey}_required`,
      jobId: loaded.manifest.jobId,
      status,
      tmuxCommand: loaded.launch.tmuxSession
        ? buildCodexGoalTmuxCommand(loaded.launch).preview
        : undefined,
      noTmuxCommand: buildCodexGoalNoTmuxCommand(loaded.launch),
      next: nextActionForStatus(status.recommendedAction),
    });
  }
  if (!loaded.launch.tmuxSession) {
    return mcpJson({
      ok: false,
      reason: "tmux_session_required",
      jobId: loaded.manifest.jobId,
      noTmuxCommand: buildCodexGoalNoTmuxCommand(loaded.launch),
    });
  }
  if (!args.skipDoctor) {
    await prepareCodexGoalLaunchPaths(loaded.launch);
    const doctor = await doctorCodexGoal({
      config: loaded.launch.config,
      tmuxSession: loaded.launch.tmuxSession,
    });
    if (!doctor.ok) {
      return mcpJson({
        ok: false,
        reason: "doctor_failed",
        jobId: loaded.manifest.jobId,
        doctor,
      });
    }
  }
  const resultReconciliation = shouldReconcileResultBeforeStart(status)
    ? await reconcileCodexGoalRuntimeResult({
        config: loaded.launch.config,
        status,
        preservePatch: true,
      })
    : undefined;
  const command = await startCodexGoalTmux(loaded.launch);
  return mcpJson({
    ok: true,
    mode: options.mode,
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    tmuxSession: loaded.launch.tmuxSession,
    tmuxCommand: command.preview,
    statusBefore: status,
    ...(resultReconciliation === undefined ? {} : { resultReconciliation }),
  });
}

function shouldReconcileResultBeforeStart(status: Awaited<ReturnType<typeof collectCodexGoalStatus>>): boolean {
  if (
    status.progressStatus === "maintenance_paused" &&
    status.resultExists !== true &&
    !status.workspaceDirty &&
    (
      status.logExists !== true ||
      (status.logByteLength ?? 0) === 0
    )
  ) {
    return false;
  }
  if (status.resultExists === true) return true;
  if (status.workspaceDirty) return true;
  if (status.progressExists) return true;
  if (status.logExists && (status.logByteLength ?? 0) > 0) return true;
  return false;
}

async function reconcileStoredJobRuntimeResult(args: JobResultReconcileMcpArgs) {
  const loaded = await loadJobLaunch(args);
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
    staleAfterMs: numberValue(args.staleAfterMs) ?? 10 * 60_000,
    tailLines: numberValue(args.tailLines) ?? 20,
  });
  if (brief.workerAlive && !brief.silentStale && !brief.heartbeatOnlyNoOutput && !args.forceWrite) {
    return mcpJson({
      ok: false,
      reason: "worker_alive",
      jobId: loaded.manifest.jobId,
      status,
      brief,
      requiredOverride: "forceWrite",
      safeMessage:
        "Worker still appears alive. Reconcile result only after stop/stale confirmation or with forceWrite.",
    });
  }
  const reconciliation = await reconcileCodexGoalRuntimeResult({
    config: loaded.launch.config,
    status,
    forceWrite: booleanValue(args.forceWrite) === true,
    preservePatch: args.preservePatch !== false,
    silentStale: brief.silentStale,
    heartbeatOnlyNoOutput: brief.heartbeatOnlyNoOutput,
    ...(brief.silentStale
      ? { reason: "silent_stale_worker" }
      : brief.heartbeatOnlyNoOutput
      ? { reason: "heartbeat_only_no_output" }
      : {}),
  });
  return mcpJson({
    ok: true,
    mode: "reconcile_result",
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    status,
    brief,
    reconciliation,
  });
}

async function stopStoredJob(args: JobLifecycleMcpArgs) {
  const loaded = await loadJobLaunch(args);
  const projectControlDenial = projectControlGenericToolDenial({
    accessBoundary: loaded.manifest.accessBoundary,
    projectAccessScope: loaded.manifest.projectAccessScope,
    jobId: loaded.manifest.jobId,
    requiredTool: "codex_goal_project_stop",
  }) ?? await projectControlGenericScopeDenial({
    registryRootDir: loaded.registryRootDir,
    jobId: loaded.manifest.jobId,
    workspacePath: loaded.launch.config.workspacePath,
    requiredTool: "codex_goal_project_stop",
  });
  if (projectControlDenial) return mcpJson(projectControlDenial);
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
    staleAfterMs: numberValue(args.staleAfterMs) ?? 10 * 60_000,
    tailLines: numberValue(args.tailLines) ?? 20,
  });
  if (!loaded.launch.tmuxSession) {
    return mcpJson({
      ok: false,
      reason: "tmux_session_required",
      jobId: loaded.manifest.jobId,
      status,
      brief,
    });
  }
  const stopCommand = buildCodexGoalStopTmuxCommand(loaded.launch.tmuxSession);
  if (!status.tmuxAlive) {
    return mcpJson({
      ok: false,
      reason: "worker_not_running",
      jobId: loaded.manifest.jobId,
      tmuxSession: loaded.launch.tmuxSession,
      stopCommand: stopCommand.preview,
      status,
      brief,
    });
  }
  if (!brief.silentStale && !brief.heartbeatOnlyNoOutput && !args.forceStop) {
    return mcpJson({
      ok: false,
      reason: "worker_not_silent_stale_or_heartbeat_only_no_output",
      jobId: loaded.manifest.jobId,
      tmuxSession: loaded.launch.tmuxSession,
      requiredOverride: "forceStop",
      stopCommand: stopCommand.preview,
      status,
      brief,
    });
  }
  if (!args.confirmStop) {
    return mcpJson({
      ok: false,
      reason: "confirm_stop_required",
      jobId: loaded.manifest.jobId,
      tmuxSession: loaded.launch.tmuxSession,
      stopCommand: stopCommand.preview,
      status,
      brief,
    });
  }
  const command = await stopCodexGoalTmux(loaded.launch.tmuxSession);
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
    tmuxSession: loaded.launch.tmuxSession,
    stopCommand: command.preview,
    forceStop: Boolean(args.forceStop),
    statusBefore: status,
    statusAfter,
    brief,
  });
  const resultReconciliation = await reconcileCodexGoalRuntimeResult({
    config: loaded.launch.config,
    status: statusAfter,
    reason: brief.silentStale
      ? "silent_stale_worker"
      : brief.heartbeatOnlyNoOutput
      ? "heartbeat_only_no_output"
      : "manual_force_stop",
    preservePatch: true,
    silentStale: brief.silentStale,
    heartbeatOnlyNoOutput: brief.heartbeatOnlyNoOutput,
  });
  return mcpJson({
    ok: true,
    mode: "stop",
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    tmuxSession: loaded.launch.tmuxSession,
    stopCommand: command.preview,
    stopEventPath,
    statusBefore: status,
    statusAfter,
    brief,
    resultReconciliation,
    safeMessage:
      "Stopped the tmux worker session. Review workspace/log/result before continuing or recovery.",
  });
}

async function maintenancePauseStoredJob(args: JobLifecycleMcpArgs) {
  const loaded = await loadJobLaunch(args);
  const projectControlDenial = projectControlGenericToolDenial({
    accessBoundary: loaded.manifest.accessBoundary,
    projectAccessScope: loaded.manifest.projectAccessScope,
    jobId: loaded.manifest.jobId,
    requiredTool: "codex_goal_project_stop",
  }) ?? await projectControlGenericScopeDenial({
    registryRootDir: loaded.registryRootDir,
    jobId: loaded.manifest.jobId,
    workspacePath: loaded.launch.config.workspacePath,
    requiredTool: "codex_goal_project_stop",
  });
  if (projectControlDenial) return mcpJson(projectControlDenial);
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
    staleAfterMs: numberValue(args.staleAfterMs) ?? 10 * 60_000,
    tailLines: numberValue(args.tailLines) ?? 20,
  });
  if (!loaded.launch.tmuxSession) {
    return mcpJson({
      ok: false,
      reason: "tmux_session_required",
      jobId: loaded.manifest.jobId,
      status,
      brief,
    });
  }
  const stopCommand = buildCodexGoalStopTmuxCommand(loaded.launch.tmuxSession);
  if (!status.tmuxAlive) {
    return mcpJson({
      ok: false,
      reason: status.progressStatus === "maintenance_paused"
        ? "already_maintenance_paused"
        : "worker_not_running",
      jobId: loaded.manifest.jobId,
      tmuxSession: loaded.launch.tmuxSession,
      stopCommand: stopCommand.preview,
      status,
      brief,
    });
  }
  if (status.workspaceDirty && !args.forcePause) {
    return mcpJson({
      ok: false,
      reason: "workspace_dirty_requires_force_pause",
      jobId: loaded.manifest.jobId,
      tmuxSession: loaded.launch.tmuxSession,
      requiredOverride: "forcePause",
      stopCommand: stopCommand.preview,
      status,
      brief,
      safeMessage:
        "Workspace has uncommitted changes. Wait for a clean checkpoint or pass forcePause after manual review.",
    });
  }
  if (!args.confirmPause) {
    return mcpJson({
      ok: false,
      reason: "confirm_pause_required",
      jobId: loaded.manifest.jobId,
      tmuxSession: loaded.launch.tmuxSession,
      stopCommand: stopCommand.preview,
      status,
      brief,
    });
  }
  const command = await stopCodexGoalTmux(loaded.launch.tmuxSession);
  const pauseReason = stringValue(args.reason) ?? "planned_maintenance";
  await writeCodexGoalStoppedProgress({
    progressPath: loaded.launch.config.progressPath ?? codexGoalProgressPath({
      jobRootDir: loaded.launch.config.jobRootDir,
      taskId: loaded.launch.config.taskId,
    }),
    taskId: loaded.launch.config.taskId,
    status: "maintenance_paused",
    reason: pauseReason,
  });
  const statusAfter = await collectCodexGoalStatus(statusInput(loaded.launch));
  const maintenancePausePath = await writeCodexGoalMaintenancePauseEvent({
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    jobRootDir: loaded.launch.config.jobRootDir,
    tmuxSession: loaded.launch.tmuxSession,
    stopCommand: command.preview,
    reason: pauseReason,
    forcePause: Boolean(args.forcePause),
    statusBefore: status,
    statusAfter,
    brief,
  });
  return mcpJson({
    ok: true,
    mode: "maintenance_pause",
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    tmuxSession: loaded.launch.tmuxSession,
    stopCommand: command.preview,
    maintenancePausePath,
    statusBefore: status,
    statusAfter,
    brief,
    safeMessage:
      "Worker paused for planned maintenance. No failure result was reconciled; codex_goal_continue can resume after maintenance.",
  });
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

async function watchAgentRuns(args: AgentRunWatchMcpArgs): Promise<JsonObject> {
  const providerKindInput = stringValue(args.providerKind) ?? RunEventProviderKind.Codex;
  const providerKind = runEventProviderKindFromString(providerKindInput);
  if (providerKind === RunEventProviderKind.Claude) {
    const jobId = stringValue(args.jobId);
    const staleAfterMs = numberValue(args.staleAfterMs);
    const tailLines = numberValue(args.tailLines);
    const limit = numberValue(args.limit);
    return watchClaudeRuns({
      includeChangedFiles: booleanValue(args.includeChangedFiles) === true,
      includeLogTail: booleanValue(args.includeLogTail) === true,
      ...(args.stateRootDir === undefined ? {} : { stateRootDir: args.stateRootDir }),
      ...(args.runArtifactsRootDir === undefined
        ? {}
        : { runArtifactsRootDir: args.runArtifactsRootDir }),
      ...(jobId === undefined ? {} : { jobId }),
      ...(args.jobIds === undefined ? {} : { jobIds: args.jobIds }),
      ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
      ...(tailLines === undefined ? {} : { tailLines }),
      ...(limit === undefined ? {} : { limit }),
    } satisfies ClaudeRunWatchArgs);
  }
  if (providerKind !== RunEventProviderKind.Codex) {
    return {
      ok: false,
      mode: "read_only",
      sideEffects: [],
      providerKind,
      supportedProviderKinds: [RunEventProviderKind.Codex, RunEventProviderKind.Claude],
      reason: "provider_observation_not_implemented",
      safeMessage:
        `Run observation for provider '${providerKindInput}' is not implemented yet. Watch did not start, stop, continue, recover or deliver work.`,
    };
  }
  const registryRootDir = registryRootFromArgs(args);
  const staleAfterMs = numberValue(args.staleAfterMs);
  const tailLines = numberValue(args.tailLines);
  const adapter = new CodexRunObservationAdapter({
    registryRootDir,
    ...(args.cwd ? { cwd: args.cwd } : {}),
    ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
    ...(tailLines === undefined ? {} : { tailLines }),
  });
  const service = new RunObservationService(adapter);
  const explicitJobIds = [
    ...(stringValue(args.jobId) ? [stringValue(args.jobId) as string] : []),
    ...jobIdsFromValue(args.jobIds),
  ];
  const limit = numberValue(args.limit);
  const listedRunIds = explicitJobIds.length
    ? explicitJobIds
    : await service.listRunIds();
  const runIds = limit === undefined
    ? listedRunIds
    : listedRunIds.slice(0, limit);
  const snapshots = await Promise.all(
    runIds.map(async (runId) => {
      try {
        return await service.observeRun({
          runId,
          ...(tailLines === undefined ? {} : { tailLines }),
          includeChangedFiles: booleanValue(args.includeChangedFiles) === true,
          includeLogTail: booleanValue(args.includeLogTail) === true,
        });
      } catch (error) {
        const orphan = await observeOrphanCodexRun({
          runId,
          error,
          args,
          providerKind,
          staleAfterMs: staleAfterMs ?? 10 * 60_000,
          tailLines: tailLines ?? 20,
        });
        if (orphan) return orphan;
        return failedRunObservationSnapshot({
          runId,
          providerKind,
          error,
        });
      }
    }),
  );
  const observationFailures = snapshots
    .filter((snapshot) =>
      snapshot.warnings.some((warning) => warning.code === "run_observation_failed")
    )
    .map((snapshot) => ({
      runId: snapshot.runId,
      warnings: snapshot.warnings.filter((warning) =>
        warning.code === "run_observation_failed"
      ),
    }));
  return {
    ok: observationFailures.length === 0,
    mode: "read_only",
    sideEffects: [],
    providerKind: "codex",
    registryRootDir,
    totalRuns: listedRunIds.length,
    returnedRuns: snapshots.length,
    truncated: limit === undefined ? false : listedRunIds.length > runIds.length,
    summary: summarizeRunObservationSnapshots(snapshots),
    ...(observationFailures.length ? { observationFailures } : {}),
    snapshots,
  };
}

async function readAgentRunEvents(
  args: AgentRunEventsMcpArgs,
): Promise<JsonObject> {
  const registryRootDir = registryRootFromArgs(args);
  const eventRootDir = runEventRootFromArgs(args, registryRootDir);
  const providerKind = optionalRunEventProviderKind(args.providerKind);
  const eventStore = new LocalFileRunEventStore({ rootDir: eventRootDir });
  const result = await eventStore.read({
    ...(stringValue(args.cursor) === undefined
      ? {}
      : { cursor: { value: stringValue(args.cursor) as string } }),
    ...(stringValue(args.jobId) === undefined
      ? {}
      : { runId: stringValue(args.jobId) as string }),
    ...(numberValue(args.limit) === undefined
      ? {}
      : { limit: numberValue(args.limit) as number }),
    ...(providerKind === undefined ? {} : { sourceProviderKind: providerKind }),
    ...runEventTypeFilter(args),
  });
  return {
    ok: result.warnings.length === 0,
    mode: "read_only",
    sideEffects: [],
    providerKind: providerKind ?? "all",
    registryRootDir,
    eventRootDir,
    returnedEvents: result.events.length,
    nextCursor: result.nextCursor?.value,
    warnings: result.warnings,
    events: result.events,
  };
}

async function readAgentRunState(
  args: AgentRunStateMcpArgs,
): Promise<JsonObject> {
  const registryRootDir = registryRootFromArgs(args);
  const eventRootDir = runEventRootFromArgs(args, registryRootDir);
  const providerKind = optionalRunEventProviderKind(args.providerKind);
  const runId = requiredRawString(args.jobId, "jobId");
  const stateStore = new LocalFileRunEventProjectionStateStore({
    rootDir: eventRootDir,
  });
  const state = await stateStore.readProjectionState(runId);
  if (state === null) {
    const eventStore = new LocalFileRunEventStore({ rootDir: eventRootDir });
    const read = await eventStore.read({ runId });
    const replayed = projectRunReadModelsFromEvents(read.events);
    if (
      replayed !== null &&
      (providerKind === undefined || replayed.providerKind === providerKind)
    ) {
      return {
        ok: read.warnings.length === 0,
        mode: "read_only_state",
        sideEffects: [],
        providerKind: replayed.providerKind,
        registryRootDir,
        eventRootDir,
        runId,
        observedAt: replayed.observedAt,
        replayOnly: true,
        warnings: read.warnings,
        readModels: replayed,
      };
    }
    return {
      ok: false,
      mode: "read_only_state",
      sideEffects: [],
      providerKind: providerKind ?? "all",
      registryRootDir,
      eventRootDir,
      runId,
      reason: "projection_state_not_found",
      safeMessage:
        "No projected run state exists yet and no replayable run events were found. Run agent_run_project_events first to observe and project this run.",
    };
  }
  if (providerKind !== undefined && state.providerKind !== providerKind) {
    return {
      ok: false,
      mode: "read_only_state",
      sideEffects: [],
      providerKind,
      registryRootDir,
      eventRootDir,
      runId,
      reason: "projection_state_provider_mismatch",
      safeMessage:
        "Projected run state exists for a different provider. No worker action was taken.",
    };
  }
  return {
    ok: true,
    mode: "read_only_state",
    sideEffects: [],
    providerKind: state.providerKind,
    registryRootDir,
    eventRootDir,
    runId,
    observedAt: state.observedAt,
    status: state.status,
    liveness: state.liveness,
    readModels: state.readModels,
    state,
  };
}

async function planAgentRunEventCompaction(
  args: AgentRunEventCompactionMcpArgs,
): Promise<JsonObject> {
  const registryRootDir = registryRootFromArgs(args);
  const eventRootDir = runEventRootFromArgs(args, registryRootDir);
  const eventStore = new LocalFileRunEventStore({ rootDir: eventRootDir });
  const policy = runEventRetentionPolicyFromArgs(args);
  const plan = await eventStore.planCompaction(policy);
  return {
    ok: plan.warnings.length === 0,
    mode: "compaction_plan",
    sideEffects: [],
    registryRootDir,
    eventRootDir,
    policy,
    plan,
  };
}

async function compactAgentRunEvents(
  args: AgentRunEventCompactionMcpArgs,
): Promise<JsonObject> {
  const registryRootDir = registryRootFromArgs(args);
  const eventRootDir = runEventRootFromArgs(args, registryRootDir);
  const policy = runEventRetentionPolicyFromArgs(args);
  if (booleanValue(args.confirmCompact) !== true) {
    const eventStore = new LocalFileRunEventStore({ rootDir: eventRootDir });
    const plan = await eventStore.planCompaction(policy);
    return {
      ok: false,
      mode: "compact_events",
      sideEffects: [],
      registryRootDir,
      eventRootDir,
      policy,
      reason: "confirm_compact_required",
      safeMessage:
        "Compaction rewrites the local event log. Re-run with confirmCompact=true after reviewing the plan.",
      plan,
    };
  }
  const eventStore = new LocalFileRunEventStore({ rootDir: eventRootDir });
  const result = await eventStore.compact(policy);
  return {
    ok: result.warnings.length === 0 &&
      result.cursorRewrites.every((rewrite) => !rewrite.invalidatedUnreadEvents),
    mode: "compact_events",
    sideEffects: ["rewrite_run_event_log", "rewrite_delivery_cursors"],
    registryRootDir,
    eventRootDir,
    policy,
    result,
  };
}

async function projectAgentRunEvents(
  args: AgentRunProjectEventsMcpArgs,
): Promise<JsonObject> {
  const providerKind = optionalRunEventProviderKind(args.providerKind) ??
    RunEventProviderKind.Codex;
  if (
    providerKind !== RunEventProviderKind.Codex &&
    providerKind !== RunEventProviderKind.Claude
  ) {
    return {
      ok: false,
      mode: "project_events",
      sideEffects: [],
      providerKind,
      supportedProviderKinds: [RunEventProviderKind.Codex, RunEventProviderKind.Claude],
      reason: "provider_event_projection_not_implemented",
      safeMessage:
        `Run event projection for provider '${providerKind}' is not implemented yet. Projection did not start, stop, continue, recover or deliver work.`,
    };
  }
  const registryRootDir = registryRootFromArgs(args);
  const eventRootDir = runEventRootFromArgs(args, registryRootDir);
  const watch = await watchAgentRuns({
    ...args,
    providerKind,
    includeChangedFiles: booleanValue(args.includeChangedFiles) === true,
    includeLogTail: false,
  });
  const snapshots = Array.isArray(watch.snapshots)
    ? watch.snapshots as readonly RunObservationSnapshot[]
    : [];
  const eventStore = new LocalFileRunEventStore({ rootDir: eventRootDir });
  const stateStore = new LocalFileRunEventProjectionStateStore({
    rootDir: eventRootDir,
  });
  const projectedRuns = [];
  let appendedCount = 0;
  let skippedDuplicateCount = 0;
  for (const snapshot of snapshots) {
    const previousState = await stateStore.readProjectionState(snapshot.runId);
    const projection = projectRunObservationEvents({
      snapshot,
      previousState,
      ...(stringValue(args.hostId) === undefined
        ? {}
        : { hostId: stringValue(args.hostId) as string }),
      registryRootDir,
    });
    const appendResult = await eventStore.append(projection.events);
    await stateStore.writeProjectionState(projection.nextState);
    appendedCount += appendResult.appendedCount;
    skippedDuplicateCount += appendResult.skippedDuplicateCount;
    projectedRuns.push({
      runId: snapshot.runId,
      projectedEvents: projection.events.length,
      appendedEvents: appendResult.appendedCount,
      skippedDuplicateEvents: appendResult.skippedDuplicateCount,
      eventTypes: projection.events.map((event) => event.type),
      decision: snapshot.readOnlyDecision.kind,
      status: snapshot.status,
      readModels: projection.nextState.readModels,
    });
  }
  const projectedRunIds = snapshots.map((snapshot) => snapshot.runId);
  const readBack: RunEventReadResult = await eventStore.read({
    runIds: projectedRunIds,
    sourceProviderKind: providerKind,
    sourceRegistryRootDir: registryRootDir,
    ...(numberValue(args.limit) === undefined
      ? {}
      : { limit: numberValue(args.limit) as number }),
    ...runEventTypeFilter(args),
  });
  return {
    ok: watch.ok === true && readBack.warnings.length === 0,
    mode: "project_events",
    sideEffects: ["append_run_events", "write_projection_state"],
    providerKind,
    registryRootDir,
    eventRootDir,
    totalRuns: watch.totalRuns,
    returnedRuns: snapshots.length,
    appendedCount,
    skippedDuplicateCount,
    warnings: readBack.warnings,
    projectedRuns,
    nextCursor: readBack.nextCursor?.value,
    events: readBack.events,
  };
}

async function observeOrphanCodexRun(input: {
  readonly runId: string;
  readonly error: unknown;
  readonly args: AgentRunWatchMcpArgs;
  readonly providerKind: RunEventProviderKind;
  readonly staleAfterMs: number;
  readonly tailLines: number;
}): Promise<RunObservationSnapshot | null> {
  if (!isMissingCodexGoalManifestError(input.error)) return null;
  if (!stringValue(input.args.runArtifactsRootDir)) return null;
  const cwd = resolvePath(
    process.cwd(),
    stringValue(input.args.cwd) ?? process.cwd(),
  );
  const jobRootDir = join(
    resolvePath(cwd, stringValue(input.args.runArtifactsRootDir) as string),
    input.runId,
  );
  try {
    const rootStat = await stat(jobRootDir);
    if (!rootStat.isDirectory()) return null;
  } catch {
    return null;
  }
  const status = await collectCodexGoalStatus({
    jobRootDir,
    taskId: input.runId,
    resultPath: join(jobRootDir, "result.json"),
    logPath: join(jobRootDir, "worker.log"),
    progressPath: join(jobRootDir, "progress.json"),
    tmuxSession: input.runId,
  });
  const logUpdatedAgeMs = isoAgeMsForMcp(status.logUpdatedAt);
  const progressStale = status.progressHeartbeatAgeMs !== undefined &&
    status.progressHeartbeatAgeMs > input.staleAfterMs;
  const logStale = logUpdatedAgeMs !== undefined &&
    logUpdatedAgeMs > input.staleAfterMs;
  const workerLiveness = resolveCodexGoalWorkerLiveness({
    status,
    progressStale,
  });
  const workerAlive = false;
  const heartbeatOnlyNoOutput = Boolean(
    workerAlive &&
      status.progressExists &&
      !status.resultExists &&
      (status.logByteLength ?? 0) === 0,
  );
  const warnings = [
    {
      code: "codex_orphan_artifact_run",
      message:
        "Codex run artifacts exist but the job registry manifest is missing; observing artifact paths read-only.",
      severity: "warning" as const,
    },
    ...status.warnings.map((message) => ({
      code: "codex_status_warning",
      message,
      severity: "warning" as const,
    })),
    ...(heartbeatOnlyNoOutput
      ? [{
          code: "heartbeat_only_no_output",
          message:
            "worker heartbeat is fresh, but there is no result, log output or workspace change",
          severity: "blocked" as const,
        }]
      : []),
  ];
  const runStatus = workerAlive && status.progressStatus === "running"
    ? "running"
    : status.resultStatus === "completed"
    ? "completed"
    : status.resultStatus === "failed"
    ? "failed"
    : workerAlive
    ? "running"
    : "unknown";
  const liveness = workerAlive
    ? (progressStale || logStale ? "stale" : "alive")
    : "dead";
  const manualReviewReasons = [
    "missing_job_manifest",
    ...(heartbeatOnlyNoOutput ? ["heartbeat_only_no_output"] : []),
  ];
  const snapshotBase = {
    runId: input.runId,
    providerKind: input.providerKind,
    observedAt: new Date().toISOString(),
    status: runStatus,
    liveness,
    process: {
      supervisor: workerLiveness.supervisorKind,
      sessionId: input.runId,
      alive: workerAlive,
      aliveReason: workerLiveness.aliveReason,
      ...(status.progressPid === undefined ? {} : { pid: status.progressPid }),
    },
    progress: {
      ...(status.progressStatus === undefined ? {} : { status: status.progressStatus }),
      ...(status.progressUpdatedAt === undefined ? {} : { updatedAt: status.progressUpdatedAt }),
      ...(status.progressHeartbeatAgeMs === undefined
        ? {}
        : { heartbeatAgeMs: status.progressHeartbeatAgeMs }),
      staleAfterMs: input.staleAfterMs,
      stale: progressStale,
      silentStale: Boolean(workerAlive && (progressStale || logStale)),
      heartbeatOnlyNoOutput,
      ...(status.progressAttemptCount === undefined
        ? {}
        : { attemptCount: status.progressAttemptCount }),
      ...(status.progressCurrentAccount === undefined
        ? {}
        : { currentAccount: status.progressCurrentAccount }),
    },
    result: {
      ...(status.resultExists === undefined ? {} : { exists: status.resultExists }),
      ...(status.resultStatus === undefined ? {} : { status: status.resultStatus }),
      ...(status.resultReason === undefined ? {} : { reason: status.resultReason }),
      ...(status.resultPath === undefined ? {} : { path: status.resultPath }),
    },
    logs: await orphanCodexLogExcerpt({
      status,
      includeLogTail: booleanValue(input.args.includeLogTail) === true,
      tailLines: input.tailLines,
    }),
    artifacts: [
      orphanArtifactSummary("result", status.resultPath, status.resultExists),
      orphanArtifactSummary(
        "progress",
        status.progressPath,
        status.progressExists,
        status.progressUpdatedAt,
      ),
      orphanArtifactSummary(
        "log",
        status.logPath,
        status.logExists,
        status.logUpdatedAt,
        status.logByteLength,
      ),
    ],
    manualReviewReasons,
    warnings,
  } satisfies Omit<RunObservationSnapshot, "readOnlyDecision">;
  return {
    ...snapshotBase,
    readOnlyDecision: {
      kind: "manual_review_required",
      reason: "missing_job_manifest",
      safeMessage:
        "This Codex run has artifacts but no job registry manifest. Watch remains read-only; review or recreate the job manifest before continuing.",
      evidence: ["manualReviewReasons", "artifacts"],
    },
  };
}

function isMissingCodexGoalManifestError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("job.json") && message.includes("ENOENT");
}

async function orphanCodexLogExcerpt(input: {
  readonly status: Awaited<ReturnType<typeof collectCodexGoalStatus>>;
  readonly includeLogTail: boolean;
  readonly tailLines: number;
}) {
  if (!input.status.logPath) return { exists: false };
  if (!input.status.logExists) {
    return { exists: false, path: input.status.logPath };
  }
  return {
    exists: true,
    path: input.status.logPath,
    ...(input.status.logUpdatedAt ? { updatedAt: input.status.logUpdatedAt } : {}),
    ...(input.status.logByteLength === undefined
      ? {}
      : { byteLength: input.status.logByteLength }),
    ...(input.includeLogTail
      ? { tail: await tailCodexGoalLog(input.status.logPath, input.tailLines) }
      : {}),
  };
}

function orphanArtifactSummary(
  kind: string,
  path: string | undefined,
  exists: boolean | undefined,
  updatedAt?: string,
  byteLength?: number,
) {
  return {
    kind,
    ...(path === undefined ? {} : { path }),
    ...(exists === undefined ? {} : { exists }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(byteLength === undefined ? {} : { byteLength }),
  };
}

function isoAgeMsForMcp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return Date.now() - time;
}

function failedRunObservationSnapshot(input: {
  readonly runId: string;
  readonly providerKind: RunEventProviderKind;
  readonly error: unknown;
}): RunObservationSnapshot {
  const message = safeObservationErrorMessage(input.error);
  const warnings = [{
    code: "run_observation_failed",
    message,
    severity: "warning" as const,
  }];
  const manualReviewReasons = ["run_observation_failed"];
  return {
    runId: input.runId,
    providerKind: input.providerKind,
    observedAt: new Date().toISOString(),
    status: "unknown",
    liveness: "unknown",
    warnings,
    manualReviewReasons,
    readOnlyDecision: decideRunObservation({
      status: "unknown",
      liveness: "unknown",
      manualReviewReasons,
      warnings,
    }),
  };
}

function safeObservationErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return new DefaultRedactor().redact(message);
}

function summarizeRunObservationSnapshots(
  snapshots: readonly { readonly status: string; readonly liveness: string; readonly readOnlyDecision: { readonly kind: string }; readonly warnings: readonly unknown[] }[],
): JsonObject {
  return {
    running: snapshots.filter((snapshot) => snapshot.status === "running").length,
    completed: snapshots.filter((snapshot) => snapshot.status === "completed").length,
    failed: snapshots.filter((snapshot) => snapshot.status === "failed").length,
    stopped: snapshots.filter((snapshot) => snapshot.status === "stopped").length,
    unknown: snapshots.filter((snapshot) => snapshot.status === "unknown").length,
    alive: snapshots.filter((snapshot) => snapshot.liveness === "alive").length,
    stale: snapshots.filter((snapshot) => snapshot.liveness === "stale").length,
    manualReview: snapshots.filter((snapshot) =>
      snapshot.readOnlyDecision.kind === "manual_review_required"
    ).length,
    capacityBlocked: snapshots.filter((snapshot) =>
      snapshot.readOnlyDecision.kind === "capacity_blocked"
    ).length,
    unsafeStateMismatch: snapshots.filter((snapshot) =>
      snapshot.readOnlyDecision.kind === "unsafe_state_mismatch"
    ).length,
    warnings: snapshots.reduce((count, snapshot) => count + snapshot.warnings.length, 0),
  };
}

async function codexOverviewItemToWatchStatus(
  item: JsonObject,
): Promise<RunReconcilePreviewStatus> {
  const jobId = stringValue(item.jobId) ?? "unknown";
  const workspacePath = stringValue(item.workspacePath);
  const recommendedAction = stringValue(item.recommendedAction);
  const nextBestTool = stringValue(item.nextBestTool);
  const continueAfter = continueAfterFromOverviewItem(item);
  const requiresManualReview = nextBestTool === "manual_review" ||
    recommendedAction === "inspect_dirty_workspace" ||
    recommendedAction === "inspect_dirty_failure" ||
    recommendedAction === "inspect_failure" ||
    recommendedAction === "check_log_or_result";
  return {
    runId: jobId,
    workerAlive: item.workerAlive === true,
    safeToContinue: item.safeToContinue === true,
    ...(workspacePath ? { workspaceKey: await workspaceConflictKey(workspacePath) } : {}),
    ...(item.workspaceDirty === undefined
      ? {}
      : { workspaceDirty: item.workspaceDirty === true }),
    ...(requiresManualReview ? { requiresManualReview: true } : {}),
    ...(requiresManualReview
      ? { manualReviewReason: nextBestTool ?? recommendedAction ?? "manual_review" }
      : {}),
    ...(continueAfter ? { continueAfter } : {}),
    summary: item,
  };
}

function continueAfterFromOverviewItem(item: JsonObject): Date | undefined {
  const recommendedAction = stringValue(item.recommendedAction);
  if (recommendedAction !== "continue_after_capacity") return undefined;
  const accounts = Array.isArray(item.capacityBlockedAccounts)
    ? item.capacityBlockedAccounts
    : [];
  return accounts
    .map((account) =>
      isRecord(account) ? dateValue(account.cooldownUntil) : undefined
    )
    .filter((value): value is Date => value !== undefined)
    .sort((left, right) => left.getTime() - right.getTime())[0];
}

async function buildCodexGoalWorkspaceConflicts(
  jobs: readonly JsonObject[],
): Promise<readonly JsonObject[]> {
  const candidates = jobs.filter((job) =>
    job.ok === true &&
    typeof job.jobId === "string" &&
    typeof job.workspacePath === "string" &&
    (job.workerAlive === true || job.safeToContinue === true)
  );
  const keyed = await Promise.all(
    candidates.map(async (job) => ({
      job,
      workspaceKey: await workspaceConflictKey(String(job.workspacePath)),
    })),
  );
  const groups = new Map<string, typeof keyed>();
  for (const item of keyed) {
    groups.set(item.workspaceKey, [...(groups.get(item.workspaceKey) ?? []), item]);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      workspacePath: group[0]?.job.workspacePath,
      workspaceKey: group[0]?.workspaceKey,
      jobIds: group.map((item) => item.job.jobId).filter((jobId): jobId is string =>
        typeof jobId === "string"
      ),
      runningJobIds: group
        .filter((item) => item.job.workerAlive === true)
        .map((item) => item.job.jobId)
        .filter((jobId): jobId is string => typeof jobId === "string"),
      safeToContinueJobIds: group
        .filter((item) => item.job.safeToContinue === true)
        .map((item) => item.job.jobId)
        .filter((jobId): jobId is string => typeof jobId === "string"),
      reason: "multiple_potential_writers_share_workspace",
      safeMessage:
        "Multiple stored jobs can write to the same workspace. Continue only one writer after manual review.",
    }));
}

async function workspaceConflictKey(workspacePath: string): Promise<string> {
  try {
    return await realpath(workspacePath);
  } catch {
    return resolve(process.cwd(), workspacePath);
  }
}

function workspaceConflictJobIds(
  conflicts: readonly JsonObject[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const conflict of conflicts) {
    const jobIds = Array.isArray(conflict.jobIds) ? conflict.jobIds : [];
    for (const jobId of jobIds) {
      if (typeof jobId === "string") ids.add(jobId);
    }
  }
  return ids;
}

function applyWorkspaceConflictToOverviewJob(input: {
  readonly job: JsonObject;
  readonly conflictJobIds: ReadonlySet<string>;
}): JsonObject {
  const jobId = typeof input.job.jobId === "string" ? input.job.jobId : undefined;
  if (!jobId || !input.conflictJobIds.has(jobId)) return input.job;
  const commands = isRecord(input.job.commands)
    ? omitJsonKey(input.job.commands, "continue")
    : input.job.commands;
  return {
    ...input.job,
    safeToContinue: false,
    blockedBySingleWriter: true,
    workspaceConflict: true,
    nextBestTool: "manual_review",
    nextBestReason: "single_writer_workspace_conflict",
    nextBestCommand: "manual_review_single_writer_workspace_conflict",
    ...(commands ? { commands } : {}),
  };
}

function omitJsonKey(value: JsonObject, key: string): JsonObject {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
}

async function buildCodexGoalOverviewItem(input: {
  readonly registryRootDir: string;
  readonly jobId: string;
  readonly staleAfterMs: number;
  readonly tailLines: number;
}): Promise<JsonObject> {
  try {
    const manifest = await readCodexGoalJob({
      registryRootDir: input.registryRootDir,
      jobId: input.jobId,
    });
    const launch = await goalLaunchInput(codexGoalJobToArgs(manifest));
    const status = await collectCodexGoalStatus(statusInput(launch));
    const accounts = await listCodexGoalAccountStatuses({
      authRootDir: launch.config.authRootDir,
      accounts: launch.config.accounts.map((account) => account.name),
      stateRootDir: codexGoalStateRootDir(launch),
    });
    const brief = await buildCodexGoalBrief({
      jobId: manifest.jobId,
      launch,
      status,
      accounts,
      staleAfterMs: input.staleAfterMs,
      tailLines: input.tailLines,
    });
    const registryArgs = {
      registryRootDir: input.registryRootDir,
      jobId: manifest.jobId,
    };
    const recommendedAction =
      brief.lifecycleMarkerTypes.includes("review") &&
      !status.resultExists &&
      !brief.workerAlive
        ? "review_completed"
        : status.recommendedAction;
    return {
      ok: true,
      jobId: manifest.jobId,
      description: manifest.description,
      tags: manifest.tags ?? [],
      workspacePath: launch.config.workspacePath,
      taskId: launch.config.taskId,
      tmuxSession: launch.tmuxSession,
      workerAlive: Boolean(brief.workerAlive),
      workerSupervisorKind: brief.workerSupervisorKind,
      workerAliveReason: brief.workerAliveReason,
      workerProcessAlive: brief.workerProcessAlive,
      workerFreshProgressAlive: brief.workerFreshProgressAlive,
      workerHealth: brief.workerHealth,
      activeWriterRisk: brief.activeWriterRisk,
      activeWriterRiskReasons: brief.activeWriterRiskReasons,
      statusView: brief.statusView,
      baseRevision: brief.baseRevision,
      baseRevisionStatus: brief.baseRevisionStatus,
      baseRevisionReasons: brief.baseRevisionReasons,
      recommendedAction,
      resultStatus: status.resultStatus,
      resultReason: status.resultReason,
      progressPath: status.progressPath,
      progressExists: status.progressExists,
      progressStatus: status.progressStatus,
      progressUpdatedAt: status.progressUpdatedAt,
      progressHeartbeatAgeMs: status.progressHeartbeatAgeMs,
      progressPid: status.progressPid,
      progressProcessAlive: status.progressProcessAlive,
      workspaceDirty: status.workspaceDirty,
      changedFilesCount: (status.changedFiles ?? []).length,
      changedFiles: status.changedFiles ?? [],
      lastProgressAt: brief.lastProgressAt,
      lastProgressAgeMs: brief.lastProgressAgeMs,
      isStale: brief.isStale,
      silentStale: brief.silentStale,
      heartbeatOnlyNoOutput: brief.heartbeatOnlyNoOutput,
      safeToContinue: brief.safeToContinue,
      hasAvailableAccount: brief.hasAvailableAccount,
      needsHumanRelogin: brief.needsHumanRelogin,
      capacityBlockedAccounts: brief.capacityBlockedAccounts,
      availableDedupedAccounts: brief.availableDedupedAccounts,
      invalidAccounts: brief.invalidAccounts,
      lifecycleMarkers: brief.lifecycleMarkers,
      lifecycleMarkerTypes: brief.lifecycleMarkerTypes,
      nextBestTool: brief.nextBestTool,
      nextBestReason: brief.nextBestReason,
      nextBestCommand: brief.nextBestCommand,
      commands: {
        brief: `codex_goal_brief(${JSON.stringify(registryArgs)})`,
        handoff: `codex_goal_handoff(${JSON.stringify(registryArgs)})`,
        accounts: `codex_goal_accounts_status(${JSON.stringify(registryArgs)})`,
        ...(brief.safeToContinue
          ? {
              continue:
                `codex_goal_continue(${JSON.stringify({ ...registryArgs, confirmContinue: true })})`,
            }
          : {}),
        ...(brief.silentStale
          ? {
              stop:
                `codex_goal_stop(${JSON.stringify({ ...registryArgs, confirmStop: true })})`,
            }
          : {}),
      },
    };
  } catch (error) {
    return {
      ok: false,
      jobId: input.jobId,
      safeMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function jobManifestInputFromArgs(args: JobCreateMcpArgs): CodexGoalJobManifestInput {
  const cwd = resolvePath(process.cwd(), args.cwd ?? process.cwd());
  const jobId = requiredRawString(args.jobId, "jobId");
  const jobRootDir = resolvePath(
    cwd,
    args.jobRootDir ?? defaultCodexGoalJobRoot(jobId),
  );
  const controlModes = goalControlModesFromRecord(args as unknown as JsonObject);
  const accessBoundary = optionalCodexGoalAccessBoundary(args.accessBoundary);
  const projectAccessScope = parseCodexGoalProjectAccessScope(
    args.projectAccessScope,
  );
  const networkAccess = optionalCodexGoalNetworkAccess(args.networkAccess);
  return {
    jobId,
    ...(stringValue(args.description) ? { description: stringValue(args.description) as string } : {}),
    ...(tagValues(args.tags).length ? { tags: tagValues(args.tags) } : {}),
    jobRootDir,
    authRootDir: resolvePath(cwd, args.authRootDir ?? defaultAuthRoot),
    ...(args.stateRootDir ? { stateRootDir: resolvePath(cwd, args.stateRootDir) } : {}),
    workspacePath: requiredString(args.workspacePath, "workspacePath", cwd),
    promptPath: resolvePath(cwd, args.promptPath ?? join(jobRootDir, "prompt.md")),
    ...(stringValue(args.codexGoalObjective)
      ? { codexGoalObjective: stringValue(args.codexGoalObjective) as string }
      : {}),
    taskId: args.taskId ?? jobId,
    accounts: accountNames(args.accounts),
    ...(args.outputPath ? { outputPath: resolvePath(cwd, args.outputPath) } : {}),
    ...(args.progressPath ? { progressPath: resolvePath(cwd, args.progressPath) } : {}),
    progressHeartbeatMs: args.progressHeartbeatMs ?? 60_000,
    ...(args.codexBinaryPath ? { codexBinaryPath: args.codexBinaryPath } : {}),
    model: args.model ?? "gpt-5.5",
    reasoningEffort: args.reasoningEffort ?? "high",
    serviceTier: args.serviceTier ?? "default",
    executionEngine: args.executionEngine ?? "app-server-goal",
    taskTimeoutMs: args.taskTimeoutMs ?? defaultTimeoutMs,
    ...(args.appServerStartupTimeoutMs
      ? { appServerStartupTimeoutMs: args.appServerStartupTimeoutMs }
      : {}),
    ...(args.staleLockMs ? { staleLockMs: args.staleLockMs } : {}),
    maxAccountCycles: args.maxAccountCycles ?? 5,
    ...controlModes,
    ...(accessBoundary === undefined ? {} : { accessBoundary }),
    ...(projectAccessScope === undefined ? {} : { projectAccessScope }),
    ...(args.allowDangerFullAccess === undefined
      ? {}
      : { allowDangerFullAccess: args.allowDangerFullAccess }),
    ...(networkAccess === undefined ? {} : { networkAccess }),
    allowDuplicateAccountIdentities: args.allowDuplicateAccountIdentities ?? false,
    requireGitWorkspace: args.requireGitWorkspace ?? true,
    prewarmOnStart: args.prewarmOnStart ?? false,
    ...(args.workerReportMode ? { workerReportMode: args.workerReportMode } : {}),
    tmuxSession: args.tmuxSession ?? jobId,
    ...(args.cwd ? { cwd } : {}),
    ...(args.logPath ? { logPath: resolvePath(cwd, args.logPath) } : {}),
    outputFormat: args.outputFormat ?? "json",
  };
}

function jobManifestPatchFromArgs(args: JobUpdateMcpArgs): CodexGoalJobManifestPatch {
  const cwd = resolvePath(process.cwd(), args.cwd ?? process.cwd());
  const patch: Record<string, unknown> = {};
  putIfDefined(patch, "description", stringValue(args.description));
  const tags = tagValues(args.tags);
  if (args.tags !== undefined) patch.tags = tags;
  putIfDefined(patch, "jobRootDir", args.jobRootDir && resolvePath(cwd, args.jobRootDir));
  putIfDefined(patch, "authRootDir", args.authRootDir && resolvePath(cwd, args.authRootDir));
  putIfDefined(patch, "stateRootDir", args.stateRootDir && resolvePath(cwd, args.stateRootDir));
  putIfDefined(patch, "workspacePath", args.workspacePath && resolvePath(cwd, args.workspacePath));
  putIfDefined(patch, "promptPath", args.promptPath && resolvePath(cwd, args.promptPath));
  putIfDefined(patch, "codexGoalObjective", stringValue(args.codexGoalObjective));
  putIfDefined(patch, "taskId", stringValue(args.taskId));
  if (args.accounts !== undefined) patch.accounts = accountNames(args.accounts);
  putIfDefined(patch, "outputPath", args.outputPath && resolvePath(cwd, args.outputPath));
  putIfDefined(patch, "progressPath", args.progressPath && resolvePath(cwd, args.progressPath));
  putIfDefined(patch, "progressHeartbeatMs", numberValue(args.progressHeartbeatMs));
  putIfDefined(patch, "codexBinaryPath", stringValue(args.codexBinaryPath));
  putIfDefined(patch, "model", stringValue(args.model));
  putIfDefined(patch, "reasoningEffort", stringValue(args.reasoningEffort));
  putIfDefined(patch, "serviceTier", stringValue(args.serviceTier));
  putIfDefined(patch, "executionEngine", stringValue(args.executionEngine));
  putIfDefined(patch, "taskTimeoutMs", numberValue(args.taskTimeoutMs));
  putIfDefined(
    patch,
    "appServerStartupTimeoutMs",
    numberValue(args.appServerStartupTimeoutMs),
  );
  putIfDefined(patch, "staleLockMs", numberValue(args.staleLockMs));
  putIfDefined(patch, "maxAccountCycles", numberValue(args.maxAccountCycles));
  putIfDefined(
    patch,
    "editMode",
    optionalCodexGoalEditMode(stringValue(args.editMode), "editMode"),
  );
  putIfDefined(
    patch,
    "providerSandboxMode",
    optionalCodexGoalProviderSandboxMode(
      stringValue(args.providerSandboxMode),
      "providerSandboxMode",
    ),
  );
  putIfDefined(
    patch,
    "accessBoundary",
    optionalCodexGoalAccessBoundary(args.accessBoundary),
  );
  putIfDefined(
    patch,
    "projectAccessScope",
    parseCodexGoalProjectAccessScope(args.projectAccessScope),
  );
  putIfDefined(
    patch,
    "allowDangerFullAccess",
    booleanValue(args.allowDangerFullAccess),
  );
  putIfDefined(
    patch,
    "networkAccess",
    optionalCodexGoalNetworkAccess(args.networkAccess),
  );
  putIfDefined(
    patch,
    "allowDuplicateAccountIdentities",
    booleanValue(args.allowDuplicateAccountIdentities),
  );
  putIfDefined(patch, "requireGitWorkspace", booleanValue(args.requireGitWorkspace));
  putIfDefined(patch, "prewarmOnStart", booleanValue(args.prewarmOnStart));
  putIfDefined(patch, "workerReportMode", workerReportModeValue(args.workerReportMode));
  putIfDefined(patch, "tmuxSession", stringValue(args.tmuxSession));
  putIfDefined(patch, "cwd", args.cwd && cwd);
  putIfDefined(patch, "logPath", args.logPath && resolvePath(cwd, args.logPath));
  putIfDefined(patch, "outputFormat", stringValue(args.outputFormat));
  return patch as CodexGoalJobManifestPatch;
}

export async function buildCodexGoalBrief(input: {
  readonly jobId: string;
  readonly launch: CodexGoalLaunchInput;
  readonly status: Awaited<ReturnType<typeof collectCodexGoalStatus>>;
  readonly accounts: Awaited<ReturnType<typeof listCodexGoalAccountStatuses>>;
  readonly staleAfterMs: number;
  readonly tailLines: number;
  readonly targetCommit?: string;
}) {
  const result = input.status.resultPath
    ? await readRuntimeResultBrief(input.status.resultPath)
    : {};
  const baseRevision = assessBaseRevision({
    workerBase: result.baseCommit === undefined ? {} : { commit: result.baseCommit },
    ...(input.targetCommit === undefined
      ? {}
      : { target: { commit: input.targetCommit } }),
    outputChangedFiles: input.status.changedFiles ?? [],
    outputNoDiff: (input.status.changedFiles ?? []).length === 0 &&
      input.status.workspaceDirty !== true,
  });
  const lastProgressAt = latestIsoDate([
    input.status.progressUpdatedAt,
    input.status.logUpdatedAt,
    result.updatedAt,
  ]);
  const lastProgressMs = lastProgressAt ? Date.parse(lastProgressAt) : NaN;
  const lastProgressAgeMs = Number.isFinite(lastProgressMs)
    ? Date.now() - lastProgressMs
    : undefined;
  const isStale = Number.isFinite(lastProgressMs)
    ? (lastProgressAgeMs ?? 0) > input.staleAfterMs
    : false;
  const progressStale = input.status.progressHeartbeatAgeMs !== undefined &&
    input.status.progressHeartbeatAgeMs > input.staleAfterMs;
  const workerLiveness = resolveCodexGoalWorkerLiveness({
    status: input.status,
    progressStale,
  });
  const silentStale = Boolean(
    workerLiveness.alive &&
      input.status.recommendedAction === "wait_for_worker" &&
      isStale,
  );
  const heartbeatOnlyNoOutput = isHeartbeatOnlyNoOutputBrief({
    status: input.status,
    staleAfterMs: input.staleAfterMs,
  });
  const workerHealth = assessWorkerHealth({
    status: codexGoalBriefHealthStatus({
      status: input.status,
      workerAlive: workerLiveness.alive,
    }),
    processAlive: workerLiveness.alive,
    liveness: silentStale ? "stale" : workerLiveness.alive ? "alive" : "dead",
    staleAfterMs: input.staleAfterMs,
    progressStale,
    silentStale,
    heartbeatOnlyNoOutput,
    changedFilesCount: (input.status.changedFiles ?? []).length,
    ...(input.status.progressStatus === undefined
      ? {}
      : { progressStatus: input.status.progressStatus }),
    ...(input.status.progressHeartbeatAgeMs === undefined
      ? {}
      : { progressHeartbeatAgeMs: input.status.progressHeartbeatAgeMs }),
    ...(input.status.resultExists === undefined
      ? {}
      : { resultExists: input.status.resultExists }),
    ...(input.status.resultStatus === undefined
      ? {}
      : { resultStatus: input.status.resultStatus }),
    ...(input.status.workspaceDirty === undefined
      ? {}
      : { workspaceDirty: input.status.workspaceDirty }),
  });
  const invalidAccounts = input.accounts.filter((slot) => slot.status !== "ready");
  const capacityBlockedAccounts = input.accounts.filter((slot) =>
    slot.availability === "limited"
  );
  const duplicateAccounts = duplicateAccountGroups(input.accounts);
  const dedupedAccounts = dedupeCodexGoalAccountSlots(input.accounts);
  const availableDedupedAccounts = availableCodexGoalAccountSlots(dedupedAccounts);
  const safeStatusToContinue =
    !workerLiveness.alive && isSafeStartAction(input.status.recommendedAction);
  const hasAvailableAccount = availableDedupedAccounts.length > 0;
  const lifecycleMarkers = await readCodexGoalLifecycleMarkers({
    jobRootDir: input.launch.config.jobRootDir,
    taskId: input.launch.config.taskId,
  });
  const lifecycleMarkerTypes = lifecycleMarkers
    .map((marker) => marker.type)
    .filter((type): type is string => typeof type === "string");
  const reviewed = lifecycleMarkerTypes.includes("review");
  const reviewedStopped = Boolean(reviewed && !workerLiveness.alive);
  const reviewedWithoutResult = Boolean(
    reviewedStopped &&
      !input.status.resultExists &&
      !workerLiveness.alive,
  );
  const stoppedWithoutResult = Boolean(
    lifecycleMarkerTypes.includes("stop_event") &&
      !input.status.resultExists &&
      !workerLiveness.alive,
  );
  const maintenancePaused = Boolean(
    lifecycleMarkerTypes.includes("maintenance_pause") &&
      input.status.progressStatus === "maintenance_paused" &&
      !workerLiveness.alive,
  );
  const strictResultExists = result.strict === true;
  const needsResultReconcile = Boolean(
    !workerLiveness.alive &&
      !strictResultExists &&
      (
        (stoppedWithoutResult && !maintenancePaused) ||
        input.status.workspaceDirty ||
        (result.strict === false && !safeStatusToContinue)
      ),
  );
  const next = workerLiveness.alive && !silentStale && !heartbeatOnlyNoOutput
    ? {
        tool: "codex_goal_brief",
        reason: "worker is already running",
      }
    : needsResultReconcile
    ? {
        tool: "codex_goal_reconcile_result",
        reason: result.strict === false
          ? "non_strict_runtime_result"
          : "missing_runtime_result",
      }
    : silentStale
    ? {
        tool: "manual_review",
        reason: "silent_stale_worker",
      }
    : heartbeatOnlyNoOutput
    ? {
        tool: "manual_review",
        reason: "heartbeat_only_no_output",
      }
    : stoppedWithoutResult && !maintenancePaused
    ? {
        tool: "manual_review",
        reason: "stopped_worker",
      }
    : safeStatusToContinue && !hasAvailableAccount
    ? {
        tool: "codex_goal_accounts_status",
        reason: "no available account slots for this job",
      }
    : reviewedStopped
    ? {
        tool: "manual_review",
        reason: reviewedWithoutResult ? "reviewed_no_result" : "reviewed_result",
      }
    : nextActionForStatus(input.status.recommendedAction);
  const recentLogTail = redactLogTail(await safeTail(input.launch.logPath, input.tailLines));
  const currentAccount = result.currentAccount ?? input.status.progressCurrentAccount;
  const statusView = buildWorkerStatusView({
    health: workerHealth,
    staleAfterMs: input.staleAfterMs,
    baseStatus: baseRevision.status,
    dirtyFilesCount: (input.status.changedFiles ?? []).length,
    nextBestActionHint: String(next.tool),
    ...(baseRevision.workerBaseCommit === undefined
      ? {}
      : { baseCommit: baseRevision.workerBaseCommit }),
    ...(baseRevision.targetCommit === undefined
      ? {}
      : { targetCommit: baseRevision.targetCommit }),
    ...(input.launch.config.model === undefined
      ? {}
      : { model: input.launch.config.model }),
    ...(input.launch.config.reasoningEffort === undefined
      ? {}
      : { effort: input.launch.config.reasoningEffort }),
    ...(input.launch.config.serviceTier === undefined
      ? {}
      : { serviceTier: input.launch.config.serviceTier }),
    ...(currentAccount === undefined ? {} : { account: currentAccount }),
    ...(input.launch.config.accessBoundary === undefined
      ? {}
      : { accessBoundary: input.launch.config.accessBoundary }),
    ...(lastProgressAgeMs === undefined ? {} : { freshAgeMs: lastProgressAgeMs }),
  });
  return {
    text: [
      workerLiveness.alive ? "worker alive" : "worker not running",
      `recommendedAction ${input.status.recommendedAction}`,
      lastProgressAt ? `lastProgressAt ${lastProgressAt}` : "lastProgressAt unknown",
      input.status.progressUpdatedAt
        ? `progressUpdatedAt ${input.status.progressUpdatedAt}`
        : "progressUpdatedAt unknown",
      input.status.progressStatus
        ? `progressStatus ${input.status.progressStatus}`
        : "progressStatus unknown",
      input.status.appServerProcessAlive === undefined
        ? "appServerProcessAlive unknown"
        : `appServerProcessAlive ${String(input.status.appServerProcessAlive)}`,
      input.status.workspaceDirty === undefined
        ? "workspace dirty unknown"
        : `workspace dirty ${input.status.workspaceDirty}`,
      input.status.changedFiles?.length
        ? `changed files ${input.status.changedFiles.length}`
        : "changed files 0",
      silentStale ? "silentStale true" : "silentStale false",
      heartbeatOnlyNoOutput
        ? "heartbeatOnlyNoOutput true"
        : "heartbeatOnlyNoOutput false",
      lifecycleMarkerTypes.length
        ? `lifecycle markers ${lifecycleMarkerTypes.join(",")}`
        : "lifecycle markers none",
      reviewedStopped ? "reviewedStopped true" : "reviewedStopped false",
      reviewedWithoutResult ? "reviewedWithoutResult true" : "reviewedWithoutResult false",
      stoppedWithoutResult ? "stoppedWithoutResult true" : "stoppedWithoutResult false",
      maintenancePaused ? "maintenancePaused true" : "maintenancePaused false",
    ].join(", "),
    lastProgressAt,
    lastProgressAgeMs,
    staleAfterMs: input.staleAfterMs,
    isStale,
    workerAlive: workerLiveness.alive,
    workerSupervisorKind: workerLiveness.supervisorKind,
    workerAliveReason: workerLiveness.aliveReason,
    workerProcessAlive: workerLiveness.processAlive,
    workerFreshProgressAlive: workerLiveness.freshProgressAlive,
    workerHealth,
    statusView,
    baseRevision,
    baseRevisionStatus: baseRevision.status,
    baseRevisionReasons: baseRevision.reasons,
    handoffArtifacts: result.artifacts ?? [],
    handoffBaseCommit: result.baseCommit,
    handoffPatchPath: result.patchPath,
    handoffSummaryPath: result.summaryPath,
    activeWriterRisk: workerHealth.activeWriterRisk.kind,
    activeWriterRiskReasons: workerHealth.activeWriterRisk.reasons,
    silentStale,
    heartbeatOnlyNoOutput,
    logExists: input.status.logExists,
    logByteLength: input.status.logByteLength,
    progressPath: input.status.progressPath,
    progressExists: input.status.progressExists,
    progressStatus: input.status.progressStatus,
    progressUpdatedAt: input.status.progressUpdatedAt,
    progressHeartbeatAgeMs: input.status.progressHeartbeatAgeMs,
    progressPid: input.status.progressPid,
    progressProcessAlive: input.status.progressProcessAlive,
    appServerProcessAlive: input.status.appServerProcessAlive,
    appServerProcessPid: input.status.appServerProcessPid,
    progressResultStatus: input.status.progressResultStatus,
    progressResultReason: input.status.progressResultReason,
    progressAttemptCount: input.status.progressAttemptCount,
    progressCurrentAccount: input.status.progressCurrentAccount,
    runtimeEventsPath: input.status.runtimeEventsPath,
    runtimeEventsExists: input.status.runtimeEventsExists,
    runtimeEventsByteLength: input.status.runtimeEventsByteLength,
    lastRuntimeEvent: input.status.lastRuntimeEvent,
    lastRuntimeEventAt: input.status.lastRuntimeEventAt,
    lastRuntimeEventLevel: input.status.lastRuntimeEventLevel,
    currentAccount: result.currentAccount,
    lastFailureReason: input.status.resultReason ?? result.lastFailureReason,
    changedFiles: input.status.changedFiles ?? [],
    safeToContinue:
      workerHealth.safeToContinue &&
      safeStatusToContinue &&
      hasAvailableAccount &&
      !reviewedStopped &&
      !reviewedWithoutResult &&
      (!stoppedWithoutResult || maintenancePaused),
    hasAvailableAccount,
    configuredAccounts: input.accounts.map((slot) => slot.name),
    dedupedAccounts: dedupedAccounts.map((slot) => slot.name),
    availableDedupedAccounts: availableDedupedAccounts.map((slot) => slot.name),
    needsHumanRelogin: invalidAccounts.length > 0,
    invalidAccounts: invalidAccounts.map((slot) => slot.name),
    duplicateAccounts,
    lifecycleMarkers,
    lifecycleMarkerTypes,
    maintenancePaused,
    capacityBlockedAccounts: capacityBlockedAccounts.map((slot) => ({
      name: slot.name,
      availability: slot.availability,
      reason: slot.capacityReason,
      cooldownUntil: slot.limitResetAt ?? slot.capacityCooldownUntil,
    })),
    recentCommands: extractRecentCommands(recentLogTail),
    nextBestTool: next.tool,
    nextBestReason: next.reason,
    nextBestCommand: nextBestCommand({
      jobId: input.jobId,
      action: next,
      status: input.status,
      launch: input.launch,
    }),
    recentLogTail,
  };
}

async function targetCommitFromArgs(
  args: Pick<JobBriefMcpArgs, "cwd" | "targetCommit" | "targetWorkspacePath">,
): Promise<string | undefined> {
  const commit = stringValue(args.targetCommit);
  if (commit) {
    assertSafeGitCommitSha(commit);
    return commit;
  }
  const workspacePath = stringValue(args.targetWorkspacePath);
  if (!workspacePath) return undefined;
  const cwd = resolvePath(process.cwd(), args.cwd ?? process.cwd());
  const target = await readTargetRevision(new LocalGitRevisionReader(), {
    workspacePath: resolvePath(cwd, workspacePath),
  });
  return target.commit;
}

function optionalTargetCommit(
  targetCommit: string | undefined,
): { readonly targetCommit?: string } {
  return targetCommit === undefined ? {} : { targetCommit };
}

function registerCodexGoalPrompts(server: McpServer): void {
  for (const prompt of [
    ["start_codex_goal_worker", "Start a stored Codex goal worker safely."],
    ["monitor_codex_goal_worker", "Monitor a running Codex goal worker."],
    ["recover_codex_goal_worker", "Recover a stopped Codex goal worker."],
    ["handoff_codex_goal_job", "Prepare a handoff for another agent."],
    ["review_worker_changes", "Review worker changes before merge or commit."],
  ] as const) {
    server.registerPrompt(
      prompt[0],
      {
        title: prompt[0],
        description: prompt[1],
        argsSchema: { jobId: z.string().optional() },
      },
      ({ jobId }) => ({
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: codexGoalPromptText(prompt[0], jobId),
          },
        }],
      }),
    );
  }
}

function codexGoalPromptText(name: string, jobId: string | undefined): string {
  const id = jobId?.trim() || "<jobId>";
  const shared =
    `Use the subscription-runtime Codex goal MCP tools for jobId ${id}. ` +
    "Never print auth.json or tokens. Do not run two writer workers in the same worktree. " +
    "Treat codex_goal_overview as the registry monitor, codex_goal_brief as the single-job monitor, and codex_goal_decision as the read-only action gate for safeToContinue, blockers, evidence and nextBestCommand.";
  if (name === "start_codex_goal_worker") {
    return `${shared} First call codex_goal_decision. Start or continue only when decision.safeToContinue is true, otherwise follow decision.checklist and decision.nextBestCommand. If no job exists yet, create one with model gpt-5.5, reasoningEffort high, serviceTier default, app-server-goal behavior and 72h timeout.`;
  }
  if (name === "monitor_codex_goal_worker") {
    return `${shared} Call codex_goal_overview for pool-level status, codex_goal_brief for monitoring, and codex_goal_decision before taking action. If worker is alive and silentStale is false, keep monitoring instead of starting another worker. If silentStale is true, verify progress heartbeat, tmux, runner process, app-server process, recent log tail and git status before stopping or recovery.`;
  }
  if (name === "recover_codex_goal_worker") {
    return `${shared} Use codex_goal_recover only for safe capacity, auth, reconnect or timeout states and only when decision.safeToContinue is true. If decision.action is fix_accounts, call codex_goal_accounts_status for the job. Inspect dirty, provider_output_invalid, unknown runtime, test and benchmark failures manually.`;
  }
  if (name === "handoff_codex_goal_job") {
    return `${shared} Provide jobId, registryRootDir if non-default, worktree, branch, tmux session, task id, prompt path, accounts, model, effort, service tier, decision.action, decision.safeToContinue, decision.nextBestCommand and any dirty files.`;
  }
  return `${shared} Inspect git diff, result JSON, recent commands and test evidence before merging. Use codex_goal_mark_reviewed only after the worker output has been reviewed.`;
}

function goalInputSchema(): Record<string, z.ZodTypeAny> {
  return {
    jobId: z.string().optional(),
    configPath: z.string().optional(),
    jobRootDir: z.string().optional(),
    authRootDir: z.string().optional(),
    stateRootDir: z.string().optional(),
    workspacePath: z.string().optional(),
    promptPath: z.string().optional(),
    codexGoalObjective: z.string().max(codexGoalObjectiveMaxChars).describe(
      "Short app-server goal objective, max 4000 characters. For long instructions, keep the full task in promptPath and reference docs/files here.",
    ).optional(),
    taskId: z.string().optional(),
    accounts: z.union([z.string(), z.array(z.string())]).optional(),
    outputPath: z.string().optional(),
    progressPath: z.string().optional(),
    progressHeartbeatMs: z.number().int().positive().optional(),
    codexBinaryPath: z.string().optional(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    serviceTier: z.string().optional(),
    executionEngine: CODEX_GOAL_EXECUTION_ENGINE_SCHEMA.optional(),
    taskTimeoutMs: z.number().int().positive().optional(),
    appServerStartupTimeoutMs: z.number().int().positive().optional(),
    staleLockMs: z.number().int().positive().optional(),
    maxAccountCycles: z.number().int().positive().optional(),
    editMode: z.string().optional(),
    providerSandboxMode: z.string().optional(),
    accessBoundary: z.string().optional(),
    projectAccessScope: z.record(z.string(), z.unknown()).optional(),
    allowDangerFullAccess: z.boolean().optional(),
    networkAccess: z.string().optional(),
    allowDuplicateAccountIdentities: z.boolean().optional(),
    requireGitWorkspace: z.boolean().optional(),
    prewarmOnStart: z.boolean().optional(),
    workerReportMode: z.enum(["runtime-only", "structured-output"]).optional(),
    tmuxSession: z.string().optional(),
    cwd: z.string().optional(),
    logPath: z.string().optional(),
    outputFormat: z.enum(["text", "json"]).optional(),
  };
}

function statusInputSchema(): Record<string, z.ZodTypeAny> {
  return {
    jobRootDir: z.string().optional(),
    taskId: z.string().optional(),
    workspacePath: z.string().optional(),
    tmuxSession: z.string().optional(),
    logPath: z.string().optional(),
    progressPath: z.string().optional(),
    accessBoundary: z.string().optional(),
    cwd: z.string().optional(),
  };
}

function statusInput(launch: CodexGoalLaunchInput) {
  return {
    jobRootDir: launch.config.jobRootDir,
    taskId: launch.config.taskId,
    ...(launch.config.outputPath ? { resultPath: launch.config.outputPath } : {}),
    workspacePath: launch.config.workspacePath,
    ...(launch.tmuxSession ? { tmuxSession: launch.tmuxSession } : {}),
    logPath: launch.logPath,
    ...(launch.config.progressPath ? { progressPath: launch.config.progressPath } : {}),
    ...(launch.config.accessBoundary === undefined
      ? {}
      : { accessBoundary: launch.config.accessBoundary }),
  };
}

function launchSummary(launch: CodexGoalLaunchInput): JsonObject {
  return {
    ...(launch.config.jobId ? { jobId: launch.config.jobId } : {}),
    taskId: launch.config.taskId,
    workspacePath: launch.config.workspacePath,
    promptPath: launch.config.promptPath,
    accountNames: launch.config.accounts.map((account) => account.name),
    model: launch.config.model,
    reasoningEffort: launch.config.reasoningEffort,
    serviceTier: launch.config.serviceTier,
    executionEngine: launch.config.executionEngine ?? "app-server-goal",
    taskTimeoutMs: launch.config.taskTimeoutMs,
    appServerStartupTimeoutMs: launch.config.appServerStartupTimeoutMs,
    progressPath: launch.config.progressPath,
    progressHeartbeatMs: launch.config.progressHeartbeatMs,
    maxAccountCycles: launch.config.maxAccountCycles,
    tmuxSession: launch.tmuxSession,
    logPath: launch.logPath,
  };
}

async function readGoalConfigFile(path: string): Promise<JsonObject> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed)) throw new Error("configPath must contain a JSON object");
  return parsed;
}

function defaultCliCommand(importMetaUrl: string): readonly string[] {
  return [
    execPath,
    join(dirname(fileURLToPath(importMetaUrl)), "codex-goal-cli.js"),
  ];
}

function mergeDefined(...items: readonly JsonObject[]): JsonObject {
  const merged: Record<string, unknown> = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

async function projectControlDefaultAccountNames(input: {
  readonly authRootDir?: string;
  readonly requestedAccounts: readonly string[];
  readonly allowedAccountIds: readonly string[];
}): Promise<readonly string[]> {
  if (!input.authRootDir) return input.requestedAccounts;
  const allowed = new Set(input.allowedAccountIds);
  const slots = await listCodexGoalAccountStatuses({
    authRootDir: input.authRootDir,
  });
  const readyAccounts = slots
    .filter((slot) =>
      slot.status === "ready" &&
      (allowed.size === 0 || allowed.has(slot.name))
    )
    .map((slot) => slot.name);
  return readyAccounts.length > 0 ? readyAccounts : input.requestedAccounts;
}

async function projectControlRefillAccountNames(input: {
  readonly authRootDir?: string;
  readonly requestedAccounts: readonly string[];
  readonly allowedAccountIds: readonly string[];
}): Promise<readonly string[]> {
  const requestedAccounts = input.requestedAccounts.length
    ? uniqueProjectControlStrings(input.requestedAccounts)
    : await projectControlDefaultAccountNames(input);
  const allowed = new Set(input.allowedAccountIds);
  const scopedAccounts = requestedAccounts.filter((account) =>
    allowed.size === 0 || allowed.has(account)
  );
  if (!input.authRootDir || scopedAccounts.length === 0) return scopedAccounts;

  const slots = await listCodexGoalAccountStatuses({
    authRootDir: input.authRootDir,
    accounts: scopedAccounts,
  });
  const ready = new Set(
    slots
      .filter((slot) => slot.status === "ready")
      .map((slot) => slot.name),
  );
  return ready.size > 0
    ? scopedAccounts.filter((account) => ready.has(account))
    : scopedAccounts;
}

function mcpJson(value: JsonObject) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function jsonRecordFromProjectControlArgs(
  args: ProjectControlMcpArgs,
): ProjectControlOperationJsonRecord {
  return JSON.parse(JSON.stringify(args)) as ProjectControlOperationJsonRecord;
}

function controlledAgentOwnerIsLive(owner: ControlledAgentProcessOwner): boolean {
  if (owner.hostname !== undefined && owner.hostname !== hostname()) return true;
  if (owner.pid === undefined) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withMcpErrors(
  action: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await action();
  } catch (error) {
    const value = {
      ok: false,
      error: error instanceof Error ? error.message : "codex_goal_mcp_error",
    };
    return {
      ...mcpJson(value),
      isError: true,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
