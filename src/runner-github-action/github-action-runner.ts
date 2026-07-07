import type {
  OutputSink,
  ProcessResult,
  RedactorPort,
  RunnerPort,
} from "@vioxen/subscription-runtime/core";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { NodeRunnerProcessSpawner } from "./adapters/node-runner-process-spawner";
import { githubActionRunnerCapabilities } from "./capabilities";
import { runGitHubActionProcess } from "./application/run-github-action-process";
import {
  defaultKillGraceMs,
  defaultMaxCapturedOutputBytes,
} from "./domain/github-action-runner-policy";
import type { RunnerProcessSpawnerPort } from "./ports/runner-process-spawner-port";

export type GitHubActionRunnerOptions = {
  readonly redactor?: RedactorPort;
  readonly maxCapturedOutputBytes?: number;
  readonly killGraceMs?: number;
  readonly processSpawner?: RunnerProcessSpawnerPort;
};

export class GitHubActionRunner implements RunnerPort {
  readonly runnerId = githubActionRunnerCapabilities.runnerId;
  readonly capabilities = githubActionRunnerCapabilities;
  private readonly redactor: RedactorPort;
  private readonly maxCapturedOutputBytes: number;
  private readonly killGraceMs: number;
  private readonly processSpawner: RunnerProcessSpawnerPort;

  constructor(options: GitHubActionRunnerOptions = {}) {
    this.redactor = options.redactor ?? new DefaultRedactor();
    this.maxCapturedOutputBytes =
      options.maxCapturedOutputBytes ?? defaultMaxCapturedOutputBytes;
    this.killGraceMs = options.killGraceMs ?? defaultKillGraceMs;
    this.processSpawner =
      options.processSpawner ?? new NodeRunnerProcessSpawner();
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
    return runGitHubActionProcess({
      ...input,
      redactor: this.redactor,
      maxCapturedOutputBytes: this.maxCapturedOutputBytes,
      killGraceMs: this.killGraceMs,
      processSpawner: this.processSpawner,
    });
  }
}
