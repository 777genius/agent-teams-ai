import type {
  ManagedRunInputRequest,
  ManagedRunResumeHandle,
  ProviderTask,
  ProviderTaskTelemetry,
  RuntimeWarning,
} from "@vioxen/subscription-runtime/core";

export enum RuntimeAgentTaskProvider {
  Claude = "claude",
  Codex = "codex",
}

export type ProviderName = RuntimeAgentTaskProvider;

export type RuntimeAgentTaskWorker = {
  start(): Promise<void>;
  seedClaudeOAuth?(input: { readonly oauthToken: string }): Promise<void>;
  seedCodexAuthJsonFile?(authJsonPath: string): Promise<void>;
  run(job: RuntimeAgentTaskWorkerJob): Promise<RuntimeAgentTaskWorkerResult>;
  dispose?(): Promise<void>;
};

export type RuntimeAgentTaskWorkerJob = {
  readonly runId?: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly kind?: ProviderTask["kind"];
  readonly outputSchemaName?: string;
  readonly controls?: ProviderTask["controls"];
  readonly abortSignal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, string>>;
};

export type RuntimeAgentTaskWorkerResult = {
  readonly status?: "completed" | "waiting_for_input";
  readonly runId?: string;
  readonly outputText: string;
  readonly request?: ManagedRunInputRequest;
  readonly resumeHandle?: ManagedRunResumeHandle;
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
  readonly claudeRuntimeDistDir?: string;
  readonly codexBinaryPath?: string;
};

export type RuntimeAgentTaskWorkerFactory = (
  input: RuntimeAgentTaskWorkerFactoryInput,
) => RuntimeAgentTaskWorker;
