import type {
  ProviderTaskControls,
  ProviderTaskEvent,
  ProviderTaskResult,
  ProviderTaskTelemetry,
  RedactorPort,
  RunnerPort,
} from "@vioxen/subscription-runtime/core";
import type { ClaudeOAuthSession } from "../session/session-artifact";

export type ClaudeTaskExecutionResult = {
  readonly outputText: string;
  readonly structuredOutput?: unknown;
  readonly telemetry?: ProviderTaskTelemetry;
  readonly warnings: ProviderTaskResult["warnings"];
};

export type ClaudeRuntimeThreadInput = {
  readonly threadId: string;
  readonly resumeSessionId?: string;
};

export type ClaudeTaskEngineInput = {
  readonly prompt: string;
  readonly session: ClaudeOAuthSession;
  readonly workspacePath: string;
  readonly appendSystemPrompt?: string;
  readonly runner: RunnerPort;
  readonly redactor: RedactorPort;
  readonly model: string;
  readonly maxTurns?: number;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpConfig?: readonly string[];
  readonly editMode?: ProviderTaskControls["editMode"];
  readonly providerSandboxMode?: ProviderTaskControls["providerSandboxMode"];
  readonly strictMcpConfig?: boolean;
  readonly outputSchemaName?: string;
  readonly runtimeThread?: ClaudeRuntimeThreadInput;
  readonly abortSignal: AbortSignal;
};

export type ClaudeTaskExecutionEngine = {
  readonly kind: string;
  readonly capabilities: {
    readonly supportsStreaming: boolean;
    readonly supportsToolCalls: boolean;
    readonly supportsUsage: boolean;
    readonly supportsProviderRunId: boolean;
    readonly supportsCleanup: boolean;
  };
  run(input: ClaudeTaskEngineInput): Promise<ClaudeTaskExecutionResult>;
  stream?(input: ClaudeTaskEngineInput): AsyncIterable<ProviderTaskEvent>;
  dispose?(): Promise<void>;
};
