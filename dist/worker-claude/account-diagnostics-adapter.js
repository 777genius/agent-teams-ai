import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hashProviderAccountKey, parseLimitResetFromText, shortAccountHash, } from "../account-diagnostics/index.js";
import { classifyClaudeRuntimeFailure } from "../provider-claude/index.js";
export function createClaudeAccountRegistry(accounts) {
    return {
        async listAccounts() {
            return accounts;
        },
    };
}
export async function discoverClaudeConfigAccounts(input) {
    const explicit = input.accounts ?? [];
    if (!input.rootDir)
        return explicit;
    const rootDir = resolve(input.rootDir);
    let entries = [];
    try {
        entries = await readdir(rootDir, { withFileTypes: true });
    }
    catch {
        return explicit;
    }
    const discovered = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const configDir = join(rootDir, entry.name);
        if (!(await directoryExists(configDir)))
            continue;
        const capacityAccountId = input.capacityAccountIds?.[entry.name];
        discovered.push({
            provider: "claude",
            slotId: entry.name,
            providerInstanceId: `claude:${entry.name}`,
            configDir,
            ...(capacityAccountId ? { capacityAccountId } : {}),
            ...(input.claudePath ? { claudePath: input.claudePath } : {}),
        });
    }
    return [...explicit, ...discovered];
}
export function createClaudeIdentityReader() {
    return {
        async readIdentity(input) {
            const accountKey = input.account.capacityAccountId ?? input.account.metadata?.quotaGroup;
            const accountKeyHash = accountKey
                ? hashProviderAccountKey({
                    provider: "claude",
                    accountKey,
                })
                : undefined;
            return {
                identity: {
                    safeIdentity: accountKeyHash
                        ? `claude:${shortAccountHash(accountKeyHash)}`
                        : `claude:${input.account.slotId}`,
                    ...(accountKeyHash ? { accountKeyHash } : {}),
                    ...(accountKey ? { providerAccountId: accountKey } : {}),
                },
            };
        },
    };
}
export function createClaudeAccountHealthProbe(input = {}) {
    const runner = input.runner ?? runClaudeDiagnosticCommand;
    return {
        async probeAccount(probeInput) {
            const plan = await buildClaudeProbePlan({
                account: probeInput.account,
                mode: probeInput.mode,
                claudePath: probeInput.account.claudePath ?? input.claudePath ?? "claude",
            });
            try {
                const result = await runner({
                    ...plan,
                    ...(probeInput.timeoutMs ? { timeoutMs: probeInput.timeoutMs } : {}),
                });
                return claudeDiagnosticSignalFromProcessResult({
                    result,
                    now: probeInput.now,
                    source: probeInput.mode === "health" ? "health" : "live_probe",
                });
            }
            finally {
                await plan.cleanup?.();
            }
        },
    };
}
export function claudeDiagnosticSignalFromProcessResult(input) {
    const source = input.source ?? "live_probe";
    if (input.result.timedOut) {
        return {
            availability: "unhealthy",
            source,
            reason: "probe_timeout",
            checkedAt: input.now,
        };
    }
    if (input.result.exitCode === 0) {
        return {
            availability: "available",
            source,
            checkedAt: input.now,
        };
    }
    const text = `${input.result.stdout}\n${input.result.stderr}`;
    const state = classifyClaudeRuntimeFailure(text);
    if (state === "needs_reconnect") {
        return {
            availability: "reconnect_required",
            source,
            reason: state,
            reconnectRequired: true,
            checkedAt: input.now,
        };
    }
    if (state === "quota_limited") {
        const reset = parseLimitResetFromText({ text, now: input.now });
        return {
            availability: "limited",
            source,
            reason: state,
            checkedAt: input.now,
            ...(reset.limitResetAt ? { limitResetAt: reset.limitResetAt } : {}),
            ...(reset.rawResetText ? { rawResetText: reset.rawResetText } : {}),
        };
    }
    return {
        availability: "unhealthy",
        source,
        reason: state,
        checkedAt: input.now,
    };
}
async function buildClaudeProbePlan(input) {
    const cwd = await mkdtemp(join(tmpdir(), "subscription-runtime-claude-diagnostic-"));
    const env = {
        PATH: process.env.PATH ?? "",
        ...(input.account.configDir ? { CLAUDE_CONFIG_DIR: input.account.configDir } : {}),
    };
    if (input.mode === "health") {
        return {
            command: input.claudePath,
            args: ["--version"],
            cwd,
            env,
            cleanup: async () => {
                await rm(cwd, { recursive: true, force: true });
            },
        };
    }
    return {
        command: input.claudePath,
        args: ["--print", "Reply with exactly: OK"],
        cwd,
        env,
        cleanup: async () => {
            await rm(cwd, { recursive: true, force: true });
        },
    };
}
function runClaudeDiagnosticCommand(input) {
    return new Promise((resolvePromise) => {
        const child = spawn(input.command, [...input.args], {
            cwd: input.cwd,
            env: input.env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout = [];
        const stderr = [];
        let timedOut = false;
        const timeout = input.timeoutMs !== undefined
            ? setTimeout(() => {
                timedOut = true;
                child.kill("SIGTERM");
            }, input.timeoutMs)
            : null;
        child.stdout.on("data", (chunk) => {
            stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        child.stderr.on("data", (chunk) => {
            stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        child.on("error", (error) => {
            if (timeout)
                clearTimeout(timeout);
            resolvePromise({
                exitCode: null,
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: `${Buffer.concat(stderr).toString("utf8")}\n${error.message}`,
                timedOut,
            });
        });
        child.on("close", (exitCode) => {
            if (timeout)
                clearTimeout(timeout);
            resolvePromise({
                exitCode,
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8"),
                timedOut,
            });
        });
        if (input.stdin)
            child.stdin.end(input.stdin);
        else
            child.stdin.end();
    });
}
async function directoryExists(path) {
    try {
        const info = await stat(path);
        return info.isDirectory();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=account-diagnostics-adapter.js.map