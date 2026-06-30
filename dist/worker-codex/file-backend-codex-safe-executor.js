import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateCodexAuthJsonBytes, } from "@vioxen/subscription-runtime/provider-codex";
import { LocalFileWorkerAccountCapacityStore } from "@vioxen/subscription-runtime/store-local-file";
import { accountCapacityAwareWorkerFactory, BoundedSubscriptionWorkerPool, LocalFileAttemptJournal, LocalFileWorkspaceLockStore, SafeExecutionRunner, SubscriptionWorkerError, } from "@vioxen/subscription-runtime/worker-core";
import { FileBackendCodexWorker, } from "./file-backend-codex-worker.js";
const defaultMaxAccountCycles = 5;
export class FileBackendCodexSafeExecutor {
    options;
    accountCapacityStore;
    executorId;
    workerAccounts = [];
    roundRobinSlotCursor = 0;
    pool;
    runner;
    startPromise = null;
    disposed = false;
    constructor(options) {
        this.options = options;
        assertSafeExecutorOptions(options);
        this.executorId =
            options.executorId ??
                `file-backend-codex-safe:${hashText(options.workspacePath).slice(0, 12)}`;
        this.accountCapacityStore =
            options.accountCapacityStore ??
                new LocalFileWorkerAccountCapacityStore({
                    rootDir: join(options.stateRootDir, "worker-account-capacity"),
                });
        this.pool = new BoundedSubscriptionWorkerPool({
            poolId: this.executorId,
            slots: options.accounts.length,
            ...(options.clock ? { clock: options.clock } : {}),
            ...(options.maxQueueSize === undefined
                ? {}
                : { maxQueueSize: options.maxQueueSize }),
            ...(options.shutdownTimeoutMs === undefined
                ? {}
                : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
            retryPolicy: {
                maxAttempts: options.accounts.length,
                retryOnSlotCapacityUnavailable: true,
            },
            slotSelector: ({ slots }) => this.selectRoundRobinSlot(slots),
            workerFactory: accountCapacityAwareWorkerFactory({
                accountCapacityStore: this.accountCapacityStore,
                ...(options.clock ? { clock: options.clock } : {}),
                workerFactory: ({ slotIndex, workerId }) => {
                    const account = options.accounts[slotIndex];
                    if (!account) {
                        throw new Error("file_backend_codex_safe_account_missing");
                    }
                    const worker = new FileBackendCodexWorker({
                        ...account.worker,
                        workerId: account.worker.workerId ?? workerId,
                        workspacePath: options.workspacePath,
                    });
                    this.workerAccounts.push({ account, worker });
                    return worker;
                },
            }),
        });
        this.runner = new SafeExecutionRunner({
            lockStore: options.lockStore ??
                new LocalFileWorkspaceLockStore(join(options.stateRootDir, "workspace-locks")),
            journal: options.journal ??
                new LocalFileAttemptJournal(join(options.stateRootDir, "attempt-journal")),
            ...(options.clock ? { clock: options.clock } : {}),
            ownerId: this.executorId,
        });
    }
    start() {
        if (this.disposed) {
            return Promise.reject(new SubscriptionWorkerError("subscription_worker_disposed", "Codex safe executor has been disposed."));
        }
        if (!this.startPromise) {
            this.startPromise = this.startOnce().catch((error) => {
                this.startPromise = null;
                throw error;
            });
        }
        return this.startPromise;
    }
    async prewarm() {
        await this.start();
        await this.pool.prewarm();
    }
    async run(input) {
        const { job, taskId, originalPrompt, effectMode, staleLockMs, maxAccountCycles, policy, } = codexSafeExecutionInput(input);
        return this.runner.run({
            taskId,
            workspace: {
                mode: "existing_locked",
                path: this.options.workspacePath,
                ...(staleLockMs === undefined ? {} : { staleLockMs }),
                ...(this.options.requireGitWorkspace === false
                    ? {}
                    : { requireGitWorkspace: true }),
            },
            effectMode: effectMode ??
                this.options.effectMode ??
                codexEffectModeFromJobControls(job),
            provider: "codex",
            pool: {
                run: async (runJob, runOptions) => {
                    await this.start();
                    return this.pool.run(runJob, runOptions);
                },
            },
            job,
            originalPrompt,
            policy: mergedSafeExecutionPolicy({
                base: this.options.safeExecutionPolicy,
                override: policy,
                defaultMaxAttempts: accountCycleAttemptLimit({
                    accountCount: this.options.accounts.length,
                    maxAccountCycles: maxAccountCycles ??
                        this.options.maxAccountCycles ??
                        defaultMaxAccountCycles,
                }),
            }),
            continuationJobFactory: ({ job: previousJob, continuationPacket, attemptNumber }) => ({
                ...previousJob,
                runId: `${taskId}:attempt-${attemptNumber}`,
                prompt: continuationPacket.message,
            }),
            summarizeResult: (result) => result.outputText,
            ...(job.abortSignal ? { abortSignal: job.abortSignal } : {}),
        });
    }
    health() {
        return this.pool.health();
    }
    stats() {
        return this.pool.stats();
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        await this.pool.dispose();
    }
    async startOnce() {
        await assertUniqueCodexAccountIdentities(this.options);
        await this.pool.start();
        await this.seedAccounts();
        if (this.options.prewarmOnStart) {
            await this.pool.prewarm();
        }
    }
    async seedAccounts() {
        for (const { account, worker } of this.workerAccounts) {
            if (account.codexAuthJsonPath) {
                await worker.seedCodexAuthJsonFile(account.codexAuthJsonPath);
            }
            if (account.codexAuthJson) {
                await worker.seedCodexAuthJson(account.codexAuthJson);
            }
        }
    }
    selectRoundRobinSlot(slots) {
        const available = slots.filter((slot) => !slot.busy && slot.capacity.availability === "available");
        if (available.length === 0)
            return null;
        const reconnectRetry = available.find((slot) => slot.capacity.reason === "reconnect_retry_pending");
        if (reconnectRetry)
            return reconnectRetry;
        for (let offset = 0; offset < slots.length; offset += 1) {
            const index = (this.roundRobinSlotCursor + offset) % slots.length;
            const slot = slots.find((candidate) => candidate.slotIndex === index);
            if (!slot || slot.busy || slot.capacity.availability !== "available") {
                continue;
            }
            this.roundRobinSlotCursor = (index + 1) % slots.length;
            return slot;
        }
        const fallback = available[0];
        this.roundRobinSlotCursor = (fallback.slotIndex + 1) % slots.length;
        return fallback;
    }
}
function codexSafeExecutionInput(input) {
    const { taskId, originalPrompt, effectMode, staleLockMs, maxAccountCycles, safeExecutionPolicy, ...jobInput } = input;
    assertMaxAccountCycles(maxAccountCycles);
    const job = {
        ...jobInput,
        runId: jobInput.runId ?? taskId,
    };
    return {
        taskId,
        job,
        originalPrompt: originalPrompt ?? job.prompt,
        ...(effectMode === undefined ? {} : { effectMode }),
        ...(staleLockMs === undefined ? {} : { staleLockMs }),
        ...(maxAccountCycles === undefined ? {} : { maxAccountCycles }),
        ...(safeExecutionPolicy === undefined ? {} : { policy: safeExecutionPolicy }),
    };
}
function codexEffectModeFromJobControls(job) {
    return job.controls?.permissionMode === "allow-edits"
        ? "workspace_patch"
        : "read_only";
}
function mergedSafeExecutionPolicy(input) {
    return {
        maxAttempts: input.defaultMaxAttempts,
        retryOnCapacity: true,
        retryOnAccountUnavailable: true,
        retryOnReconnectRequired: true,
        retryUnknownCleanWorkspace: false,
        retryUnknownChangedWorkspace: false,
        continuationMode: "packet_first",
        ...(input.base ?? {}),
        ...(input.override ?? {}),
    };
}
function accountCycleAttemptLimit(input) {
    assertMaxAccountCycles(input.maxAccountCycles);
    return input.accountCount * input.maxAccountCycles;
}
function assertSafeExecutorOptions(options) {
    if (!options.stateRootDir.trim()) {
        throw new Error("file_backend_codex_safe_state_root_required");
    }
    if (!options.workspacePath.trim()) {
        throw new Error("file_backend_codex_safe_workspace_required");
    }
    if (options.accounts.length === 0) {
        throw new Error("file_backend_codex_safe_accounts_required");
    }
    assertMaxAccountCycles(options.maxAccountCycles);
    for (const account of options.accounts) {
        if (account.codexAuthJson && account.codexAuthJsonPath) {
            throw new Error("file_backend_codex_safe_account_seed_conflict");
        }
    }
}
function assertMaxAccountCycles(value) {
    if (value !== undefined &&
        (!Number.isInteger(value) || value <= 0)) {
        throw new Error("file_backend_codex_safe_max_account_cycles_invalid");
    }
}
async function assertUniqueCodexAccountIdentities(options) {
    if (options.allowDuplicateAccountIdentities)
        return;
    const identities = (await Promise.all(options.accounts.map(async (account, index) => codexAccountIdentityFromSafeExecutorAccount(account, index)))).filter((identity) => identity !== null);
    const byKey = new Map();
    for (const identity of identities) {
        const existing = byKey.get(identity.key);
        if (existing) {
            existing.push(identity);
        }
        else {
            byKey.set(identity.key, [identity]);
        }
    }
    const duplicateGroups = [...byKey.values()].filter((group) => group.length > 1);
    if (duplicateGroups.length === 0)
        return;
    const firstGroup = duplicateGroups[0];
    const duplicateLabels = firstGroup.map((identity) => identity.label).join(",");
    throw new SubscriptionWorkerError("subscription_worker_start_failed", `Duplicate Codex account identity across safe executor accounts: ${duplicateLabels}. Re-login duplicate slots with different accounts or remove them from the pool.`, {
        details: {
            code: "file_backend_codex_duplicate_account_identity",
            accounts: duplicateLabels,
            identityHash: firstGroup[0].hash,
            identitySource: firstGroup[0].source,
        },
    });
}
async function codexAccountIdentityFromSafeExecutorAccount(account, index) {
    const authJson = await readSafeExecutorAccountAuthJson(account);
    if (!authJson)
        return null;
    return codexAccountIdentityFromAuthJson({
        authJson,
        label: safeExecutorAccountLabel(account, index),
    });
}
async function readSafeExecutorAccountAuthJson(account) {
    if (account.codexAuthJson !== undefined)
        return account.codexAuthJson;
    if (account.codexAuthJsonPath !== undefined) {
        return readFile(account.codexAuthJsonPath, "utf8");
    }
    return null;
}
function safeExecutorAccountLabel(account, index) {
    return (account.worker.capacityAccountId?.trim() ||
        account.worker.providerInstanceId.trim() ||
        `slot-${index + 1}`);
}
function codexAccountIdentityFromAuthJson(input) {
    const validation = validateCodexAuthJsonBytes({
        authJsonBytes: input.authJson,
    });
    const identity = resolveCodexAccountIdentity(validation.parsed);
    return {
        label: input.label,
        key: identity.key,
        hash: hashText(identity.key).slice(0, 16),
        source: identity.source,
    };
}
function resolveCodexAccountIdentity(authJson) {
    const directAccountId = firstNonEmptyString(authJson.tokens.account_id, authJson.tokens.chatgpt_account_id, authJson.account_id, authJson.chatgpt_account_id);
    if (directAccountId) {
        return {
            key: `account:${directAccountId.toLowerCase()}`,
            source: "auth_json_account_id",
        };
    }
    const idTokenClaims = decodeJwtClaims(authJson.tokens.id_token);
    if (idTokenClaims) {
        const authNamespace = objectClaim(idTokenClaims["https://api.openai.com/auth"]);
        const accountId = firstNonEmptyString(idTokenClaims["https://api.openai.com/auth.chatgpt_account_id"], idTokenClaims["chatgpt_account_id"], idTokenClaims["account_id"], authNamespace?.chatgpt_account_id, authNamespace?.account_id, idTokenClaims["sub"]);
        if (accountId) {
            return {
                key: `account:${accountId.toLowerCase()}`,
                source: "id_token_account_id",
            };
        }
        const email = firstNonEmptyString(idTokenClaims["https://api.openai.com/profile.email"], idTokenClaims["email"], authNamespace?.email);
        if (email) {
            return {
                key: `email:${email.toLowerCase()}`,
                source: "id_token_email",
            };
        }
    }
    return {
        key: `refresh:${hashText(authJson.tokens.refresh_token)}`,
        source: "refresh_token_hash",
    };
}
function decodeJwtClaims(token) {
    if (!token)
        return null;
    const parts = token.split(".");
    const payload = parts[1];
    if (!payload)
        return null;
    try {
        const decoded = Buffer.from(payload, "base64url").toString("utf8");
        const parsed = JSON.parse(decoded);
        return isRecord(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
function objectClaim(value) {
    return isRecord(value) ? value : null;
}
function firstNonEmptyString(...values) {
    for (const value of values) {
        if (typeof value !== "string")
            continue;
        const trimmed = value.trim();
        if (trimmed)
            return trimmed;
    }
    return null;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hashText(value) {
    return createHash("sha256").update(value).digest("hex");
}
//# sourceMappingURL=file-backend-codex-safe-executor.js.map