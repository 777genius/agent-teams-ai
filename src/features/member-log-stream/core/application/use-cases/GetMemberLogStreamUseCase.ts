import { createEmptyMemberLogStreamResponse } from '../../../contracts';
import {
  clampMemberLogStreamSegmentLimit,
  DEFAULT_MEMBER_LOG_STREAM_BUDGET,
} from '../../domain/models/MemberLogStreamBudget';
import { buildMemberLogStreamResponse } from '../../domain/policies/memberLogStreamMergePolicy';

import type { MemberLogStreamResponse } from '../../../contracts';
import type { MemberLogStreamBudget } from '../../domain/models/MemberLogStreamBudget';
import type { ClockPort } from '../ports/ClockPort';
import type { LoggerPort } from '../ports/LoggerPort';
import type {
  MemberLogStreamSource,
  MemberLogStreamSourceResult,
} from '../ports/MemberLogStreamSource';

export interface GetMemberLogStreamInput {
  teamName: string;
  memberName: string;
  limitSegments?: number;
  sinceMs?: number | null;
  laneId?: string;
  forceRefresh?: boolean;
}

interface GetMemberLogStreamUseCaseDeps {
  sources: readonly MemberLogStreamSource[];
  clock: ClockPort;
  logger: LoggerPort;
  budget?: Partial<MemberLogStreamBudget>;
}

function stableInputKey(input: GetMemberLogStreamInput, limitSegments: number): string {
  return JSON.stringify([
    input.teamName,
    input.memberName,
    limitSegments,
    input.sinceMs ?? null,
    input.laneId ?? '',
    input.forceRefresh === true,
  ]);
}

export class GetMemberLogStreamUseCase {
  private readonly budget: MemberLogStreamBudget;
  private readonly inFlight = new Map<string, Promise<MemberLogStreamResponse>>();

  constructor(private readonly deps: GetMemberLogStreamUseCaseDeps) {
    this.budget = { ...DEFAULT_MEMBER_LOG_STREAM_BUDGET, ...(deps.budget ?? {}) };
  }

  async execute(input: GetMemberLogStreamInput): Promise<MemberLogStreamResponse> {
    const limitSegments = clampMemberLogStreamSegmentLimit(input.limitSegments, this.budget);
    const key = stableInputKey(input, limitSegments);
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const promise = this.buildResponse(input, limitSegments).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async buildResponse(
    input: GetMemberLogStreamInput,
    limitSegments: number
  ): Promise<MemberLogStreamResponse> {
    if (this.deps.sources.length === 0) {
      return createEmptyMemberLogStreamResponse(new Date(this.deps.clock.now()).toISOString());
    }

    const sourceInput = {
      teamName: input.teamName,
      memberName: input.memberName,
      laneId: input.laneId,
      budget: this.budget,
      sinceMs: input.sinceMs,
      forceRefresh: input.forceRefresh,
    };

    const settled = await Promise.all(
      this.deps.sources.map(async (source): Promise<MemberLogStreamSourceResult> => {
        try {
          return await source.load(sourceInput);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.deps.logger.warn(
            `Member log stream source ${source.provider} failed for ${input.teamName}/${input.memberName}: ${message}`
          );
          return {
            provider: source.provider,
            status: 'skipped',
            reason: message,
            participants: [],
            segments: [],
            warnings: [
              {
                code:
                  source.provider === 'opencode_runtime'
                    ? 'opencode_runtime_unavailable'
                    : 'unreadable_transcript_file',
                message,
              },
            ],
          };
        }
      })
    );

    const metadata = {
      scannedTranscriptFileCount: 0,
      includedTranscriptFileCount: 0,
      droppedSegmentCount: 0,
      droppedChunkCount: 0,
      droppedMessageCount: 0,
    };

    for (const result of settled) {
      metadata.scannedTranscriptFileCount += result.metadata?.scannedTranscriptFileCount ?? 0;
      metadata.includedTranscriptFileCount += result.metadata?.includedTranscriptFileCount ?? 0;
      metadata.droppedSegmentCount += result.metadata?.droppedSegmentCount ?? 0;
      metadata.droppedChunkCount += result.metadata?.droppedChunkCount ?? 0;
      metadata.droppedMessageCount += result.metadata?.droppedMessageCount ?? 0;
    }

    return buildMemberLogStreamResponse({
      participants: settled.flatMap((result) => result.participants),
      segments: settled.flatMap((result) => result.segments),
      coverage: settled.map((result) => ({
        provider: result.provider,
        status: result.status,
        ...(result.reason ? { reason: result.reason } : {}),
      })),
      warnings: settled.flatMap((result) => result.warnings),
      generatedAt: new Date(this.deps.clock.now()).toISOString(),
      budget: this.budget,
      limitSegments,
      metadata,
    });
  }
}
