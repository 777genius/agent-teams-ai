import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SafeExecutionCommandRunner } from "@vioxen/subscription-runtime/worker-core";

const execFileAsync = promisify(execFile);

export class NodeSafeExecutionCommandRunner implements SafeExecutionCommandRunner {
  async run(input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly timeoutMs?: number;
    readonly maxBufferBytes?: number;
    readonly abortSignal?: AbortSignal;
  }): Promise<{
    readonly stdout: string;
    readonly stderr: string;
  }> {
    const result = await execFileAsync(input.command, [...input.args], {
      cwd: input.cwd,
      ...(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }),
      ...(input.maxBufferBytes === undefined
        ? {}
        : { maxBuffer: input.maxBufferBytes }),
      ...(input.abortSignal === undefined ? {} : { signal: input.abortSignal }),
    });
    return {
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  }
}
