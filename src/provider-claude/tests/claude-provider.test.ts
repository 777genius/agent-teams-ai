import { describe, expect, it } from "vitest";
import {
  DefaultRedactor,
  type ProviderTaskEvent,
  type ProcessResult,
  type RunnerCapabilities,
  type RunnerPort,
} from "@vioxen/subscription-runtime/core";
import {
  agentDriverContract,
  providerSessionDriverContract,
} from "@vioxen/subscription-runtime/testing";
import {
  ClaudeBgProviderDriver,
  ClaudeRuntimeTaskExecutionEngine,
  ClaudeSessionDriver,
  ClaudeTaskAgentDriver,
  claudeBgTaskAgentCapabilities,
  claudeEnvironmentPolicy,
  claudeProviderManifest,
  claudeSessionCapabilities,
  classifyClaudeRuntimeFailure,
  createClaudeBgRuntimeContext,
  sessionArtifactFromClaudeOAuth,
  validateClaudeSessionArtifact,
  type ClaudeTaskEngineInput,
  type ClaudeTaskExecutionEngine,
} from "../index";

const validSession = sessionArtifactFromClaudeOAuth({
  oauthToken: "claude-oauth-secret",
  configDir: "/tmp/claude-config",
  refreshedAt: "2026-06-01T00:00:00.000Z",
});

