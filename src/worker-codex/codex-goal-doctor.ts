import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { hostExecutableNotFoundMessage } from "@vioxen/subscription-runtime/worker-core";
import { resolveHostExecutable } from "../worker-local/host-command";
import type { CodexGoalRunConfig } from "./codex-goal-runner";

const execFileAsync = promisify(execFile);
const gitStatusTimeoutMs = 5_000;

export type CodexGoalDoctorCheck = {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
};

export type CodexGoalDoctorResult = {
  readonly ok: boolean;
  readonly checks: readonly CodexGoalDoctorCheck[];
};

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
        "account:" + account.name,
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

export async function resolveCodexGoalTmuxExecutable(): Promise<string> {
  const resolution = await resolveCodexGoalTmux();
  if (!resolution.found) {
    throw new Error(hostExecutableNotFoundMessage(resolution));
  }
  return resolution.executable;
}

export async function inspectCodexGoalTmuxSession(
  session: string,
): Promise<{ readonly alive: boolean; readonly warning?: string }> {
  const resolution = await resolveCodexGoalTmux();
  if (!resolution.found) {
    return {
      alive: false,
      warning: hostExecutableNotFoundMessage(resolution),
    };
  }
  try {
    await execFileAsync(resolution.executable, ["has-session", "-t", session]);
    return { alive: true };
  } catch (error) {
    if (isTmuxPermissionFailure(error)) {
      return {
        alive: false,
        warning: tmuxUnavailableMessage(error),
      };
    }
    return { alive: false };
  }
}

export function tmuxCodexGoalStartFailedMessage(error: unknown): string {
  if (isTmuxPermissionFailure(error)) return tmuxUnavailableMessage(error);
  const detail = safeExecErrorMessage(error);
  return ["codex_goal_tmux_start_failed", detail].filter(Boolean).join(": ");
}

async function checkFile(
  name: string,
  path: string,
): Promise<CodexGoalDoctorCheck> {
  try {
    const item = await stat(path);
    if (!item.isFile()) {
      return { name, ok: false, message: path + " is not a file" };
    }
    await access(path, constants.R_OK);
    return { name, ok: true, message: path };
  } catch (error) {
    const code = safeErrorCode(error);
    if (code === "ENOENT") {
      return { name, ok: false, message: path + " is missing" };
    }
    return {
      name,
      ok: false,
      message: path + " is not readable (" + code + ")",
    };
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
      message: item.isDirectory() ? path : path + " is not a directory",
    };
  } catch {
    return { name, ok: false, message: path + " is missing" };
  }
}

async function checkGitWorkspace(path: string): Promise<CodexGoalDoctorCheck> {
  try {
    await execFileAsync(
      "git",
      ["-C", path, "rev-parse", "--is-inside-work-tree"],
      { timeout: gitStatusTimeoutMs },
    );
    return { name: "workspace", ok: true, message: path };
  } catch {
    return { name: "workspace", ok: false, message: path + " is not a git worktree" };
  }
}

async function checkTmuxSessionAvailable(
  session: string,
): Promise<CodexGoalDoctorCheck> {
  const tmux = await inspectCodexGoalTmuxSession(session);
  if (tmux.warning) {
    return {
      name: "tmuxSession",
      ok: false,
      message: tmux.warning,
    };
  }
  const alive = tmux.alive;
  return {
    name: "tmuxSession",
    ok: !alive,
    message: alive
      ? session + " is already alive"
      : session + " is available",
  };
}

async function resolveCodexGoalTmux() {
  return resolveHostExecutable({
    name: "tmux",
    envNames: [
      "SUBSCRIPTION_RUNTIME_TMUX_PATH",
      "TMUX_PATH",
      "TMUX_BIN",
    ],
    additionalCandidates: [
      "/opt/homebrew/bin/tmux",
      "/usr/local/bin/tmux",
      "/usr/bin/tmux",
      "/bin/tmux",
    ],
  });
}

function tmuxUnavailableMessage(error: unknown): string {
  const detail = safeExecErrorMessage(error);
  return [
    "codex_goal_tmux_unavailable",
    detail,
    "Lane orchestrators inside app-server-goal cannot own child worker process supervision; request worker start, continue, stop and account actions through host-side subscription-runtime MCP or CLI controls.",
  ].filter(Boolean).join(": ");
}

function isTmuxPermissionFailure(error: unknown): boolean {
  const message = safeExecErrorMessage(error).toLowerCase();
  return message.includes("operation not permitted") ||
    message.includes("permission denied") ||
    message.includes("eacces") ||
    safeErrorCode(error) === "EACCES" ||
    safeErrorCode(error) === "EPERM";
}

function safeExecErrorMessage(error: unknown): string {
  if (!isRecord(error)) {
    return error instanceof Error ? redactStatusText(error.message) : "tmux failed";
  }
  const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
  const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
  const message = error instanceof Error ? error.message : "";
  return redactStatusText(stderr || stdout || message || "tmux failed");
}

function safeErrorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return "unknown_error";
}

function redactStatusText(value: string): string {
  return new DefaultRedactor().redact(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
