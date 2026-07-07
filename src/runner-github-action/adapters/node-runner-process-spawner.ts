import { spawn as spawnChildProcess } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type {
  RunnerProcessOutputName,
  RunnerProcessSignal,
  RunnerProcessSpawnerPort,
  SpawnedRunnerProcessPort,
  SpawnRunnerProcessInput,
} from "../ports/runner-process-spawner-port";

export class NodeRunnerProcessSpawner implements RunnerProcessSpawnerPort {
  spawn(input: SpawnRunnerProcessInput): SpawnedRunnerProcessPort {
    return new NodeSpawnedRunnerProcess(
      spawnChildProcess(input.command, input.args, {
        cwd: input.cwd,
        env: input.env,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  }
}

class NodeSpawnedRunnerProcess implements SpawnedRunnerProcessPort {
  constructor(
    private readonly child: ChildProcessByStdio<Writable, Readable, Readable>,
  ) {}

  get exitCode(): number | null {
    return this.child.exitCode;
  }

  get signalCode(): string | null {
    return this.child.signalCode;
  }

  onOutput(
    streamName: RunnerProcessOutputName,
    listener: (chunk: Uint8Array | string) => void,
  ): void {
    this.child[streamName].on("data", listener);
  }

  onError(listener: (error: unknown) => void): void {
    this.child.on("error", listener);
  }

  onStdinError(listener: (error: unknown) => void): void {
    this.child.stdin.on("error", listener);
  }

  onClose(listener: (code: number | null) => void): void {
    this.child.on("close", (code) => listener(code));
  }

  endStdin(input?: Uint8Array): void {
    this.child.stdin.end(input ? Buffer.from(input) : undefined);
  }

  kill(signal: RunnerProcessSignal): void {
    this.child.kill(signal);
  }
}