describe("Claude provider adapter", () => {
  it("declares provider, session and task capabilities", () => {
    expect(claudeSessionCapabilities.providerId).toBe("claude");
    expect(claudeSessionCapabilities.refreshMode).toBe("validate-only");
    expect(claudeSessionCapabilities.supportsRefresh).toBe(false);
    expect(claudeSessionCapabilities.sessionArtifactKinds).toEqual([
      "json-file",
      "env-token",
    ]);
    expect(claudeEnvironmentPolicy.credentialSourceOrder).toEqual([
      "claude-oauth-token",
      "claude-config-dir",
    ]);
    expect(claudeBgTaskAgentCapabilities.agentId).toBe("claude-bg-task");
    expect(claudeBgTaskAgentCapabilities.providerId).toBe("claude");
    expect(claudeBgTaskAgentCapabilities.executionModes).toEqual(["task"]);
    expect(claudeBgTaskAgentCapabilities.toolPolicyMode).toBe(
      "provider-enforced",
    );
    expect(claudeBgTaskAgentCapabilities.supportsAbort).toBe(true);
    expect(claudeBgTaskAgentCapabilities.supportsStreaming).toBe(true);
    expect(claudeProviderManifest).toMatchObject({
      adapterId: "provider.claude-bg",
      adapterKind: "combined-provider",
      packageName: "@vioxen/subscription-runtime/provider-claude",
      capabilities: {
        agent: {
          agentId: "claude-bg-task",
        },
      },
    });
  });

  it("validates json and env-token Claude sessions", () => {
    const jsonResult = validateClaudeSessionArtifact(validSession);
    const envResult = validateClaudeSessionArtifact({
      kind: "env-token",
      providerId: "claude",
      formatVersion: "claude-oauth-session-v1",
      bytes: new TextEncoder().encode("env-claude-token"),
      contentType: "text/plain",
    });

    expect(jsonResult.session).toMatchObject({
      authMode: "oauth",
      oauthToken: "claude-oauth-secret",
      configDir: "/tmp/claude-config",
    });
    expect(envResult.session.oauthToken).toBe("env-claude-token");
  });

  it("warns on unparseable or expired session expiry metadata", () => {
    expect(
      validateClaudeSessionArtifact(
        sessionArtifactFromClaudeOAuth({
          oauthToken: "claude-oauth-secret",
          expiresAt: "not-a-date",
        }),
      ).warnings,
    ).toEqual([
      {
        code: "claude_session_expiry_unparseable",
        safeMessage: "Claude session expiry could not be parsed.",
      },
    ]);

    expect(
      validateClaudeSessionArtifact(
        sessionArtifactFromClaudeOAuth({
          oauthToken: "claude-oauth-secret",
          expiresAt: "2020-01-01T00:00:00.000Z",
        }),
      ).warnings,
    ).toEqual([
      {
        code: "claude_session_expired",
        safeMessage: "Claude session appears expired.",
      },
    ]);
  });

  it("validates refresh requests without rotating Claude sessions", async () => {
    const result = await new ClaudeSessionDriver().refreshSession({
      session: validSession,
      workspace: { path: "/tmp/claude-workspace" },
      runner: new StaticRunner(),
      redactor: new DefaultRedactor(),
      abortSignal: new AbortController().signal,
    });

    expect(result.artifact).toBe(validSession);
    expect(result.providerState).toBe("unchanged");
    expect(result.warnings.map((warning) => warning.code)).toContain(
      "claude_session_refresh_unavailable",
    );
  });

  it("classifies Claude lifecycle, auth, quota and permission failures", () => {
    expect(classifyClaudeRuntimeFailure("claude_bg_aborted")).toBe(
      "task_cancelled",
    );
    expect(classifyClaudeRuntimeFailure("claude_task_timeout:30000")).toBe(
      "task_timeout",
    );
    expect(
      classifyClaudeRuntimeFailure("claude_structured_output_invalid"),
    ).toBe("provider_output_invalid");
    expect(
      classifyClaudeRuntimeFailure("CLAUDE_CODE_OAUTH_TOKEN missing"),
    ).toBe("needs_reconnect");
    expect(classifyClaudeRuntimeFailure("You've hit your usage limit.")).toBe(
      "quota_limited",
    );
    expect(classifyClaudeRuntimeFailure("approval required")).toBe(
      "permission_required",
    );
  });

  it("passes task controls and configured Claude runtime knobs into the engine", async () => {
    const engine = new RecordingClaudeEngine({
      outputText: "result includes claude-oauth-secret",
      structuredOutput: { verdict: "APPROVE" },
    });
    const driver = new ClaudeTaskAgentDriver({
      appendSystemPrompt: "review mode",
      engine,
      model: "default-model",
      maxTurns: 1,
      allowedTools: ["Read"],
      mcpConfig: ['{"mcpServers":{"memora":{"command":"memora-server"}}}'],
      strictMcpConfig: true,
    });
    const result = await driver.runTask({
      session: validSession,
      task: {
        kind: "structured-prompt",
        prompt: "inspect diff",
        controls: {
          model: "claude-task-model",
          maxTurns: 3,
          allowedTools: ["Read", "Grep"],
          permissionMode: "read-only",
          outputSchemaName: "review-verdict",
        },
      },
      workspace: { path: "/tmp/claude-workspace" },
      runner: new StaticRunner(),
      redactor: new DefaultRedactor(),
      abortSignal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "completed",
      outputText: "result includes [redacted:claude-oauth-token]",
      structuredOutput: { verdict: "APPROVE" },
      telemetry: {
        providerRunId: "claude-run-1",
        finishReason: "completed",
      },
    });
    expect(result.telemetry?.durationMs).toEqual(expect.any(Number));
    expect(engine.records[0]).toMatchObject({
      prompt: "inspect diff",
      workspacePath: "/tmp/claude-workspace",
      appendSystemPrompt: "review mode",
      model: "claude-task-model",
      maxTurns: 3,
      allowedTools: ["Read", "Grep"],
      mcpConfig: ['{"mcpServers":{"memora":{"command":"memora-server"}}}'],
      permissionMode: "read-only",
      strictMcpConfig: true,
      outputSchemaName: "review-verdict",
    });
  });

  it("fails clearly when a Claude task has no session", async () => {
    const result = await new ClaudeTaskAgentDriver({
      engine: new RecordingClaudeEngine(),
    }).runTask({
      session: null,
      task: { kind: "review", prompt: "inspect diff" },
      workspace: { path: "/tmp/claude-workspace" },
      runner: new StaticRunner(),
      redactor: new DefaultRedactor(),
      abortSignal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: "provider_session_invalid",
        reconnectRequired: true,
      },
      telemetry: {
        finishReason: "provider_error",
      },
    });
  });

  it("maps Claude engine aborts to cancelled task telemetry", async () => {
    const result = await new ClaudeTaskAgentDriver({
      engine: new RecordingClaudeEngine({
        throwMessage: "claude_bg_aborted",
      }),
    }).runTask({
      session: validSession,
      task: { kind: "review", prompt: "inspect diff" },
      workspace: { path: "/tmp/claude-workspace" },
      runner: new StaticRunner(),
      redactor: new DefaultRedactor(),
      abortSignal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: "task_cancelled",
      },
      telemetry: {
        finishReason: "cancelled",
      },
    });
  });

  it("exposes a combined provider driver for composition roots", async () => {
    const engine = new RecordingClaudeEngine({ outputText: "combined output" });
    const driver = new ClaudeBgProviderDriver({ engine });
    const result = await driver.runTask({
      session: validSession,
      task: { kind: "review", prompt: "review pull request" },
      workspace: { path: "/tmp/claude-workspace" },
      runner: new StaticRunner(),
      redactor: new DefaultRedactor(),
      abortSignal: new AbortController().signal,
    });

    expect(driver.providerId).toBe("claude");
    expect(driver.agentId).toBe("claude-bg-task");
    expect(driver.capabilities).toBe(claudeSessionCapabilities);
    expect(driver.agentCapabilities).toBe(claudeBgTaskAgentCapabilities);
    expect(result).toMatchObject({
      status: "completed",
      outputText: "combined output",
    });
    expect(engine.records[0]?.prompt).toBe("review pull request");
  });

  it("streams through the combined provider driver", async () => {
    const engine = new StreamingClaudeEngine();
    const driver = new ClaudeBgProviderDriver({ engine });
    const events = await collectEvents(driver.streamTask({
      session: validSession,
      task: { kind: "review", prompt: "review claude-oauth-secret" },
      workspace: { path: "/tmp/claude-workspace" },
      runner: new StaticRunner(),
      redactor: new DefaultRedactor(),
      abortSignal: new AbortController().signal,
    }));

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "text_delta",
      "completed",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      result: {
        status: "completed",
        outputText: "stream:review [redacted:claude-oauth-token]",
      },
    });
    expect(events[1]).toMatchObject({
      type: "text_delta",
      text: "stream:review [redacted:claude-oauth-token]",
    });
    expect(engine.records[0]?.prompt).toBe("review claude-oauth-secret");
  });

  it("adapts claude-runtime BG provider as a concrete task engine", async () => {
    const fakeProvider = new FakeClaudeRuntimeProvider([
      { type: "assistant_message", text: "thinking" },
      {
        type: "result_available",
        result: {
          text: '{"verdict":"APPROVE"}',
          usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
        },
      },
    ]);
    const engine = new ClaudeRuntimeTaskExecutionEngine({
      commandTimeoutMs: 1234,
      pollIntervalMs: 10,
      runtimeModuleLoader: async () => fakeRuntimeModule,
      providerModuleLoader: async () => fakeProviderModule(fakeProvider),
      stateFilePath: "/tmp/subscription-runtime-claude-state.json",
    });

    const result = await engine.run({
      allowedTools: ["Read", "Grep"],
      appendSystemPrompt: "system",
      abortSignal: new AbortController().signal,
      mcpConfig: ['{"mcpServers":{}}'],
      model: "claude-sonnet-test",
      outputSchemaName: "review-verdict",
      permissionMode: "read-only",
      prompt: "review",
      redactor: new DefaultRedactor(),
      runner: new StaticRunner(),
      session: {
        authMode: "oauth",
        configDir: "/tmp/claude-config",
        oauthToken: "claude-oauth-secret",
      },
      strictMcpConfig: true,
      workspacePath: "/tmp/workspace",
    });

    expect(result).toMatchObject({
      outputText: 'thinking\n{"verdict":"APPROVE"}',
      structuredOutput: { verdict: "APPROVE" },
      telemetry: {
        providerRunId: "run-1",
        providerSessionId: "session-1",
        usage: {
          inputTokens: 12,
          outputTokens: 5,
          totalTokens: 17,
        },
      },
    });
    expect(fakeProvider.removed).toBe(true);
    expect(fakeProvider.startRequests[0]?.command).toMatchObject({
      allowedTools: ["Read", "Grep"],
      appendSystemPrompt: "system",
      cwd: "/tmp/workspace",
      mcpConfig: ['{"mcpServers":{}}'],
      model: "claude-sonnet-test",
      permissionMode: "dontAsk",
      prompt: "review",
      strictMcpConfig: true,
    });
    expect(fakeProvider.constructorOptions).toMatchObject({
      commandTimeoutMs: 1234,
      configDir: "/tmp/claude-config",
      oauthToken: "claude-oauth-secret",
      pollIntervalMs: 10,
    });
  });

  it("builds claude-runtime BG provider context with default state isolation", async () => {
    const fakeProvider = new FakeClaudeRuntimeProvider([]);

    const context = await createClaudeBgRuntimeContext(
      {
        configDir: "/tmp/claude-config",
        oauthToken: "claude-oauth-secret",
      },
      {
        baseEnv: { CLAUDE_CONFIG_DIR: "/tmp/claude-config" },
        runtimeModuleLoader: async () => fakeRuntimeModule,
        providerModuleLoader: async () => fakeProviderModule(fakeProvider),
      },
    );

    expect(context.runtime).toBe(fakeRuntimeModule);
    expect(context.provider.id).toBe("fake-claude-bg");
    expect(fakeProvider.constructorOptions).toMatchObject({
      baseEnv: { CLAUDE_CONFIG_DIR: "/tmp/claude-config" },
      configDir: "/tmp/claude-config",
      oauthToken: "claude-oauth-secret",
      store: {
        options: {
          filePath:
            "/tmp/claude-config/subscription-runtime-claude-bg-state.json",
        },
      },
    });
    expect(fakeProvider.constructorOptions.fs).toBeDefined();
    expect(fakeProvider.constructorOptions.runner).toBeDefined();
    expect(fakeProvider.constructorOptions.redactor).toBeDefined();
  });

  it("streams claude-runtime BG events as provider-neutral task events", async () => {
    const longDiagnosticDetail = `prefix claude-oauth-secret ${"x".repeat(2500)}`;
    const fakeProvider = new FakeClaudeRuntimeProvider([
      {
        type: "tool_use",
        toolName: "mcp__memora__memory_get",
        input: { memory_id: 42, token: "claude-oauth-secret" },
      },
      {
        type: "tool_result",
        toolName: "mcp__memora__memory_get",
        output: "ok",
      },
      {
        type: "usage",
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      },
      {
        type: "diagnostic",
        code: "claude_runtime_warning",
        level: "warn",
        message: "token claude-oauth-secret was hidden",
        details: {
          raw: longDiagnosticDetail,
        },
      },
      { type: "assistant_message", text: "streamed verdict" },
    ]);
    const engine = new ClaudeRuntimeTaskExecutionEngine({
      runtimeModuleLoader: async () => fakeRuntimeModule,
      providerModuleLoader: async () => fakeProviderModule(fakeProvider),
    });
    const redactor = new DefaultRedactor();
    redactor.registerSecret("claude-oauth-secret", "claude-token");

    const events = await collectEvents(engine.stream({
      abortSignal: new AbortController().signal,
      model: "claude-sonnet-test",
      prompt: "review",
      redactor,
      runner: new StaticRunner(),
      session: {
        authMode: "oauth",
        configDir: "/tmp/claude-config",
        oauthToken: "claude-oauth-secret",
      },
      workspacePath: "/tmp/workspace",
    }));

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "tool_call",
      "tool_call",
      "usage",
      "warning",
      "text_delta",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      type: "tool_call",
      toolCall: {
        name: "mcp__memora__memory_get",
        safeInput: {
          memory_id: 42,
          token: "[redacted:claude-token]",
        },
        status: "started",
      },
    });
    expect(events[4]).toMatchObject({
      type: "warning",
      warning: {
        code: "claude_runtime_warning",
        safeMessage: "token [redacted:claude-token] was hidden",
        details: {
          raw: expect.stringContaining("[redacted:claude-token]"),
        },
      },
    });
    const warning = events[4];
    expect(warning?.type).toBe("warning");
    if (warning?.type === "warning") {
      expect(warning.warning.details?.raw).not.toContain("claude-oauth-secret");
      expect(warning.warning.details?.raw?.length).toBeLessThanOrEqual(2000);
    }
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      result: {
        status: "completed",
        outputText: "streamed verdict",
      },
      telemetry: {
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      },
    });
    expect(fakeProvider.removed).toBe(true);
  });

  it("deduplicates live claude-runtime final result text", async () => {
    const fakeProvider = new FakeClaudeRuntimeProvider([
      { type: "assistant_message", text: "final verdict" },
      {
        type: "result_available",
        result: {
          detail: "final verdict",
          output: "final verdict",
          summary: "replied with requested string",
          text: "final verdict",
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        },
      },
    ]);
    const engine = new ClaudeRuntimeTaskExecutionEngine({
      runtimeModuleLoader: async () => fakeRuntimeModule,
      providerModuleLoader: async () => fakeProviderModule(fakeProvider),
    });

    const events = await collectEvents(engine.stream({
      abortSignal: new AbortController().signal,
      model: "claude-sonnet-test",
      prompt: "review",
      redactor: new DefaultRedactor(),
      runner: new StaticRunner(),
      session: {
        authMode: "oauth",
        configDir: "/tmp/claude-config",
        oauthToken: "claude-oauth-secret",
      },
      workspacePath: "/tmp/workspace",
    }));

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "text_delta",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      type: "text_delta",
      text: "final verdict",
    });
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      result: {
        status: "completed",
        outputText: "final verdict",
      },
      telemetry: {
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    });
  });

  it("requires configDir for claude-runtime task engine sessions", async () => {
    const engine = new ClaudeRuntimeTaskExecutionEngine({
      runtimeModuleLoader: async () => fakeRuntimeModule,
      providerModuleLoader: async () =>
        fakeProviderModule(new FakeClaudeRuntimeProvider([])),
    });

    await expect(
      engine.run({
        abortSignal: new AbortController().signal,
        model: "claude-sonnet-test",
        prompt: "review",
        redactor: new DefaultRedactor(),
        runner: new StaticRunner(),
        session: {
          authMode: "oauth",
          oauthToken: "claude-oauth-secret",
        },
        workspacePath: "/tmp/workspace",
      }),
    ).rejects.toThrow("claude_config_dir_required");
  });
});

