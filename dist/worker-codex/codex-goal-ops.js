import { execFile } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { readCodexAuthJsonFreshness, validateCodexAuthJsonBytes, } from "@vioxen/subscription-runtime/provider-codex";
const execFileAsync = promisify(execFile);
export function buildCodexGoalNoTmuxCommand(input) {
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
    if (config.allowDuplicateAccountIdentities)
        args.push("--allow-duplicate-accounts");
    if (config.requireGitWorkspace === false)
        args.push("--no-require-git-workspace");
    if (config.prewarmOnStart)
        args.push("--prewarm");
    return args.map(shellQuote).join(" ");
}
export function buildCodexGoalTmuxCommand(input) {
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
    ];
    return {
        args,
        preview: `tmux ${args.map(shellQuote).join(" ")}`,
    };
}
export async function startCodexGoalTmux(input) {
    const command = buildCodexGoalTmuxCommand(input);
    await execFileAsync("tmux", command.args);
    return command;
}
export async function collectCodexGoalStatus(input) {
    const warnings = [];
    const resultPath = input.jobRootDir && input.taskId
        ? join(input.jobRootDir, `${input.taskId}.latest-result.json`)
        : undefined;
    const resultExists = resultPath ? await fileExists(resultPath) : undefined;
    const result = resultPath && resultExists
        ? await readCodexGoalResultSummary(resultPath)
        : {};
    let tmuxAlive;
    if (input.tmuxSession) {
        tmuxAlive = await tmuxSessionAlive(input.tmuxSession);
        if (!tmuxAlive)
            warnings.push("tmux session is not alive");
    }
    const workspace = input.workspacePath
        ? await gitWorkspaceStatus(input.workspacePath)
        : {};
    if (workspace.warning)
        warnings.push(workspace.warning);
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
export async function doctorCodexGoal(input) {
    const checks = await Promise.all([
        checkFile("prompt", input.config.promptPath),
        checkDirectory("jobRoot", input.config.jobRootDir),
        checkDirectory("authRoot", input.config.authRootDir),
        checkGitWorkspace(input.config.workspacePath),
        ...(input.tmuxSession
            ? [checkTmuxSessionAvailable(input.tmuxSession)]
            : []),
        ...input.config.accounts.map((account) => checkFile(`account:${account.name}`, account.authJsonPath ??
            join(input.config.authRootDir, account.name, "auth.json"))),
    ]);
    return {
        ok: checks.every((check) => check.ok),
        checks,
    };
}
export async function tailCodexGoalLog(logPath, lines) {
    const text = await readFile(logPath, "utf8");
    return `${text.split(/\r?\n/).slice(-lines).join("\n")}\n`;
}
export async function listCodexGoalAccountStatuses(input) {
    const accountNames = input.accounts?.length
        ? input.accounts
        : await listAccountDirectories(input.authRootDir);
    return Promise.all(accountNames.map((name) => inspectCodexGoalAccount(input.authRootDir, name)));
}
export function recommendCodexGoalAction(input) {
    if (input.tmuxAlive)
        return "wait_for_worker";
    if (input.resultStatus === "completed")
        return "review_completed";
    if (!input.resultExists) {
        return input.workspaceDirty ? "inspect_dirty_workspace" : "start_worker";
    }
    if (input.resultReason === "quota_limited" ||
        input.resultReason === "capacity_unavailable" ||
        input.resultReason === "account_unavailable" ||
        input.resultReason === "reconnect_required") {
        return "continue_after_capacity";
    }
    if (input.resultReason === "task_timeout")
        return "continue_after_timeout";
    if (input.resultStatus === "partial" ||
        input.resultStatus === "failed" ||
        input.resultStatus === "aborted") {
        return input.workspaceDirty ? "inspect_dirty_failure" : "inspect_failure";
    }
    return "check_log_or_result";
}
export function shellQuote(value) {
    if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value))
        return value;
    return `'${value.replace(/'/g, "'\\''")}'`;
}
async function inspectCodexGoalAccount(authRootDir, name) {
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
    }
    catch (error) {
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
async function listAccountDirectories(authRootDir) {
    try {
        const entries = await readdir(authRootDir, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort((left, right) => left.localeCompare(right));
    }
    catch {
        return [];
    }
}
async function readCodexGoalResultSummary(path) {
    try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        if (!isRecord(parsed))
            return {};
        return {
            ...(typeof parsed.status === "string" ? { status: parsed.status } : {}),
            ...(isAttemptFailureReason(parsed.reason) ? { reason: parsed.reason } : {}),
        };
    }
    catch {
        return {};
    }
}
async function gitWorkspaceStatus(path) {
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
    }
    catch {
        return {
            dirty: false,
            changedFiles: [],
            warning: `${path} is not a readable git worktree`,
        };
    }
}
async function logFileStatus(path) {
    try {
        const item = await stat(path);
        return {
            exists: item.isFile(),
            ...(item.isFile() ? { updatedAt: item.mtime.toISOString() } : {}),
        };
    }
    catch {
        return { exists: false };
    }
}
async function checkFile(name, path) {
    try {
        const item = await stat(path);
        return {
            name,
            ok: item.isFile(),
            message: item.isFile() ? path : `${path} is not a file`,
        };
    }
    catch {
        return { name, ok: false, message: `${path} is missing` };
    }
}
async function checkDirectory(name, path) {
    try {
        const item = await stat(path);
        return {
            name,
            ok: item.isDirectory(),
            message: item.isDirectory() ? path : `${path} is not a directory`,
        };
    }
    catch {
        return { name, ok: false, message: `${path} is missing` };
    }
}
async function checkGitWorkspace(path) {
    try {
        await execFileAsync("git", ["-C", path, "rev-parse", "--is-inside-work-tree"]);
        return { name: "workspace", ok: true, message: path };
    }
    catch {
        return { name: "workspace", ok: false, message: `${path} is not a git worktree` };
    }
}
async function checkTmuxSessionAvailable(session) {
    const alive = await tmuxSessionAlive(session);
    return {
        name: "tmuxSession",
        ok: !alive,
        message: alive
            ? `${session} is already alive`
            : `${session} is available`,
    };
}
async function tmuxSessionAlive(session) {
    try {
        await execFileAsync("tmux", ["has-session", "-t", session]);
        return true;
    }
    catch {
        return false;
    }
}
async function fileExists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
function isAttemptFailureReason(value) {
    return (value === "quota_limited" ||
        value === "capacity_unavailable" ||
        value === "account_unavailable" ||
        value === "reconnect_required" ||
        value === "permission_required" ||
        value === "task_timeout" ||
        value === "provider_output_invalid" ||
        value === "user_abort" ||
        value === "unknown_error");
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
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=codex-goal-ops.js.map