import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { runGitHubActionProcess } from "../application/run-github-action-process";
import {
  assertSafeGitHubActionProcessInput,
  isForbiddenGitHubActionRunnerEnvKey,
  safeGitHubActionFailureOutput,
} from "../domain/github-action-runner-policy";
import type {
  RunnerProcessOutputName,
  RunnerProcessSignal,
  RunnerProcessSpawnerPort,
  SpawnedRunnerProcessPort,
  SpawnRunnerProcessInput,
} from "../ports/runner-process-spawner-port";

describe("GitHub Action runner boundaries", () => {
  it("keeps child process mechanics behind a port while preserving output policy", async () => {
    const redactor = new DefaultRedactor();
    redactor.registerSecret("super-secret", "unit");
    const process = new FakeSpawnedRunnerProcess();
    const processSpawner = new FakeRunnerProcessSpawner(process);
    const stdout: string[] = [];

    const run = runGitHubActionProcess({
      command: "tool",
      args: ["arg"],
      cwd: "/workspace",
      env: { PATH: "/bin" },
      stdin: Buffer.from("input"),
      timeoutMs: 30_000,
      stdout: { write: (chunk) => stdout.push(String(chunk)) },
      abortSignal: new AbortController().signal,
      redactor,
      maxCapturedOutputBytes: 256_000,
      killGraceMs: 5_000,
      processSpawner,
    });

    expect(processSpawner.spawnedInputs).toEqual([
      {
        command: "tool",
        args: ["arg"],
        cwd: "/workspace",
        env: { PATH: "/bin" },
      },
    ]);
    expect(process.stdinWrites).toHaveLength(1);

    process.emitOutput("stdout", "hello super-secret access_token=abc123");
    process.emitOutput("stderr", "warning");
    process.close(0);

    await expect(run).resolves.toMatchObject({
      exitCode: 0,
      stdout: "hello [redacted:unit] access_token=[redacted:token-field]",
      stderr: "warning",
    });
    expect(stdout.join("")).not.toContain("super-secret");
  });

  it("rejects unsafe runner input before invoking the process port", async () => {
    const processSpawner = new FakeRunnerProcessSpawner(
      new FakeSpawnedRunnerProcess(),
    );

    await expect(
      runGitHubActionProcess({
        command: "tool",
        args: [],
        cwd: "/workspace",
        env: { GITHUB_TOKEN: "must-not-pass" },
        timeoutMs: 30_000,
        abortSignal: new AbortController().signal,
        redactor: new DefaultRedactor(),
        maxCapturedOutputBytes: 256_000,
        killGraceMs: 5_000,
        processSpawner,
      }),
    ).rejects.toThrow("runner_forbidden_env:GITHUB_TOKEN");
    expect(processSpawner.spawnedInputs).toEqual([]);
  });

  it("keeps GitHub Actions env and failure-output policy in the domain", () => {
    expect(isForbiddenGitHubActionRunnerEnvKey("INPUT_AUTH_TOKEN")).toBe(true);
    expect(isForbiddenGitHubActionRunnerEnvKey("SAFE_INPUT")).toBe(false);
    expect(() =>
      assertSafeGitHubActionProcessInput({
        command: "tool",
        args: ["safe", "bad\0arg"],
        cwd: "/workspace",
        env: {},
        timeoutMs: 30_000,
      }),
    ).toThrow("runner_invalid_arg");
    expect(safeGitHubActionFailureOutput(" \n\t ")).toBe(
      "empty_process_output",
    );
    expect(safeGitHubActionFailureOutput("a\n b")).toBe("a b");
  });
});

class FakeRunnerProcessSpawner implements RunnerProcessSpawnerPort {
  readonly spawnedInputs: SpawnRunnerProcessInput[] = [];

  constructor(private readonly process: SpawnedRunnerProcessPort) {}

  spawn(input: SpawnRunnerProcessInput): SpawnedRunnerProcessPort {
    this.spawnedInputs.push(input);
    return this.process;
  }
}

class FakeSpawnedRunnerProcess implements SpawnedRunnerProcessPort {
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly killedSignals: RunnerProcessSignal[] = [];
  readonly stdinWrites: Array<Uint8Array | undefined> = [];
  private readonly outputListeners: Record<
    RunnerProcessOutputName,
    Array<(chunk: Uint8Array | string) => void>
  > = {
    stdout: [],
    stderr: [],
  };
  private readonly errorListeners: Array<(error: unknown) => void> = [];
  private readonly stdinErrorListeners: Array<(error: unknown) => void> = [];
  private readonly closeListeners: Array<(code: number | null) => void> = [];

  onOutput(
    streamName: RunnerProcessOutputName,
    listener: (chunk: Uint8Array | string) => void,
  ): void {
    this.outputListeners[streamName].push(listener);
  }

  onError(listener: (error: unknown) => void): void {
    this.errorListeners.push(listener);
  }

  onStdinError(listener: (error: unknown) => void): void {
    this.stdinErrorListeners.push(listener);
  }

  onClose(listener: (code: number | null) => void): void {
    this.closeListeners.push(listener);
  }

  endStdin(input?: Uint8Array): void {
    this.stdinWrites.push(input);
  }

  kill(signal: RunnerProcessSignal): void {
    this.killedSignals.push(signal);
  }

  emitOutput(streamName: RunnerProcessOutputName, chunk: string): void {
    for (const listener of this.outputListeners[streamName]) {
      listener(chunk);
    }
  }

  emitError(error: unknown): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }

  emitStdinError(error: unknown): void {
    for (const listener of this.stdinErrorListeners) {
      listener(error);
    }
  }

  close(code: number | null): void {
    this.exitCode = code;
    for (const listener of this.closeListeners) {
      listener(code);
    }
  }
}