providerSessionDriverContract("claude", () => ({
  driver: new ClaudeSessionDriver(),
  goodSession: validSession,
  redactor: new DefaultRedactor(),
  reconnectError: new Error("CLAUDE_CODE_OAUTH_TOKEN missing token=raw"),
}));

agentDriverContract("claude-bg-task", () => ({
  driver: new ClaudeTaskAgentDriver({
    engine: new RecordingClaudeEngine({ outputText: "contract output" }),
  }),
  goodSession: validSession,
  redactor: new DefaultRedactor(),
}));

const runnerCapabilities: RunnerCapabilities = {
  runnerId: "claude-test-runner",
  supportsEnvAllowlist: true,
  supportsWorkingDirectory: true,
  supportsTimeout: true,
  supportsAbortSignal: true,
  supportsOutputRedaction: true,
  supportsReadOnlySandbox: true,
  readOnlyFilesystem: false,
  platform: "node-process",
};

class StaticRunner implements RunnerPort {
  readonly runnerId = "claude-test-runner";
  readonly capabilities = runnerCapabilities;

  async run(): Promise<ProcessResult> {
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
  }
}

class RecordingClaudeEngine implements ClaudeTaskExecutionEngine {
  readonly kind = "recording-claude";
  readonly capabilities = {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsUsage: true,
    supportsProviderRunId: true,
    supportsCleanup: true,
  };
  readonly records: ClaudeTaskEngineInput[] = [];

