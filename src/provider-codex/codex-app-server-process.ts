import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";

export type CodexAppServerProcessFactory = (input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}) => CodexAppServerChildProcess;

export type CodexAppServerChildProcess = {
  readonly pid?: number | undefined;
  readonly stdin: {
    write(chunk: string | Uint8Array): boolean;
    end(): void;
    on?(event: "error", listener: (error: Error) => void): unknown;
  };
  readonly stdout: {
    on(event: "data", listener: (chunk: unknown) => void): unknown;
    setEncoding(encoding: BufferEncoding): unknown;
  };
  readonly stderr: {
    on(event: "data", listener: (chunk: unknown) => void): unknown;
    setEncoding(encoding: BufferEncoding): unknown;
  };
  on(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};

export function spawnCodexAppServerProcess(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}): CodexAppServerChildProcess {
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  }) as ChildProcessWithoutNullStreams;
  return child;
}

export function signalCodexAppServerChildGroup(
  child: CodexAppServerChildProcess,
  signal: NodeJS.Signals,
): void {
  try {
    if (process.platform === "win32" || !child.pid) {
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process may already be gone.
    }
  }
}
