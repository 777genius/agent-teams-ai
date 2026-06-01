import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "@777genius/subscription-runtime/core";
import {
  agentDriverContract,
  providerSessionDriverContract,
} from "@777genius/subscription-runtime/testing";
import type {
  ProcessResult,
  RunnerPort,
  RunnerCapabilities,
} from "@777genius/subscription-runtime/core";
import {
  CodexCliAgentDriver,
  CodexCliProviderDriver,
  CodexCliSessionDriver,
  CodexWorkerCacheSessionMaterializer,
  CodexWorkerCacheSessionPoolMaterializer,
  CodexAppServerExecutionEngine,
  CodexJsonAgentDriver,
  PackagedCodexJsonExecutionEngine,
  buildCodexJsonExecArgs,
  codexAgentCapabilities,
  codexEnvironmentPolicy,
  codexJsonAgentCapabilities,
  codexProviderManifest,
  codexSessionCapabilities,
  sessionArtifactFromCodexAuthJson,
  validateCodexSessionArtifact,
} from "../index";
import type { CodexExecutionEngine } from "../codex-json-execution-engine";
import type { CodexSessionMaterializer } from "../codex-session-materializer";
import { classifyCodexRuntimeFailure } from "../codex-cli-domain";
import { pruneCodexChildEnv } from "../codex-cli-domain";
import { isTransientCodexTempCleanupError } from "../codex-cli-temp-cleanup";

const validAuthJson = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    refresh_token: "refresh-token",
    access_token: "access-token",
  },
  last_refresh: "2026-05-24T12:00:00.000Z",
});

const refreshedAuthJson = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    refresh_token: "refreshed-refresh-token",
    access_token: "refreshed-access-token",
  },
  last_refresh: "2026-05-25T12:00:00.000Z",
});