  constructor(
    private readonly behavior: {
      readonly outputText?: string;
      readonly structuredOutput?: unknown;
      readonly throwMessage?: string;
    } = {},
  ) {}

  async run(input: ClaudeTaskEngineInput) {
    this.records.push(input);
    if (this.behavior.throwMessage) {
      throw new Error(this.behavior.throwMessage);
    }
    return {
      outputText: this.behavior.outputText ?? `claude:${input.prompt}`,
      ...(this.behavior.structuredOutput === undefined
        ? {}
        : { structuredOutput: this.behavior.structuredOutput }),
      telemetry: {
        providerRunId: "claude-run-1",
        turns: 2,
        usage: {
          inputTokens: 12,
          outputTokens: 4,
          totalTokens: 16,
        },
      },
      warnings: [],
    };
  }
}

class StreamingClaudeEngine extends RecordingClaudeEngine {
  override readonly capabilities = {
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsUsage: true,
    supportsProviderRunId: true,
    supportsCleanup: true,
  };

  async *stream(input: ClaudeTaskEngineInput): AsyncIterable<ProviderTaskEvent> {
    this.records.push(input);
    yield {
      type: "started",
      occurredAt: new Date(),
      telemetry: { providerRunId: "stream-run-1" },
    };
    yield {
      type: "text_delta",
      occurredAt: new Date(),
      text: `stream:${input.prompt}`,
    };
    yield {
      type: "completed",
      occurredAt: new Date(),
      result: {
        status: "completed",
        outputText: `stream:${input.prompt}`,
        telemetry: { providerRunId: "stream-run-1" },
        warnings: [],
      },
      telemetry: { providerRunId: "stream-run-1" },
    };
  }
}

