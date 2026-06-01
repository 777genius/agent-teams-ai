import { mkdtemp, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { describe, expect, it } from "vitest";
import { FileBackendCodexWorker } from "../index";
import { NodeProcessRunner } from "../node-process-runner";

const validAuthJson = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    refresh_token: "refresh-token",
    access_token: "access-token",
    expiry: "2026-05-31T23:00:00.000Z",
  },
  last_refresh: "2026-05-31T00:00:00.000Z",
});

describe("FileBackendCodexWorker", () => {
  it("exposes lifecycle, seed, prewarm, health, and dispose", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const appServer = new FakeAppServerFactory();
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:test",
      stateRootDir: rootDir,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(7),
      appServerProcessFactory: appServer.create,
      clock: {
        now: () => new Date("2026-05-31T00:05:00.000Z"),
        monotonicMs: () => 1,
      },
    });

    try {
      await expect(worker.health()).resolves.toMatchObject({
        status: "unhealthy",
      });
      await worker.start();
      await worker.seedCodexAuthJson(validAuthJson);
      await expect(worker.health()).resolves.toMatchObject({
        status: "healthy",
      });
      await expect(worker.prewarm()).resolves.toMatchObject({
        status: "ready",
        details: {
          engine: "app-server-pool",
          engineReusable: "true",
        },
      });
      expect(appServer.spawnCount).toBe(1);
      expect(appServer.envs[0]).toMatchObject({ PATH: process.env.PATH });
      expect(appServer.prompts).toEqual(["Return exactly OK."]);
      await worker.dispose();
      await expect(worker.run({ prompt: "hello" })).rejects.toThrow(
        "Codex worker has been disposed.",
      );
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("requires explicit start before running work", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:test",
      stateRootDir: rootDir,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(8),
    });

    try {
      await expect(worker.run({ prompt: "hello" })).rejects.toThrow(
        "Codex worker has not been started.",
      );
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

class FakeAppServerFactory {
  spawnCount = 0;
  readonly prompts: string[] = [];
  readonly envs: Readonly<Record<string, string>>[] = [];

  readonly create = (input: {
    readonly env: Readonly<Record<string, string>>;
  }) => {
    this.spawnCount += 1;
    this.envs.push(input.env);
    return new FakeAppServerProcess((prompt) => this.prompts.push(prompt));
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

  constructor(private readonly onPrompt: (prompt: string) => void) {
    super();
  }

  kill(): boolean {
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }

  private handleRequest(chunk: string): void {
    for (const line of chunk.split(/\n/)) {
      if (!line.trim()) continue;
      const request = JSON.parse(line) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (request.method === "initialize") {
        this.respond(request.id, { userAgent: "fake-codex" });
        continue;
      }
      if (request.method === "thread/start") {
        const threadId = `thread-${this.nextThreadId}`;
        this.nextThreadId += 1;
        this.respond(request.id, { thread: { id: threadId } });
        continue;
      }
      if (request.method === "turn/start") {
        const turnId = `turn-${this.nextTurnId}`;
        this.nextTurnId += 1;
        const prompt = extractFakePrompt(request.params);
        this.onPrompt(prompt);
        this.respond(request.id, { turn: { id: turnId } });
        setTimeout(() => {
          this.notify("item/agentMessage/delta", {
            turnId,
            delta: "OK",
          });
          this.notify("turn/completed", {
            turn: { id: turnId, status: { type: "completed" } },
          });
        }, 1);
        continue;
      }
      this.respond(request.id, {});
    }
  }

  private respond(id: number, result: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify({ id, result })}\n`);
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

describe("NodeProcessRunner", () => {
  it("rejects non-zero process exits with a safe error", async () => {
    const runner = new NodeProcessRunner();

    await expect(
      runner.run({
        command: execPath,
        args: ["-e", "process.stderr.write('bad exit'); process.exit(7)"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 30_000,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("node_process_runner_failed:7:bad exit");
  });

  it("rejects timed-out work even when the process exits zero after SIGTERM", async () => {
    const runner = new NodeProcessRunner({ killGraceMs: 500 });

    await expect(
      runner.run({
        command: execPath,
        args: [
          "-e",
          [
            "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 20));",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 50,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("node_process_runner_timeout:50");
  });

  it("does not spawn work for an already-aborted signal", async () => {
    const runner = new NodeProcessRunner();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runner.run({
        command: "/path/that/must/not/spawn",
        args: [],
        cwd: process.cwd(),
        env: {},
        timeoutMs: 1_000,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("node_process_runner_aborted");
  });
});
