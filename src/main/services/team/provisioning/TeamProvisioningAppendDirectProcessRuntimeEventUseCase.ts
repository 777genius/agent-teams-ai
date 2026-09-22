import * as fs from 'fs';
import * as path from 'path';

export interface AppendDirectProcessRuntimeEventUseCasePorts {
  mkdirRecursive(directoryPath: string): Promise<void>;
  appendFileUtf8(filePath: string, contents: string, options: { mode: number }): Promise<void>;
  nowIso(): string;
}

export interface DirectProcessRuntimeEventInput {
  type: string;
  eventsPath: string;
  pid: number;
  teamName: string;
  agentName: string;
  agentId: string;
  runId: string;
  bootstrapRunId: string;
  source: string;
  detail?: string;
}

export type AppendDirectProcessRuntimeEventUseCase = (
  input: DirectProcessRuntimeEventInput
) => Promise<void>;

export function createNodeAppendDirectProcessRuntimeEventUseCasePorts(
  input: { nowIso?: () => string } = {}
): AppendDirectProcessRuntimeEventUseCasePorts {
  return {
    mkdirRecursive: async (directoryPath) => {
      await fs.promises.mkdir(directoryPath, { recursive: true });
    },
    appendFileUtf8: (filePath, contents, options) =>
      fs.promises.appendFile(filePath, contents, { encoding: 'utf8', mode: options.mode }),
    nowIso: input.nowIso ?? (() => new Date().toISOString()),
  };
}

export function createAppendDirectProcessRuntimeEventUseCase(
  ports: AppendDirectProcessRuntimeEventUseCasePorts = createNodeAppendDirectProcessRuntimeEventUseCasePorts()
): AppendDirectProcessRuntimeEventUseCase {
  return async (input: DirectProcessRuntimeEventInput): Promise<void> => {
    await ports.mkdirRecursive(path.dirname(input.eventsPath));
    await ports.appendFileUtf8(
      input.eventsPath,
      `${JSON.stringify({
        version: 1,
        type: input.type,
        timestamp: ports.nowIso(),
        pid: input.pid,
        teamName: input.teamName,
        agentName: input.agentName,
        agentId: input.agentId,
        runId: input.runId,
        bootstrapRunId: input.bootstrapRunId,
        source: input.source,
        ...(input.detail ? { detail: input.detail } : {}),
      })}\n`,
      { mode: 0o600 }
    );
  };
}
