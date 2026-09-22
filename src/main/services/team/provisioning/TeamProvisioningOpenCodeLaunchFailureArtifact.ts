import { createLogger } from '@shared/utils/logger';

import { writeTeamLaunchFailureArtifactPack } from '../TeamLaunchFailureArtifactPack';

import type { TeamLaunchFailureArtifactPackInput } from '../TeamLaunchFailureArtifactPack';

export type OpenCodeLaunchFailureArtifactInput = Omit<
  TeamLaunchFailureArtifactPackInput,
  'runtimeAdapterTraceLines'
>;

/** Application-owned output port for the OpenCode launch lifecycle. */
export interface OpenCodeLaunchFailureArtifactPort {
  write(input: OpenCodeLaunchFailureArtifactInput): Promise<void>;
}

export interface OpenCodeLaunchFailureArtifactAdapterOptions {
  getRuntimeAdapterTraceLines(runId: string): readonly string[] | undefined;
  writer?: {
    write(input: TeamLaunchFailureArtifactPackInput): Promise<unknown>;
  };
  warn?(message: string): void;
}

const logger = createLogger('Service:OpenCodeLaunchFailureArtifact');

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Focused adapter to the canonical artifact serializer/writer. It enriches the
 * application input with the retained runtime trace and makes writes
 * non-throwing so artifact I/O can never replace a launch outcome.
 */
export function createOpenCodeLaunchFailureArtifactAdapter(
  options: OpenCodeLaunchFailureArtifactAdapterOptions
): OpenCodeLaunchFailureArtifactPort {
  const writer = options.writer ?? { write: writeTeamLaunchFailureArtifactPack };
  return {
    async write(input): Promise<void> {
      try {
        await writer.write({
          ...input,
          runtimeAdapterTraceLines: options.getRuntimeAdapterTraceLines(input.runId),
        });
      } catch (error) {
        (options.warn ?? ((message: string) => logger.warn(message)))(
          `[${input.teamName}] Failed to write OpenCode launch failure artifact pack: ${getErrorMessage(
            error
          )}`
        );
      }
    },
  };
}
