import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FileBackendCodexSafeExecutor, } from "./file-backend-codex-safe-executor.js";
export async function runCodexGoal(config, deps = {}) {
    assertCodexGoalRunConfig(config);
    const prompt = await readFile(config.promptPath, "utf8");
    const progressPath = codexGoalProgressPath(config);
    const progressHeartbeat = createCodexGoalProgressHeartbeat({
        progressPath,
        taskId: config.taskId,
        intervalMs: config.progressHeartbeatMs ?? 60_000,
    });
    await progressHeartbeat.write({ status: "starting" });
    const encryptionKey = await readOrCreateCodexGoalEncryptionKey(config.encryptionKeyPath ?? join(config.jobRootDir, "encryption-key.hex"));
    const stateRootDir = config.stateRootDir ?? join(config.jobRootDir, "state");
    await mkdir(stateRootDir, { recursive: true, mode: 0o700 });
    const executor = (deps.createExecutor ??
        ((options) => new FileBackendCodexSafeExecutor(options)))(buildCodexGoalExecutorOptions({
        config,
        stateRootDir,
        encryptionKey,
    }));
    try {
        progressHeartbeat.start();
        const result = await executor.run({
            ...(config.jobId === undefined ? {} : { jobId: config.jobId }),
            taskId: config.taskId,
            prompt,
            originalPrompt: prompt,
            ...(config.staleLockMs === undefined
                ? {}
                : { staleLockMs: config.staleLockMs }),
            ...(config.maxAccountCycles === undefined
                ? {}
                : { maxAccountCycles: config.maxAccountCycles }),
            ...(config.effectMode === undefined ? {} : { effectMode: config.effectMode }),
            ...(config.safeExecutionPolicy === undefined
                ? {}
                : { safeExecutionPolicy: config.safeExecutionPolicy }),
            controls: {
                permissionMode: config.permissionMode ?? "allow-edits",
            },
            systemPrompt: codexGoalWorkerSystemPrompt(config.taskId),
            metadata: {
                goal: config.goalSummary ?? config.taskId,
                codexGoalObjective: config.codexGoalObjective ?? prompt,
            },
        });
        if (config.outputPath) {
            await writeFile(config.outputPath, `${JSON.stringify(result, null, 2)}\n`, {
                encoding: "utf8",
                mode: 0o600,
            });
        }
        await progressHeartbeat.write(progressFromResult(result));
        return result;
    }
    catch (error) {
        await progressHeartbeat.write({
            status: "failed",
            reason: "runner_exception",
        });
        throw error;
    }
    finally {
        await progressHeartbeat.stop();
        await executor.dispose();
    }
}
export function buildCodexGoalExecutorOptions(input) {
    const { config } = input;
    return {
        ...(config.executorId ? { executorId: config.executorId } : {}),
        stateRootDir: input.stateRootDir,
        workspacePath: config.workspacePath,
        maxAccountCycles: config.maxAccountCycles ?? 5,
        allowDuplicateAccountIdentities: config.allowDuplicateAccountIdentities ?? false,
        requireGitWorkspace: config.requireGitWorkspace ?? true,
        prewarmOnStart: config.prewarmOnStart ?? false,
        ...(config.effectMode === undefined ? {} : { effectMode: config.effectMode }),
        ...(config.safeExecutionPolicy === undefined
            ? {}
            : { safeExecutionPolicy: config.safeExecutionPolicy }),
        accounts: config.accounts.map((account, index) => ({
            codexAuthJsonPath: account.authJsonPath ?? join(config.authRootDir, account.name, "auth.json"),
            worker: {
                providerInstanceId: `${config.taskId}-${account.name}`,
                stateRootDir: input.stateRootDir,
                codexBinaryPath: config.codexBinaryPath ?? "codex",
                encryptionKey: input.encryptionKey,
                executionEngine: config.executionEngine ?? "app-server-goal",
                capacityAccountId: account.name,
                taskTimeoutMs: config.taskTimeoutMs ?? 72 * 60 * 60 * 1000,
                sourceEnv: config.sourceEnv ?? process.env,
                ...(config.model ? { model: config.model } : {}),
                ...(config.reasoningEffort
                    ? { reasoningEffort: config.reasoningEffort }
                    : {}),
                ...(config.serviceTier ? { serviceTier: config.serviceTier } : {}),
                capacityPolicy: {
                    quotaCooldownMs: config.quotaCooldownMs ?? 15 * 60 * 1000,
                    reconnectCooldownMs: config.reconnectCooldownMs ?? 15 * 60 * 1000,
                    maxReconnectRetriesPerAccount: config.maxReconnectRetriesPerAccount ?? 4,
                },
            },
        })),
        safeExecutionPolicy: {
            retryOnCapacity: true,
            retryOnAccountUnavailable: true,
            retryOnReconnectRequired: true,
            retryUnknownCleanWorkspace: false,
            retryUnknownChangedWorkspace: false,
            continuationMode: "packet_first",
            ...(config.safeExecutionPolicy ?? {}),
        },
    };
}
export async function readOrCreateCodexGoalEncryptionKey(keyPath) {
    if (existsSync(keyPath)) {
        const value = (await readFile(keyPath, "utf8")).trim();
        if (!/^[a-fA-F0-9]{64}$/.test(value)) {
            throw new Error("codex_goal_encryption_key_invalid");
        }
        return Buffer.from(value, "hex");
    }
    await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    await writeFile(keyPath, `${key.toString("hex")}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    return key;
}
export function codexGoalProgressPath(config) {
    return config.progressPath ?? join(config.jobRootDir, `${config.taskId}.progress.json`);
}
export function codexGoalAccountSlots(accounts) {
    return accounts
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => ({ name }));
}
function assertCodexGoalRunConfig(config) {
    if (!config.jobRootDir.trim())
        throw new Error("codex_goal_job_root_required");
    if (!config.authRootDir.trim())
        throw new Error("codex_goal_auth_root_required");
    if (!config.workspacePath.trim())
        throw new Error("codex_goal_workspace_required");
    if (!config.promptPath.trim())
        throw new Error("codex_goal_prompt_required");
    if (!config.taskId.trim())
        throw new Error("codex_goal_task_id_required");
    if (config.accounts.length === 0)
        throw new Error("codex_goal_accounts_required");
    assertPositiveInteger(config.taskTimeoutMs, "codex_goal_task_timeout_invalid");
    assertPositiveInteger(config.staleLockMs, "codex_goal_stale_lock_invalid");
    assertPositiveInteger(config.maxAccountCycles, "codex_goal_account_cycles_invalid");
    assertPositiveInteger(config.quotaCooldownMs, "codex_goal_quota_cooldown_invalid");
    assertPositiveInteger(config.reconnectCooldownMs, "codex_goal_reconnect_cooldown_invalid");
    assertPositiveInteger(config.maxReconnectRetriesPerAccount, "codex_goal_reconnect_retries_invalid");
    assertPositiveInteger(config.progressHeartbeatMs, "codex_goal_progress_heartbeat_invalid");
}
function assertPositiveInteger(value, code) {
    if (value === undefined)
        return;
    if (!Number.isInteger(value) || value <= 0)
        throw new Error(code);
}
function codexGoalWorkerSystemPrompt(taskId) {
    return [
        "Codex goal runtime artifact rule:",
        "If the task asks you to write a report, evidence file, or other artifact to a path outside the current workspace and the sandbox denies that write, write the artifact under /tmp instead.",
        `Use a task-specific directory such as /tmp/${taskId}-artifacts, include the exact fallback path in your final output, and do not mark the goal blocked solely because the external copy could not be performed.`,
        "Keep source worktrees clean unless the task explicitly requires code or docs changes.",
    ].join(" ");
}
function createCodexGoalProgressHeartbeat(input) {
    let stopped = false;
    let timer;
    let writes = Promise.resolve();
    const write = (patch) => {
        writes = writes.then(async () => {
            if (stopped && patch.status === "running")
                return;
            await writeCodexGoalProgress(input.progressPath, {
                schemaVersion: 1,
                taskId: input.taskId,
                updatedAt: new Date().toISOString(),
                pid: process.pid,
                ...patch,
            });
        });
        return writes;
    };
    return {
        async write(patch) {
            await write(patch);
        },
        start() {
            void write({ status: "running" });
            timer = setInterval(() => {
                void write({ status: "running" });
            }, input.intervalMs);
            timer.unref();
        },
        async stop() {
            stopped = true;
            if (timer)
                clearInterval(timer);
            await writes;
        },
    };
}
function progressFromResult(result) {
    const attempts = "attempts" in result && Array.isArray(result.attempts)
        ? result.attempts
        : [];
    const lastAttempt = attempts.at(-1);
    return {
        status: progressStatusFromResult(result.status),
        resultStatus: result.status,
        ...("reason" in result && typeof result.reason === "string"
            ? { reason: result.reason }
            : {}),
        attemptCount: attempts.length,
        ...(lastAttempt && "accountId" in lastAttempt && typeof lastAttempt.accountId === "string"
            ? { currentAccount: lastAttempt.accountId }
            : {}),
    };
}
function progressStatusFromResult(status) {
    if (status === "completed")
        return "completed";
    if (status === "partial")
        return "partial";
    if (status === "failed")
        return "failed";
    if (status === "aborted")
        return "aborted";
    return "failed";
}
async function writeCodexGoalProgress(path, snapshot) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    await rename(tempPath, path);
}
//# sourceMappingURL=codex-goal-runner.js.map