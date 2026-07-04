import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DefaultRedactor,
  type ProcessResult,
  type RunnerPort,
  type RunnerCapabilities,
} from "../../core/index.js";
import {
  OpenAiBridgeChatCompletionUseCase,
  OpenAiBridgeErrorCode,
  OpenAiBridgeObjectKind,
  OpenAiBridgeRequestError,
  OpenAiBridgeResponseFormatType,
  OpenAiBridgeRole,
  CodexOpenAiBridgeBackend,
  renderOpenAiBridgeChat,
  type OpenAiBridgeChatBackend,
} from "../index.js";
import { PackagedCodexJsonExecutionEngine } from "../../provider-codex/index.js";

describe("OpenAI-compatible Codex bridge", () => {
  it("renders json_object requests into a JSON-only system prompt", () => {
    const rendered = renderOpenAiBridgeChat({
      messages: [
        { role: OpenAiBridgeRole.System, content: "Extract memories." },
        { role: OpenAiBridgeRole.User, content: "Dana keeps the blue checklist." },
      ],
      response_format: { type: OpenAiBridgeResponseFormatType.JsonObject },
    });

    expect(rendered.systemPrompt).toContain("Extract memories.");
    expect(rendered.systemPrompt).toContain("Return one valid JSON object only");
    expect(rendered.prompt).toContain("<message role=\"user\">");
  });

  it("returns an OpenAI-compatible chat completion response", async () => {
    const backend: OpenAiBridgeChatBackend = {
      async complete(input) {
        expect(input.model).toBe("gpt-5.5");
        expect(input.systemPrompt).toContain("Return one valid JSON object only");
        return { text: "{\"memory\":[\"Dana keeps the blue checklist\"]}", model: input.model };
      },
    };
    const useCase = new OpenAiBridgeChatCompletionUseCase({
      backend,
      publicModel: "subscription-codex",
      codexModel: "gpt-5.5",
      clock: () => new Date("2026-07-02T20:00:00.000Z"),
    });

    const response = await useCase.complete({
      request: {
        model: "gpt-4o-mini",
        messages: [
          { role: "user", content: "Extract: Dana keeps the blue checklist." },
        ],
        response_format: { type: "json_object" },
      },
      abortSignal: new AbortController().signal,
    });

    expect(response.object).toBe(OpenAiBridgeObjectKind.ChatCompletion);
    expect(response.model).toBe("gpt-4o-mini");
    expect(response.choices[0]?.message.content).toBe(
      "{\"memory\":[\"Dana keeps the blue checklist\"]}",
    );
    expect(response.system_fingerprint).toBe(
      "subscription-runtime-codex-bridge-v1",
    );
  });

  it("rejects streaming and tools instead of silently burning provider calls", async () => {
    const useCase = new OpenAiBridgeChatCompletionUseCase({
      backend: {
        async complete() {
          throw new Error("should_not_run_backend");
        },
      },
      publicModel: "subscription-codex",
      codexModel: "gpt-5.5",
    });

    await expect(useCase.complete({
      request: {
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
      abortSignal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: OpenAiBridgeErrorCode.UnsupportedFeature,
    } satisfies Partial<OpenAiBridgeRequestError>);

    await expect(useCase.complete({
      request: {
        messages: [{ role: "user", content: "hello" }],
        tools: [{}],
      },
      abortSignal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: OpenAiBridgeErrorCode.UnsupportedFeature,
    } satisfies Partial<OpenAiBridgeRequestError>);
  });

  it("accepts current Codex item.completed JSON events", async () => {
    const engine = new PackagedCodexJsonExecutionEngine({
      codexBinaryPath: "/bin/codex-test",
    });
    const result = await engine.run({
      prompt: "Reply OK",
      session: {
        home: "/tmp/home",
        codexHome: "/tmp/codex-home",
        env: {},
        release: async () => {},
      },
      workspacePath: "/tmp",
      runner: new ItemCompletedRunner(),
      redactor: new DefaultRedactor(),
      model: "gpt-5.5",
      reasoningEffort: "low",
      abortSignal: new AbortController().signal,
    });

    expect(result.outputText).toBe("OK");
  });

  it("runs Codex bridge requests with isolated state CODEX_HOME copies", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-openai-bridge-"));
    const authRoot = join(root, "auth");
    const sourceCodexHome = join(authRoot, "account-a");
    const stateDir = join(root, "state");
    const capturePath = join(root, "captured-codex-home.txt");
    const codexBinaryPath = join(root, "fake-codex");
    const authJson = JSON.stringify({ tokens: { access_token: "test-token" } });

    try {
      await mkdir(sourceCodexHome, { recursive: true });
      await writeFile(join(sourceCodexHome, "auth.json"), authJson);
      await writeFile(
        codexBinaryPath,
        [
          "#!/bin/sh",
          "while IFS= read -r _; do :; done",
          `printf '%s\\n' "$CODEX_HOME" > ${JSON.stringify(capturePath)}`,
          "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"OK\"}}'",
        ].join("\n"),
      );
      await chmod(codexBinaryPath, 0o700);

      const backend = new CodexOpenAiBridgeBackend({
        codexBinaryPath,
        authRootDir: authRoot,
        stateDir,
        accountNames: ["account-a"],
        timeoutMs: 5_000,
        quotaCooldownMs: 1_000,
        maxAccountCycles: 1,
        maxConcurrentRequests: 1,
        reasoningEffort: "low",
      });

      const result = await backend.complete({
        prompt: "Reply OK",
        model: "gpt-5.5",
        requestId: "bridge-test",
        abortSignal: new AbortController().signal,
      });

      const capturedCodexHome = (await readFile(capturePath, "utf8")).trim();
      expect(result.text).toBe("OK");
      expect(capturedCodexHome).toBe(join(stateDir, "codex-home", "account-a"));
      expect(capturedCodexHome).not.toBe(sourceCodexHome);
      await expect(readFile(join(capturedCodexHome, "auth.json"), "utf8"))
        .resolves.toBe(authJson);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

class ItemCompletedRunner implements RunnerPort {
  readonly runnerId = "item-completed-runner";
  readonly capabilities: RunnerCapabilities = {
    runnerId: this.runnerId,
    supportsEnvAllowlist: true,
    supportsWorkingDirectory: true,
    supportsTimeout: true,
    supportsAbortSignal: true,
    supportsOutputRedaction: false,
    supportsReadOnlySandbox: false,
    readOnlyFilesystem: false,
    platform: "node-process",
  };

  async run(): Promise<ProcessResult> {
    return {
      exitCode: 0,
      stdout: [
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "OK" },
        }),
      ].join("\n"),
      stderr: "",
      durationMs: 1,
    };
  }
}
