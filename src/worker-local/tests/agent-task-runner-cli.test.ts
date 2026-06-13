import { describe, expect, it } from "vitest";
import {
  runSubscriptionAgentTaskCli,
  type RuntimeAgentTaskWorker,
  type RuntimeAgentTaskWorkerFactory,
  type RuntimeAgentTaskWorkerFactoryInput,
  type RuntimeAgentTaskWorkerJob,
  type SubscriptionAgentTaskCliIo,
} from "../agent-task-runner-cli";

describe("subscription runtime agent-task runner CLI", () => {
  it("runs a Claude AgentTaskRequest through the selected worker", async () => {
    const calls: {
      factory?: RuntimeAgentTaskWorkerFactoryInput;
      seed?: string;
      job?: RuntimeAgentTaskWorkerJob;
    } = {};
    const stdout: string[] = [];
    const exitCode = await runSubscriptionAgentTaskCli(
      [
        "--provider",
        "claude",
        "--format",
        "result-json",
        "--state-root",
        "/tmp/runtime-state",
        "--provider-instance",
        "claude-a",
        "--model",
        "sonnet",
      ],
      fakeIo({
        stdout,
        stdin: JSON.stringify({
          protocolVersion: 1,
          runId: "run-1",
          task: {
            kind: "structured-prompt",
            prompt: "classify this failure",
            controls: {
              model: "opus",
              maxTurns: 1,
              permissionMode: "preapproved",
            },
          },
        }),
        env: {
          PATH: "/usr/bin",
          SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY:
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
        },
      }),
      fakeFactory(calls),
    );

    expect(exitCode).toBe(0);
    expect(calls.factory).toMatchObject({
      provider: "claude",
      providerInstanceId: "claude-a",
      model: "sonnet",
    });
    expect(calls.factory?.env).toMatchObject({
      PATH: "/usr/bin",
    });
    expect(calls.factory?.env).not.toHaveProperty("SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY");
    expect(calls.factory?.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(calls.seed).toBe("claude-token");
    expect(calls.job).toMatchObject({
      runId: "run-1",
      prompt: "classify this failure",
      kind: "structured-prompt",
      controls: {
        model: "opus",
        maxTurns: 1,
        permissionMode: "preapproved",
      },
    });
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      protocolVersion: 1,
      status: "completed",
      outputText: "worker:classify this failure",
      structuredOutput: { ok: true },
      telemetry: { finishReason: "completed" },
    });
  });

  it("emits event-ndjson and supports ephemeral state without an encryption env", async () => {
    const stdout: string[] = [];
    const exitCode = await runSubscriptionAgentTaskCli(
      ["--provider", "codex", "--ephemeral"],
      fakeIo({
        stdout,
        stdin: JSON.stringify({
          protocolVersion: 1,
          task: {
            kind: "review",
            prompt: "review this",
          },
        }),
        env: {
          CODEX_AUTH_JSON_PATH: "/tmp/auth.json",
        },
      }),
      fakeFactory({}),
    );

    expect(exitCode).toBe(0);
    const events = stdout.join("").trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ protocolVersion: 1, type: "started" });
    expect(events[1]).toMatchObject({
      protocolVersion: 1,
      type: "completed",
      result: {
        status: "completed",
        outputText: "worker:review this",
      },
    });
  });

  it("uses request timeout unless the CLI timeout overrides it", async () => {
    const request = JSON.stringify({
      protocolVersion: 1,
      timeoutMs: 45_000,
      task: {
        kind: "structured-prompt",
        prompt: "hello",
      },
    });

    const requestCalls: {
      factory?: RuntimeAgentTaskWorkerFactoryInput;
    } = {};
    const requestExitCode = await runSubscriptionAgentTaskCli(
      ["--provider", "claude", "--state-root", "/tmp/runtime-state"],
      fakeIo({
        stdin: request,
        env: {
          SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY:
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      }),
      fakeFactory(requestCalls),
    );

    expect(requestExitCode).toBe(0);
    expect(requestCalls.factory?.timeoutMs).toBe(45_000);

    const overrideCalls: {
      factory?: RuntimeAgentTaskWorkerFactoryInput;
    } = {};
    const overrideExitCode = await runSubscriptionAgentTaskCli(
      [
        "--provider",
        "claude",
        "--state-root",
        "/tmp/runtime-state",
        "--timeout-ms",
        "120000",
      ],
      fakeIo({
        stdin: request,
        env: {
          SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY:
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      }),
      fakeFactory(overrideCalls),
    );

    expect(overrideExitCode).toBe(0);
    expect(overrideCalls.factory?.timeoutMs).toBe(120_000);
  });

  it("fails before constructing a durable worker when the encryption key env is missing", async () => {
    let factoryCalled = false;
    const stderr: string[] = [];
    const exitCode = await runSubscriptionAgentTaskCli(
      ["--provider", "claude", "--state-root", "/tmp/runtime-state"],
      fakeIo({
        stderr,
        stdin: JSON.stringify({
          protocolVersion: 1,
          task: {
            kind: "structured-prompt",
            prompt: "hello",
          },
        }),
        env: {},
      }),
      () => {
        factoryCalled = true;
        throw new Error("should not construct");
      },
    );

    expect(exitCode).toBe(2);
    expect(factoryCalled).toBe(false);
    expect(stderr.join("")).toContain("SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY is required");
  });

  it("rejects request cwd values outside the current workspace", async () => {
    for (const cwd of ["/", "../escape"]) {
      let factoryCalled = false;
      const stderr: string[] = [];
      const exitCode = await runSubscriptionAgentTaskCli(
        ["--provider", "codex", "--ephemeral"],
        fakeIo({
          stderr,
          stdin: JSON.stringify({
            protocolVersion: 1,
            cwd,
            task: {
              kind: "structured-prompt",
              prompt: "hello",
            },
          }),
          env: {
            CODEX_AUTH_JSON_PATH: "/tmp/auth.json",
          },
        }),
        () => {
          factoryCalled = true;
          throw new Error("should not construct");
        },
      );

      expect(exitCode).toBe(2);
      expect(factoryCalled).toBe(false);
      expect(stderr.join("")).toContain("Agent task cwd must stay within the current workspace.");
    }
  });
});

function fakeFactory(calls: {
  factory?: RuntimeAgentTaskWorkerFactoryInput;
  seed?: string;
  job?: RuntimeAgentTaskWorkerJob;
}): RuntimeAgentTaskWorkerFactory {
  return (input) => {
    calls.factory = input;
    const worker: RuntimeAgentTaskWorker = {
      async start() {},
      async seedClaudeOAuth(seed) {
        calls.seed = seed.oauthToken;
      },
      async seedCodexAuthJsonFile(path) {
        calls.seed = path;
      },
      async run(job) {
        calls.job = job;
        return {
          outputText: `worker:${job.prompt}`,
          structuredOutput: { ok: true },
          telemetry: { finishReason: "completed" },
          warnings: [],
        };
      },
      async dispose() {},
    };
    return worker;
  };
}

function fakeIo(input: {
  readonly stdin: string;
  readonly stdout?: string[];
  readonly stderr?: string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}): SubscriptionAgentTaskCliIo {
  return {
    async readStdin() {
      return input.stdin;
    },
    writeStdout(chunk) {
      input.stdout?.push(chunk);
    },
    writeStderr(chunk) {
      input.stderr?.push(chunk);
    },
    cwd() {
      return "/workspace/repo";
    },
    env() {
      return input.env;
    },
  };
}
