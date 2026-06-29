#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  codexGoalAccountSlots,
  runCodexGoal,
  type CodexGoalRunConfig,
} from "./codex-goal-runner";

const execFileAsync = promisify(execFile);

type OutputFormat = "text" | "json";
type CodexGoalCliCommand =
  | RunCommand
  | StatusCommand
  | DoctorCommand
  | TailCommand
  | HelpCommand;

type RunCommand = {
  readonly kind: "run";
  readonly config: CodexGoalRunConfig;
  readonly tmuxSession?: string;
  readonly dryRun: boolean;
  readonly printCommand: boolean;
  readonly format: OutputFormat;
  readonly cwd: string;
  readonly logPath: string;
};

type StatusCommand = {
  readonly kind: "status";
  readonly jobRootDir?: string;
  readonly taskId?: string;
  readonly workspacePath?: string;
  readonly tmuxSession?: string;
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
    if (command.tmuxSession) {
      const tmuxCommand = buildTmuxCommand(command);
      if (command.dryRun || command.printCommand) {
        io.writeStdout(`${tmuxCommand.preview}\n`);
        return 0;
      }
      await execFileAsync("tmux", tmuxCommand.args);
      io.writeStdout(
        `started ${command.tmuxSession} for ${command.config.taskId}\n`,
      );
      return 0;
    }
    if (command.dryRun || command.printCommand) {
      io.writeStdout(`${buildNoTmuxShellCommand(command)}\n`);
      return 0;
    }
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
  throw new Error(`unknown command: ${commandName}`);
}

export function buildTmuxCommand(command: RunCommand): {
  readonly args: readonly string[];
  readonly preview: string;
} {
  if (!command.tmuxSession) {
    throw new Error("codex_goal_tmux_session_required");
  }
  const shellCommand = `${buildNoTmuxShellCommand(command)} 2>&1 | tee -a ${shellQuote(command.logPath)}`;
  const args = [
    "new-session",
    "-d",
    "-s",
    command.tmuxSession,
    "-c",
    command.cwd,
    shellCommand,
  ] as const;
  return {
    args,
    preview: `tmux ${args.map(shellQuote).join(" ")}`,
  };
}

export function buildNoTmuxShellCommand(command: RunCommand): string {
  const config = command.config;
  const args = [
    execPath,
    currentCliPath(),
    "run",
    "--no-tmux",
    "--job-root",
    config.jobRootDir,
    "--auth-root",
    config.authRootDir,
    "--workspace",
    config.workspacePath,
    "--prompt",
    config.promptPath,
    "--task-id",
    config.taskId,
    "--accounts",
    config.accounts.map((account) => account.name).join(","),
    "--format",
    command.format,
  ];
  pushOptional(args, "--state-root", config.stateRootDir);
  pushOptional(args, "--output", config.outputPath);
  pushOptional(args, "--codex-binary", config.codexBinaryPath);
  pushOptional(args, "--model", config.model);
  pushOptional(args, "--effort", config.reasoningEffort);
  pushOptional(args, "--service-tier", config.serviceTier);
  pushOptionalNumber(args, "--timeout-ms", config.taskTimeoutMs);
  pushOptionalNumber(args, "--stale-lock-ms", config.staleLockMs);
  pushOptionalNumber(args, "--max-account-cycles", config.maxAccountCycles);
  pushOptional(args, "--permission-mode", config.permissionMode);
  if (config.allowDuplicateAccountIdentities) args.push("--allow-duplicate-accounts");
  if (config.requireGitWorkspace === false) args.push("--no-require-git-workspace");
  if (config.prewarmOnStart) args.push("--prewarm");
  return args.map(shellQuote).join(" ");
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
  return {
    kind: "status",
    ...(jobRootDir ? { jobRootDir } : {}),
    ...(taskId ? { taskId } : {}),
    ...(workspacePath ? { workspacePath } : {}),
    ...(tmuxSession ? { tmuxSession } : {}),
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
  ]) ?? "xhigh") as CodexGoalRunConfig["reasoningEffort"];
  const serviceTier = (option(values, env, "--service-tier", [
    "CODEX_SERVICE_TIER",
  ]) ?? "fast") as CodexGoalRunConfig["serviceTier"];
  const staleLockMs = parseOptionalPositiveInteger(
    option(values, env, "--stale-lock-ms", []),
    "--stale-lock-ms",
  );
  const config: CodexGoalRunConfig = {
    jobRootDir: resolvePath(cwd, jobRootDir),
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
    model: option(values, env, "--model", ["CODEX_MODEL"]) ?? "gpt-5.5",
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    codexBinaryPath: option(values, env, "--codex-binary", [
      "CODEX_BINARY_PATH",
    ]) ?? "codex",
    permissionMode: (option(values, env, "--permission-mode", []) ??
      "allow-edits") as CodexGoalRunConfig["permissionMode"],
    taskTimeoutMs: parseOptionalPositiveInteger(
      option(values, env, "--timeout-ms", [
        "SUBSCRIPTION_RUNTIME_TASK_TIMEOUT_MS",
        "MEMO_STACK_GOAL_TASK_TIMEOUT_MS",
      ]),
      "--timeout-ms",
    ) ?? parseDurationMs(option(values, env, "--timeout", []) ?? "72h"),
    maxAccountCycles: parseOptionalPositiveInteger(
      option(values, env, "--max-account-cycles", [
        "SUBSCRIPTION_RUNTIME_MAX_ACCOUNT_CYCLES",
      ]),
      "--max-account-cycles",
    ) ?? 3,
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
  const warnings: string[] = [];
  const resultPath = command.jobRootDir && command.taskId
    ? join(command.jobRootDir, `${command.taskId}.latest-result.json`)
    : null;
  const resultExists = resultPath ? await fileExists(resultPath) : undefined;
  let resultStatus: string | undefined;
  if (resultPath && resultExists) {
    resultStatus = await readResultStatus(resultPath);
  }
  let tmuxAlive: boolean | undefined;
  if (command.tmuxSession) {
    tmuxAlive = await tmuxSessionAlive(command.tmuxSession);
    if (!tmuxAlive) warnings.push("tmux session is not alive");
  }
  let workspaceDirty: boolean | undefined;
  if (command.workspacePath) {
    workspaceDirty = await gitWorkspaceDirty(command.workspacePath);
  }
  return {
    ...(tmuxAlive === undefined ? {} : { tmuxAlive }),
    ...(resultExists === undefined ? {} : { resultExists }),
    ...(resultStatus === undefined ? {} : { resultStatus }),
    ...(workspaceDirty === undefined ? {} : { workspaceDirty }),
    warnings,
  };
}

