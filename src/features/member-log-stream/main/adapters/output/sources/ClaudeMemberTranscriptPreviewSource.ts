import { extractMemberLogPreviewItems } from '../../../../core/domain/policies/memberLogPreviewExtractor';

import { dedupeMemberLogRefs } from './memberLogStreamSourceUtils';

import type { MemberLogStreamWarning } from '../../../../contracts';
import type { LoggerPort } from '../../../../core/application/ports/LoggerPort';
import type {
  MemberLogPreviewSource,
  MemberLogPreviewSourceInput,
  MemberLogPreviewSourceResult,
} from '../../../../core/application/ports/MemberLogPreviewSource';
import type { BoardTaskExactLogStrictParser } from '@main/services/team/taskLogs/exact/BoardTaskExactLogStrictParser';
import type { TeamMemberLogsFinder } from '@main/services/team/TeamMemberLogsFinder';
import type { ParsedMessage } from '@main/types';

function recentMessages(
  messages: readonly ParsedMessage[],
  maxMessages: number
): { messages: ParsedMessage[]; dropped: number } {
  if (messages.length <= maxMessages) {
    return { messages: [...messages], dropped: 0 };
  }
  return {
    messages: messages.slice(-maxMessages),
    dropped: messages.length - maxMessages,
  };
}

export class ClaudeMemberTranscriptPreviewSource implements MemberLogPreviewSource {
  readonly provider = 'claude_transcript' as const;

  constructor(
    private readonly logsFinder: TeamMemberLogsFinder,
    private readonly parser: BoardTaskExactLogStrictParser,
    private readonly logger: LoggerPort
  ) {}

  async loadPreview(input: MemberLogPreviewSourceInput): Promise<MemberLogPreviewSourceResult> {
    const warnings: MemberLogStreamWarning[] = [];
    const refs = await this.logsFinder.findRecentMemberLogFileRefsByMember(
      input.teamName,
      [input.memberName],
      {
        forceRefresh: input.forceRefresh === true,
      }
    );
    const dedupedRefs = dedupeMemberLogRefs(refs);
    const cappedRefs = dedupedRefs.slice(0, input.budget.maxTranscriptFiles);
    const droppedRefCount = Math.max(0, dedupedRefs.length - cappedRefs.length);
    if (droppedRefCount > 0) {
      warnings.push({
        code: 'large_log_window_limited',
        message: `Scanning ${cappedRefs.length} recent transcript files for graph log preview.`,
      });
    }

    const parsedByPath = await this.parser.parseFiles(cappedRefs.map((ref) => ref.filePath));
    const items = [];
    let droppedMessageCount = 0;
    let sourceOverflowCount = 0;
    let sourceTruncated = droppedRefCount > 0;

    for (const ref of cappedRefs) {
      const parsedMessages = parsedByPath.get(ref.filePath) ?? [];
      if (parsedMessages.length === 0) continue;

      const limited = recentMessages(parsedMessages, input.budget.maxSourceMessagesPerProvider);
      droppedMessageCount += limited.dropped;
      sourceTruncated = sourceTruncated || limited.dropped > 0;

      const extracted = extractMemberLogPreviewItems({
        messages: limited.messages,
        provider: this.provider,
        maxItems: input.maxItems,
        textLimit: input.textLimit,
        sourceId: ref.filePath,
        sourceLabel: ref.kind === 'lead_session' ? 'Claude lead transcript' : 'Claude transcript',
        sessionId: ref.sessionId,
      });
      items.push(...extracted.items);
      sourceOverflowCount += extracted.overflowCount;
      sourceTruncated = sourceTruncated || extracted.truncated;
    }

    if (droppedMessageCount > 0) {
      warnings.push({
        code: 'segment_message_window_limited',
        message: 'Some transcript files were trimmed to recent messages for graph preview.',
      });
    }

    this.logger.debug?.(
      `Claude member log preview ${input.teamName}/${input.memberName}: refs=${refs.length}, items=${items.length}`
    );

    return {
      provider: this.provider,
      status: items.length > 0 ? 'included' : 'skipped',
      reason: items.length > 0 ? undefined : 'no_member_transcripts',
      items,
      warnings,
      truncated: sourceTruncated,
      overflowCount: sourceOverflowCount,
    };
  }
}
