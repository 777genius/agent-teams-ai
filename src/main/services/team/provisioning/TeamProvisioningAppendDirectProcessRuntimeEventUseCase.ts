import * as fs from 'fs';
import * as path from 'path';

import type {
  EffortLevel,
  ProviderBillingMode,
  TeamFastMode,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

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
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  billingMode?: ProviderBillingMode;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
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
    const event = {
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
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.providerBackendId ? { providerBackendId: input.providerBackendId } : {}),
      ...(input.billingMode ? { billingMode: input.billingMode } : {}),
      ...(input.model?.trim() ? { model: input.model.trim() } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.fastMode ? { fastMode: input.fastMode } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
    };
    const cliStarted =
      input.type === 'process_spawned' && input.providerId
        ? `${JSON.stringify({ ...event, type: 'cli_started', detail: undefined })}\n`
        : '';
    await ports.appendFileUtf8(
      input.eventsPath,
      `${cliStarted}${JSON.stringify(event)}\n`,
      { mode: 0o600 }
    );
  };
}
