import type {
  AgentToolCall,
  AgentUsage,
  ManagedRunInputRequest,
  ManagedRunResumeHandle,
  ProviderFailure,
  ProviderFailureCode,
  ProviderTaskControls,
  ProviderTaskKind,
  ProviderTaskTelemetry,
  RuntimeWarning,
} from "@vioxen/subscription-runtime/core";

export const agentTaskProtocolVersion = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonArray = readonly JsonValue[];

export type AgentTaskRequest = {
  readonly protocolVersion: typeof agentTaskProtocolVersion;
  readonly runId?: string;
  readonly providerInstanceId?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly task: AgentTaskPayload;
  readonly context?: AgentTaskContext;
};

export type AgentTaskPayload = {
  readonly kind: ProviderTaskKind;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly outputSchemaName?: string;
  readonly controls?: AgentTaskControls;
  readonly metadata?: Readonly<Record<string, string>>;
};

export type AgentTaskControls = ProviderTaskControls & {
  readonly outputSchema?: JsonObject;
};

export type AgentTaskContext = {
  readonly application?: string;
  readonly purpose?: string;
  readonly correlationId?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly round?: AgentTaskRoundContext;
};

export type AgentTaskRoundContext = {
  readonly roundId?: string;
  readonly roundIndex?: number;
  readonly totalRounds?: number;
  readonly member: AgentTaskRoundMemberIdentity;
  readonly adversaryOf?: AgentTaskRoundMemberIdentity;
};

export type AgentTaskRoundMemberIdentity = {
  readonly id: string;
  readonly adapterId: string;
  readonly agentType: string;
  readonly provider: string;
  readonly model: string;
  readonly independenceGroup: string;
  readonly label?: string;
};

export type AgentTaskResult =
  | {
      readonly protocolVersion: typeof agentTaskProtocolVersion;
      readonly status: "completed";
      readonly outputText: string;
      readonly structuredOutput?: JsonValue;
      readonly telemetry?: ProviderTaskTelemetry;
      readonly warnings: readonly RuntimeWarning[];
    }
  | {
      readonly protocolVersion: typeof agentTaskProtocolVersion;
      readonly status: "waiting_for_input";
      readonly runId: string;
      readonly outputText: string;
      readonly structuredOutput?: JsonValue;
      readonly request: ManagedRunInputRequest;
      readonly resumeHandle: ManagedRunResumeHandle;
      readonly telemetry?: ProviderTaskTelemetry;
      readonly warnings: readonly RuntimeWarning[];
    }
  | {
      readonly protocolVersion: typeof agentTaskProtocolVersion;
      readonly status: "failed";
      readonly failure: ProviderFailure;
      readonly telemetry?: ProviderTaskTelemetry;
      readonly warnings: readonly RuntimeWarning[];
    };

export type AgentTaskEvent =
  | {
      readonly protocolVersion: typeof agentTaskProtocolVersion;
      readonly type: "started";
      readonly occurredAt: string;
      readonly telemetry?: ProviderTaskTelemetry;
    }
  | {
      readonly protocolVersion: typeof agentTaskProtocolVersion;
      readonly type: "text_delta";
      readonly occurredAt: string;
      readonly text: string;
      readonly telemetry?: ProviderTaskTelemetry;
    }
  | {
      readonly protocolVersion: typeof agentTaskProtocolVersion;
      readonly type: "tool_call";
      readonly occurredAt: string;
      readonly toolCall: AgentToolCall;
      readonly telemetry?: ProviderTaskTelemetry;
    }
  | {
      readonly protocolVersion: typeof agentTaskProtocolVersion;
      readonly type: "usage";
      readonly occurredAt: string;
      readonly usage: AgentUsage;
      readonly telemetry?: ProviderTaskTelemetry;
    }
  | {
      readonly protocolVersion: typeof agentTaskProtocolVersion;
      readonly type: "warning";
      readonly occurredAt: string;
      readonly warning: RuntimeWarning;
      readonly telemetry?: ProviderTaskTelemetry;
    }
  | {
      readonly protocolVersion: typeof agentTaskProtocolVersion;
      readonly type: "completed";
      readonly occurredAt: string;
      readonly result: AgentTaskResult;
      readonly telemetry?: ProviderTaskTelemetry;
    };

export type AgentTaskBridgeRunResult = {
  readonly request: AgentTaskRequest;
  readonly result: AgentTaskResult;
  readonly events: readonly AgentTaskEvent[];
};

export type AgentTaskProtocolErrorCode =
  | "agent_task_protocol_version_invalid"
  | "agent_task_request_invalid"
  | "agent_task_result_invalid"
  | "agent_task_event_invalid"
  | "agent_task_handler_invalid"
  | "agent_task_json_invalid";

export class AgentTaskProtocolError extends Error {
  constructor(
    readonly code: AgentTaskProtocolErrorCode,
    safeMessage: string,
  ) {
    super(safeMessage);
    this.name = "AgentTaskProtocolError";
  }
}

export function makeAgentTaskFailure(
  code: ProviderFailureCode,
  safeMessage: string,
  input?: {
    readonly retryable?: boolean;
    readonly reconnectRequired?: boolean;
    readonly causeCategory?: string;
    readonly details?: Readonly<Record<string, string>>;
  },
): ProviderFailure {
  return {
    code,
    retryable: input?.retryable ?? false,
    reconnectRequired: input?.reconnectRequired ?? false,
    safeMessage,
    ...(input?.causeCategory ? { causeCategory: input.causeCategory } : {}),
    ...(input?.details ? { details: input.details } : {}),
  };
}
