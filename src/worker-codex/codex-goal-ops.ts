import { execFile } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  readCodexAuthJsonFreshness,
  validateCodexAuthJsonBytes,
} from "@vioxen/subscription-runtime/provider-codex";
import type { AttemptFailureReason } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalRunConfig } from "./codex-goal-runner";

const execFileAsync = promisify(execFile);

export type CodexGoalOutputFormat = "text" | "json";

export type CodexGoalLaunchInput = {
  readonly config: CodexGoalRunConfig;
  readonly tmuxSession?: string;
  readonly cwd: string;
  readonly logPath: string;
  readonly format?: CodexGoalOutputFormat;
  readonly cliCommand: readonly string[];
};

export type CodexGoalTmuxCommand = {
  readonly args: readonly string[];
  readonly preview: string;
};

export type CodexGoalStatusInput = {
  readonly jobRootDir?: string;
  readonly taskId?: string;
  readonly workspacePath?: string;
  readonly tmuxSession?: string;
  readonly logPath?: string;
};

export type CodexGoalRecommendedAction =
  | "start_worker"
  | "wait_for_worker"
  | "review_completed"
  | "continue_after_capacity"
  | "continue_after_timeout"
  | "inspect_dirty_workspace"
  | "inspect_dirty_failure"
  | "inspect_failure"
  | "check_log_or_result";

export type CodexGoalStatus = {
  readonly tmuxAlive?: boolean;
  readonly resultPath?: string;
  readonly resultExists?: boolean;
  readonly resultStatus?: string;
  readonly resultReason?: AttemptFailureReason;
  readonly workspaceDirty?: boolean;
  readonly changedFiles?: readonly string[];
  readonly logPath?: string;
  readonly logExists?: boolean;
  readonly logUpdatedAt?: string;
  readonly recommendedAction: CodexGoalRecommendedAction;
  readonly warnings: readonly string[];
};

export type CodexGoalDoctorCheck = {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
};

export type CodexGoalDoctorResult = {
  readonly ok: boolean;
  readonly checks: readonly CodexGoalDoctorCheck[];
};

export type CodexGoalAccountStatus =
  | "ready"
  | "auth_missing"
  | "auth_invalid";

export type CodexGoalAccountSlotStatus = {
  readonly name: string;
  readonly authJsonPath: string;
  readonly status: CodexGoalAccountStatus;
  readonly byteLength?: number;
  readonly authJsonSha256Prefix?: string;
  readonly lastRefreshAt?: string;
  readonly expiresAt?: string;
  readonly warnings: readonly string[];
  readonly safeMessage: string;
};

export type CodexGoalAccountStatusInput = {
  readonly authRootDir: string;
  readonly accounts?: readonly string[];
};

