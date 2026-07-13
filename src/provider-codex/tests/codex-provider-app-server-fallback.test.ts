import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DefaultRedactor,
  providerTaskSystemPromptMaxBytes,
} from "@vioxen/subscription-runtime/core";
import {
  agentDriverContract,
  providerSessionDriverContract,
} from "../../core/testing/contracts";
import type {
  ManagedRunInputRequest,
  ManagedRunRecord,
  ManagedRunResumeHandle,
  ManagedRunStorePort,
  ProcessResult,
  ProviderFailure,
  RunnerPort,
  RunnerCapabilities,
} from "@vioxen/subscription-runtime/core";
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
  classifyCodexFailure,
  codexAgentCapabilities,
  codexEnvironmentPolicy,
  codexJsonAgentCapabilities,
  codexProviderManifest,
  codexSessionCapabilities,
  defaultCodexModel,
  sessionArtifactFromCodexAuthJson,
  validateCodexSessionArtifact,
} from "../index";
import type { CodexExecutionEngine } from "../codex-json-execution-engine";
import type { CodexSessionMaterializer } from "../codex-session-materializer";
import {
  classifyCodexRuntimeFailure,
  pruneCodexChildEnv,
} from "../codex-cli-domain";
import { isTransientCodexTempCleanupError } from "../codex-cli-temp-cleanup";
import {
  extractFakePrompt,
  FakeAppServerFactory,
} from "../app-server/testing/fake-app-server";
import {
  RecordingJsonEngine,
  RecordingManagedRunStore,
  RefreshingRunner,
  SlowRecordingJsonEngine,
  StaticRunner,
  expectFencedCodexPrompt,
  refreshedAuthJson,
  validAuthJson,
} from "./codex-provider-test-support";

