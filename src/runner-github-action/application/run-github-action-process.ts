import type {
  OutputSink,
  ProcessResult,
  RedactorPort,
} from "@vioxen/subscription-runtime/core";
import {
  assertSafeGitHubActionProcessInput,
  safeGitHubActionFailureOutput,
} from "../domain/github-action-runner-policy";
import type { RunnerProcessSpawnerPort } from "../ports/runner-process-spawner-port";

export type RunGitHubActionProcessInput = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array;
  readonly timeoutMs: number;
  readonly stdout?: OutputSink;
  readonly stderr?: OutputSink;
  readonly abortSignal: AbortSignal;
  readonly redactor: RedactorPort;
  readonly maxCapturedOutputBytes: number;
  readonly killGraceMs: number;
  readonly processSpawner: RunnerProcessSpawnerPort;
};

export function runGitHubActionProcess(
  input: RunGitHubActionProcessInput,
): Promise<ProcessResult> {
  try {
    assertSafeGitHubActionProcessInput(input);
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
    let terminalError: Error | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;
    const child = input.processSpawner.spawn({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      env: input.env,
    });

    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.abortSignal.removeEventListener("abort", abort);
    };
    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const terminate = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      forceKillTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, input.killGraceMs);
    };
    const failAfterExit = (error: Error): void => {
      if (settled || terminalError) return;
      terminalError = error;
      terminate();
    };
    const abort = (): void => {
      failAfterExit(new Error("process_aborted"));
    };
    timeoutTimer = setTimeout(() => {
      failAfterExit(new Error("process_timeout"));
    }, input.timeoutMs);
    const failOutputSink = (
      streamName: "stdout" | "stderr",
      error: unknown,
    ): void => {
      const message = error instanceof Error ? error.message : String(error);
      failAfterExit(
        new Error(`process_output_sink_failed:${streamName}:${message}`),
      );
    };
    const failStdin = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      failAfterExit(new Error(`process_stdin_failed:${message}`));
    };

    input.abortSignal.addEventListener("abort", abort, { once: true });
    child.onOutput("stdout", (chunk) => {
      const buffer = Buffer.from(chunk);
      try {
        writeRedacted(input.stdout, input.redactor, buffer);
      } catch (error) {
        failOutputSink("stdout", error);
        return;
      }
      capturedBytes = appendCapturedChunk(
        stdoutChunks,
        capturedBytes,
        buffer,
        input.maxCapturedOutputBytes,
      );
    });
    child.onOutput("stderr", (chunk) => {
      const buffer = Buffer.from(chunk);
      try {
        writeRedacted(input.stderr, input.redactor, buffer);
      } catch (error) {
        failOutputSink("stderr", error);
        return;
      }
      capturedBytes = appendCapturedChunk(
        stderrChunks,
        capturedBytes,
        buffer,
        input.maxCapturedOutputBytes,
      );
    });
    child.onError((error) => {
      if (terminalError) return;
      settleReject(error instanceof Error ? error : new Error(String(error)));
    });
    child.onStdinError(failStdin);
    child.onClose((code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminalError) {
        reject(terminalError);
        return;
      }
      const stdout = input.redactor.redact(
        Buffer.concat(stdoutChunks).toString("utf8"),
      );
      const stderr = input.redactor.redact(
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
          `process_failed:${input.command}:${code ?? "signal"}:${safeGitHubActionFailureOutput(
            `${stdout}\n${stderr}`,
          )}`,
        ),
      );
    });
    try {
      child.endStdin(input.stdin ? Buffer.from(input.stdin) : undefined);
    } catch (error) {
      failStdin(error);
    }
  });
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
