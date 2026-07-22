import { spawn } from "node:child_process";

import type {
  CheckWorkspaceCommandResult,
} from "./project-integration-check-workspace-transaction";

export async function runIsolatedCheckProcess(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly maxBuffer: number;
  readonly terminationGraceMs?: number;
}): Promise<CheckWorkspaceCommandResult> {
  if (process.platform === "win32") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "check_process_group_unsupported_platform",
      timedOut: false,
      processTreeStopped: false,
    };
  }

  return await new Promise((resolve) => {
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      detached: true,
      env: input.env === undefined ? process.env : dropUndefinedEnv(input.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let exitCode = 1;
    let timedOut = false;
    let outputOverflow = false;
    let spawnError = "";
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let processGroupShutdown: Promise<boolean> | undefined;
    let finalized = false;

    const capture = (target: Buffer[], chunk: Buffer): void => {
      if (capturedBytes >= input.maxBuffer) {
        outputOverflow = true;
        requestShutdown();
        return;
      }
      const remaining = input.maxBuffer - capturedBytes;
      target.push(chunk.subarray(0, remaining));
      capturedBytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) {
        outputOverflow = true;
        requestShutdown();
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));

    const timeout = setTimeout(() => {
      timedOut = true;
      requestShutdown();
    }, input.timeoutMs);
    timeout.unref();

    child.once("error", (error) => {
      spawnError = error.message;
      requestShutdown();
    });
    child.once("exit", (code) => {
      exitCode = code ?? 1;
      requestShutdown();
    });
    child.once("close", () => {
      clearTimeout(timeout);
      void finalize();
    });

    function shutdownProcessGroup(): Promise<boolean> {
      processGroupShutdown ??= terminateProcessGroup(
        child.pid,
        input.terminationGraceMs ?? 250,
      ).catch(() => false);
      return processGroupShutdown;
    }

    function requestShutdown(): void {
      void shutdownProcessGroup().then((stopped) => {
        if (!stopped) void finalize();
      });
    }

    async function finalize(): Promise<void> {
      if (finalized) return;
      finalized = true;
      const processTreeStopped = await shutdownProcessGroup();
      const safeStderr = [
        Buffer.concat(stderr).toString("utf8"),
        spawnError,
        outputOverflow ? "check_output_limit_exceeded" : "",
        processTreeStopped ? "" : "check_process_group_termination_failed",
      ].filter(Boolean).join("\n");
      resolve({
        exitCode: processTreeStopped && !outputOverflow ? exitCode : 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: safeStderr,
        timedOut,
        processTreeStopped,
      });
    }
  });
}

async function terminateProcessGroup(
  pid: number | undefined,
  graceMs: number,
): Promise<boolean> {
  if (pid === undefined) return true;
  signalProcessGroup(pid, "SIGTERM");
  if (await waitForProcessGroupExit(pid, graceMs)) return true;
  signalProcessGroup(pid, "SIGKILL");
  return await waitForProcessGroupExit(pid, Math.max(graceMs, 1_000));
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!processGroupExists(pid)) return true;
    await delay(10);
  }
  return !processGroupExists(pid);
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function dropUndefinedEnv(
  env: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
