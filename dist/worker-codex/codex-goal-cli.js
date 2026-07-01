#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { codexGoalAccountSlots, runCodexGoal, } from "./codex-goal-runner.js";
import { parseCodexGoalPermissionMode } from "./codex-goal-permission-mode.js";
import { buildCodexGoalNoTmuxCommand, buildCodexGoalTmuxCommand, collectCodexGoalStatus, doctorCodexGoal, startCodexGoalTmux, tailCodexGoalLog, } from "./codex-goal-ops.js";
import { callCodexGoalMcpTool, doctorCodexGoalControlSurface, getCodexGoalMcpPrompt, listCodexGoalMcpPrompts, listCodexGoalMcpResources, listCodexGoalMcpTools, readCodexGoalMcpResource, } from "./codex-goal-mcp-client.js";
export async function runCodexGoalCli(argv = process.argv.slice(2), io = defaultIo) {
    try {
        const command = parseCodexGoalCliArgs(argv, io);
        if (command.kind === "help") {
            io.writeStdout(usage());
            return 0;
        }
        if (command.kind === "status") {
            await printStatus(command, io);
            return 0;
        }
        if (command.kind === "doctor") {
            const result = await doctor(command);
            writeJsonOrText(command.format, result, io);
            return result.ok ? 0 : 1;
        }
        if (command.kind === "tail") {
            io.writeStdout(await tailFile(command.logPath, command.lines));
            return 0;
        }
        if (command.kind === "mcp-tools") {
            writeJsonOrText(command.format, await listCodexGoalMcpTools(), io);
            return 0;
        }
        if (command.kind === "mcp-tool") {
            writeJsonOrText(command.format, await callCodexGoalMcpTool({
                name: command.name,
                args: await readJsonArgs(command, io),
            }), io);
            return 0;
        }
        if (command.kind === "mcp-resources") {
            writeJsonOrText(command.format, await listCodexGoalMcpResources(), io);
            return 0;
        }
        if (command.kind === "mcp-resource") {
            writeJsonOrText(command.format, await readCodexGoalMcpResource({ uri: command.uri }), io);
            return 0;
        }
        if (command.kind === "mcp-prompts") {
            writeJsonOrText(command.format, await listCodexGoalMcpPrompts(), io);
            return 0;
        }
        if (command.kind === "mcp-prompt") {
            writeJsonOrText(command.format, await getCodexGoalMcpPrompt({
                name: command.name,
                args: await readJsonArgs(command, io),
            }), io);
            return 0;
        }
        if (command.kind === "control-doctor") {
            const result = await doctorCodexGoalControlSurface();
            writeJsonOrText(command.format, result, io);
            return result.ok ? 0 : 1;
        }
        if (command.tmuxSession) {
            const tmuxCommand = buildTmuxCommand(command);
            if (command.dryRun || command.printCommand) {
                io.writeStdout(`${tmuxCommand.preview}\n`);
                return 0;
            }
            await startCodexGoalTmux(cliLaunchInput(command));
            io.writeStdout(`started ${command.tmuxSession} for ${command.config.taskId}\n`);
            return 0;
        }
        if (command.dryRun || command.printCommand) {
            io.writeStdout(`${buildNoTmuxShellCommand(command)}\n`);
            return 0;
        }
        const result = await runCodexGoal(command.config);
        writeJsonOrText(command.format, result, io);
        return result.status === "completed" ? 0 : 1;
    }
    catch (error) {
        io.writeStderr(`${error instanceof Error ? error.message : "codex goal failed"}\n`);
        return 2;
    }
}
export function parseCodexGoalCliArgs(argv, io = defaultIo) {
    const commandName = argv[0] ?? "help";
    const rest = commandName === "help" || commandName.startsWith("--")
        ? argv
        : argv.slice(1);
    if (commandName === "help" || commandName === "--help" || commandName === "-h") {
        return { kind: "help" };
    }
    if (commandName === "run" || commandName.startsWith("--")) {
        return parseRun(rest, io);
    }
    if (commandName === "continue") {
        return parseRun(rest, io);
    }
    if (commandName === "status") {
        return parseStatus(rest, io);
    }
    if (commandName === "doctor") {
        return parseDoctor(rest, io);
    }
    if (commandName === "tail") {
        return parseTail(rest, io);
    }
    if (commandName === "tools") {
        return parseMcpTools(rest, io);
    }
    if (commandName === "tool" || commandName === "call") {
        return parseMcpTool(rest, io);
    }
    if (commandName === "resources") {
        return parseMcpResources(rest, io);
    }
    if (commandName === "resource") {
        return parseMcpResource(rest, io);
    }
    if (commandName === "prompts") {
        return parseMcpPrompts(rest, io);
    }
    if (commandName === "prompt") {
        return parseMcpPrompt(rest, io);
    }
    if (commandName === "doctor-control" || commandName === "control-doctor") {
        return parseControlDoctor(rest, io);
    }
    const shortcut = parseMcpShortcut(commandName, rest, io);
    if (shortcut)
        return shortcut;
    throw new Error(`unknown command: ${commandName}`);
}
export function buildTmuxCommand(command) {
    return buildCodexGoalTmuxCommand(cliLaunchInput(command));
}
export function buildNoTmuxShellCommand(command) {
    return buildCodexGoalNoTmuxCommand(cliLaunchInput(command));
}
function cliLaunchInput(command) {
    return {
        config: command.config,
        ...(command.tmuxSession ? { tmuxSession: command.tmuxSession } : {}),
        cwd: command.cwd,
        logPath: command.logPath,
        format: command.format,
        cliCommand: [execPath, currentCliPath()],
    };
}
function parseRun(argv, io) {
    const env = io.env();
    const values = parseFlags(argv);
    const jobRootDir = requiredOption(values, env, "--job-root", [
        "SUBSCRIPTION_RUNTIME_JOB_ROOT",
    ]);
    const taskId = requiredOption(values, env, "--task-id", [
        "SUBSCRIPTION_RUNTIME_TASK_ID",
        "MEMO_STACK_GOAL_TASK_ID",
    ]);
    const logPath = option(values, env, "--log", []) ??
        join(jobRootDir, `${taskId}.log`);
    const config = runConfigFromFlags(values, env, io.cwd(), jobRootDir, taskId);
    return {
        kind: "run",
        config,
        ...(option(values, env, "--tmux-session", []) || flag(values, "--tmux")
            ? { tmuxSession: option(values, env, "--tmux-session", []) ?? taskId }
            : {}),
        dryRun: flag(values, "--dry-run"),
        printCommand: flag(values, "--print-command"),
        format: outputFormat(option(values, env, "--format", []) ?? "text"),
        cwd: resolvePath(io.cwd(), option(values, env, "--cwd", []) ?? io.cwd()),
        logPath,
    };
}
function parseDoctor(argv, io) {
    const env = io.env();
    const values = parseFlags(argv);
    const jobRootDir = requiredOption(values, env, "--job-root", [
        "SUBSCRIPTION_RUNTIME_JOB_ROOT",
    ]);
    const taskId = requiredOption(values, env, "--task-id", [
        "SUBSCRIPTION_RUNTIME_TASK_ID",
        "MEMO_STACK_GOAL_TASK_ID",
    ]);
    const tmuxSession = option(values, env, "--tmux-session", []);
    return {
        kind: "doctor",
        config: runConfigFromFlags(values, env, io.cwd(), jobRootDir, taskId),
        ...(tmuxSession ? { tmuxSession } : {}),
        format: outputFormat(option(values, env, "--format", []) ?? "text"),
    };
}
function parseStatus(argv, io) {
    const env = io.env();
    const values = parseFlags(argv);
    const jobRootDir = option(values, env, "--job-root", [
        "SUBSCRIPTION_RUNTIME_JOB_ROOT",
    ]);
    const taskId = option(values, env, "--task-id", [
        "SUBSCRIPTION_RUNTIME_TASK_ID",
        "MEMO_STACK_GOAL_TASK_ID",
    ]);
    const workspacePath = option(values, env, "--workspace", [
        "SUBSCRIPTION_RUNTIME_WORKSPACE_PATH",
        "MEMO_STACK_GOAL_WORKSPACE_PATH",
    ]);
    const tmuxSession = option(values, env, "--tmux-session", []);
    const progressPath = option(values, env, "--progress", []);
    return {
        kind: "status",
        ...(jobRootDir ? { jobRootDir } : {}),
        ...(taskId ? { taskId } : {}),
        ...(workspacePath ? { workspacePath } : {}),
        ...(tmuxSession ? { tmuxSession } : {}),
        ...(progressPath ? { progressPath: resolvePath(io.cwd(), progressPath) } : {}),
        format: outputFormat(option(values, env, "--format", []) ?? "text"),
    };
}
function parseTail(argv, io) {
    const env = io.env();
    const values = parseFlags(argv);
    const taskId = option(values, env, "--task-id", [
        "SUBSCRIPTION_RUNTIME_TASK_ID",
        "MEMO_STACK_GOAL_TASK_ID",
    ]);
    const jobRoot = option(values, env, "--job-root", [
        "SUBSCRIPTION_RUNTIME_JOB_ROOT",
    ]);
    const logPath = option(values, env, "--log", []) ??
        (taskId && jobRoot ? join(jobRoot, `${taskId}.log`) : undefined);
    if (!logPath)
        throw new Error("--log or --job-root with --task-id is required");
    return {
        kind: "tail",
        logPath,
        lines: parsePositiveInteger(option(values, env, "--lines", []) ?? "100", "--lines"),
    };
}
function parseMcpTools(argv, io) {
    const values = parseFlags(argv);
    return {
        kind: "mcp-tools",
        format: outputFormatFromFlags(values, io.env()),
    };
}
function parseMcpTool(argv, io) {
    const name = argv[0];
    if (!name || name.startsWith("--"))
        throw new Error("tool name is required");
    const values = parseFlags(argv.slice(1));
    return {
        kind: "mcp-tool",
        name,
        ...jsonArgsSource(values),
        format: outputFormatFromFlags(values, io.env()),
    };
}
function parseMcpResources(argv, io) {
    const values = parseFlags(argv);
    return {
        kind: "mcp-resources",
        format: outputFormatFromFlags(values, io.env()),
    };
}
function parseMcpResource(argv, io) {
    const uri = argv[0];
    if (!uri || uri.startsWith("--"))
        throw new Error("resource uri is required");
    const values = parseFlags(argv.slice(1));
    return {
        kind: "mcp-resource",
        uri,
        format: outputFormatFromFlags(values, io.env()),
    };
}
function parseMcpPrompts(argv, io) {
    const values = parseFlags(argv);
    return {
        kind: "mcp-prompts",
        format: outputFormatFromFlags(values, io.env()),
    };
}
function parseMcpPrompt(argv, io) {
    const name = argv[0];
    if (!name || name.startsWith("--"))
        throw new Error("prompt name is required");
    const values = parseFlags(argv.slice(1));
    return {
        kind: "mcp-prompt",
        name,
        ...jsonArgsSource(values),
        format: outputFormatFromFlags(values, io.env()),
    };
}
function parseControlDoctor(argv, io) {
    const values = parseFlags(argv);
    return {
        kind: "control-doctor",
        format: outputFormatFromFlags(values, io.env()),
    };
}
function parseMcpShortcut(commandName, argv, io) {
    if (commandName === "overview") {
        const values = parseFlags(argv);
        return {
            kind: "mcp-tool",
            name: "codex_goal_overview",
            argsJson: JSON.stringify({
                ...registryArg(values),
                ...optionalNumberArg(values, "--stale-after-ms", "staleAfterMs"),
                ...optionalNumberArg(values, "--tail-lines", "tailLines"),
                ...optionalNumberArg(values, "--limit", "limit"),
            }),
            format: outputFormatFromFlags(values, io.env()),
        };
    }
    if (commandName === "run-watch" || commandName === "agent-run-watch") {
        const jobId = argv[0]?.startsWith("--") ? undefined : argv[0];
        const values = parseFlags(jobId ? argv.slice(1) : argv);
        return {
            kind: "mcp-tool",
            name: "agent_run_watch",
            argsJson: JSON.stringify({
                providerKind: values.values.get("--provider") ??
                    values.values.get("--provider-kind") ??
                    "codex",
                ...(jobId ? { jobId } : {}),
                ...registryArg(values),
                ...(values.values.get("--state-root")
                    ? { stateRootDir: values.values.get("--state-root") }
                    : {}),
                ...(values.values.get("--run-artifacts-root")
                    ? { runArtifactsRootDir: values.values.get("--run-artifacts-root") }
                    : {}),
                ...optionalNumberArg(values, "--stale-after-ms", "staleAfterMs"),
                ...optionalNumberArg(values, "--tail-lines", "tailLines"),
                ...optionalNumberArg(values, "--limit", "limit"),
                ...(flag(values, "--include-changed-files") || flag(values, "--changed-files")
                    ? { includeChangedFiles: true }
                    : {}),
                ...(flag(values, "--include-log-tail") || flag(values, "--log-tail")
                    ? { includeLogTail: true }
                    : {}),
            }),
            format: outputFormatFromFlags(values, io.env()),
        };
    }
    if (commandName === "reconcile-preview") {
        const values = parseFlags(argv);
        return {
            kind: "mcp-tool",
            name: "codex_goal_reconcile_preview",
            argsJson: JSON.stringify({
                ...registryArg(values),
                ...optionalNumberArg(values, "--stale-after-ms", "staleAfterMs"),
                ...optionalNumberArg(values, "--tail-lines", "tailLines"),
                ...optionalNumberArg(values, "--max-continues", "maxContinuesPerRun"),
                ...(flag(values, "--continue-safe-jobs")
                    ? { continueSafeJobs: true }
                    : {}),
                ...(flag(values, "--skip-doctor") ? { skipDoctor: true } : {}),
            }),
            format: outputFormatFromFlags(values, io.env()),
        };
    }
    if (commandName === "brief") {
        return parseJobShortcut({
            kind: "brief",
            tool: "codex_goal_brief",
            argv,
            io,
            extraArgs: (values) => ({
                ...optionalNumberArg(values, "--stale-after-ms", "staleAfterMs"),
                ...optionalNumberArg(values, "--tail-lines", "tailLines"),
            }),
        });
    }
    if (commandName === "decision") {
        return parseJobShortcut({
            kind: "decision",
            tool: "codex_goal_decision",
            argv,
            io,
            extraArgs: (values) => ({
                ...optionalNumberArg(values, "--stale-after-ms", "staleAfterMs"),
                ...optionalNumberArg(values, "--tail-lines", "tailLines"),
                ...(flag(values, "--no-registry-conflicts")
                    ? { includeRegistryConflicts: false }
                    : {}),
            }),
        });
    }
    if (commandName === "handoff") {
        return parseJobShortcut({
            kind: "handoff",
            tool: "codex_goal_handoff",
            argv,
            io,
            extraArgs: (values) => ({
                includeCliFallback: !flag(values, "--no-cli-fallback"),
                ...optionalNumberArg(values, "--stale-after-ms", "staleAfterMs"),
                ...optionalNumberArg(values, "--tail-lines", "tailLines"),
            }),
        });
    }
    if (commandName === "accounts") {
        return parseJobShortcut({
            kind: "accounts",
            tool: "codex_goal_accounts_status",
            argv,
            io,
        });
    }
    if (commandName === "send-guidance" || commandName === "guidance") {
        return parseJobShortcut({
            kind: "send-guidance",
            tool: "codex_goal_send_guidance",
            argv,
            io,
            extraArgs: (values) => ({
                message: requiredFlagValue(values, "--message"),
                ...callerArgs(values),
                ...(values.values.get("--caller-id")
                    ? { callerId: values.values.get("--caller-id") }
                    : {}),
                ...(values.values.get("--priority")
                    ? { priority: values.values.get("--priority") }
                    : {}),
                ...(values.values.get("--idempotency-key")
                    ? { idempotencyKey: values.values.get("--idempotency-key") }
                    : {}),
                ...(values.values.get("--expires-at")
                    ? { expiresAt: values.values.get("--expires-at") }
                    : {}),
            }),
        });
    }
    if (commandName === "control-enqueue" || commandName === "inbox-enqueue") {
        return parseJobShortcut({
            kind: "control-enqueue",
            tool: "codex_goal_control_enqueue",
            argv,
            io,
            extraArgs: (values) => ({
                intent: values.values.get("--intent") ?? "guidance",
                body: requiredFlagValue(values, "--body"),
                ...(values.values.get("--delivery-mode")
                    ? { deliveryMode: values.values.get("--delivery-mode") }
                    : {}),
                ...(values.values.get("--created-by")
                    ? { createdBy: values.values.get("--created-by") }
                    : {}),
                ...callerArgs(values),
                ...(values.values.get("--caller-id")
                    ? { callerId: values.values.get("--caller-id") }
                    : {}),
                ...(values.values.get("--priority")
                    ? { priority: values.values.get("--priority") }
                    : {}),
                ...(values.values.get("--idempotency-key")
                    ? { idempotencyKey: values.values.get("--idempotency-key") }
                    : {}),
                ...(values.values.get("--expires-at")
                    ? { expiresAt: values.values.get("--expires-at") }
                    : {}),
                ...(values.values.get("--supersedes")
                    ? { supersedesSignalIds: values.values.get("--supersedes") }
                    : {}),
            }),
        });
    }
    if (commandName === "control-list" || commandName === "inbox-list") {
        return parseJobShortcut({
            kind: "control-list",
            tool: "codex_goal_control_list",
            argv,
            io,
            extraArgs: (values) => ({
                ...(flag(values, "--include-bodies") ? { includeBodies: true } : {}),
            }),
        });
    }
    if (commandName === "control-decision" || commandName === "inbox-decision") {
        return parseJobShortcut({
            kind: "control-decision",
            tool: "codex_goal_control_decision",
            argv,
            io,
        });
    }
    if (commandName === "control-reconcile" || commandName === "inbox-reconcile") {
        return parseJobShortcut({
            kind: "control-reconcile",
            tool: "codex_goal_control_reconcile",
            argv,
            io,
            extraArgs: (values) => ({
                ...(flag(values, "--repair") ? { repair: true } : {}),
                ...positiveIntegerArg(values, "--accepted-stale-after-ms"),
            }),
        });
    }
    if (commandName === "control-supersede" || commandName === "inbox-supersede") {
        return parseJobShortcut({
            kind: "control-supersede",
            tool: "codex_goal_control_supersede",
            argv,
            io,
            extraArgs: (values) => ({
                signalId: requiredFlagValue(values, "--signal-id"),
                ...(values.values.get("--superseded-by")
                    ? { supersededBySignalId: values.values.get("--superseded-by") }
                    : {}),
                ...(values.values.get("--reason")
                    ? { reason: values.values.get("--reason") }
                    : {}),
                ...callerArgs(values),
                ...(values.values.get("--caller-id")
                    ? { callerId: values.values.get("--caller-id") }
                    : {}),
            }),
        });
    }
    if (commandName === "continue-job") {
        return parseJobShortcut({
            kind: "continue-job",
            tool: "codex_goal_continue",
            argv,
            io,
            extraArgs: (values) => ({
                ...(flag(values, "--confirm") ? { confirmContinue: true } : {}),
                ...(flag(values, "--force") ? { forceStart: true } : {}),
                ...(flag(values, "--skip-doctor") ? { skipDoctor: true } : {}),
            }),
        });
    }
    if (commandName === "recover-job") {
        return parseJobShortcut({
            kind: "recover-job",
            tool: "codex_goal_recover",
            argv,
            io,
            extraArgs: (values) => ({
                ...(flag(values, "--confirm") ? { confirmRecover: true } : {}),
                ...(flag(values, "--force") ? { forceStart: true } : {}),
                ...(flag(values, "--skip-doctor") ? { skipDoctor: true } : {}),
            }),
        });
    }
    if (commandName === "stop-job") {
        return parseJobShortcut({
            kind: "stop-job",
            tool: "codex_goal_stop",
            argv,
            io,
            extraArgs: (values) => ({
                ...(flag(values, "--confirm") ? { confirmStop: true } : {}),
                ...(flag(values, "--force") ? { forceStop: true } : {}),
                ...optionalNumberArg(values, "--stale-after-ms", "staleAfterMs"),
                ...optionalNumberArg(values, "--tail-lines", "tailLines"),
            }),
        });
    }
    if (commandName === "mark-reviewed") {
        return parseJobShortcut({
            kind: "mark-reviewed",
            tool: "codex_goal_mark_reviewed",
            argv,
            io,
            extraArgs: (values) => ({
                ...(values.values.get("--note")
                    ? { note: values.values.get("--note") }
                    : {}),
            }),
        });
    }
    if (commandName === "relogin") {
        const jobId = argv[0];
        if (!jobId || jobId.startsWith("--"))
            throw new Error("jobId is required");
        const account = argv[1]?.startsWith("--") ? undefined : argv[1];
        const flagArgs = account ? argv.slice(2) : argv.slice(1);
        const values = parseFlags(flagArgs);
        return {
            kind: "mcp-tool",
            name: "codex_goal_accounts_relogin_instructions",
            argsJson: JSON.stringify({
                jobId,
                ...registryArg(values),
                ...(account ? { account } : {}),
            }),
            format: outputFormatFromFlags(values, io.env()),
        };
    }
    return undefined;
}
function parseJobShortcut(input) {
    const jobId = input.argv[0];
    if (!jobId || jobId.startsWith("--"))
        throw new Error("jobId is required");
    const values = parseFlags(input.argv.slice(1));
    return {
        kind: "mcp-tool",
        name: input.tool,
        argsJson: JSON.stringify({
            jobId,
            ...registryArg(values),
            ...(input.extraArgs?.(values) ?? {}),
        }),
        format: outputFormatFromFlags(values, input.io.env()),
    };
}
function registryArg(values) {
    const registryRootDir = values.values.get("--registry-root");
    return registryRootDir ? { registryRootDir } : {};
}
function callerArgs(values) {
    const callerKind = values.values.get("--caller-kind") ?? values.values.get("--caller-actor");
    const callerId = values.values.get("--caller-id");
    return {
        ...(callerKind ? { callerKind } : {}),
        ...(callerId ? { callerId } : {}),
    };
}
function positiveIntegerArg(values, name) {
    const value = values.values.get(name);
    if (value === undefined)
        return {};
    return { [camelCaseFlagName(name)]: parsePositiveInteger(value, name) };
}
function camelCaseFlagName(name) {
    return name
        .replace(/^--/, "")
        .replace(/-([a-z])/g, (_, character) => character.toUpperCase());
}
function optionalNumberArg(values, flagName, key) {
    const value = values.values.get(flagName);
    return value === undefined
        ? {}
        : { [key]: parsePositiveInteger(value, flagName) };
}
function requiredFlagValue(values, flagName) {
    const value = values.values.get(flagName);
    if (!value)
        throw new Error(`${flagName} is required`);
    return value;
}
function jsonArgsSource(values) {
    const argsJson = values.values.get("--args-json");
    const argsFile = values.values.get("--args-file");
    if (argsJson && argsFile) {
        throw new Error("use only one of --args-json or --args-file");
    }
    return {
        ...(argsJson ? { argsJson } : {}),
        ...(argsFile ? { argsFile } : {}),
    };
}
async function readJsonArgs(command, io) {
    if (command.argsJson)
        return parseJsonObject(command.argsJson, "--args-json");
    if (command.argsFile) {
        const path = resolvePath(io.cwd(), command.argsFile);
        return parseJsonObject(await readFile(path, "utf8"), "--args-file");
    }
    return {};
}
function parseJsonObject(value, source) {
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch (error) {
        throw new Error(`${source} must be valid JSON: ${error instanceof Error ? error.message : "parse failed"}`);
    }
    if (!isRecord(parsed))
        throw new Error(`${source} must be a JSON object`);
    return parsed;
}
function runConfigFromFlags(values, env, cwd, jobRootDir, taskId) {
    const authRootDir = resolvePath(cwd, option(values, env, "--auth-root", [
        "SUBSCRIPTION_RUNTIME_CODEX_AUTH_ROOT",
    ]) ?? "~/.cache/subscription-runtime/live-codex-auth");
    const accounts = codexGoalAccountSlots(splitCsv(requiredOption(values, env, "--accounts", ["CODEX_ACCOUNTS"])));
    const reasoningEffort = (option(values, env, "--effort", [
        "CODEX_REASONING_EFFORT",
    ]) ?? "high");
    const serviceTier = (option(values, env, "--service-tier", [
        "CODEX_SERVICE_TIER",
    ]) ?? "fast");
    const executionEngine = (option(values, env, "--execution-engine", [
        "CODEX_EXECUTION_ENGINE",
    ]) ?? "app-server-goal");
    const staleLockMs = parseOptionalPositiveInteger(option(values, env, "--stale-lock-ms", []), "--stale-lock-ms");
    const config = {
        ...(option(values, env, "--job-id", ["SUBSCRIPTION_RUNTIME_JOB_ID"]) === undefined
            ? {}
            : {
                jobId: option(values, env, "--job-id", [
                    "SUBSCRIPTION_RUNTIME_JOB_ID",
                ]),
            }),
        jobRootDir: resolvePath(cwd, jobRootDir),
        authRootDir,
        workspacePath: resolvePath(cwd, requiredOption(values, env, "--workspace", [
            "SUBSCRIPTION_RUNTIME_WORKSPACE_PATH",
            "MEMO_STACK_GOAL_WORKSPACE_PATH",
        ])),
        promptPath: resolvePath(cwd, requiredOption(values, env, "--prompt", [
            "SUBSCRIPTION_RUNTIME_PROMPT_PATH",
            "MEMO_STACK_GOAL_PROMPT_PATH",
        ])),
        taskId,
        accounts,
        outputPath: resolvePath(cwd, option(values, env, "--output", []) ??
            join(resolvePath(cwd, jobRootDir), `${taskId}.latest-result.json`)),
        progressPath: resolvePath(cwd, option(values, env, "--progress", []) ??
            join(resolvePath(cwd, jobRootDir), `${taskId}.progress.json`)),
        model: option(values, env, "--model", ["CODEX_MODEL"]) ?? "gpt-5.5",
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(serviceTier ? { serviceTier } : {}),
        ...(executionEngine ? { executionEngine } : {}),
        codexBinaryPath: option(values, env, "--codex-binary", [
            "CODEX_BINARY_PATH",
        ]) ?? "codex",
        permissionMode: parseCodexGoalPermissionMode(option(values, env, "--permission-mode", []) ?? "allow-edits", "--permission-mode"),
        taskTimeoutMs: parseOptionalPositiveInteger(option(values, env, "--timeout-ms", [
            "SUBSCRIPTION_RUNTIME_TASK_TIMEOUT_MS",
            "MEMO_STACK_GOAL_TASK_TIMEOUT_MS",
        ]), "--timeout-ms") ?? parseDurationMs(option(values, env, "--timeout", []) ?? "72h"),
        progressHeartbeatMs: parseOptionalPositiveInteger(option(values, env, "--progress-heartbeat-ms", [
            "SUBSCRIPTION_RUNTIME_PROGRESS_HEARTBEAT_MS",
        ]), "--progress-heartbeat-ms") ?? 60_000,
        maxAccountCycles: parseOptionalPositiveInteger(option(values, env, "--max-account-cycles", [
            "SUBSCRIPTION_RUNTIME_MAX_ACCOUNT_CYCLES",
        ]), "--max-account-cycles") ?? 5,
        ...(staleLockMs === undefined ? {} : { staleLockMs }),
        allowDuplicateAccountIdentities: flag(values, "--allow-duplicate-accounts"),
        requireGitWorkspace: !flag(values, "--no-require-git-workspace"),
        prewarmOnStart: flag(values, "--prewarm"),
        sourceEnv: env,
    };
    const stateRoot = option(values, env, "--state-root", []);
    return stateRoot
        ? { ...config, stateRootDir: resolvePath(cwd, stateRoot) }
        : config;
}
async function printStatus(command, io) {
    const status = await collectStatus(command);
    writeJsonOrText(command.format, status, io);
}
async function collectStatus(command) {
    return collectCodexGoalStatus(command);
}
async function doctor(command) {
    return doctorCodexGoal(command);
}
async function tailFile(path, lines) {
    return tailCodexGoalLog(path, lines);
}
function parseFlags(argv) {
    const flags = new Set();
    const values = new Map();
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (!arg)
            continue;
        if (arg === "--help" || arg === "-h")
            throw new Error(usage());
        if (!arg.startsWith("--"))
            throw new Error(`unknown argument: ${arg}`);
        const next = argv[index + 1];
        if (!next || next.startsWith("--")) {
            flags.add(arg);
            continue;
        }
        values.set(arg, next);
        index += 1;
    }
    return { flags, values };
}
function requiredOption(flags, env, name, envNames) {
    const value = option(flags, env, name, envNames);
    if (!value)
        throw new Error(`${name} is required`);
    return value;
}
function option(flags, env, name, envNames) {
    const value = flags.values.get(name);
    if (value !== undefined)
        return value;
    for (const envName of envNames) {
        const envValue = env[envName];
        if (envValue?.trim())
            return envValue;
    }
    return undefined;
}
function flag(flags, name) {
    return flags.flags.has(name);
}
function outputFormatFromFlags(flags, env, defaultFormat = "json") {
    const explicitFormat = option(flags, env, "--format", []);
    const json = flag(flags, "--json");
    const text = flag(flags, "--text");
    if (json && text)
        throw new Error("use only one of --json or --text");
    if (explicitFormat && json && explicitFormat !== "json") {
        throw new Error("use only one of --format text or --json");
    }
    if (explicitFormat && text && explicitFormat !== "text") {
        throw new Error("use only one of --format json or --text");
    }
    if (json)
        return "json";
    if (text)
        return "text";
    return outputFormat(explicitFormat ?? defaultFormat);
}
function outputFormat(value) {
    if (value === "text" || value === "json")
        return value;
    throw new Error("--format must be text or json");
}
function parseOptionalPositiveInteger(value, label) {
    return value === undefined ? undefined : parsePositiveInteger(value, label);
}
function parsePositiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer`);
    }
    return parsed;
}
function parseDurationMs(value) {
    const match = value.match(/^(\d+)(ms|s|m|h)$/);
    if (!match)
        throw new Error("--timeout must look like 72h, 30m, 10s or 1000ms");
    const amount = Number(match[1]);
    const unit = match[2];
    const multiplier = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
    return amount * multiplier;
}
function splitCsv(value) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
}
function resolvePath(cwd, value) {
    const expanded = value.startsWith("~/")
        ? join(homedir(), value.slice(2))
        : value;
    return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}
function pushOptional(args, flagName, value) {
    if (value === undefined)
        return;
    args.push(flagName, value);
}
function pushOptionalNumber(args, flagName, value) {
    if (value === undefined)
        return;
    args.push(flagName, String(value));
}
function shellQuote(value) {
    if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value))
        return value;
    return `'${value.replace(/'/g, "'\\''")}'`;
}
function writeJsonOrText(format, value, io) {
    if (format === "json") {
        io.writeStdout(`${JSON.stringify(value, null, 2)}\n`);
        return;
    }
    if (isRecord(value) && "checks" in value && Array.isArray(value.checks)) {
        for (const check of value.checks) {
            if (!isRecord(check))
                continue;
            io.writeStdout(`${check.ok ? "ok" : "fail"} ${String(check.name)} ${String(check.message)}\n`);
        }
        return;
    }
    io.writeStdout(`${JSON.stringify(value)}\n`);
}
function currentCliPath() {
    return fileURLToPath(import.meta.url);
}
function usage() {
    return `usage:
  subscription-runtime-codex-goal run --job-root <dir> --workspace <dir> --prompt <file> --task-id <id> --accounts account-a,account-b [--tmux-session <name>]
  subscription-runtime-codex-goal status --job-root <dir> --task-id <id> [--workspace <dir>] [--tmux-session <name>]
  subscription-runtime-codex-goal doctor --job-root <dir> --workspace <dir> --prompt <file> --task-id <id> --accounts account-a,account-b
  subscription-runtime-codex-goal tail --job-root <dir> --task-id <id> [--lines 100]
  subscription-runtime-codex-goal doctor-control
  subscription-runtime-codex-goal overview [--registry-root <dir>]
  subscription-runtime-codex-goal run-watch [jobId] [--provider codex|claude|agent-task] [--registry-root <dir>] [--state-root <dir>] [--include-log-tail] [--include-changed-files] [--json|--text]
  subscription-runtime-codex-goal reconcile-preview [--registry-root <dir>] [--continue-safe-jobs]
  subscription-runtime-codex-goal brief <jobId> [--registry-root <dir>]
  subscription-runtime-codex-goal decision <jobId> [--registry-root <dir>]
  subscription-runtime-codex-goal handoff <jobId> [--registry-root <dir>]
  subscription-runtime-codex-goal accounts <jobId> [--registry-root <dir>]
  subscription-runtime-codex-goal control-enqueue <jobId> --body <text> [--intent guidance] [--caller-kind user|operator|orchestrator|runtime|agent] [--caller-id <id>] [--registry-root <dir>]
  subscription-runtime-codex-goal control-list <jobId> [--include-bodies] [--registry-root <dir>]
  subscription-runtime-codex-goal control-decision <jobId> [--registry-root <dir>]
  subscription-runtime-codex-goal control-reconcile <jobId> [--repair] [--accepted-stale-after-ms 300000] [--registry-root <dir>]
  subscription-runtime-codex-goal control-supersede <jobId> --signal-id <id> [--caller-kind user|operator|orchestrator|runtime|agent] [--caller-id <id>] [--registry-root <dir>]
  subscription-runtime-codex-goal relogin <jobId> [account] [--registry-root <dir>]
  subscription-runtime-codex-goal continue-job <jobId> --confirm [--registry-root <dir>]
  subscription-runtime-codex-goal recover-job <jobId> --confirm [--registry-root <dir>]
  subscription-runtime-codex-goal stop-job <jobId> --confirm [--registry-root <dir>]
  subscription-runtime-codex-goal tools
  subscription-runtime-codex-goal tool <mcp_tool_name> [--args-json '{"jobId":"..."}' | --args-file args.json]
  subscription-runtime-codex-goal resources
  subscription-runtime-codex-goal resource <mcp_resource_uri>
  subscription-runtime-codex-goal prompts
  subscription-runtime-codex-goal prompt <mcp_prompt_name> [--args-json '{"jobId":"..."}' | --args-file args.json]

defaults:
  --model gpt-5.5 --effort high --service-tier fast --execution-engine app-server-goal --timeout 72h --max-account-cycles 5

escape hatches:
  --dry-run, --print-command, --no-tmux, --no-require-git-workspace

MCP fallback:
  use tool/resources/prompts when native MCP tools are unavailable in a Codex thread.
  These commands call the same in-process MCP server via the SDK, so the API surface matches MCP.
  Shortcuts like overview, run-watch, reconcile-preview, brief, decision, handoff, accounts, control-*, continue-job, recover-job and stop-job are thin wrappers around MCP tools.
`;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
const defaultIo = {
    writeStdout(chunk) {
        process.stdout.write(chunk);
    },
    writeStderr(chunk) {
        process.stderr.write(chunk);
    },
    cwd() {
        return process.cwd();
    },
    env() {
        return process.env;
    },
};
if (await isMainModule()) {
    process.exitCode = await runCodexGoalCli();
}
async function isMainModule() {
    if (!process.argv[1])
        return false;
    try {
        return (await realpath(currentCliPath())) === (await realpath(process.argv[1]));
    }
    catch {
        return currentCliPath() === process.argv[1];
    }
}
//# sourceMappingURL=codex-goal-cli.js.map