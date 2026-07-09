#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";
import {
  type CodexGoalCliIo,
  type OutputFormat,
  type ParsedFlags,
  flag,
  option,
  outputFormat,
  outputFormatFromFlags,
  parseFlags,
  parseOptionalPositiveInteger,
  parsePositiveInteger,
  requiredOption,
  resolvePath,
  writeJsonOrText,
} from "./codex-goal-cli-support";

export type { CodexGoalCliIo } from "./codex-goal-cli-support";

import {
  runCodexGoal,
  type CodexGoalRunConfig,
} from "./codex-goal-runner";
import {
  buildCodexGoalNoTmuxCommand,
  buildCodexGoalTmuxCommand,
  collectCodexGoalStatus,
  doctorCodexGoal,
  startCodexGoalTmux,
  tailCodexGoalLog,
} from "./codex-goal-ops";
import {
  callCodexGoalMcpTool,
  doctorCodexGoalControlSurface,
  getCodexGoalMcpPrompt,
  listCodexGoalMcpPrompts,
  listCodexGoalMcpResources,
  listCodexGoalMcpTools,
  readCodexGoalMcpResource,
  superviseCodexGoalProjectController,
} from "./codex-goal-mcp-client";
import {
  upsertCodexGoalLaunchManifest,
  type CodexGoalLaunchManifestMetadata,
} from "./codex-goal-launch-manifest";
import {
  parseCodexGoalRelayEventsCommand,
  runCodexGoalRelayEventsCommand,
  type RelayEventsCommand,
} from "./run-event-relay";
import {
  oneShotCodexGoalMcpToolGuard,
  parseCodexGoalCliMcpShortcut,
} from "./codex-goal-cli-shortcuts";
import {
  runConfigFromFlags,
  splitCsv,
} from "./codex-goal-cli-run-config";
import {
  projectControlGenericScopeDenial,
  projectControlGenericToolDenial,
} from "./project-control-scope-guard";
import {
  runProjectControlOperationFile,
} from "./project-control-operation-lifecycle";

type CodexGoalCliCommand =
  | RunCommand
  | StatusCommand
  | DoctorCommand
  | TailCommand
  | RelayEventsCommand
  | McpToolsCommand
  | McpToolCommand
  | McpResourcesCommand
  | McpResourceCommand
  | McpPromptsCommand
  | McpPromptCommand
  | ControlDoctorCommand
  | ControllerSuperviseCommand
  | ProjectControlOperationRunCommand
  | HelpCommand;

export type RunCommand = {
  readonly kind: "run";
  readonly config: CodexGoalRunConfig;
  readonly tmuxSession?: string;
  readonly dryRun: boolean;
  readonly printCommand: boolean;
  readonly format: OutputFormat;
  readonly cwd: string;
  readonly logPath: string;
  readonly registryRootDir?: string;
  readonly registryMetadata?: CodexGoalLaunchManifestMetadata;
};

type StatusCommand = {
  readonly kind: "status";
  readonly jobRootDir?: string;
  readonly taskId?: string;
  readonly workspacePath?: string;
  readonly tmuxSession?: string;
  readonly progressPath?: string;
  readonly format: OutputFormat;
};

type DoctorCommand = {
  readonly kind: "doctor";
  readonly config: CodexGoalRunConfig;
  readonly tmuxSession?: string;
  readonly format: OutputFormat;
};

type TailCommand = {
  readonly kind: "tail";
  readonly logPath: string;
  readonly lines: number;
};

type McpToolsCommand = {
  readonly kind: "mcp-tools";
  readonly format: OutputFormat;
};

type McpToolCommand = {
  readonly kind: "mcp-tool";
  readonly name: string;
  readonly argsJson?: string;
  readonly argsFile?: string;
  readonly format: OutputFormat;
};

type McpResourcesCommand = {
  readonly kind: "mcp-resources";
  readonly format: OutputFormat;
};

type McpResourceCommand = {
  readonly kind: "mcp-resource";
  readonly uri: string;
  readonly format: OutputFormat;
};

type McpPromptsCommand = {
  readonly kind: "mcp-prompts";
  readonly format: OutputFormat;
};

type McpPromptCommand = {
  readonly kind: "mcp-prompt";
  readonly name: string;
  readonly argsJson?: string;
  readonly argsFile?: string;
  readonly format: OutputFormat;
};

