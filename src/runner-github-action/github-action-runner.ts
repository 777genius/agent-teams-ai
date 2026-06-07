import { spawn } from "node:child_process";
import type {
  OutputSink,
  ProcessResult,
  RedactorPort,
  RunnerPort,
} from "@vioxen/subscription-runtime/core";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { githubActionRunnerCapabilities } from "./capabilities";

const defaultMaxCapturedOutputBytes = 256_000;

export type GitHubActionRunnerOptions = {
  readonly redactor?: RedactorPort;
  readonly maxCapturedOutputBytes?: number;
};

export class GitHubActionRunner implements RunnerPort {
  readonly runnerId = githubActionRunnerCapabilities.runnerId;
  readonly capabilities = githubActionRunnerCapabilities;
  private readonly redactor: RedactorPort;
  private readonly maxCapturedOutputBytes: number;

  constructor(options: GitHubActionRunnerOptions = {}) {
    this.redactor = options.redactor ?? new DefaultRedactor();
    this.maxCapturedOutputBytes =
      options.maxCapturedOutputBytes ?? defaultMaxCapturedOutputBytes;
  }

  run(input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly stdin?: Uint8Array;
    readonly timeoutMs: number;
    readonly stdout?: OutputSink;
    readonly stderr?: OutputSink;
    readonly abortSignal: AbortSignal;
  }): Promise<ProcessResult> {
    try {
      assertSafeProcessInput(input);
    } catch (error) {
      return Promise.reject(error);
    }
    if (input.abortSignal.aborted) {
      return Promise.reject(new Error("process_aborted"));
    }

    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let capturedBytes = 0;
      let settled = false;
      const child = spawn(input.command, input.args, {
        cwd: input.cwd,
        env: input.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const cleanup = (): void => {
        clearTimeout(timer);
        input.abortSignal.removeEventListener("abort", abort);
      };
      const settleReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const abort = (): void => {
        child.kill("SIGTERM");
        settleReject(new Error("process_aborted"));
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        settleReject(new Error("process_timeout"));
      }, input.timeoutMs);

      input.abortSignal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        writeRedacted(input.stdout, this.redactor, buffer);
        capturedBytes = appendCapturedChunk(
          stdoutChunks,
          capturedBytes,
          buffer,
          this.maxCapturedOutputBytes,
        );
      });
      child.stderr.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        writeRedacted(input.stderr, this.redactor, buffer);
        capturedBytes = appendCapturedChunk(
          stderrChunks,
          capturedBytes,
          buffer,
          this.maxCapturedOutputBytes,
        );
      });
      child.on("error", (error) => {
        settleReject(error instanceof Error ? error : new Error(String(error)));
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        const stdout = this.redactor.redact(
          Buffer.concat(stdoutChunks).toString("utf8"),
        );
        const stderr = this.redactor.redact(
          Buffer.concat(stderrChunks).toString("utf8"),
        );
        const durationMs = Date.now() - startedAt;
        if (code === 0) {
          resolve({
            exitCode: 0,
            stdout,
            stderr,
            durationMs,
          });
          return;
        }
        reject(
          new Error(
            `process_failed:${input.command}:${code ?? "signal"}:${safeFailureOutput(
              `${stdout}\n${stderr}`,
            )}`,
          ),
        );
      });
      child.stdin.end(input.stdin ? Buffer.from(input.stdin) : undefined);
    });
  }
}

function assertSafeProcessInput(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}): void {
  if (!input.command || input.command.includes("\0")) {
    throw new Error("runner_invalid_command");
  }
  if (!input.cwd || input.cwd.includes("\0")) {
    throw new Error("runner_invalid_cwd");
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("runner_invalid_timeout");
  }
  for (const arg of input.args) {
    if (arg.includes("\0")) {
      throw new Error("runner_invalid_arg");
    }
  }
  for (const key of Object.keys(input.env)) {
    if (isForbiddenRunnerEnvKey(key)) {
      throw new Error(`runner_forbidden_env:${key}`);
    }
  }
}

function isForbiddenRunnerEnvKey(key: string): boolean {
  return (
    key === "GITHUB_TOKEN" ||
    key === "GH_TOKEN" ||
    key === "ACTIONS_ID_TOKEN_REQUEST_URL" ||
    key === "ACTIONS_ID_TOKEN_REQUEST_TOKEN" ||
    key === "GITHUB_ENV" ||
    key === "GITHUB_OUTPUT" ||
    key === "GITHUB_PATH" ||
    key === "GITHUB_STEP_SUMMARY" ||
    key === "GITHUB_STATE" ||
    key === "NODE_OPTIONS" ||
    key === "BASH_ENV" ||
    key === "ENV" ||
    key.startsWith("INPUT_AUTH") ||
    key.includes("AUTH_JSON") ||
    key.includes("OPENAI_API_KEY") ||
    key.includes("CLAUDE_CODE_OAUTH_TOKEN") ||
    key.includes("OPENROUTER_API_KEY")
  );
}

function writeRedacted(
  sink: OutputSink | undefined,
  redactor: RedactorPort,
  chunk: Buffer,
): void {
  if (!sink) return;
  sink.write(redactor.redact(chunk.toString("utf8")));
}

function appendCapturedChunk(
  chunks: Buffer[],
  currentBytes: number,
  chunk: Buffer,
  maxBytes: number,
): number {
  const remaining = maxBytes - currentBytes;
  if (remaining <= 0) return currentBytes;
  const nextChunk =
    chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
  chunks.push(nextChunk);
  return currentBytes + nextChunk.byteLength;
}

function safeFailureOutput(output: string): string {
  const compact = output.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(-1000) : "empty_process_output";
}
