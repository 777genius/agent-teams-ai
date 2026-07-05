import { describe, expect, it } from "vitest";
import {
  DefaultRedactor,
  providerTaskSystemPromptMaxBytes,
  type ProviderFailure,
  type ProviderTaskEvent,
  type ProcessResult,
  type RunnerCapabilities,
  type RunnerPort,
} from "@vioxen/subscription-runtime/core";
import {
  agentDriverContract,
  providerSessionDriverContract,
} from "../../core/testing/contracts";
import {
  ClaudeBgProviderDriver,
  ClaudeCliTaskExecutionEngine,
  ClaudeRuntimeTaskExecutionEngine,
  ClaudeProviderFailureError,
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
    expect(classifyClaudeRuntimeFailure("rate_limit_exceeded")).toBe(
      "quota_limited",
    );
    expect(classifyClaudeRuntimeFailure("Too many requests")).toBe(
      "quota_limited",
    );
    expect(
      classifyClaudeRuntimeFailure(
        "5 messages remaining until your usage limit resets",
      ),
    ).toBe("quota_limited");
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
          editMode: "read-only",
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
      editMode: "read-only",
      strictMcpConfig: true,
      outputSchemaName: "review-verdict",
    });
  });

  it("merges per-task system prompts with configured Claude runtime prompts", async () => {
    const engine = new RecordingClaudeEngine();
    const driver = new ClaudeTaskAgentDriver({
      appendSystemPrompt: "default system",
      engine,
    });

    await driver.runTask({
      session: validSession,
      task: {
        kind: "review",
        prompt: "inspect diff",
        systemPrompt: "task-specific system",
      },
      workspace: { path: "/tmp/claude-workspace" },
      runner: new StaticRunner(),
      redactor: new DefaultRedactor(),
      abortSignal: new AbortController().signal,
    });

    expect(engine.records[0]).toMatchObject({
      prompt: "inspect diff",
      appendSystemPrompt: "default system\n\ntask-specific system",
    });
  });

  it("rejects direct Claude system prompts before calling the engine", async () => {
    const engine = new RecordingClaudeEngine();
    const driver = new ClaudeTaskAgentDriver({ engine });

    await expect(
      driver.runTask({
        session: validSession,
        task: {
          kind: "review",
          prompt: "inspect diff",
          systemPrompt: "x".repeat(providerTaskSystemPromptMaxBytes + 1),
        },
        workspace: { path: "/tmp/claude-workspace" },
        runner: new StaticRunner(),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      `task.systemPrompt exceeds ${providerTaskSystemPromptMaxBytes} bytes`,
    );
    expect(engine.records).toEqual([]);
  });

  it("rejects streamed Claude system prompts before calling the engine", async () => {
    const engine = new StreamingClaudeEngine();
    const driver = new ClaudeTaskAgentDriver({ engine });
    const iterator = driver
      .streamTask({
        session: validSession,
        task: {
          kind: "review",
          prompt: "inspect diff",
          systemPrompt: " ",
        },
        workspace: { path: "/tmp/claude-workspace" },
        runner: new StaticRunner(),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow(
      "task.systemPrompt must not be empty",
    );
    expect(engine.records).toEqual([]);
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

  it("preserves typed Claude runtime failure diagnostics", async () => {
    const redactor = new DefaultRedactor();
    redactor.registerSecret("raw-claude-token", "claude-token");
    const result = await new ClaudeTaskAgentDriver({
      engine: new RecordingClaudeEngine({
        throwFailure: {
          code: "permission_required",
          retryable: false,
          reconnectRequired: false,
          safeMessage: "Claude permission required for raw-claude-token.",
          causeCategory: "permission_required",
          details: {
            runtimeMessage: "approval required for raw-claude-token",
          },
        },
      }),
    }).runTask({
      session: validSession,
      task: { kind: "review", prompt: "inspect diff" },
      workspace: { path: "/tmp/claude-workspace" },
      runner: new StaticRunner(),
      redactor,
      abortSignal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: "permission_required",
        safeMessage: "Claude permission required for [redacted:claude-token].",
        details: {
          runtimeMessage: "approval required for [redacted:claude-token]",
        },
      },
      telemetry: {
        finishReason: "provider_error",
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
      pluginDirs: ["/opt/quanta-plugin"],
      pollIntervalMs: 10,
      runtimeModuleLoader: async () => fakeRuntimeModule,
      providerModuleLoader: async () => fakeProviderModule(fakeProvider),
      settingsPath: "/tmp/claude-statusline-settings.json",
      stateFilePath: "/tmp/subscription-runtime-claude-state.json",
    });

    const result = await engine.run({
      allowedTools: ["Read", "Grep"],
      appendSystemPrompt: "system",
      abortSignal: new AbortController().signal,
      maxTurns: 5,
      mcpConfig: ['{"mcpServers":{}}'],
      model: "claude-sonnet-test",
      outputSchemaName: "review-verdict",
      editMode: "read-only",
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
      maxTurns: 5,
      model: "claude-sonnet-test",
      permissionMode: "dontAsk",
      pluginDirs: ["/opt/quanta-plugin"],
      prompt: "review",
      settings: "/tmp/claude-statusline-settings.json",
      strictMcpConfig: true,
    });
    expect(fakeProvider.constructorOptions).toMatchObject({
      commandTimeoutMs: 1234,
      configDir: "/tmp/claude-config",
      oauthToken: "claude-oauth-secret",
      pollIntervalMs: 10,
    });
  });

  it("runs Claude CLI fallback with isolated explicit OAuth auth", async () => {
    const runner = new RecordingRunner({
      stdout: '{"verdict":"APPROVE"}\n',
      stderr: "diagnostic\n",
      durationMs: 42,
    });
    const engine = new ClaudeCliTaskExecutionEngine({
      baseEnv: {
        PATH: "/usr/bin",
        HOME: "/Users/real-home",
        CLAUDE_CODE_OAUTH_TOKEN: "must-not-inherit",
        GITHUB_TOKEN: "must-not-pass",
      },
      claudePath: "/usr/local/bin/claude",
      timeoutMs: 1234,
    });
    const redactor = new DefaultRedactor();
    redactor.registerSecret("claude-oauth-secret", "claude-token");

    const result = await engine.run({
      allowedTools: ["Read", "Grep"],
      appendSystemPrompt: "system",
      abortSignal: new AbortController().signal,
      maxTurns: 1,
      mcpConfig: ['{"mcpServers":{}}'],
      model: "sonnet",
      outputSchemaName: "review-verdict",
      editMode: "read-only",
      disallowedTools: ["Bash", "Edit"],
      prompt: "review",
      redactor,
      runner,
      session: {
        authMode: "oauth",
        configDir: "/tmp/claude-config",
        oauthToken: "claude-oauth-secret",
      },
      strictMcpConfig: true,
      workspacePath: "/tmp/workspace",
    });

    expect(result).toMatchObject({
      outputText: '{"verdict":"APPROVE"}',
      structuredOutput: { verdict: "APPROVE" },
      telemetry: { durationMs: 42 },
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "claude_cli_max_turns_unsupported",
      "claude_cli_stderr",
    ]);
    expect(runner.lastRun).toMatchObject({
      command: "/usr/local/bin/claude",
      cwd: "/tmp/workspace",
      timeoutMs: 1234,
      env: {
        PATH: "/usr/bin",
        HOME: "/tmp/claude-config",
        CLAUDE_CONFIG_DIR: "/tmp/claude-config",
        CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-secret",
        CI: "true",
      },
    });
    expect(runner.lastRun?.env.GITHUB_TOKEN).toBeUndefined();
    expect(runner.lastRun?.args).toEqual([
      "--print",
      "--safe-mode",
      "--no-session-persistence",
      "--output-format",
      "text",
      "--model",
      "sonnet",
      "--permission-mode",
      "dontAsk",
      "--append-system-prompt",
      "system",
      "--allowedTools",
      "Read,Grep",
      "--disallowedTools",
      "Bash,Edit",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--strict-mcp-config",
      "review",
    ]);
  });

  it("rejects write-capable allowed tools when Claude permission mode is read-only", async () => {
    const engine = new ClaudeRuntimeTaskExecutionEngine({
      runtimeModuleLoader: async () => fakeRuntimeModule,
      providerModuleLoader: async () =>
        fakeProviderModule(new FakeClaudeRuntimeProvider([])),
    });

    await expect(
      engine.run({
        abortSignal: new AbortController().signal,
        allowedTools: ["Read", "Bash", "Edit"],
        model: "claude-sonnet-test",
        editMode: "read-only",
        prompt: "review",
        redactor: new DefaultRedactor(),
        runner: new StaticRunner(),
        session: {
          authMode: "oauth",
          configDir: "/tmp/claude-config",
          oauthToken: "claude-oauth-secret",
        },
        workspacePath: "/tmp/workspace",
      }),
    ).rejects.toThrow("claude_read_only_allowed_tools_unsafe:Bash,Edit");
  });

  it("maps danger-full-access provider sandbox to bypassPermissions", async () => {
    const fakeProvider = new FakeClaudeRuntimeProvider([
      {
        type: "result_available",
        result: {
          text: "done",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    ]);
    const engine = new ClaudeRuntimeTaskExecutionEngine({
      runtimeModuleLoader: async () => fakeRuntimeModule,
      providerModuleLoader: async () => fakeProviderModule(fakeProvider),
    });

    await engine.run({
      abortSignal: new AbortController().signal,
      allowedTools: ["Bash", "mcp__memora__*"],
      editMode: "allow-edits",
      model: "claude-sonnet-test",
      providerSandboxMode: "danger-full-access",
      prompt: "post review",
      redactor: new DefaultRedactor(),
      runner: new StaticRunner(),
      session: {
        authMode: "oauth",
        configDir: "/tmp/claude-config",
        oauthToken: "claude-oauth-secret",
      },
      workspacePath: "/tmp/workspace",
    });

    expect(fakeProvider.startRequests[0]?.command).toMatchObject({
      allowedTools: ["Bash", "mcp__memora__*"],
      permissionMode: "bypassPermissions",
    });
  });

  it("fails structured Claude tasks when the runtime returns invalid JSON", async () => {
    const fakeProvider = new FakeClaudeRuntimeProvider([
      {
        type: "result_available",
        result: {
          text: "not json",
        },
      },
    ]);
    const driver = new ClaudeTaskAgentDriver({
      engine: new ClaudeRuntimeTaskExecutionEngine({
        runtimeModuleLoader: async () => fakeRuntimeModule,
        providerModuleLoader: async () => fakeProviderModule(fakeProvider),
      }),
    });

    const result = await driver.runTask({
      session: validSession,
      task: {
        kind: "structured-prompt",
        prompt: "review",
        outputSchemaName: "review-verdict",
      },
      workspace: { path: "/tmp/claude-workspace" },
      runner: new StaticRunner(),
      redactor: new DefaultRedactor(),
      abortSignal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: "provider_output_invalid",
        retryable: true,
        reconnectRequired: false,
      },
      telemetry: {
        finishReason: "provider_error",
      },
    });
    expect(fakeProvider.removed).toBe(true);
  });

  it("resumes claude-runtime logical threads through provider send", async () => {
    const fakeProvider = new FakeClaudeRuntimeProvider([
      { type: "assistant_message", text: "resumed answer" },
    ]);
    const engine = new ClaudeRuntimeTaskExecutionEngine({
      runtimeModuleLoader: async () => fakeRuntimeModule,
      providerModuleLoader: async () => fakeProviderModule(fakeProvider),
    });

    const result = await engine.run({
      abortSignal: new AbortController().signal,
      model: "claude-sonnet-test",
      prompt: "continue review",
      redactor: new DefaultRedactor(),
      runner: new StaticRunner(),
      runtimeThread: {
        threadId: "logical-review-thread",
        resumeSessionId: "previous-claude-session",
      },
      session: {
        authMode: "oauth",
        configDir: "/tmp/claude-config",
        oauthToken: "claude-oauth-secret",
      },
      workspacePath: "/tmp/workspace",
    });

    expect(result).toMatchObject({
      outputText: "resumed answer",
      telemetry: {
        providerRunId: "run-2",
        providerSessionId: "session-2",
      },
    });
    expect(fakeProvider.startRequests).toHaveLength(0);
    expect(fakeProvider.sendRequests).toHaveLength(1);
    expect(fakeProvider.sendRequests[0]).toMatchObject({
      previousProviderSessionId: "previous-claude-session",
      thread: {
        id: "logical-review-thread",
        cwd: "/tmp/workspace",
        latestProviderSessionId: "previous-claude-session",
      },
      command: {
        mode: "followup",
        prompt: "continue review",
        threadId: "logical-review-thread",
      },
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
    expect(Object.hasOwn(fakeProvider.constructorOptions, "redactor")).toBe(false);
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
        output: "ok claude-oauth-secret",
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
    expect(events[2]).toMatchObject({
      type: "tool_call",
      toolCall: {
        name: "mcp__memora__memory_get",
        safeInputPreview: "ok [redacted:claude-token]",
        safeOutputPreview: "ok [redacted:claude-token]",
        status: "completed",
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

class RecordingRunner implements RunnerPort {
  readonly runnerId = "recording-runner";
  readonly capabilities = runnerCapabilities;
  lastRun: Parameters<RunnerPort["run"]>[0] | null = null;

  constructor(private readonly result: Partial<ProcessResult> = {}) {}

  async run(input: Parameters<RunnerPort["run"]>[0]): Promise<ProcessResult> {
    this.lastRun = input;
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 1,
      ...this.result,
    };
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
      readonly throwFailure?: ProviderFailure;
    } = {},
  ) {}

  async run(input: ClaudeTaskEngineInput) {
    this.records.push(input);
    if (this.behavior.throwMessage) {
      throw new Error(this.behavior.throwMessage);
    }
    if (this.behavior.throwFailure) {
      throw new ClaudeProviderFailureError(this.behavior.throwFailure);
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

      send(request: Parameters<FakeClaudeRuntimeProvider["send"]>[0]) {
        return provider.send(request);
      }

      observe() {
        return provider.observe();
      }

      remove() {
        return provider.remove();
      }
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
  readonly sendRequests: Array<{
    readonly thread: unknown;
    readonly command: unknown;
    readonly previousProviderSessionId?: string;
    readonly requestedAt: string;
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

  async send(request: {
    readonly thread: unknown;
    readonly command: unknown;
    readonly previousProviderSessionId?: string;
    readonly requestedAt: string;
  }) {
    this.sendRequests.push(request);
    return { runId: "run-2", providerSessionId: "session-2" };
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
