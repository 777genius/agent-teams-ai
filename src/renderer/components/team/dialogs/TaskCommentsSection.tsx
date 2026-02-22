import { useCallback, useRef, useState } from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { useStore } from '@renderer/store';
import { formatDistanceToNow } from 'date-fns';
import { MessageSquare, Send } from 'lucide-react';

import type { TaskComment } from '@shared/types';

const MAX_COMMENT_LENGTH = 2000;

interface TaskCommentsSectionProps {
  teamName: string;
  taskId: string;
  comments: TaskComment[];
}

export const TaskCommentsSection = ({
  teamName,
  taskId,
  comments,
}: TaskCommentsSectionProps): React.JSX.Element => {
  const addTaskComment = useStore((s) => s.addTaskComment);
  const addingComment = useStore((s) => s.addingComment);

  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const trimmed = text.trim();
  const remaining = MAX_COMMENT_LENGTH - trimmed.length;
  const canSubmit = trimmed.length > 0 && trimmed.length <= MAX_COMMENT_LENGTH && !addingComment;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    try {
      await addTaskComment(teamName, taskId, trimmed);
      setText('');
    } catch {
      // Error is stored in addCommentError via store
    }
  }, [canSubmit, addTaskComment, teamName, taskId, trimmed]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit]
  );

  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-muted)]">
        <MessageSquare size={12} />
        Comments
        {comments.length > 0 ? (
          <span className="rounded-full bg-[var(--color-surface-raised)] px-1.5 py-0 text-[10px]">
            {comments.length}
          </span>
        ) : null}
      </div>

      {comments.length > 0 ? (
        <div className="mb-3 space-y-2">
          {comments.map((comment) => (
            <div
              key={comment.id}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5"
            >
              <div className="mb-1 flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
                <span className="font-medium text-[var(--color-text-secondary)]">
                  {comment.author}
                </span>
                <span>{formatDistanceToNow(new Date(comment.createdAt), { addSuffix: true })}</span>
              </div>
              <div className="text-xs">
                <MarkdownViewer content={comment.text} maxHeight="max-h-[120px]" />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="space-y-1.5">
        <textarea
          ref={textareaRef}
          className="w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-xs text-[var(--color-text)] placeholder:text-zinc-500 focus:border-[var(--color-border-emphasis)] focus:outline-none"
          placeholder="Add a comment... (Cmd+Enter to send)"
          rows={3}
          maxLength={MAX_COMMENT_LENGTH}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={addingComment}
        />
        <div className="flex items-center justify-between">
          <span
            className={`text-[10px] ${
              remaining < 100 ? 'text-yellow-400' : 'text-[var(--color-text-muted)]'
            }`}
          >
            {remaining < 200 ? `${remaining} chars remaining` : ''}
          </span>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
          >
            <Send size={12} />
            Comment
          </button>
        </div>
      </div>
    </div>
  );
};
