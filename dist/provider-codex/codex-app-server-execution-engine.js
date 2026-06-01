import { spawn } from "node:child_process";
import { once as onceEvent } from "node:events";
import { pruneCodexChildEnv } from "./codex-cli-domain.js";
import { resolveCodexExecutionProfile } from "./codex-execution-profile.js";
const defaultTimeoutMs = 10 * 60 * 1000;
const defaultMaxOutputBytes = 512 * 1024;
export class CodexAppServerExecutionEngine {
    options;
    kind = "app-server-pool";
    capabilities = {
        supportsStructuredOutput: true,
        supportsJsonEvents: true,
        supportsThreadResume: false,
        requiresSchemaFile: false,
    };
    executionProfile;
    slots = new Map();
    constructor(options) {
        this.options = options;
        if (!options.codexBinaryPath.trim()) {
            throw new Error("codex_app_server_binary_required");
        }
        this.executionProfile = resolveCodexExecutionProfile(options.executionProfile);
    }
    async run(input) {
        try {
            const result = await this.runViaAppServer(input);
            if (input.outputSchema) {
                return {
                    ...result,
                    structuredOutput: parseStructuredOutput(result.outputText),
                };
            }
            return result;
        }
        catch (error) {
            await this.disposeSessionSlot(input.session);
            if (input.abortSignal.aborted || isAbortLikeError(error))
                throw error;
            if (!this.options.fallback)
                throw error;
            const fallbackResult = await this.options.fallback.run(input);
            return {
                ...fallbackResult,
                warnings: [appServerFallbackWarning(error), ...fallbackResult.warnings],
            };
        }
    }
    async dispose() {
        const slots = [...this.slots.values()];
        this.slots.clear();
        await Promise.all(slots.map((slot) => slot.client.stop()));
        await this.options.fallback?.dispose?.();
    }
    async prewarm(input) {
        try {
            const slot = await this.ensureSlot(input);
            const warmupPrompt = input.warmupPrompt?.trim();
            const warnings = [];
            if (warmupPrompt) {
                const result = await slot.client.runCleanTurn({
                    prompt: warmupPrompt,
                    workspacePath: input.workspacePath,
                    model: input.model,
                    reasoningEffort: input.reasoningEffort,
                    timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
                    abortSignal: input.abortSignal,
                    prepareNext: false,
                });
                const outputText = input.redactor.redact(result.outputText);
                input.redactor.assertNoKnownSecret(outputText, "codex-app-server-prewarm-output");
                assertOutputWithinBounds(outputText, this.options.maxOutputBytes);
                warnings.push(...result.warnings);
            }
            warnings.push(...(await slot.client.prewarmCleanThread({
                workspacePath: input.workspacePath,
                model: input.model,
                reasoningEffort: input.reasoningEffort,
                timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
                abortSignal: input.abortSignal,
            })));
            return {
                kind: this.kind,
                reusable: true,
                warmedAt: new Date(),
                warnings,
            };
        }
        catch (error) {
            await this.disposeSessionSlot(input.session);
            throw error;
        }
    }
    async runViaAppServer(input) {
        const slot = await this.ensureSlot(input);
        const result = await slot.client.runCleanTurn({
            prompt: input.prompt,
            workspacePath: input.workspacePath,
            model: input.model,
            reasoningEffort: input.reasoningEffort,
            timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
            abortSignal: input.abortSignal,
        });
        const outputText = input.redactor.redact(result.outputText);
        input.redactor.assertNoKnownSecret(outputText, "codex-app-server-output");
        assertOutputWithinBounds(outputText, this.options.maxOutputBytes);
        return {
            outputText,
            warnings: result.warnings,
        };
    }
    async ensureSlot(input) {
        const key = input.session.codexHome;
        const sessionHash = input.session.sessionHash ?? null;
        const existing = this.slots.get(key);
        if (existing && existing.sessionHash === sessionHash) {
            return existing;
        }
        if (existing) {
            await existing.client.stop();
            this.slots.delete(key);
        }
        const client = new CodexAppServerClient({
            codexBinaryPath: this.options.codexBinaryPath,
            sourceEnv: this.options.sourceEnv ?? {},
            processFactory: this.options.processFactory ?? spawnCodexAppServerProcess,
            session: input.session,
            workspacePath: input.workspacePath,
            executionProfile: this.executionProfile,
            cleanThreadPrewarm: this.options.cleanThreadPrewarm ?? true,
            timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
            abortSignal: input.abortSignal,
        });
        await client.start();
        const slot = { key, client, sessionHash };
        this.slots.set(key, slot);
        return slot;
    }
    async disposeSessionSlot(session) {
        const slot = this.slots.get(session.codexHome);
        if (!slot)
            return;
        this.slots.delete(session.codexHome);
        await slot.client.stop();
    }
}
class CodexAppServerClient {
    options;
    nextId = 1;
    child = null;
    stdoutBuffer = "";
    pending = new Map();
    turns = new Map();
    serverRequests = [];
    backgroundWarnings = [];
    preparedThread = null;
    prepareThreadInFlight = null;
    exited = false;
    constructor(options) {
        this.options = options;
    }
    async start() {
        this.exited = false;
        const env = {
            ...pruneCodexChildEnv(this.options.sourceEnv),
            ...this.options.session.env,
            CI: "true",
        };
        this.child = this.options.processFactory({
            command: this.options.codexBinaryPath,
            args: ["app-server", "--listen", "stdio://"],
            cwd: this.options.session.home,
            env,
        });
        this.child.stdout.setEncoding("utf8");
        this.child.stderr.setEncoding("utf8");
        this.child.stdout.on("data", (chunk) => this.onStdout(String(chunk)));
        this.child.stderr.on("data", () => {
            // Keep stderr private. Codex may include environment or auth diagnostics.
        });
        this.child.on("exit", (code, signal) => {
            this.exited = true;
            const error = new Error(`codex_app_server_exited:${code ?? signal}`);
            for (const pending of this.pending.values()) {
                clearTimeout(pending.timer);
                pending.reject(error);
            }
            this.pending.clear();
            for (const turn of this.turns.values()) {
                turn.error = error;
                this.resolveTurn(turn);
            }
        });
        this.child.on("error", (error) => {
            for (const pending of this.pending.values()) {
                clearTimeout(pending.timer);
                pending.reject(error);
            }
            this.pending.clear();
        });
        const response = await this.send("initialize", {
            clientInfo: {
                name: "subscription-runtime",
                title: "ReviewRouter subscription runtime",
                version: "0.0.0",
            },
            capabilities: {
                experimentalApi: true,
                requestAttestation: false,
            },
        });
        if (response.error) {
            throw new Error(`codex_app_server_initialize_failed:${response.error.message ?? "unknown"}`);
        }
    }
    async runCleanTurn(input) {
        const warnings = this.drainWarnings();
        const preparedThread = this.takePreparedThread(input);
        const threadId = preparedThread?.threadId ?? (await this.startThread(input));
        const turn = await this.startTurn({ ...input, threadId }).catch(async (error) => {
            if (!preparedThread)
                throw error;
            warnings.push({
                code: "codex_app_server_prepared_thread_failed",
                safeMessage: "Codex app-server prepared thread failed; retried with a fresh thread.",
            });
            const retryThreadId = await this.startThread(input);
            return await this.startTurn({ ...input, threadId: retryThreadId });
        });
        if (turn.error)
            throw turn.error;
        if (!turn.outputText.trim()) {
            throw new Error("codex_app_server_final_message_missing");
        }
        if (input.prepareNext ?? true) {
            this.prepareCleanThreadBestEffort(input);
        }
        warnings.push(...this.drainWarnings());
        return {
            outputText: turn.outputText,
            warnings,
        };
    }
    async prewarmCleanThread(input) {
        if (!this.cleanThreadPrewarmEnabled())
            return [];
        try {
            await this.prepareCleanThreadNow(input);
            return this.drainWarnings();
        }
        catch (error) {
            return [cleanThreadPrewarmWarning(error)];
        }
    }
    async stop() {
        const child = this.child;
        this.child = null;
        if (!child)
            return;
        if (this.exited)
            return;
        signalChildGroup(child, "SIGTERM");
        const timeout = setTimeout(() => {
            signalChildGroup(child, "SIGKILL");
        }, 5_000);
        try {
            await onceEvent(child, "exit");
        }
        catch {
            // Best-effort shutdown.
        }
        finally {
            clearTimeout(timeout);
            signalChildGroup(child, "SIGKILL");
        }
    }
    drainWarnings() {
        const warnings = [...this.backgroundWarnings, ...this.serverRequests];
        this.backgroundWarnings.length = 0;
        this.serverRequests.length = 0;
        return warnings;
    }
    takePreparedThread(input) {
        const prepared = this.preparedThread;
        if (!prepared)
            return null;
        this.preparedThread = null;
        if (prepared.workspacePath !== input.workspacePath ||
            prepared.model !== input.model ||
            prepared.reasoningEffort !== input.reasoningEffort) {
            this.backgroundWarnings.push({
                code: "codex_app_server_prepared_thread_discarded",
                safeMessage: "Codex app-server discarded a prepared thread because the next task used a different runtime context.",
            });
            return null;
        }
        return prepared;
    }
    prepareCleanThreadBestEffort(input) {
        if (!this.cleanThreadPrewarmEnabled() || input.abortSignal.aborted)
            return;
        void this.prepareCleanThreadNow(input).catch((error) => {
            this.backgroundWarnings.push(cleanThreadPrewarmWarning(error));
        });
    }
    async prepareCleanThreadNow(input) {
        if (!this.cleanThreadPrewarmEnabled())
            return;
        if (this.preparedThread && this.preparedThreadMatches(input))
            return;
        if (this.prepareThreadInFlight)
            return await this.prepareThreadInFlight;
        this.prepareThreadInFlight = this.startThread(input)
            .then((threadId) => {
            this.preparedThread = {
                threadId,
                workspacePath: input.workspacePath,
                model: input.model,
                reasoningEffort: input.reasoningEffort,
            };
        })
            .finally(() => {
            this.prepareThreadInFlight = null;
        });
        await this.prepareThreadInFlight;
    }
    preparedThreadMatches(input) {
        return (this.preparedThread?.workspacePath === input.workspacePath &&
            this.preparedThread.model === input.model &&
            this.preparedThread.reasoningEffort === input.reasoningEffort);
    }
    cleanThreadPrewarmEnabled() {
        return this.options.cleanThreadPrewarm ?? true;
    }
    async startThread(input) {
        const response = await this.send("thread/start", {
            model: input.model,
            modelProvider: null,
            serviceTier: null,
            cwd: input.workspacePath,
            runtimeWorkspaceRoots: [input.workspacePath],
            approvalPolicy: "never",
            approvalsReviewer: null,
            sandbox: "read-only",
            permissions: null,
            config: {
                model_reasoning_effort: input.reasoningEffort,
                model_verbosity: "low",
                approval_policy: "never",
                sandbox_mode: "read-only",
                web_search: "disabled",
                features: {
                    apps: false,
                    hooks: false,
                    memories: false,
                    multi_agent: false,
                    shell_snapshot: false,
                    skill_mcp_dependency_install: false,
                },
                apps: {
                    _default: {
                        enabled: false,
                        destructive_enabled: false,
                        open_world_enabled: false,
                    },
                },
            },
            serviceName: "subscription-runtime",
            baseInstructions: this.options.executionProfile.baseInstructions,
            developerInstructions: this.options.executionProfile.developerInstructions,
            personality: null,
            ephemeral: true,
            sessionStartSource: "startup",
            threadSource: "user",
            environments: [],
            dynamicTools: [],
            experimentalRawEvents: false,
        }, input);
        if (response.error) {
            throw new Error(`codex_app_server_thread_start_failed:${response.error.message ?? "unknown"}`);
        }
        const threadId = nestedString(response.result, ["thread", "id"]);
        if (!threadId)
            throw new Error("codex_app_server_thread_id_missing");
        return threadId;
    }
    async startTurn(input) {
        const response = await this.send("turn/start", {
            threadId: input.threadId,
            input: [
                {
                    type: "text",
                    text: input.prompt,
                    text_elements: [],
                },
            ],
            responsesapiClientMetadata: null,
            additionalContext: null,
            environments: [],
            cwd: null,
            runtimeWorkspaceRoots: null,
            approvalPolicy: "never",
            approvalsReviewer: null,
            sandboxPolicy: null,
            permissions: null,
            model: input.model,
            serviceTier: null,
            effort: input.reasoningEffort,
            summary: "none",
            personality: null,
            outputSchema: null,
            collaborationMode: null,
        }, input);
        if (response.error) {
            throw new Error(`codex_app_server_turn_start_failed:${response.error.message ?? "unknown"}`);
        }
        const turnId = nestedString(response.result, ["turn", "id"]);
        if (!turnId)
            throw new Error("codex_app_server_turn_id_missing");
        return this.waitForTurn(turnId, input);
    }
    send(method, params, input = {}) {
        if (!this.child)
            throw new Error("codex_app_server_not_started");
        throwIfAborted(input.abortSignal);
        const id = this.nextId;
        this.nextId += 1;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`codex_app_server_request_timeout:${method}`));
            }, input.timeoutMs ?? this.options.timeoutMs);
            const abort = () => {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new Error(`codex_app_server_aborted:${method}`));
            };
            input.abortSignal?.addEventListener("abort", abort, { once: true });
            this.pending.set(id, {
                method,
                resolve: (value) => {
                    input.abortSignal?.removeEventListener("abort", abort);
                    resolve(value);
                },
                reject: (error) => {
                    input.abortSignal?.removeEventListener("abort", abort);
                    reject(error);
                },
                timer,
            });
            this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        });
    }
    waitForTurn(turnId, input) {
        const existing = this.turns.get(turnId);
        if (existing?.completed || existing?.error)
            return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.turns.delete(turnId);
                reject(new Error(`codex_app_server_turn_timeout:${turnId}`));
            }, input.timeoutMs);
            const abort = () => {
                clearTimeout(timer);
                this.turns.delete(turnId);
                reject(new Error(`codex_app_server_turn_aborted:${turnId}`));
            };
            input.abortSignal.addEventListener("abort", abort, { once: true });
            const turn = existing ?? createTurnState();
            turn.waiters.push((state) => {
                clearTimeout(timer);
                input.abortSignal.removeEventListener("abort", abort);
                this.turns.delete(turnId);
                resolve(state);
            });
            this.turns.set(turnId, turn);
        });
    }
    onStdout(chunk) {
        this.stdoutBuffer += chunk;
        const lines = this.stdoutBuffer.split(/\n/);
        this.stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            let message;
            try {
                message = JSON.parse(trimmed);
            }
            catch {
                continue;
            }
            this.onMessage(message);
        }
    }
    onMessage(message) {
        if (!message || typeof message !== "object")
            return;
        const record = message;
        if (typeof record.id === "number" &&
            ("result" in record || "error" in record)) {
            const pending = this.pending.get(record.id);
            if (!pending)
                return;
            clearTimeout(pending.timer);
            this.pending.delete(record.id);
            pending.resolve(record);
            return;
        }
        if (typeof record.id === "number" && typeof record.method === "string") {
            this.onServerRequest(record.id, record.method);
            return;
        }
        if (typeof record.method !== "string")
            return;
        const params = readRecord(record.params);
        if (record.method === "item/agentMessage/delta") {
            const turnId = stringField(params, "turnId");
            const turn = this.ensureTurn(turnId);
            turn.outputText += stringField(params, "delta") ?? "";
            return;
        }
        if (record.method === "item/completed") {
            const turnId = stringField(params, "turnId");
            const item = readRecord(params?.item);
            if (item?.type === "agentMessage" && typeof item.text === "string") {
                this.ensureTurn(turnId).outputText = item.text;
            }
            return;
        }
        if (record.method === "turn/completed") {
            const turn = readRecord(params?.turn);
            const turnId = stringField(turn, "id");
            const state = this.ensureTurn(turnId);
            state.completed = true;
            const status = readRecord(turn?.status);
            if (status?.type === "failed") {
                state.error = new Error("codex_app_server_turn_failed");
            }
            this.resolveTurn(state);
            return;
        }
        if (record.method === "error") {
            const turnId = stringField(params, "turnId");
            const error = new Error(`codex_app_server_error:${safeMessage(params?.error ?? params ?? record)}`);
            if (!turnId) {
                for (const turn of this.turns.values()) {
                    turn.error = error;
                    this.resolveTurn(turn);
                }
                return;
            }
            const turn = this.ensureTurn(turnId);
            turn.error = error;
            this.resolveTurn(turn);
        }
    }
    onServerRequest(id, method) {
        this.serverRequests.push({
            code: "codex_app_server_unsupported_request",
            safeMessage: `Codex app-server requested unsupported client method: ${method}`,
        });
        this.child?.stdin.write(`${JSON.stringify({
            id,
            error: {
                code: -32000,
                message: `unsupported_server_request:${method}`,
            },
        })}\n`);
    }
    ensureTurn(turnId) {
        if (!turnId)
            return createTurnState();
        let turn = this.turns.get(turnId);
        if (!turn) {
            turn = createTurnState();
            this.turns.set(turnId, turn);
        }
        return turn;
    }
    resolveTurn(turn) {
        const waiters = turn.waiters.splice(0);
        for (const waiter of waiters)
            waiter(turn);
    }
}
function spawnCodexAppServerProcess(input) {
    const child = spawn(input.command, input.args, {
        cwd: input.cwd,
        env: input.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
    });
    return child;
}
function createTurnState() {
    return {
        outputText: "",
        completed: false,
        error: null,
        waiters: [],
    };
}
function appServerFallbackWarning(error) {
    return {
        code: "codex_app_server_fallback",
        safeMessage: `Codex app-server failed; used codex exec fallback: ${safeMessage(error)}`,
    };
}
function cleanThreadPrewarmWarning(error) {
    return {
        code: "codex_app_server_clean_thread_prewarm_failed",
        safeMessage: `Codex app-server clean thread prewarm failed: ${safeMessage(error)}`,
    };
}
function signalChildGroup(child, signal) {
    try {
        if (process.platform === "win32" || !child.pid) {
            child.kill(signal);
            return;
        }
        process.kill(-child.pid, signal);
    }
    catch {
        try {
            child.kill(signal);
        }
        catch {
            // Process may already be gone.
        }
    }
}
function nestedString(value, path) {
    let current = value;
    for (const segment of path) {
        const record = readRecord(current);
        current = record?.[segment];
    }
    return typeof current === "string" ? current : null;
}
function readRecord(value) {
    return value && typeof value === "object"
        ? value
        : null;
}
function stringField(record, field) {
    const value = record?.[field];
    return typeof value === "string" ? value : null;
}
function parseStructuredOutput(outputText) {
    try {
        return JSON.parse(outputText);
    }
    catch (error) {
        throw new Error("codex_app_server_structured_output_invalid", {
            cause: error,
        });
    }
}
function assertOutputWithinBounds(output, maxOutputBytes = defaultMaxOutputBytes) {
    if (Buffer.byteLength(output, "utf8") > maxOutputBytes) {
        throw new Error("codex_app_server_output_too_large");
    }
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw new Error("codex_app_server_aborted");
}
function isAbortLikeError(error) {
    return (error instanceof Error &&
        (error.message.includes("codex_app_server_aborted") ||
            error.message.includes("codex_app_server_turn_aborted") ||
            error.message.includes("node_process_runner_aborted")));
}
function safeMessage(error) {
    if (error instanceof Error)
        return error.message.slice(-1000);
    if (typeof error === "string")
        return error.slice(-1000);
    const record = readRecord(error);
    if (typeof record?.message === "string")
        return record.message.slice(-1000);
    const nested = record ? readRecord(record.error) : null;
    if (typeof nested?.message === "string")
        return nested.message.slice(-1000);
    return "unknown";
}
//# sourceMappingURL=codex-app-server-execution-engine.js.map