const fakeRuntimeModule = {
  asCommandId: (value: string) => value,
  asIsoTimestamp: (value: string) => value,
  asThreadId: (value: string) => value,
  FileRuntimeStateStore: class {
    constructor(readonly options: { readonly filePath: string }) {}
  },
};

function fakeProviderModule(provider: FakeClaudeRuntimeProvider) {
  return {
    ClaudeBgRuntimeProvider: class {
      readonly id = provider.id;

      constructor(options: Record<string, unknown>) {
        provider.constructorOptions = options;
      }

      start(request: Parameters<FakeClaudeRuntimeProvider["start"]>[0]) {
        return provider.start(request);
      }

      observe() {
        return provider.observe();
      }

      remove() {
        return provider.remove();
      }
    },
    NodeProcessRunner: class {
      constructor(readonly options?: Record<string, unknown>) {}
    },
    SecretRedactor: class {
      constructor(readonly options?: { readonly secrets?: readonly string[] }) {}
    },
  };
}

class FakeClaudeRuntimeProvider {
  readonly id = "fake-claude-bg";
  readonly startRequests: Array<{
    readonly command: unknown;
    readonly providerId: string;
    readonly requestedAt: string;
    readonly threadId: string;
  }> = [];
  constructorOptions: Record<string, unknown> = {};
  removed = false;

