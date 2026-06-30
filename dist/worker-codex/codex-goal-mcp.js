#!/usr/bin/env node
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate, } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { codexGoalJobToArgs, createCodexGoalJob, defaultCodexGoalJobRoot, listCodexGoalJobs, readCodexGoalJob, resolveCodexGoalJobRegistryRoot, summarizeCodexGoalJob, updateCodexGoalJob, } from "./codex-goal-jobs.js";
import { codexGoalAccountSlots, codexGoalProgressPath, } from "./codex-goal-runner.js";
import { buildCodexGoalNoTmuxCommand, buildCodexGoalStopTmuxCommand, buildCodexGoalTmuxCommand, collectCodexGoalStatus, doctorCodexGoal, listCodexGoalAccountStatuses, shellQuote, startCodexGoalTmux, stopCodexGoalTmux, tailCodexGoalLog, } from "./codex-goal-ops.js";
const serverVersion = "0.1.0-main.2";
const defaultAuthRoot = "~/.cache/subscription-runtime/live-codex-auth";
const defaultTimeoutMs = 72 * 60 * 60 * 1000;
const lifecycleMarkerSpecs = [
    {
        type: "pause_request",
        suffix: "pause-request.json",
        timestampKeys: ["requestedAt"],
    },
    {
        type: "review",
        suffix: "review.json",
        timestampKeys: ["reviewedAt"],
    },
    {
        type: "stop_event",
        suffix: "stop-event.json",
        timestampKeys: ["stoppedAt"],
    },
];
export function createCodexGoalMcpServer() {
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
        },
    }, async (args) => withMcpErrors(async () => {
        const overview = await buildCodexGoalOverview(args);
        return mcpJson(overview);
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
        const manifest = await createCodexGoalJob({
            registryRootDir,
            manifest: jobManifestInputFromArgs(args),
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
        const manifest = await updateCodexGoalJob({
            registryRootDir,
            jobId: requiredRawString(updateArgs.jobId, "jobId"),
            patch: jobManifestPatchFromArgs(updateArgs),
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
        const ok = !status.tmuxAlive && status.recommendedAction !== "wait_for_worker";
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
    server.registerTool("codex_goal_pause", {
        title: "Soft Pause Codex Goal",
        description: "Write a soft pause request marker. This never kills a running worker.",
        inputSchema: jobIdInputSchema(),
    }, async (args) => withMcpErrors(async () => {
        const loaded = await loadJobLaunch(args);
        await mkdir(loaded.launch.config.jobRootDir, { recursive: true, mode: 0o700 });
        const pausePath = join(loaded.launch.config.jobRootDir, `${loaded.launch.config.taskId}.pause-request.json`);
        const status = await collectCodexGoalStatus(statusInput(loaded.launch));
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
            status,
            safeMessage: "Soft pause marker written. No tmux session or worker process was killed.",
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
        },
    }, async (args) => withMcpErrors(async () => {
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
            staleAfterMs: numberValue(args.staleAfterMs) ?? 10 * 60_000,
            tailLines: numberValue(args.tailLines) ?? 20,
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
            includeRegistryConflicts: z.boolean().optional(),
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
        inputSchema: jobIdInputSchema(),
    }, async (args) => withMcpErrors(async () => {
        const loaded = await loadJobLaunch(args);
        return mcpJson({
            registryRootDir: loaded.registryRootDir,
            jobId: loaded.manifest.jobId,
            ...(await codexGoalAccountStatusPayload(loaded.launch)),
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
            confirmStart: z.boolean().optional(),
            skipDoctor: z.boolean().optional(),
            forceStart: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => {
        const launch = await goalLaunchInput(args);
        if (!launch.tmuxSession) {
            return mcpJson({
                ok: false,
                reason: "tmux_session_required",
                noTmuxCommand: buildCodexGoalNoTmuxCommand(launch),
            });
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
            taskId: launch.config.taskId,
            tmuxSession: launch.tmuxSession,
            tmuxCommand: command.preview,
            summary: launchSummary(launch),
        });
    }));
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
async function goalLaunchInput(args) {
    const cwd = resolvePath(process.cwd(), args.cwd ?? process.cwd());
    const fileConfig = args.configPath
        ? await readGoalConfigFile(resolvePath(cwd, args.configPath))
        : {};
    const merged = mergeDefined(fileConfig, args);
    const jobRootDir = requiredString(merged.jobRootDir, "jobRootDir", cwd);
    const taskId = requiredRawString(merged.taskId, "taskId");
    const authRootDir = resolvePath(cwd, stringValue(merged.authRootDir) ?? defaultAuthRoot);
    const workspacePath = requiredString(merged.workspacePath, "workspacePath", cwd);
    const promptPath = requiredString(merged.promptPath, "promptPath", cwd);
    const accounts = codexGoalAccountSlots(accountNames(merged.accounts));
    if (!accounts.length)
        throw new Error("accounts are required");
    const config = {
        jobRootDir,
        authRootDir,
        workspacePath,
        promptPath,
        taskId,
        accounts,
        outputPath: resolvePath(cwd, stringValue(merged.outputPath) ??
            join(jobRootDir, `${taskId}.latest-result.json`)),
        progressPath: resolvePath(cwd, stringValue(merged.progressPath) ??
            codexGoalProgressPath({ jobRootDir, taskId })),
        model: stringValue(merged.model) ?? "gpt-5.5",
        reasoningEffort: (stringValue(merged.reasoningEffort) ?? "xhigh"),
        serviceTier: (stringValue(merged.serviceTier) ?? "fast"),
        executionEngine: (stringValue(merged.executionEngine) ?? "app-server-goal"),
        codexBinaryPath: stringValue(merged.codexBinaryPath) ?? "codex",
        permissionMode: (stringValue(merged.permissionMode) ?? "allow-edits"),
        taskTimeoutMs: numberValue(merged.taskTimeoutMs) ?? defaultTimeoutMs,
        progressHeartbeatMs: numberValue(merged.progressHeartbeatMs) ?? 60_000,
        ...(numberValue(merged.staleLockMs) === undefined
            ? {}
            : { staleLockMs: numberValue(merged.staleLockMs) }),
        maxAccountCycles: numberValue(merged.maxAccountCycles) ?? 5,
        allowDuplicateAccountIdentities: booleanValue(merged.allowDuplicateAccountIdentities) ?? false,
        requireGitWorkspace: booleanValue(merged.requireGitWorkspace) ?? true,
        prewarmOnStart: booleanValue(merged.prewarmOnStart) ?? false,
    };
    const stateRootDir = stringValue(merged.stateRootDir);
    const finalConfig = stateRootDir
        ? { ...config, stateRootDir: resolvePath(cwd, stateRootDir) }
        : config;
    return {
        config: finalConfig,
        ...(stringValue(merged.tmuxSession)
            ? { tmuxSession: stringValue(merged.tmuxSession) }
            : {}),
        cwd,
        logPath: resolvePath(cwd, stringValue(merged.logPath) ?? join(jobRootDir, `${taskId}.log`)),
        format: (stringValue(merged.outputFormat) ?? "json"),
        cliCommand: defaultCliCommand(import.meta.url),
    };
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
function codexGoalStateRootDir(launch) {
    return launch.config.stateRootDir ?? join(launch.config.jobRootDir, "state");
}
async function codexGoalAccountStatusPayload(launch) {
    return codexAccountStatusPayload({
        authRootDir: launch.config.authRootDir,
        stateRootDir: codexGoalStateRootDir(launch),
        accounts: launch.config.accounts.map((account) => account.name),
    });
}
async function codexAccountStatusPayload(input) {
    const slots = await listCodexGoalAccountStatuses({
        authRootDir: input.authRootDir,
        ...(input.accounts?.length ? { accounts: input.accounts } : {}),
        ...(input.stateRootDir ? { stateRootDir: input.stateRootDir } : {}),
    });
    const duplicates = duplicateAccountGroups(slots);
    const dedupedSlots = dedupeCodexGoalAccountSlots(slots);
    const availableDedupedSlots = availableCodexGoalAccountSlots(dedupedSlots);
    return {
        ok: availableDedupedSlots.length > 0,
        authRootDir: input.authRootDir,
        capacityAware: Boolean(input.stateRootDir),
        ...(input.stateRootDir ? { stateRootDir: input.stateRootDir } : {}),
        slots,
        duplicates,
        dedupedAccountNames: dedupedSlots.map((slot) => slot.name),
        availableDedupedAccountNames: availableDedupedSlots.map((slot) => slot.name),
        dedupeRecommendation: duplicates.length
            ? "Use dedupedAccountNames for worker pools. It keeps the newest ready slot per identity group."
            : "No duplicate identity groups detected.",
    };
}
function codexAccountReloginInstructions(input) {
    return [
        "This is a manual relogin flow. It does not automate browser login.",
        `mkdir -p ${shellText(join(input.authRootDir, input.account))}`,
        `test ! -f ${shellText(join(input.authRootDir, input.account, "auth.json"))} || cp ${shellText(join(input.authRootDir, input.account, "auth.json"))} ${shellText(join(input.authRootDir, input.account, "auth.json.bak.$(date +%Y%m%d-%H%M%S).before-relogin"))}`,
        `CODEX_HOME=${shellText(join(input.authRootDir, input.account))} codex login --device-auth`,
        input.afterLoginInstruction,
    ];
}
async function continueStoredJob(args, options) {
    const loaded = await loadJobLaunch(args);
    const status = await collectCodexGoalStatus(statusInput(loaded.launch));
    if (status.tmuxAlive) {
        return mcpJson({
            ok: false,
            reason: "worker_already_running",
            jobId: loaded.manifest.jobId,
            status,
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
    const command = await startCodexGoalTmux(loaded.launch);
    return mcpJson({
        ok: true,
        mode: options.mode,
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        tmuxSession: loaded.launch.tmuxSession,
        tmuxCommand: command.preview,
        statusBefore: status,
    });
}
async function stopStoredJob(args) {
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
    if (!brief.silentStale && !args.forceStop) {
        return mcpJson({
            ok: false,
            reason: "worker_not_silent_stale",
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
        safeMessage: "Stopped the tmux worker session. Review workspace/log/result before continuing or recovery.",
    });
}
async function writeCodexGoalStopEvent(input) {
    await mkdir(input.jobRootDir, { recursive: true, mode: 0o700 });
    const path = join(input.jobRootDir, `${input.taskId}.stop-event.json`);
    await writeFile(path, `${JSON.stringify({
        schemaVersion: 1,
        jobId: input.jobId,
        taskId: input.taskId,
        stoppedAt: new Date().toISOString(),
        tmuxSession: input.tmuxSession,
        stopCommand: input.stopCommand,
        forceStop: input.forceStop,
        reason: input.brief.silentStale
            ? "silent_stale_worker"
            : "manual_force_stop",
        brief: {
            silentStale: input.brief.silentStale,
            lastProgressAt: input.brief.lastProgressAt,
            lastProgressAgeMs: input.brief.lastProgressAgeMs,
            staleAfterMs: input.brief.staleAfterMs,
            logByteLength: input.brief.logByteLength,
            workspaceDirty: input.statusBefore.workspaceDirty,
            changedFiles: input.statusBefore.changedFiles ?? [],
        },
        statusBefore: input.statusBefore,
        statusAfter: input.statusAfter,
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return path;
}
async function buildCodexGoalOverview(args) {
    const registryRootDir = registryRootFromArgs(args);
    const summaries = await listCodexGoalJobs({ registryRootDir });
    const limit = numberValue(args.limit);
    const selectedSummaries = limit ? summaries.slice(0, limit) : summaries;
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
        totalJobs: summaries.length,
        returnedJobs: jobs.length,
        truncated: selectedSummaries.length < summaries.length,
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
async function buildCodexGoalWorkspaceConflicts(jobs) {
    const candidates = jobs.filter((job) => job.ok === true &&
        typeof job.jobId === "string" &&
        typeof job.workspacePath === "string" &&
        (job.workerAlive === true || job.safeToContinue === true));
    const keyed = await Promise.all(candidates.map(async (job) => ({
        job,
        workspaceKey: await workspaceConflictKey(String(job.workspacePath)),
    })));
    const groups = new Map();
    for (const item of keyed) {
        groups.set(item.workspaceKey, [...(groups.get(item.workspaceKey) ?? []), item]);
    }
    return [...groups.values()]
        .filter((group) => group.length > 1)
        .map((group) => ({
        workspacePath: group[0]?.job.workspacePath,
        workspaceKey: group[0]?.workspaceKey,
        jobIds: group.map((item) => item.job.jobId).filter((jobId) => typeof jobId === "string"),
        runningJobIds: group
            .filter((item) => item.job.workerAlive === true)
            .map((item) => item.job.jobId)
            .filter((jobId) => typeof jobId === "string"),
        safeToContinueJobIds: group
            .filter((item) => item.job.safeToContinue === true)
            .map((item) => item.job.jobId)
            .filter((jobId) => typeof jobId === "string"),
        reason: "multiple_potential_writers_share_workspace",
        safeMessage: "Multiple stored jobs can write to the same workspace. Continue only one writer after manual review.",
    }));
}
async function workspaceConflictKey(workspacePath) {
    try {
        return await realpath(workspacePath);
    }
    catch {
        return resolve(process.cwd(), workspacePath);
    }
}
function workspaceConflictJobIds(conflicts) {
    const ids = new Set();
    for (const conflict of conflicts) {
        const jobIds = Array.isArray(conflict.jobIds) ? conflict.jobIds : [];
        for (const jobId of jobIds) {
            if (typeof jobId === "string")
                ids.add(jobId);
        }
    }
    return ids;
}
function applyWorkspaceConflictToOverviewJob(input) {
    const jobId = typeof input.job.jobId === "string" ? input.job.jobId : undefined;
    if (!jobId || !input.conflictJobIds.has(jobId))
        return input.job;
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
function omitJsonKey(value, key) {
    const copy = { ...value };
    delete copy[key];
    return copy;
}
async function buildCodexGoalOverviewItem(input) {
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
        return {
            ok: true,
            jobId: manifest.jobId,
            description: manifest.description,
            tags: manifest.tags ?? [],
            workspacePath: launch.config.workspacePath,
            taskId: launch.config.taskId,
            tmuxSession: launch.tmuxSession,
            workerAlive: Boolean(status.tmuxAlive),
            recommendedAction: status.recommendedAction,
            resultStatus: status.resultStatus,
            resultReason: status.resultReason,
            progressPath: status.progressPath,
            progressExists: status.progressExists,
            progressStatus: status.progressStatus,
            progressUpdatedAt: status.progressUpdatedAt,
            progressHeartbeatAgeMs: status.progressHeartbeatAgeMs,
            progressPid: status.progressPid,
            workspaceDirty: status.workspaceDirty,
            changedFilesCount: (status.changedFiles ?? []).length,
            changedFiles: status.changedFiles ?? [],
            lastProgressAt: brief.lastProgressAt,
            lastProgressAgeMs: brief.lastProgressAgeMs,
            isStale: brief.isStale,
            silentStale: brief.silentStale,
            safeToContinue: brief.safeToContinue,
            hasAvailableAccount: brief.hasAvailableAccount,
            needsHumanRelogin: brief.needsHumanRelogin,
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
                        continue: `codex_goal_continue(${JSON.stringify({ ...registryArgs, confirmContinue: true })})`,
                    }
                    : {}),
                ...(brief.silentStale
                    ? {
                        stop: `codex_goal_stop(${JSON.stringify({ ...registryArgs, confirmStop: true })})`,
                    }
                    : {}),
            },
        };
    }
    catch (error) {
        return {
            ok: false,
            jobId: input.jobId,
            safeMessage: error instanceof Error ? error.message : String(error),
        };
    }
}
function jobRegistryInputSchema() {
    return {
        registryRootDir: z.string().optional(),
        cwd: z.string().optional(),
    };
}
function jobIdInputSchema() {
    return {
        ...jobRegistryInputSchema(),
        jobId: z.string().optional(),
    };
}
function registryRootFromArgs(args) {
    return resolveCodexGoalJobRegistryRoot({
        ...(args.registryRootDir ? { registryRootDir: args.registryRootDir } : {}),
        ...(args.cwd ? { cwd: args.cwd } : {}),
    });
}
function jobManifestInputFromArgs(args) {
    const cwd = resolvePath(process.cwd(), args.cwd ?? process.cwd());
    const jobId = requiredRawString(args.jobId, "jobId");
    const jobRootDir = resolvePath(cwd, args.jobRootDir ?? defaultCodexGoalJobRoot(jobId));
    return {
        jobId,
        ...(stringValue(args.description) ? { description: stringValue(args.description) } : {}),
        ...(tagValues(args.tags).length ? { tags: tagValues(args.tags) } : {}),
        jobRootDir,
        authRootDir: resolvePath(cwd, args.authRootDir ?? defaultAuthRoot),
        ...(args.stateRootDir ? { stateRootDir: resolvePath(cwd, args.stateRootDir) } : {}),
        workspacePath: requiredString(args.workspacePath, "workspacePath", cwd),
        promptPath: resolvePath(cwd, args.promptPath ?? join(jobRootDir, "prompt.md")),
        taskId: args.taskId ?? jobId,
        accounts: accountNames(args.accounts),
        ...(args.outputPath ? { outputPath: resolvePath(cwd, args.outputPath) } : {}),
        ...(args.progressPath ? { progressPath: resolvePath(cwd, args.progressPath) } : {}),
        progressHeartbeatMs: args.progressHeartbeatMs ?? 60_000,
        ...(args.codexBinaryPath ? { codexBinaryPath: args.codexBinaryPath } : {}),
        model: args.model ?? "gpt-5.5",
        reasoningEffort: args.reasoningEffort ?? "xhigh",
        serviceTier: args.serviceTier ?? "fast",
        executionEngine: args.executionEngine ?? "app-server-goal",
        taskTimeoutMs: args.taskTimeoutMs ?? defaultTimeoutMs,
        ...(args.staleLockMs ? { staleLockMs: args.staleLockMs } : {}),
        maxAccountCycles: args.maxAccountCycles ?? 5,
        permissionMode: args.permissionMode ?? "allow-edits",
        allowDuplicateAccountIdentities: args.allowDuplicateAccountIdentities ?? false,
        requireGitWorkspace: args.requireGitWorkspace ?? true,
        prewarmOnStart: args.prewarmOnStart ?? false,
        tmuxSession: args.tmuxSession ?? jobId,
        ...(args.cwd ? { cwd } : {}),
        ...(args.logPath ? { logPath: resolvePath(cwd, args.logPath) } : {}),
        outputFormat: args.outputFormat ?? "json",
    };
}
function jobManifestPatchFromArgs(args) {
    const cwd = resolvePath(process.cwd(), args.cwd ?? process.cwd());
    const patch = {};
    putIfDefined(patch, "description", stringValue(args.description));
    const tags = tagValues(args.tags);
    if (args.tags !== undefined)
        patch.tags = tags;
    putIfDefined(patch, "jobRootDir", args.jobRootDir && resolvePath(cwd, args.jobRootDir));
    putIfDefined(patch, "authRootDir", args.authRootDir && resolvePath(cwd, args.authRootDir));
    putIfDefined(patch, "stateRootDir", args.stateRootDir && resolvePath(cwd, args.stateRootDir));
    putIfDefined(patch, "workspacePath", args.workspacePath && resolvePath(cwd, args.workspacePath));
    putIfDefined(patch, "promptPath", args.promptPath && resolvePath(cwd, args.promptPath));
    putIfDefined(patch, "taskId", stringValue(args.taskId));
    if (args.accounts !== undefined)
        patch.accounts = accountNames(args.accounts);
    putIfDefined(patch, "outputPath", args.outputPath && resolvePath(cwd, args.outputPath));
    putIfDefined(patch, "progressPath", args.progressPath && resolvePath(cwd, args.progressPath));
    putIfDefined(patch, "progressHeartbeatMs", numberValue(args.progressHeartbeatMs));
    putIfDefined(patch, "codexBinaryPath", stringValue(args.codexBinaryPath));
    putIfDefined(patch, "model", stringValue(args.model));
    putIfDefined(patch, "reasoningEffort", stringValue(args.reasoningEffort));
    putIfDefined(patch, "serviceTier", stringValue(args.serviceTier));
    putIfDefined(patch, "executionEngine", stringValue(args.executionEngine));
    putIfDefined(patch, "taskTimeoutMs", numberValue(args.taskTimeoutMs));
    putIfDefined(patch, "staleLockMs", numberValue(args.staleLockMs));
    putIfDefined(patch, "maxAccountCycles", numberValue(args.maxAccountCycles));
    putIfDefined(patch, "permissionMode", stringValue(args.permissionMode));
    putIfDefined(patch, "allowDuplicateAccountIdentities", booleanValue(args.allowDuplicateAccountIdentities));
    putIfDefined(patch, "requireGitWorkspace", booleanValue(args.requireGitWorkspace));
    putIfDefined(patch, "prewarmOnStart", booleanValue(args.prewarmOnStart));
    putIfDefined(patch, "tmuxSession", stringValue(args.tmuxSession));
    putIfDefined(patch, "cwd", args.cwd && cwd);
    putIfDefined(patch, "logPath", args.logPath && resolvePath(cwd, args.logPath));
    putIfDefined(patch, "outputFormat", stringValue(args.outputFormat));
    return patch;
}
export async function buildCodexGoalBrief(input) {
    const result = input.status.resultPath
        ? await readRuntimeResultBrief(input.status.resultPath)
        : {};
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
    const silentStale = Boolean(input.status.tmuxAlive &&
        input.status.recommendedAction === "wait_for_worker" &&
        isStale);
    const invalidAccounts = input.accounts.filter((slot) => slot.status !== "ready");
    const capacityBlockedAccounts = input.accounts.filter((slot) => slot.capacityAvailability && slot.capacityAvailability !== "available");
    const duplicateAccounts = duplicateAccountGroups(input.accounts);
    const dedupedAccounts = dedupeCodexGoalAccountSlots(input.accounts);
    const availableDedupedAccounts = availableCodexGoalAccountSlots(dedupedAccounts);
    const safeStatusToContinue = !input.status.tmuxAlive && isSafeStartAction(input.status.recommendedAction);
    const hasAvailableAccount = availableDedupedAccounts.length > 0;
    const lifecycleMarkers = await readCodexGoalLifecycleMarkers({
        jobRootDir: input.launch.config.jobRootDir,
        taskId: input.launch.config.taskId,
    });
    const lifecycleMarkerTypes = lifecycleMarkers
        .map((marker) => marker.type)
        .filter((type) => typeof type === "string");
    const reviewedWithoutResult = Boolean(lifecycleMarkerTypes.includes("review") &&
        !input.status.resultExists &&
        !input.status.tmuxAlive);
    const next = silentStale
        ? {
            tool: "manual_review",
            reason: "silent_stale_worker",
        }
        : safeStatusToContinue && !hasAvailableAccount
            ? {
                tool: "codex_goal_accounts_status",
                reason: "no available account slots for this job",
            }
            : reviewedWithoutResult
                ? {
                    tool: "manual_review",
                    reason: "reviewed_no_result",
                }
                : nextActionForStatus(input.status.recommendedAction);
    const recentLogTail = redactLogTail(await safeTail(input.launch.logPath, input.tailLines));
    return {
        text: [
            input.status.tmuxAlive ? "worker alive" : "worker not running",
            `recommendedAction ${input.status.recommendedAction}`,
            lastProgressAt ? `lastProgressAt ${lastProgressAt}` : "lastProgressAt unknown",
            input.status.progressUpdatedAt
                ? `progressUpdatedAt ${input.status.progressUpdatedAt}`
                : "progressUpdatedAt unknown",
            input.status.progressStatus
                ? `progressStatus ${input.status.progressStatus}`
                : "progressStatus unknown",
            input.status.workspaceDirty === undefined
                ? "workspace dirty unknown"
                : `workspace dirty ${input.status.workspaceDirty}`,
            input.status.changedFiles?.length
                ? `changed files ${input.status.changedFiles.length}`
                : "changed files 0",
            silentStale ? "silentStale true" : "silentStale false",
            lifecycleMarkerTypes.length
                ? `lifecycle markers ${lifecycleMarkerTypes.join(",")}`
                : "lifecycle markers none",
            reviewedWithoutResult ? "reviewedWithoutResult true" : "reviewedWithoutResult false",
        ].join(", "),
        lastProgressAt,
        lastProgressAgeMs,
        staleAfterMs: input.staleAfterMs,
        isStale,
        silentStale,
        logExists: input.status.logExists,
        logByteLength: input.status.logByteLength,
        progressPath: input.status.progressPath,
        progressExists: input.status.progressExists,
        progressStatus: input.status.progressStatus,
        progressUpdatedAt: input.status.progressUpdatedAt,
        progressHeartbeatAgeMs: input.status.progressHeartbeatAgeMs,
        progressPid: input.status.progressPid,
        progressResultStatus: input.status.progressResultStatus,
        progressResultReason: input.status.progressResultReason,
        progressAttemptCount: input.status.progressAttemptCount,
        progressCurrentAccount: input.status.progressCurrentAccount,
        currentAccount: result.currentAccount,
        lastFailureReason: input.status.resultReason ?? result.lastFailureReason,
        changedFiles: input.status.changedFiles ?? [],
        safeToContinue: safeStatusToContinue && hasAvailableAccount && !reviewedWithoutResult,
        hasAvailableAccount,
        configuredAccounts: input.accounts.map((slot) => slot.name),
        dedupedAccounts: dedupedAccounts.map((slot) => slot.name),
        availableDedupedAccounts: availableDedupedAccounts.map((slot) => slot.name),
        needsHumanRelogin: invalidAccounts.length > 0,
        invalidAccounts: invalidAccounts.map((slot) => slot.name),
        duplicateAccounts,
        lifecycleMarkers,
        lifecycleMarkerTypes,
        capacityBlockedAccounts: capacityBlockedAccounts.map((slot) => ({
            name: slot.name,
            availability: slot.capacityAvailability,
            reason: slot.capacityReason,
            cooldownUntil: slot.capacityCooldownUntil,
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
function buildCodexGoalDecision(input) {
    const registryArgs = {
        registryRootDir: input.registryRootDir,
        jobId: input.manifest.jobId,
    };
    const workspaceConflict = findWorkspaceConflictForJob(input.overview, input.manifest.jobId);
    const blockedBySingleWriter = workspaceConflict !== undefined;
    const safeToContinue = input.brief.safeToContinue && !blockedBySingleWriter;
    const blockers = [];
    const warnings = [];
    const evidence = [
        {
            code: "worker_state",
            workerAlive: Boolean(input.status.tmuxAlive),
            recommendedAction: input.status.recommendedAction,
            resultStatus: input.status.resultStatus,
            resultReason: redactOptional(input.status.resultReason),
        },
        {
            code: "workspace_state",
            workspacePath: input.launch.config.workspacePath,
            workspaceDirty: input.status.workspaceDirty,
            changedFilesCount: (input.status.changedFiles ?? []).length,
        },
        {
            code: "progress_state",
            lastProgressAt: input.brief.lastProgressAt,
            lastProgressAgeMs: input.brief.lastProgressAgeMs,
            staleAfterMs: input.brief.staleAfterMs,
            progressUpdatedAt: input.brief.progressUpdatedAt,
            progressHeartbeatAgeMs: input.brief.progressHeartbeatAgeMs,
            progressStatus: input.brief.progressStatus,
            logByteLength: input.brief.logByteLength,
            silentStale: input.brief.silentStale,
        },
        {
            code: "account_state",
            configuredAccounts: input.brief.configuredAccounts,
            dedupedAccounts: input.brief.dedupedAccounts,
            availableDedupedAccounts: input.brief.availableDedupedAccounts,
            invalidAccounts: input.brief.invalidAccounts,
            hasAvailableAccount: input.brief.hasAvailableAccount,
        },
    ];
    if (input.brief.lifecycleMarkerTypes.length) {
        evidence.push({
            code: "lifecycle_markers",
            lifecycleMarkerTypes: input.brief.lifecycleMarkerTypes,
            lifecycleMarkers: input.brief.lifecycleMarkers,
        });
    }
    if (workspaceConflict) {
        blockers.push({
            code: "single_writer_workspace_conflict",
            severity: "critical",
            message: "Multiple stored jobs can write to the same workspace. Do not continue this job until one writer is selected.",
            conflict: workspaceConflict,
        });
    }
    if (input.brief.silentStale) {
        blockers.push({
            code: "silent_stale_worker",
            severity: "blocked",
            message: "The worker process appears alive but observable progress is stale. Inspect process, app-server, log and worktree before stopping or recovery.",
        });
    }
    if (input.status.workspaceDirty && !input.status.tmuxAlive) {
        blockers.push({
            code: "dirty_worktree_requires_review",
            severity: "blocked",
            message: "The workspace has uncommitted changes and no active worker. Review changes before starting another writer.",
            changedFiles: input.status.changedFiles ?? [],
        });
    }
    if (!input.brief.hasAvailableAccount && isSafeStartAction(input.status.recommendedAction)) {
        blockers.push({
            code: "no_available_accounts",
            severity: "blocked",
            message: "The job is otherwise continuable, but no deduped account slot is currently available.",
            invalidAccounts: input.brief.invalidAccounts,
            capacityBlockedAccounts: input.brief.capacityBlockedAccounts,
        });
    }
    if (input.brief.needsHumanRelogin && input.brief.hasAvailableAccount) {
        warnings.push({
            code: "some_accounts_need_relogin",
            severity: "warning",
            message: "Some configured accounts are invalid, but at least one deduped account is still available.",
            invalidAccounts: input.brief.invalidAccounts,
        });
    }
    if (input.brief.duplicateAccounts.length) {
        warnings.push({
            code: "duplicate_account_identity",
            severity: "warning",
            message: "Multiple slots appear to share one account identity. Deduped availability is lower than configured slot count.",
            duplicateAccounts: input.brief.duplicateAccounts,
        });
    }
    const decision = codexGoalDecisionKind({
        blockedBySingleWriter,
        brief: input.brief,
        status: input.status,
        safeToContinue,
    });
    const severity = codexGoalDecisionSeverity(decision, blockers, warnings);
    const commands = codexGoalDecisionCommands({
        registryArgs,
        safeToContinue,
        silentStale: input.brief.silentStale,
        hasInvalidAccounts: input.brief.invalidAccounts.length > 0,
    });
    return {
        action: decision,
        decision,
        severity,
        safeToContinue,
        safeToOperate: !blockedBySingleWriter,
        jobId: input.manifest.jobId,
        taskId: input.launch.config.taskId,
        workspacePath: input.launch.config.workspacePath,
        tmuxSession: input.launch.tmuxSession,
        nextBestTool: blockedBySingleWriter
            ? "manual_review"
            : input.brief.nextBestTool,
        nextBestReason: blockedBySingleWriter
            ? "single_writer_workspace_conflict"
            : input.brief.nextBestReason,
        nextBestCommand: blockedBySingleWriter
            ? "manual_review_single_writer_workspace_conflict"
            : safeToContinue
                ? commands.continue
                : input.brief.nextBestCommand,
        blockers,
        warnings,
        evidence,
        checklist: codexGoalDecisionChecklist({
            decision,
            commands,
            invalidAccounts: input.brief.invalidAccounts,
        }),
        commands,
        recentCommands: input.brief.recentCommands,
    };
}
function codexGoalDecisionKind(input) {
    if (input.blockedBySingleWriter)
        return "manual_review_single_writer_conflict";
    if (input.brief.silentStale)
        return "manual_review_silent_stale";
    if (input.status.tmuxAlive)
        return "wait_for_worker";
    if (input.status.recommendedAction === "review_completed")
        return "review_completed";
    if (!input.brief.hasAvailableAccount && isSafeStartAction(input.status.recommendedAction)) {
        return "fix_accounts";
    }
    if (input.safeToContinue)
        return "continue";
    if (input.status.workspaceDirty)
        return "manual_review_dirty_worktree";
    return "manual_review";
}
function codexGoalDecisionSeverity(decision, blockers, warnings) {
    if (blockers.some((blocker) => blocker.severity === "critical"))
        return "critical";
    if (blockers.length)
        return "blocked";
    if (decision.startsWith("manual_review"))
        return "blocked";
    if (warnings.length)
        return "warning";
    return "info";
}
function codexGoalDecisionCommands(input) {
    return {
        overview: `codex_goal_overview(${JSON.stringify({
            registryRootDir: input.registryArgs.registryRootDir,
        })})`,
        decision: `codex_goal_decision(${JSON.stringify(input.registryArgs)})`,
        brief: `codex_goal_brief(${JSON.stringify(input.registryArgs)})`,
        handoff: `codex_goal_handoff(${JSON.stringify(input.registryArgs)})`,
        accounts: `codex_goal_accounts_status(${JSON.stringify(input.registryArgs)})`,
        ...(input.safeToContinue
            ? {
                continue: `codex_goal_continue(${JSON.stringify({ ...input.registryArgs, confirmContinue: true })})`,
            }
            : {}),
        ...(input.silentStale
            ? {
                stopAfterManualReview: `codex_goal_stop(${JSON.stringify({ ...input.registryArgs, confirmStop: true })})`,
            }
            : {}),
        ...(input.hasInvalidAccounts
            ? {
                reloginInstructions: `codex_goal_accounts_relogin_instructions(${JSON.stringify(input.registryArgs)})`,
            }
            : {}),
    };
}
function codexGoalDecisionChecklist(input) {
    if (input.decision === "continue") {
        return [
            `Call ${String(input.commands.continue)}.`,
            "Monitor with codex_goal_brief and do not start another writer in the same worktree.",
        ];
    }
    if (input.decision === "wait_for_worker") {
        return [
            "Keep monitoring with codex_goal_brief.",
            "Do not start or recover another writer while the worker is alive and not silent-stale.",
        ];
    }
    if (input.decision === "fix_accounts") {
        return [
            `Call ${String(input.commands.accounts)}.`,
            input.invalidAccounts.length
                ? `Relogin invalid slots with ${String(input.commands.reloginInstructions)}.`
                : "Wait for account capacity cooldown or add a valid account slot.",
            "Re-run codex_goal_decision before continuing.",
        ];
    }
    if (input.decision === "manual_review_silent_stale") {
        return [
            "Inspect process tree, app-server, log tail and git status.",
            `If stale is confirmed, call ${String(input.commands.stopAfterManualReview)}.`,
            "After stop, re-run codex_goal_decision before continuing.",
        ];
    }
    if (input.decision === "manual_review_single_writer_conflict") {
        return [
            `Call ${String(input.commands.overview)}.`,
            "Choose exactly one writer job for the shared workspace.",
            "Do not continue any conflicted job until the conflict is resolved.",
        ];
    }
    if (input.decision === "review_completed") {
        return [
            "Review the result, workspace diff and project checks.",
            "If accepted, call codex_goal_mark_reviewed for this job.",
        ];
    }
    return [
        "Inspect brief, status, recent log tail and workspace diff manually.",
        "Do not continue until the blocking state is understood.",
    ];
}
function findWorkspaceConflictForJob(overview, jobId) {
    const conflicts = Array.isArray(overview?.workspaceConflicts)
        ? overview.workspaceConflicts
        : [];
    return conflicts.find((conflict) => isRecord(conflict) &&
        Array.isArray(conflict.jobIds) &&
        conflict.jobIds.includes(jobId));
}
function redactOptional(value) {
    return value ? redactText(value) : undefined;
}
function buildCodexGoalHandoff(input) {
    const registryArgs = {
        registryRootDir: input.registryRootDir,
        jobId: input.manifest.jobId,
    };
    const cliFallbackCommands = input.includeCliFallback
        ? [
            cliFallbackToolCommand("codex_goal_get_job", registryArgs),
            cliFallbackToolCommand("codex_goal_brief", registryArgs),
            cliFallbackToolCommand("codex_goal_accounts_status", registryArgs),
            cliFallbackToolCommand("codex_goal_continue", {
                ...registryArgs,
                confirmContinue: true,
            }),
            cliFallbackToolCommand("codex_goal_handoff", registryArgs),
        ]
        : [];
    const stopArgs = { ...registryArgs, confirmStop: true };
    const reviewCommands = input.brief.silentStale
        ? [
            `codex_goal_stop(${JSON.stringify(stopArgs)})`,
            `subscription-runtime-codex-goal stop-job ${shellText(input.manifest.jobId)} --registry-root ${shellText(input.registryRootDir)} --confirm`,
        ]
        : [];
    const mcpCommands = [
        `codex_goal_get_job(${JSON.stringify(registryArgs)})`,
        `codex_goal_brief(${JSON.stringify(registryArgs)})`,
        `codex_goal_accounts_status(${JSON.stringify(registryArgs)})`,
        input.brief.safeToContinue
            ? `codex_goal_continue(${JSON.stringify({ ...registryArgs, confirmContinue: true })})`
            : String(input.brief.nextBestCommand),
    ];
    const text = [
        `# Codex goal handoff: ${input.manifest.jobId}`,
        "",
        "Use subscription-runtime Codex goal controls. Native MCP is preferred; CLI fallback calls the same MCP server through the SDK.",
        "",
        "## Job",
        `- registryRootDir: ${input.registryRootDir}`,
        `- workspacePath: ${input.launch.config.workspacePath}`,
        `- jobRootDir: ${input.launch.config.jobRootDir}`,
        `- stateRootDir: ${codexGoalStateRootDir(input.launch)}`,
        `- taskId: ${input.launch.config.taskId}`,
        `- tmuxSession: ${input.launch.tmuxSession ?? ""}`,
        `- model: ${input.launch.config.model ?? ""}`,
        `- reasoningEffort: ${input.launch.config.reasoningEffort ?? ""}`,
        `- serviceTier: ${input.launch.config.serviceTier ?? ""}`,
        `- taskTimeoutMs: ${input.launch.config.taskTimeoutMs}`,
        `- maxAccountCycles: ${input.launch.config.maxAccountCycles}`,
        `- accounts: ${input.launch.config.accounts.map((account) => account.name).join(", ")}`,
        "",
        "## Current State",
        `- worker: ${input.status.tmuxAlive ? "alive" : "not running"}`,
        `- recommendedAction: ${input.status.recommendedAction}`,
        `- resultStatus: ${input.status.resultStatus ?? ""}`,
        `- resultReason: ${input.status.resultReason ?? ""}`,
        `- workspaceDirty: ${String(input.status.workspaceDirty)}`,
        `- changedFiles: ${(input.status.changedFiles ?? []).length}`,
        `- silentStale: ${String(input.brief.silentStale)}`,
        `- lastProgressAt: ${String(input.brief.lastProgressAt ?? "")}`,
        `- progressStatus: ${String(input.brief.progressStatus ?? "")}`,
        `- progressUpdatedAt: ${String(input.brief.progressUpdatedAt ?? "")}`,
        `- progressHeartbeatAgeMs: ${String(input.brief.progressHeartbeatAgeMs ?? "")}`,
        `- logByteLength: ${String(input.brief.logByteLength ?? "")}`,
        `- lifecycleMarkers: ${input.brief.lifecycleMarkerTypes.join(", ") || "none"}`,
        `- safeToContinue: ${String(input.brief.safeToContinue)}`,
        `- hasAvailableAccount: ${String(input.brief.hasAvailableAccount)}`,
        `- availableDedupedAccounts: ${input.brief.availableDedupedAccounts.join(", ")}`,
        `- invalidAccounts: ${input.brief.invalidAccounts.join(", ")}`,
        `- nextBestTool: ${String(input.brief.nextBestTool)}`,
        `- nextBestCommand: ${String(input.brief.nextBestCommand)}`,
        "",
        "## Native MCP",
        ...mcpCommands.map((command) => `- ${command}`),
        ...(reviewCommands.length
            ? [
                "",
                "## After Manual Review",
                ...reviewCommands.map((command) => `- ${command}`),
            ]
            : []),
        ...(cliFallbackCommands.length
            ? [
                "",
                "## CLI Fallback",
                ...cliFallbackCommands.map((command) => `- ${command}`),
            ]
            : []),
        "",
        "## Safety Rules",
        "- Do not run two writer workers in the same worktree.",
        "- Continue only when brief.safeToContinue is true.",
        "- If hasAvailableAccount is false, inspect accounts before continuing.",
        "- Dirty, provider output invalid, unknown runtime, test and benchmark failures require manual review.",
        "- Never print auth.json, access tokens, refresh tokens, id tokens or raw provider payloads.",
    ].join("\n");
    return {
        text,
        mcpCommands,
        reviewCommands,
        cliFallbackCommands,
        summary: {
            jobId: input.manifest.jobId,
            registryRootDir: input.registryRootDir,
            workspacePath: input.launch.config.workspacePath,
            taskId: input.launch.config.taskId,
            tmuxSession: input.launch.tmuxSession,
            recommendedAction: input.status.recommendedAction,
            resultStatus: input.status.resultStatus,
            resultReason: input.status.resultReason,
            workspaceDirty: input.status.workspaceDirty,
            changedFiles: input.status.changedFiles ?? [],
            silentStale: input.brief.silentStale,
            lastProgressAt: input.brief.lastProgressAt,
            lastProgressAgeMs: input.brief.lastProgressAgeMs,
            staleAfterMs: input.brief.staleAfterMs,
            logExists: input.brief.logExists,
            logByteLength: input.brief.logByteLength,
            progressPath: input.brief.progressPath,
            progressExists: input.brief.progressExists,
            progressStatus: input.brief.progressStatus,
            progressUpdatedAt: input.brief.progressUpdatedAt,
            progressHeartbeatAgeMs: input.brief.progressHeartbeatAgeMs,
            progressPid: input.brief.progressPid,
            lifecycleMarkers: input.brief.lifecycleMarkers,
            lifecycleMarkerTypes: input.brief.lifecycleMarkerTypes,
            safeToContinue: input.brief.safeToContinue,
            hasAvailableAccount: input.brief.hasAvailableAccount,
            availableDedupedAccounts: input.brief.availableDedupedAccounts,
            invalidAccounts: input.brief.invalidAccounts,
            nextBestTool: input.brief.nextBestTool,
            nextBestCommand: input.brief.nextBestCommand,
        },
        accounts: input.accounts.map((account) => ({
            name: account.name,
            status: account.status,
            capacityAvailability: account.capacityAvailability,
            capacityReason: account.capacityReason,
            capacityCooldownUntil: account.capacityCooldownUntil,
            identityHashPrefix: account.identityHashPrefix,
            safeMessage: account.safeMessage,
        })),
    };
}
async function readCodexGoalLifecycleMarkers(input) {
    const markers = await Promise.all(lifecycleMarkerSpecs.map((spec) => readCodexGoalLifecycleMarker({
        ...input,
        spec,
    })));
    return markers
        .filter((marker) => marker !== undefined)
        .sort((left, right) => Date.parse(String(right.timestamp ?? right.updatedAt ?? "0")) -
        Date.parse(String(left.timestamp ?? left.updatedAt ?? "0")));
}
async function readCodexGoalLifecycleMarker(input) {
    const markerPath = join(input.jobRootDir, `${input.taskId}.${input.spec.suffix}`);
    try {
        const [metadata, raw] = await Promise.all([
            stat(markerPath),
            readFile(markerPath, "utf8"),
        ]);
        const parsed = parseLifecycleMarker(raw);
        const timestamp = firstStringKey(parsed, input.spec.timestampKeys);
        const brief = isRecord(parsed.brief) ? parsed.brief : {};
        return {
            type: input.spec.type,
            markerPath,
            updatedAt: metadata.mtime.toISOString(),
            ...(timestamp ? { timestamp } : {}),
            ...(typeof parsed.reason === "string" ? { reason: redactText(parsed.reason) } : {}),
            ...(typeof parsed.mode === "string" ? { mode: redactText(parsed.mode) } : {}),
            ...(typeof parsed.note === "string" ? { note: truncateText(redactText(parsed.note), 300) } : {}),
            ...(typeof parsed.forceStop === "boolean" ? { forceStop: parsed.forceStop } : {}),
            ...(typeof brief.silentStale === "boolean" ? { silentStale: brief.silentStale } : {}),
            ...(typeof brief.lastProgressAt === "string"
                ? { lastProgressAt: brief.lastProgressAt }
                : {}),
            ...(typeof brief.lastProgressAgeMs === "number"
                ? { lastProgressAgeMs: brief.lastProgressAgeMs }
                : {}),
            ...(typeof brief.logByteLength === "number"
                ? { logByteLength: brief.logByteLength }
                : {}),
            ...(typeof parsed.schemaVersion === "number" ? { schemaVersion: parsed.schemaVersion } : {}),
        };
    }
    catch {
        return undefined;
    }
}
function parseLifecycleMarker(raw) {
    try {
        const parsed = JSON.parse(raw);
        return isRecord(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
function latestIsoDate(values) {
    const latest = values
        .map((value) => value ? { value, time: Date.parse(value) } : undefined)
        .filter((value) => value !== undefined && Number.isFinite(value.time))
        .sort((left, right) => right.time - left.time)[0];
    return latest?.value;
}
function firstStringKey(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.trim())
            return redactText(value.trim());
    }
    return undefined;
}
function redactText(value) {
    return new DefaultRedactor().redact(value);
}
function truncateText(value, maxLength) {
    if (value.length <= maxLength)
        return value;
    return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
function cliFallbackToolCommand(tool, args) {
    return `subscription-runtime-codex-goal tool ${tool} --args-json ${shellText(JSON.stringify(args))}`;
}
async function readRuntimeResultBrief(path) {
    try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        if (!isRecord(parsed))
            return {};
        const attempts = Array.isArray(parsed.attempts) ? parsed.attempts : [];
        const lastAttempt = lastRecord(attempts);
        return {
            ...(isRecord(lastAttempt) && typeof lastAttempt.accountId === "string"
                ? { currentAccount: lastAttempt.accountId }
                : {}),
            ...(typeof parsed.reason === "string"
                ? { lastFailureReason: parsed.reason }
                : {}),
            ...(isRecord(parsed.task) && typeof parsed.task.updatedAt === "string"
                ? { updatedAt: parsed.task.updatedAt }
                : {}),
        };
    }
    catch {
        return {};
    }
}
function lastRecord(values) {
    for (let index = values.length - 1; index >= 0; index -= 1) {
        const value = values[index];
        if (isRecord(value))
            return value;
    }
    return undefined;
}
async function safeTail(path, lines) {
    try {
        return await tailCodexGoalLog(path, lines);
    }
    catch {
        return "";
    }
}
function nextActionForStatus(action) {
    if (action === "wait_for_worker") {
        return { tool: "codex_goal_brief", reason: "worker is already running" };
    }
    if (action === "start_worker") {
        return { tool: "codex_goal_continue", reason: "no result exists and workspace is clean" };
    }
    if (action === "continue_after_capacity" || action === "continue_after_timeout") {
        return { tool: "codex_goal_continue", reason: "safe continuation condition" };
    }
    if (action === "review_completed") {
        return { tool: "codex_goal_mark_reviewed", reason: "worker completed" };
    }
    return { tool: "manual_review", reason: "status requires inspection before continuing" };
}
function nextBestCommand(input) {
    const tool = typeof input.action.tool === "string"
        ? input.action.tool
        : "manual_review";
    if (tool === "codex_goal_continue") {
        return `codex_goal_continue({ jobId: ${JSON.stringify(input.jobId)}, confirmContinue: true })`;
    }
    if (tool === "codex_goal_mark_reviewed") {
        return `codex_goal_mark_reviewed({ jobId: ${JSON.stringify(input.jobId)} })`;
    }
    if (tool === "codex_goal_brief") {
        return `codex_goal_brief({ jobId: ${JSON.stringify(input.jobId)} })`;
    }
    if (tool === "codex_goal_accounts_status") {
        return `codex_goal_accounts_status({ jobId: ${JSON.stringify(input.jobId)} })`;
    }
    if (tool === "manual_review" &&
        input.action.reason === "silent_stale_worker") {
        return "manual_review_silent_stale_worker";
    }
    if (input.status.workspaceDirty) {
        return "manual_review_dirty_worktree";
    }
    return "manual_review_status";
}
function accountPoolRootFromArgs(args) {
    return resolvePath(process.cwd(), args.poolRootDir ?? join(homedir(), ".cache", "subscription-runtime"));
}
function accountAuthRootFromArgs(args) {
    if (args.authRootDir)
        return resolvePath(process.cwd(), args.authRootDir);
    if (args.pool)
        return join(accountPoolRootFromArgs(args), args.pool);
    return resolvePath(process.cwd(), defaultAuthRoot);
}
async function listAccountPools(poolRootDir, stateRootDir) {
    let entries;
    try {
        entries = await readdir(poolRootDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const pools = await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
        const authRootDir = join(poolRootDir, entry.name);
        const slots = await listCodexGoalAccountStatuses({
            authRootDir,
            ...(stateRootDir ? { stateRootDir } : {}),
        });
        const visibleSlots = visibleCodexGoalAccountPoolSlots(entry.name, slots);
        const dedupedSlots = dedupeCodexGoalAccountSlots(visibleSlots);
        const availableDedupedSlots = availableCodexGoalAccountSlots(dedupedSlots);
        return {
            pool: entry.name,
            authRootDir,
            accountCount: visibleSlots.length,
            readyCount: visibleSlots.filter((slot) => slot.status === "ready").length,
            availableCount: availableDedupedSlots.length,
            dedupedAccountNames: dedupedSlots.map((slot) => slot.name),
            availableDedupedAccountNames: availableDedupedSlots.map((slot) => slot.name),
            hasDuplicates: duplicateAccountGroups(visibleSlots).length > 0,
        };
    }));
    return pools.filter((pool) => pool.accountCount > 0);
}
function duplicateAccountGroups(slots) {
    const groups = new Map();
    for (const slot of slots) {
        if (!slot.identityHashPrefix)
            continue;
        groups.set(slot.identityHashPrefix, [
            ...(groups.get(slot.identityHashPrefix) ?? []),
            slot,
        ]);
    }
    return [...groups.entries()]
        .filter(([, group]) => group.length > 1)
        .map(([identityHashPrefix, group]) => ({
        identityHashPrefix,
        slots: group.map((slot) => ({
            name: slot.name,
            status: slot.status,
            lastRefreshAt: slot.lastRefreshAt,
            expiresAt: slot.expiresAt,
        })),
        preferredSlot: preferredAccountSlot(group)?.name,
    }));
}
export function dedupeCodexGoalAccountSlots(slots) {
    const byIdentity = new Map();
    const uniqueSlots = [];
    for (const slot of slots) {
        const key = slot.identityHashPrefix;
        if (!key) {
            uniqueSlots.push(slot);
            continue;
        }
        const existing = byIdentity.get(key);
        const preferred = existing ? preferredAccountSlot([existing, slot]) : slot;
        if (preferred)
            byIdentity.set(key, preferred);
    }
    const duplicateIdentities = new Set(duplicateAccountGroups(slots)
        .map((group) => group.identityHashPrefix)
        .filter((value) => typeof value === "string"));
    for (const slot of slots) {
        if (!slot.identityHashPrefix || duplicateIdentities.has(slot.identityHashPrefix)) {
            continue;
        }
        uniqueSlots.push(slot);
    }
    return [
        ...uniqueSlots,
        ...[...byIdentity.entries()]
            .filter(([identity]) => duplicateIdentities.has(identity))
            .map(([, slot]) => slot),
    ];
}
export function availableCodexGoalAccountSlots(slots) {
    return slots.filter(isAccountSlotAvailable);
}
export function visibleCodexGoalAccountPoolSlots(poolName, slots) {
    const likelyAuthPool = isLikelyAuthPoolName(poolName);
    return slots.filter((slot) => slot.status !== "auth_missing" ||
        likelyAuthPool);
}
function preferredAccountSlot(slots) {
    return [...slots].sort((left, right) => {
        const leftReady = left.status === "ready" ? 1 : 0;
        const rightReady = right.status === "ready" ? 1 : 0;
        if (leftReady !== rightReady)
            return rightReady - leftReady;
        return Date.parse(right.lastRefreshAt ?? right.expiresAt ?? "0") -
            Date.parse(left.lastRefreshAt ?? left.expiresAt ?? "0");
    })[0];
}
function isAccountSlotAvailable(slot) {
    return slot.status === "ready" && (!slot.capacityAvailability || slot.capacityAvailability === "available");
}
function isLikelyAuthPoolName(name) {
    return /codex/i.test(name) &&
        /(?:^|[-_])(auth|accounts?)(?:$|[-_])/i.test(name);
}
function tagValues(value) {
    if (Array.isArray(value))
        return value.map((item) => String(item).trim()).filter(Boolean);
    if (typeof value === "string") {
        return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
    return [];
}
function extractRecentCommands(logTail) {
    const commands = [];
    for (const line of logTail.split(/\r?\n/)) {
        const command = commandFromLogLine(line);
        if (!command)
            continue;
        if (commands.at(-1) !== command)
            commands.push(command);
    }
    return commands.slice(-10);
}
function commandFromLogLine(line) {
    const trimmed = line.trim();
    if (!trimmed)
        return null;
    const promptMatch = /^(?:[$>]|\+\s)(.+)$/.exec(trimmed);
    const command = promptMatch?.[1]?.trim() ?? trimmed;
    if (!/^(?:git|npm|npx|node|pnpm|yarn|bun|uv|python|python3|pytest|ruff|mypy|tsc|vitest|cargo|go|make|cmake|docker|docker-compose|\.venv\/bin\/python|scripts\/)[\s/]/.test(command)) {
        return null;
    }
    return redactCommand(command).slice(0, 500);
}
function redactCommand(command) {
    return new DefaultRedactor().redact(command);
}
function redactLogTail(logTail) {
    return logTail
        .split(/\r?\n/)
        .map((line) => redactCommand(line))
        .join("\n");
}
function putIfDefined(target, key, value) {
    if (value !== undefined)
        target[key] = value;
}
function registerCodexGoalPrompts(server) {
    for (const prompt of [
        ["start_codex_goal_worker", "Start a stored Codex goal worker safely."],
        ["monitor_codex_goal_worker", "Monitor a running Codex goal worker."],
        ["recover_codex_goal_worker", "Recover a stopped Codex goal worker."],
        ["handoff_codex_goal_job", "Prepare a handoff for another agent."],
        ["review_worker_changes", "Review worker changes before merge or commit."],
    ]) {
        server.registerPrompt(prompt[0], {
            title: prompt[0],
            description: prompt[1],
            argsSchema: { jobId: z.string().optional() },
        }, ({ jobId }) => ({
            messages: [{
                    role: "user",
                    content: {
                        type: "text",
                        text: codexGoalPromptText(prompt[0], jobId),
                    },
                }],
        }));
    }
}
function codexGoalPromptText(name, jobId) {
    const id = jobId?.trim() || "<jobId>";
    const shared = `Use the subscription-runtime Codex goal MCP tools for jobId ${id}. ` +
        "Never print auth.json or tokens. Do not run two writer workers in the same worktree. " +
        "Treat codex_goal_overview as the registry monitor, codex_goal_brief as the single-job monitor, and codex_goal_decision as the read-only action gate for safeToContinue, blockers, evidence and nextBestCommand.";
    if (name === "start_codex_goal_worker") {
        return `${shared} First call codex_goal_decision. Start or continue only when decision.safeToContinue is true, otherwise follow decision.checklist and decision.nextBestCommand. If no job exists yet, create one with model gpt-5.5, reasoningEffort xhigh, serviceTier fast, app-server-goal behavior and 72h timeout.`;
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
function shellText(value) {
    return shellQuote(value);
}
function goalInputSchema() {
    return {
        configPath: z.string().optional(),
        jobRootDir: z.string().optional(),
        authRootDir: z.string().optional(),
        stateRootDir: z.string().optional(),
        workspacePath: z.string().optional(),
        promptPath: z.string().optional(),
        taskId: z.string().optional(),
        accounts: z.union([z.string(), z.array(z.string())]).optional(),
        outputPath: z.string().optional(),
        progressPath: z.string().optional(),
        progressHeartbeatMs: z.number().int().positive().optional(),
        codexBinaryPath: z.string().optional(),
        model: z.string().optional(),
        reasoningEffort: z.string().optional(),
        serviceTier: z.string().optional(),
        executionEngine: z.string().optional(),
        taskTimeoutMs: z.number().int().positive().optional(),
        staleLockMs: z.number().int().positive().optional(),
        maxAccountCycles: z.number().int().positive().optional(),
        permissionMode: z.string().optional(),
        allowDuplicateAccountIdentities: z.boolean().optional(),
        requireGitWorkspace: z.boolean().optional(),
        prewarmOnStart: z.boolean().optional(),
        tmuxSession: z.string().optional(),
        cwd: z.string().optional(),
        logPath: z.string().optional(),
        outputFormat: z.enum(["text", "json"]).optional(),
    };
}
function statusInputSchema() {
    return {
        jobRootDir: z.string().optional(),
        taskId: z.string().optional(),
        workspacePath: z.string().optional(),
        tmuxSession: z.string().optional(),
        logPath: z.string().optional(),
        progressPath: z.string().optional(),
        cwd: z.string().optional(),
    };
}
function statusInput(launch) {
    return {
        jobRootDir: launch.config.jobRootDir,
        taskId: launch.config.taskId,
        ...(launch.config.outputPath ? { resultPath: launch.config.outputPath } : {}),
        workspacePath: launch.config.workspacePath,
        ...(launch.tmuxSession ? { tmuxSession: launch.tmuxSession } : {}),
        logPath: launch.logPath,
        ...(launch.config.progressPath ? { progressPath: launch.config.progressPath } : {}),
    };
}
function isSafeStartAction(action) {
    return (action === "start_worker" ||
        action === "continue_after_capacity" ||
        action === "continue_after_timeout");
}
function launchSummary(launch) {
    return {
        taskId: launch.config.taskId,
        workspacePath: launch.config.workspacePath,
        promptPath: launch.config.promptPath,
        accountNames: launch.config.accounts.map((account) => account.name),
        model: launch.config.model,
        reasoningEffort: launch.config.reasoningEffort,
        serviceTier: launch.config.serviceTier,
        executionEngine: launch.config.executionEngine ?? "app-server-goal",
        taskTimeoutMs: launch.config.taskTimeoutMs,
        progressPath: launch.config.progressPath,
        progressHeartbeatMs: launch.config.progressHeartbeatMs,
        maxAccountCycles: launch.config.maxAccountCycles,
        tmuxSession: launch.tmuxSession,
        logPath: launch.logPath,
    };
}
async function readGoalConfigFile(path) {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed))
        throw new Error("configPath must contain a JSON object");
    return parsed;
}
function defaultCliCommand(importMetaUrl) {
    return [
        execPath,
        join(dirname(fileURLToPath(importMetaUrl)), "codex-goal-cli.js"),
    ];
}
function mergeDefined(...items) {
    const merged = {};
    for (const item of items) {
        for (const [key, value] of Object.entries(item)) {
            if (value !== undefined)
                merged[key] = value;
        }
    }
    return merged;
}
function accountNames(value) {
    if (Array.isArray(value)) {
        return value.map((item) => String(item).trim()).filter(Boolean);
    }
    if (typeof value === "string") {
        return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
    return [];
}
function requiredString(value, name, cwd) {
    return resolvePath(cwd, requiredRawString(value, name));
}
function requiredRawString(value, name) {
    const text = stringValue(value);
    if (!text)
        throw new Error(`${name} is required`);
    return text;
}
function stringValue(value) {
    return typeof value === "string" && value.trim() ? value : undefined;
}
function numberValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function booleanValue(value) {
    return typeof value === "boolean" ? value : undefined;
}
function resolvePath(cwd, value) {
    const expanded = value.startsWith("~/")
        ? join(homedir(), value.slice(2))
        : value;
    return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}
function mcpJson(value) {
    return {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
        structuredContent: value,
    };
}
async function withMcpErrors(action) {
    try {
        return await action();
    }
    catch (error) {
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
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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