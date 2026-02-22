import { useCallback, useMemo } from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useMarkCommentsRead } from '@renderer/hooks/useMarkCommentsRead';
import { useStore } from '@renderer/store';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { formatDistanceToNow } from 'date-fns';
import { MessageSquare, Send } from 'lucide-react';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { ResolvedTeamMember, TaskComment } from '@shared/types';

const MAX_COMMENT_LENGTH = 2000;

interface TaskCommentsSectionProps {
  teamName: string;
  taskId: string;
  comments: TaskComment[];
  members: ResolvedTeamMember[];
}

export const TaskCommentsSection = ({
  teamName,
  taskId,
  comments,
  members,
}: TaskCommentsSectionProps): React.JSX.Element => {
  const addTaskComment = useStore((s) => s.addTaskComment);
  const addingComment = useStore((s) => s.addingComment);
  const commentsRef = useMarkCommentsRead(teamName, taskId, comments);

  const draft = useDraftPersistence({ key: `taskComment:${teamName}:${taskId}` });

  const mentionSuggestions = useMemo<MentionSuggestion[]>(
    () =>
      members.map((m) => ({
        id: m.name,
        name: m.name,
        subtitle: formatAgentRole(m.role) ?? formatAgentRole(m.agentType) ?? undefined,
        color: m.color,
      })),
    [members]
  );

  const trimmed = draft.value.trim();
  const remaining = MAX_COMMENT_LENGTH - trimmed.length;
  const canSubmit = trimmed.length > 0 && trimmed.length <= MAX_COMMENT_LENGTH && !addingComment;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    try {
      await addTaskComment(teamName, taskId, trimmed);
      draft.clearDraft();
    } catch {
      // Error is stored in addCommentError via store
    }
  }, [canSubmit, addTaskComment, teamName, taskId, trimmed, draft]);

  return (
    <div ref={commentsRef}>
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
                <span
                  className="font-medium"
                  style={{
                    color:
                      comment.author === 'user'
                        ? 'var(--color-text-secondary)'
                        : (members.find((m) => m.name === comment.author)?.color ??
                          'var(--color-text-secondary)'),
                  }}
                >
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
        <MentionableTextarea
          id={`task-comment-${taskId}`}
          placeholder="Add a comment... (Cmd+Enter to send)"
          value={draft.value}
          onValueChange={draft.setValue}
          suggestions={mentionSuggestions}
          minRows={2}
          maxRows={8}
          maxLength={MAX_COMMENT_LENGTH}
          disabled={addingComment}
          footerRight={
            <div className="flex items-center gap-2">
              {remaining < 200 ? (
                <span
                  className={`text-[10px] ${remaining < 100 ? 'text-yellow-400' : 'text-[var(--color-text-muted)]'}`}
                >
                  {remaining} chars left
                </span>
              ) : null}
              {draft.isSaved ? (
                <span className="text-[10px] text-[var(--color-text-muted)]">Draft saved</span>
              ) : null}
            </div>
          }
        />
        <div className="flex justify-end">
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