type ControlDoctorCommand = {
  readonly kind: "control-doctor";
  readonly format: OutputFormat;
};

type ControllerSuperviseCommand = {
  readonly kind: "controller-supervise";
  readonly args: Record<string, unknown>;
  readonly statusIntervalMs: number;
  readonly format: OutputFormat;
};

type ProjectControlOperationRunCommand = {
  readonly kind: "project-control-operation-run";
  readonly operationFilePath: string;
  readonly format: OutputFormat;
};

type HelpCommand = {
  readonly kind: "help";
};


export async function runCodexGoalCli(
  argv = process.argv.slice(2),
  io: CodexGoalCliIo = defaultIo,
): Promise<number> {
  try {
    const command = parseCodexGoalCliArgs(argv, io);
    if (command.kind === "help") {
      io.writeStdout(usage());
      return 0;
    }
    if (command.kind === "status") {
      writeJsonOrText(command.format, await collectCodexGoalStatus(command), io);
      return 0;
    }
    if (command.kind === "doctor") {
      const result = await doctorCodexGoal(command);
      writeJsonOrText(command.format, result, io);
      return result.ok ? 0 : 1;
    }
    if (command.kind === "tail") {
      io.writeStdout(await tailCodexGoalLog(command.logPath, command.lines));
      return 0;
    }
    if (command.kind === "relay-events") {
      return runCodexGoalRelayEventsCommand(command, io);
    }
    if (command.kind === "mcp-tools") {
      writeJsonOrText(command.format, await listCodexGoalMcpTools(), io);
      return 0;
    }
    if (command.kind === "mcp-tool") {
      const oneShotGuard = oneShotCodexGoalMcpToolGuard(command.name);
      if (oneShotGuard !== undefined) {
        writeJsonOrText(command.format, oneShotGuard, io);
        return 1;
      }
      writeJsonOrText(
        command.format,
        await callCodexGoalMcpTool({
          name: command.name,
          args: await readJsonArgs(command, io),
        }),
        io,
      );
      return 0;
    }
    if (command.kind === "mcp-resources") {
      writeJsonOrText(command.format, await listCodexGoalMcpResources(), io);
      return 0;
    }
    if (command.kind === "mcp-resource") {
      writeJsonOrText(
        command.format,
        await readCodexGoalMcpResource({ uri: command.uri }),
        io,
      );
      return 0;
    }
    if (command.kind === "mcp-prompts") {
      writeJsonOrText(command.format, await listCodexGoalMcpPrompts(), io);
      return 0;
    }
    if (command.kind === "mcp-prompt") {
      writeJsonOrText(
        command.format,
        await getCodexGoalMcpPrompt({
          name: command.name,
          args: await readJsonArgs(command, io),
        }),
        io,
      );
      return 0;
    }
    if (command.kind === "control-doctor") {
      const result = await doctorCodexGoalControlSurface();
      writeJsonOrText(command.format, result, io);
      return result.ok ? 0 : 1;
    }
    if (command.kind === "controller-supervise") {
      const abortController = new AbortController();
      const onSignal = () => abortController.abort();
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        const result = await superviseCodexGoalProjectController({
          args: command.args,
          statusIntervalMs: command.statusIntervalMs,
          signal: abortController.signal,
          onEvent: (event) => {
            if (command.format === "json") {
              io.writeStdout(`${JSON.stringify(event)}\n`);
              return;
            }
            io.writeStdout(`${event.type} ${JSON.stringify(event.result)}\n`);
          },
        });
        return result.ok ? 0 : 1;
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
    }
    if (command.kind === "project-control-operation-run") {
      const result = await runProjectControlOperationFile({
        operationFilePath: command.operationFilePath,
        invokeTool: (name, args) =>
          callCodexGoalMcpTool({
            name,
            args: args as Record<string, unknown>,
          }),
      });
      writeJsonOrText(command.format, result, io);
      return result.ok ? 0 : 1;
    }
    if (command.tmuxSession) {
      const tmuxCommand = buildTmuxCommand(command);
      if (command.dryRun || command.printCommand) {
        io.writeStdout(`${tmuxCommand.preview}\n`);
        return 0;
      }
      await assertRunCommandProjectControlAllowed(command);
      await upsertRunCommandManifest(command);
      await startCodexGoalTmux(cliLaunchInput(command));
      io.writeStdout(
        `started ${command.tmuxSession} for ${command.config.taskId}\n`,
      );
      return 0;
    }
    if (command.dryRun || command.printCommand) {
      io.writeStdout(`${buildNoTmuxShellCommand(command)}\n`);
      return 0;
    }
    await assertRunCommandProjectControlAllowed(command);
    await upsertRunCommandManifest(command);
    const result = await runCodexGoal(command.config);
    writeJsonOrText(command.format, result, io);
    return result.status === "completed" ? 0 : 1;
  } catch (error) {
    if (isBrokenPipeError(error)) return 0;
    try {
      io.writeStderr(`${error instanceof Error ? error.message : "codex goal failed"}\n`);
    } catch (stderrError) {
      if (isBrokenPipeError(stderrError)) return 0;
      throw stderrError;
    }
    return 2;
  }
}

