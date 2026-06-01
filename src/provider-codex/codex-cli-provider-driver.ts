import type {
  AgentCapabilities,
  ProviderCapabilities,
  ProviderFailure,
  ProviderTask,
  ProviderTaskResult,
  RefreshedSession,
  SessionArtifact,
  SessionValidationResult,
  SubscriptionProviderDriver,
  WorkspaceHandle,
} from "@777genius/subscription-runtime/core";
import {
  CodexCliAgentDriver,
  type CodexCliAgentDriverOptions,
} from "./codex-cli-agent-driver";
import {
  CodexCliSessionDriver,
  type CodexCliSessionDriverOptions,
} from "./codex-cli-session-driver";

export type CodexCliProviderDriverOptions = CodexCliSessionDriverOptions &
  CodexCliAgentDriverOptions;

export class CodexCliProviderDriver implements SubscriptionProviderDriver {
  private readonly sessionDriver: CodexCliSessionDriver;
  private readonly agentDriver: CodexCliAgentDriver;

  readonly providerId: string;
  readonly agentId: string;
  readonly supportedArtifactKinds: readonly SessionArtifact["kind"][];
  readonly capabilities: ProviderCapabilities;
  readonly agentCapabilities: AgentCapabilities;

  constructor(options: CodexCliProviderDriverOptions = {}) {
    this.sessionDriver = new CodexCliSessionDriver(options);
    this.agentDriver = new CodexCliAgentDriver(options);
    this.providerId = this.sessionDriver.providerId;
    this.agentId = this.agentDriver.agentId;
    this.supportedArtifactKinds = this.sessionDriver.supportedArtifactKinds;
    this.capabilities = this.sessionDriver.capabilities;
    this.agentCapabilities = this.agentDriver.capabilities;
  }

  validateSession(input: {
    readonly session: SessionArtifact;
  }): Promise<SessionValidationResult> {
    return this.sessionDriver.validateSession(input);
  }

  refreshSession(input: {
    readonly session: SessionArtifact;
    readonly workspace: WorkspaceHandle;
    readonly runner: Parameters<
      CodexCliSessionDriver["refreshSession"]
    >[0]["runner"];
    readonly redactor: Parameters<
      CodexCliSessionDriver["refreshSession"]
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
    readonly runner: Parameters<CodexCliAgentDriver["runTask"]>[0]["runner"];
    readonly redactor: Parameters<
      CodexCliAgentDriver["runTask"]
    >[0]["redactor"];
    readonly abortSignal: AbortSignal;
  }): Promise<ProviderTaskResult> {
    return this.agentDriver.runTask(input);
  }

  classifyRunFailure(error: unknown): ProviderFailure {
    return this.agentDriver.classifyRunFailure(error);
  }
}
