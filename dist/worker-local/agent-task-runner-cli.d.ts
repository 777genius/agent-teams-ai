#!/usr/bin/env node
import type { ProviderTask, ProviderTaskTelemetry, RuntimeWarning } from "@vioxen/subscription-runtime/core";
type ProviderName = "claude" | "codex";
export type SubscriptionAgentTaskCliIo = {
    readStdin(): Promise<string>;
    writeStdout(chunk: string): void;
    writeStderr(chunk: string): void;
    cwd(): string;
    env(): Readonly<Record<string, string | undefined>>;
};
export type RuntimeAgentTaskWorker = {
    start(): Promise<void>;
    seedClaudeOAuth?(input: {
        readonly oauthToken: string;
    }): Promise<void>;
    seedCodexAuthJsonFile?(authJsonPath: string): Promise<void>;
    run(job: RuntimeAgentTaskWorkerJob): Promise<RuntimeAgentTaskWorkerResult>;
    dispose?(): Promise<void>;
};
export type RuntimeAgentTaskWorkerJob = {
    readonly runId?: string;
    readonly prompt: string;
    readonly kind?: ProviderTask["kind"];
    readonly outputSchemaName?: string;
    readonly controls?: ProviderTask["controls"];
    readonly abortSignal?: AbortSignal;
    readonly metadata?: Readonly<Record<string, string>>;
};
export type RuntimeAgentTaskWorkerResult = {
    readonly outputText: string;
    readonly structuredOutput?: unknown;
    readonly telemetry?: ProviderTaskTelemetry;
    readonly warnings: readonly RuntimeWarning[];
};
export type RuntimeAgentTaskWorkerFactoryInput = {
    readonly provider: ProviderName;
    readonly stateRootDir: string;
    readonly providerInstanceId: string;
    readonly encryptionKey: Uint8Array | string;
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly model?: string;
    readonly timeoutMs?: number;
    readonly claudePath?: string;
    readonly codexBinaryPath?: string;
};
export type RuntimeAgentTaskWorkerFactory = (input: RuntimeAgentTaskWorkerFactoryInput) => RuntimeAgentTaskWorker;
export declare function runSubscriptionAgentTaskCli(argv?: string[], io?: SubscriptionAgentTaskCliIo, workerFactory?: RuntimeAgentTaskWorkerFactory): Promise<number>;
export declare function resolveRequestCwd(workspaceRoot: string, requestedCwd: string): string;
export declare function pruneClaudeChildEnv(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | undefined>>;
export {};
//# sourceMappingURL=agent-task-runner-cli.d.ts.map