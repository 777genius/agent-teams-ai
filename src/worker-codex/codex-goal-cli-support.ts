import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type OutputFormat = "text" | "json";

export type CodexGoalCliIo = {
  writeStdout(chunk: string): void;
  writeStderr(chunk: string): void;
  cwd(): string;
  env(): Readonly<Record<string, string | undefined>>;
};

export type ParsedFlags = {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
};

export function parseFlags(argv: readonly string[]): ParsedFlags {
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

export function requiredOption(
  flags: ParsedFlags,
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  envNames: readonly string[],
): string {
  const value = option(flags, env, name, envNames);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function option(
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

export function flag(flags: ParsedFlags, name: string): boolean {
  return flags.flags.has(name);
}

export function outputFormatFromFlags(
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

export function outputFormat(value: string): OutputFormat {
  if (value === "text" || value === "json") return value;
  throw new Error("--format must be text or json");
}

export function parseOptionalPositiveInteger(
  value: string | undefined,
  label: string,
): number | undefined {
  return value === undefined ? undefined : parsePositiveInteger(value, label);
}

export function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export function resolvePath(cwd: string, value: string): string {
  const expanded = value.startsWith("~/")
    ? join(homedir(), value.slice(2))
    : value;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

export function writeJsonOrText(
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function usage(): string {
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
  subscription-runtime-codex-goal controller-supervise --controller-job-id <id> [--registry-root <dir>] [--provider codex|claude] [--status-interval-ms 60000]
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
