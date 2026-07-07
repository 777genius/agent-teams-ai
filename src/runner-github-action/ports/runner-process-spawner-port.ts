export type RunnerProcessOutputName = "stdout" | "stderr";
export type RunnerProcessSignal = "SIGTERM" | "SIGKILL";

export type SpawnRunnerProcessInput = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
};

export interface SpawnedRunnerProcessPort {
  readonly exitCode: number | null;
  readonly signalCode: string | null;

  onOutput(
    streamName: RunnerProcessOutputName,
    listener: (chunk: Uint8Array | string) => void,
  ): void;
  onError(listener: (error: unknown) => void): void;
  onStdinError(listener: (error: unknown) => void): void;
  onClose(listener: (code: number | null) => void): void;
  endStdin(input?: Uint8Array): void;
  kill(signal: RunnerProcessSignal): void;
}

export interface RunnerProcessSpawnerPort {
  spawn(input: SpawnRunnerProcessInput): SpawnedRunnerProcessPort;
}
