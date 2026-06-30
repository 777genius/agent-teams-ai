import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
            systemPrompt: "return strict JSON",
            controls: {
              model: "opus",
              maxTurns: 1,
              permissionMode: "preapproved",
            },
          },
        }),
        env: {
          PATH: "/usr/bin",
          CLAUDE_RUNTIME_DIST_DIR: "/tmp/claude-runtime-dist",
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
      claudeRuntimeDistDir: "/tmp/claude-runtime-dist",
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
      systemPrompt: "return strict JSON",
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

  it("runs the default Codex worker in the borrowed request cwd without deleting it", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "subscription-runtime-codex-cli-"));
    const workspaceDir = join(tempDir, "workspace");
    const authPath = join(tempDir, "auth.json");
    const codexPath = join(tempDir, "fake-codex.mjs");
    const canaryPath = join(workspaceDir, "canary.txt");
    await mkdir(workspaceDir);
    await writeFile(canaryPath, "safe", "utf8");
    await writeFile(authPath, validCodexAuthJson(), "utf8");
    await writeFakeCodexBinary(codexPath);

    try {
      const stdout: string[] = [];
      const exitCode = await runSubscriptionAgentTaskCli(
        [
          "--provider",
          "codex",
          "--ephemeral",
          "--codex-binary",
          codexPath,
          "--format",
          "result-json",
        ],
        fakeIo({
          cwd: workspaceDir,
          stdout,
          stdin: JSON.stringify({
            protocolVersion: 1,
            cwd: ".",
            providerInstanceId: "codex:e2e",
            task: {
              kind: "structured-prompt",
              prompt: "hello-from-sandbox",
            },
          }),
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            CODEX_AUTH_JSON_PATH: authPath,
          },
        }),
      );

      expect(exitCode, stdout.join("")).toBe(0);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        protocolVersion: 1,
        status: "completed",
        outputText: `fake-codex-ok:${await realpath(workspaceDir)}:hello-from-sandbox`,
      });
      await expect(access(canaryPath)).resolves.toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves the borrowed request cwd when the default Codex worker fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "subscription-runtime-codex-cli-"));
    const workspaceDir = join(tempDir, "workspace");
    const authPath = join(tempDir, "auth.json");
    const codexPath = join(tempDir, "fake-codex.mjs");
    const canaryPath = join(workspaceDir, "canary.txt");
    await mkdir(workspaceDir);
    await writeFile(canaryPath, "safe", "utf8");
    await writeFile(authPath, validCodexAuthJson(), "utf8");
    await writeFakeCodexBinary(codexPath, {
      appServerTurnFails: true,
      fallbackExecFails: true,
    });

    try {
      const stdout: string[] = [];
      const exitCode = await runSubscriptionAgentTaskCli(
        [
          "--provider",
          "codex",
          "--ephemeral",
          "--codex-binary",
          codexPath,
          "--format",
          "result-json",
        ],
        fakeIo({
          cwd: workspaceDir,
          stdout,
          stdin: JSON.stringify({
            protocolVersion: 1,
            cwd: ".",
            providerInstanceId: "codex:e2e",
            task: {
              kind: "structured-prompt",
              prompt: "must-fail",
            },
          }),
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            CODEX_AUTH_JSON_PATH: authPath,
          },
        }),
      );

      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        protocolVersion: 1,
        status: "failed",
        failure: {
          code: "unknown_runtime_failure",
          details: {
            exitCode: "7",
            stderrTail: "forced fallback failure",
          },
        },
      });
      await expect(access(canaryPath)).resolves.toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs the Codex exec fallback in the borrowed request cwd", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "subscription-runtime-codex-cli-"));
    const workspaceDir = join(tempDir, "workspace");
    const authPath = join(tempDir, "auth.json");
    const codexPath = join(tempDir, "fake-codex.mjs");
    const canaryPath = join(workspaceDir, "canary.txt");
    await mkdir(workspaceDir);
    await writeFile(canaryPath, "safe", "utf8");
    await writeFile(authPath, validCodexAuthJson(), "utf8");
    await writeFakeCodexBinary(codexPath, {
      appServerTurnFails: true,
    });

    try {
      const stdout: string[] = [];
      const exitCode = await runSubscriptionAgentTaskCli(
        [
          "--provider",
          "codex",
          "--ephemeral",
          "--codex-binary",
          codexPath,
          "--format",
          "result-json",
        ],
        fakeIo({
          cwd: workspaceDir,
          stdout,
          stdin: JSON.stringify({
            protocolVersion: 1,
            cwd: ".",
            providerInstanceId: "codex:e2e",
            task: {
              kind: "structured-prompt",
              prompt: "hello-from-fallback",
            },
          }),
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            CODEX_AUTH_JSON_PATH: authPath,
          },
        }),
      );

      const result = JSON.parse(stdout.join("")) as {
        readonly status: string;
        readonly outputText?: string;
      };
      expect(exitCode, stdout.join("")).toBe(0);
      expect(result.status).toBe("completed");
      expect(result.outputText).toContain(`fake-codex-exec-ok:${await realpath(workspaceDir)}:`);
      expect(result.outputText).toContain("hello-from-fallback");
      await expect(access(canaryPath)).resolves.toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runSubscriptionAgentTaskCli(
      [
        "--provider",
        "claude",
        "--format",
        "result-json",
        "--state-root",
        "/tmp/runtime-state",
      ],
      fakeIo({
        stdout,
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
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      protocolVersion: 1,
      status: "failed",
      failure: {
        code: "unknown_runtime_failure",
        safeMessage: "SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY is required",
      },
    });
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

  it("rejects request cwd symlinks that resolve outside the current workspace", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "subscription-runtime-agent-task-cwd-"));
    const workspaceDir = join(tempDir, "workspace");
    const outsideDir = join(tempDir, "outside");
    const linkDir = join(workspaceDir, "outside-link");
    await mkdir(workspaceDir);
    await mkdir(outsideDir);
    await symlink(outsideDir, linkDir);

    try {
      let factoryCalled = false;
      const stderr: string[] = [];
      const exitCode = await runSubscriptionAgentTaskCli(
        ["--provider", "codex", "--ephemeral"],
        fakeIo({
          cwd: workspaceDir,
          stderr,
          stdin: JSON.stringify({
            protocolVersion: 1,
            cwd: "outside-link",
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
    } finally {
      await rm(tempDir, { recursive: true, force: true });
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
  readonly cwd?: string;
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
      return input.cwd ?? process.cwd();
    },
    env() {
      return input.env;
    },
  };
}

function validCodexAuthJson(): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      refresh_token: "refresh-token",
      access_token: "access-token",
      expiry: "2027-05-31T23:00:00.000Z",
    },
    last_refresh: "2026-05-31T00:00:00.000Z",
  });
}

