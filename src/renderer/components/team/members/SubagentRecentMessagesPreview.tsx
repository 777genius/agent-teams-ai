import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { format } from 'date-fns';

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
}

export const SubagentRecentMessagesPreview = ({
  messages,
  memberName,
}: SubagentRecentMessagesPreviewProps): React.JSX.Element | null => {
  if (!messages.length) return null;

  return (
    <div className="mb-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0 truncate text-[11px] text-[var(--color-text-muted)]">
          Latest messages{memberName ? ` — ${memberName}` : ''}
        </div>
        <div className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
          {format(messages[0].timestamp, 'h:mm:ss a')}
        </div>
      </div>

      <div className="space-y-2">
        {messages.map((m) => (
          <div
            key={m.id}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-2"
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className="min-w-0 truncate text-[10px] text-[var(--color-text-muted)]">
                {m.label ? (
                  <span className="rounded bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-secondary)]">
                    {m.label}
                  </span>
                ) : (
                  <span className="font-mono">{m.kind}</span>
                )}
              </div>
              <div className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                {format(m.timestamp, 'h:mm:ss a')}
              </div>
            </div>

            {m.kind === 'tool_result' ? (
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--color-text)]">
                {m.content}
              </pre>
            ) : (
              <div className="max-h-40 overflow-y-auto text-xs text-[var(--color-text)]">
                <MarkdownViewer content={m.content} copyable />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
