import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { hashProviderAccountKey, maskEmail, parseLimitResetFromText, shortAccountHash, } from "../account-diagnostics/index.js";
import { classifyCodexRuntimeFailure, readCodexAuthJsonFreshness, validateCodexAuthJsonBytes, } from "../provider-codex/index.js";
export function createCodexAccountRegistry(accounts) {
    return {
        async listAccounts() {
            return accounts;
        },
    };
}
export async function discoverCodexAuthJsonAccounts(input) {
    const explicit = input.accounts ?? [];
    if (!input.rootDir)
        return explicit;
    const rootDir = resolve(input.rootDir);
    const discovered = [];
    const rootAuthPath = join(rootDir, "auth.json");
    if (await fileExists(rootAuthPath)) {
        const slotId = basename(rootDir);
        const capacityAccountId = input.capacityAccountIds?.[slotId];
        discovered.push(accountFromAuthPath({
            slotId,
            authJsonPath: rootAuthPath,
            codexHome: rootDir,
            ...(capacityAccountId ? { capacityAccountId } : {}),
            ...(input.codexBinaryPath ? { codexBinaryPath: input.codexBinaryPath } : {}),
        }));
    }
    let entries = [];
    try {
        entries = await readdir(rootDir, { withFileTypes: true });
    }
    catch {
        return explicit;
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const codexHome = join(rootDir, entry.name);
        const authJsonPath = join(codexHome, "auth.json");
        if (!(await fileExists(authJsonPath)))
            continue;
        const capacityAccountId = input.capacityAccountIds?.[entry.name];
        discovered.push(accountFromAuthPath({
            slotId: entry.name,
            authJsonPath,
            codexHome,
            ...(capacityAccountId ? { capacityAccountId } : {}),
            ...(input.codexBinaryPath ? { codexBinaryPath: input.codexBinaryPath } : {}),
        }));
    }
    return [...explicit, ...discovered];
}
export function createCodexAuthJsonIdentityReader() {
    return {
        async readIdentity(input) {
            return readCodexIdentity(input.account, input.now);
        },
    };
}
export function createCodexAccountHealthProbe(input = {}) {
    const runner = input.runner ?? runCodexDiagnosticCommand;
    return {
        async probeAccount(probeInput) {
            const plan = await buildCodexProbePlan({
                account: probeInput.account,
                mode: probeInput.mode,
                codexBinaryPath: probeInput.account.codexBinaryPath ?? input.codexBinaryPath ?? "codex",
            });
            try {
                const result = await runner({
                    ...plan,
                    ...(probeInput.timeoutMs ? { timeoutMs: probeInput.timeoutMs } : {}),
                });
                return codexDiagnosticSignalFromProcessResult({
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
export function codexDiagnosticSignalFromProcessResult(input) {
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
    const state = classifyCodexRuntimeFailure(text);
    if (state === "provider_session_invalid" || state === "needs_reconnect") {
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
    if (state === "permission_required") {
        return {
            availability: "unhealthy",
            source,
            reason: state,
            checkedAt: input.now,
        };
    }
    return {
        availability: "unhealthy",
        source,
        reason: state,
        checkedAt: input.now,
    };
}
async function readCodexIdentity(account, now) {
    let authJsonBytes;
    try {
        authJsonBytes = await readFile(account.authJsonPath, "utf8");
    }
    catch {
        return {
            identity: {
                safeIdentity: `codex:${account.slotId}`,
            },
            signal: {
                availability: "auth_unknown",
                source: "cached",
                reason: "auth_json_missing",
                checkedAt: now,
            },
        };
    }
    try {
        const validation = validateCodexAuthJsonBytes({
            authJsonBytes,
            now,
        });
        const freshness = readCodexAuthJsonFreshness({
            authJsonBytes,
            now,
        });
        const claims = decodeJwtPayload(validation.parsed.tokens.id_token);
        const providerAccountId = firstString([
            validation.parsed.tokens.account_id,
            validation.parsed.tokens.chatgpt_account_id,
            validation.parsed.account_id,
            validation.parsed.chatgpt_account_id,
            claims?.account_id,
            claims?.chatgpt_account_id,
            claims?.["https://api.openai.com/auth.chatgpt_account_id"],
            claims?.sub,
        ]);
        const email = firstString([
            claims?.email,
            claims?.["https://api.openai.com/auth.email"],
            validation.parsed.email,
        ]);
        const accountKeyHash = providerAccountId
            ? hashProviderAccountKey({
                provider: "codex",
                accountKey: providerAccountId,
            })
            : undefined;
        const warnings = [...new Set([...validation.warnings, ...freshness.warnings])];
        return {
            identity: {
                safeIdentity: email
                    ? maskEmail(email)
                    : `codex:${accountKeyHash ? shortAccountHash(accountKeyHash) : account.slotId}`,
                ...(accountKeyHash ? { accountKeyHash } : {}),
                ...(providerAccountId ? { providerAccountId } : {}),
                ...(warnings.length ? { warnings } : {}),
            },
        };
    }
    catch (error) {
        return {
            identity: {
                safeIdentity: `codex:${account.slotId}`,
            },
            signal: {
                availability: "auth_unknown",
                source: "cached",
                reason: error instanceof Error ? error.message : "auth_json_invalid",
                checkedAt: now,
            },
        };
    }
}
function accountFromAuthPath(input) {
    return {
        provider: "codex",
        slotId: input.slotId,
        providerInstanceId: `codex:${input.slotId}`,
        authJsonPath: input.authJsonPath,
        ...(input.codexHome ? { codexHome: input.codexHome } : {}),
        ...(input.capacityAccountId
            ? { capacityAccountId: input.capacityAccountId }
            : {}),
        ...(input.codexBinaryPath ? { codexBinaryPath: input.codexBinaryPath } : {}),
    };
}
async function buildCodexProbePlan(input) {
    const codexHome = input.account.codexHome ?? dirname(input.account.authJsonPath);
    const baseEnv = {
        PATH: process.env.PATH ?? "",
        HOME: dirname(codexHome),
        CODEX_HOME: codexHome,
        REVIEWROUTER_CODEX_AUTH_PATH: input.account.authJsonPath,
    };
    if (input.mode === "health") {
        return {
            command: input.codexBinaryPath,
            args: ["login", "status"],
            cwd: codexHome,
            env: baseEnv,
        };
    }
    const cwd = await mkdtemp(join(tmpdir(), "subscription-runtime-codex-diagnostic-"));
    await mkdir(cwd, { recursive: true });
    return {
        command: input.codexBinaryPath,
        args: [
            "exec",
            "--sandbox",
            "read-only",
            "--ignore-rules",
            "--ephemeral",
            "-C",
            cwd,
            "--skip-git-repo-check",
            "-",
        ],
        cwd,
        env: baseEnv,
        stdin: "Reply with exactly: OK",
        cleanup: async () => {
            await rm(cwd, { recursive: true, force: true });
        },
    };
}
function runCodexDiagnosticCommand(input) {
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
async function fileExists(path) {
    try {
        const info = await stat(path);
        return info.isFile();
    }
    catch {
        return false;
    }
}
function decodeJwtPayload(token) {
    if (!token)
        return null;
    const payload = token.split(".")[1];
    if (!payload)
        return null;
    try {
        return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    }
    catch {
        return null;
    }
}
function firstString(values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim())
            return value.trim();
    }
    return undefined;
}
//# sourceMappingURL=account-diagnostics-adapter.js.map