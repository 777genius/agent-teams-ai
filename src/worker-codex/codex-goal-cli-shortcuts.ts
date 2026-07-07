import { RunEventCompactionSafetyMode } from "@vioxen/subscription-runtime/worker-core";
import {
  type CodexGoalCliIo,
  type OutputFormat,
  type ParsedFlags,
  flag,
  outputFormatFromFlags,
  parseFlags,
  parsePositiveInteger,
} from "./codex-goal-cli-support";

export type CodexGoalCliMcpToolCommand = {
  readonly kind: "mcp-tool";
  readonly name: string;
  readonly argsJson?: string;
  readonly argsFile?: string;
  readonly format: OutputFormat;
};

export function parseCodexGoalCliMcpShortcut(
  commandName: string,
  argv: readonly string[],
  io: CodexGoalCliIo,
): CodexGoalCliMcpToolCommand | undefined {
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
      tool: "codex_goal_accounts_status",
      argv,
      io,
    });
  }
  if (commandName === "send-guidance" || commandName === "guidance") {
    return parseJobShortcut({
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
      tool: "codex_goal_control_decision",
      argv,
      io,
    });
  }
  if (commandName === "control-reconcile" || commandName === "inbox-reconcile") {
    return parseJobShortcut({
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

export function oneShotCodexGoalMcpToolGuard(
  name: string,
): Record<string, unknown> | undefined {
  if (name !== "codex_goal_project_controller_start") return undefined;
  return {
    ok: false,
    mode: "mcp_tool_guard",
    sideEffects: [],
    tool: name,
    reason: "durable_controller_process_required",
    safeMessage:
      "codex_goal_project_controller_start must run through a durable MCP/supervisor process that keeps the provider runner attached. The one-shot CLI fallback exits after the tool call and cannot safely own live controller liveness. Start subscription-runtime-codex-goal-mcp under the host supervisor or use an in-process MCP client owned by that supervisor.",
  };
}

function parseJobShortcut(input: {
  readonly tool: string;
  readonly argv: readonly string[];
  readonly io: CodexGoalCliIo;
  readonly extraArgs?: (values: ParsedFlags) => Record<string, unknown>;
}): CodexGoalCliMcpToolCommand {
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
