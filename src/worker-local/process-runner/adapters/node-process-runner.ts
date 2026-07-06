import { spawn } from "node:child_process";
import type {
  OutputSink,
  ProcessResult,
  RunnerPort,
} from "@vioxen/subscription-runtime/core";
import { safeProcessFailureOutput } from "../domain/process-output";

export type NodeProcessRunnerOptions = {
  readonly killGraceMs?: number;
};

export class NodeProcessRunner implements RunnerPort {
  readonly runnerId = "node-process-runner";
  readonly capabilities = {
    runnerId: this.runnerId,
    supportsEnvAllowlist: true,
    supportsWorkingDirectory: true,
    supportsTimeout: true,
    supportsAbortSignal: true,
    supportsOutputRedaction: false,
    supportsReadOnlySandbox: false,
    readOnlyFilesystem: false,
    platform: "node-process" as const,
  };

  constructor(private readonly options: NodeProcessRunnerOptions = {}) {}

  async run(input: {
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
    if (input.abortSignal.aborted) {
      throw new Error("node_process_runner_aborted");
    }
    const startedAt = Date.now();
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let forceKillTimer: NodeJS.Timeout | null = null;
    let abortError: Error | null = null;
    let childError: Error | null = null;
    let outputSinkError: Error | null = null;
    let stdinError: Error | null = null;
    let timedOut = false;
    let terminalReason:
      | "abort"
      | "timeout"
      | "child"
      | "outputSink"
      | "stdin"
      | null = null;
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      forceKillTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, this.options.killGraceMs ?? 5_000);
    };
    const writeOutputSink = (
      streamName: "stdout" | "stderr",
      sink: OutputSink | undefined,
      chunk: Buffer,
    ): void => {
      if (!sink || outputSinkError) return;
      try {
        sink.write(chunk);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!terminalReason) {
          terminalReason = "outputSink";
          outputSinkError = new Error(
            `node_process_runner_output_sink_failed:${streamName}:${message}`,
          );
        }
        terminate();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      writeOutputSink("stdout", input.stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      writeOutputSink("stderr", input.stderr, chunk);
    });

    const timeout = setTimeout(() => {
      if (!terminalReason) {
        terminalReason = "timeout";
        timedOut = true;
      }
      terminate();
    }, input.timeoutMs);
    const abort = () => {
      if (!terminalReason) {
        terminalReason = "abort";
        abortError = new Error("node_process_runner_aborted");
      }
      terminate();
    };
    input.abortSignal.addEventListener("abort", abort, { once: true });

    try {
      const exit = await new Promise<{
        readonly exitCode: number;
      }>((resolve) => {
        const failChild = (error: unknown) => {
          if (!terminalReason) {
            terminalReason = "child";
            childError = error instanceof Error ? error : new Error(String(error));
          }
          terminate();
        };
        const failStdin = (error: unknown) => {
          if (!terminalReason) {
            terminalReason = "stdin";
            stdinError = error instanceof Error ? error : new Error(String(error));
          }
          terminate();
        };
        child.on("error", failChild);
        child.stdin.on("error", failStdin);
        child.on("close", (code) => resolve({ exitCode: code ?? 1 }));
        try {
          if (input.stdin) {
            child.stdin.end(input.stdin);
          } else {
            child.stdin.end();
          }
        } catch (error) {
          failStdin(error);
        }
      });
      if (terminalReason === "abort" && abortError) throw abortError;
      if (terminalReason === "timeout" && timedOut) {
        throw new Error(`node_process_runner_timeout:${input.timeoutMs}`);
      }
      if (terminalReason === "child" && childError) throw childError;
      if (terminalReason === "outputSink" && outputSinkError) {
        throw outputSinkError;
      }
      const result = {
        exitCode: exit.exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Date.now() - startedAt,
      };
      const failureOutput = safeProcessFailureOutput(`${result.stdout}\n${result.stderr}`);
      if (
        terminalReason === "stdin" &&
        stdinError &&
        failureOutput === "empty_process_output"
      ) {
        throw stdinError;
      }
      if (exit.exitCode !== 0) {
        throw Object.assign(new Error(
          `node_process_runner_failed:${exit.exitCode}:${failureOutput}`,
        ), {
          exitCode: exit.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }
      if (terminalReason === "stdin" && stdinError) throw stdinError;
      return result;
    } finally {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.abortSignal.removeEventListener("abort", abort);
    }
  }
}