describe("Codex provider adapter", () => {
  it("classifies quota failures without matching generic support guidance", () => {
    expect(
      classifyCodexRuntimeFailure(
        "Error 429: rate limit exceeded for this account",
      ),
    ).toBe("quota_limited");
    expect(
      classifyCodexRuntimeFailure(
        "insufficient_quota: You exceeded your current quota",
      ),
    ).toBe("quota_limited");
    expect(classifyCodexRuntimeFailure("You've hit your usage limit.")).toBe(
      "quota_limited",
    );
    expect(
      classifyCodexRuntimeFailure(
        "Visit https://chatgpt.com/codex/settings/usage to purchase more credits",
      ),
    ).toBe("quota_limited");
    expect(
      classifyCodexRuntimeFailure(
        "However, not enough retry quota is available for another attempt",
      ),
    ).toBe("quota_limited");
    expect(
      classifyCodexRuntimeFailure(
        "Check the required provider credentials, CLI setup, model name, and quota.",
      ),
    ).toBe("unknown_auth_state");
    expect(
      classifyCodexRuntimeFailure(
        "Verify the key has quota and access to the configured model.",
      ),
    ).toBe("unknown_auth_state");
  });

  it("recognizes transient Codex temp cleanup races", () => {
    const error = Object.assign(
      new Error(
        "ENOTEMPTY: directory not empty, rmdir '/tmp/codex-home/.tmp/plugins-clone-test'",
      ),
      { code: "ENOTEMPTY" },
    );

    expect(isTransientCodexTempCleanupError(error)).toBe(true);
    expect(isTransientCodexTempCleanupError(new Error("boom"))).toBe(false);
  });

  it("declares split session and agent capabilities", () => {
    expect(codexSessionCapabilities.providerId).toBe("codex");
    expect(codexSessionCapabilities.refreshMayRotateSession).toBe(true);
    expect(codexSessionCapabilities.environmentPolicy).toBe(
      codexEnvironmentPolicy,
    );
    expect(codexEnvironmentPolicy.credentialSourceOrder).toEqual([
      "codex-auth-json-file",
    ]);
    expect(codexAgentCapabilities.agentId).toBe("codex-cli");
    expect(codexAgentCapabilities.providerId).toBe("codex");
    expect(codexJsonAgentCapabilities.agentId).toBe("codex-json");
    expect(codexJsonAgentCapabilities.providerId).toBe("codex");
  });

  it("supports lazy refresh freshness checks from Codex auth metadata", async () => {
    const driver = new CodexCliSessionDriver({ refreshMode: "lazy-refresh" });
    const session = sessionArtifactFromCodexAuthJson(
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          refresh_token: "refresh-token",
          access_token: "access-token",
          expiry: "2026-05-30T00:20:00.000Z",
        },
        last_refresh: "2026-05-30T00:00:00.000Z",
      }),
    );

    expect(driver.capabilities.refreshMode).toBe("lazy-refresh");
    await expect(
      driver.inspectSessionFreshness({
        session,
        redactor: new DefaultRedactor(),
        now: new Date("2026-05-30T00:05:00.000Z"),
        policy: {
          minFreshMs: 60_000,
          refreshBeforeExpiryMs: 5 * 60_000,
          maxSessionAgeMs: 24 * 60 * 60_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "fresh",
      reason: "expires_later",
    });

    await expect(
      driver.inspectSessionFreshness({
        session,
        redactor: new DefaultRedactor(),
        now: new Date("2026-05-30T00:05:00.000Z"),
        policy: {
          minFreshMs: 60_000,
          refreshBeforeExpiryMs: 5 * 60_000,
          maxSessionAgeMs: 4 * 60_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "refresh_recommended",
      reason: "max_age_exceeded",
      expiresAt: new Date("2026-05-30T00:20:00.000Z"),
      refreshedAt: new Date("2026-05-30T00:00:00.000Z"),
    });

    await expect(
      driver.inspectSessionFreshness({
        session,
        redactor: new DefaultRedactor(),
        now: new Date("2026-05-30T00:16:00.000Z"),
        policy: {
          minFreshMs: 60_000,
          refreshBeforeExpiryMs: 5 * 60_000,
          maxSessionAgeMs: 24 * 60 * 60_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "refresh_recommended",
      reason: "expires_soon",
    });
  });

  it("applies the provider-owned environment policy before Codex subprocesses", () => {
    const env = pruneCodexChildEnv({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      CI: "true",
      CODEX_HOME: "/tmp/codex-home",
      GITHUB_TOKEN: "must-not-pass",
      OPENAI_API_KEY: "must-not-pass",
      REVIEWROUTER_CODEX_AUTH_JSON: "must-not-pass",
      SAFE_PUBLIC_FLAG: "ok",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      CI: "true",
      CODEX_HOME: "/tmp/codex-home",
    });
  });

  it("exposes a combined provider driver and manifest for composition roots", () => {
    const driver = new CodexCliProviderDriver({
      codexBinaryPath: "/bin/codex-test",
    });

    expect(driver.providerId).toBe("codex");
    expect(driver.agentId).toBe("codex-cli");
    expect(driver.capabilities).toBe(codexSessionCapabilities);
    expect(driver.agentCapabilities).toBe(codexAgentCapabilities);
    expect(codexProviderManifest).toMatchObject({
      adapterId: "provider.codex-cli",
      adapterKind: "combined-provider",
      capabilities: {
        agent: {
          agentId: "codex-json",
        },
      },
    });
    expect("custody" in codexProviderManifest).toBe(false);
  });

  it("validates Codex auth JSON as a session artifact", () => {
    const artifact = sessionArtifactFromCodexAuthJson(validAuthJson);
    const result = validateCodexSessionArtifact(artifact);

    expect(result.status).toBe("valid");
    expect(artifact.providerId).toBe("codex");
    expect(artifact.kind).toBe("json-file");
    expect(artifact.formatVersion).toBe("codex-auth-json-v1");
  });

  it("refreshes by writing an isolated Codex home and reading refreshed auth", async () => {
    const runner = new RefreshingRunner(refreshedAuthJson);
    const workspace = await mkdtemp(join(tmpdir(), "codex-provider-test-"));
    const driver = new CodexCliSessionDriver({
      codexBinaryPath: "/bin/codex-test",
      sourceEnv: {
        PATH: "/usr/bin",
        GITHUB_TOKEN: "must-not-pass",
      },
    });

    try {
      const result = await driver.refreshSession({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result.providerState).toBe("refreshed");
      expect(runner.lastEnv?.GITHUB_TOKEN).toBeUndefined();
      expect(runner.lastEnv?.CODEX_HOME).toBeTruthy();
      expect(new TextDecoder().decode(result.artifact.bytes)).toContain(
        "refreshed-refresh-token",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("runs a Codex task with redacted output", async () => {
    const runner = new StaticRunner("review output");
    const workspace = await mkdtemp(join(tmpdir(), "codex-agent-test-"));
    const driver = new CodexCliAgentDriver({
      codexBinaryPath: "/bin/codex-test",
      model: "gpt-test",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "inspect diff" },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "review output",
      });
      expect(runner.lastArgs).toContain("gpt-test");
      expect(runner.lastArgs).toContain("inspect diff");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("builds packaged JSON exec args without the human renderer path", () => {
    expect(
      buildCodexJsonExecArgs({
        jsonFlag: "--json",
        model: "gpt-test",
        reasoningEffort: "low",
      }),
    ).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-test",
      "--sandbox",
      "read-only",
      "--config",
      'approval_policy="never"',
      "--config",
      'model_reasoning_effort="low"',
      "--config",
      'model_verbosity="low"',
      "--config",
      'web_search="disabled"',
      "--config",
      "features.apps=false",
      "--config",
      "features.hooks=false",
      "--config",
      "features.memories=false",
      "--config",
      "features.multi_agent=false",
      "--config",
      "features.shell_snapshot=false",
      "--config",
      "features.skill_mcp_dependency_install=false",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--color",
      "never",
      "--skip-git-repo-check",
      "-",
    ]);
  });

  it("runs a Codex JSON task through the packaged execution engine", async () => {
    const runner = new StaticRunner(
      `${JSON.stringify({ type: "agent_message", message: "json review output" })}\n`,
    );
    const workspace = await mkdtemp(join(tmpdir(), "codex-json-agent-test-"));
    const driver = new CodexJsonAgentDriver({
      engine: new PackagedCodexJsonExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "inspect diff" },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "json review output",
      });
      expect(runner.lastArgs).toContain("--json");
      expect(runner.lastArgs).toContain("-");
      expect(runner.lastStdin).toBe("inspect diff");
      expect(runner.lastEnv?.CODEX_HOME).toBeTruthy();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("ignores non-JSON stdout lines before Codex JSON events", async () => {
    const runner = new StaticRunner(
      [
        "warning: codex wrote a non-json diagnostic",
        JSON.stringify({ type: "agent_message", message: "json output" }),
        "",
      ].join("\n"),
    );
    const workspace = await mkdtemp(join(tmpdir(), "codex-json-agent-test-"));
    const driver = new CodexJsonAgentDriver({
      engine: new PackagedCodexJsonExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "inspect diff" },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "json output",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails malformed JSON-looking Codex JSON events", async () => {
    const runner = new StaticRunner(
      [
        JSON.stringify({ type: "agent_message", message: "partial output" }),
        '{"type":"agent_message"',
        "",
      ].join("\n"),
    );
    const workspace = await mkdtemp(join(tmpdir(), "codex-json-agent-test-"));
    const driver = new CodexJsonAgentDriver({
      engine: new PackagedCodexJsonExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "inspect diff" },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "unknown_runtime_failure",
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("disposes the engine and materializer even when one disposal fails", async () => {
    let materializerDisposed = false;
    const driver = new CodexJsonAgentDriver({
      engine: {
        kind: "packaged-json",
        capabilities: {
          supportsStructuredOutput: true,
          supportsJsonEvents: true,
          supportsThreadResume: false,
          requiresSchemaFile: false,
        },
        async run() {
          return { outputText: "unused", warnings: [] };
        },
        dispose(): Promise<void> {
          throw new Error("engine_dispose_failed");
        },
      },
      sessionMaterializer: {
        mode: "ephemeral",
        async materialize() {
          throw new Error("unused");
        },
        async dispose() {
          materializerDisposed = true;
        },
      } satisfies CodexSessionMaterializer,
    });

    const error = await driver.dispose().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ code: "codex_json_agent_dispose_failed" });
    expect(materializerDisposed).toBe(true);
  });

  it("runs Codex JSON tasks through reusable app-server slots", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-server-test-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "codex-app-server-root-"));
    const fakeFactory = new FakeAppServerFactory();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        executionProfile: "stateless-completion",
      }),
      sessionMaterializer: new CodexWorkerCacheSessionPoolMaterializer({
        cacheKey: "provider-account:codex-test",
        slots: 2,
        rootDir: cacheRoot,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const run = (prompt: string) =>
        driver.runTask({
          session: sessionArtifactFromCodexAuthJson(validAuthJson),
          task: { kind: "review", prompt },
          workspace: { path: workspace },
          runner: new StaticRunner(""),
          redactor: new DefaultRedactor(),
          abortSignal: new AbortController().signal,
        });

      const [first, second] = await Promise.all([run("one"), run("two")]);

      expect(first).toMatchObject({
        status: "completed",
        outputText: "app-server output:one",
      });
      expect(second).toMatchObject({
        status: "completed",
        outputText: "app-server output:two",
      });
      expect(fakeFactory.spawnCount).toBe(2);
      expect(new Set(fakeFactory.codexHomes)).toHaveLength(2);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("fully prewarms reusable app-server slots before the first task", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-warm-test-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "codex-app-warm-root-"));
    const fakeFactory = new FakeAppServerFactory();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        executionProfile: "stateless-completion",
      }),
      sessionMaterializer: new CodexWorkerCacheSessionPoolMaterializer({
        cacheKey: "provider-account:codex-warm-test",
        slots: 1,
        rootDir: cacheRoot,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
      warmupPrompt: "warm slot",
    });

    try {
      const prewarm = await driver.prewarmSession({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        redactor: new DefaultRedactor(),
        workspacePath: workspace,
        runner: new StaticRunner(""),
        abortSignal: new AbortController().signal,
      });

      expect(prewarm).toMatchObject({
        reusable: true,
        engine: {
          kind: "app-server-pool",
          reusable: true,
        },
      });
      expect(fakeFactory.spawnCount).toBe(1);
      expect(fakeFactory.cwds).toEqual([prewarm.home]);
      expect(fakeFactory.prompts).toEqual(["warm slot"]);
      expect(
        fakeFactory.requests.find(
          (request) => request.method === "thread/start",
        )?.params,
      ).toMatchObject({
        baseInstructions: expect.stringContaining(
          "fast backend inference worker",
        ),
        developerInstructions: null,
        dynamicTools: [],
        environments: [],
        config: {
          web_search: "disabled",
          model_verbosity: "low",
          features: {
            apps: false,
            hooks: false,
            memories: false,
            multi_agent: false,
            shell_snapshot: false,
            skill_mcp_dependency_install: false,
          },
        },
      });
      const prewarmThreadStarts = fakeFactory.requests.filter(
        (request) => request.method === "thread/start",
      );
      expect(prewarmThreadStarts).toHaveLength(2);

      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "real task" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "app-server output:real task",
      });
      expect(fakeFactory.spawnCount).toBe(1);
      expect(fakeFactory.prompts).toEqual(["warm slot", "real task"]);
      const realTaskTurn = fakeFactory.requests
        .filter((request) => request.method === "turn/start")
        .find((request) => extractFakePrompt(request.params) === "real task");
      expect(realTaskTurn?.params?.threadId).toBe("thread-2");
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("defaults direct app-server use to the previous subscription-worker profile", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-profile-test-"));
    const fakeFactory = new FakeAppServerFactory();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "profile task" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      const threadStart = fakeFactory.requests.find(
        (request) => request.method === "thread/start",
      );
      expect(threadStart?.params).toMatchObject({
        baseInstructions: null,
        developerInstructions: expect.stringContaining(
          "non-interactive subscription runtime worker",
        ),
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not fail a task when clean-thread prewarm fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-clean-thread-test-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "codex-clean-thread-root-"));
    const fakeFactory = new FakeAppServerFactory({
      failThreadStartNumbers: [2],
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
      }),
      sessionMaterializer: new CodexWorkerCacheSessionPoolMaterializer({
        cacheKey: "provider-account:codex-clean-thread-test",
        slots: 1,
        rootDir: cacheRoot,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
      warmupPrompt: "warm slot",
    });

    try {
      const prewarm = await driver.prewarmSession({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        redactor: new DefaultRedactor(),
        workspacePath: workspace,
        runner: new StaticRunner(""),
        abortSignal: new AbortController().signal,
      });

      expect((prewarm.warnings ?? []).map((warning) => warning.code)).toContain(
        "codex_app_server_clean_thread_prewarm_failed",
      );

      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "real task" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "app-server output:real task",
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("falls back to packaged Codex exec when app-server fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-fallback-test-"));
    const fakeFactory = new FakeAppServerFactory({
      failThreadStart: true,
    });
    const fallback = new RecordingJsonEngine("fallback output");
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        fallback,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "fallback please" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "fallback output",
      });
      expect(result.warnings.map((warning) => warning.code)).toContain(
        "codex_app_server_fallback",
      );
      expect(fallback.prompts).toEqual(["fallback please"]);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not fall back to packaged Codex exec after abort", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-abort-test-"));
    const fakeFactory = new FakeAppServerFactory();
    const fallback = new RecordingJsonEngine("fallback output");
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        fallback,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });
    const controller = new AbortController();
    controller.abort();

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "must not fallback" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: controller.signal,
      });

      expect(result.status).toBe("failed");
      expect(fallback.prompts).toEqual([]);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("classifies top-level app-server error messages", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-error-test-"));
    const fakeFactory = new FakeAppServerFactory({
      emitTopLevelErrorOnTurn: "You've hit your usage limit.",
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "fail clearly" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "quota_limited",
          safeMessage: "Codex quota or billing limit was reached.",
        },
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("prewarms and reuses worker-cache CODEX_HOME across tasks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-worker-cache-test-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "codex-worker-cache-root-"));
    const engine = new RecordingJsonEngine();
    const materializer = new CodexWorkerCacheSessionMaterializer({
      cacheKey: "provider-account:codex-test:slot:0",
      rootDir: cacheRoot,
    });
    const driver = new CodexJsonAgentDriver({
      engine,
      sessionMaterializer: materializer,
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const prewarm = await driver.prewarmSession({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        redactor: new DefaultRedactor(),
      });
      expect(prewarm.reusable).toBe(true);

      const first = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "first" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });
      const second = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "second" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(first.status).toBe("completed");
      expect(second.status).toBe("completed");
      expect(engine.codexHomes).toHaveLength(2);
      expect(engine.codexHomes[0]).toBe(prewarm.codexHome);
      expect(engine.codexHomes[1]).toBe(prewarm.codexHome);

      await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(refreshedAuthJson),
        task: { kind: "review", prompt: "rotated" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(engine.codexHomes[2]).toBe(prewarm.codexHome);
      await expect(
        readFile(join(prewarm.codexHome, "auth.json"), "utf8"),
      ).resolves.toContain("refreshed-refresh-token");

      await driver.dispose();
      await expect(
        readFile(join(prewarm.codexHome, "auth.json"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("serializes concurrent worker-cache use for one warmed worker slot", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-worker-lock-test-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "codex-worker-lock-root-"));
    const engine = new SlowRecordingJsonEngine();
    const driver = new CodexJsonAgentDriver({
      engine,
      sessionMaterializer: new CodexWorkerCacheSessionMaterializer({
        cacheKey: "provider-account:codex-test:slot:1",
        rootDir: cacheRoot,
      }),
    });

    try {
      const run = (prompt: string) =>
        driver.runTask({
          session: sessionArtifactFromCodexAuthJson(validAuthJson),
          task: { kind: "review", prompt },
          workspace: { path: workspace },
          runner: new StaticRunner(""),
          redactor: new DefaultRedactor(),
          abortSignal: new AbortController().signal,
        });

      await Promise.all([run("one"), run("two")]);
      expect(engine.maxActive).toBe(1);
      expect(engine.codexHomes[0]).toBe(engine.codexHomes[1]);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });
});

providerSessionDriverContract("codex", () => ({
  driver: new CodexCliSessionDriver({ codexBinaryPath: "/bin/codex-test" }),
  goodSession: sessionArtifactFromCodexAuthJson(validAuthJson),
  redactor: new DefaultRedactor(),
  reconnectError: new Error("invalid_grant refresh_token=raw"),
}));

agentDriverContract("codex", () => ({
  driver: new CodexCliAgentDriver({ codexBinaryPath: "/bin/codex-test" }),
  goodSession: sessionArtifactFromCodexAuthJson(validAuthJson),
  redactor: new DefaultRedactor(),
}));

agentDriverContract("codex-json", () => ({
  driver: new CodexJsonAgentDriver({
    engine: {
      kind: "packaged-json",
      capabilities: {
        supportsStructuredOutput: true,
        supportsJsonEvents: true,
        supportsThreadResume: false,
        requiresSchemaFile: false,
      },
      async run() {
        return {
          outputText: "json contract output",
          warnings: [],
        };
      },
    },
  }),
  goodSession: sessionArtifactFromCodexAuthJson(validAuthJson),
  redactor: new DefaultRedactor(),
}));

const runnerCapabilities: RunnerCapabilities = {
  runnerId: "codex-test-runner",
  supportsEnvAllowlist: true,
  supportsWorkingDirectory: true,
  supportsTimeout: true,
  supportsAbortSignal: true,
  supportsOutputRedaction: true,
  supportsReadOnlySandbox: true,
  readOnlyFilesystem: false,
  platform: "node-process",
};

class RefreshingRunner implements RunnerPort {
  readonly runnerId = "codex-test-runner";
  readonly capabilities = runnerCapabilities;
  lastEnv: Readonly<Record<string, string>> | null = null;

  constructor(private readonly nextAuthJson: string) {}

  async run(input: {
    readonly env: Readonly<Record<string, string>>;
    readonly args: readonly string[];
  }): Promise<ProcessResult> {
    this.lastEnv = input.env;
    const codexHome = input.env.CODEX_HOME;
    if (!codexHome) throw new Error("missing_codex_home");
    expect(input.args).toContain("exec");
    await readFile(join(codexHome, "auth.json"), "utf8");
    await writeFile(join(codexHome, "auth.json"), this.nextAuthJson);
    return {
      exitCode: 0,
      stdout: "OK",
      stderr: "",
      durationMs: 1,
    };
  }
}

class StaticRunner implements RunnerPort {
  readonly runnerId = "codex-test-runner";
  readonly capabilities = runnerCapabilities;
  lastArgs: readonly string[] = [];
  lastEnv: Readonly<Record<string, string>> | null = null;
  lastStdin: string | null = null;

  constructor(private readonly stdout: string) {}

  async run(input: {
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly stdin?: Uint8Array;
  }): Promise<ProcessResult> {
    this.lastArgs = input.args;
    this.lastEnv = input.env;
    this.lastStdin = input.stdin ? new TextDecoder().decode(input.stdin) : null;
    return {
      exitCode: 0,
      stdout: this.stdout,
      stderr: "",
      durationMs: 1,
    };
  }
}

class RecordingJsonEngine implements CodexExecutionEngine {
  readonly kind = "packaged-json" as const;
  readonly capabilities = {
    supportsStructuredOutput: true,
    supportsJsonEvents: true,
    supportsThreadResume: false,
    requiresSchemaFile: false,
  } as const;
  readonly codexHomes: string[] = [];
  readonly prompts: string[] = [];

  constructor(private readonly fixedOutputText?: string) {}

  async run(input: Parameters<CodexExecutionEngine["run"]>[0]) {
    this.codexHomes.push(input.session.codexHome);
    this.prompts.push(input.prompt);
    return {
      outputText: this.fixedOutputText ?? `json output:${input.prompt}`,
      warnings: [],
    };
  }
}

class SlowRecordingJsonEngine extends RecordingJsonEngine {
  active = 0;
  maxActive = 0;

  override async run(input: Parameters<CodexExecutionEngine["run"]>[0]) {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return await super.run(input);
    } finally {
      this.active -= 1;
    }
  }
}

type FakeAppServerFactoryOptions = {
  readonly failThreadStart?: boolean;
  readonly failThreadStartNumbers?: readonly number[];
  readonly emitTopLevelErrorOnTurn?: string;
  readonly onPrompt?: (prompt: string) => void;
  readonly onRequest?: (request: FakeAppServerRequest) => void;
};

type FakeAppServerRequest = {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

class FakeAppServerFactory {
  spawnCount = 0;
  readonly codexHomes: string[] = [];
  readonly cwds: string[] = [];
  readonly prompts: string[] = [];
  readonly requests: FakeAppServerRequest[] = [];

  constructor(private readonly options: FakeAppServerFactoryOptions = {}) {}

  readonly create = (input: {
    readonly env: Readonly<Record<string, string>>;
    readonly cwd: string;
  }) => {
    this.spawnCount += 1;
    this.codexHomes.push(input.env.CODEX_HOME ?? "");
    this.cwds.push(input.cwd);
    return new FakeAppServerProcess({
      ...this.options,
      onPrompt: (prompt) => this.prompts.push(prompt),
      onRequest: (request) => this.requests.push(request),
    });
  };
}

class FakeAppServerProcess extends EventEmitter {
  readonly pid = undefined;
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly stdin = {
    write: (chunk: string | Uint8Array) => {
      this.handleRequest(String(chunk));
      return true;
    },
    end: () => undefined,
  };
  private nextThreadId = 1;
  private nextTurnId = 1;
  private threadStartCount = 0;

  constructor(private readonly options: FakeAppServerFactoryOptions) {
    super();
  }

  kill(): boolean {
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }

  private handleRequest(chunk: string): void {
    for (const line of chunk.split(/\n/)) {
      if (!line.trim()) continue;
      const request = JSON.parse(line) as FakeAppServerRequest;
      this.options.onRequest?.(request);
      if (request.method === "initialize") {
        this.respond(request.id, {
          userAgent: "fake-codex",
          codexHome: "/tmp/fake-codex-home",
        });
        continue;
      }
      if (request.method === "thread/start") {
        this.threadStartCount += 1;
        if (
          this.options.failThreadStart ||
          this.options.failThreadStartNumbers?.includes(this.threadStartCount)
        ) {
          this.respondError(request.id, "fake thread start failure");
          continue;
        }
        const threadId = `thread-${this.nextThreadId}`;
        this.nextThreadId += 1;
        this.respond(request.id, {
          thread: { id: threadId },
        });
        continue;
      }
      if (request.method === "turn/start") {
        const turnId = `turn-${this.nextTurnId}`;
        this.nextTurnId += 1;
        const prompt = extractFakePrompt(request.params);
        this.options.onPrompt?.(prompt);
        this.respond(request.id, {
          turn: { id: turnId },
        });
        setTimeout(() => {
          if (this.options.emitTopLevelErrorOnTurn) {
            this.stdout.emit(
              "data",
              `${JSON.stringify({
                method: "error",
                message: this.options.emitTopLevelErrorOnTurn,
              })}\n`,
            );
            return;
          }
          this.notify("item/agentMessage/delta", {
            turnId,
            delta: `app-server output:${prompt}`,
          });
          this.notify("turn/completed", {
            turn: { id: turnId, status: { type: "completed" } },
          });
        }, 5);
        continue;
      }
      this.respondError(request.id, `unsupported:${request.method}`);
    }
  }

  private respond(id: number, result: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify({ id, result })}\n`);
  }

  private respondError(id: number, message: string): void {
    this.stdout.emit("data", `${JSON.stringify({ id, error: { message } })}\n`);
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify({ method, params })}\n`);
  }
}

class FakeReadable extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

function extractFakePrompt(
  params: Record<string, unknown> | undefined,
): string {
  const input = params?.input;
  if (!Array.isArray(input)) return "";
  const first = input[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : "";
}
