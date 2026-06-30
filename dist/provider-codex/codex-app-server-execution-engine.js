import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once as onceEvent } from "node:events";
import { pruneCodexChildEnv } from "./codex-cli-domain.js";
import { resolveCodexExecutionProfile } from "./codex-execution-profile.js";
import { parseCodexStructuredOutput } from "./structured-output.js";
const defaultTimeoutMs = 10 * 60 * 1000;
const defaultControlRequestTimeoutMs = 30 * 1000;
const defaultReconnectGraceMs = 10 * 60 * 1000;
const defaultMaxOutputBytes = 512 * 1024;
const defaultMaxGoalTurns = 20;
const defaultGoalContinuePrompt = "Continue working toward the active goal. If the goal is complete, mark it complete and summarize the result.";
function normalizeSystemPrompt(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}
function mergeDeveloperInstructions(input) {
    const systemPrompt = normalizeSystemPrompt(input.systemPrompt);
    if (!systemPrompt)
        return input.base;
    if (!input.base)
        return systemPrompt;
    return `${input.base}\n\n${systemPrompt}`;
}
export class CodexAppServerExecutionEngine {
    options;
    kind;
    capabilities = {
        supportsStructuredOutput: true,
        supportsJsonEvents: true,
        supportsThreadResume: false,
        requiresSchemaFile: false,
    };
    executionProfile;
    runStore;
    slots = new Map();
    constructor(options) {
        this.options = options;
        if (!options.codexBinaryPath.trim()) {
            throw new Error("codex_app_server_binary_required");
        }
        this.kind = options.goalMode ? "app-server-goal" : "app-server-pool";
        this.executionProfile = resolveCodexExecutionProfile(options.executionProfile);
        this.runStore = options.runStore ?? new InMemoryManagedRunStore();
    }
    async run(input) {
        try {
            const result = await this.runViaAppServer(input);
            if (result.status === "waiting_for_input")
                return result;
            if (input.outputSchema) {
                try {
                    return {
                        ...result,
                        structuredOutput: parseStructuredOutput(result.outputText),
                    };
                }
                catch (error) {
                    await this.failManagedRunForProviderOutput(input.runId);
                    throw error;
                }
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
    async resume(input) {
        try {
            const result = await this.resumeViaAppServer(input);
            if (result.status === "waiting_for_input")
                return result;
            if (input.outputSchema) {
                try {
                    return {
                        ...result,
                        structuredOutput: parseStructuredOutput(result.outputText),
                    };
                }
                catch (error) {
                    await this.failManagedRunForProviderOutput(input.runId);
                    throw error;
                }
            }
            return result;
        }
        catch (error) {
            if (!isManagedRunResumeValidationError(error)) {
                await this.disposeSessionSlot(input.session);
            }
            throw error;
        }
    }
    async failManagedRunForProviderOutput(runId) {
        if (!this.options.goalMode || !runId)
            return;
        await this.runStore.fail({
            runId,
            failure: {
                code: "provider_output_invalid",
                retryable: true,
                reconnectRequired: false,
                safeMessage: "Codex provider output was invalid.",
            },
            now: new Date(),
        }).catch(() => undefined);
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
                    ...(input.serviceTier === undefined
                        ? {}
                        : { serviceTier: input.serviceTier }),
                    sandboxMode: "read-only",
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
                ...(input.serviceTier === undefined
                    ? {}
                    : { serviceTier: input.serviceTier }),
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
        const common = {
            ...(input.runId !== undefined ? { runId: input.runId } : {}),
            prompt: input.prompt,
            ...(input.goalObjective !== undefined
                ? { goalObjective: input.goalObjective }
                : {}),
            ...(input.systemPrompt !== undefined
                ? { systemPrompt: input.systemPrompt }
                : {}),
            workspacePath: input.workspacePath,
            model: input.model,
            reasoningEffort: input.reasoningEffort,
            ...(input.serviceTier === undefined
                ? {}
                : { serviceTier: input.serviceTier }),
            sandboxMode: input.sandboxMode ?? "read-only",
            timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
            abortSignal: input.abortSignal,
        };
        const result = this.options.goalMode
            ? await slot.client.runGoal({
                ...common,
                maxGoalTurns: this.options.maxGoalTurns ?? defaultMaxGoalTurns,
                goalContinuePrompt: this.options.goalContinuePrompt ?? defaultGoalContinuePrompt,
            })
            : await slot.client.runCleanTurn(common);
        const outputText = input.redactor.redact(result.outputText);
        input.redactor.assertNoKnownSecret(outputText, "codex-app-server-output");
        assertOutputWithinBounds(outputText, this.options.maxOutputBytes);
        if (isAppServerWaitingForInputResult(result)) {
            return redactWaitingForInputResult({
                result,
                outputText,
                redactor: input.redactor,
            });
        }
        return {
            outputText,
            warnings: result.warnings,
        };
    }
    async resumeViaAppServer(input) {
        if (!this.options.goalMode) {
            throw new Error("codex_app_server_resume_requires_goal_mode");
        }
        await this.assertManagedRunCanResume(input);
        const slot = await this.ensureSlot(input);
        const result = await slot.client.resumeGoal({
            runId: input.runId,
            requestId: input.requestId,
            answer: input.answer,
            resumeHandle: input.resumeHandle,
            workspacePath: input.workspacePath,
            model: input.model,
            reasoningEffort: input.reasoningEffort,
            ...(input.serviceTier === undefined
                ? {}
                : { serviceTier: input.serviceTier }),
            sandboxMode: input.sandboxMode ?? "read-only",
            timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
            abortSignal: input.abortSignal,
            maxGoalTurns: this.options.maxGoalTurns ?? defaultMaxGoalTurns,
            goalContinuePrompt: this.options.goalContinuePrompt ?? defaultGoalContinuePrompt,
        });
        const outputText = input.redactor.redact(result.outputText);
        input.redactor.assertNoKnownSecret(outputText, "codex-app-server-output");
        assertOutputWithinBounds(outputText, this.options.maxOutputBytes);
        if (isAppServerWaitingForInputResult(result)) {
            return redactWaitingForInputResult({
                result,
                outputText,
                redactor: input.redactor,
            });
        }
        return {
            outputText,
            warnings: result.warnings,
        };
    }
    async assertManagedRunCanResume(input) {
        const threadId = input.resumeHandle.threadId;
        if (!threadId)
            throw new Error("codex_managed_run_thread_missing");
        if (input.resumeHandle.providerId !== "codex") {
            throw new Error("codex_managed_run_provider_mismatch");
        }
        if (input.resumeHandle.agentId !== undefined &&
            input.resumeHandle.agentId !== "codex-json") {
            throw new Error("codex_managed_run_agent_mismatch");
        }
        if (input.resumeHandle.runId !== input.runId) {
            throw new Error("codex_managed_run_resume_handle_mismatch");
        }
        if (input.resumeHandle.workspacePath !== input.workspacePath) {
            throw new Error("codex_managed_run_workspace_mismatch");
        }
        const current = await this.runStore.get({ runId: input.runId });
        if (!current || current.status !== "waiting_for_input") {
            throw new Error("codex_managed_run_not_waiting_for_input");
        }
        if (current.request?.id !== input.requestId) {
            throw new Error("codex_managed_run_request_mismatch");
        }
        if (current.resumeHandle?.runId !== input.runId ||
            current.resumeHandle.threadId !== threadId ||
            current.resumeHandle.workspacePath !== input.workspacePath) {
            throw new Error("codex_managed_run_resume_handle_mismatch");
        }
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
        throwIfAborted(input.abortSignal);
        const client = new CodexAppServerClient({
            codexBinaryPath: this.options.codexBinaryPath,
            sourceEnv: this.options.sourceEnv ?? process.env,
            processFactory: this.options.processFactory ?? spawnCodexAppServerProcess,
            runStore: this.runStore,
            session: input.session,
            workspacePath: input.workspacePath,
            executionProfile: this.executionProfile,
            cleanThreadPrewarm: this.options.cleanThreadPrewarm ?? true,
            timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
            reconnectGraceMs: this.options.reconnectGraceMs ?? defaultReconnectGraceMs,
            abortSignal: input.abortSignal,
        });
        try {
            await client.start();
        }
        catch (error) {
            await client.stop().catch(() => undefined);
            throw error;
        }
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
    pendingTurnIdsByThread = new Map();
    earlyTurnIdsByThread = new Map();
    turnIdAliases = new Map();
    serverRequests = [];
    backgroundWarnings = [];
    preparedThread = null;
    prepareThreadInFlight = null;
    exited = false;
    terminalError = null;
    constructor(options) {
        this.options = options;
    }
    async start() {
        throwIfAborted(this.options.abortSignal);
        this.exited = false;
        this.terminalError = null;
        const env = {
            ...pruneCodexChildEnv(this.options.sourceEnv ?? process.env),
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
            this.recordTerminalError(new Error(`codex_app_server_exited:${code ?? signal}`));
        });
        this.child.on("error", (error) => {
            this.recordTerminalError(error);
        });
        this.child.stdin.on?.("error", (error) => {
            this.recordTerminalError(error);
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
        }, {
            timeoutMs: this.options.timeoutMs,
            abortSignal: this.options.abortSignal,
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
    async runGoal(input) {
        const warnings = this.drainWarnings();
        const runId = normalizeRunId(input.runId);
        const threadId = await this.startThread({
            ...input,
            goalMode: true,
        });
        await this.setGoal({
            threadId,
            objective: input.goalObjective ?? input.prompt,
            status: "active",
            timeoutMs: input.timeoutMs,
            abortSignal: input.abortSignal,
        });
        return this.continueGoal({
            ...input,
            runId,
            threadId,
            firstPrompt: input.prompt,
            warnings,
        });
    }
    async resumeGoal(input) {
        const threadId = input.resumeHandle.threadId;
        if (!threadId)
            throw new Error("codex_managed_run_thread_missing");
        if (input.resumeHandle.providerId !== "codex") {
            throw new Error("codex_managed_run_provider_mismatch");
        }
        if (input.resumeHandle.agentId !== undefined &&
            input.resumeHandle.agentId !== "codex-json") {
            throw new Error("codex_managed_run_agent_mismatch");
        }
        if (input.resumeHandle.runId !== input.runId) {
            throw new Error("codex_managed_run_resume_handle_mismatch");
        }
        if (input.resumeHandle.workspacePath !== input.workspacePath) {
            throw new Error("codex_managed_run_workspace_mismatch");
        }
        const current = await this.options.runStore.get({ runId: input.runId });
        if (!current || current.status !== "waiting_for_input") {
            throw new Error("codex_managed_run_not_waiting_for_input");
        }
        if (current.request?.id !== input.requestId) {
            throw new Error("codex_managed_run_request_mismatch");
        }
        if (current.resumeHandle?.runId !== input.runId ||
            current.resumeHandle.threadId !== threadId ||
            current.resumeHandle.workspacePath !== input.workspacePath) {
            throw new Error("codex_managed_run_resume_handle_mismatch");
        }
        await this.options.runStore.resume({
            runId: input.runId,
            requestId: input.requestId,
            answer: input.answer,
            now: new Date(),
        });
        try {
            return await this.continueGoal({
                ...input,
                threadId,
                firstPrompt: buildGoalResumePrompt(input),
                warnings: this.drainWarnings(),
            });
        }
        catch (error) {
            await this.options.runStore.fail({
                runId: input.runId,
                failure: managedRunFailureFromError(error),
                now: new Date(),
            });
            throw error;
        }
    }
    async continueGoal(input) {
        let outputText = "";
        for (let turnNumber = 1; turnNumber <= input.maxGoalTurns; turnNumber += 1) {
            const turn = await this.startTurn({
                ...input,
                goalMode: true,
                prompt: turnNumber === 1 ? input.firstPrompt : input.goalContinuePrompt,
            });
            if (turn.error)
                throw turn.error;
            outputText = turn.outputText;
            const goal = await this.getGoal({
                threadId: input.threadId,
                timeoutMs: controlRequestTimeoutMs(input.timeoutMs),
                abortSignal: input.abortSignal,
            });
            if (!goal) {
                throw new Error("codex_app_server_goal_missing");
            }
            if (goal.status === "complete") {
                input.warnings.push(...this.drainWarnings());
                await this.options.runStore.complete({
                    runId: input.runId,
                    outputText,
                    now: new Date(),
                });
                return {
                    status: "completed",
                    outputText,
                    warnings: input.warnings,
                };
            }
            if (goal.status === "blocked" || goal.status === "paused") {
                return this.waitForGoalInput({
                    runId: input.runId,
                    threadId: input.threadId,
                    goal,
                    outputText,
                    workspacePath: input.workspacePath,
                    warnings: input.warnings,
                });
            }
            if (goal.status !== "active") {
                throw new Error(`codex_app_server_goal_${goal.status}`);
            }
            if (!outputText.trim()) {
                throw new Error("codex_app_server_goal_turn_output_missing");
            }
        }
        throw new Error(`codex_app_server_goal_max_turns_exceeded:${input.maxGoalTurns}`);
    }
    async waitForGoalInput(input) {
        const request = goalInputRequest({
            runId: input.runId,
            goal: input.goal,
            outputText: input.outputText,
        });
        const resumeHandle = {
            runId: input.runId,
            providerId: "codex",
            agentId: "codex-json",
            workspacePath: input.workspacePath,
            threadId: input.threadId,
            providerState: {
                goalObjective: input.goal.objective,
                goalStatus: input.goal.status,
            },
        };
        await this.options.runStore.saveWaitingInput({
            runId: input.runId,
            request,
            resumeHandle,
            ...(input.outputText.trim() ? { outputText: input.outputText } : {}),
            now: new Date(),
        });
        return {
            status: "waiting_for_input",
            runId: input.runId,
            outputText: input.outputText.trim() ? input.outputText : request.question,
            request,
            resumeHandle,
            warnings: input.warnings,
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
        const exit = onceEvent(child, "exit").catch(() => undefined);
        try {
            child.stdin.end();
        }
        catch {
            // The process may have already closed stdin.
        }
        signalChildGroup(child, "SIGTERM");
        const timeout = setTimeout(() => {
            signalChildGroup(child, "SIGKILL");
        }, 5_000);
        try {
            await exit;
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
            prepared.reasoningEffort !== input.reasoningEffort ||
            prepared.serviceTier !== input.serviceTier ||
            prepared.sandboxMode !== (input.sandboxMode ?? "read-only") ||
            prepared.systemPrompt !== normalizeSystemPrompt(input.systemPrompt)) {
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
                ...(input.serviceTier === undefined
                    ? {}
                    : { serviceTier: input.serviceTier }),
                sandboxMode: input.sandboxMode ?? "read-only",
                systemPrompt: normalizeSystemPrompt(input.systemPrompt),
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
            this.preparedThread.reasoningEffort === input.reasoningEffort &&
            this.preparedThread.serviceTier === input.serviceTier &&
            this.preparedThread.sandboxMode === (input.sandboxMode ?? "read-only") &&
            this.preparedThread.systemPrompt === normalizeSystemPrompt(input.systemPrompt));
    }
    cleanThreadPrewarmEnabled() {
        return this.options.cleanThreadPrewarm ?? true;
    }
    async startThread(input) {
        const disableTools = this.options.executionProfile.disableTools && input.goalMode !== true;
        const features = {
            apps: false,
            hooks: false,
            memories: false,
            multi_agent: false,
            shell_snapshot: false,
            skill_mcp_dependency_install: false,
            ...(input.serviceTier === "fast" ? { fast_mode: true } : {}),
            ...(input.goalMode ? { goals: true } : {}),
        };
        const response = await this.send("thread/start", {
            model: input.model,
            modelProvider: null,
            serviceTier: input.serviceTier ?? null,
            cwd: input.workspacePath,
            runtimeWorkspaceRoots: [input.workspacePath],
            approvalPolicy: "never",
            approvalsReviewer: null,
            sandbox: input.sandboxMode ?? "read-only",
            permissions: null,
            config: {
                model_reasoning_effort: input.reasoningEffort,
                model_verbosity: "low",
                ...(input.serviceTier === undefined
                    ? {}
                    : { service_tier: input.serviceTier }),
                approval_policy: "never",
                sandbox_mode: input.sandboxMode ?? "read-only",
                web_search: "disabled",
                features,
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
            developerInstructions: mergeDeveloperInstructions({
                base: this.options.executionProfile.developerInstructions,
                ...(input.systemPrompt !== undefined
                    ? { systemPrompt: input.systemPrompt }
                    : {}),
            }),
            personality: null,
            ephemeral: input.goalMode ? false : true,
            sessionStartSource: "startup",
            threadSource: "user",
            ...(disableTools
                ? {
                    environments: [],
                    dynamicTools: [],
                    experimentalRawEvents: false,
                }
                : {}),
        }, input);
        if (response.error) {
            throw new Error(`codex_app_server_thread_start_failed:${response.error.message ?? "unknown"}`);
        }
        const threadId = nestedString(response.result, ["thread", "id"]);
        if (!threadId)
            throw new Error("codex_app_server_thread_id_missing");
        return threadId;
    }
    async setGoal(input) {
        const response = await this.send("thread/goal/set", {
            threadId: input.threadId,
            objective: input.objective,
            status: input.status,
        }, input);
        if (response.error) {
            throw new Error(`codex_app_server_goal_set_failed:${response.error.message ?? "unknown"}`);
        }
        const goal = readGoal(response.result?.goal);
        if (!goal)
            throw new Error("codex_app_server_goal_set_missing");
        return goal;
    }
    async getGoal(input) {
        const response = await this.send("thread/goal/get", {
            threadId: input.threadId,
        }, input);
        if (response.error) {
            throw new Error(`codex_app_server_goal_get_failed:${response.error.message ?? "unknown"}`);
        }
        return readGoal(response.result?.goal);
    }
    async startTurn(input) {
        const disableTools = this.options.executionProfile.disableTools && input.goalMode !== true;
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
            ...(disableTools ? { environments: [] } : {}),
            cwd: null,
            runtimeWorkspaceRoots: null,
            approvalPolicy: "never",
            approvalsReviewer: null,
            sandboxPolicy: null,
            permissions: null,
            model: input.model,
            serviceTier: input.serviceTier ?? null,
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
        if (this.terminalError)
            throw this.terminalError;
        const id = this.nextId;
        this.nextId += 1;
        return new Promise((resolve, reject) => {
            const timeoutMs = input.timeoutMs ?? this.options.timeoutMs;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                input.abortSignal?.removeEventListener("abort", abort);
                reject(new Error(`codex_app_server_request_timeout:${method}`));
            }, timeoutMs);
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
            try {
                this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
            }
            catch (error) {
                clearTimeout(timer);
                input.abortSignal?.removeEventListener("abort", abort);
                this.pending.delete(id);
                reject(error instanceof Error
                    ? error
                    : new Error("codex_app_server_write_failed"));
            }
        });
    }
    waitForTurn(turnId, input) {
        const earlyTurnId = this.earlyTurnIdsByThread.get(input.threadId);
        if (earlyTurnId) {
            this.earlyTurnIdsByThread.delete(input.threadId);
            this.aliasTurnId(earlyTurnId, turnId);
        }
        const existing = this.turns.get(turnId);
        if (existing?.completed || existing?.error) {
            this.clearTurnTracking(turnId, input.threadId);
            return Promise.resolve(existing);
        }
        if (this.terminalError) {
            return Promise.resolve({
                ...createTurnState(),
                error: this.terminalError,
            });
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.clearTurnTracking(turnId, input.threadId);
                input.abortSignal.removeEventListener("abort", abort);
                reject(new Error(`codex_app_server_turn_timeout:${turnId}`));
            }, input.timeoutMs);
            const abort = () => {
                clearTimeout(timer);
                this.clearTurnTracking(turnId, input.threadId);
                reject(new Error(`codex_app_server_turn_aborted:${turnId}`));
            };
            input.abortSignal.addEventListener("abort", abort, { once: true });
            const turn = existing ?? createTurnState();
            turn.waiters.push((state) => {
                clearTimeout(timer);
                input.abortSignal.removeEventListener("abort", abort);
                this.clearTurnTracking(turnId, input.threadId);
                resolve(state);
            });
            this.turns.set(turnId, turn);
            this.pendingTurnIdsByThread.set(input.threadId, turnId);
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
            this.clearReconnectGraceTimer(turn);
            turn.outputText += stringField(params, "delta") ?? "";
            return;
        }
        if (record.method === "turn/started") {
            const threadId = stringField(params, "threadId");
            const turn = readRecord(params?.turn);
            const actualTurnId = stringField(turn, "id");
            const expectedTurnId = threadId
                ? this.pendingTurnIdsByThread.get(threadId)
                : undefined;
            if (actualTurnId && expectedTurnId && actualTurnId !== expectedTurnId) {
                this.aliasTurnId(actualTurnId, expectedTurnId);
            }
            else if (actualTurnId &&
                threadId &&
                !expectedTurnId &&
                !this.turnIdAliases.has(actualTurnId)) {
                this.earlyTurnIdsByThread.set(threadId, actualTurnId);
            }
            return;
        }
        if (record.method === "item/completed") {
            const turnId = stringField(params, "turnId");
            const item = readRecord(params?.item);
            if (item?.type === "agentMessage") {
                const text = agentMessageText(item);
                if (text) {
                    const turn = this.ensureTurn(turnId);
                    this.clearReconnectGraceTimer(turn);
                    turn.outputText = text;
                }
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
                state.error = new Error(`codex_app_server_turn_failed:${safeMessage(turn?.error ?? status ?? params ?? record)}`);
            }
            this.resolveTurn(state);
            return;
        }
        if (record.method === "turn/aborted" || record.method === "turn_aborted") {
            const turnId = stringField(params, "turnId") ??
                stringField(params, "turn_id") ??
                stringField(readRecord(params?.turn), "id");
            const reason = stringField(params, "reason") ??
                stringField(readRecord(params?.status), "reason") ??
                "unknown";
            const error = new Error(`codex_app_server_turn_aborted:${reason}:${turnId ?? "unknown"}`);
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
            return;
        }
        if (record.method === "error") {
            const turnId = stringField(params, "turnId");
            const message = safeMessage(params?.error ?? params ?? record);
            if (isCodexAppServerReconnectProgressMessage(message)) {
                this.deferTurnsForReconnectProgress(turnId, message);
                return;
            }
            const error = new Error(`codex_app_server_error:${message}`);
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
    deferTurnsForReconnectProgress(turnId, message) {
        const turns = turnId === null ? [...this.turns.values()] : [this.ensureTurn(turnId)];
        if (turns.length === 0) {
            this.backgroundWarnings.push({
                code: "codex_app_server_reconnecting",
                safeMessage: message,
            });
            return;
        }
        for (const turn of turns) {
            this.scheduleReconnectGraceTimeout(turn, message);
        }
    }
    scheduleReconnectGraceTimeout(turn, message) {
        this.clearReconnectGraceTimer(turn);
        turn.reconnectGraceTimer = setTimeout(() => {
            if (turn.completed || turn.error)
                return;
            turn.error = new Error(`codex_app_server_reconnect_timeout:${safeMessage(message)}`);
            this.resolveTurn(turn);
        }, this.options.reconnectGraceMs);
    }
    onServerRequest(id, method) {
        this.serverRequests.push({
            code: "codex_app_server_unsupported_request",
            safeMessage: `Codex app-server requested unsupported client method: ${method}`,
        });
        try {
            this.child?.stdin.write(`${JSON.stringify({
                id,
                error: {
                    code: -32000,
                    message: `unsupported_server_request:${method}`,
                },
            })}\n`);
        }
        catch (error) {
            this.recordTerminalError(new Error(`codex_app_server_unsupported_response_failed:${safeMessage(error)}`));
        }
    }
    ensureTurn(turnId) {
        if (!turnId)
            return createTurnState();
        const canonicalTurnId = this.turnIdAliases.get(turnId) ?? turnId;
        let turn = this.turns.get(canonicalTurnId);
        if (!turn) {
            turn = createTurnState();
            this.turns.set(canonicalTurnId, turn);
        }
        return turn;
    }
    resolveTurn(turn) {
        this.clearReconnectGraceTimer(turn);
        const waiters = turn.waiters.splice(0);
        for (const waiter of waiters)
            waiter(turn);
    }
    failOutstanding(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        for (const turn of this.turns.values()) {
            turn.error = error;
            this.resolveTurn(turn);
        }
        this.pendingTurnIdsByThread.clear();
        this.earlyTurnIdsByThread.clear();
        this.turnIdAliases.clear();
    }
    recordTerminalError(error) {
        this.terminalError = this.terminalError ?? error;
        this.failOutstanding(this.terminalError);
    }
    clearTurnTracking(turnId, threadId) {
        this.turns.delete(turnId);
        this.pendingTurnIdsByThread.delete(threadId);
        this.earlyTurnIdsByThread.delete(threadId);
        this.deleteTurnAliases(turnId);
    }
    deleteTurnAliases(turnId) {
        for (const [actualTurnId, expectedTurnId] of this.turnIdAliases) {
            if (actualTurnId === turnId || expectedTurnId === turnId) {
                this.turnIdAliases.delete(actualTurnId);
            }
        }
    }
    aliasTurnId(actualTurnId, expectedTurnId) {
        if (actualTurnId === expectedTurnId)
            return;
        this.turnIdAliases.set(actualTurnId, expectedTurnId);
        const actual = this.turns.get(actualTurnId);
        if (!actual)
            return;
        const expected = this.turns.get(expectedTurnId);
        if (expected) {
            expected.outputText += actual.outputText;
            expected.completed = expected.completed || actual.completed;
            expected.error = expected.error ?? actual.error;
            expected.waiters.push(...actual.waiters);
            if (expected.completed || expected.error) {
                this.resolveTurn(expected);
            }
        }
        else {
            this.turns.set(expectedTurnId, actual);
        }
        this.turns.delete(actualTurnId);
    }
    clearReconnectGraceTimer(turn) {
        if (!turn.reconnectGraceTimer)
            return;
        clearTimeout(turn.reconnectGraceTimer);
        turn.reconnectGraceTimer = null;
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
        reconnectGraceTimer: null,
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
class InMemoryManagedRunStore {
    records = new Map();
    async get(input) {
        return this.records.get(input.runId) ?? null;
    }
    async saveWaitingInput(input) {
        const current = this.records.get(input.runId);
        const record = {
            runId: input.runId,
            status: "waiting_for_input",
            request: input.request,
            resumeHandle: input.resumeHandle,
            ...(input.recoveryPacket === undefined
                ? current?.recoveryPacket === undefined
                    ? {}
                    : { recoveryPacket: current.recoveryPacket }
                : { recoveryPacket: input.recoveryPacket }),
            ...(input.taskId === undefined
                ? current?.taskId === undefined
                    ? {}
                    : { taskId: current.taskId }
                : { taskId: input.taskId }),
            ...(input.assignedWorkerId === undefined
                ? current?.assignedWorkerId === undefined
                    ? {}
                    : { assignedWorkerId: current.assignedWorkerId }
                : { assignedWorkerId: input.assignedWorkerId }),
            ...(input.providerInstanceId === undefined
                ? current?.providerInstanceId === undefined
                    ? {}
                    : { providerInstanceId: current.providerInstanceId }
                : { providerInstanceId: input.providerInstanceId }),
            ...(input.workspacePath === undefined
                ? current?.workspacePath === undefined
                    ? {}
                    : { workspacePath: current.workspacePath }
                : { workspacePath: input.workspacePath }),
            ...(input.outputText === undefined ? {} : { outputText: input.outputText }),
            updatedAt: input.now,
        };
        this.records.set(input.runId, record);
        return record;
    }
    async resume(input) {
        const current = this.records.get(input.runId);
        if (!current ||
            current.status !== "waiting_for_input" ||
            current.request?.id !== input.requestId) {
            throw new Error("managed_run_request_mismatch");
        }
        const record = {
            runId: input.runId,
            status: "active",
            ...(current.recoveryPacket === undefined
                ? {}
                : { recoveryPacket: current.recoveryPacket }),
            ...(current.taskId === undefined ? {} : { taskId: current.taskId }),
            ...(current.assignedWorkerId === undefined
                ? {}
                : { assignedWorkerId: current.assignedWorkerId }),
            ...(current.providerInstanceId === undefined
                ? {}
                : { providerInstanceId: current.providerInstanceId }),
            ...(current.workspacePath === undefined
                ? {}
                : { workspacePath: current.workspacePath }),
            ...(current.outputText === undefined
                ? {}
                : { outputText: current.outputText }),
            updatedAt: input.now,
        };
        this.records.set(input.runId, record);
        return record;
    }
    async complete(input) {
        const current = this.records.get(input.runId);
        const record = {
            ...(current ?? { runId: input.runId }),
            runId: input.runId,
            status: "completed",
            outputText: input.outputText,
            updatedAt: input.now,
        };
        this.records.set(input.runId, record);
        return record;
    }
    async fail(input) {
        const current = this.records.get(input.runId);
        const record = {
            ...(current ?? { runId: input.runId }),
            runId: input.runId,
            status: "failed",
            failure: input.failure,
            updatedAt: input.now,
        };
        this.records.set(input.runId, record);
        return record;
    }
}
function isAppServerWaitingForInputResult(result) {
    return result.status === "waiting_for_input";
}
function redactWaitingForInputResult(input) {
    const contextSummary = input.result.request.contextSummary;
    const suggestedAnswers = input.result.request.suggestedAnswers?.map((answer) => input.redactor.redact(answer));
    const providerState = input.result.resumeHandle.providerState;
    return {
        status: "waiting_for_input",
        runId: input.result.runId,
        outputText: input.outputText,
        request: {
            id: input.result.request.id,
            kind: input.result.request.kind,
            question: input.redactor.redact(input.result.request.question),
            ...(contextSummary === undefined
                ? {}
                : { contextSummary: input.redactor.redact(contextSummary) }),
            ...(suggestedAnswers === undefined ? {} : { suggestedAnswers }),
            audience: input.result.request.audience,
        },
        resumeHandle: {
            ...input.result.resumeHandle,
            ...(providerState === undefined
                ? {}
                : { providerState: redactStringRecord(providerState, input.redactor) }),
        },
        warnings: input.result.warnings,
    };
}
function redactStringRecord(record, redactor) {
    const redacted = {};
    for (const [key, value] of Object.entries(record)) {
        redacted[key] = redactor.redact(value);
    }
    return redacted;
}
function normalizeRunId(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : `codex-managed-run-${randomUUID()}`;
}
function buildGoalResumePrompt(input) {
    const answer = input.answer.trim() || "(empty answer)";
    return [
        `Additional information for pending request ${input.requestId}:`,
        answer,
        "",
        input.goalContinuePrompt,
    ].join("\n");
}
function goalInputRequest(input) {
    const question = input.outputText.trim() ||
        `Codex goal is ${input.goal.status} and needs input before it can continue.`;
    return {
        id: `managed-input-${randomUUID()}`,
        kind: input.goal.status === "paused" ? "decision_required" : "missing_context",
        question,
        contextSummary: `Goal: ${input.goal.objective}\nStatus: ${input.goal.status}`,
        audience: "orchestrator",
    };
}
function managedRunFailureFromError(error) {
    if (isAbortLikeError(error)) {
        return {
            code: "task_cancelled",
            retryable: false,
            reconnectRequired: false,
            safeMessage: "Codex managed run resume was cancelled.",
        };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout/i.test(message)) {
        return {
            code: "task_timeout",
            retryable: true,
            reconnectRequired: false,
            safeMessage: "Codex managed run resume timed out.",
        };
    }
    return {
        code: "unknown_runtime_failure",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex managed run resume failed.",
    };
}
function isManagedRunResumeValidationError(error) {
    return (error instanceof Error &&
        error.message.startsWith("codex_managed_run_"));
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
function agentMessageText(item) {
    return stringifyContent(item.text) ?? stringifyContent(item.content);
}
function stringifyContent(value) {
    if (typeof value === "string" && value.trim())
        return value;
    if (Array.isArray(value)) {
        const parts = value
            .map((entry) => stringifyContentEntry(entry))
            .filter((entry) => typeof entry === "string");
        return parts.length > 0 ? parts.join("") : null;
    }
    if (value && typeof value === "object") {
        const record = value;
        if (!isAssistantContentRecord(record))
            return null;
        return stringifyContent(record.text ?? record.output_text ?? record.content ?? record.output);
    }
    return null;
}
function stringifyContentEntry(entry) {
    if (typeof entry === "string")
        return entry;
    if (!entry || typeof entry !== "object")
        return null;
    const record = entry;
    if (!isAssistantContentRecord(record))
        return null;
    return stringifyContent(record.text ?? record.output_text ?? record.content ?? record.output);
}
function isAssistantContentRecord(record) {
    const type = typeof record.type === "string" ? record.type : null;
    if (!hasAssistantRole(record))
        return false;
    return (!type ||
        type === "agentMessage" ||
        type === "agent_message" ||
        type === "assistant_message" ||
        type === "message" ||
        type === "output_text" ||
        type === "text");
}
function hasAssistantRole(record) {
    const role = record.role;
    return typeof role !== "string" || role === "assistant";
}
function readGoal(value) {
    const goal = readRecord(value);
    if (!goal)
        return null;
    const threadId = stringField(goal, "threadId");
    const objective = stringField(goal, "objective");
    const status = stringField(goal, "status");
    if (!threadId || !objective || !isGoalStatus(status))
        return null;
    return {
        threadId,
        objective,
        status,
    };
}
function isGoalStatus(value) {
    return (value === "active" ||
        value === "paused" ||
        value === "blocked" ||
        value === "usageLimited" ||
        value === "budgetLimited" ||
        value === "complete");
}
function parseStructuredOutput(outputText) {
    return parseCodexStructuredOutput(outputText, "codex_app_server_structured_output_invalid");
}
function assertOutputWithinBounds(output, maxOutputBytes = defaultMaxOutputBytes) {
    if (Buffer.byteLength(output, "utf8") > maxOutputBytes) {
        throw new Error("codex_app_server_output_too_large");
    }
}
function controlRequestTimeoutMs(taskTimeoutMs) {
    return Math.min(taskTimeoutMs, defaultControlRequestTimeoutMs);
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
function isCodexAppServerReconnectProgressMessage(message) {
    return /\breconnecting(?:\.{3}|…)?\s*\d+\s*\/\s*\d+\b/i.test(message);
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