  constructor(private readonly events: readonly FakeClaudeRuntimeEvent[]) {}

  async start(request: {
    readonly command: unknown;
    readonly providerId: string;
    readonly requestedAt: string;
    readonly threadId: string;
  }) {
    this.startRequests.push(request);
    return { runId: "run-1", providerSessionId: "session-1" };
  }

  async *observe(): AsyncIterable<FakeClaudeRuntimeEvent> {
    for (const event of this.events) {
      yield event;
    }
  }

  async remove(): Promise<void> {
    this.removed = true;
  }
}

type FakeClaudeRuntimeEvent =
  | { readonly type: "assistant_message"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly toolName: string;
      readonly input?: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly toolName?: string;
      readonly output?: unknown;
      readonly isError?: boolean;
    }
  | {
      readonly type: "usage";
      readonly usage: {
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        readonly totalTokens?: number;
      };
    }
  | {
      readonly type: "diagnostic";
      readonly code?: string;
      readonly level?: string;
      readonly message?: string;
      readonly details?: unknown;
    }
  | {
      readonly type: "result_available";
      readonly result: {
        readonly detail?: string;
        readonly output?: unknown;
        readonly summary?: string;
        readonly text?: string;
        readonly usage?: {
          readonly inputTokens?: number;
          readonly outputTokens?: number;
          readonly totalTokens?: number;
        };
      };
    };

async function collectEvents(
  iterable: AsyncIterable<ProviderTaskEvent>,
): Promise<ProviderTaskEvent[]> {
  const events: ProviderTaskEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
