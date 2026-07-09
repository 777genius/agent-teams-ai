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

describe("Codex provider adapter", () => {
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

  it("builds packaged JSON exec args with explicit workspace-write sandbox", () => {
    expect(
      buildCodexJsonExecArgs({
        jsonFlag: "--json",
        model: "gpt-test",
        reasoningEffort: "low",
        sandboxMode: "workspace-write",
      }),
    ).toEqual(
      expect.arrayContaining(["--sandbox", "workspace-write"]),
    );
  });

  it("builds packaged JSON exec args with a native output schema path", () => {
    expect(
      buildCodexJsonExecArgs({
        jsonFlag: "--json",
        model: "gpt-test",
        reasoningEffort: "low",
        outputSchemaPath: "/tmp/schema.json",
      }),
    ).toEqual(expect.arrayContaining(["--output-schema", "/tmp/schema.json"]));
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
        telemetry: {
          finishReason: "completed",
        },
      });
      expect(result.telemetry?.durationMs).toEqual(expect.any(Number));
      expect(runner.lastArgs).toContain("--json");
      expect(runner.lastArgs).toContain("-");
      expect(runner.lastStdin).toBe("inspect diff");
      expect(runner.lastEnv?.CODEX_HOME).toBeTruthy();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("passes registered output schemas to packaged Codex exec", async () => {
    let schemaPath: string | undefined;
    const runner = new StaticRunner(
      `${JSON.stringify({
        type: "agent_message",
        message: JSON.stringify({ verdict: "ok" }),
      })}\n`,
      async (input) => {
        const schemaFlagIndex = input.args.indexOf("--output-schema");
        expect(schemaFlagIndex).toBeGreaterThan(-1);
        schemaPath = input.args[schemaFlagIndex + 1];
        expect(schemaPath).toEqual(expect.any(String));
        expect(JSON.parse(await readFile(schemaPath!, "utf8"))).toEqual({
          type: "object",
          properties: { verdict: { type: "string" } },
          required: ["verdict"],
          additionalProperties: false,
        });
      },
    );
    const workspace = await mkdtemp(join(tmpdir(), "codex-json-agent-test-"));
    const driver = new CodexJsonAgentDriver({
      engine: new PackagedCodexJsonExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
      }),
      model: "gpt-test",
      reasoningEffort: "low",
      outputSchemas: {
        "review-verdict": {
          type: "object",
          properties: { verdict: { type: "string" } },
          required: ["verdict"],
          additionalProperties: false,
        },
      },
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "review",
          prompt: "inspect diff",
          outputSchemaName: "review-verdict",
        },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        structuredOutput: { verdict: "ok" },
      });
      expect(schemaPath).toBeTruthy();
      await expect(readFile(schemaPath!, "utf8")).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("passes task system prompts through Codex JSON task engines", async () => {
    const engine = new RecordingJsonEngine();
    const workspace = await mkdtemp(join(tmpdir(), "codex-json-system-test-"));
    const driver = new CodexJsonAgentDriver({
      engine,
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "review",
          prompt: "inspect diff",
          systemPrompt: "return only the verdict",
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(engine.prompts).toEqual(["inspect diff"]);
      expect(engine.systemPrompts).toEqual(["return only the verdict"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects direct Codex JSON system prompts before calling the engine", async () => {
    const engine = new RecordingJsonEngine();
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-json-system-invalid-test-"),
    );
    const driver = new CodexJsonAgentDriver({
      engine,
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      await expect(
        driver.runTask({
          session: sessionArtifactFromCodexAuthJson(validAuthJson),
          task: {
            kind: "review",
            prompt: "inspect diff",
            systemPrompt: "x".repeat(providerTaskSystemPromptMaxBytes + 1),
          },
          workspace: { path: workspace },
          runner: new StaticRunner(""),
          redactor: new DefaultRedactor(),
          abortSignal: new AbortController().signal,
        }),
      ).rejects.toThrow(
        `task.systemPrompt exceeds ${providerTaskSystemPromptMaxBytes} bytes`,
      );
      expect(engine.prompts).toEqual([]);
      expect(engine.systemPrompts).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps task system prompts separate in packaged Codex JSON stdin", async () => {
    const runner = new StaticRunner(
      `${JSON.stringify({ type: "agent_message", message: "json review output" })}\n`,
    );
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-json-stdin-system-test-"),
    );
    const driver = new CodexJsonAgentDriver({
      engine: new PackagedCodexJsonExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "review",
          prompt: "inspect diff",
          systemPrompt: "return only the verdict",
        },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expectFencedCodexPrompt(
        runner.lastStdin,
        "return only the verdict",
        "inspect diff",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses task controls for provider-neutral model and schema selection", async () => {
    const runner = new StaticRunner(
      `${JSON.stringify({
        type: "agent_message",
        message: JSON.stringify({ verdict: "APPROVE" }),
      })}\n`,
    );
    const workspace = await mkdtemp(join(tmpdir(), "codex-controls-test-"));
    const driver = new CodexJsonAgentDriver({
      engine: new PackagedCodexJsonExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
      }),
      model: "default-model",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: "inspect diff",
          controls: {
            model: "task-model",
            outputSchemaName: "review-verdict",
            editMode: "allow-edits",
          },
        },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        structuredOutput: { verdict: "APPROVE" },
      });
      expect(runner.lastArgs).toContain("task-model");
      expect(runner.lastArgs).toEqual(
        expect.arrayContaining(["--sandbox", "workspace-write"]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts fenced structured output from Codex JSON execution", async () => {
    const runner = new StaticRunner(
      `${JSON.stringify({
        type: "agent_message",
        message: [
          "Review result:",
          "```json",
          JSON.stringify({ verdict: "APPROVE" }),
          "```",
        ].join("\n"),
      })}\n`,
    );
    const workspace = await mkdtemp(join(tmpdir(), "codex-controls-test-"));
    const driver = new CodexJsonAgentDriver({
      engine: new PackagedCodexJsonExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
      }),
      model: "default-model",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: "inspect diff",
          controls: {
            outputSchemaName: "review-verdict",
          },
        },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        structuredOutput: { verdict: "APPROVE" },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reads nested content parts from Codex JSON execution events", async () => {
    const runner = new StaticRunner(
      `${JSON.stringify({
        type: "agent_message",
        message: {
          content: [
            {
              type: "output_text",
              text: "nested packaged json output",
            },
          ],
        },
      })}\n`,
    );
    const workspace = await mkdtemp(join(tmpdir(), "codex-json-content-test-"));
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
        task: { kind: "review", prompt: "inspect nested content" },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "nested packaged json output",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reads response output parts from Codex JSON execution events", async () => {
    const runner = new StaticRunner(
      `${JSON.stringify({
        type: "response.completed",
        response: {
          type: "response",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ verdict: "APPROVE" }),
                },
              ],
            },
            {
              type: "tool_output",
              content: JSON.stringify({ verdict: "REJECT" }),
            },
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ verdict: "REJECT" }),
                },
              ],
            },
          ],
        },
      })}\n`,
    );
    const workspace = await mkdtemp(join(tmpdir(), "codex-json-response-test-"));
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
        task: {
          kind: "structured-prompt",
          prompt: "inspect response output",
          controls: {
            outputSchemaName: "review-verdict",
          },
        },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        structuredOutput: { verdict: "APPROVE" },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not let later non-assistant Codex JSON events override final output", async () => {
    const runner = new StaticRunner(
      [
        JSON.stringify({
          type: "agent_message",
          message: JSON.stringify({ verdict: "APPROVE" }),
        }),
        JSON.stringify({
          type: "tool_output",
          content: JSON.stringify({ verdict: "REJECT" }),
        }),
        "",
      ].join("\n"),
    );
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-json-tool-output-test-"),
    );
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
        task: {
          kind: "structured-prompt",
          prompt: "inspect tool output ordering",
          controls: {
            outputSchemaName: "review-verdict",
          },
        },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        structuredOutput: { verdict: "APPROVE" },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not let later non-assistant message roles override final output", async () => {
    const runner = new StaticRunner(
      [
        JSON.stringify({
          type: "agent_message",
          message: JSON.stringify({ verdict: "APPROVE" }),
        }),
        JSON.stringify({
          type: "message",
          role: "user",
          content: JSON.stringify({ verdict: "REJECT" }),
        }),
        "",
      ].join("\n"),
    );
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-json-user-message-test-"),
    );
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
        task: {
          kind: "structured-prompt",
          prompt: "inspect role ordering",
          controls: {
            outputSchemaName: "review-verdict",
          },
        },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        structuredOutput: { verdict: "APPROVE" },
      });
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
          code: "provider_output_invalid",
        },
        telemetry: {
          finishReason: "provider_error",
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
});
