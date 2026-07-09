import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execPath } from "node:process";
import { promisify } from "node:util";
import type {
  ObservabilityPort,
  RuntimeEvent,
  RuntimeMetric,
  RunnerPort,
  WorkspacePort,
} from "@vioxen/subscription-runtime/core";
import {
  AccessBoundary,
  BoundedSubscriptionWorkerPool,
  InMemoryActiveAttemptRegistry,
  InMemoryWorkerAccountCapacityStore,
  InterruptAndContinueWorkerUseCase,
  LaunchPlanStatus,
  WorkerControlService,
  accountCapacityAwareWorkerFactory,
  buildLaunchPlan,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalFileWorkerControlInboxStore } from "@vioxen/subscription-runtime/store-local-file";
import { describe, expect, it } from "vitest";
import {
  CommandPolicyRunner,
  FileBackendCodexSafeExecutor,
  FileBackendCodexWorker,
} from "../index";
import { NodeProcessRunner } from "../node-process-runner";

export const validAuthJson = codexAuthJson("refresh-token");
export const execFileAsync = promisify(execFile);

export type FakeAppServerFactoryOptions = {
  readonly emitTopLevelErrorOnTurn?: string;
  readonly emitTopLevelErrorsOnTurns?: readonly (string | null)[];
  readonly goalStatusesAfterTurns?: readonly string[];
  readonly holdTurnOpen?: boolean;
  readonly writeFileOnTurn?: {
    readonly relativePath: string;
    readonly content: string;
  };
};

export class FakeAppServerFactory {
  spawnCount = 0;
  readonly prompts: string[] = [];
  readonly threadCwds: string[] = [];
  readonly envs: Readonly<Record<string, string>>[] = [];
  readonly codexHomes: string[] = [];
  readonly goalObjectives: string[] = [];
  private emittedTurnErrors = 0;

  constructor(private readonly options: FakeAppServerFactoryOptions = {}) {}

  readonly create = (input: {
    readonly env: Readonly<Record<string, string>>;
  }) => {
    this.spawnCount += 1;
    this.envs.push(input.env);
    this.codexHomes.push(input.env.CODEX_HOME ?? "");
    return new FakeAppServerProcess(
      (prompt) => this.prompts.push(prompt),
      (cwd) => this.threadCwds.push(cwd),
      (objective) => this.goalObjectives.push(objective),
      () => this.configuredTurnError(),
      this.options,
    );
  };

  private configuredTurnError(): string | null {
    const sequence = this.options.emitTopLevelErrorsOnTurns;
    if (sequence) {
      const value = sequence[this.emittedTurnErrors];
      this.emittedTurnErrors += 1;
      return value ?? null;
    }
    return this.options.emitTopLevelErrorOnTurn ?? null;
  }
}

export class FakeAppServerProcess extends EventEmitter {
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
  private completedTurnCount = 0;
  private readonly threadCwdsById = new Map<string, string>();
  private readonly goals = new Map<
    string,
    { objective: string; status: string }
  >();

