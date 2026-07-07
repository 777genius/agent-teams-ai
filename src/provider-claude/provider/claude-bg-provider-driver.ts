import type {
  AgentCapabilities,
  ProviderCapabilities,
  ProviderFailure,
  ProviderTask,
  ProviderTaskEvent,
  ProviderTaskResult,
  RefreshedSession,
  RunnerPort,
  SessionArtifact,
  SessionValidationResult,
  SubscriptionProviderDriver,
  WorkspaceHandle,
} from "@vioxen/subscription-runtime/core";
import { ClaudeSessionDriver } from "../session/claude-session-driver";
import {
  ClaudeTaskAgentDriver,
  type ClaudeTaskAgentDriverOptions,
} from "../task/claude-task-agent-driver";

export type ClaudeBgProviderDriverOptions = ClaudeTaskAgentDriverOptions;

export class ClaudeBgProviderDriver implements SubscriptionProviderDriver {
  private readonly sessionDriver: ClaudeSessionDriver;
  private readonly agentDriver: ClaudeTaskAgentDriver;

  readonly providerId: string;
  readonly agentId: string;
  readonly supportedArtifactKinds: readonly SessionArtifact["kind"][];
  readonly capabilities: ProviderCapabilities;
  readonly agentCapabilities: AgentCapabilities;

  constructor(options: ClaudeBgProviderDriverOptions) {
    this.sessionDriver = new ClaudeSessionDriver();
    this.agentDriver = new ClaudeTaskAgentDriver(options);
    this.providerId = this.sessionDriver.providerId;
    this.agentId = this.agentDriver.agentId;
    this.supportedArtifactKinds = this.sessionDriver.supportedArtifactKinds;
    this.capabilities = this.sessionDriver.capabilities;
    this.agentCapabilities = this.agentDriver.capabilities;
  }

  validateSession(input: {
    readonly session: SessionArtifact;
    readonly redactor: Parameters<
      ClaudeSessionDriver["validateSession"]
    >[0]["redactor"];
  }): Promise<SessionValidationResult> {
    return this.sessionDriver.validateSession(input);
  }

  refreshSession(input: {
    readonly session: SessionArtifact;
    readonly workspace: WorkspaceHandle;
    readonly runner: RunnerPort;
    readonly redactor: Parameters<
      ClaudeSessionDriver["refreshSession"]
    >[0]["redactor"];
    readonly abortSignal: AbortSignal;
  }): Promise<RefreshedSession> {
    return this.sessionDriver.refreshSession(input);
  }

  classifySessionFailure(error: unknown): ProviderFailure {
    return this.sessionDriver.classifySessionFailure(error);
  }

  runTask(input: {
    readonly session: SessionArtifact;
    readonly task: ProviderTask;
    readonly workspace: WorkspaceHandle;
    readonly runner: RunnerPort;
    readonly redactor: Parameters<
      ClaudeTaskAgentDriver["runTask"]
    >[0]["redactor"];
    readonly abortSignal: AbortSignal;
  }): Promise<ProviderTaskResult> {
    return this.agentDriver.runTask(input);
  }

  classifyRunFailure(error: unknown): ProviderFailure {
    return this.agentDriver.classifyRunFailure(error);
  }

  streamTask(input: {
    readonly session: SessionArtifact;
    readonly task: ProviderTask;
    readonly workspace: WorkspaceHandle;
    readonly runner: RunnerPort;
    readonly redactor: Parameters<
      ClaudeTaskAgentDriver["runTask"]
    >[0]["redactor"];
    readonly abortSignal: AbortSignal;
  }): AsyncIterable<ProviderTaskEvent> {
    return this.agentDriver.streamTask(input);
  }

  async dispose(): Promise<void> {
    await this.agentDriver.dispose();
  }
}
