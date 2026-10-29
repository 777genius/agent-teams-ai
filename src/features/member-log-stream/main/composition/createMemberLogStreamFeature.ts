import { BoardTaskExactLogChunkBuilder } from '@main/services/team/taskLogs/exact/BoardTaskExactLogChunkBuilder';
import { BoardTaskExactLogStrictParser } from '@main/services/team/taskLogs/exact/BoardTaskExactLogStrictParser';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';

import {
  createEmptyMemberLogPreviewResponse,
  createEmptyMemberLogStreamResponse,
  createEmptyMemberRuntimeLogTailResponse,
} from '../../contracts';
import {
  GetMemberLogPreviewsUseCase,
  normalizeMemberLogPreviewRequests,
} from '../../core/application/use-cases/GetMemberLogPreviewsUseCase';
import { GetMemberLogStreamUseCase } from '../../core/application/use-cases/GetMemberLogStreamUseCase';
import { SetMemberLogStreamTrackingUseCase } from '../../core/application/use-cases/SetMemberLogStreamTrackingUseCase';
import { DEFAULT_MEMBER_LOG_PREVIEW_BUDGET } from '../../core/domain/models/MemberLogPreviewBudget';
import { inferMemberLogStreamSource } from '../../core/domain/policies/memberLogStreamMergePolicy';
import { ClaudeMemberTranscriptPreviewSource } from '../adapters/output/sources/ClaudeMemberTranscriptPreviewSource';
import { ClaudeMemberTranscriptStreamSource } from '../adapters/output/sources/ClaudeMemberTranscriptStreamSource';
import { CodexNativeMemberTracePreviewSource } from '../adapters/output/sources/CodexNativeMemberTracePreviewSource';
import { CodexNativeMemberTraceStreamSource } from '../adapters/output/sources/CodexNativeMemberTraceStreamSource';
import { OPENCODE_NATIVE_RUNTIME_LABEL } from '../adapters/output/sources/memberLogStreamSourceUtils';
import { OpenCodeMemberRuntimePreviewSource } from '../adapters/output/sources/OpenCodeMemberRuntimePreviewSource';
import { OpenCodeMemberRuntimeStreamSource } from '../adapters/output/sources/OpenCodeMemberRuntimeStreamSource';
import {
  OpenCodeMemberTranscriptBindingReader,
  unavailableOpenCodeTranscriptWarning,
} from '../adapters/output/sources/OpenCodeMemberTranscriptBindingReader';
import { MemberRuntimeLogTailReader } from '../application/MemberRuntimeLogTailReader';
import { isMemberLogStreamReadEnabled } from '../featureGates';

import type {
  MemberLogPreviewResponse,
  MemberLogStreamResponse,
  MemberRuntimeLogTailOptions,
  MemberRuntimeLogTailResponse,
} from '../../contracts';
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
  getMemberRuntimeLogTail(input: {
    teamName: string;
    memberName: string;
    options: MemberRuntimeLogTailOptions;
  }): Promise<MemberRuntimeLogTailResponse>;
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
  runtimeLogTailReader?: MemberRuntimeLogTailReader;
  logger: LoggerPort;
}): MemberLogStreamFeatureFacade {
  const chunkBuilder = new BoardTaskExactLogChunkBuilder();
  const strictParser = new BoardTaskExactLogStrictParser();
  const configReader = deps.configReader ?? new TeamConfigReader();
  const runtimeLogTailReader = deps.runtimeLogTailReader ?? new MemberRuntimeLogTailReader();
  const bindingReader = new OpenCodeMemberTranscriptBindingReader();
  const sources = [
    new ClaudeMemberTranscriptStreamSource(
      deps.logsFinder,
      strictParser,
      chunkBuilder,
      deps.logger
    ),
    new OpenCodeMemberRuntimeStreamSource(
      deps.runtimeBridge,
      chunkBuilder,
      undefined,
      undefined,
      bindingReader
    ),
    new CodexNativeMemberTraceStreamSource(configReader),
  ];
  const previewSources = [
    new ClaudeMemberTranscriptPreviewSource(deps.logsFinder, strictParser, deps.logger),
    new OpenCodeMemberRuntimePreviewSource(
      deps.runtimeBridge,
      undefined,
      undefined,
      undefined,
      bindingReader
    ),
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
      const binding = await bindingReader.read(input);
      const result = await getUseCase.execute({ ...input, sourceIdentity: binding.cacheKey });
      if (await bindingReader.isCurrent(input, binding)) return result;
      const segments = result.segments.filter(
        (segment) =>
          segment.source.provider !== 'opencode_runtime' ||
          segment.source.label !== OPENCODE_NATIVE_RUNTIME_LABEL
      );
      if (segments.length === result.segments.length) return result;
      const participantKeys = new Set(segments.map((segment) => segment.participantKey));
      const participants = result.participants.filter((participant) =>
        participantKeys.has(participant.key)
      );
      return {
        ...result,
        segments,
        participants,
        defaultFilter: participants.length === 1 ? participants[0].key : 'all',
        source: inferMemberLogStreamSource(segments),
        coverage: result.coverage.map((coverage) =>
          coverage.provider === 'opencode_runtime'
            ? { ...coverage, status: 'skipped' as const, reason: 'opencode_runtime_unavailable' }
            : coverage
        ),
        warnings: [...result.warnings, unavailableOpenCodeTranscriptWarning()],
      };
    },
    getMemberLogPreviews: async (input) => {
      if (!isMemberLogStreamReadEnabled()) {
        return createEmptyMemberLogPreviewResponse();
      }
      const admissions = await Promise.all(
        normalizeMemberLogPreviewRequests(
          input.memberNames,
          input.laneIdsByMember,
          DEFAULT_MEMBER_LOG_PREVIEW_BUDGET.maxMembers
        ).map(async (member) => {
          const request = { teamName: input.teamName, ...member };
          return { request, binding: await bindingReader.read(request) };
        })
      );
      const result = await getPreviewsUseCase.execute({
        ...input,
        sourceIdentity: JSON.stringify(
          admissions.map(({ request, binding }) => [request.memberName, binding.cacheKey])
        ),
      });
      const members = await Promise.all(
        result.members.map(async (member) => {
          const admission = admissions.find(
            (entry) => entry.request.memberName === member.memberName
          );
          if (!admission || (await bindingReader.isCurrent(admission.request, admission.binding)))
            return member;
          return getPreviewsUseCase.mapMemberSources(member, (source) => {
            if (source.coverage.provider !== 'opencode_runtime') return source;
            const warnings = [...source.warnings, unavailableOpenCodeTranscriptWarning()];
            if (!source.items.some((item) => item.sourceLabel === OPENCODE_NATIVE_RUNTIME_LABEL))
              return { ...source, warnings };
            return {
              ...source,
              items: [],
              coverage: {
                provider: 'opencode_runtime',
                status: 'skipped',
                reason: 'opencode_runtime_unavailable',
              },
              truncated: false,
              overflowCount: 0,
              warnings,
            };
          });
        })
      );
      return { ...result, members };
    },
    getMemberRuntimeLogTail: async (input) => {
      if (!isMemberLogStreamReadEnabled()) {
        return createEmptyMemberRuntimeLogTailResponse(input.options.kind);
      }
      return runtimeLogTailReader.getTail({
        teamName: input.teamName,
        memberName: input.memberName,
        kind: input.options.kind,
        maxBytes: input.options.maxBytes,
      });
    },
    setMemberLogStreamTracking: (teamName, enabled) => trackingUseCase.execute(teamName, enabled),
  };
}