  constructor(
    private readonly onPrompt: (prompt: string) => void,
    private readonly onThreadCwd: (cwd: string) => void,
    private readonly onGoalObjective: (objective: string) => void,
    private readonly nextTurnError: () => string | null,
    private readonly options: FakeAppServerFactoryOptions,
  ) {
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
        const cwd = request.params?.cwd;
        if (typeof cwd === "string") {
          this.onThreadCwd(cwd);
          this.threadCwdsById.set(threadId, cwd);
        }
        this.respond(request.id, { thread: { id: threadId } });
        continue;
      }
      if (request.method === "thread/goal/set") {
        const threadId = String(request.params?.threadId ?? "");
        const objective = String(request.params?.objective ?? "");
        const status = String(request.params?.status ?? "active");
        this.goals.set(threadId, { objective, status });
        this.onGoalObjective(objective);
        this.respond(request.id, {
          goal: {
            threadId,
            objective,
            status,
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 0,
            updatedAt: 0,
          },
        });
        continue;
      }
      if (request.method === "thread/goal/get") {
        const threadId = String(request.params?.threadId ?? "");
        const goal = this.goals.get(threadId);
        this.respond(request.id, {
          goal: goal
            ? {
                threadId,
                objective: goal.objective,
                status: goal.status,
                tokenBudget: null,
                tokensUsed: 0,
                timeUsedSeconds: 0,
                createdAt: 0,
                updatedAt: 0,
              }
            : null,
        });
        continue;
      }
      if (request.method === "turn/start") {
        const turnId = `turn-${this.nextTurnId}`;
        this.nextTurnId += 1;
        const prompt = extractFakePrompt(request.params);
        this.onPrompt(prompt);
        this.respond(request.id, { turn: { id: turnId } });
        setTimeout(() => {
          void this.writeConfiguredTurnFile(request.params).then(() => {
            if (this.options.holdTurnOpen) {
              this.notify("turn/started", {
                threadId: String(request.params?.threadId ?? ""),
                turn: { id: turnId, status: "inProgress" },
              });
              return;
            }
            const errorMessage = this.nextTurnError();
            if (errorMessage) {
              this.stdout.emit(
                "data",
                `${JSON.stringify({
                  method: "error",
                  message: errorMessage,
                })}\n`,
              );
              return;
            }
            this.markGoalAfterCompletedTurn(
              String(request.params?.threadId ?? ""),
            );
            this.notify("item/agentMessage/delta", {
              turnId,
              delta: "OK",
            });
            this.notify("turn/completed", {
              turn: { id: turnId, status: { type: "completed" } },
            });
          });
        }, 1);
        continue;
      }
      this.respond(request.id, {});
    }
  }

  private markGoalAfterCompletedTurn(threadId: string): void {
    const goal = this.goals.get(threadId);
    if (!goal) return;
    const nextStatus =
      this.options.goalStatusesAfterTurns?.[this.completedTurnCount] ??
      "complete";
    this.completedTurnCount += 1;
    this.goals.set(threadId, { ...goal, status: nextStatus });
  }

  private async writeConfiguredTurnFile(
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    const write = this.options.writeFileOnTurn;
    if (!write) return;
    const threadId = params?.threadId;
    if (typeof threadId !== "string") return;
    const cwd = this.threadCwdsById.get(threadId);
    if (!cwd) return;
    await writeFile(join(cwd, write.relativePath), write.content, "utf8");
  }

  private respond(id: number, result: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify({ id, result })}\n`);
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify({ method, params })}\n`);
  }
}

export class FakeReadable extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

export class MemoryWorkerObservability implements ObservabilityPort {
  readonly events: RuntimeEvent[] = [];
  readonly metrics: Array<{ readonly metric: RuntimeMetric; readonly value?: number }> = [];
  readonly timings: Array<{ readonly metric: RuntimeMetric; readonly durationMs: number }> = [];

  emit(event: RuntimeEvent): void {
    this.events.push(event);
  }

  count(metric: RuntimeMetric, value?: number): void {
    this.metrics.push({ metric, ...(value === undefined ? {} : { value }) });
  }

  timing(metric: RuntimeMetric, durationMs: number): void {
    this.timings.push({ metric, durationMs });
  }
}

export function isolatedWorkspaceCommandPolicy() {
  const plan = buildLaunchPlan({
    boundary: AccessBoundary.IsolatedWorkspaceWrite,
    scope: {
      projectId: "project",
      readRoots: ["/tmp/project"],
      isolatedWorkspaceRoot: "/tmp/project",
      workspaceRoots: ["/tmp/project"],
      worktreeRoots: ["/tmp/project-worktrees"],
      registryRoot: "/tmp/worker-jobs",
      allowedBranches: ["main"],
      jobIdPrefixes: ["project-"],
    },
    adapter: {
      canEnforceFilesystemPolicy: true,
      canIsolateHome: true,
      canIsolateTemp: true,
      canDisableRawShell: true,
      canBrokerProjectControl: true,
      canRestrictNetwork: true,
    },
  });
  if (plan.status !== LaunchPlanStatus.Ready) {
    throw new Error("test_command_policy_launch_plan_blocked");
  }
  return plan.commandPolicy;
}