async function doctor(command: DoctorCommand): Promise<{
  readonly ok: boolean;
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly message: string }[];
}> {
  const checks = await Promise.all([
    checkFile("prompt", command.config.promptPath),
    checkDirectory("jobRoot", command.config.jobRootDir),
    checkDirectory("authRoot", command.config.authRootDir),
    checkGitWorkspace(command.config.workspacePath),
    ...command.config.accounts.map((account) =>
      checkFile(
        `account:${account.name}`,
        account.authJsonPath ??
          join(command.config.authRootDir, account.name, "auth.json"),
      ),
    ),
  ]);
  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

async function checkFile(name: string, path: string): Promise<{
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
}> {
  try {
    const item = await stat(path);
    return {
      name,
      ok: item.isFile(),
      message: item.isFile() ? path : `${path} is not a file`,
    };
  } catch {
    return { name, ok: false, message: `${path} is missing` };
  }
}

async function checkDirectory(name: string, path: string): Promise<{
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
}> {
  try {
    const item = await stat(path);
    return {
      name,
      ok: item.isDirectory(),
      message: item.isDirectory() ? path : `${path} is not a directory`,
    };
  } catch {
    return { name, ok: false, message: `${path} is missing` };
  }
}

async function checkGitWorkspace(path: string): Promise<{
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
}> {
  try {
    await execFileAsync("git", ["-C", path, "rev-parse", "--is-inside-work-tree"]);
    return { name: "workspace", ok: true, message: path };
  } catch {
    return { name: "workspace", ok: false, message: `${path} is not a git worktree` };
  }
}

async function gitWorkspaceDirty(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", path, "status", "--porcelain"]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function tmuxSessionAlive(session: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["has-session", "-t", session]);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readResultStatus(path: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isRecord(parsed) && typeof parsed.status === "string") return parsed.status;
    return undefined;
  } catch {
    return undefined;
  }
}

async function tailFile(path: string, lines: number): Promise<string> {
  const text = await readFile(path, "utf8");
  return `${text.split(/\r?\n/).slice(-lines).join("\n")}\n`;
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

function outputFormat(value: string): OutputFormat {
  if (value === "text" || value === "json") return value;
  throw new Error("--format must be text or json");
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
  subscription-runtime-codex-goal run --job-root <dir> --workspace <dir> --prompt <file> --task-id <id> --accounts account-a,account-b [--tmux-session <name>]
  subscription-runtime-codex-goal status --job-root <dir> --task-id <id> [--workspace <dir>] [--tmux-session <name>]
  subscription-runtime-codex-goal doctor --job-root <dir> --workspace <dir> --prompt <file> --task-id <id> --accounts account-a,account-b
  subscription-runtime-codex-goal tail --job-root <dir> --task-id <id> [--lines 100]

defaults:
  --model gpt-5.5 --effort xhigh --service-tier fast --timeout 72h --max-account-cycles 3

escape hatches:
  --dry-run, --print-command, --no-tmux, --no-require-git-workspace
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
