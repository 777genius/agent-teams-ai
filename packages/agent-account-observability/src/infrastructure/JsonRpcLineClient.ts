import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import type {
  CodexAccountSlot,
  CodexAppServerClientFactoryPort,
  CodexAppServerClientPort,
} from "../providers/codex/codexTypes";
import {
  InMemoryAppServerLaunchThrottle,
  normalizeAppServerLaunchMinIntervalMs,
  type AppServerLaunchThrottlePort,
} from "./AppServerLaunchThrottle";

export type JsonRpcLineClientOptions = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly spawnProcess?: typeof spawn;
};

export const DEFAULT_CODEX_APP_SERVER_LAUNCH_MIN_INTERVAL_MS = 10_000;
export const CODEX_APP_SERVER_LAUNCH_MIN_INTERVAL_MS_ENV =
  "AGENT_ACCOUNT_OBSERVABILITY_CODEX_APP_SERVER_MIN_INTERVAL_MS";
export const SUBSCRIPTION_RUNTIME_CODEX_APP_SERVER_LAUNCH_MIN_INTERVAL_MS_ENV =
  "SUBSCRIPTION_RUNTIME_CODEX_APP_SERVER_MIN_INTERVAL_MS";

export class JsonRpcLineClient implements CodexAppServerClientPort {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private stdoutBuffer = "";
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
      readonly timer: NodeJS.Timeout;
    }
  >();

  constructor(private readonly options: JsonRpcLineClientOptions) {}

  async start(): Promise<void> {
    this.child = (this.options.spawnProcess ?? spawn)(
      this.options.command,
      [...this.options.args],
      {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onStdout(String(chunk)));
    this.child.stdin.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code, signal) => {
      this.rejectAll(new Error(`json_rpc_process_exited:${code ?? signal}`));
    });
    this.child.on("error", (error) => this.rejectAll(error));
    try {
      await this.call({
        method: "initialize",
        params: {
          clientInfo: {
            name: "agent-account-observability",
            title: "Agent account observability",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        },
        ...(this.options.startupTimeoutMs
          ? { timeoutMs: this.options.startupTimeoutMs }
          : {}),
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  call(input: {
    readonly method: string;
    readonly params?: unknown;
    readonly timeoutMs?: number;
  }): Promise<unknown> {
    if (!this.child) throw new Error("json_rpc_process_not_started");
    const child = this.child;
    if (
      child.stdin.destroyed ||
      child.stdin.writableEnded ||
      !child.stdin.writable
    ) {
      return Promise.reject(new Error("json_rpc_stdin_unavailable"));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`json_rpc_request_timeout:${input.method}`));
      }, input.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(
          `${JSON.stringify({
            id,
            method: input.method,
            params: input.params ?? {},
          })}\n`,
          (error) => {
            if (error) this.rejectPending(id, error);
          },
        );
      } catch (error) {
        this.rejectPending(id, toError(error));
      }
    });
  }

  async close(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    this.rejectAll(new Error("json_rpc_process_closed"));
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    if (await waitForChildExit(child, 250)) return;
    child.kill("SIGKILL");
    await waitForChildExit(child, 250);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const record =
        message && typeof message === "object"
          ? (message as Record<string, unknown>)
          : null;
      const id = typeof record?.id === "number" ? record.id : undefined;
      if (id === undefined) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (record?.error) {
        const errorRecord =
          record.error && typeof record.error === "object"
            ? (record.error as Record<string, unknown>)
            : null;
        pending.reject(
          new Error(
            typeof errorRecord?.message === "string"
              ? errorRecord.message
              : "json_rpc_error",
          ),
        );
        continue;
      }
      pending.resolve(record?.result ?? {});
    }
  }

  private rejectAll(error: Error): void {
    for (const id of this.pending.keys()) this.rejectPending(id, error);
  }

  private rejectPending(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(child.exitCode !== null), timeoutMs);
    child.once("exit", onExit);
  });
}

export class CodexAppServerClientFactory
  implements CodexAppServerClientFactoryPort
{
  private readonly launchThrottle: AppServerLaunchThrottlePort;

  constructor(
    private readonly options: {
      readonly codexBinaryPath?: string;
      readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
      readonly startupTimeoutMs?: number;
      readonly requestTimeoutMs?: number;
      readonly appServerLaunchThrottle?: AppServerLaunchThrottlePort;
      readonly appServerLaunchMinIntervalMs?: number;
    } = {},
  ) {
    const minIntervalMs =
      options.appServerLaunchMinIntervalMs ??
      resolveCodexAppServerLaunchMinIntervalMs(
        options.sourceEnv ?? process.env,
      );
    this.launchThrottle =
      options.appServerLaunchThrottle ??
      sharedCodexAppServerLaunchThrottle(minIntervalMs);
  }

  async open(input: {
    readonly account: CodexAccountSlot;
    readonly timeoutMs?: number;
  }): Promise<CodexAppServerClientPort> {
    await this.launchThrottle.waitForLaunch();

    const client = new JsonRpcLineClient({
      command:
        input.account.codexBinaryPath ?? this.options.codexBinaryPath ?? "codex",
      args: ["app-server", "--listen", "stdio://"],
      cwd: input.account.authHome,
      env: {
        ...pruneEnv(this.options.sourceEnv ?? process.env),
        CODEX_HOME: input.account.authHome,
        HOME: dirname(input.account.authHome),
        CI: "true",
        ...(input.account.authJsonPath
          ? { REVIEWROUTER_CODEX_AUTH_PATH: input.account.authJsonPath }
          : {}),
      },
      ...(input.timeoutMs ?? this.options.startupTimeoutMs
        ? { startupTimeoutMs: input.timeoutMs ?? this.options.startupTimeoutMs }
        : {}),
      ...(input.timeoutMs ?? this.options.requestTimeoutMs
        ? { requestTimeoutMs: input.timeoutMs ?? this.options.requestTimeoutMs }
        : {}),
    });
    await client.start();
    return client;
  }
}

export function resolveCodexAppServerLaunchMinIntervalMs(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const values = [
    env[CODEX_APP_SERVER_LAUNCH_MIN_INTERVAL_MS_ENV],
    env[SUBSCRIPTION_RUNTIME_CODEX_APP_SERVER_LAUNCH_MIN_INTERVAL_MS_ENV],
  ];
  for (const value of values) {
    if (value === undefined || value.trim() === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  }
  return DEFAULT_CODEX_APP_SERVER_LAUNCH_MIN_INTERVAL_MS;
}

const sharedCodexAppServerLaunchThrottles = new Map<
  number,
  AppServerLaunchThrottlePort
>();

function sharedCodexAppServerLaunchThrottle(
  minIntervalMs: number,
): AppServerLaunchThrottlePort {
  const normalized = normalizeAppServerLaunchMinIntervalMs(minIntervalMs);
  const existing = sharedCodexAppServerLaunchThrottles.get(normalized);
  if (existing) return existing;

  const throttle = new InMemoryAppServerLaunchThrottle({
    minIntervalMs: normalized,
  });
  sharedCodexAppServerLaunchThrottles.set(normalized, throttle);
  return throttle;
}

function pruneEnv(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
