import { BoardTaskExactLogChunkBuilder } from '@main/services/team/taskLogs/exact/BoardTaskExactLogChunkBuilder';
import { BoardTaskExactLogStrictParser } from '@main/services/team/taskLogs/exact/BoardTaskExactLogStrictParser';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';

import {
  createEmptyMemberLogPreviewResponse,
  createEmptyMemberLogStreamResponse,
} from '../../contracts';
import { GetMemberLogPreviewsUseCase } from '../../core/application/use-cases/GetMemberLogPreviewsUseCase';
import { GetMemberLogStreamUseCase } from '../../core/application/use-cases/GetMemberLogStreamUseCase';
import { SetMemberLogStreamTrackingUseCase } from '../../core/application/use-cases/SetMemberLogStreamTrackingUseCase';
import { ClaudeMemberTranscriptPreviewSource } from '../adapters/output/sources/ClaudeMemberTranscriptPreviewSource';
import { ClaudeMemberTranscriptStreamSource } from '../adapters/output/sources/ClaudeMemberTranscriptStreamSource';
import { CodexNativeMemberTracePreviewSource } from '../adapters/output/sources/CodexNativeMemberTracePreviewSource';
import { CodexNativeMemberTraceStreamSource } from '../adapters/output/sources/CodexNativeMemberTraceStreamSource';
import { OpenCodeMemberRuntimePreviewSource } from '../adapters/output/sources/OpenCodeMemberRuntimePreviewSource';
import { OpenCodeMemberRuntimeStreamSource } from '../adapters/output/sources/OpenCodeMemberRuntimeStreamSource';
import { isMemberLogStreamReadEnabled } from '../featureGates';

import type { MemberLogPreviewResponse, MemberLogStreamResponse } from '../../contracts';
import type { LoggerPort } from '../../core/application/ports/LoggerPort';
import type { MemberLogStreamTrackingPort } from '../../core/application/ports/MemberLogStreamTrackingPort';
import type { GetMemberLogPreviewsInput } from '../../core/application/use-cases/GetMemberLogPreviewsUseCase';
import type { GetMemberLogStreamInput } from '../../core/application/use-cases/GetMemberLogStreamUseCase';
import type { ClaudeMultimodelBridgeService } from '@main/services/runtime/ClaudeMultimodelBridgeService';
import type { TeamLogSourceTracker } from '@main/services/team/TeamLogSourceTracker';
import type { TeamMemberLogsFinder } from '@main/services/team/TeamMemberLogsFinder';

export interface MemberLogStreamFeatureFacade {
  getMemberLogStream(input: GetMemberLogStreamInput): Promise<MemberLogStreamResponse>;
  getMemberLogPreviews(input: GetMemberLogPreviewsInput): Promise<MemberLogPreviewResponse>;
  setMemberLogStreamTracking(teamName: string, enabled: boolean): Promise<void>;
}

class TeamLogSourceTrackerMemberStreamPort implements MemberLogStreamTrackingPort {
  constructor(private readonly tracker: TeamLogSourceTracker) {}

  async setTracking(teamName: string, enabled: boolean): Promise<void> {
    if (enabled) {
      await this.tracker.enableTracking(teamName, 'member_log_stream');
      return;
    }
    await this.tracker.disableTracking(teamName, 'member_log_stream');
  }
}

export function createMemberLogStreamFeature(deps: {
  logsFinder: TeamMemberLogsFinder;
  logSourceTracker: TeamLogSourceTracker;
  runtimeBridge: ClaudeMultimodelBridgeService;
  configReader?: TeamConfigReader;
  logger: LoggerPort;
}): MemberLogStreamFeatureFacade {
  const chunkBuilder = new BoardTaskExactLogChunkBuilder();
  const strictParser = new BoardTaskExactLogStrictParser();
  const configReader = deps.configReader ?? new TeamConfigReader();
  const sources = [
    new ClaudeMemberTranscriptStreamSource(
      deps.logsFinder,
      strictParser,
      chunkBuilder,
      deps.logger
    ),
    new OpenCodeMemberRuntimeStreamSource(deps.runtimeBridge, chunkBuilder),
    new CodexNativeMemberTraceStreamSource(configReader),
  ];
  const previewSources = [
    new ClaudeMemberTranscriptPreviewSource(deps.logsFinder, strictParser, deps.logger),
    new OpenCodeMemberRuntimePreviewSource(deps.runtimeBridge),
    new CodexNativeMemberTracePreviewSource(configReader),
  ];
  const getUseCase = new GetMemberLogStreamUseCase({
    sources,
    clock: { now: () => Date.now() },
    logger: deps.logger,
  });
  const getPreviewsUseCase = new GetMemberLogPreviewsUseCase({
    sources: previewSources,
    clock: { now: () => Date.now() },
    logger: deps.logger,
  });
  const trackingUseCase = new SetMemberLogStreamTrackingUseCase(
    new TeamLogSourceTrackerMemberStreamPort(deps.logSourceTracker)
  );

  return {
    getMemberLogStream: async (input) => {
      if (!isMemberLogStreamReadEnabled()) {
        return createEmptyMemberLogStreamResponse();
      }
      return getUseCase.execute(input);
    },
    getMemberLogPreviews: async (input) => {
      if (!isMemberLogStreamReadEnabled()) {
        return createEmptyMemberLogPreviewResponse();
      }
      return getPreviewsUseCase.execute(input);
    },
    setMemberLogStreamTracking: (teamName, enabled) => trackingUseCase.execute(teamName, enabled),
  };
}
