#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import {
  LocalFileRunEventDeliveryCursorStore,
  LocalFileRunEventStore,
} from "@vioxen/subscription-runtime/store-local-file";
import {
  RunEventCompactionSafetyMode,
  RunEventRelayService,
  RunEventType,
  isRunEventType,
} from "@vioxen/subscription-runtime/worker-core";
import {
  StdoutNdjsonRunEventPublisher,
  WebhookRunEventPublisher,
} from "@vioxen/subscription-runtime/worker-local";
import {
  codexGoalAccountSlots,
  runCodexGoal,
  type CodexGoalRunConfig,
} from "./codex-goal-runner";
import {
  assertCodexGoalProviderSandboxModeAllowed,
  optionalCodexGoalProviderSandboxMode,
  parseCodexGoalEditMode,
} from "./codex-goal-control-modes";
import {
  optionalCodexGoalAccessBoundary,
  optionalCodexGoalNetworkAccess,
  parseCodexGoalProjectAccessScopeJson,
} from "./codex-goal-access-plan";
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
} from "./codex-goal-mcp-client";
import {
  upsertCodexGoalLaunchManifest,
  type CodexGoalLaunchManifestMetadata,
} from "./codex-goal-launch-manifest";

type OutputFormat = "text" | "json";
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

type RelayEventsPublisherKind = "stdout" | "webhook";

