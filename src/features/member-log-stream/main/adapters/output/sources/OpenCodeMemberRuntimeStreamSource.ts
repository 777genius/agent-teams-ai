import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { mapOpenCodeRuntimeTranscriptMessagesToParsedMessages } from '@main/services/team/taskLogs/stream/OpenCodeRuntimeProjectionMapper';

import { applyMemberLogMessageBudget } from '../../../infrastructure/memberLogMessageBudget';

import {
  buildMemberActor,
  buildMemberParticipant,
  buildSegmentId,
  classifyOpenCodeTranscriptError,
  normalizeMemberName,
  OPENCODE_NATIVE_RUNTIME_LABEL,
  withSegmentSource,
} from './memberLogStreamSourceUtils';
import {
  OpenCodeMemberTranscriptBindingReader,
  unavailableOpenCodeTranscriptWarning,
} from './OpenCodeMemberTranscriptBindingReader';
import {
  type OpenCodeMemberVisibleActivityEntry,
  OpenCodeMemberVisibleActivityReader,
} from './OpenCodeMemberVisibleActivityReader';

import type { MemberLogStreamWarning } from '../../../../contracts';
import type {
  MemberLogStreamSource,
  MemberLogStreamSourceInput,
  MemberLogStreamSourceResult,
} from '../../../../core/application/ports/MemberLogStreamSource';
import type {
  OpenCodeMemberTranscriptBinding,
  OpenCodeTranscriptBindingReader,
} from './OpenCodeMemberTranscriptBindingReader';
import type { ClaudeMultimodelBridgeService } from '@main/services/runtime/ClaudeMultimodelBridgeService';
import type { BoardTaskExactLogChunkBuilder } from '@main/services/team/taskLogs/exact/BoardTaskExactLogChunkBuilder';
import type { ParsedMessage } from '@main/types';

interface BinaryResolverLike {
  resolve(): Promise<string | null>;
}

