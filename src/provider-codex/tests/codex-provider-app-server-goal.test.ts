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
import { CodexAppServerTurnError } from "../app-server/application/app-server-client";
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
  it("preserves the turn cause and typed diagnostics through timeout classification", () => {
    const cause = new Error("node_process_runner_timeout:50000");
    const error = new CodexAppServerTurnError({
      cause,
      phase: "turn_start_rejected",
      turnNumber: 2,
      elapsedMs: 50_000,
    });

    expect(error.cause).toBe(cause);
    expect(classifyCodexFailure(error)).toMatchObject({
      code: "task_timeout",
      retryable: true,
      details: {
        phase: "turn_start_rejected",
        turnNumber: "2",
        outputObserved: "false",
        outputCharCount: "0",
        elapsedMs: "50000",
      },
    });
  });

  it("runs first-class Codex goal mode through the app-server protocol", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-goal-test-"));
    const fakeFactory = new FakeAppServerFactory();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        goalMode: true,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: "finish the benchmark goal with full instructions",
          metadata: {
            codexGoalObjective: "short benchmark goal",
          },
          controls: { editMode: "allow-edits" },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText:
          "app-server output:finish the benchmark goal with full instructions",
      });
      expect(fakeFactory.requests.map((request) => request.method)).toEqual(
        expect.arrayContaining([
          "thread/start",
          "thread/goal/set",
          "turn/start",
          "thread/goal/get",
        ]),
      );
      expect(
        fakeFactory.requests.find(
          (request) => request.method === "thread/goal/set",
        )?.params,
      ).toMatchObject({
        objective: "short benchmark goal",
        status: "active",
      });
      expect(
        fakeFactory.requests.find(
          (request) => request.method === "thread/start",
        )?.params,
      ).toMatchObject({
        ephemeral: false,
        config: {
          features: {
            goals: true,
          },
        },
      });
      const threadStart = fakeFactory.requests.find(
        (request) => request.method === "thread/start",
      );
      expect(threadStart?.params).not.toHaveProperty("environments");
      expect(threadStart?.params).not.toHaveProperty("dynamicTools");
      expect(threadStart?.params).not.toHaveProperty("experimentalRawEvents");
      const turnStart = fakeFactory.requests.find(
        (request) => request.method === "turn/start",
      );
      expect(turnStart?.params).not.toHaveProperty("environments");
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("can disable native app-server environments in goal mode without clearing dynamic tools", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-goal-native-tools-test-"),
    );
    const fakeFactory = new FakeAppServerFactory();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        goalMode: true,
        nativeToolSurface: "disabled",
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: "coordinate broker tools only",
          metadata: {
            codexGoalObjective: "broker-only controller goal",
          },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      const threadStart = fakeFactory.requests.find(
        (request) => request.method === "thread/start",
      );
      expect(threadStart?.params).toMatchObject({
        environments: [],
      });
      expect(threadStart?.params).not.toHaveProperty("dynamicTools");
      const turnStart = fakeFactory.requests.find(
        (request) => request.method === "turn/start",
      );
      expect(turnStart?.params).toMatchObject({
        environments: [],
      });
      expect(turnStart?.params).not.toHaveProperty("dynamicTools");
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reports overlong app-server goal objectives before goal set", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-goal-objective-test-"),
    );
    const fakeFactory = new FakeAppServerFactory();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        goalMode: true,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: "full task lives in promptPath",
          metadata: {
            codexGoalObjective: "x".repeat(4001),
          },
          controls: { editMode: "allow-edits" },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "unknown_runtime_failure",
          details: {
            rawCause:
              "codex_app_server_goal_set_failed:Prompt too long: 4001/4000 chars. Use compact prompt with docs links.",
          },
        },
      });
      expect(
        fakeFactory.requests.map((request) => request.method),
      ).not.toContain("thread/goal/set");
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("continues an active Codex app-server goal until the goal is complete", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-goal-loop-test-"),
    );
    const fakeFactory = new FakeAppServerFactory({
      goalStatusesAfterTurns: ["active", "complete"],
      mismatchTurnStartResponseId: true,
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        goalMode: true,
        maxGoalTurns: 2,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: "keep going until done",
          controls: { editMode: "allow-edits" },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: expect.stringContaining("Continue working toward"),
      });
      expect(fakeFactory.prompts).toEqual([
        "keep going until done",
        expect.stringContaining("Continue working toward"),
      ]);
      expect(
        fakeFactory.requests.filter(
          (request) => request.method === "thread/goal/get",
        ),
      ).toHaveLength(2);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reports a synchronous turn/start rejection with bounded turn diagnostics", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-goal-turn-rejected-test-"),
    );
    const fakeFactory = new FakeAppServerFactory({
      onRequest: (request) => {
        if (request.method !== "turn/start") return;
        fakeFactory.processes[0]?.stdout.emit(
          "data",
          `${JSON.stringify({
            id: request.id,
            error: { message: "fake turn start rejection" },
          })}\n`,
        );
      },
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        goalMode: true,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: "observe start rejection",
          controls: { editMode: "allow-edits" },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          details: {
            phase: "turn_start_rejected",
            turnNumber: "1",
            outputObserved: "false",
            outputCharCount: "0",
            elapsedMs: expect.any(String),
            rawCause: expect.stringContaining(
              '"phase":"turn_start_rejected","turnNumber":1,"outputObserved":false,"outputCharCount":0,"elapsedMs":',
            ),
          },
        },
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reports an accepted turn error before output without content metadata", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-goal-turn-before-output-test-"),
    );
    const fakeFactory = new FakeAppServerFactory({
      emitTopLevelErrorOnTurn: "fake accepted turn failure",
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        goalMode: true,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: "observe failure before output",
          controls: { editMode: "allow-edits" },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          details: {
            phase: "turn_error_before_output",
            turnNumber: "1",
            outputObserved: "false",
            outputCharCount: "0",
            elapsedMs: expect.any(String),
            rawCause: expect.stringContaining(
              '"phase":"turn_error_before_output","turnNumber":1,"outputObserved":false,"outputCharCount":0,"elapsedMs":',
            ),
          },
        },
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reports an accepted turn error after output by count without raw output", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-goal-turn-after-output-test-"),
    );
    const partialOutput = "private partial provider output";
    const fakeFactory = new FakeAppServerFactory({
      onRequest: (request) => {
        if (request.method !== "turn/start") return;
        setTimeout(() => {
          const process = fakeFactory.processes[0];
          process?.stdout.emit(
            "data",
            [
              JSON.stringify({
                method: "item/agentMessage/delta",
                params: { turnId: "turn-1", delta: partialOutput },
              }),
              JSON.stringify({
                method: "error",
                params: {
                  turnId: "turn-1",
                  error: "fake failure after output",
                },
              }),
            ].join("\n") + "\n",
          );
        }, 0);
      },
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        goalMode: true,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: "observe failure after output",
          controls: { editMode: "allow-edits" },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          details: {
            phase: "turn_error_after_output",
            turnNumber: "1",
            outputObserved: "true",
            outputCharCount: String(partialOutput.length),
            elapsedMs: expect.any(String),
            rawCause: expect.stringContaining(
              `"phase":"turn_error_after_output","turnNumber":1,"outputObserved":true,"outputCharCount":${partialOutput.length},"elapsedMs":`,
            ),
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain(partialOutput);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reports the exact goal turn number when a later turn fails", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-goal-second-turn-error-test-"),
    );
    const fakeFactory = new FakeAppServerFactory({
      goalStatusesAfterTurns: ["active"],
      emitTopLevelErrorsOnTurns: [null, "fake second turn failure"],
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        goalMode: true,
        maxGoalTurns: 2,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: "continue into a failing second turn",
          controls: { editMode: "allow-edits" },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          details: {
            phase: "turn_error_before_output",
            turnNumber: "2",
            outputObserved: "false",
            outputCharCount: "0",
            elapsedMs: expect.any(String),
            rawCause: expect.stringContaining(
              '"phase":"turn_error_before_output","turnNumber":2,"outputObserved":false,"outputCharCount":0,"elapsedMs":',
            ),
          },
        },
      });
      expect(fakeFactory.prompts).toHaveLength(2);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns a retryable slice failure when app-server goal max turns are exhausted", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-goal-max-turns-test-"),
    );
    const fakeFactory = new FakeAppServerFactory({
      goalStatusesAfterTurns: ["active"],
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        goalMode: true,
        maxGoalTurns: 1,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: "keep going beyond one slice",
          controls: { editMode: "allow-edits" },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "goal_slice_exhausted",
          retryable: true,
          reconnectRequired: false,
          details: {
            lastOutputTail: "app-server output:keep going beyond one slice",
          },
        },
        telemetry: {
          finishReason: "max_turns",
        },
      });
      expect(fakeFactory.prompts).toEqual(["keep going beyond one slice"]);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns waiting_for_input for a blocked app-server goal and resumes it", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-goal-waiting-test-"),
    );
    const fakeFactory = new FakeAppServerFactory({
      goalStatusesAfterTurns: ["blocked", "complete"],
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        goalMode: true,
        maxGoalTurns: 2,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const waiting = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: "finish after missing context",
          controls: { editMode: "allow-edits" },
          metadata: { codexManagedRunId: "managed-goal-1" },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(waiting).toMatchObject({
        status: "waiting_for_input",
        runId: "managed-goal-1",
        request: {
          kind: "missing_context",
          audience: "orchestrator",
        },
        resumeHandle: {
          threadId: "thread-1",
          workspacePath: workspace,
        },
      });
      if (waiting.status !== "waiting_for_input") {
        throw new Error("expected waiting result");
      }

      const resumed = await driver.resumeManagedRun({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        runId: waiting.runId,
        requestId: waiting.request.id,
        answer: "Use project alpha.",
        resumeHandle: waiting.resumeHandle,
        task: { controls: { editMode: "allow-edits" } },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(resumed).toMatchObject({
        status: "completed",
        outputText: expect.stringContaining("Use project alpha."),
      });
      expect(fakeFactory.prompts).toEqual([
        "finish after missing context",
        expect.stringContaining("Use project alpha."),
      ]);
      expect(
        fakeFactory.requests.filter(
          (request) => request.method === "thread/start",
        ),
      ).toHaveLength(1);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("marks a managed run failed when resume continuation fails", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-goal-resume-failed-test-"),
    );
    const runStore = new RecordingManagedRunStore();
    const fakeFactory = new FakeAppServerFactory({
      goalStatusesAfterTurns: ["blocked"],
      emitTopLevelErrorsOnTurns: [null, "resume exploded"],
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        goalMode: true,
        maxGoalTurns: 2,
        runStore,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const waiting = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: "finish after resume failure",
          controls: { editMode: "allow-edits" },
          metadata: { codexManagedRunId: "managed-goal-failed-1" },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });
      if (waiting.status !== "waiting_for_input") {
        throw new Error("expected waiting result");
      }

      const failed = await driver.resumeManagedRun({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        runId: waiting.runId,
        requestId: waiting.request.id,
        answer: "Use project beta.",
        resumeHandle: waiting.resumeHandle,
        task: { controls: { editMode: "allow-edits" } },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(failed).toMatchObject({
        status: "failed",
        failure: {
          code: "unknown_runtime_failure",
          details: {
            phase: "turn_error_before_output",
            turnNumber: "1",
            outputObserved: "false",
            outputCharCount: "0",
            elapsedMs: expect.any(String),
          },
        },
      });
      await expect(
        runStore.get({ runId: waiting.runId }),
      ).resolves.toMatchObject({
        status: "failed",
        failure: {
          code: "unknown_runtime_failure",
          details: {
            phase: "turn_error_before_output",
            turnNumber: "1",
            outputObserved: "false",
            outputCharCount: "0",
            elapsedMs: expect.any(String),
          },
        },
      });

      const retry = await driver.resumeManagedRun({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        runId: waiting.runId,
        requestId: waiting.request.id,
        answer: "Use project beta.",
        resumeHandle: waiting.resumeHandle,
        task: { controls: { editMode: "allow-edits" } },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(retry).toMatchObject({
        status: "failed",
        failure: { code: "unknown_runtime_failure" },
      });
      expect(fakeFactory.prompts).toEqual([
        "finish after resume failure",
        expect.stringContaining("Use project beta."),
      ]);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails fast when an app-server goal continuation is replaced", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-goal-replaced-test-"),
    );
    const fakeFactory = new FakeAppServerFactory({
      goalStatusesAfterTurns: ["active"],
      abortTurnNumbers: [2],
      abortTurnReason: "replaced",
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        goalMode: true,
        maxGoalTurns: 3,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: "work until interrupted",
          controls: { editMode: "allow-edits" },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "unknown_runtime_failure",
          retryable: true,
          safeMessage: "Codex runtime failed.",
        },
      });
      expect(fakeFactory.prompts).toEqual([
        "work until interrupted",
        expect.stringContaining("Continue working toward"),
      ]);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("classifies app-server goal usage limits before empty output", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-goal-usage-limit-test-"),
    );
    const fakeFactory = new FakeAppServerFactory({
      goalStatusesAfterTurns: ["usageLimited"],
      suppressOutputTurnNumbers: [1],
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        goalMode: true,
        maxGoalTurns: 1,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: "hit the account limit",
          controls: { editMode: "allow-edits" },
        },
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
});
