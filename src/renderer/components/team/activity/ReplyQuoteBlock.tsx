import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';

import type { ParsedMessageReply } from '@renderer/utils/agentMessageFormatting';

interface ReplyQuoteBlockProps {
  reply: ParsedMessageReply;
}

export const ReplyQuoteBlock = ({ reply }: ReplyQuoteBlockProps): React.JSX.Element => (
  <div className="space-y-2">
    <div
      className="rounded-md border-l-2 border-[var(--color-border-emphasis)] bg-[var(--color-surface)] px-3 py-2"
      style={{ opacity: 0.7 }}
    >
      <span className="mb-0.5 block text-[10px] font-medium text-[var(--color-text-muted)]">
        @{reply.agentName}
      </span>
      <p className="line-clamp-3 text-xs text-[var(--color-text-muted)]">{reply.originalText}</p>
    </div>
    <MarkdownViewer content={reply.replyText} maxHeight="max-h-56" copyable />
  </div>
);
