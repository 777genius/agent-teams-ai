import { spawn } from "node:child_process";

export type ProcessRunnerInput = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
};

export type ProcessRunnerResult = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
};

export interface ProcessRunnerPort {
  run(input: ProcessRunnerInput): Promise<ProcessRunnerResult>;
}

export class NodeProcessRunner implements ProcessRunnerPort {
  run(input: ProcessRunnerInput): Promise<ProcessRunnerResult> {
    return new Promise((resolve) => {
      const child = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env: input.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      const timeout =
        input.timeoutMs !== undefined
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGTERM");
            }, input.timeoutMs)
          : null;

      child.stdout.on("data", (chunk) => {
        stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk) => {
        stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.on("error", (error) => {
        if (timeout) clearTimeout(timeout);
        resolve({
          exitCode: null,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: `${Buffer.concat(stderr).toString("utf8")}\n${error.message}`,
          timedOut,
        });
      });
      child.on("close", (exitCode) => {
        if (timeout) clearTimeout(timeout);
        resolve({
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          timedOut,
        });
      });
      child.stdin.end(input.stdin ?? "");
    });
  }
}