function isBrokenPipeError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.code === "EPIPE" || error.errno === -32;
}

function installBrokenPipeHandlers(): void {
  const onStreamError = (error: Error): void => {
    if (isBrokenPipeError(error)) {
      process.exit(0);
    }
    throw error;
  };
  process.stdout.on("error", onStreamError);
  process.stderr.on("error", onStreamError);
}

export function parseCodexGoalCliArgs(
  argv: readonly string[],
  io: CodexGoalCliIo = defaultIo,
): CodexGoalCliCommand {
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
  if (commandName === "relay-events") {
    return parseCodexGoalRelayEventsCommand(rest, io);
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
  if (
    commandName === "controller-supervise" ||
    commandName === "project-controller-supervise"
  ) {
    return parseControllerSupervise(rest, io);
  }
  if (commandName === "project-control-operation-run") {
    return parseProjectControlOperationRun(rest, io);
  }
  const shortcut = parseMcpShortcut(commandName, rest, io);
  if (shortcut) return shortcut;
  throw new Error(`unknown command: ${commandName}`);
}

export function buildTmuxCommand(command: RunCommand): {
  readonly args: readonly string[];
  readonly preview: string;
} {
  return buildCodexGoalTmuxCommand(cliLaunchInput(command));
}

export function buildNoTmuxShellCommand(command: RunCommand): string {
  return buildCodexGoalNoTmuxCommand(cliLaunchInput(command));
}

export async function upsertRunCommandManifest(command: RunCommand) {
  if (!command.registryRootDir) return undefined;
  return upsertCodexGoalLaunchManifest({
    registryRootDir: command.registryRootDir,
    launch: cliLaunchInput(command),
    ...(command.registryMetadata ? { metadata: command.registryMetadata } : {}),
  });
}

async function assertRunCommandProjectControlAllowed(command: RunCommand): Promise<void> {
  const jobId = command.config.jobId ?? command.config.taskId;
  if (
    command.config.sourceEnv?.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START === "1" &&
    command.config.accessBoundary !== AccessBoundary.ProjectScopedControl
  ) {
    return;
  }
  const denial = command.registryRootDir === undefined
    ? projectControlGenericToolDenial({
        accessBoundary: command.config.accessBoundary,
        projectAccessScope: command.config.projectAccessScope,
        jobId,
        requiredTool: "codex_goal_project_start",
      })
    : await projectControlGenericScopeDenial({
        registryRootDir: command.registryRootDir,
        jobId,
        workspacePath: command.config.workspacePath,
        accessBoundary: command.config.accessBoundary,
        projectAccessScope: command.config.projectAccessScope,
        requiredTool: "codex_goal_project_start",
      });
  if (!denial) return;
  throw new Error(
    [
      denial.reason,
      `requiredTool=${denial.requiredTool}`,
      denial.controllerJobId ? `controllerJobId=${denial.controllerJobId}` : undefined,
      denial.safeMessage,
    ].filter((part): part is string => part !== undefined).join("; "),
  );
}

function cliLaunchInput(command: RunCommand) {
  return {
    config: command.config,
    ...(command.tmuxSession ? { tmuxSession: command.tmuxSession } : {}),
    cwd: command.cwd,
    logPath: command.logPath,
    format: command.format,
    cliCommand: [execPath, currentCliPath()],
  } as const;
}

function parseRun(
  argv: readonly string[],
  io: CodexGoalCliIo,
): RunCommand {
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
  const registryRootDir = option(values, env, "--registry-root", [
    "SUBSCRIPTION_RUNTIME_CODEX_GOAL_REGISTRY_ROOT",
    "CODEX_GOAL_REGISTRY_ROOT",
  ]);
  const registryMetadata = registryMetadataFromFlags(values);
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
    ...(registryRootDir
      ? { registryRootDir: resolvePath(io.cwd(), registryRootDir) }
      : {}),
    ...(registryMetadata ? { registryMetadata } : {}),
  };
}

