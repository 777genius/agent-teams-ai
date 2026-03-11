import { useState } from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { linkifyTaskIdsInMarkdown } from '@renderer/utils/taskReferenceUtils';

import type { ParsedMessageReply } from '@renderer/utils/agentMessageFormatting';
import type { TaskRef } from '@shared/types';

interface ReplyQuoteBlockProps {
  reply: ParsedMessageReply;
  /** Color name for the quoted agent (resolved from memberColorMap). */
  memberColor?: string;
  /** When set, limits height of the reply body (e.g. "max-h-56"). Omit to show full content. */
  bodyMaxHeight?: string;
  /** Structured task refs for the reply body, when available. */
  replyTaskRefs?: TaskRef[];
}

/** Threshold (characters) above which the "more/less" toggle is shown. */
const LONG_QUOTE_THRESHOLD = 200;

export const ReplyQuoteBlock = ({
  reply,
  memberColor,
  bodyMaxHeight = 'max-h-56',
  replyTaskRefs,
}: ReplyQuoteBlockProps): React.JSX.Element => {
  const isLong = reply.originalText.length > LONG_QUOTE_THRESHOLD;
  const [expanded, setExpanded] = useState(false);

  const quoteMaxHeight = expanded ? 'max-h-48' : 'max-h-[3.75rem]';

  return (
    <div className="space-y-2">
      {/* Quote block — styled like SendMessageDialog */}
      <div className="relative overflow-hidden rounded-md border border-blue-400/20 bg-blue-100/40 py-2 pl-3 pr-2 dark:border-blue-500/20 dark:bg-blue-950/20">
        {/* Decorative quotation mark */}
        <span className="pointer-events-none absolute -right-1 top-1/2 -translate-y-1/2 select-none font-serif text-[48px] leading-none text-blue-600/[0.08] dark:text-blue-400/[0.08]">
          &ldquo;
        </span>

        {/* "Replying to" + MemberBadge */}
        <div className="mb-1 flex items-center gap-1.5">
          <span className="text-[10px] text-blue-600/60 dark:text-blue-300/60">Replying to</span>
          <MemberBadge name={reply.agentName} color={memberColor} size="sm" />
        </div>

        {/* Quote text */}
        <div className={`pr-5 opacity-50 ${expanded ? '' : 'max-h-[3.75rem] overflow-hidden'}`}>
          <MarkdownViewer
            content={linkifyTaskIdsInMarkdown(reply.originalText)}
            bare
            maxHeight={quoteMaxHeight}
          />
        </div>

        {/* More/less toggle */}
        {isLong ? (
          <button
            type="button"
            className="mt-0.5 text-[10px] text-blue-600/60 hover:text-blue-700 dark:text-blue-400/60 dark:hover:text-blue-300"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'less' : 'more'}
          </button>
        ) : null}
      </div>

      {/* Reply text */}
      <MarkdownViewer
        content={linkifyTaskIdsInMarkdown(reply.replyText, replyTaskRefs)}
        maxHeight={bodyMaxHeight}
        copyable
        bare
      />
    </div>
  );
};