type RelayEventsCommand = {
  readonly kind: "relay-events";
  readonly eventRootDir: string;
  readonly consumerId: string;
  readonly publisherKind: RelayEventsPublisherKind;
  readonly webhookUrl?: string;
  readonly webhookTimeoutMs?: number;
  readonly limit?: number;
  readonly runId?: string;
  readonly types?: readonly RunEventType[];
  readonly format: OutputFormat;
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

type HelpCommand = {
  readonly kind: "help";
};

export type CodexGoalCliIo = {
  writeStdout(chunk: string): void;
  writeStderr(chunk: string): void;
  cwd(): string;
  env(): Readonly<Record<string, string | undefined>>;
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
    if (command.kind === "relay-events") {
      const result = await relayEvents(command, io);
      if (command.publisherKind === "stdout" && command.format === "text") {
        return 0;
      }
      writeJsonOrText(command.format, result, io);
      return 0;
    }
    if (command.kind === "mcp-tools") {
      writeJsonOrText(command.format, await listCodexGoalMcpTools(), io);
      return 0;
    }
    if (command.kind === "mcp-tool") {
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
    if (command.tmuxSession) {
      const tmuxCommand = buildTmuxCommand(command);
      if (command.dryRun || command.printCommand) {
        io.writeStdout(`${tmuxCommand.preview}\n`);
        return 0;
      }
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
    await upsertRunCommandManifest(command);
    const result = await runCodexGoal(command.config);
    writeJsonOrText(command.format, result, io);
    return result.status === "completed" ? 0 : 1;
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : "codex goal failed"}\n`);
    return 2;
  }
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
    return parseRelayEvents(rest, io);
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

function parseRelayEvents(
  argv: readonly string[],
  io: CodexGoalCliIo,
): RelayEventsCommand {
  const env = io.env();
  const values = parseFlags(argv);
  const publisherKind = relayEventsPublisherKind(
    option(values, env, "--publisher", [
      "SUBSCRIPTION_RUNTIME_RUN_EVENT_PUBLISHER",
    ]) ?? "stdout",
  );
  const eventRootDir = resolvePath(
    io.cwd(),
    requiredOption(values, env, "--event-root", [
      "SUBSCRIPTION_RUNTIME_RUN_EVENT_ROOT",
    ]),
  );
  const webhookUrl = option(values, env, "--webhook-url", [
    "SUBSCRIPTION_RUNTIME_RUN_EVENT_WEBHOOK_URL",
  ]);
  if (publisherKind === "webhook" && !webhookUrl) {
    throw new Error("--webhook-url is required for webhook publisher");
  }
  const format = outputFormatFromFlags(values, env, "text");
  if (publisherKind === "stdout" && format === "json") {
    throw new Error("stdout relay publisher writes NDJSON events; use --text");
  }
  const webhookTimeoutMs = parseOptionalPositiveInteger(
    option(values, env, "--webhook-timeout-ms", [
      "SUBSCRIPTION_RUNTIME_RUN_EVENT_WEBHOOK_TIMEOUT_MS",
    ]),
    "--webhook-timeout-ms",
  );
  const limit = parseOptionalPositiveInteger(
    option(values, env, "--limit", []),
    "--limit",
  );
  const runId = option(values, env, "--run-id", []);
  const types = relayEventTypes(option(values, env, "--type", []));
  return {
    kind: "relay-events",
    eventRootDir,
    consumerId: requiredOption(values, env, "--consumer-id", [
      "SUBSCRIPTION_RUNTIME_RUN_EVENT_CONSUMER_ID",
    ]),
    publisherKind,
    ...(webhookUrl === undefined ? {} : { webhookUrl }),
    ...(webhookTimeoutMs === undefined ? {} : { webhookTimeoutMs }),
    ...(limit === undefined ? {} : { limit }),
    ...(runId === undefined ? {} : { runId }),
    ...(types === undefined ? {} : { types }),
    format,
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

function parseMcpShortcut(
  commandName: string,
  argv: readonly string[],
  io: CodexGoalCliIo,
): McpToolCommand | undefined {
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
        ...optionalStringArg(values, "--job-prefix", "jobIdPrefix"),
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
  if (
    commandName === "events" ||
    commandName === "run-events" ||
    commandName === "agent-run-events"
  ) {
    const jobId = argv[0]?.startsWith("--") ? undefined : argv[0];
    const values = parseFlags(jobId ? argv.slice(1) : argv);
    return {
      kind: "mcp-tool",
      name: "agent_run_events",
      argsJson: JSON.stringify({
        providerKind: values.values.get("--provider") ??
          values.values.get("--provider-kind") ??
          "codex",
        ...(jobId ? { jobId } : {}),
        ...registryArg(values),
        ...optionalStringArg(values, "--event-root", "eventRootDir"),
        ...optionalStringArg(values, "--cursor", "cursor"),
        ...optionalStringArg(values, "--type", "type"),
        ...optionalNumberArg(values, "--limit", "limit"),
      }),
      format: outputFormatFromFlags(values, io.env()),
    };
  }
  if (
    commandName === "state" ||
    commandName === "run-state" ||
    commandName === "agent-run-state"
  ) {
    const jobId = argv[0]?.startsWith("--") ? undefined : argv[0];
    const values = parseFlags(jobId ? argv.slice(1) : argv);
    return {
      kind: "mcp-tool",
      name: "agent_run_state",
      argsJson: JSON.stringify({
        providerKind: values.values.get("--provider") ??
          values.values.get("--provider-kind") ??
          "codex",
        ...(jobId ? { jobId } : {}),
        ...registryArg(values),
        ...optionalStringArg(values, "--event-root", "eventRootDir"),
      }),
      format: outputFormatFromFlags(values, io.env()),
    };
  }
  if (
    commandName === "event-compaction-plan" ||
    commandName === "events-compaction-plan" ||
    commandName === "run-event-compaction-plan"
  ) {
    const values = parseFlags(argv);
    return {
      kind: "mcp-tool",
      name: "agent_run_event_compaction_plan",
      argsJson: JSON.stringify({
        ...registryArg(values),
        ...optionalStringArg(values, "--event-root", "eventRootDir"),
        ...runEventRetentionPolicyArgs(values),
      }),
      format: outputFormatFromFlags(values, io.env()),
    };
  }
  if (
    commandName === "event-compact" ||
    commandName === "events-compact" ||
    commandName === "run-event-compact"
  ) {
    const values = parseFlags(argv);
    return {
      kind: "mcp-tool",
      name: "agent_run_event_compact",
      argsJson: JSON.stringify({
        ...registryArg(values),
        ...optionalStringArg(values, "--event-root", "eventRootDir"),
        ...runEventRetentionPolicyArgs(values),
        ...(flag(values, "--confirm") ? { confirmCompact: true } : {}),
      }),
      format: outputFormatFromFlags(values, io.env()),
    };
  }
  if (
    commandName === "project-events" ||
    commandName === "run-project-events" ||
    commandName === "agent-run-project-events"
  ) {
    const jobId = argv[0]?.startsWith("--") ? undefined : argv[0];
    const values = parseFlags(jobId ? argv.slice(1) : argv);
    return {
      kind: "mcp-tool",
      name: "agent_run_project_events",
      argsJson: JSON.stringify({
        providerKind: values.values.get("--provider") ??
          values.values.get("--provider-kind") ??
          "codex",
        ...(jobId ? { jobId } : {}),
        ...registryArg(values),
        ...optionalStringArg(values, "--event-root", "eventRootDir"),
        ...optionalStringArg(values, "--host-id", "hostId"),
        ...optionalNumberArg(values, "--stale-after-ms", "staleAfterMs"),
        ...optionalNumberArg(values, "--tail-lines", "tailLines"),
        ...optionalNumberArg(values, "--limit", "limit"),
        ...(flag(values, "--include-changed-files") || flag(values, "--changed-files")
          ? { includeChangedFiles: true }
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
  if (commandName === "reconcile-result") {
    return parseJobShortcut({
      kind: "reconcile-result",
      tool: "codex_goal_reconcile_result",
      argv,
      io,
      extraArgs: (values) => ({
        ...(flag(values, "--force") ? { forceWrite: true } : {}),
        ...(flag(values, "--no-preserve-patch") ? { preservePatch: false } : {}),
        ...optionalNumberArg(values, "--stale-after-ms", "staleAfterMs"),
        ...optionalNumberArg(values, "--tail-lines", "tailLines"),
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
  if (commandName === "maintenance-pause-job") {
    return parseJobShortcut({
      kind: "maintenance-pause-job",
      tool: "codex_goal_maintenance_pause",
      argv,
      io,
      extraArgs: (values) => ({
        ...(flag(values, "--confirm") ? { confirmPause: true } : {}),
        ...(flag(values, "--force") ? { forcePause: true } : {}),
        ...(values.values.get("--reason")
          ? { reason: values.values.get("--reason") as string }
          : {}),
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
          ? { note: values.values.get("--note") as string }
          : {}),
      }),
    });
  }
  if (commandName === "relogin") {
    const jobId = argv[0];
    if (!jobId || jobId.startsWith("--")) throw new Error("jobId is required");
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

function parseJobShortcut(input: {
  readonly kind: string;
  readonly tool: string;
  readonly argv: readonly string[];
  readonly io: CodexGoalCliIo;
  readonly extraArgs?: (values: ParsedFlags) => Record<string, unknown>;
}): McpToolCommand {
  const jobId = input.argv[0];
  if (!jobId || jobId.startsWith("--")) throw new Error("jobId is required");
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

function registryArg(values: ParsedFlags): Record<string, unknown> {
  const registryRootDir = values.values.get("--registry-root");
  return registryRootDir ? { registryRootDir } : {};
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

function callerArgs(values: ParsedFlags): Record<string, unknown> {
  const callerKind =
    values.values.get("--caller-kind") ?? values.values.get("--caller-actor");
  const callerId = values.values.get("--caller-id");
  return {
    ...(callerKind ? { callerKind } : {}),
    ...(callerId ? { callerId } : {}),
  };
}

function positiveIntegerArg(
  values: ParsedFlags,
  name: string,
): Record<string, unknown> {
  const value = values.values.get(name);
  if (value === undefined) return {};
  return { [camelCaseFlagName(name)]: parsePositiveInteger(value, name) };
}

function camelCaseFlagName(name: string): string {
  return name
    .replace(/^--/, "")
    .replace(/-([a-z])/g, (_, character: string) => character.toUpperCase());
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

function optionalStringArg(
  values: ParsedFlags,
  flagName: string,
  key: string,
): Record<string, unknown> {
  const value = values.values.get(flagName);
  return value === undefined || value.trim() === "" ? {} : { [key]: value };
}

function runEventRetentionPolicyArgs(values: ParsedFlags): Record<string, unknown> {
  return {
    ...optionalStringArg(values, "--keep-after", "keepEventsAfter"),
    ...optionalNumberArg(values, "--keep-latest-per-run", "keepLatestEventsPerRun"),
    ...(flag(values, "--compact-delivered") ? { compactDeliveredEvents: true } : {}),
    ...(flag(values, "--drop-invalid-lines") ? { dropInvalidLines: true } : {}),
    ...(flag(values, "--force")
      ? { safetyMode: RunEventCompactionSafetyMode.Force }
      : {}),
  };
}

function requiredFlagValue(values: ParsedFlags, flagName: string): string {
  const value = values.values.get(flagName);
  if (!value) throw new Error(`${flagName} is required`);
  return value;
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

function runConfigFromFlags(
  values: ParsedFlags,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  jobRootDir: string,
  taskId: string,
): CodexGoalRunConfig {
  const authRootDir = resolvePath(
    cwd,
    option(values, env, "--auth-root", [
      "SUBSCRIPTION_RUNTIME_CODEX_AUTH_ROOT",
    ]) ?? "~/.cache/subscription-runtime/live-codex-auth",
  );
  const accounts = codexGoalAccountSlots(
    splitCsv(
      requiredOption(values, env, "--accounts", ["CODEX_ACCOUNTS"]),
    ),
  );
  const reasoningEffort = (option(values, env, "--effort", [
    "CODEX_REASONING_EFFORT",
  ]) ?? "high") as CodexGoalRunConfig["reasoningEffort"];
  const serviceTier = (option(values, env, "--service-tier", [
    "CODEX_SERVICE_TIER",
  ]) ?? "fast") as CodexGoalRunConfig["serviceTier"];
  const executionEngine = (option(values, env, "--execution-engine", [
    "CODEX_EXECUTION_ENGINE",
  ]) ?? "app-server-goal") as CodexGoalRunConfig["executionEngine"];
  const staleLockMs = parseOptionalPositiveInteger(
    option(values, env, "--stale-lock-ms", []),
    "--stale-lock-ms",
  );
  const editModeFlag = option(values, env, "--edit-mode", []);
  const legacyPermissionModeFlag = option(values, env, "--permission-mode", []);
  const editMode = parseCodexGoalEditMode(
    editModeFlag ?? legacyPermissionModeFlag ?? "allow-edits",
    editModeFlag === undefined && legacyPermissionModeFlag !== undefined
      ? "--permission-mode"
      : "--edit-mode",
  );
  const providerSandboxMode = optionalCodexGoalProviderSandboxMode(
    option(values, env, "--provider-sandbox-mode", []),
    "--provider-sandbox-mode",
  );
  const workerReportMode = parseCodexGoalWorkerReportMode(
    option(values, env, "--worker-report-mode", [
      "SUBSCRIPTION_RUNTIME_WORKER_REPORT_MODE",
    ]),
  );
  assertCodexGoalProviderSandboxModeAllowed({
    editMode,
    providerSandboxMode,
    fieldName: "--provider-sandbox-mode",
  });
  const accessBoundary = optionalCodexGoalAccessBoundary(
    option(values, env, "--access-boundary", [
      "SUBSCRIPTION_RUNTIME_ACCESS_BOUNDARY",
    ]),
    "--access-boundary",
  );
  const projectAccessScope = parseCodexGoalProjectAccessScopeJson(
    option(values, env, "--project-access-scope-json", [
      "SUBSCRIPTION_RUNTIME_PROJECT_ACCESS_SCOPE_JSON",
    ]),
    "--project-access-scope-json",
  );
  const networkAccess = optionalCodexGoalNetworkAccess(
    option(values, env, "--network-access", [
      "SUBSCRIPTION_RUNTIME_NETWORK_ACCESS",
    ]),
    "--network-access",
  );
  const resolvedJobRootDir = resolvePath(cwd, jobRootDir);
  const sourceEnv = {
    ...env,
    SUBSCRIPTION_RUNTIME_JOB_ROOT: resolvedJobRootDir,
    SUBSCRIPTION_RUNTIME_TMPDIR:
      env.SUBSCRIPTION_RUNTIME_TMPDIR ?? join(resolvedJobRootDir, "tmp"),
    TMPDIR: env.TMPDIR ?? join(resolvedJobRootDir, "tmp"),
  } as const;
  const config: CodexGoalRunConfig = {
    ...(option(values, env, "--job-id", ["SUBSCRIPTION_RUNTIME_JOB_ID"]) === undefined
      ? {}
      : {
          jobId: option(values, env, "--job-id", [
            "SUBSCRIPTION_RUNTIME_JOB_ID",
          ]) as string,
        }),
    jobRootDir: resolvedJobRootDir,
    authRootDir,
    workspacePath: resolvePath(
      cwd,
      requiredOption(values, env, "--workspace", [
        "SUBSCRIPTION_RUNTIME_WORKSPACE_PATH",
        "MEMO_STACK_GOAL_WORKSPACE_PATH",
      ]),
    ),
    promptPath: resolvePath(
      cwd,
      requiredOption(values, env, "--prompt", [
        "SUBSCRIPTION_RUNTIME_PROMPT_PATH",
        "MEMO_STACK_GOAL_PROMPT_PATH",
      ]),
    ),
    taskId,
    accounts,
    outputPath: resolvePath(
      cwd,
      option(values, env, "--output", []) ??
        join(resolvePath(cwd, jobRootDir), `${taskId}.latest-result.json`),
    ),
    progressPath: resolvePath(
      cwd,
      option(values, env, "--progress", []) ??
        join(resolvePath(cwd, jobRootDir), `${taskId}.progress.json`),
    ),
    model: option(values, env, "--model", ["CODEX_MODEL"]) ?? "gpt-5.5",
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(executionEngine ? { executionEngine } : {}),
    codexBinaryPath: option(values, env, "--codex-binary", [
      "CODEX_BINARY_PATH",
    ]) ?? "codex",
    editMode,
    ...(providerSandboxMode === undefined ? {} : { providerSandboxMode }),
    ...(accessBoundary === undefined ? {} : { accessBoundary }),
    ...(projectAccessScope === undefined ? {} : { projectAccessScope }),
    allowDangerFullAccess: flag(values, "--allow-danger-full-access"),
    ...(networkAccess === undefined ? {} : { networkAccess }),
    taskTimeoutMs: parseOptionalPositiveInteger(
      option(values, env, "--timeout-ms", [
        "SUBSCRIPTION_RUNTIME_TASK_TIMEOUT_MS",
        "MEMO_STACK_GOAL_TASK_TIMEOUT_MS",
      ]),
      "--timeout-ms",
    ) ?? parseDurationMs(option(values, env, "--timeout", []) ?? "72h"),
    progressHeartbeatMs: parseOptionalPositiveInteger(
      option(values, env, "--progress-heartbeat-ms", [
        "SUBSCRIPTION_RUNTIME_PROGRESS_HEARTBEAT_MS",
      ]),
      "--progress-heartbeat-ms",
    ) ?? 60_000,
    maxAccountCycles: parseOptionalPositiveInteger(
      option(values, env, "--max-account-cycles", [
        "SUBSCRIPTION_RUNTIME_MAX_ACCOUNT_CYCLES",
      ]),
      "--max-account-cycles",
    ) ?? 5,
    ...(staleLockMs === undefined ? {} : { staleLockMs }),
    allowDuplicateAccountIdentities: flag(values, "--allow-duplicate-accounts"),
    requireGitWorkspace: !flag(values, "--no-require-git-workspace"),
    prewarmOnStart: flag(values, "--prewarm"),
    ...(workerReportMode === undefined ? {} : { workerReportMode }),
    sourceEnv,
  };
  const stateRoot = option(values, env, "--state-root", []);
  return stateRoot
    ? { ...config, stateRootDir: resolvePath(cwd, stateRoot) }
    : config;
}

async function printStatus(
  command: StatusCommand,
  io: CodexGoalCliIo,
): Promise<void> {
  const status = await collectStatus(command);
  writeJsonOrText(command.format, status, io);
}

async function collectStatus(command: StatusCommand): Promise<{
  readonly tmuxAlive?: boolean;
  readonly resultExists?: boolean;
  readonly resultStatus?: string;
  readonly workspaceDirty?: boolean;
  readonly warnings: readonly string[];
}> {
  return collectCodexGoalStatus(command);
}

async function doctor(command: DoctorCommand): Promise<{
  readonly ok: boolean;
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly message: string }[];
}> {
  return doctorCodexGoal(command);
}

async function tailFile(path: string, lines: number): Promise<string> {
  return tailCodexGoalLog(path, lines);
}

async function relayEvents(command: RelayEventsCommand, io: CodexGoalCliIo) {
  const eventStore = new LocalFileRunEventStore({
    rootDir: command.eventRootDir,
  });
  const cursorStore = new LocalFileRunEventDeliveryCursorStore({
    rootDir: command.eventRootDir,
  });
  const publisher = command.publisherKind === "stdout"
    ? new StdoutNdjsonRunEventPublisher({
        write: (chunk) => io.writeStdout(chunk),
      })
    : new WebhookRunEventPublisher({
        endpointUrl: command.webhookUrl as string,
        ...(command.webhookTimeoutMs === undefined
          ? {}
          : { timeoutMs: command.webhookTimeoutMs }),
      });
  const service = new RunEventRelayService({
    eventStore,
    cursorStore,
    publisher,
  });
  const result = await service.relay({
    consumerId: command.consumerId,
    ...(command.limit === undefined ? {} : { limit: command.limit }),
    ...(command.runId === undefined ? {} : { runId: command.runId }),
    ...(command.types === undefined ? {} : { types: command.types }),
  });
  return {
    ok: result.warnings.length === 0,
    mode: "relay_events",
    eventRootDir: command.eventRootDir,
    publisherKind: command.publisherKind,
    ...result,
  };
}

type ParsedFlags = {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
};

function parseFlags(argv: readonly string[]): ParsedFlags {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") throw new Error(usage());
    if (!arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
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

function requiredOption(
  flags: ParsedFlags,
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  envNames: readonly string[],
): string {
  const value = option(flags, env, name, envNames);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function option(
  flags: ParsedFlags,
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  envNames: readonly string[],
): string | undefined {
  const value = flags.values.get(name);
  if (value !== undefined) return value;
  for (const envName of envNames) {
    const envValue = env[envName];
    if (envValue?.trim()) return envValue;
  }
  return undefined;
}

function flag(flags: ParsedFlags, name: string): boolean {
  return flags.flags.has(name);
}

function outputFormatFromFlags(
  flags: ParsedFlags,
  env: Readonly<Record<string, string | undefined>>,
  defaultFormat: OutputFormat = "json",
): OutputFormat {
  const explicitFormat = option(flags, env, "--format", []);
  const json = flag(flags, "--json");
  const text = flag(flags, "--text");
  if (json && text) throw new Error("use only one of --json or --text");
  if (explicitFormat && json && explicitFormat !== "json") {
    throw new Error("use only one of --format text or --json");
  }
  if (explicitFormat && text && explicitFormat !== "text") {
    throw new Error("use only one of --format json or --text");
  }
  if (json) return "json";
  if (text) return "text";
  return outputFormat(explicitFormat ?? defaultFormat);
}

function outputFormat(value: string): OutputFormat {
  if (value === "text" || value === "json") return value;
  throw new Error("--format must be text or json");
}

function relayEventsPublisherKind(value: string): RelayEventsPublisherKind {
  if (value === "stdout" || value === "webhook") return value;
  throw new Error("--publisher must be stdout or webhook");
}

function relayEventTypes(value: string | undefined): readonly RunEventType[] | undefined {
  if (value === undefined) return undefined;
  const types = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (types.length === 0) return undefined;
  return types.map((type) => {
    if (isRunEventType(type)) return type;
    throw new Error(`unsupported run event type: ${type}`);
  });
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  label: string,
): number | undefined {
  return value === undefined ? undefined : parsePositiveInteger(value, label);
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseDurationMs(value: string): number {
  const match = value.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) throw new Error("--timeout must look like 72h, 30m, 10s or 1000ms");
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return amount * multiplier;
}

function parseCodexGoalWorkerReportMode(
  value: string | undefined,
): CodexGoalRunConfig["workerReportMode"] | undefined {
  if (value === undefined) return undefined;
  if (value === "runtime-only" || value === "structured-output") return value;
  throw new Error("--worker-report-mode must be runtime-only or structured-output");
}

function splitCsv(value: string): readonly string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function resolvePath(cwd: string, value: string): string {
  const expanded = value.startsWith("~/")
    ? join(homedir(), value.slice(2))
    : value;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function pushOptional(args: string[], flagName: string, value: string | undefined): void {
  if (value === undefined) return;
  args.push(flagName, value);
}

function pushOptionalNumber(
  args: string[],
  flagName: string,
  value: number | undefined,
): void {
  if (value === undefined) return;
  args.push(flagName, String(value));
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function writeJsonOrText(
  format: OutputFormat,
  value: unknown,
  io: CodexGoalCliIo,
): void {
  if (format === "json") {
    io.writeStdout(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (isRecord(value) && "checks" in value && Array.isArray(value.checks)) {
    for (const check of value.checks) {
      if (!isRecord(check)) continue;
      io.writeStdout(
        `${check.ok ? "ok" : "fail"} ${String(check.name)} ${String(check.message)}\n`,
      );
    }
    return;
  }
  io.writeStdout(`${JSON.stringify(value)}\n`);
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
