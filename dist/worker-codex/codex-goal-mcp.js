#!/usr/bin/env node
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate, } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { sessionArtifactFromCodexAuthJson } from "@vioxen/subscription-runtime/provider-codex";
import { LocalFileRunEventProjectionStateStore, LocalFileRunEventStore, LocalControlledAgentStateStore, } from "@vioxen/subscription-runtime/store-local-file";
import { buildLocalClaudeControlledAgentProfile, createLocalClaudeControlledAgentProvider, loadScopedClaudeSessionArtifact, watchClaudeRuns, } from "@vioxen/subscription-runtime/worker-local";
import { AccessBoundary, LaunchPlanStatus, NetworkAccessMode, ProjectAdmissionWorkerRole, RunObservationService, InterruptAndContinueWorkerUseCase, RunEventProviderKind, buildControlledAgentLaunchPlan, buildControlledAgentLiveControllerState, buildControlledAgentProcessOwner, getControlledAgentStatus, reconcileControlledAgentRun, startControlledAgentRun, stopControlledAgentRun, evaluateProjectAdmission, projectRunObservationEvents, projectRunReadModelsFromEvents, reconcileRunPreview, runEventProviderKindFromString, ProjectOperation, } from "@vioxen/subscription-runtime/worker-core";
import { codexGoalJobToArgs, createCodexGoalJob, listCodexGoalJobs, readCodexGoalJob, resolveCodexGoalJobRegistryRoot, summarizeCodexGoalJob, updateCodexGoalJob, } from "./codex-goal-jobs.js";
import { upsertCodexGoalLaunchManifest } from "./codex-goal-launch-manifest.js";
import { runDependencyBootstrap, } from "./dependency-bootstrap.js";
import { codexGoalProgressPath, } from "./codex-goal-runner.js";
import { buildCodexGoalNoTmuxCommand, buildCodexGoalStopTmuxCommand, buildCodexGoalTmuxCommand, collectCodexGoalStatus, doctorCodexGoal, listCodexGoalAccountStatuses, prepareCodexGoalLaunchPaths, reconcileCodexGoalRuntimeResult, resolveCodexGoalWorkerLiveness, startCodexGoalTmux, stopCodexGoalTmux, tailCodexGoalLog, } from "./codex-goal-ops.js";
import { CodexRunObservationAdapter } from "./codex-run-observation.js";
import { parseCodexGoalProjectAccessScope, } from "./codex-goal-access-plan.js";
import { projectControlGenericScopeDenial, projectControlGenericToolDenial, } from "./project-control-scope-guard.js";
import { registerProjectIntegrationMcpTools, } from "./project-integration-mcp/index.js";
import { createLocalProjectIntegrationMcpToolHandlers, } from "./project-integration-mcp/adapters/local-project-integration-mcp-tool-handlers.js";
import { buildCodexControlledAgentProfile, CodexControlledAgentProvider, } from "./controlled-agent/index.js";
import { projectControllerCapacityDemand, recordProjectControllerCapacitySignal, } from "./project-controller-capacity.js";
import { createProjectControlOperation, patchProjectControlOperation, projectControlOperationExecutionMode, projectControlOperationView, projectControlOperationsRoot, readProjectControlOperationById, startProjectControlOperationRunner, } from "./project-control-operation-lifecycle.js";
import { accountNames, booleanValue, numberValue, requiredRawString, resolvePath, stringValue, tagValues, } from "./codex-goal-mcp-values.js";
import { jobIdInputSchema, jobRegistryInputSchema, optionalRunEventProviderKind, registryRootFromArgs, runEventRetentionPolicyFromArgs, runEventRootFromArgs, runEventTypeFilter, } from "./codex-goal-mcp-inputs.js";
import { accountAuthRootFromArgs, accountPoolRootFromArgs, availableCodexGoalAccountSlots, codexAccountReloginInstructions, codexAccountStatusPayload, dedupeCodexGoalAccountSlots, listAccountPools, } from "./codex-goal-mcp-accounts.js";
import { writeCodexGoalMaintenancePauseEvent, writeCodexGoalStopEvent, writeCodexGoalStoppedProgress, } from "./codex-goal-mcp-lifecycle-markers.js";
import { matchesProjectControlPrefix, pathInsideAnyProjectRoot, stringArrayArg, uniqueProjectControlStrings, } from "./codex-goal-mcp-project-utils.js";
import { projectControlDefaultAccountNames, projectControlRefillAccountNames, } from "./codex-goal-mcp-project-accounts.js";
import { buildCodexProjectAdmissionSnapshot, projectAdmissionDetailView, projectAdmissionOperation, projectAdmissionWorkerRoleArg, } from "./codex-goal-mcp-project-admission.js";
import { jobIdsFromValue, parseIsoDate, signalIdList, workerControlCallerArgs, workerControlDecisionJson, workerControlReceiptJson, workerControlSignalJson, workerControlSignalViewJson, } from "./codex-goal-mcp-worker-control-view.js";
import { codexGoalAccountStatusPayload, codexGoalStateRootDir, codexGoalWorkerControlService, codexGoalWorkerControlTarget, } from "./codex-goal-mcp-worker-control.js";
import { codexGoalAccountCapacityFacts } from "./codex-goal-mcp-account-capacity-facts.js";
import { applyWorkspaceConflictToOverviewJob, buildCodexGoalWorkspaceConflicts, workspaceConflictJobIds, } from "./codex-goal-mcp-workspace-conflicts.js";
import { codexOverviewItemToWatchStatus } from "./codex-goal-mcp-watch-status.js";
import { failedRunObservationSnapshot, observeOrphanCodexRun, safeObservationErrorMessage, summarizeRunObservationSnapshots, } from "./codex-goal-mcp-observation-projection.js";
import { buildCodexGoalBrief } from "./codex-goal-mcp-brief.js";
import { jobManifestInputFromArgs, jobManifestPatchFromArgs, } from "./codex-goal-mcp-manifest-args.js";
import { mcpJson, withMcpErrors, } from "./codex-goal-mcp-response.js";
import { registerCodexGoalPrompts } from "./codex-goal-mcp-prompts.js";
import { optionalTargetCommit, targetCommitFromArgs, } from "./codex-goal-mcp-target-commit.js";
import { goalInputSchema, statusInputSchema, } from "./codex-goal-mcp-input-schemas.js";
export { buildCodexGoalBrief } from "./codex-goal-mcp-brief.js";
import { buildCodexGoalOverviewItem } from "./codex-goal-mcp-overview-item.js";
import { codexGoalStatusInputFromLaunch as statusInput, } from "./codex-goal-mcp-status-input.js";
import { createCodexProjectControlBroker, projectControlAuditPath, } from "./codex-goal-mcp-project-broker.js";
import { assertReadablePrompt, createOrReuseProjectJob, createOrReuseProjectWorktree, readTextFileIfExists, rollbackProjectRefillPartial, } from "./codex-goal-mcp-project-refill.js";
import { goalLaunchInput, } from "./codex-goal-mcp-launch-input.js";
import { codexGoalLaunchSummary as launchSummary, } from "./codex-goal-mcp-launch-summary.js";
import { CODEX_GOAL_CONTROL_SURFACE_SCHEMA, buildCodexGoalDecision, buildCodexGoalHandoff, isSafeStartAction, nextActionForStatus, redactText, truncateText, } from "./codex-goal-mcp-decision.js";
import { assertSafeGitCommitSha, assertSafeGitRefName, assertSafeGitRemoteName, } from "./codex-goal-mcp-project-git.js";
import { assertProjectControlCreateManifestPaths, assertProjectControlDependencyBootstrapReady, assertProjectControlScopeRepairAllowed, projectControlChildScope, projectControlDependencyBootstrapMode, projectControlPathArg, projectControlRealPathOutsideWorkspaceScope, projectControlWorkerRole, projectScopeFieldFingerprint, } from "./codex-goal-mcp-project-scope.js";
import { projectIntegrationPushApprovedCommitWithConsumedLedger, } from "./codex-goal-mcp-project-integration-ledger.js";
export { availableCodexGoalAccountSlots, dedupeCodexGoalAccountSlots, visibleCodexGoalAccountPoolSlots, } from "./codex-goal-mcp-accounts.js";
const serverVersion = "0.1.0-main.2";
const controlledAgentProcessOwner = buildControlledAgentProcessOwner({
    runtimeVersion: serverVersion,
    ...(process.env.SUBSCRIPTION_RUNTIME_RELEASE_SHA === undefined
        ? {}
        : { runtimeSha: process.env.SUBSCRIPTION_RUNTIME_RELEASE_SHA }),
    pid: process.pid,
});
const controlledAgentProviders = new Map();
export function createCodexGoalMcpServer(options = {}) {
    const server = new McpServer({
        name: "subscription-runtime-codex-goal",
        version: serverVersion,
    });
    server.registerResource("codex-goal-job", new ResourceTemplate("codex-goal://jobs/{jobId}", {
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
    }), {
        title: "Codex Goal Job",
        description: "A stored Codex goal job manifest.",
        mimeType: "application/json",
    }, async (uri, { jobId }) => {
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
    });
    registerCodexGoalPrompts(server);
    server.registerTool("codex_goal_list_jobs", {
        title: "List Codex Goal Jobs",
        description: "List stored Codex goal job manifests.",
        inputSchema: jobRegistryInputSchema(),
    }, async (args) => withMcpErrors(async () => {
        const registryRootDir = registryRootFromArgs(args);
        const jobs = await listCodexGoalJobs({ registryRootDir });
        return mcpJson({ ok: true, registryRootDir, jobs });
    }));
    server.registerTool("codex_goal_overview", {
        title: "Codex Goal Overview",
        description: "Summarize all stored Codex goal jobs with compact status, account and next-action hints.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            staleAfterMs: z.number().int().positive().optional(),
            tailLines: z.number().int().positive().optional(),
            limit: z.number().int().positive().optional(),
            jobIdPrefix: z.string().optional(),
        },
    }, async (args) => withMcpErrors(async () => {
        const overview = await buildCodexGoalOverview(args);
        return mcpJson(overview);
    }));
    server.registerTool("codex_goal_reconcile_preview", {
        title: "Codex Goal Reconcile Preview",
        description: "Run one safe reconciliation-preview pass over stored jobs. Dry-run by default; continues only when continueSafeJobs is true and each job is safe. This is not pure watch.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            staleAfterMs: z.number().int().positive().optional(),
            tailLines: z.number().int().positive().optional(),
            jobIds: z.union([z.string(), z.array(z.string())]).optional(),
            continueSafeJobs: z.boolean().optional(),
            maxContinuesPerRun: z.number().int().positive().optional(),
            skipDoctor: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => {
        const watch = await reconcilePreviewCodexGoalJobs(args);
        return mcpJson(watch);
    }));
    const agentRunWatchTool = {
        title: "Agent Run Watch",
        description: "Read-only provider-neutral run observation. Reports status, liveness, progress, logs, workspace changes, capacity hints and read-only recommendations without starting, stopping or continuing workers.",
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
    server.registerTool("agent_run_watch", agentRunWatchTool, async (args) => withMcpErrors(async () => {
        const watch = await watchAgentRuns(args);
        return mcpJson(watch);
    }));
    server.registerTool("codex_goal_run_watch", {
        ...agentRunWatchTool,
        title: "Codex Goal Run Watch",
        description: "Codex-scoped read-only run observation. Reports status, liveness, progress, logs, workspace changes, capacity hints and read-only recommendations without starting, stopping or continuing workers.",
    }, async (args) => withMcpErrors(async () => {
        const watch = await watchAgentRuns(args);
        return mcpJson(watch);
    }));
    const agentRunEventsTool = {
        title: "Agent Run Events",
        description: "Read normalized durable run events from the local outbox. This is read-only and does not observe, start, stop, continue or recover workers.",
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
    server.registerTool("agent_run_events", agentRunEventsTool, async (args) => withMcpErrors(async () => {
        const events = await readAgentRunEvents(args);
        return mcpJson(events);
    }));
    server.registerTool("codex_goal_events", {
        ...agentRunEventsTool,
        title: "Codex Goal Events",
        description: "Read normalized durable Codex goal run events from the local outbox. This is read-only and does not observe, start, stop, continue or recover workers.",
    }, async (args) => withMcpErrors(async () => {
        const events = await readAgentRunEvents({
            ...args,
            providerKind: "codex",
        });
        return mcpJson(events);
    }));
    const agentRunStateTool = {
        title: "Agent Run State",
        description: "Read projected run read-model state from the local event projection store. This is read-only and does not observe, start, stop, continue or recover workers.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            providerKind: z.string().optional(),
            jobId: z.string(),
            eventRootDir: z.string().optional(),
        },
    };
    server.registerTool("agent_run_state", agentRunStateTool, async (args) => withMcpErrors(async () => {
        const state = await readAgentRunState(args);
        return mcpJson(state);
    }));
    server.registerTool("codex_goal_state", {
        ...agentRunStateTool,
        title: "Codex Goal State",
        description: "Read projected Codex goal run read-model state from the local event projection store. This is read-only and does not observe, start, stop, continue or recover workers.",
    }, async (args) => withMcpErrors(async () => {
        const state = await readAgentRunState({
            ...args,
            providerKind: "codex",
        });
        return mcpJson(state);
    }));
    const agentRunEventCompactionTool = {
        title: "Agent Run Event Compaction",
        description: "Plan or run explicit local RunEvent JSONL compaction. This touches only the event outbox and delivery cursors; it does not observe, start, stop, continue or recover workers.",
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
    server.registerTool("agent_run_event_compaction_plan", {
        ...agentRunEventCompactionTool,
        title: "Agent Run Event Compaction Plan",
        description: "Read-only plan for local RunEvent JSONL compaction. No files are rewritten.",
    }, async (args) => withMcpErrors(async () => {
        const plan = await planAgentRunEventCompaction(args);
        return mcpJson(plan);
    }));
    server.registerTool("agent_run_event_compact", {
        ...agentRunEventCompactionTool,
        title: "Agent Run Event Compact",
        description: "Run explicit local RunEvent JSONL compaction. Requires confirmCompact=true and never controls workers.",
    }, async (args) => withMcpErrors(async () => {
        const result = await compactAgentRunEvents(args);
        return mcpJson(result);
    }));
    const agentRunProjectEventsTool = {
        title: "Agent Run Project Events",
        description: "Observe runs and project normalized durable RunEvent records into the local outbox. This writes event/projection state only; it does not start, stop, continue or recover workers.",
        inputSchema: {
            ...agentRunWatchTool.inputSchema,
            eventRootDir: z.string().optional(),
            hostId: z.string().optional(),
            type: z.union([z.string(), z.array(z.string())]).optional(),
            types: z.union([z.string(), z.array(z.string())]).optional(),
        },
    };
    server.registerTool("agent_run_project_events", agentRunProjectEventsTool, async (args) => withMcpErrors(async () => {
        const projected = await projectAgentRunEvents(args);
        return mcpJson(projected);
    }));
    server.registerTool("codex_goal_project_events", {
        ...agentRunProjectEventsTool,
        title: "Codex Goal Project Events",
        description: "Observe Codex goal runs and project normalized durable RunEvent records into the local outbox. This writes event/projection state only; it does not start, stop, continue or recover workers.",
    }, async (args) => withMcpErrors(async () => {
        const projected = await projectAgentRunEvents({
            ...args,
            providerKind: "codex",
        });
        return mcpJson(projected);
    }));
    server.registerTool("codex_goal_get_job", {
        title: "Get Codex Goal Job",
        description: "Read one Codex goal job manifest by jobId.",
        inputSchema: jobIdInputSchema(),
    }, async (args) => withMcpErrors(async () => {
        const registryRootDir = registryRootFromArgs(args);
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
    }));
    server.registerTool("codex_goal_create_job", {
        title: "Create Codex Goal Job",
        description: "Create a versioned job.json manifest so future tools can operate by jobId.",
        inputSchema: {
            ...goalInputSchema(),
            ...jobIdInputSchema(),
            description: z.string().optional(),
            tags: z.union([z.string(), z.array(z.string())]).optional(),
            overwrite: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => {
        const registryRootDir = registryRootFromArgs(args);
        const createManifest = jobManifestInputFromArgs(args);
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
        if (projectControlDenial)
            return mcpJson(projectControlDenial);
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
    }));
    server.registerTool("codex_goal_update_job", {
        title: "Update Codex Goal Job",
        description: "Patch an existing job.json manifest by jobId.",
        inputSchema: {
            ...goalInputSchema(),
            ...jobIdInputSchema(),
            description: z.string().optional(),
            tags: z.union([z.string(), z.array(z.string())]).optional(),
        },
    }, async (args) => withMcpErrors(async () => {
        const updateArgs = args;
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
        if (projectControlDenial)
            return mcpJson(projectControlDenial);
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
    }));
    server.registerTool("codex_goal_status_by_id", {
        title: "Codex Goal Status By Job",
        description: "Inspect a stored Codex goal job using only jobId.",
        inputSchema: jobIdInputSchema(),
    }, async (args) => withMcpErrors(async () => {
        const registryRootDir = registryRootFromArgs(args);
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
    }));
    server.registerTool("codex_goal_recommend_next_action", {
        title: "Recommend Codex Goal Action",
        description: "Return the next safe lifecycle action for a stored job.",
        inputSchema: jobIdInputSchema(),
    }, async (args) => withMcpErrors(async () => {
        const loaded = await loadJobLaunch(args);
        const status = await collectCodexGoalStatus(statusInput(loaded.launch));
        return mcpJson({
            ok: true,
            registryRootDir: loaded.registryRootDir,
            jobId: loaded.manifest.jobId,
            status,
            next: nextActionForStatus(status.recommendedAction),
            summary: summarizeCodexGoalJob(loaded.manifest, loaded.registryRootDir),
        });
    }));
    server.registerTool("codex_goal_assert_single_writer", {
        title: "Assert Single Codex Writer",
        description: "Check whether starting another writer for this job would be safe.",
        inputSchema: jobIdInputSchema(),
    }, async (args) => withMcpErrors(async () => {
        const loaded = await loadJobLaunch(args);
        const status = await collectCodexGoalStatus(statusInput(loaded.launch));
        const progressStale = status.progressHeartbeatAgeMs !== undefined &&
            status.progressHeartbeatAgeMs >
                (numberValue(args.staleAfterMs) ?? 10 * 60_000);
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
    }));
    server.registerTool("codex_goal_reconcile_result", {
        title: "Reconcile Codex Goal Runtime Result",
        description: "Write a strict latest-result.json for a stopped or stale Codex goal when the worker crashed, was stopped, or left a non-strict result.",
        inputSchema: {
            ...jobIdInputSchema(),
            forceWrite: z.boolean().optional(),
            preservePatch: z.boolean().optional(),
            staleAfterMs: z.number().int().positive().optional(),
            tailLines: z.number().int().positive().optional(),
        },
    }, async (args) => withMcpErrors(async () => reconcileStoredJobRuntimeResult(args)));
    server.registerTool("codex_goal_continue", {
        title: "Continue Codex Goal",
        description: "Safely continue a stored job by jobId when status allows continuation.",
        inputSchema: {
            ...jobIdInputSchema(),
            confirmContinue: z.boolean().optional(),
            skipDoctor: z.boolean().optional(),
            forceStart: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => continueStoredJob(args, {
        confirmKey: "confirmContinue",
        mode: "continue",
    })));
    server.registerTool("codex_goal_recover", {
        title: "Recover Codex Goal",
        description: "Recover a stored job after quota, auth, reconnect or timeout status.",
        inputSchema: {
            ...jobIdInputSchema(),
            confirmRecover: z.boolean().optional(),
            skipDoctor: z.boolean().optional(),
            forceStart: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => continueStoredJob(args, {
        confirmKey: "confirmRecover",
        mode: "recover",
    })));
    server.registerTool("codex_goal_stop", {
        title: "Stop Codex Goal Worker",
        description: "Stop a stored job's tmux worker after explicit confirmation. Default guard allows silent-stale workers only.",
        inputSchema: {
            ...jobIdInputSchema(),
            confirmStop: z.boolean().optional(),
            forceStop: z.boolean().optional(),
            staleAfterMs: z.number().int().positive().optional(),
            tailLines: z.number().int().positive().optional(),
        },
    }, async (args) => withMcpErrors(async () => stopStoredJob(args)));
    server.registerTool("codex_goal_maintenance_pause", {
        title: "Maintenance Pause Codex Goal Worker",
        description: "Stop a stored job's tmux worker for planned maintenance without reconciling it as a runtime failure.",
        inputSchema: {
            ...jobIdInputSchema(),
            confirmPause: z.boolean().optional(),
            forcePause: z.boolean().optional(),
            reason: z.string().optional(),
            staleAfterMs: z.number().int().positive().optional(),
            tailLines: z.number().int().positive().optional(),
        },
    }, async (args) => withMcpErrors(async () => maintenancePauseStoredJob(args)));
    server.registerTool("codex_goal_pause", {
        title: "Soft Pause Codex Goal",
        description: "Write a soft pause request marker. This never kills a running worker.",
        inputSchema: jobIdInputSchema(),
    }, async (args) => withMcpErrors(async () => {
        const loaded = await loadJobLaunch(args);
        await mkdir(loaded.launch.config.jobRootDir, { recursive: true, mode: 0o700 });
        const pausePath = join(loaded.launch.config.jobRootDir, `${loaded.launch.config.taskId}.pause-request.json`);
        const status = await collectCodexGoalStatus(statusInput(loaded.launch));
        const controlSignal = await codexGoalWorkerControlService(loaded.launch)
            .enqueueSignal({
            target: codexGoalWorkerControlTarget(loaded),
            intent: "pause_requested",
            deliveryMode: "next_safe_point",
            body: "Soft pause was requested by the operator. Pause at the next safe point if the provider/session supports it; otherwise preserve this request in the continuation context.",
            createdBy: "operator",
            priority: "normal",
        });
        await writeFile(pausePath, `${JSON.stringify({
            schemaVersion: 1,
            jobId: loaded.manifest.jobId,
            taskId: loaded.launch.config.taskId,
            requestedAt: new Date().toISOString(),
            mode: "soft_pause_only",
            note: "The running worker is not terminated by this marker.",
        }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        return mcpJson({
            ok: true,
            jobId: loaded.manifest.jobId,
            pausePath,
            controlSignal: workerControlSignalJson(controlSignal, false),
            status,
            safeMessage: "Soft pause marker written. No tmux session or worker process was killed.",
        });
    }));
    server.registerTool("codex_goal_send_guidance", {
        title: "Send Codex Goal Guidance",
        description: "Durably send guidance to a Codex goal. Requests interrupt-then-continue when the active attempt is locally controllable; otherwise it safely falls back to next safe continuation.",
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
    }, async (args) => withMcpErrors(async () => {
        const controlArgs = args;
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
                ? { priority: stringValue(controlArgs.priority) }
                : {}),
            ...(stringValue(controlArgs.idempotencyKey)
                ? { idempotencyKey: stringValue(controlArgs.idempotencyKey) }
                : {}),
            ...(stringValue(controlArgs.expiresAt)
                ? { expiresAt: parseIsoDate(stringValue(controlArgs.expiresAt), "expiresAt") }
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
    }));
    server.registerTool("codex_goal_control_enqueue", {
        title: "Enqueue Codex Goal Control Signal",
        description: "Durably enqueue guidance or a control request for a stored Codex goal job. Default delivery is next safe continuation.",
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
    }, async (args) => withMcpErrors(async () => {
        const loaded = await loadJobLaunch(args);
        const control = codexGoalWorkerControlService(loaded.launch);
        const controlArgs = args;
        const enqueueInput = {
            target: codexGoalWorkerControlTarget(loaded),
            intent: requiredRawString(controlArgs.intent, "intent"),
            ...(stringValue(controlArgs.deliveryMode)
                ? {
                    deliveryMode: stringValue(controlArgs.deliveryMode),
                }
                : {}),
            body: requiredRawString(controlArgs.body, "body"),
            ...(stringValue(controlArgs.createdBy)
                ? { createdBy: stringValue(controlArgs.createdBy) }
                : {}),
            ...workerControlCallerArgs(controlArgs),
            ...(stringValue(controlArgs.priority)
                ? { priority: stringValue(controlArgs.priority) }
                : {}),
            ...(stringValue(controlArgs.idempotencyKey)
                ? { idempotencyKey: stringValue(controlArgs.idempotencyKey) }
                : {}),
            ...(stringValue(controlArgs.expiresAt)
                ? { expiresAt: parseIsoDate(stringValue(controlArgs.expiresAt), "expiresAt") }
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
    }));
    server.registerTool("codex_goal_control_list", {
        title: "List Codex Goal Control Signals",
        description: "List durable control inbox signals for a stored Codex goal job.",
        inputSchema: {
            ...jobIdInputSchema(),
            includeBodies: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => {
        const loaded = await loadJobLaunch(args);
        const control = codexGoalWorkerControlService(loaded.launch);
        const includeBodies = booleanValue(args.includeBodies) ?? false;
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
    }));
    server.registerTool("codex_goal_control_decision", {
        title: "Codex Goal Control Decision",
        description: "Inspect pending control inbox signals and whether they are safe for next continuation.",
        inputSchema: jobIdInputSchema(),
    }, async (args) => withMcpErrors(async () => {
        const loaded = await loadJobLaunch(args);
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
    }));
    server.registerTool("codex_goal_control_reconcile", {
        title: "Reconcile Codex Goal Control Inbox",
        description: "Return derived control inbox counts for a stored Codex goal job. With repair, stale accepted local delivery claims can be released back to pending.",
        inputSchema: {
            ...jobIdInputSchema(),
            repair: z.boolean().optional(),
            acceptedStaleAfterMs: z.number().int().positive().optional(),
        },
    }, async (args) => withMcpErrors(async () => {
        const controlArgs = args;
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
    }));
    server.registerTool("codex_goal_control_supersede", {
        title: "Supersede Codex Goal Control Signal",
        description: "Mark a pending control inbox signal as superseded for a stored Codex goal job.",
        inputSchema: {
            ...jobIdInputSchema(),
            signalId: z.string(),
            supersededBySignalId: z.string().optional(),
            reason: z.string().optional(),
            callerKind: z.enum(["user", "operator", "orchestrator", "runtime", "agent"]).optional(),
            callerActor: z.enum(["user", "operator", "orchestrator", "runtime", "agent"]).optional(),
            callerId: z.string().optional(),
        },
    }, async (args) => withMcpErrors(async () => {
        const loaded = await loadJobLaunch(args);
        const control = codexGoalWorkerControlService(loaded.launch);
        const receipt = await control.markSuperseded({
            target: codexGoalWorkerControlTarget(loaded),
            signalId: requiredRawString(args.signalId, "signalId"),
            ...(stringValue(args.supersededBySignalId)
                ? {
                    supersededBySignalId: stringValue(args.supersededBySignalId),
                }
                : {}),
            ...(stringValue(args.reason)
                ? { reason: stringValue(args.reason) }
                : {}),
            ...workerControlCallerArgs(args),
        });
        return mcpJson({
            ok: true,
            registryRootDir: loaded.registryRootDir,
            jobId: loaded.manifest.jobId,
            taskId: loaded.launch.config.taskId,
            receipt: workerControlReceiptJson(receipt),
        });
    }));
    server.registerTool("codex_goal_mark_reviewed", {
        title: "Mark Codex Goal Reviewed",
        description: "Write a local review marker after a human or orchestrator has inspected the result.",
        inputSchema: {
            ...jobIdInputSchema(),
            note: z.string().optional(),
        },
    }, async (args) => withMcpErrors(async () => {
        const loaded = await loadJobLaunch(args);
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
        if (projectControlDenial)
            return mcpJson(projectControlDenial);
        await mkdir(loaded.launch.config.jobRootDir, { recursive: true, mode: 0o700 });
        const reviewPath = join(loaded.launch.config.jobRootDir, `${loaded.launch.config.taskId}.review.json`);
        const status = await collectCodexGoalStatus(statusInput(loaded.launch));
        await writeFile(reviewPath, `${JSON.stringify({
            schemaVersion: 1,
            jobId: loaded.manifest.jobId,
            taskId: loaded.launch.config.taskId,
            reviewedAt: new Date().toISOString(),
            note: stringValue(args.note) ?? "reviewed",
            status,
        }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        return mcpJson({ ok: true, jobId: loaded.manifest.jobId, reviewPath, status });
    }));
    server.registerTool("codex_goal_brief", {
        title: "Codex Goal Brief",
        description: "Return a compact agent-friendly status summary by jobId.",
        inputSchema: {
            ...jobIdInputSchema(),
            staleAfterMs: z.number().int().positive().optional(),
            tailLines: z.number().int().positive().optional(),
            targetCommit: z.string().optional(),
            targetWorkspacePath: z.string().optional(),
        },
    }, async (args) => withMcpErrors(async () => {
        const briefArgs = args;
        const loaded = await loadJobLaunch(args);
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
    }));
    server.registerTool("codex_goal_decision", {
        title: "Codex Goal Decision",
        description: "Return a conservative agent decision report with blockers, evidence and exact next command.",
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
    }, async (args) => withMcpErrors(async () => {
        const decisionArgs = args;
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
    }));
    server.registerTool("codex_goal_handoff", {
        title: "Codex Goal Handoff",
        description: "Build a copy-paste safe handoff bundle for another agent by jobId.",
        inputSchema: {
            ...jobIdInputSchema(),
            staleAfterMs: z.number().int().positive().optional(),
            tailLines: z.number().int().positive().optional(),
            targetCommit: z.string().optional(),
            targetWorkspacePath: z.string().optional(),
            includeCliFallback: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => {
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
            ...optionalTargetCommit(await targetCommitFromArgs(args)),
        });
        const handoff = buildCodexGoalHandoff({
            registryRootDir: loaded.registryRootDir,
            manifest: loaded.manifest,
            launch: loaded.launch,
            brief,
            status,
            accounts,
            includeCliFallback: booleanValue(args.includeCliFallback) ?? true,
        });
        return mcpJson({
            ok: true,
            registryRootDir: loaded.registryRootDir,
            jobId: loaded.manifest.jobId,
            handoff,
            brief,
            status,
        });
    }));
    server.registerTool("codex_goal_accounts_status", {
        title: "Codex Goal Account Status",
        description: "Inspect a stored job's configured account slots by jobId, including job-specific capacity cooldowns.",
        inputSchema: {
            ...jobIdInputSchema(),
            liveCheck: z.boolean().optional(),
            codexBinaryPath: z.string().optional(),
            liveCheckTimeoutMs: z.number().int().positive().optional(),
        },
    }, async (args) => withMcpErrors(async () => {
        const loaded = await loadJobLaunch(args);
        return mcpJson({
            registryRootDir: loaded.registryRootDir,
            jobId: loaded.manifest.jobId,
            ...(await codexGoalAccountStatusPayload(loaded.launch, {
                liveCheck: booleanValue(args.liveCheck) ?? false,
                ...(stringValue(args.codexBinaryPath)
                    ? { codexBinaryPath: stringValue(args.codexBinaryPath) }
                    : {}),
                ...(numberValue(args.liveCheckTimeoutMs)
                    ? { liveCheckTimeoutMs: numberValue(args.liveCheckTimeoutMs) }
                    : {}),
            })),
        });
    }));
    server.registerTool("codex_goal_accounts_list_pools", {
        title: "Codex Goal Account Pools",
        description: "List account pools for a stored job by jobId using the job state root for capacity-aware counts.",
        inputSchema: {
            ...jobIdInputSchema(),
            poolRootDir: z.string().optional(),
        },
    }, async (args) => withMcpErrors(async () => {
        const loaded = await loadJobLaunch(args);
        const poolRootDir = resolvePath(process.cwd(), stringValue(args.poolRootDir) ??
            dirname(loaded.launch.config.authRootDir));
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
    }));
    server.registerTool("codex_goal_accounts_relogin_instructions", {
        title: "Codex Goal Account Relogin Instructions",
        description: "Return safe manual relogin commands for a stored job's account slot by jobId.",
        inputSchema: {
            ...jobIdInputSchema(),
            account: z.string().optional(),
        },
    }, async (args) => withMcpErrors(async () => {
        const loaded = await loadJobLaunch(args);
        const status = await codexGoalAccountStatusPayload(loaded.launch);
        const requestedAccount = stringValue(args.account);
        const targetAccounts = requestedAccount
            ? [requestedAccount]
            : status.slots
                .filter((slot) => slot.status !== "ready")
                .map((slot) => slot.name);
        const instructionsByAccount = Object.fromEntries(targetAccounts.map((account) => [
            account,
            codexAccountReloginInstructions({
                authRootDir: loaded.launch.config.authRootDir,
                account,
                afterLoginInstruction: "After login, run codex_goal_accounts_status for the job before starting workers.",
            }),
        ]));
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
    }));
    server.registerTool("codex_goal_dry_run", {
        title: "Codex Goal Dry Run",
        description: "Build the exact Codex goal worker command without starting a worker.",
        inputSchema: goalInputSchema(),
    }, async (args) => withMcpErrors(async () => {
        const launch = await goalLaunchInput(args);
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
    }));
    server.registerTool("codex_goal_start", {
        title: "Start Codex Goal Worker",
        description: "Start a detached tmux Codex goal worker after explicit confirmation.",
        inputSchema: {
            ...goalInputSchema(),
            registryRootDir: z.string().optional(),
            confirmStart: z.boolean().optional(),
            skipDoctor: z.boolean().optional(),
            forceStart: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => {
        const launch = await goalLaunchInput(args);
        const projectControlDenial = projectControlGenericToolDenial({
            accessBoundary: launch.config.accessBoundary,
            projectAccessScope: launch.config.projectAccessScope,
        }) ?? await projectControlGenericScopeDenial({
            registryRootDir: registryRootFromArgs(args),
            jobId: launch.config.jobId ?? launch.config.taskId,
            workspacePath: launch.config.workspacePath,
            requiredTool: "codex_goal_project_start",
        });
        if (projectControlDenial)
            return mcpJson(projectControlDenial);
        if (!launch.tmuxSession) {
            return mcpJson({
                ok: false,
                reason: "tmux_session_required",
                noTmuxCommand: buildCodexGoalNoTmuxCommand(launch),
            });
        }
        if (args.confirmStart) {
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
        if (!isSafeStartAction(statusBefore.recommendedAction) &&
            !args.forceStart) {
            return mcpJson({
                ok: false,
                reason: "status_requires_review",
                status: statusBefore,
                requiredOverride: "forceStart",
            });
        }
        if (!args.confirmStart) {
            return mcpJson({
                ok: false,
                reason: "confirm_start_required",
                tmuxCommand: buildCodexGoalTmuxCommand(launch).preview,
                summary: launchSummary(launch),
            });
        }
        const registryRootDir = registryRootFromArgs(args);
        const manifest = await upsertCodexGoalLaunchManifest({
            registryRootDir,
            launch,
        });
        if (!args.skipDoctor) {
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
    }));
    server.registerTool("codex_goal_project_create_job", {
        title: "Project Control Create Codex Goal Job",
        description: "Create a child Codex goal job through a ProjectScopedControl controller manifest and broker policy.",
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
    }, async (args) => withMcpErrors(async () => projectControlCreateCodexGoalJob(args)));
    server.registerTool("codex_goal_project_refill_worker", {
        title: "Project Control Refill Worker",
        description: "Create a scoped worktree, write a prompt, create a child job and optionally start it through one ProjectScopedControl broker flow.",
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
    }, async (args) => withMcpErrors(async () => projectControlRefillWorker(args)));
    server.registerTool("codex_goal_project_operation_status", {
        title: "Project Control Operation Status",
        description: "Read a durable async ProjectScopedControl operation status handle created by bounded project-control tools.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            operationId: z.string(),
            includeResult: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControlOperationStatus(args)));
    server.registerTool("codex_goal_project_admission_snapshot", {
        title: "Project Admission Snapshot",
        description: "Read project output debt used by the ProjectScopedControl admission gate. This is read-only.",
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
    }, async (args) => withMcpErrors(async () => projectControlAdmissionSnapshot(args)));
    server.registerTool("codex_goal_project_update_controller_scope", {
        title: "Project Control Update Controller Scope",
        description: "Safely repair limited ProjectScopedControl controller scope fields through a brokered manifest update path.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            projectAccessScope: z.record(z.string(), z.unknown()).optional(),
            confirmUpdate: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControlUpdateControllerScope(args)));
    server.registerTool("brokered_project_manifest_repair", {
        title: "Brokered Project Manifest Repair",
        description: "Safely repair limited project-owned child job manifest fields through a ProjectScopedControl controller.",
        inputSchema: {
            ...jobIdInputSchema(),
            controllerJobId: z.string().optional(),
            accounts: z.union([z.string(), z.array(z.string())]).optional(),
            description: z.string().optional(),
            tags: z.union([z.string(), z.array(z.string())]).optional(),
            confirmRepair: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControlRepairJobManifest(args)));
    server.registerTool("codex_goal_project_controller_launch_plan", {
        title: "Project Controller Controlled-Agent Launch Plan",
        description: "Build a fail-closed broker-only LLM controller launch plan for a ProjectScopedControl controller manifest. Does not start an LLM.",
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
    }, async (args) => withMcpErrors(async () => projectControllerLaunchPlan(args)));
    server.registerTool("codex_goal_project_controller_start", {
        title: "Project Controller Controlled-Agent Start",
        description: "Start a broker-only LLM controller when the provider adapter can enforce the controlled-agent launch plan. Fails closed when no safe provider runner is available.",
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
    }, async (args) => withMcpErrors(async () => projectControllerStart(args)));
    server.registerTool("codex_goal_project_controller_status", {
        title: "Project Controller Controlled-Agent Status",
        description: "Read the persisted controlled-agent controller session/run state for a ProjectScopedControl manifest.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            providerKind: z.enum([RunEventProviderKind.Codex, RunEventProviderKind.Claude]).optional(),
            stateDir: z.string().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControllerStatus(args)));
    server.registerTool("codex_goal_project_controller_consume_guidance", {
        title: "Project Controller Consume Guidance",
        description: "Consume pending control guidance for the ProjectScopedControl controller's own inbox and record delivery receipts. Does not consume child-worker inboxes.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            deliveryAttemptId: z.string().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControllerConsumeGuidance(args)));
    server.registerTool("codex_goal_project_controller_stop", {
        title: "Project Controller Controlled-Agent Stop",
        description: "Stop a broker-only LLM controller through its provider adapter. Fails closed while no safe provider runner is connected.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            providerKind: z.enum([RunEventProviderKind.Codex, RunEventProviderKind.Claude]).optional(),
            stateDir: z.string().optional(),
            reason: z.string().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControllerStop(args)));
    server.registerTool("codex_goal_project_controller_reconcile", {
        title: "Project Controller Controlled-Agent Reconcile",
        description: "Reconcile a broker-only LLM controller run through its provider adapter. Fails closed while no safe provider runner is connected.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            providerKind: z.enum([RunEventProviderKind.Codex, RunEventProviderKind.Claude]).optional(),
            stateDir: z.string().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControllerReconcile(args)));
    server.registerTool("codex_goal_project_start", {
        title: "Project Control Start Codex Goal Worker",
        description: "Start a stored Codex goal worker through a ProjectScopedControl controller manifest and broker policy.",
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
    }, async (args) => withMcpErrors(async () => projectControlStartStoredJob(args)));
    server.registerTool("codex_goal_project_create_worktree", {
        title: "Project Control Create Git Worktree",
        description: "Create a project git worktree through a ProjectScopedControl controller manifest and broker policy.",
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
    }, async (args) => withMcpErrors(async () => projectControlCreateWorktree(args)));
    server.registerTool("codex_goal_project_integrate_commit", {
        title: "Project Control Integrate Git Commit",
        description: "Cherry-pick a reviewed commit into a scoped project worktree through broker policy.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            workspacePath: z.string().optional(),
            branch: z.string().optional(),
            commitSha: z.string().optional(),
            confirmIntegrate: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControlIntegrateCommit(args)));
    server.registerTool("codex_goal_project_push_branch", {
        title: "Project Control Push Git Branch",
        description: "Push an allowed project branch through broker policy. Force uses --force-with-lease and must be allowed by scope.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            workspacePath: z.string().optional(),
            branch: z.string().optional(),
            remote: z.string().optional(),
            force: z.boolean().optional(),
            confirmPush: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControlPushBranch(args)));
    const projectIntegrationHandlers = createLocalProjectIntegrationMcpToolHandlers({
        loadController: loadProjectControlController,
        resolvePathArg: projectControlPathArg,
    });
    registerProjectIntegrationMcpTools(server, {
        openAttempt: (args) => withMcpErrors(async () => projectIntegrationHandlers.openAttempt(args)),
        applyWorkerOutput: (args) => withMcpErrors(async () => projectIntegrationHandlers.applyWorkerOutput(args)),
        runRequiredChecks: (args) => withMcpErrors(async () => projectIntegrationHandlers.runRequiredChecks(args)),
        commitApprovedChanges: (args) => withMcpErrors(async () => projectIntegrationHandlers.commitApprovedChanges(args)),
        pushApprovedCommit: (args) => withMcpErrors(async () => projectIntegrationPushApprovedCommitWithConsumedLedger({
            args,
            loadController: loadProjectControlController,
            pushApprovedCommitHandler: projectIntegrationHandlers.pushApprovedCommit,
        })),
        rejectAttempt: (args) => withMcpErrors(async () => projectIntegrationHandlers.rejectAttempt(args)),
    });
    server.registerTool("codex_goal_project_stop", {
        title: "Project Control Stop Codex Goal Worker",
        description: "Stop a stored Codex goal worker through a ProjectScopedControl controller manifest and broker policy.",
        inputSchema: {
            ...jobIdInputSchema(),
            controllerJobId: z.string().optional(),
            confirmStop: z.boolean().optional(),
            forceStop: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControlStopStoredJob(args)));
    server.registerTool("codex_goal_project_mark_reviewed", {
        title: "Project Control Mark Codex Goal Reviewed",
        description: "Write a review marker for a stored job through a ProjectScopedControl controller manifest and broker policy.",
        inputSchema: {
            ...jobIdInputSchema(),
            controllerJobId: z.string().optional(),
            note: z.string().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControlMarkReviewed(args)));
    server.registerTool("codex_goal_status", {
        title: "Codex Goal Status",
        description: "Inspect tmux, result JSON, log freshness and workspace dirtiness.",
        inputSchema: statusInputSchema(),
    }, async (args) => withMcpErrors(async () => {
        const cwd = resolvePath(process.cwd(), stringValue(args.cwd) ?? process.cwd());
        return mcpJson(await collectCodexGoalStatus({
            ...(stringValue(args.jobRootDir)
                ? { jobRootDir: resolvePath(cwd, stringValue(args.jobRootDir)) }
                : {}),
            ...(stringValue(args.taskId)
                ? { taskId: stringValue(args.taskId) }
                : {}),
            ...(stringValue(args.workspacePath)
                ? { workspacePath: resolvePath(cwd, stringValue(args.workspacePath)) }
                : {}),
            ...(stringValue(args.tmuxSession)
                ? { tmuxSession: stringValue(args.tmuxSession) }
                : {}),
            ...(stringValue(args.logPath)
                ? { logPath: resolvePath(cwd, stringValue(args.logPath)) }
                : {}),
            ...(stringValue(args.progressPath)
                ? { progressPath: resolvePath(cwd, stringValue(args.progressPath)) }
                : {}),
        }));
    }));
    server.registerTool("codex_goal_doctor", {
        title: "Codex Goal Doctor",
        description: "Validate prompt, job root, auth root, workspace and account auth files.",
        inputSchema: goalInputSchema(),
    }, async (args) => withMcpErrors(async () => {
        const launch = await goalLaunchInput(args);
        return mcpJson(await doctorCodexGoal({
            config: launch.config,
            ...(launch.tmuxSession ? { tmuxSession: launch.tmuxSession } : {}),
        }));
    }));
    server.registerTool("codex_goal_tail", {
        title: "Codex Goal Tail",
        description: "Read the last lines from a Codex goal worker log.",
        inputSchema: {
            jobRootDir: z.string().optional(),
            taskId: z.string().optional(),
            logPath: z.string().optional(),
            cwd: z.string().optional(),
            lines: z.number().int().positive().optional(),
        },
    }, async (args) => withMcpErrors(async () => {
        const cwd = resolvePath(process.cwd(), stringValue(args.cwd) ?? process.cwd());
        const logPath = stringValue(args.logPath) ??
            (stringValue(args.jobRootDir) && stringValue(args.taskId)
                ? join(resolvePath(cwd, stringValue(args.jobRootDir)), `${stringValue(args.taskId)}.log`)
                : undefined);
        if (!logPath)
            throw new Error("logPath or jobRootDir with taskId is required");
        const resolvedLogPath = resolvePath(cwd, logPath);
        const text = await tailCodexGoalLog(resolvedLogPath, numberValue(args.lines) ?? 100);
        return mcpJson({ ok: true, logPath: resolvedLogPath, text });
    }));
    server.registerTool("codex_accounts_list_pools", {
        title: "List Codex Account Pools",
        description: "List account auth pools under a root directory without printing tokens.",
        inputSchema: {
            poolRootDir: z.string().optional(),
            stateRootDir: z.string().optional(),
        },
    }, async (args) => withMcpErrors(async () => {
        const poolRootDir = accountPoolRootFromArgs(args);
        const stateRootDir = stringValue(args.stateRootDir)
            ? resolvePath(process.cwd(), stringValue(args.stateRootDir))
            : undefined;
        const pools = await listAccountPools(poolRootDir, stateRootDir);
        return mcpJson({
            ok: true,
            poolRootDir,
            capacityAware: Boolean(stateRootDir),
            ...(stateRootDir ? { stateRootDir } : {}),
            pools,
        });
    }));
    server.registerTool("codex_accounts_status", {
        title: "Codex Account Slot Status",
        description: "Inspect Codex account slot auth files without printing tokens.",
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
    }, async (args) => withMcpErrors(async () => {
        const authRootDir = accountAuthRootFromArgs(args);
        const accounts = accountNames(args.accounts);
        return mcpJson(await codexAccountStatusPayload({
            authRootDir,
            ...(accounts.length ? { accounts } : {}),
            ...(stringValue(args.stateRootDir)
                ? { stateRootDir: resolvePath(process.cwd(), stringValue(args.stateRootDir)) }
                : {}),
            liveCheck: booleanValue(args.liveCheck) ?? false,
            ...(stringValue(args.codexBinaryPath)
                ? { codexBinaryPath: stringValue(args.codexBinaryPath) }
                : {}),
            ...(numberValue(args.liveCheckTimeoutMs)
                ? { liveCheckTimeoutMs: numberValue(args.liveCheckTimeoutMs) }
                : {}),
        }));
    }));
    server.registerTool("codex_accounts_relogin_instructions", {
        title: "Codex Account Relogin Instructions",
        description: "Return safe manual relogin commands for account slots. Does not perform login.",
        inputSchema: {
            poolRootDir: z.string().optional(),
            pool: z.string().optional(),
            authRootDir: z.string().optional(),
            account: z.string().optional(),
        },
    }, async (args) => withMcpErrors(async () => {
        const authRootDir = accountAuthRootFromArgs(args);
        const account = stringValue(args.account) ?? "<account-slot>";
        return mcpJson({
            ok: true,
            authRootDir,
            account,
            instructions: codexAccountReloginInstructions({
                authRootDir,
                account,
                afterLoginInstruction: "After login, run codex_accounts_status for this pool before starting workers.",
            }),
        });
    }));
    return server;
}
async function loadJobLaunch(args) {
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
async function loadProjectControlController(args) {
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
const codexProjectAdmissionDeps = {
    listJobs: listCodexGoalJobs,
    buildOverviewItem: (input) => buildCodexGoalOverviewItem(input),
};
async function projectControlAdmissionSnapshot(args) {
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
async function projectControlUpdateControllerScope(args) {
    const controller = await loadProjectControlController(args);
    const proposedScope = parseCodexGoalProjectAccessScope(args.projectAccessScope, "projectAccessScope");
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
            currentConsumedOutputLedgerRoots: controller.scope.consumedOutputLedgerRoots ?? [],
            proposedConsumedOutputLedgerRoots: proposedScope.consumedOutputLedgerRoots ?? [],
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
async function projectControlRepairJobManifest(args) {
    const controller = await loadProjectControlController(args);
    const jobId = requiredRawString(args.jobId, "jobId");
    if (jobId === controller.controller.jobId) {
        return mcpJson({
            ok: false,
            error: "project_control_controller_manifest_repair_unsupported",
            requiredTool: "codex_goal_project_update_controller_scope",
            safeMessage: "Controller manifests use codex_goal_project_update_controller_scope for scoped repairs.",
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
    const patch = {};
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
    }
    else {
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
            proposedPatch: patch,
        });
    }
    const manifest = await updateCodexGoalJob({
        registryRootDir: controller.registryRootDir,
        jobId: existing.jobId,
        patch: patch,
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
function assertProjectControlRepairJobOwned(input) {
    if (input.job.accessBoundary === AccessBoundary.ProjectScopedControl) {
        throw new Error("project_control_repair_child_job_required");
    }
    if (input.job.projectAccessScope?.projectId !== input.controllerScope.projectId) {
        throw new Error("project_control_repair_project_scope_mismatch");
    }
    const jobMatches = matchesProjectControlPrefix(input.job.jobId, input.controllerScope.jobIdPrefixes ?? []);
    const workspaceMatches = pathInsideAnyProjectRoot(input.job.workspacePath, [
        ...(input.controllerScope.workspaceRoots ?? []),
        ...(input.controllerScope.worktreeRoots ?? []),
        ...(input.controllerScope.isolatedWorkspaceRoot
            ? [input.controllerScope.isolatedWorkspaceRoot]
            : []),
    ]);
    if (!jobMatches && !workspaceMatches) {
        throw new Error("project_control_repair_job_scope_mismatch");
    }
}
function assertProjectControlRepairAccountsAllowed(input) {
    const allowed = new Set(input.allowedAccountIds);
    if (allowed.size === 0)
        return;
    const denied = input.accounts.filter((account) => !allowed.has(account));
    if (denied.length > 0) {
        throw new Error("project_control_repair_account_outside_scope");
    }
}
function codexProjectControlBroker(input) {
    return createCodexProjectControlBroker({
        ...input,
        admissionDeps: codexProjectAdmissionDeps,
    });
}
async function projectControllerLaunchPlan(args) {
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
                safeMessage: "Controlled LLM controller launch is blocked until the provider can enforce broker-only tools without raw shell.",
            }),
    });
}
async function projectControllerStart(args) {
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
            safeMessage: "Controlled LLM controller start is blocked by the fail-closed launch plan.",
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
                safeMessage: "Controlled LLM controller already has an active run. Use status, stop or reconcile before starting another run.",
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
            safeMessage: "Controlled LLM controller start was blocked by the controlled-agent use case.",
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
async function projectControllerStatus(args) {
    const controller = await loadProjectControlController(args);
    const state = projectControllerState(args, controller);
    const result = await getControlledAgentStatus(state.sessionId, {
        stateStore: state.store,
    });
    const provider = controlledAgentProviders.get(state.sessionId);
    let observed;
    let providerStatusError;
    if (result.ok && provider) {
        try {
            observed = await provider.status({ session: result.session, run: result.run });
        }
        catch (error) {
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
async function projectControllerConsumeGuidance(args) {
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
async function projectControllerStop(args) {
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
        if (stopped.ok)
            controlledAgentProviders.delete(state.sessionId);
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
async function projectControllerReconcile(args) {
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
function recordControllerCapacitySignal(input) {
    recordProjectControllerCapacitySignal({
        stateRootDir: codexGoalStateRootDir(input.launch),
        controllerJobId: input.controllerJobId,
        config: input.launch.config,
        run: input.run,
    });
}
function projectControllerState(args, controller) {
    const cwd = resolvePath(process.cwd(), stringValue(args.cwd) ?? process.cwd());
    const stateDir = resolvePath(cwd, stringValue(args.stateDir) ??
        join(controller.controller.jobRootDir, "controlled-agent"));
    return {
        cwd,
        stateDir,
        sessionId: projectControllerSessionId(controller.controller.jobId, projectControllerProviderKind(args)),
        store: new LocalControlledAgentStateStore({ rootDir: stateDir }),
    };
}
function projectControllerProviderKind(args) {
    const providerKind = optionalRunEventProviderKind(args.providerKind) ??
        RunEventProviderKind.Codex;
    if (providerKind === RunEventProviderKind.Codex ||
        providerKind === RunEventProviderKind.Claude) {
        return providerKind;
    }
    throw new Error(`project_controller_provider_kind_unsupported:${providerKind}`);
}
function projectControllerSessionId(controllerJobId, providerKind) {
    if (providerKind === RunEventProviderKind.Codex) {
        return `${controllerJobId}:controlled-agent`;
    }
    return `${controllerJobId}:controlled-agent:${providerKind}`;
}
function projectControllerProfile(args, state) {
    const common = {
        stateDir: state.stateDir,
        ...(stringValue(args.mcpServerName) === undefined
            ? {}
            : { mcpServerName: stringValue(args.mcpServerName) }),
        ...(stringValue(args.mcpCommand) === undefined
            ? {}
            : { mcpCommand: stringValue(args.mcpCommand) }),
        ...(args.mcpArgs === undefined ? {} : { mcpArgs: stringArrayArg(args.mcpArgs) }),
        ...(stringValue(args.mcpCwd) === undefined
            ? {}
            : { mcpCwd: resolvePath(state.cwd, stringValue(args.mcpCwd)) }),
    };
    if (projectControllerProviderKind(args) === RunEventProviderKind.Claude) {
        return buildLocalClaudeControlledAgentProfile(common);
    }
    return buildCodexControlledAgentProfile({
        ...common,
        rawShellMode: args.rawShellMode ?? "disabled-by-provider",
    });
}
function projectControllerLaunchInput(controller, state, profile) {
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
function projectControllerAllowedTools(profile) {
    return profile.providerKind === RunEventProviderKind.Codex
        ? profile.enabledTools
        : profile.allowedTools;
}
function projectControllerProfileReadyJson(profile) {
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
async function projectControllerProvider(input) {
    if (input.profile.providerKind === RunEventProviderKind.Claude) {
        const loaded = await controlledAgentClaudeSessionArtifact(input);
        const controllerObjective = await projectControllerObjectiveWithPendingGuidance(input.controller, input.launch);
        return {
            provider: createLocalClaudeControlledAgentProvider({
                profile: input.profile,
                sessionArtifact: loaded.sessionArtifact,
                workspacePath: input.launch.config.workspacePath,
                ...(stringValue(input.args.claudePath) === undefined
                    ? {}
                    : { claudePath: stringValue(input.args.claudePath) }),
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
            safeMessage: "Claude broker-only controlled-agent provider started with strict MCP broker tools.",
        };
    }
    const account = await controlledAgentCodexAccount({
        controller: input.controller,
        launch: input.launch,
    });
    const controllerObjective = await projectControllerObjectiveWithPendingGuidance(input.controller, input.launch);
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
        safeMessage: "Codex broker-only controlled-agent provider started with native app-server environments disabled.",
    };
}
async function projectControllerObjectiveWithPendingGuidance(controller, launch) {
    const baseObjective = await readFile(launch.config.promptPath, "utf8");
    const guidanceContext = await projectControllerPendingGuidanceContext(controller, launch);
    return guidanceContext === undefined
        ? baseObjective
        : `${baseObjective}\n\n${guidanceContext}`;
}
async function projectControllerPendingGuidanceContext(controller, launch) {
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
    }
    catch {
        return undefined;
    }
}
export function projectControllerPendingGuidancePromptContext(input) {
    const deliverable = input.deliverableSignals
        .slice()
        .sort((left, right) => right.signal.createdAt.getTime() - left.signal.createdAt.getTime())
        .slice(0, 5);
    if (deliverable.length === 0)
        return undefined;
    const lines = [
        "Pending controller guidance from durable inbox:",
        "- Treat this as read-only context for this run.",
        "- Before applying it, call codex_goal_project_controller_consume_guidance for your controller job so the inbox records delivery.",
        `- pendingCount=${input.pendingCount} deliverableCount=${input.deliverableSignals.length}`,
    ];
    for (const view of deliverable) {
        const signal = view.signal;
        lines.push(`- ${signal.createdAt.toISOString()} ${signal.createdBy}/${signal.priority}: ${truncateText(redactPromptGuidanceText(signal.body), 800)}`);
    }
    if (input.deliverableSignals.length > deliverable.length) {
        lines.push(`- ${input.deliverableSignals.length - deliverable.length} older deliverable guidance item(s) omitted from prompt context.`);
    }
    return lines.join("\n");
}
function redactPromptGuidanceText(value) {
    return redactText(value).replace(/[A-Za-z0-9_=-]{32,}/g, "[redacted]");
}
async function controlledAgentCodexAccount(input) {
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
        .filter((slot) => allowedAccountIds === undefined ||
        allowedAccountIds.includes(slot.name));
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
async function controlledAgentClaudeSessionArtifact(input) {
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
async function projectControlCreateCodexGoalJob(args) {
    const controller = await loadProjectControlController(args);
    if (args.projectAccessScope !== undefined) {
        throw new Error("project_control_child_scope_is_controller_owned");
    }
    if (args.allowDangerFullAccess === true) {
        throw new Error("project_control_child_danger_full_access_denied");
    }
    const requested = jobManifestInputFromArgs(args);
    if (requested.accessBoundary === AccessBoundary.ProjectScopedControl ||
        requested.accessBoundary === AccessBoundary.DangerFullAccess) {
        throw new Error("project_control_child_boundary_denied");
    }
    const accessBoundary = requested.accessBoundary ?? AccessBoundary.IsolatedWorkspaceWrite;
    const workerRole = projectAdmissionWorkerRoleArg(args.workerRole);
    const accounts = await projectControlDefaultAccountNames({
        ...(requested.authRootDir ? { authRootDir: requested.authRootDir } : {}),
        requestedAccounts: requested.accounts,
        allowedAccountIds: controller.scope.allowedAccountIds ?? [],
    });
    const createManifest = {
        ...requested,
        accounts,
        accessBoundary,
        projectAccessScope: projectControlChildScope(controller.scope, requested.workspacePath),
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
            manifestPreview: createManifest,
        });
    }
    const broker = codexProjectControlBroker({
        registryRootDir: controller.registryRootDir,
        controller: controller.controller,
        scope: controller.scope,
        createManifest,
        createOverwrite: booleanValue(args.overwrite) ?? false,
    });
    const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(createManifest.workspacePath, controller.scope);
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
        result: result,
        manifest,
        summary: summarizeCodexGoalJob(manifest, controller.registryRootDir),
    });
}
async function projectControlRefillWorker(args) {
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
    const sourceWorkspacePath = projectControlPathArg(args, args.sourceWorkspacePath, "sourceWorkspacePath");
    const requested = jobManifestInputFromArgs(args);
    if (requested.accessBoundary === AccessBoundary.ProjectScopedControl ||
        requested.accessBoundary === AccessBoundary.DangerFullAccess) {
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
    const accessBoundary = requested.accessBoundary ?? AccessBoundary.IsolatedWorkspaceWrite;
    const createManifest = {
        ...requested,
        accounts,
        tags: uniqueProjectControlStrings([
            ...tagValues(requested.tags),
            "project-control-refill",
            `worker-role-${role}`,
        ]),
        accessBoundary,
        projectAccessScope: projectControlChildScope(controller.scope, requested.workspacePath),
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
    if (sourceRef)
        assertSafeGitRefName(sourceRef, "sourceRef");
    const newBranch = stringValue(args.newBranch);
    if (newBranch)
        assertSafeGitRefName(newBranch, "newBranch");
    const realSourceWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(sourceWorkspacePath, controller.scope);
    const createWorktreeInput = {
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
            manifestPreview: createManifest,
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
    let worktree;
    let createJob;
    let manifest;
    let prompt;
    let dependencyPreflight;
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
    }
    catch (error) {
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
        loadLaunch: async (jobManifest) => goalLaunchInput(codexGoalJobToArgs(jobManifest)),
    });
    let start;
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
        const realLaunchWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(launch.config.workspacePath, controller.scope);
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
        dependencyPreflight: dependencyPreflight,
        jobId: manifest.jobId,
        worktree: worktree,
        createJob: createJob,
        ...(start ? { start: start } : { startSkipped: true }),
        manifest,
        summary: summarizeCodexGoalJob(manifest, controller.registryRootDir),
    });
}
async function projectControlRefillWorkerBounded(args) {
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
    const requested = jobManifestInputFromArgs(args);
    if (requested.accessBoundary === AccessBoundary.ProjectScopedControl ||
        requested.accessBoundary === AccessBoundary.DangerFullAccess) {
        throw new Error("project_control_child_boundary_denied");
    }
    const createManifest = {
        ...requested,
        accessBoundary: requested.accessBoundary ?? AccessBoundary.IsolatedWorkspaceWrite,
        projectAccessScope: projectControlChildScope(controller.scope, requested.workspacePath),
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
    };
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
async function projectControlOperationStatus(args) {
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
async function projectControlStartStoredJob(args) {
    const controller = await loadProjectControlController(args);
    const jobId = requiredRawString(args.jobId, "jobId");
    const manifest = await readCodexGoalJob({
        registryRootDir: controller.registryRootDir,
        jobId,
    });
    try {
        await assertReadablePrompt({ promptPath: manifest.promptPath });
    }
    catch (error) {
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
    const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(loaded.launch.config.workspacePath, controller.scope);
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
        dependencyPreflight: dependencyPreflight,
        result: result,
    });
}
async function projectControlCreateWorktree(args) {
    const controller = await loadProjectControlController(args);
    const sourceWorkspacePath = projectControlPathArg(args, args.sourceWorkspacePath, "sourceWorkspacePath");
    const path = projectControlPathArg(args, args.path, "path");
    const baseBranch = stringValue(args.baseBranch);
    if (baseBranch)
        assertSafeGitRefName(baseBranch, "baseBranch");
    const sourceRef = stringValue(args.sourceRef);
    if (sourceRef)
        assertSafeGitRefName(sourceRef, "sourceRef");
    const newBranch = stringValue(args.newBranch);
    if (newBranch)
        assertSafeGitRefName(newBranch, "newBranch");
    const effectiveSourceRef = sourceRef ?? baseBranch;
    const workerRole = projectAdmissionWorkerRoleArg(args.workerRole);
    const realSourceWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(sourceWorkspacePath, controller.scope);
    const createWorktreeInput = {
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
        dependencyPreflight: dependencyPreflight,
        result: result,
    });
}
async function projectControlIntegrateCommit(args) {
    const controller = await loadProjectControlController(args);
    const workspacePath = projectControlPathArg(args, args.workspacePath, "workspacePath");
    const branch = requiredRawString(args.branch, "branch");
    const commitSha = requiredRawString(args.commitSha, "commitSha");
    assertSafeGitRefName(branch, "branch");
    assertSafeGitCommitSha(commitSha);
    const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(workspacePath, controller.scope);
    const integrateCommitInput = {
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
        result: result,
    });
}
async function projectControlPushBranch(args) {
    const controller = await loadProjectControlController(args);
    const workspacePath = projectControlPathArg(args, args.workspacePath, "workspacePath");
    const branch = requiredRawString(args.branch, "branch");
    const remote = stringValue(args.remote) ?? "origin";
    const force = booleanValue(args.force) ?? false;
    assertSafeGitRefName(branch, "branch");
    assertSafeGitRemoteName(remote, "remote");
    const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(workspacePath, controller.scope);
    const pushBranchInput = {
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
        result: result,
    });
}
async function projectControlStopStoredJob(args) {
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
    if (workerLiveness.alive &&
        !brief.silentStale &&
        !brief.heartbeatOnlyNoOutput &&
        !args.forceStop) {
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
    const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(loaded.launch.config.workspacePath, controller.scope);
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
        result: result,
    });
}
async function projectControlMarkReviewed(args) {
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
    const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(loaded.launch.config.workspacePath, controller.scope);
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
        result: result,
    });
}
async function continueStoredJob(args, options) {
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
    if (projectControlDenial)
        return mcpJson(projectControlDenial);
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
    if (!isSafeStartAction(status.recommendedAction) &&
        !args.forceStart) {
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
function shouldReconcileResultBeforeStart(status) {
    if (status.progressStatus === "maintenance_paused" &&
        status.resultExists !== true &&
        !status.workspaceDirty &&
        (status.logExists !== true ||
            (status.logByteLength ?? 0) === 0)) {
        return false;
    }
    if (status.resultExists === true)
        return true;
    if (status.workspaceDirty)
        return true;
    if (status.progressExists)
        return true;
    if (status.logExists && (status.logByteLength ?? 0) > 0)
        return true;
    return false;
}
async function reconcileStoredJobRuntimeResult(args) {
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
            safeMessage: "Worker still appears alive. Reconcile result only after stop/stale confirmation or with forceWrite.",
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
async function stopStoredJob(args) {
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
    if (projectControlDenial)
        return mcpJson(projectControlDenial);
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
        safeMessage: "Stopped the tmux worker session. Review workspace/log/result before continuing or recovery.",
    });
}
async function maintenancePauseStoredJob(args) {
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
    if (projectControlDenial)
        return mcpJson(projectControlDenial);
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
            safeMessage: "Workspace has uncommitted changes. Wait for a clean checkpoint or pass forcePause after manual review.",
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
        safeMessage: "Worker paused for planned maintenance. No failure result was reconciled; codex_goal_continue can resume after maintenance.",
    });
}
async function buildCodexGoalOverview(args) {
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
    const rawJobs = await Promise.all(selectedSummaries.map((summary) => buildCodexGoalOverviewItem({
        registryRootDir,
        jobId: summary.jobId,
        staleAfterMs,
        tailLines,
    })));
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
async function reconcilePreviewCodexGoalJobs(args) {
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
function reconcilePreviewDecisionJson(decision) {
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
async function watchAgentRuns(args) {
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
        });
    }
    if (providerKind !== RunEventProviderKind.Codex) {
        return {
            ok: false,
            mode: "read_only",
            sideEffects: [],
            providerKind,
            supportedProviderKinds: [RunEventProviderKind.Codex, RunEventProviderKind.Claude],
            reason: "provider_observation_not_implemented",
            safeMessage: `Run observation for provider '${providerKindInput}' is not implemented yet. Watch did not start, stop, continue, recover or deliver work.`,
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
        ...(stringValue(args.jobId) ? [stringValue(args.jobId)] : []),
        ...jobIdsFromValue(args.jobIds),
    ];
    const limit = numberValue(args.limit);
    const listedRunIds = explicitJobIds.length
        ? explicitJobIds
        : await service.listRunIds();
    const runIds = limit === undefined
        ? listedRunIds
        : listedRunIds.slice(0, limit);
    const snapshots = await Promise.all(runIds.map(async (runId) => {
        try {
            return await service.observeRun({
                runId,
                ...(tailLines === undefined ? {} : { tailLines }),
                includeChangedFiles: booleanValue(args.includeChangedFiles) === true,
                includeLogTail: booleanValue(args.includeLogTail) === true,
            });
        }
        catch (error) {
            const orphan = await observeOrphanCodexRun({
                runId,
                error,
                args,
                providerKind,
                staleAfterMs: staleAfterMs ?? 10 * 60_000,
                tailLines: tailLines ?? 20,
            });
            if (orphan)
                return orphan;
            return failedRunObservationSnapshot({
                runId,
                providerKind,
                error,
            });
        }
    }));
    const observationFailures = snapshots
        .filter((snapshot) => snapshot.warnings.some((warning) => warning.code === "run_observation_failed"))
        .map((snapshot) => ({
        runId: snapshot.runId,
        warnings: snapshot.warnings.filter((warning) => warning.code === "run_observation_failed"),
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
async function readAgentRunEvents(args) {
    const registryRootDir = registryRootFromArgs(args);
    const eventRootDir = runEventRootFromArgs(args, registryRootDir);
    const providerKind = optionalRunEventProviderKind(args.providerKind);
    const eventStore = new LocalFileRunEventStore({ rootDir: eventRootDir });
    const result = await eventStore.read({
        ...(stringValue(args.cursor) === undefined
            ? {}
            : { cursor: { value: stringValue(args.cursor) } }),
        ...(stringValue(args.jobId) === undefined
            ? {}
            : { runId: stringValue(args.jobId) }),
        ...(numberValue(args.limit) === undefined
            ? {}
            : { limit: numberValue(args.limit) }),
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
async function readAgentRunState(args) {
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
        if (replayed !== null &&
            (providerKind === undefined || replayed.providerKind === providerKind)) {
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
            safeMessage: "No projected run state exists yet and no replayable run events were found. Run agent_run_project_events first to observe and project this run.",
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
            safeMessage: "Projected run state exists for a different provider. No worker action was taken.",
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
async function planAgentRunEventCompaction(args) {
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
async function compactAgentRunEvents(args) {
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
            safeMessage: "Compaction rewrites the local event log. Re-run with confirmCompact=true after reviewing the plan.",
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
async function projectAgentRunEvents(args) {
    const providerKind = optionalRunEventProviderKind(args.providerKind) ??
        RunEventProviderKind.Codex;
    if (providerKind !== RunEventProviderKind.Codex &&
        providerKind !== RunEventProviderKind.Claude) {
        return {
            ok: false,
            mode: "project_events",
            sideEffects: [],
            providerKind,
            supportedProviderKinds: [RunEventProviderKind.Codex, RunEventProviderKind.Claude],
            reason: "provider_event_projection_not_implemented",
            safeMessage: `Run event projection for provider '${providerKind}' is not implemented yet. Projection did not start, stop, continue, recover or deliver work.`,
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
        ? watch.snapshots
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
                : { hostId: stringValue(args.hostId) }),
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
    const readBack = await eventStore.read({
        runIds: projectedRunIds,
        sourceProviderKind: providerKind,
        sourceRegistryRootDir: registryRootDir,
        ...(numberValue(args.limit) === undefined
            ? {}
            : { limit: numberValue(args.limit) }),
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
function jsonRecordFromProjectControlArgs(args) {
    return JSON.parse(JSON.stringify(args));
}
function controlledAgentOwnerIsLive(owner) {
    if (owner.hostname !== undefined && owner.hostname !== hostname())
        return true;
    if (owner.pid === undefined)
        return true;
    try {
        process.kill(owner.pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
if (await isMainModule()) {
    try {
        const server = createCodexGoalMcpServer();
        await server.connect(new StdioServerTransport());
    }
    catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : "codex goal mcp failed"}\n`);
        process.exitCode = 1;
    }
}
async function isMainModule() {
    if (!process.argv[1])
        return false;
    try {
        return (await realpath(fileURLToPath(import.meta.url))) ===
            (await realpath(process.argv[1]));
    }
    catch {
        return fileURLToPath(import.meta.url) === process.argv[1];
    }
}
//# sourceMappingURL=codex-goal-mcp.js.map