#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentTaskProtocolVersion, agentTaskRequestToProviderTask, parseAgentTaskRequest, providerTaskResultToAgentTaskResult, } from "@vioxen/subscription-runtime/agent-task";
import { isSubscriptionWorkerError, } from "@vioxen/subscription-runtime/worker-core";
import { FileBackendClaudeWorker, } from "../worker-claude/file-backend-claude-worker.js";
import { FileBackendCodexWorker, } from "../worker-codex/file-backend-codex-worker.js";
export async function runSubscriptionAgentTaskCli(argv = process.argv.slice(2), io = defaultIo, workerFactory = createDefaultWorker) {
    let tempStateRoot = null;
    try {
        const args = parseArgs(argv);
        const request = parseAgentTaskRequest(JSON.parse(args.inputPath ? await readFile(args.inputPath, "utf8") : await io.readStdin()));
        const cwd = await resolveRequestCwd(io.cwd(), request.cwd ?? ".");
        const env = io.env();
        const workerEnv = args.provider === "claude" ? pruneClaudeChildEnv(env) : env;
        const stateRootDir = args.stateRootDir ??
            (args.ephemeral
                ? (tempStateRoot = await mkdtemp(join(tmpdir(), "subscription-runtime-agent-task-")))
                : env.SUBSCRIPTION_RUNTIME_STATE_ROOT);
        if (!stateRootDir) {
            throw new Error("--state-root is required unless --ephemeral or SUBSCRIPTION_RUNTIME_STATE_ROOT is set");
        }
        const encryptionKey = args.ephemeral
            ? randomBytes(32)
            : requiredEnv(env, args.encryptionKeyEnv);
        const providerInstanceId = args.providerInstanceId ??
            request.providerInstanceId ??
            `${args.provider}:default`;
        const timeoutMs = args.timeoutMs ?? request.timeoutMs;
        const worker = workerFactory({
            provider: args.provider,
            stateRootDir,
            providerInstanceId,
            encryptionKey,
            cwd,
            env: workerEnv,
            ...(args.model ? { model: args.model } : {}),
            ...(timeoutMs ? { timeoutMs } : {}),
            ...(args.claudePath ? { claudePath: args.claudePath } : {}),
            ...(env.CLAUDE_RUNTIME_DIST_DIR
                ? { claudeRuntimeDistDir: env.CLAUDE_RUNTIME_DIST_DIR }
                : {}),
            ...(args.codexBinaryPath ? { codexBinaryPath: args.codexBinaryPath } : {}),
        });
        try {
            await worker.start();
            await seedWorker({ args, env, worker });
            const result = await runWorkerTask({ request, worker });
            await emitResult({ request, result, format: args.format, io });
            return result.status === "completed" ? 0 : 1;
        }
        finally {
            await worker.dispose?.();
        }
    }
    catch (error) {
        const safeMessage = error instanceof Error ? error.message : "subscription runtime agent task failed";
        if (requestedOutputFormat(argv) === "result-json") {
            io.writeStdout(`${JSON.stringify(makeCliFailedAgentTaskResult({
                code: "unknown_runtime_failure",
                safeMessage,
                retryable: false,
                ...optionalFailureDetails(errorDetails(error)),
            }))}\n`);
        }
        io.writeStderr(`${safeMessage}\n`);
        return 2;
    }
    finally {
        if (tempStateRoot) {
            await rm(tempStateRoot, { recursive: true, force: true }).catch(() => { });
        }
    }
}
function requestedOutputFormat(argv) {
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] !== "--format")
            continue;
        const value = argv[index + 1];
        return value === "result-json" ? "result-json" : "event-ndjson";
    }
    return "event-ndjson";
}
export async function resolveRequestCwd(workspaceRoot, requestedCwd) {
    const root = await realpath(resolve(workspaceRoot));
    let resolved;
    try {
        resolved = await realpath(resolve(root, requestedCwd));
    }
    catch {
        throw new Error("Agent task cwd must stay within the current workspace.");
    }
    const rel = relative(root, resolved);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
        return resolved;
    }
    throw new Error("Agent task cwd must stay within the current workspace.");
}
export function pruneClaudeChildEnv(env) {
    const allowed = new Set([
        "CI",
        "CLAUDE_CONFIG_DIR",
        "HOME",
        "LANG",
        "LC_ALL",
        "PATH",
        "TEMP",
        "TMP",
        "TMPDIR",
    ]);
    return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined &&
        (allowed.has(key) || key.startsWith("LC_"))));
}
function parseArgs(argv) {
    let provider = null;
    let inputPath;
    let format = "event-ndjson";
    let stateRootDir;
    let providerInstanceId;
    let encryptionKeyEnv = "SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY";
    let ephemeral = false;
    let claudeTokenEnv = "CLAUDE_CODE_OAUTH_TOKEN";
    let codexAuthJsonPath;
    let codexAuthJsonEnv = "CODEX_AUTH_JSON_PATH";
    let claudePath;
    let codexBinaryPath;
    let model;
    let timeoutMs;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--provider") {
            const value = requiredValue(argv, index, arg);
            if (value !== "claude" && value !== "codex") {
                throw new Error("--provider must be claude or codex");
            }
            provider = value;
            index += 1;
            continue;
        }
        if (arg === "--input") {
            inputPath = requiredValue(argv, index, arg);
            index += 1;
            continue;
        }
        if (arg === "--format") {
            const value = requiredValue(argv, index, arg);
            if (value !== "event-ndjson" && value !== "result-json") {
                throw new Error("--format must be event-ndjson or result-json");
            }
            format = value;
            index += 1;
            continue;
        }
        if (arg === "--state-root") {
            stateRootDir = requiredValue(argv, index, arg);
            index += 1;
            continue;
        }
        if (arg === "--provider-instance") {
            providerInstanceId = requiredValue(argv, index, arg);
            index += 1;
            continue;
        }
        if (arg === "--encryption-key-env") {
            encryptionKeyEnv = requiredValue(argv, index, arg);
            index += 1;
            continue;
        }
        if (arg === "--ephemeral") {
            ephemeral = true;
            continue;
        }
        if (arg === "--claude-token-env") {
            claudeTokenEnv = requiredValue(argv, index, arg);
            index += 1;
            continue;
        }
        if (arg === "--codex-auth-json") {
            codexAuthJsonPath = requiredValue(argv, index, arg);
            index += 1;
            continue;
        }
        if (arg === "--codex-auth-json-env") {
            codexAuthJsonEnv = requiredValue(argv, index, arg);
            index += 1;
            continue;
        }
        if (arg === "--claude-path") {
            claudePath = requiredValue(argv, index, arg);
            index += 1;
            continue;
        }
        if (arg === "--codex-binary") {
            codexBinaryPath = requiredValue(argv, index, arg);
            index += 1;
            continue;
        }
        if (arg === "--model") {
            model = requiredValue(argv, index, arg);
            index += 1;
            continue;
        }
        if (arg === "--timeout-ms") {
            timeoutMs = parsePositiveInteger(requiredValue(argv, index, arg), arg);
            index += 1;
            continue;
        }
        if (arg === "--help" || arg === "-h") {
            throw new Error(usage());
        }
        throw new Error(`unknown argument: ${arg}`);
    }
    if (!provider)
        throw new Error("--provider is required");
    return {
        provider,
        ...(inputPath ? { inputPath } : {}),
        format,
        ...(stateRootDir ? { stateRootDir } : {}),
        ...(providerInstanceId ? { providerInstanceId } : {}),
        encryptionKeyEnv,
        ephemeral,
        claudeTokenEnv,
        ...(codexAuthJsonPath ? { codexAuthJsonPath } : {}),
        codexAuthJsonEnv,
        ...(claudePath ? { claudePath } : {}),
        ...(codexBinaryPath ? { codexBinaryPath } : {}),
        ...(model ? { model } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
    };
}
function createDefaultWorker(input) {
    if (input.provider === "claude") {
        const runtimeModules = claudeRuntimeModuleLoaders(input.claudeRuntimeDistDir);
        return new FileBackendClaudeWorker({
            providerInstanceId: input.providerInstanceId,
            stateRootDir: input.stateRootDir,
            encryptionKey: input.encryptionKey,
            baseEnv: input.env,
            workspacePath: input.cwd,
            ...(input.model ? { model: input.model } : {}),
            ...(input.timeoutMs ? { taskTimeoutMs: input.timeoutMs } : {}),
            ...(input.claudePath ? { claudePath: input.claudePath } : {}),
            ...runtimeModules,
        });
    }
    return new FileBackendCodexWorker({
        providerInstanceId: input.providerInstanceId,
        stateRootDir: input.stateRootDir,
        encryptionKey: input.encryptionKey,
        codexBinaryPath: input.codexBinaryPath ?? "codex",
        sourceEnv: input.env,
        workspacePath: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        ...(input.timeoutMs ? { taskTimeoutMs: input.timeoutMs } : {}),
    });
}
function claudeRuntimeModuleLoaders(distDir) {
    if (!distDir)
        return {};
    const resolvedDistDir = resolve(distDir);
    const runtimePath = join(resolvedDistDir, "index.js");
    const providerPath = join(resolvedDistDir, "infrastructure", "claude-bg", "provider", "index.js");
    if (!existsSync(runtimePath) || !existsSync(providerPath)) {
        throw new Error("CLAUDE_RUNTIME_DIST_DIR must contain index.js and infrastructure/claude-bg/provider/index.js.");
    }
    return {
        runtimeModuleLoader: async () => import(pathToFileURL(runtimePath).href),
        providerModuleLoader: async () => import(pathToFileURL(providerPath).href),
    };
}
async function seedWorker(input) {
    if (input.args.provider === "claude") {
        const token = input.env[input.args.claudeTokenEnv];
        if (token) {
            if (!input.worker.seedClaudeOAuth) {
                throw new Error("selected worker does not support Claude OAuth seeding");
            }
            await input.worker.seedClaudeOAuth({ oauthToken: token });
        }
        return;
    }
    const authJsonPath = input.args.codexAuthJsonPath ?? input.env[input.args.codexAuthJsonEnv];
    if (authJsonPath) {
        if (!input.worker.seedCodexAuthJsonFile) {
            throw new Error("selected worker does not support Codex auth seeding");
        }
        await input.worker.seedCodexAuthJsonFile(authJsonPath);
    }
}
async function runWorkerTask(input) {
    const task = agentTaskRequestToProviderTask(input.request);
    try {
        const result = await input.worker.run({
            runId: input.request.runId ?? `agent-task-${randomUUID()}`,
            prompt: task.prompt,
            ...(task.systemPrompt !== undefined ? { systemPrompt: task.systemPrompt } : {}),
            kind: task.kind,
            ...(task.outputSchemaName ? { outputSchemaName: task.outputSchemaName } : {}),
            ...(task.controls ? { controls: task.controls } : {}),
            ...(task.metadata ? { metadata: task.metadata } : {}),
            abortSignal: new AbortController().signal,
        });
        return providerTaskResultToAgentTaskResult(toProviderTaskResult(result));
    }
    catch (error) {
        return makeCliFailedAgentTaskResult({
            code: "unknown_runtime_failure",
            safeMessage: error instanceof Error ? error.message : "subscription worker task failed",
            ...optionalFailureDetails(errorDetails(error)),
        });
    }
}
async function emitResult(input) {
    if (input.format === "result-json") {
        input.io.writeStdout(`${JSON.stringify(input.result)}\n`);
        return;
    }
    const started = {
        protocolVersion: agentTaskProtocolVersion,
        type: "started",
        occurredAt: new Date().toISOString(),
    };
    const completed = {
        protocolVersion: agentTaskProtocolVersion,
        type: "completed",
        occurredAt: new Date().toISOString(),
        result: input.result,
    };
    input.io.writeStdout(`${JSON.stringify(started)}\n`);
    input.io.writeStdout(`${JSON.stringify(completed)}\n`);
}
function toProviderTaskResult(result) {
    if (result.status === "waiting_for_input") {
        if (!result.runId || !result.request || !result.resumeHandle) {
            throw new Error("agent_task_waiting_result_invalid");
        }
        return {
            status: "waiting_for_input",
            runId: result.runId,
            outputText: result.outputText,
            ...(result.structuredOutput === undefined
                ? {}
                : { structuredOutput: result.structuredOutput }),
            request: result.request,
            resumeHandle: result.resumeHandle,
            ...(result.telemetry ? { telemetry: result.telemetry } : {}),
            warnings: result.warnings,
        };
    }
    return {
        status: "completed",
        outputText: result.outputText,
        ...(result.structuredOutput === undefined
            ? {}
            : { structuredOutput: result.structuredOutput }),
        ...(result.telemetry ? { telemetry: result.telemetry } : {}),
        warnings: result.warnings,
    };
}
function makeCliFailedAgentTaskResult(input) {
    return {
        protocolVersion: agentTaskProtocolVersion,
        status: "failed",
        failure: {
            code: input.code,
            retryable: input.retryable ?? false,
            reconnectRequired: input.reconnectRequired ?? false,
            safeMessage: input.safeMessage,
            ...(input.causeCategory ? { causeCategory: input.causeCategory } : {}),
            ...(input.details ? { details: input.details } : {}),
        },
        warnings: [],
    };
}
function errorDetails(error) {
    const details = {};
    for (const item of errorChain(error)) {
        mergeStringDetails(details, objectDetails(item));
        if (isSubscriptionWorkerError(item)) {
            details.subscriptionWorkerCode ??= item.code;
            mergeStringDetails(details, item.details);
        }
        if (isObject(item) && typeof item["code"] === "string") {
            details.subscriptionWorkerCode ??= item["code"];
        }
        if (isObject(item)) {
            const exitCode = item["exitCode"];
            if (typeof exitCode === "number" || typeof exitCode === "string") {
                details.exitCode ??= String(exitCode);
            }
            const stderr = item["stderr"];
            if (typeof stderr === "string" && stderr.trim()) {
                details.stderrTail ??= safeDetailTail(stderr);
            }
            const stdout = item["stdout"];
            if (typeof stdout === "string" && stdout.trim()) {
                details.stdoutTail ??= safeDetailTail(stdout);
            }
        }
        const message = item instanceof Error ? item.message : undefined;
        const match = message?.match(/(?:codex_json_exec_failed|node_process_runner_failed):(\d+):(.*)$/s);
        if (match) {
            details.exitCode ??= match[1];
            if (match[2]?.trim()) {
                details.stderrTail ??= safeDetailTail(match[2]);
            }
        }
    }
    return Object.keys(details).length === 0 ? undefined : details;
}
function errorChain(error) {
    const chain = [];
    let current = error;
    const seen = new Set();
    while (current !== undefined && current !== null && !seen.has(current)) {
        chain.push(current);
        seen.add(current);
        current = isObject(current) ? current["cause"] : undefined;
    }
    return chain;
}
function objectDetails(value) {
    if (!isObject(value))
        return undefined;
    const details = value["details"];
    if (!isObject(details))
        return undefined;
    const parsed = {};
    mergeStringDetails(parsed, details);
    return Object.keys(parsed).length === 0 ? undefined : parsed;
}
function mergeStringDetails(target, details) {
    if (!details)
        return;
    for (const [key, value] of Object.entries(details)) {
        if (typeof value !== "string")
            continue;
        if (!value.trim())
            continue;
        target[key] ??= safeDetailTail(value);
    }
}
function optionalFailureDetails(details) {
    return details === undefined || Object.keys(details).length === 0
        ? {}
        : { details };
}
function safeDetailTail(value) {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length <= 800 ? normalized : normalized.slice(-800);
}
function isObject(value) {
    return typeof value === "object" && value !== null;
}
function requiredValue(argv, index, flag) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}
function requiredEnv(env, name) {
    const value = env[name];
    if (!value)
        throw new Error(`${name} is required`);
    return value;
}
function parsePositiveInteger(value, flag) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${flag} must be a positive integer`);
    }
    return parsed;
}
function usage() {
    return [
        "usage: subscription-runtime-run-agent-task --provider claude|codex [--input request.json]",
        "       [--format event-ndjson|result-json] [--state-root dir | --ephemeral]",
        "       [--provider-instance id] [--model model] [--timeout-ms ms]",
    ].join("\n");
}
const defaultIo = {
    async readStdin() {
        const chunks = [];
        for await (const chunk of process.stdin) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString("utf8");
    },
    writeStdout(chunk) {
        process.stdout.write(chunk);
    },
    writeStderr(chunk) {
        process.stderr.write(chunk);
    },
    cwd() {
        return process.cwd();
    },
    env() {
        return process.env;
    },
};
if (await isMainModule()) {
    process.exitCode = await runSubscriptionAgentTaskCli();
}
async function isMainModule() {
    if (!process.argv[1])
        return false;
    const modulePath = fileURLToPath(import.meta.url);
    try {
        return (await realpath(modulePath)) === (await realpath(process.argv[1]));
    }
    catch {
        return modulePath === process.argv[1];
    }
}
//# sourceMappingURL=agent-task-runner-cli.js.map