export function buildCodexGoalNoTmuxCommand(input: CodexGoalLaunchInput): string {
  const config = input.config;
  const args = [
    ...input.cliCommand,
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
    input.format ?? "text",
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

export function buildCodexGoalTmuxCommand(
  input: CodexGoalLaunchInput,
): CodexGoalTmuxCommand {
  if (!input.tmuxSession) {
    throw new Error("codex_goal_tmux_session_required");
  }
  const shellCommand = `${buildCodexGoalNoTmuxCommand(input)} 2>&1 | tee -a ${shellQuote(input.logPath)}`;
  const args = [
    "new-session",
    "-d",
    "-s",
    input.tmuxSession,
    "-c",
    input.cwd,
    shellCommand,
  ] as const;
  return {
    args,
    preview: `tmux ${args.map(shellQuote).join(" ")}`,
  };
}

export async function startCodexGoalTmux(
  input: CodexGoalLaunchInput,
): Promise<CodexGoalTmuxCommand> {
  const command = buildCodexGoalTmuxCommand(input);
  await execFileAsync("tmux", command.args);
  return command;
}

export async function collectCodexGoalStatus(
  input: CodexGoalStatusInput,
): Promise<CodexGoalStatus> {
  const warnings: string[] = [];
  const resultPath = input.jobRootDir && input.taskId
    ? join(input.jobRootDir, `${input.taskId}.latest-result.json`)
    : undefined;
  const resultExists = resultPath ? await fileExists(resultPath) : undefined;
  const result = resultPath && resultExists
    ? await readCodexGoalResultSummary(resultPath)
    : {};
  let tmuxAlive: boolean | undefined;
  if (input.tmuxSession) {
    tmuxAlive = await tmuxSessionAlive(input.tmuxSession);
    if (!tmuxAlive) warnings.push("tmux session is not alive");
  }
  const workspace = input.workspacePath
    ? await gitWorkspaceStatus(input.workspacePath)
    : {};
  if (workspace.warning) warnings.push(workspace.warning);
  const log = input.logPath ?? (input.jobRootDir && input.taskId
    ? join(input.jobRootDir, `${input.taskId}.log`)
    : undefined);
  const logStatus = log ? await logFileStatus(log) : {};
  return {
    ...(tmuxAlive === undefined ? {} : { tmuxAlive }),
    ...(resultPath === undefined ? {} : { resultPath }),
    ...(resultExists === undefined ? {} : { resultExists }),
    ...(result.status === undefined ? {} : { resultStatus: result.status }),
    ...(result.reason === undefined ? {} : { resultReason: result.reason }),
    ...(workspace.dirty === undefined ? {} : { workspaceDirty: workspace.dirty }),
    ...(workspace.changedFiles === undefined
      ? {}
      : { changedFiles: workspace.changedFiles }),
    ...(log === undefined ? {} : { logPath: log }),
    ...(logStatus.exists === undefined ? {} : { logExists: logStatus.exists }),
    ...(logStatus.updatedAt === undefined
      ? {}
      : { logUpdatedAt: logStatus.updatedAt }),
    recommendedAction: recommendCodexGoalAction({
      ...(tmuxAlive === undefined ? {} : { tmuxAlive }),
      ...(result.status === undefined ? {} : { resultStatus: result.status }),
      ...(result.reason === undefined ? {} : { resultReason: result.reason }),
      ...(workspace.dirty === undefined
        ? {}
        : { workspaceDirty: workspace.dirty }),
      ...(resultExists === undefined ? {} : { resultExists }),
    }),
    warnings,
  };
}

export async function doctorCodexGoal(input: {
  readonly config: CodexGoalRunConfig;
  readonly tmuxSession?: string;
}): Promise<CodexGoalDoctorResult> {
  const checks = await Promise.all([
    checkFile("prompt", input.config.promptPath),
    checkDirectory("jobRoot", input.config.jobRootDir),
    checkDirectory("authRoot", input.config.authRootDir),
    checkGitWorkspace(input.config.workspacePath),
    ...(input.tmuxSession
      ? [checkTmuxSessionAvailable(input.tmuxSession)]
      : []),
    ...input.config.accounts.map((account) =>
      checkFile(
        `account:${account.name}`,
        account.authJsonPath ??
          join(input.config.authRootDir, account.name, "auth.json"),
      ),
    ),
  ]);
  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

export async function tailCodexGoalLog(
  logPath: string,
  lines: number,
): Promise<string> {
  const text = await readFile(logPath, "utf8");
  return `${text.split(/\r?\n/).slice(-lines).join("\n")}\n`;
}

export async function listCodexGoalAccountStatuses(
  input: CodexGoalAccountStatusInput,
): Promise<readonly CodexGoalAccountSlotStatus[]> {
  const accountNames = input.accounts?.length
    ? input.accounts
    : await listAccountDirectories(input.authRootDir);
  return Promise.all(
    accountNames.map((name) => inspectCodexGoalAccount(input.authRootDir, name)),
  );
}

export function recommendCodexGoalAction(input: {
  readonly tmuxAlive?: boolean;
  readonly resultStatus?: string;
  readonly resultReason?: AttemptFailureReason;
  readonly workspaceDirty?: boolean;
  readonly resultExists?: boolean;
}): CodexGoalRecommendedAction {
  if (input.tmuxAlive) return "wait_for_worker";
  if (input.resultStatus === "completed") return "review_completed";
  if (!input.resultExists) {
    return input.workspaceDirty ? "inspect_dirty_workspace" : "start_worker";
  }
  if (
    input.resultReason === "quota_limited" ||
    input.resultReason === "capacity_unavailable" ||
    input.resultReason === "account_unavailable" ||
    input.resultReason === "reconnect_required"
  ) {
    return "continue_after_capacity";
  }
  if (input.resultReason === "task_timeout") return "continue_after_timeout";
  if (
    input.resultStatus === "partial" ||
    input.resultStatus === "failed" ||
    input.resultStatus === "aborted"
  ) {
    return input.workspaceDirty ? "inspect_dirty_failure" : "inspect_failure";
  }
  return "check_log_or_result";
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function inspectCodexGoalAccount(
  authRootDir: string,
  name: string,
): Promise<CodexGoalAccountSlotStatus> {
  const authJsonPath = join(authRootDir, name, "auth.json");
  try {
    const authJsonBytes = await readFile(authJsonPath, "utf8");
    const validation = validateCodexAuthJsonBytes({ authJsonBytes });
    const freshness = readCodexAuthJsonFreshness({ authJsonBytes });
    const warnings = [...validation.warnings, ...freshness.warnings];
    return {
      name,
      authJsonPath,
      status: "ready",
      byteLength: validation.byteLength,
      authJsonSha256Prefix: validation.exactBytesSha256.slice(0, 12),
      ...(freshness.lastRefreshAt
        ? { lastRefreshAt: freshness.lastRefreshAt.toISOString() }
        : {}),
      ...(freshness.expiresAt
        ? { expiresAt: freshness.expiresAt.toISOString() }
        : {}),
      warnings,
      safeMessage: warnings.length
        ? "auth.json is readable but has warnings"
        : "auth.json is readable",
    };
  } catch (error) {
    const safeMessage = error instanceof Error ? error.message : "auth_invalid";
    return {
      name,
      authJsonPath,
      status: safeMessage.includes("ENOENT") ? "auth_missing" : "auth_invalid",
      warnings: [],
      safeMessage: safeMessage.includes("ENOENT")
        ? "auth.json is missing"
        : safeMessage,
    };
  }
}

async function listAccountDirectories(authRootDir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(authRootDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function readCodexGoalResultSummary(path: string): Promise<{
  readonly status?: string;
  readonly reason?: AttemptFailureReason;
}> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) return {};
    return {
      ...(typeof parsed.status === "string" ? { status: parsed.status } : {}),
      ...(isAttemptFailureReason(parsed.reason) ? { reason: parsed.reason } : {}),
    };
  } catch {
    return {};
  }
}

async function gitWorkspaceStatus(path: string): Promise<{
  readonly dirty?: boolean;
  readonly changedFiles?: readonly string[];
  readonly warning?: string;
}> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      path,
      "status",
      "--porcelain",
    ]);
    const changedFiles = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      dirty: changedFiles.length > 0,
      changedFiles,
    };
  } catch {
    return {
      dirty: false,
      changedFiles: [],
      warning: `${path} is not a readable git worktree`,
    };
  }
}

