import { applyMemberLogMessageBudget } from '../../../infrastructure/memberLogMessageBudget';

import {
  buildMemberActor,
  buildMemberParticipant,
  buildSegmentId,
  dedupeMemberLogRefs,
  shortHash,
  withSegmentSource,
} from './memberLogStreamSourceUtils';

import type { MemberLogStreamWarning } from '../../../../contracts';
import type { LoggerPort } from '../../../../core/application/ports/LoggerPort';
import type {
  MemberLogStreamSource,
  MemberLogStreamSourceInput,
  MemberLogStreamSourceResult,
} from '../../../../core/application/ports/MemberLogStreamSource';
import type { BoardTaskExactLogChunkBuilder } from '@main/services/team/taskLogs/exact/BoardTaskExactLogChunkBuilder';
import type { BoardTaskExactLogStrictParser } from '@main/services/team/taskLogs/exact/BoardTaskExactLogStrictParser';
import type { TeamMemberLogsFinder } from '@main/services/team/TeamMemberLogsFinder';
import type { ParsedMessage } from '@main/types';

function filterSourceMessageBudget(
  messages: readonly ParsedMessage[],
  remaining: number
): { messages: ParsedMessage[]; dropped: number; limited: boolean } {
  if (remaining <= 0) {
    return { messages: [], dropped: messages.length, limited: messages.length > 0 };
  }
  if (messages.length <= remaining) {
    return { messages: [...messages], dropped: 0, limited: false };
  }
  return {
    messages: messages.slice(-remaining),
    dropped: messages.length - remaining,
    limited: true,
  };
}

export class ClaudeMemberTranscriptStreamSource implements MemberLogStreamSource {
  readonly provider = 'claude_transcript' as const;

  constructor(
    private readonly logsFinder: TeamMemberLogsFinder,
    private readonly parser: BoardTaskExactLogStrictParser,
    private readonly chunkBuilder: BoardTaskExactLogChunkBuilder,
    private readonly logger: LoggerPort
  ) {}

  async load(input: MemberLogStreamSourceInput): Promise<MemberLogStreamSourceResult> {
    const warnings: MemberLogStreamWarning[] = [];
    const refs = await this.logsFinder.findRecentMemberLogFileRefsByMember(
      input.teamName,
      [input.memberName],
      {
        mtimeSinceMs: input.sinceMs ?? null,
        forceRefresh: input.forceRefresh === true,
      }
    );
    const dedupedRefs = dedupeMemberLogRefs(refs);
    const cappedRefs = dedupedRefs.slice(0, input.budget.maxTranscriptFiles);
    const droppedRefCount = Math.max(0, dedupedRefs.length - cappedRefs.length);
    if (droppedRefCount > 0) {
      warnings.push({
        code: 'large_log_window_limited',
        message: `Showing ${cappedRefs.length} recent transcript files for this member.`,
      });
    }

    const parsedByPath = await this.parser.parseFiles(cappedRefs.map((ref) => ref.filePath));
    const participant = buildMemberParticipant(input.memberName);
    const segments = [];
    let remainingSourceMessages = input.budget.maxSourceMessages;
    let includedTranscriptFileCount = 0;
    let droppedMessageCount = 0;
    let contentLimited = false;
    let windowLimited = false;

    for (const ref of cappedRefs) {
      const parsedMessages = parsedByPath.get(ref.filePath) ?? [];
      if (parsedMessages.length === 0) continue;

      const sourceBudgeted = filterSourceMessageBudget(parsedMessages, remainingSourceMessages);
      remainingSourceMessages -= sourceBudgeted.messages.length;
      droppedMessageCount += sourceBudgeted.dropped;
      windowLimited = windowLimited || sourceBudgeted.limited;

      const budgeted = applyMemberLogMessageBudget(sourceBudgeted.messages, input.budget);
      droppedMessageCount += budgeted.droppedMessageCount;
      contentLimited = contentLimited || budgeted.contentLimited;
      windowLimited = windowLimited || budgeted.segmentWindowLimited;
      if (budgeted.messages.length === 0) continue;

      const chunks = this.chunkBuilder.buildBundleChunks(budgeted.messages);
      if (chunks.length === 0) continue;

      const first = budgeted.messages[0];
      const last = budgeted.messages[budgeted.messages.length - 1];
      if (!first || !last) continue;

      includedTranscriptFileCount += 1;
      const role = ref.kind === 'lead_session' ? 'lead' : 'member';
      segments.push(
        withSegmentSource(
          {
            id: buildSegmentId({
              provider: this.provider,
              teamName: input.teamName,
              memberName: input.memberName,
              sessionId: ref.sessionId,
              fingerprint: shortHash(`${ref.filePath}:${ref.mtimeMs}:${ref.sizeBytes ?? ''}`),
              startTimestamp: first.timestamp.toISOString(),
            }),
            participantKey: participant.key,
            actor: buildMemberActor({
              memberName: input.memberName,
              sessionId: ref.sessionId,
              role,
            }),
            startTimestamp: first.timestamp.toISOString(),
            endTimestamp: last.timestamp.toISOString(),
            chunks,
          },
          {
            provider: this.provider,
            label: role === 'lead' ? 'Claude lead transcript' : 'Claude transcript',
            sessionId: ref.sessionId,
            messageCount: budgeted.messages.length,
            truncated: budgeted.droppedMessageCount > 0 || budgeted.contentLimited,
          }
        )
      );
    }

    if (windowLimited) {
      warnings.push({
        code: 'segment_message_window_limited',
        message: 'Some transcript sessions were trimmed to recent messages.',
      });
    }
    if (contentLimited) {
      warnings.push({
        code: 'message_content_limited',
        message: 'Some large message content was truncated before rendering.',
      });
    }

    this.logger.debug?.(
      `Claude member log stream ${input.teamName}/${input.memberName}: refs=${refs.length}, segments=${segments.length}`
    );

    return {
      provider: this.provider,
      status: segments.length > 0 ? 'included' : 'skipped',
      reason: segments.length > 0 ? undefined : 'no_member_transcripts',
      participants: segments.length > 0 ? [participant] : [],
      segments,
      warnings,
      metadata: {
        scannedTranscriptFileCount: refs.length,
        includedTranscriptFileCount,
        droppedSegmentCount: droppedRefCount,
        droppedMessageCount,
      },
    };
  }
}
