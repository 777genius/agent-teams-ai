import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { mapOpenCodeRuntimeTranscriptMessagesToParsedMessages } from '@main/services/team/taskLogs/stream/OpenCodeRuntimeProjectionMapper';

import { applyMemberLogMessageBudget } from '../../../infrastructure/memberLogMessageBudget';

import {
  buildMemberActor,
  buildMemberParticipant,
  buildSegmentId,
  normalizeMemberName,
  withSegmentSource,
} from './memberLogStreamSourceUtils';

import type { MemberLogStreamWarning } from '../../../../contracts';
import type {
  MemberLogStreamSource,
  MemberLogStreamSourceInput,
  MemberLogStreamSourceResult,
} from '../../../../core/application/ports/MemberLogStreamSource';
import type { ClaudeMultimodelBridgeService } from '@main/services/runtime/ClaudeMultimodelBridgeService';
import type { BoardTaskExactLogChunkBuilder } from '@main/services/team/taskLogs/exact/BoardTaskExactLogChunkBuilder';

interface BinaryResolverLike {
  resolve(): Promise<string | null>;
}

const CACHE_TTL_MS = 1_500;

function classifyOpenCodeError(error: unknown): MemberLogStreamWarning {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return {
      code: 'opencode_runtime_timeout',
      message: 'OpenCode runtime transcript timed out; showing other member logs only.',
    };
  }
  if (
    normalized.includes('--lane') ||
    normalized.includes('multiple') ||
    normalized.includes('ambiguous')
  ) {
    return {
      code: 'opencode_ambiguous_lane',
      message: 'OpenCode runtime session is ambiguous without a safe lane id.',
    };
  }
  return {
    code: 'opencode_runtime_unavailable',
    message: `OpenCode runtime transcript is unavailable: ${message}`,
  };
}

export class OpenCodeMemberRuntimeStreamSource implements MemberLogStreamSource {
  readonly provider = 'opencode_runtime' as const;
  private readonly cache = new Map<
    string,
    { expiresAt: number; result: MemberLogStreamSourceResult }
  >();
  private readonly inFlight = new Map<string, Promise<MemberLogStreamSourceResult>>();

  constructor(
    private readonly runtimeBridge: ClaudeMultimodelBridgeService,
    private readonly chunkBuilder: BoardTaskExactLogChunkBuilder,
    private readonly binaryResolver: BinaryResolverLike = ClaudeBinaryResolver
  ) {}

  async load(input: MemberLogStreamSourceInput): Promise<MemberLogStreamSourceResult> {
    const cacheKey = [
      input.teamName,
      normalizeMemberName(input.memberName),
      input.laneId ?? '',
      input.budget.openCodeMessageLimit,
    ].join('::');

    if (!input.forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.result;
      }
    }

    const existing = this.inFlight.get(cacheKey);
    if (existing) {
      return existing;
    }

    const promise = this.buildResult(input)
      .then((result) => {
        this.cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, result });
        return result;
      })
      .finally(() => {
        this.inFlight.delete(cacheKey);
      });
    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  private async buildResult(
    input: MemberLogStreamSourceInput
  ): Promise<MemberLogStreamSourceResult> {
    const binaryPath = await this.binaryResolver.resolve();
    if (!binaryPath) {
      return this.skipped(
        'opencode_runtime_unavailable',
        'OpenCode runtime bridge is unavailable.'
      );
    }

    try {
      const transcript = await this.runtimeBridge.getOpenCodeTranscript(binaryPath, {
        teamId: input.teamName,
        memberName: input.memberName,
        limit: input.budget.openCodeMessageLimit,
        laneId: input.laneId,
        timeoutMs: input.budget.openCodeTimeoutMs,
      });
      const projectedMessages = transcript?.logProjection?.messages ?? [];
      const parsedMessages = mapOpenCodeRuntimeTranscriptMessagesToParsedMessages(
        projectedMessages
      ).sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
      if (parsedMessages.length === 0) {
        return {
          provider: this.provider,
          status: 'skipped',
          reason: 'opencode_missing_runtime_session',
          participants: [],
          segments: [],
          warnings: [],
        };
      }

      const budgeted = applyMemberLogMessageBudget(parsedMessages, input.budget);
      if (budgeted.messages.length === 0) {
        return {
          provider: this.provider,
          status: 'skipped',
          reason: 'opencode_no_renderable_chunks',
          participants: [],
          segments: [],
          warnings: [],
        };
      }

      const chunks = this.chunkBuilder.buildBundleChunks(budgeted.messages);
      if (chunks.length === 0) {
        return {
          provider: this.provider,
          status: 'skipped',
          reason: 'opencode_no_renderable_chunks',
          participants: [],
          segments: [],
          warnings: [],
        };
      }

      const first = budgeted.messages[0];
      const last = budgeted.messages[budgeted.messages.length - 1];
      if (!first || !last) {
        return this.skipped(
          'opencode_missing_runtime_session',
          'OpenCode runtime projection was empty.'
        );
      }

      const participant = buildMemberParticipant(input.memberName);
      const sessionId =
        transcript?.sessionId ??
        first.sessionId ??
        `opencode:${normalizeMemberName(input.memberName)}`;
      const segment = withSegmentSource(
        {
          id: buildSegmentId({
            provider: this.provider,
            teamName: input.teamName,
            memberName: input.memberName,
            sessionId,
            fingerprint: `${sessionId}:${input.laneId ?? ''}:${budgeted.messages.length}`,
            startTimestamp: first.timestamp.toISOString(),
          }),
          participantKey: participant.key,
          actor: buildMemberActor({
            memberName: input.memberName,
            sessionId,
            role: 'member',
          }),
          startTimestamp: first.timestamp.toISOString(),
          endTimestamp: last.timestamp.toISOString(),
          chunks,
        },
        {
          provider: this.provider,
          label: 'OpenCode runtime',
          sessionId,
          ...(input.laneId ? { laneId: input.laneId } : {}),
          messageCount: budgeted.messages.length,
          truncated:
            budgeted.droppedMessageCount > 0 ||
            budgeted.segmentWindowLimited ||
            budgeted.contentLimited,
        }
      );

      const warnings: MemberLogStreamWarning[] = [];
      if (budgeted.segmentWindowLimited) {
        warnings.push({
          code: 'segment_message_window_limited',
          message: 'OpenCode runtime stream was trimmed to recent messages.',
        });
      }
      if (budgeted.contentLimited) {
        warnings.push({
          code: 'message_content_limited',
          message: 'Some large OpenCode runtime content was truncated before rendering.',
        });
      }

      return {
        provider: this.provider,
        status: 'included',
        participants: [participant],
        segments: [segment],
        warnings,
        metadata: {
          droppedMessageCount: budgeted.droppedMessageCount,
        },
      };
    } catch (error) {
      const warning = classifyOpenCodeError(error);
      return this.skipped(warning.code, warning.message, warning);
    }
  }

  private skipped(
    code: MemberLogStreamWarning['code'],
    reason: string,
    warning: MemberLogStreamWarning = { code, message: reason }
  ): MemberLogStreamSourceResult {
    return {
      provider: this.provider,
      status: 'skipped',
      reason,
      participants: [],
      segments: [],
      warnings: [warning],
    };
  }
}