const CACHE_TTL_MS = 1_500;
const DEFAULT_VISIBLE_ACTIVITY_READER = new OpenCodeMemberVisibleActivityReader();

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
    private readonly binaryResolver: BinaryResolverLike = ClaudeBinaryResolver,
    private readonly visibleActivityReader: OpenCodeMemberVisibleActivityReader = DEFAULT_VISIBLE_ACTIVITY_READER,
    private readonly bindingReader: OpenCodeTranscriptBindingReader = new OpenCodeMemberTranscriptBindingReader()
  ) {}

  async load(input: MemberLogStreamSourceInput): Promise<MemberLogStreamSourceResult> {
    const binding = await this.bindingReader.read(input);
    if (binding.kind === 'unavailable') {
      const warning = unavailableOpenCodeTranscriptWarning(binding);
      return this.loadVisibleActivityFallback(input, [warning], warning.message);
    }
    const currentResult = async (result: MemberLogStreamSourceResult) =>
      (await this.bindingReader.isCurrent(input, binding))
        ? result
        : this.loadVisibleActivityFallback(
            input,
            [unavailableOpenCodeTranscriptWarning()],
            'opencode_runtime_unavailable'
          );
    const cacheKey = [
      binding.cacheKey,
      input.teamName,
      normalizeMemberName(input.memberName),
      input.laneId ?? '',
      input.budget.openCodeMessageLimit,
    ].join('::');

    if (!input.forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return currentResult(cached.result);
      }
    }

    const existing = this.inFlight.get(cacheKey);
    if (existing) {
      return currentResult(await existing);
    }

    const promise = this.buildResult(input, binding)
      .then((result) => {
        this.cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, result });
        return result;
      })
      .finally(() => {
        this.inFlight.delete(cacheKey);
      });
    this.inFlight.set(cacheKey, promise);
    return currentResult(await promise);
  }

  private async buildResult(
    input: MemberLogStreamSourceInput,
    binding: Extract<OpenCodeMemberTranscriptBinding, { kind: 'bound' }>
  ): Promise<MemberLogStreamSourceResult> {
    const binaryPath = await this.binaryResolver.resolve();
    if (!binaryPath) {
      return this.loadVisibleActivityFallback(
        input,
        [
          {
            code: 'opencode_runtime_unavailable',
            message: 'OpenCode runtime bridge is unavailable.',
          },
        ],
        'OpenCode runtime bridge is unavailable.'
      );
    }

    try {
      const transcript = await this.runtimeBridge.getOpenCodeTranscript(binaryPath, {
        teamId: input.teamName,
        memberName: input.memberName,
        limit: input.budget.openCodeMessageLimit,
        laneId: binding.laneId,
        runId: binding.runId,
        sessionId: binding.sessionId,
        timeoutMs: input.budget.openCodeTimeoutMs,
      });
      const projectedMessages = transcript?.logProjection?.messages ?? [];
      const parsedMessages = mapOpenCodeRuntimeTranscriptMessagesToParsedMessages(
        projectedMessages
      ).sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
      if (parsedMessages.length === 0) {
        return this.loadVisibleActivityFallback(input, [], 'opencode_missing_runtime_session');
      }

      const budgeted = applyMemberLogMessageBudget(parsedMessages, input.budget);
      if (budgeted.messages.length === 0) {
        return this.loadVisibleActivityFallback(input, [], 'opencode_no_renderable_chunks');
      }

      const chunks = this.chunkBuilder.buildBundleChunks(budgeted.messages);
      if (chunks.length === 0) {
        return this.loadVisibleActivityFallback(input, [], 'opencode_no_renderable_chunks');
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
          label: OPENCODE_NATIVE_RUNTIME_LABEL,
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
      const warning = classifyOpenCodeTranscriptError(error);
      return this.loadVisibleActivityFallback(input, [warning], warning.message);
    }
  }

  private async loadVisibleActivityFallback(
    input: MemberLogStreamSourceInput,
    warnings: readonly MemberLogStreamWarning[],
    skippedReason: string
  ): Promise<MemberLogStreamSourceResult> {
    try {
      const entries = await this.visibleActivityReader.list({
        teamName: input.teamName,
        memberName: input.memberName,
        forceRefresh: input.forceRefresh,
      });
      if (entries.length === 0) {
        return this.skippedFromWarnings(skippedReason, warnings);
      }

      const messages = entries
        .map((entry) => toVisibleActivityParsedMessage(entry, input.memberName))
        .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
      const budgeted = applyMemberLogMessageBudget(messages, input.budget);
      if (budgeted.messages.length === 0) {
        return this.skippedFromWarnings(skippedReason, warnings);
      }

      const chunks = this.chunkBuilder.buildBundleChunks(budgeted.messages);
      if (chunks.length === 0) {
        return this.skippedFromWarnings(skippedReason, warnings);
      }

      const first = budgeted.messages[0];
      const last = budgeted.messages[budgeted.messages.length - 1];
      if (!first || !last) {
        return this.skippedFromWarnings(skippedReason, warnings);
      }

      const participant = buildMemberParticipant(input.memberName);
      const sessionId = `opencode-visible:${normalizeMemberName(input.memberName)}`;
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
          label: 'OpenCode visible activity',
          sessionId,
          ...(input.laneId ? { laneId: input.laneId } : {}),
          messageCount: budgeted.messages.length,
          truncated:
            budgeted.droppedMessageCount > 0 ||
            budgeted.segmentWindowLimited ||
            budgeted.contentLimited,
        }
      );

      const resultWarnings = [...warnings];
      if (budgeted.segmentWindowLimited) {
        resultWarnings.push({
          code: 'segment_message_window_limited',
          message: 'OpenCode visible activity was trimmed to recent messages.',
        });
      }
      if (budgeted.contentLimited) {
        resultWarnings.push({
          code: 'message_content_limited',
          message: 'Some large OpenCode visible activity content was truncated before rendering.',
        });
      }

      return {
        provider: this.provider,
        status: 'included',
        participants: [participant],
        segments: [segment],
        warnings: resultWarnings,
        metadata: {
          droppedMessageCount: budgeted.droppedMessageCount,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.skippedFromWarnings(skippedReason, [
        ...warnings,
        {
          code: 'opencode_runtime_unavailable',
          message: `OpenCode visible activity fallback is unavailable: ${message}`,
        },
      ]);
    }
  }

  private skippedFromWarnings(
    reason: string,
    warnings: readonly MemberLogStreamWarning[]
  ): MemberLogStreamSourceResult {
    if (warnings.length === 0) {
      return {
        provider: this.provider,
        status: 'skipped',
        reason,
        participants: [],
        segments: [],
        warnings: [],
      };
    }
    const firstWarning = warnings[0];
    return this.skipped(
      firstWarning?.code ?? 'opencode_runtime_unavailable',
      reason,
      firstWarning,
      [...warnings.slice(1)]
    );
  }

  private skipped(
    code: MemberLogStreamWarning['code'],
    reason: string,
    warning: MemberLogStreamWarning = { code, message: reason },
    extraWarnings: readonly MemberLogStreamWarning[] = []
  ): MemberLogStreamSourceResult {
    return {
      provider: this.provider,
      status: 'skipped',
      reason,
      participants: [],
      segments: [],
      warnings: [warning, ...extraWarnings],
    };
  }
}

function toVisibleActivityParsedMessage(
  entry: OpenCodeMemberVisibleActivityEntry,
  memberName: string
): ParsedMessage {
  return {
    uuid: entry.id,
    parentUuid: null,
    type: 'assistant',
    timestamp: new Date(entry.timestamp),
    role: 'assistant',
    content: `${entry.title}: ${entry.text}`,
    isSidechain: true,
    isMeta: false,
    sessionId: `opencode-visible:${normalizeMemberName(memberName)}`,
    agentName: memberName,
    toolCalls: [],
    toolResults: [],
  };
}
