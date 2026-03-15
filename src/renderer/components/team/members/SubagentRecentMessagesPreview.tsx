import { useState } from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { displayMemberName } from '@renderer/utils/memberHelpers';
import { format } from 'date-fns';
import { ChevronDown, ChevronUp } from 'lucide-react';

export type SubagentPreviewMessageKind =
  | 'output'
  | 'text'
  | 'tool_result'
  | 'interruption'
  | 'plan_exit'
  | 'teammate_message'
  | 'user'
  | 'unknown';

export interface SubagentPreviewMessage {
  id: string;
  timestamp: Date;
  kind: SubagentPreviewMessageKind;
  /** Optional short label (e.g. tool name). */
  label?: string;
  content: string;
}

interface SubagentRecentMessagesPreviewProps {
  messages: SubagentPreviewMessage[];
  memberName?: string;
  hasMore?: boolean;
  onLoadMore?: () => void;
}

export const SubagentRecentMessagesPreview = ({
  messages,
  memberName,
  hasMore = false,
  onLoadMore,
}: SubagentRecentMessagesPreviewProps): React.JSX.Element | null => {
  const [expandedAll, setExpandedAll] = useState(false);

  if (!messages.length) return null;

  return (
    <div className="mb-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
      <div className="mb-2 flex items-center gap-2">
        <div className="min-w-0 truncate text-[11px] text-[var(--color-text-muted)]">
          Latest messages{memberName ? ` — ${displayMemberName(memberName)}` : ''}
        </div>
      </div>

      <div className={`${expandedAll ? 'max-h-none' : 'max-h-[200px]'} overflow-y-auto pr-1`}>
        {messages.map((m, index) => (
          <div
            key={m.id}
            className="rounded px-2 py-1.5"
            style={index % 2 === 0 ? { backgroundColor: 'var(--card-bg-zebra)' } : undefined}
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 text-xs text-[var(--color-text)]">
                <MarkdownViewer
                  content={m.content}
                  bare
                  maxHeight="max-h-none"
                  className="[&>div>div]:p-0 [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1"
                />
              </div>
              <div className="shrink-0 text-right text-[10px] text-[var(--color-text-muted)]">
                {format(m.timestamp, 'h:mm:ss a')}
              </div>
            </div>
          </div>
        ))}

        {hasMore && onLoadMore ? (
          <div className="flex justify-center pb-1 pt-2">
            <button
              type="button"
              className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-[11px] text-[var(--color-text-muted)] shadow-sm transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text-secondary)]"
              onClick={onLoadMore}
            >
              <ChevronDown size={12} />
              Load more
            </button>
          </div>
        ) : null}
      </div>

      <div className="sticky bottom-0 z-10 flex justify-end pb-1 pt-2">
        {!expandedAll ? (
          <button
            type="button"
            className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-[11px] text-[var(--color-text-muted)] shadow-sm transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text-secondary)]"
            onClick={() => setExpandedAll(true)}
          >
            <ChevronDown size={12} />
            Expand
          </button>
        ) : (
          <button
            type="button"
            className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-[11px] text-[var(--color-text-muted)] shadow-sm transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text-secondary)]"
            onClick={() => setExpandedAll(false)}
          >
            <ChevronUp size={12} />
            Collapse
          </button>
        )}
      </div>
    </div>
  );
};
