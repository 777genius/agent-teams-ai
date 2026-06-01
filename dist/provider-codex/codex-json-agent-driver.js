import { codexJsonAgentCapabilities, codexJsonAgentId, codexProviderId, } from "./capabilities.js";
import { classifyCodexFailure } from "./failure-classifier.js";
import { PackagedCodexJsonExecutionEngine, codexExecutionFailure, } from "./codex-json-execution-engine.js";
import { CodexEphemeralSessionMaterializer, sessionArtifactHash, } from "./codex-session-materializer.js";
export class CodexJsonAgentDriver {
    options;
    agentId = codexJsonAgentId;
    providerId = codexProviderId;
    capabilities = codexJsonAgentCapabilities;
    engine;
    model;
    reasoningEffort;
    sessionMaterializer;
    constructor(options) {
        this.options = options;
        this.engine =
            "engine" in options
                ? options.engine
                : new PackagedCodexJsonExecutionEngine({
                    codexBinaryPath: options.codexBinaryPath,
                    ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
                    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
                });
        this.model = options.model ?? "gpt-5.5";
        this.reasoningEffort = options.reasoningEffort ?? "low";
        this.sessionMaterializer =
            options.sessionMaterializer ?? new CodexEphemeralSessionMaterializer();
    }
    async runTask(input) {
        if (!input.session) {
            return {
                status: "failed",
                failure: {
                    code: "provider_session_invalid",
                    retryable: false,
                    reconnectRequired: true,
                    safeMessage: "Codex requires a session artifact.",
                },
                warnings: [],
            };
        }
        let materialized = null;
        try {
            materialized = await this.sessionMaterializer.materialize({
                session: input.session,
                redactor: input.redactor,
            });
            const result = await this.engine.run({
                prompt: input.task.prompt,
                outputSchema: input.task.outputSchemaName
                    ? { name: input.task.outputSchemaName }
                    : undefined,
                session: materialized,
                workspacePath: input.workspace.path,
                runner: input.runner,
                redactor: input.redactor,
                model: this.model,
                reasoningEffort: this.reasoningEffort,
                abortSignal: input.abortSignal,
            });
            return {
                status: "completed",
                outputText: result.outputText,
                structuredOutput: result.structuredOutput,
                warnings: result.warnings,
            };
        }
        catch (error) {
            return codexExecutionFailure(error);
        }
        finally {
            await materialized?.release();
        }
    }
    classifyRunFailure(error) {
        return classifyCodexFailure(error);
    }
    async prewarmSession(input) {
        const sessionPrewarm = this.sessionMaterializer.prewarm
            ? await this.sessionMaterializer.prewarm(input)
            : await this.prewarmMaterializerFallback(input);
        if (!sessionPrewarm.reusable ||
            !this.engine.prewarm ||
            !input.workspacePath ||
            !input.runner) {
            return sessionPrewarm;
        }
        const materialized = await this.sessionMaterializer.materialize(input);
        try {
            const enginePrewarm = await this.engine.prewarm({
                session: materialized,
                workspacePath: input.workspacePath,
                runner: input.runner,
                redactor: input.redactor,
                model: this.model,
                reasoningEffort: this.reasoningEffort,
                ...(this.options.warmupPrompt
                    ? { warmupPrompt: this.options.warmupPrompt }
                    : {}),
                abortSignal: input.abortSignal ?? new AbortController().signal,
            });
            return {
                ...sessionPrewarm,
                engine: {
                    kind: enginePrewarm.kind,
                    reusable: enginePrewarm.reusable,
                },
                warmedAt: enginePrewarm.warmedAt,
                warnings: enginePrewarm.warnings,
            };
        }
        finally {
            await materialized.release();
        }
    }
    async prewarmMaterializerFallback(input) {
        const materialized = await this.sessionMaterializer.materialize(input);
        try {
            return {
                mode: this.sessionMaterializer.mode,
                home: materialized.home,
                codexHome: materialized.codexHome,
                sessionHash: sessionArtifactHash(input.session),
                reusable: false,
                warmedAt: new Date(),
            };
        }
        finally {
            await materialized.release();
        }
    }
    async dispose() {
        const results = await Promise.allSettled([
            Promise.resolve().then(() => this.engine.dispose?.()),
            Promise.resolve().then(() => this.sessionMaterializer.dispose?.()),
        ]);
        const errors = results
            .filter((result) => result.status === "rejected")
            .map((result) => result.reason);
        if (errors.length > 0) {
            const error = new AggregateError(errors, "codex_json_agent_dispose_failed");
            error.code = "codex_json_agent_dispose_failed";
            throw error;
        }
    }
}
//# sourceMappingURL=codex-json-agent-driver.js.map