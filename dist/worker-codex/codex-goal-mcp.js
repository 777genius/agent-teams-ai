#!/usr/bin/env node
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate, } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AccessBoundary, ProjectAdmissionWorkerRole, InterruptAndContinueWorkerUseCase, RunEventProviderKind, ProjectOperation, } from "@vioxen/subscription-runtime/worker-core";
import { codexGoalJobToArgs, createCodexGoalJob, listCodexGoalJobs, readCodexGoalJob, resolveCodexGoalJobRegistryRoot, summarizeCodexGoalJob, updateCodexGoalJob, } from "./codex-goal-jobs.js";
import { upsertCodexGoalLaunchManifest } from "./codex-goal-launch-manifest.js";
import { buildCodexGoalNoTmuxCommand, buildCodexGoalTmuxCommand, collectCodexGoalStatus, doctorCodexGoal, listCodexGoalAccountStatuses, prepareCodexGoalLaunchPaths, resolveCodexGoalWorkerLiveness, startCodexGoalTmux, tailCodexGoalLog, } from "./codex-goal-ops.js";
import { projectControlGenericScopeDenial, projectControlGenericToolDenial, } from "./project-control-scope-guard.js";
import { registerProjectIntegrationMcpTools, } from "./project-integration-mcp/index.js";
import { createLocalProjectIntegrationMcpToolHandlers, } from "./project-integration-mcp/adapters/local-project-integration-mcp-tool-handlers.js";
import { accountNames, booleanValue, numberValue, requiredRawString, resolvePath, stringValue, } from "./codex-goal-mcp-values.js";
import { jobIdInputSchema, jobRegistryInputSchema, registryRootFromArgs, } from "./codex-goal-mcp-inputs.js";
import { accountAuthRootFromArgs, accountPoolRootFromArgs, codexAccountReloginInstructions, codexAccountStatusPayload, listAccountPools, } from "./codex-goal-mcp-accounts.js";
import { parseIsoDate, signalIdList, workerControlCallerArgs, workerControlDecisionJson, workerControlReceiptJson, workerControlSignalJson, workerControlSignalViewJson, } from "./codex-goal-mcp-worker-control-view.js";
import { codexGoalAccountStatusPayload, codexGoalStateRootDir, codexGoalWorkerControlService, codexGoalWorkerControlTarget, } from "./codex-goal-mcp-worker-control.js";
import { buildCodexGoalBrief } from "./codex-goal-mcp-brief.js";
import { jobManifestInputFromArgs, jobManifestPatchFromArgs, } from "./codex-goal-mcp-manifest-args.js";
import { mcpJson, withMcpErrors, } from "./codex-goal-mcp-response.js";
import { registerCodexGoalPrompts } from "./codex-goal-mcp-prompts.js";
import { optionalTargetCommit, targetCommitFromArgs, } from "./codex-goal-mcp-target-commit.js";
import { goalInputSchema, statusInputSchema, } from "./codex-goal-mcp-input-schemas.js";
export { buildCodexGoalBrief } from "./codex-goal-mcp-brief.js";
import { buildCodexGoalOverviewView, reconcilePreviewCodexGoalJobsView, } from "./codex-goal-mcp-overview.js";
import { buildCodexGoalOverviewItem } from "./codex-goal-mcp-overview-item.js";
import { codexGoalStatusInputFromLaunch as statusInput, } from "./codex-goal-mcp-status-input.js";
import { createCodexProjectControlBroker, } from "./codex-goal-mcp-project-broker.js";
import { projectControlAdmissionSnapshotView, projectControlRepairJobManifestView, projectControlUpdateControllerScopeView, } from "./codex-goal-mcp-project-control-admin.js";
import { projectControlCreateWorktreeView, projectControlIntegrateCommitView, projectControlMarkReviewedView, projectControlPushBranchView, projectControlStartStoredJobView, projectControlStopStoredJobView, } from "./codex-goal-mcp-project-control-actions.js";
import { projectControlCreateCodexGoalJobView, projectControlOperationStatusView, projectControlRefillWorkerView, } from "./codex-goal-mcp-project-control-jobs.js";
import { projectControllerConsumeGuidanceView, projectControllerLaunchPlanView, projectControllerReconcileView, projectControllerStartView, projectControllerStatusView, projectControllerStopView, } from "./codex-goal-mcp-project-controller.js";
export { projectControllerPendingGuidancePromptContext, } from "./codex-goal-mcp-project-controller-provider.js";
import { compactAgentRunEvents, planAgentRunEventCompaction, projectAgentRunEvents, readAgentRunEvents, readAgentRunState, watchAgentRuns, } from "./codex-goal-mcp-run-events.js";
import { continueStoredJobLifecycle, maintenancePauseStoredJobLifecycle, reconcileStoredJobRuntimeResultLifecycle, stopStoredJobLifecycle, } from "./codex-goal-mcp-job-lifecycle.js";
import { goalLaunchInput, } from "./codex-goal-mcp-launch-input.js";
import { codexGoalLaunchSummary as launchSummary, } from "./codex-goal-mcp-launch-summary.js";
import { CODEX_GOAL_CONTROL_SURFACE_SCHEMA, buildCodexGoalDecision, buildCodexGoalHandoff, isSafeStartAction, nextActionForStatus, } from "./codex-goal-mcp-decision.js";
import { projectControlPathArg, } from "./codex-goal-mcp-project-scope.js";
import { projectIntegrationPushApprovedCommitWithConsumedLedger, } from "./codex-goal-mcp-project-integration-ledger.js";
export { availableCodexGoalAccountSlots, dedupeCodexGoalAccountSlots, visibleCodexGoalAccountPoolSlots, } from "./codex-goal-mcp-accounts.js";
const serverVersion = "0.1.0-main.2";
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
function projectControlAdminDeps() {
    return {
        loadProjectControlController,
        admissionDeps: codexProjectAdmissionDeps,
    };
}
async function projectControlAdmissionSnapshot(args) {
    return mcpJson(await projectControlAdmissionSnapshotView(args, projectControlAdminDeps()));
}
async function projectControlUpdateControllerScope(args) {
    return mcpJson(await projectControlUpdateControllerScopeView(args, projectControlAdminDeps()));
}
async function projectControlRepairJobManifest(args) {
    return mcpJson(await projectControlRepairJobManifestView(args, projectControlAdminDeps()));
}
function codexProjectControlBroker(input) {
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
async function projectControllerLaunchPlan(args) {
    return mcpJson(await projectControllerLaunchPlanView(args, projectControllerDeps()));
}
async function projectControllerStart(args) {
    return mcpJson(await projectControllerStartView(args, projectControllerDeps()));
}
async function projectControllerStatus(args) {
    return mcpJson(await projectControllerStatusView(args, projectControllerDeps()));
}
async function projectControllerConsumeGuidance(args) {
    return mcpJson(await projectControllerConsumeGuidanceView(args, projectControllerDeps()));
}
async function projectControllerStop(args) {
    return mcpJson(await projectControllerStopView(args, projectControllerDeps()));
}
async function projectControllerReconcile(args) {
    return mcpJson(await projectControllerReconcileView(args, projectControllerDeps()));
}
function projectControlJobsDeps() {
    return {
        loadProjectControlController,
        codexProjectControlBroker,
    };
}
async function projectControlCreateCodexGoalJob(args) {
    return mcpJson(await projectControlCreateCodexGoalJobView(args, projectControlJobsDeps()));
}
async function projectControlRefillWorker(args) {
    return mcpJson(await projectControlRefillWorkerView(args, projectControlJobsDeps()));
}
async function projectControlOperationStatus(args) {
    return mcpJson(await projectControlOperationStatusView(args, projectControlJobsDeps()));
}
function projectControlActionDeps() {
    return {
        loadProjectControlController,
        loadJobLaunch,
        codexProjectControlBroker,
    };
}
async function projectControlStartStoredJob(args) {
    return mcpJson(await projectControlStartStoredJobView(args, projectControlActionDeps()));
}
async function projectControlCreateWorktree(args) {
    return mcpJson(await projectControlCreateWorktreeView(args, projectControlActionDeps()));
}
async function projectControlIntegrateCommit(args) {
    return mcpJson(await projectControlIntegrateCommitView(args, projectControlActionDeps()));
}
async function projectControlPushBranch(args) {
    return mcpJson(await projectControlPushBranchView(args, projectControlActionDeps()));
}
async function projectControlStopStoredJob(args) {
    return mcpJson(await projectControlStopStoredJobView(args, projectControlActionDeps()));
}
async function projectControlMarkReviewed(args) {
    return mcpJson(await projectControlMarkReviewedView(args, projectControlActionDeps()));
}
async function continueStoredJob(args, options) {
    return mcpJson(await continueStoredJobLifecycle(args, options, { loadJobLaunch }));
}
async function reconcileStoredJobRuntimeResult(args) {
    return mcpJson(await reconcileStoredJobRuntimeResultLifecycle(args, { loadJobLaunch }));
}
async function stopStoredJob(args) {
    return mcpJson(await stopStoredJobLifecycle(args, { loadJobLaunch }));
}
async function maintenancePauseStoredJob(args) {
    return mcpJson(await maintenancePauseStoredJobLifecycle(args, { loadJobLaunch }));
}
async function buildCodexGoalOverview(args) {
    return buildCodexGoalOverviewView(args);
}
function codexGoalOverviewDeps() {
    return {
        continueStoredJob: async (args, options) => {
            const response = await continueStoredJob(args, options);
            return response.structuredContent;
        },
    };
}
async function reconcilePreviewCodexGoalJobs(args) {
    return reconcilePreviewCodexGoalJobsView(args, codexGoalOverviewDeps());
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