async function logFileStatus(path: string): Promise<{
  readonly exists?: boolean;
  readonly updatedAt?: string;
}> {
  try {
    const item = await stat(path);
    return {
      exists: item.isFile(),
      ...(item.isFile() ? { updatedAt: item.mtime.toISOString() } : {}),
    };
  } catch {
    return { exists: false };
  }
}

async function checkFile(
  name: string,
  path: string,
): Promise<CodexGoalDoctorCheck> {
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

async function checkDirectory(
  name: string,
  path: string,
): Promise<CodexGoalDoctorCheck> {
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

async function checkGitWorkspace(path: string): Promise<CodexGoalDoctorCheck> {
  try {
    await execFileAsync("git", ["-C", path, "rev-parse", "--is-inside-work-tree"]);
    return { name: "workspace", ok: true, message: path };
  } catch {
    return { name: "workspace", ok: false, message: `${path} is not a git worktree` };
  }
}

async function checkTmuxSessionAvailable(
  session: string,
): Promise<CodexGoalDoctorCheck> {
  const alive = await tmuxSessionAlive(session);
  return {
    name: "tmuxSession",
    ok: !alive,
    message: alive
      ? `${session} is already alive`
      : `${session} is available`,
  };
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

function isAttemptFailureReason(value: unknown): value is AttemptFailureReason {
  return (
    value === "quota_limited" ||
    value === "capacity_unavailable" ||
    value === "account_unavailable" ||
    value === "reconnect_required" ||
    value === "permission_required" ||
    value === "task_timeout" ||
    value === "provider_output_invalid" ||
    value === "user_abort" ||
    value === "unknown_error"
  );
}

function pushOptional(
  args: string[],
  flagName: string,
  value: string | undefined,
): void {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