function parseDoctor(
  argv: readonly string[],
  io: CodexGoalCliIo,
): DoctorCommand {
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

function parseStatus(
  argv: readonly string[],
  io: CodexGoalCliIo,
): StatusCommand {
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

function parseTail(
  argv: readonly string[],
  io: CodexGoalCliIo,
): TailCommand {
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
  if (!logPath) throw new Error("--log or --job-root with --task-id is required");
  return {
    kind: "tail",
    logPath,
    lines: parsePositiveInteger(option(values, env, "--lines", []) ?? "100", "--lines"),
  };
}

function parseMcpTools(
  argv: readonly string[],
  io: CodexGoalCliIo,
): McpToolsCommand {
  const values = parseFlags(argv);
  return {
    kind: "mcp-tools",
    format: outputFormatFromFlags(values, io.env()),
  };
}

function parseMcpTool(
  argv: readonly string[],
  io: CodexGoalCliIo,
): McpToolCommand {
  const name = argv[0];
  if (!name || name.startsWith("--")) throw new Error("tool name is required");
  const values = parseFlags(argv.slice(1));
  return {
    kind: "mcp-tool",
    name,
    ...jsonArgsSource(values),
    format: outputFormatFromFlags(values, io.env()),
  };
}

function parseMcpResources(
  argv: readonly string[],
  io: CodexGoalCliIo,
): McpResourcesCommand {
  const values = parseFlags(argv);
  return {
    kind: "mcp-resources",
    format: outputFormatFromFlags(values, io.env()),
  };
}

function parseMcpResource(
  argv: readonly string[],
  io: CodexGoalCliIo,
): McpResourceCommand {
  const uri = argv[0];
  if (!uri || uri.startsWith("--")) throw new Error("resource uri is required");
  const values = parseFlags(argv.slice(1));
  return {
    kind: "mcp-resource",
    uri,
    format: outputFormatFromFlags(values, io.env()),
  };
}

function parseMcpPrompts(
  argv: readonly string[],
  io: CodexGoalCliIo,
): McpPromptsCommand {
  const values = parseFlags(argv);
  return {
    kind: "mcp-prompts",
    format: outputFormatFromFlags(values, io.env()),
  };
}

function parseMcpPrompt(
  argv: readonly string[],
  io: CodexGoalCliIo,
): McpPromptCommand {
  const name = argv[0];
  if (!name || name.startsWith("--")) throw new Error("prompt name is required");
  const values = parseFlags(argv.slice(1));
  return {
    kind: "mcp-prompt",
    name,
    ...jsonArgsSource(values),
    format: outputFormatFromFlags(values, io.env()),
  };
}

function parseControlDoctor(
  argv: readonly string[],
  io: CodexGoalCliIo,
): ControlDoctorCommand {
  const values = parseFlags(argv);
  return {
    kind: "control-doctor",
    format: outputFormatFromFlags(values, io.env()),
  };
}

function parseControllerSupervise(
  argv: readonly string[],
  io: CodexGoalCliIo,
): ControllerSuperviseCommand {
  const values = parseFlags(argv);
  const env = io.env();
  const registryRootDir = option(values, env, "--registry-root", [
    "SUBSCRIPTION_RUNTIME_CODEX_GOAL_REGISTRY_ROOT",
    "CODEX_GOAL_REGISTRY_ROOT",
  ]);
  const stateDir = option(values, env, "--state-dir", []);
  const mcpCwd = option(values, env, "--mcp-cwd", []);
  const args: Record<string, unknown> = {
    controllerJobId: requiredOption(values, env, "--controller-job-id", [
      "SUBSCRIPTION_RUNTIME_CONTROLLER_JOB_ID",
    ]),
    ...(registryRootDir
      ? { registryRootDir: resolvePath(io.cwd(), registryRootDir) }
      : {}),
    ...(option(values, env, "--provider", []) ? {
      providerKind: option(values, env, "--provider", []),
    } : {}),
    ...(stateDir ? { stateDir: resolvePath(io.cwd(), stateDir) } : {}),
    ...(option(values, env, "--session-artifact-path", []) ? {
      sessionArtifactPath: option(values, env, "--session-artifact-path", []),
    } : {}),
    ...(option(values, env, "--claude-path", []) ? {
      claudePath: option(values, env, "--claude-path", []),
    } : {}),
    ...(option(values, env, "--mcp-server-name", []) ? {
      mcpServerName: option(values, env, "--mcp-server-name", []),
    } : {}),
    ...(option(values, env, "--mcp-command", []) ? {
      mcpCommand: option(values, env, "--mcp-command", []),
    } : {}),
    ...(option(values, env, "--mcp-args", []) ? {
      mcpArgs: splitCsv(option(values, env, "--mcp-args", []) as string),
    } : {}),
    ...(mcpCwd ? { mcpCwd: resolvePath(io.cwd(), mcpCwd) } : {}),
    ...(option(values, env, "--raw-shell-mode", []) ? {
      rawShellMode: option(values, env, "--raw-shell-mode", []),
    } : {}),
    ...optionalNumberArg(values, "--max-goal-turns", "maxGoalTurns"),
  };
  return {
    kind: "controller-supervise",
    args,
    statusIntervalMs: parseOptionalPositiveInteger(
      option(values, env, "--status-interval-ms", []),
      "--status-interval-ms",
    ) ?? 60_000,
    format: outputFormatFromFlags(values, env),
  };
}

function parseProjectControlOperationRun(
  argv: readonly string[],
  io: CodexGoalCliIo,
): ProjectControlOperationRunCommand {
  const values = parseFlags(argv);
  return {
    kind: "project-control-operation-run",
    operationFilePath: resolvePath(
      io.cwd(),
      requiredOption(values, io.env(), "--operation-file", [
        "SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_OPERATION_FILE",
      ]),
    ),
    format: outputFormatFromFlags(values, io.env()),
  };
}

function parseMcpShortcut(
  commandName: string,
  argv: readonly string[],
  io: CodexGoalCliIo,
): McpToolCommand | undefined {
  return parseCodexGoalCliMcpShortcut(commandName, argv, io);
}

function registryMetadataFromFlags(
  values: ParsedFlags,
): CodexGoalLaunchManifestMetadata | undefined {
  const description =
    values.values.get("--description") ?? values.values.get("--registry-description");
  const tags = splitCsv(
    values.values.get("--tags") ?? values.values.get("--registry-tags") ?? "",
  );
  if (!description && tags.length === 0) return undefined;
  return {
    ...(description ? { description } : {}),
    ...(tags.length ? { tags } : {}),
  };
}

function optionalNumberArg(
  values: ParsedFlags,
  flagName: string,
  key: string,
): Record<string, unknown> {
  const value = values.values.get(flagName);
  return value === undefined
    ? {}
    : { [key]: parsePositiveInteger(value, flagName) };
}

function jsonArgsSource(values: ParsedFlags): {
  readonly argsJson?: string;
  readonly argsFile?: string;
} {
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

async function readJsonArgs(
  command: Pick<McpToolCommand | McpPromptCommand, "argsJson" | "argsFile">,
  io: CodexGoalCliIo,
): Promise<Record<string, unknown>> {
  if (command.argsJson) return parseJsonObject(command.argsJson, "--args-json");
  if (command.argsFile) {
    const path = resolvePath(io.cwd(), command.argsFile);
    return parseJsonObject(await readFile(path, "utf8"), "--args-file");
  }
  return {};
}

function parseJsonObject(value: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${source} must be valid JSON: ${
      error instanceof Error ? error.message : "parse failed"
    }`);
  }
  if (!isRecord(parsed)) throw new Error(`${source} must be a JSON object`);
  return parsed;
}

function currentCliPath(): string {
  return fileURLToPath(import.meta.url);
}

function usage(): string {
  return `usage:
  subscription-runtime-codex-goal run --job-root <dir> --workspace <dir> --prompt <file> --task-id <id> --accounts account-a,account-b [--tmux-session <name>] [--registry-root <dir>]
  subscription-runtime-codex-goal status --job-root <dir> --task-id <id> [--workspace <dir>] [--tmux-session <name>]
  subscription-runtime-codex-goal doctor --job-root <dir> --workspace <dir> --prompt <file> --task-id <id> --accounts account-a,account-b
  subscription-runtime-codex-goal tail --job-root <dir> --task-id <id> [--lines 100]
  subscription-runtime-codex-goal doctor-control
  subscription-runtime-codex-goal project-control-operation-run --operation-file <file> [--json|--text]
  subscription-runtime-codex-goal overview [--registry-root <dir>] [--job-prefix <prefix>]
  subscription-runtime-codex-goal run-watch [jobId] [--provider codex|claude|agent-task] [--registry-root <dir>] [--state-root <dir>] [--include-log-tail] [--include-changed-files] [--json|--text]
  subscription-runtime-codex-goal events [jobId] [--provider codex|claude|local|agent-task|unknown] [--registry-root <dir>] [--event-root <dir>] [--cursor <cursor>] [--type <event-type>] [--limit 100]
  subscription-runtime-codex-goal state <jobId> [--provider codex|claude|local|agent-task|unknown] [--registry-root <dir>] [--event-root <dir>]
  subscription-runtime-codex-goal event-compaction-plan [--registry-root <dir>] [--event-root <dir>] [--compact-delivered] [--keep-latest-per-run 100] [--drop-invalid-lines]
  subscription-runtime-codex-goal event-compact --confirm [--registry-root <dir>] [--event-root <dir>] [--compact-delivered] [--keep-latest-per-run 100] [--drop-invalid-lines] [--force]
  subscription-runtime-codex-goal project-events [jobId] [--provider codex] [--registry-root <dir>] [--event-root <dir>] [--host-id <id>] [--include-changed-files]
  subscription-runtime-codex-goal relay-events --event-root <dir> --consumer-id <id> [--publisher stdout|webhook] [--webhook-url <url>] [--limit 100] [--run-id <id>] [--type run.completed]
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
  subscription-runtime-codex-goal reconcile-result <jobId> [--force] [--registry-root <dir>]
  subscription-runtime-codex-goal relogin <jobId> [account] [--registry-root <dir>]
  subscription-runtime-codex-goal continue-job <jobId> --confirm [--registry-root <dir>]
  subscription-runtime-codex-goal recover-job <jobId> --confirm [--registry-root <dir>]
  subscription-runtime-codex-goal stop-job <jobId> --confirm [--registry-root <dir>]
  subscription-runtime-codex-goal maintenance-pause-job <jobId> --confirm [--reason resize] [--registry-root <dir>]
  subscription-runtime-codex-goal controller-supervise --controller-job-id <id> [--registry-root <dir>] [--provider codex|claude] [--status-interval-ms 60000]
  subscription-runtime-codex-goal tools
  subscription-runtime-codex-goal tool <mcp_tool_name> [--args-json '{"jobId":"..."}' | --args-file args.json]
  subscription-runtime-codex-goal resources
  subscription-runtime-codex-goal resource <mcp_resource_uri>
  subscription-runtime-codex-goal prompts
  subscription-runtime-codex-goal prompt <mcp_prompt_name> [--args-json '{"jobId":"..."}' | --args-file args.json]

defaults:
  --model gpt-5.5 --effort high --service-tier default --execution-engine app-server-goal --timeout 72h --app-server-startup-timeout-ms 120000 --max-account-cycles 5
  --codex-goal-objective <text> sets a short app-server goal objective, max 4000 chars. Keep long instructions in --prompt.

escape hatches:
  --dry-run, --print-command, --no-tmux, --no-require-git-workspace

registry:
  pass --registry-root to write or update job.json before starting the worker.
  optional --description and --tags annotate the manifest.

MCP fallback:
  use tool/resources/prompts when native MCP tools are unavailable in a Codex thread.
  These commands call the same in-process MCP server via the SDK, so the API surface matches MCP.
  Shortcuts like overview, run-watch, events, project-events, reconcile-preview, brief, decision, handoff, accounts, control-*, continue-job, recover-job and stop-job are thin wrappers around MCP tools.
`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const defaultIo: CodexGoalCliIo = {
  writeStdout(chunk: string): void {
    process.stdout.write(chunk);
  },
  writeStderr(chunk: string): void {
    process.stderr.write(chunk);
  },
  cwd(): string {
    return process.cwd();
  },
  env(): Readonly<Record<string, string | undefined>> {
    return process.env;
  },
};

if (await isMainModule()) {
  installBrokenPipeHandlers();
  process.exitCode = await runCodexGoalCli();
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;
  try {
    return (await realpath(currentCliPath())) === (await realpath(process.argv[1]));
  } catch {
    return currentCliPath() === process.argv[1];
  }
}
