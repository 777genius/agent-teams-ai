import type {
  ProviderTaskEvent,
  ProviderTaskResult,
} from "@vioxen/subscription-runtime/core";
import type {
  AgentTaskEvent,
  AgentTaskRequest,
  AgentTaskResult,
} from "../domain/agent-task-contracts";

export type AgentTaskHandlerContext = {
  readonly abortSignal: AbortSignal;
  emit(event: AgentTaskEvent | ProviderTaskEvent): Promise<void>;
};

export type AgentTaskHandlerResult = AgentTaskResult | ProviderTaskResult;

export type AgentTaskRunFunction = (
  request: AgentTaskRequest,
  context: AgentTaskHandlerContext,
) => Promise<AgentTaskHandlerResult> | AgentTaskHandlerResult;

export type AgentTaskStreamFunction = (
  request: AgentTaskRequest,
  context: AgentTaskHandlerContext,
) => AsyncIterable<AgentTaskEvent | ProviderTaskEvent>;

export type AgentTaskHandler = {
  readonly runTask?: AgentTaskRunFunction;
  readonly streamTask?: AgentTaskStreamFunction;
};