async function writeFakeCodexBinary(
  path: string,
  input: {
    readonly appServerTurnFails?: boolean;
    readonly fallbackExecFails?: boolean;
  } = {},
): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
import readline from "node:readline";

const appServerTurnFails = ${JSON.stringify(Boolean(input.appServerTurnFails))};
const fallbackExecFails = ${JSON.stringify(Boolean(input.fallbackExecFails))};

if (process.argv[2] === "exec") {
  const isJsonExec = process.argv.includes("--json");
  if (isJsonExec && fallbackExecFails) {
    process.stderr.write("forced fallback failure");
    process.exit(7);
  }
  let stdin = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    stdin += chunk;
  });
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify({
      message: "fake-codex-exec-ok:" + process.cwd() + ":" + stdin.trim(),
    }) + "\\n");
  });
  process.stdin.resume();
} else if (process.argv[2] !== "app-server") {
  process.stderr.write("unexpected fake codex args: " + process.argv.slice(2).join(" "));
  process.exit(2);
} else {
  runAppServer();
}

function runAppServer() {
  let nextThreadId = 1;
  let nextTurnId = 1;
  const threadCwds = new Map();
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  function write(message) {
    process.stdout.write(JSON.stringify(message) + "\\n");
  }

  function promptFromParams(params) {
    const input = params?.input;
    if (!Array.isArray(input)) return "";
    const first = input[0];
    return typeof first?.text === "string" ? first.text : "";
  }

  rl.on("line", (line) => {
    if (!line.trim()) return;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      write({ id: request.id, result: { userAgent: "fake-codex-e2e" } });
      return;
    }
    if (request.method === "thread/start") {
      const threadId = "thread-" + nextThreadId;
      nextThreadId += 1;
      if (typeof request.params?.cwd === "string") {
        threadCwds.set(threadId, request.params.cwd);
      }
      write({ id: request.id, result: { thread: { id: threadId } } });
      return;
    }
    if (request.method === "turn/start") {
      if (appServerTurnFails) {
        write({
          id: request.id,
          error: {
            message: "forced app-server turn failure",
          },
        });
        return;
      }
      const turnId = "turn-" + nextTurnId;
      nextTurnId += 1;
      const prompt = promptFromParams(request.params);
      const cwd = threadCwds.get(request.params?.threadId) ?? "cwd-missing";
      write({ id: request.id, result: { turn: { id: turnId } } });
      setTimeout(() => {
        write({
          method: "item/agentMessage/delta",
          params: {
            turnId,
            delta: "fake-codex-ok:" + cwd + ":" + prompt,
          },
        });
        write({
          method: "turn/completed",
          params: {
            turn: { id: turnId, status: { type: "completed" } },
          },
        });
      }, 1);
      return;
    }
    write({ id: request.id, result: {} });
  });
}
`,
    "utf8",
  );
  await chmod(path, 0o700);
}