describe("Codex provider app-server adapter", () => {
  it("reports the account model catalog and skips fallback for unavailable models", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-model-catalog-test-"));
    const fakeFactory = new FakeAppServerFactory({
      failThreadStart: true,
      threadStartError:
        "The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account",
      availableModels: [
        {
          model: "gpt-5.6-sol",
          supportedReasoningEfforts: ["high", "xhigh"],
          isDefault: true,
        },
        {
          model: "gpt-5.5",
          supportedReasoningEfforts: ["medium", "high", "xhigh"],
        },
      ],
    });
    const fallback = new RecordingJsonEngine("fallback must not run");
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        fallback,
      }),
      model: "gpt-5.6",
      reasoningEffort: "xhigh",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "inspect model availability" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "model_unavailable",
          retryable: true,
          safeMessage:
            'Codex model "gpt-5.6" is unavailable for this account. Available models: gpt-5.6-sol, gpt-5.5.',
          details: {
            requestedModel: "gpt-5.6",
            availableModels: "gpt-5.6-sol,gpt-5.5",
            availableModelProfiles:
              "gpt-5.6-sol[high|xhigh],gpt-5.5[medium|high|xhigh]",
          },
        },
      });
      expect(fallback.prompts).toEqual([]);
      expect(fakeFactory.requests.map((request) => request.method)).toContain(
        "model/list",
      );
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
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

  it("falls back when app-server errors after turn start responds", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-turn-error-fallback-test-"));
    const fakeFactory = new FakeAppServerFactory({
      emitProcessErrorAfterTurnStartResponse: true,
    });
    const fallback = new RecordingJsonEngine("fallback output");
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        fallback,
        timeoutMs: 1_000,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "fallback after turn start" },
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
      expect(fallback.prompts).toEqual(["fallback after turn start"]);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("falls back when writing an app-server request fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-write-failure-test-"));
    const fakeFactory = new FakeAppServerFactory({
      throwOnRequestMethod: "turn/start",
    });
    const fallback = new RecordingJsonEngine("fallback output");
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        fallback,
        timeoutMs: 1_000,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "fallback after write failure" },
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
      expect(fallback.prompts).toEqual(["fallback after write failure"]);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("falls back when responding to an unsupported app-server request fails", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-server-response-failure-test-"),
    );
    const fakeFactory = new FakeAppServerFactory({
      emitUnsupportedServerRequestOnTurn: true,
      throwOnUnsupportedServerResponse: true,
    });
    const fallback = new RecordingJsonEngine("fallback output");
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        fallback,
        timeoutMs: 1_000,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "fallback after response failure" },
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
      expect(fallback.prompts).toEqual(["fallback after response failure"]);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("falls back when the app-server stdin stream errors", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-stdin-stream-error-test-"),
    );
    const fakeFactory = new FakeAppServerFactory({
      emitStdinErrorAfterTurnStartResponse: true,
    });
    const fallback = new RecordingJsonEngine("fallback output");
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        fallback,
        timeoutMs: 1_000,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "fallback after stdin error" },
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
      expect(fallback.prompts).toEqual(["fallback after stdin error"]);
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

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "task_cancelled",
        },
        telemetry: {
          finishReason: "cancelled",
        },
      });
      expect(fallback.prompts).toEqual([]);
      expect(fakeFactory.spawnCount).toBe(0);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("cancels a pending app-server initialize and stops the child", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-init-abort-test-"));
    const controller = new AbortController();
    const fakeFactory = new FakeAppServerFactory({
      suppressInitializeResponse: true,
      onRequest: (request) => {
        if (request.method === "initialize") controller.abort();
      },
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        timeoutMs: 250,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "cancel initialize" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: controller.signal,
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
      expect(fakeFactory.spawnCount).toBe(1);
      expect(fakeFactory.processes[0]?.isExited()).toBe(true);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses a bounded app-server startup timeout separate from task timeout", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-init-timeout-test-"));
    const fakeFactory = new FakeAppServerFactory({
      suppressInitializeResponse: true,
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        timeoutMs: 60_000,
        startupTimeoutMs: 25,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "timeout initialize" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "task_timeout",
          safeMessage: "Codex task timed out.",
        },
      });
      expect(fakeFactory.spawnCount).toBe(1);
      expect(fakeFactory.processes[0]?.isExited()).toBe(true);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("classifies app-server initialize usage limits as quota limited", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-init-quota-test-"));
    const fakeFactory = new FakeAppServerFactory({
      initializeError: "You've hit your usage limit.",
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        startupTimeoutMs: 250,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "quota initialize" },
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

  it("waits through transient app-server reconnect progress errors", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-reconnect-test-"),
    );
    const fakeFactory = new FakeAppServerFactory({
      emitTransientTopLevelErrorOnTurn: "Reconnecting... 2/5",
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        reconnectGraceMs: 50,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "survive reconnect" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "app-server output:survive reconnect",
      });
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

  it("fails active app-server turns immediately when the child process errors", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-process-error-test-"));
    const fakeFactory = new FakeAppServerFactory({
      emitProcessErrorOnTurn: true,
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        timeoutMs: 250,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "process fails mid-turn" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "unknown_runtime_failure",
        },
        telemetry: {
          finishReason: "provider_error",
        },
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails app-server turns when the process errors after turn start responds", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-early-process-error-test-"));
    const fakeFactory = new FakeAppServerFactory({
      emitProcessErrorAfterTurnStartResponse: true,
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        timeoutMs: 1_000,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "process fails before turn event" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "unknown_runtime_failure",
        },
        telemetry: {
          finishReason: "provider_error",
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
      ).resolves.toContain(["refreshed", "refresh", "token"].join("-"));

      await driver.dispose();
      await expect(
        readFile(join(prewarm.codexHome, "auth.json"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("captures Codex auth changes written during task execution", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-task-update-test-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "codex-task-update-root-"));
    const engine = new (class extends RecordingJsonEngine {
      override async run(input: Parameters<CodexExecutionEngine["run"]>[0]) {
        await writeFile(join(input.session.codexHome, "auth.json"), refreshedAuthJson);
        return super.run(input);
      }
    })();
    const driver = new CodexJsonAgentDriver({
      engine,
      sessionMaterializer: new CodexWorkerCacheSessionMaterializer({
        cacheKey: "provider-account:codex-test:slot:snapshot",
        rootDir: cacheRoot,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "capture auth update" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result.status).toBe("completed");
      if (result.status === "completed") {
        expect(result.sessionUpdate).toBeTruthy();
        expect(new TextDecoder().decode(result.sessionUpdate!.bytes)).toContain(
          ["refreshed", "refresh", "token"].join("-"),
        );
      }
    } finally {
      await driver.dispose();
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
