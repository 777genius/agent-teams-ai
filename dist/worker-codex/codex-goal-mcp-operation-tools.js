import { join } from "node:path";
import { z } from "zod";
import { buildCodexGoalNoTmuxCommand, buildCodexGoalTmuxCommand, collectCodexGoalStatus, doctorCodexGoal, prepareCodexGoalLaunchPaths, startCodexGoalTmux, tailCodexGoalLog, } from "./codex-goal-ops.js";
import { goalInputSchema, statusInputSchema, } from "./codex-goal-mcp-input-schemas.js";
import { registryRootFromArgs, } from "./codex-goal-mcp-inputs.js";
import { mcpJson, withMcpErrors, } from "./codex-goal-mcp-response.js";
import { goalLaunchInput, } from "./codex-goal-mcp-launch-input.js";
import { codexGoalLaunchSummary as launchSummary, } from "./codex-goal-mcp-launch-summary.js";
import { codexGoalStatusInputFromLaunch as statusInput, } from "./codex-goal-mcp-status-input.js";
import { numberValue, resolvePath, stringValue, } from "./codex-goal-mcp-values.js";
import { isSafeStartAction, } from "./codex-goal-mcp-decision.js";
import { projectControlGenericScopeDenial, projectControlGenericToolDenial, } from "./project-control-scope-guard.js";
import { upsertCodexGoalLaunchManifest } from "./codex-goal-launch-manifest.js";
export function registerCodexGoalLaunchTools(server) {
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
}
export function registerCodexGoalInspectionTools(server) {
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
}
//# sourceMappingURL=codex-goal-mcp-operation-tools.js.map