export class StaticRunner implements RunnerPort {
  readonly runnerId = "node-process";
  readonly capabilities = {
    runnerId: this.runnerId,
    supportsEnvAllowlist: true,
    supportsWorkingDirectory: true,
    supportsTimeout: true,
    supportsAbortSignal: true,
    supportsOutputRedaction: true,
    supportsReadOnlySandbox: true,
    readOnlyFilesystem: true,
    platform: "node-process" as const,
  };

  constructor(
    private readonly result: {
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    },
  ) {}

  lastArgs: readonly string[] = [];
  lastCwd = "";
  lastStdin = "";

  async run(input: Parameters<RunnerPort["run"]>[0]) {
    this.lastArgs = input.args;
    this.lastCwd = input.cwd;
    this.lastStdin = new TextDecoder().decode(input.stdin);
    return {
      ...this.result,
      durationMs: 1,
    };
  }
}

export class RefreshingFakeRunner implements RunnerPort {
  readonly runnerId = "node-process";
  readonly capabilities = {
    runnerId: this.runnerId,
    supportsEnvAllowlist: true,
    supportsWorkingDirectory: true,
    supportsTimeout: true,
    supportsAbortSignal: true,
    supportsOutputRedaction: true,
    supportsReadOnlySandbox: true,
    readOnlyFilesystem: true,
    platform: "node-process" as const,
  };
  runCount = 0;

  async run(input: Parameters<RunnerPort["run"]>[0]) {
    this.runCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const authPath = input.env.REVIEWROUTER_CODEX_AUTH_PATH;
    if (!authPath) {
      throw new Error("missing_auth_path");
    }
    const { readFile, writeFile } = await import("node:fs/promises");
    const auth = JSON.parse(await readFile(authPath, "utf8")) as {
      tokens: { access_token?: string; expiry?: string };
      last_refresh?: string;
    };
    auth.tokens.access_token = `access-token-refreshed-${this.runCount}`;
    auth.tokens.expiry = "2026-05-31T23:00:00.000Z";
    auth.last_refresh = "2026-05-31T00:05:00.000Z";
    await writeFile(authPath, JSON.stringify(auth), "utf8");
    return { exitCode: 0, stdout: "OK", stderr: "", durationMs: 50 };
  }
}

export function codexAuthJson(refreshToken: string): string {
  return codexAuthJsonAt(refreshToken, "2026-05-31T00:00:00.000Z");
}

export function codexAuthJsonForAccount(
  refreshToken: string,
  accountId: string,
): string {
  const auth = JSON.parse(codexAuthJson(refreshToken)) as {
    tokens: { id_token?: string };
  };
  auth.tokens.id_token = fakeJwt({
    "https://api.openai.com/auth.chatgpt_account_id": accountId,
  });
  return JSON.stringify(auth);
}

export function codexAuthJsonAt(refreshToken: string, lastRefresh: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      refresh_token: refreshToken,
      access_token: "access-token",
      expiry: "2026-05-31T23:00:00.000Z",
    },
    last_refresh: lastRefresh,
  });
}

export function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

export async function gitWorkspace(prefix: string): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), prefix));
  await execFileAsync("git", ["init"], { cwd: workspacePath });
  await writeFile(join(workspacePath, "README.md"), "base\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: workspacePath });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Subscription Runtime Tests",
      "-c",
      "user.email=tests@example.com",
      "commit",
      "-m",
      "Initial commit",
    ],
    { cwd: workspacePath },
  );
  return workspacePath;
}

export function extractFakePrompt(
  params: Record<string, unknown> | undefined,
): string {
  const input = params?.input;
  if (!Array.isArray(input)) return "";
  const first = input[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : "";
}

export function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

export async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("wait_until_timeout");
}
