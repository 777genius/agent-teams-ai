import type { RedactorPort, RunnerPort } from "@vioxen/subscription-runtime/core";
import type { CodexExecutionProfile } from "./codex-execution-profile.js";
import type { CodexExecutionEngine, CodexExecutionPrewarmResult, CodexExecutionResult, CodexMaterializedSession, CodexReasoningEffort } from "./codex-json-execution-engine.js";
export type CodexAppServerExecutionEngineOptions = {
    readonly codexBinaryPath: string;
    readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly fallback?: CodexExecutionEngine;
    readonly processFactory?: CodexAppServerProcessFactory;
    readonly executionProfile?: CodexExecutionProfile;
    readonly cleanThreadPrewarm?: boolean;
};
export type CodexAppServerProcessFactory = (input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
}) => CodexAppServerChildProcess;
export type CodexAppServerChildProcess = {
    readonly pid?: number | undefined;
    readonly stdin: {
        write(chunk: string | Uint8Array): boolean;
        end(): void;
    };
    readonly stdout: {
        on(event: "data", listener: (chunk: unknown) => void): unknown;
        setEncoding(encoding: BufferEncoding): unknown;
    };
    readonly stderr: {
        on(event: "data", listener: (chunk: unknown) => void): unknown;
        setEncoding(encoding: BufferEncoding): unknown;
    };
    on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
    kill(signal?: NodeJS.Signals): boolean;
};
export declare class CodexAppServerExecutionEngine implements CodexExecutionEngine {
    private readonly options;
    readonly kind: "app-server-pool";
    readonly capabilities: {
        readonly supportsStructuredOutput: true;
        readonly supportsJsonEvents: true;
        readonly supportsThreadResume: false;
        readonly requiresSchemaFile: false;
    };
    private readonly executionProfile;
    private readonly slots;
    constructor(options: CodexAppServerExecutionEngineOptions);
    run(input: {
        readonly prompt: string;
        readonly session: CodexMaterializedSession;
        readonly workspacePath: string;
        readonly runner: RunnerPort;
        readonly redactor: RedactorPort;
        readonly model: string;
        readonly reasoningEffort: CodexReasoningEffort;
        readonly outputSchema?: unknown;
        readonly abortSignal: AbortSignal;
    }): Promise<CodexExecutionResult>;
    dispose(): Promise<void>;
    prewarm(input: {
        readonly session: CodexMaterializedSession;
        readonly workspacePath: string;
        readonly runner: RunnerPort;
        readonly redactor: RedactorPort;
        readonly model: string;
        readonly reasoningEffort: CodexReasoningEffort;
        readonly warmupPrompt?: string;
        readonly abortSignal: AbortSignal;
    }): Promise<CodexExecutionPrewarmResult>;
    private runViaAppServer;
    private ensureSlot;
    private disposeSessionSlot;
}
//# sourceMappingURL=codex-app-server-execution-engine.d.ts.map