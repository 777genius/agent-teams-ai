import { useCallback, useMemo } from 'react';

import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useStore } from '@renderer/store';
import { buildReplyBlock } from '@renderer/utils/agentMessageFormatting';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { getModifierKeyName } from '@renderer/utils/keyboardUtils';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { Send, X } from 'lucide-react';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { ResolvedTeamMember } from '@shared/types';

const MAX_COMMENT_LENGTH = 2000;

interface TaskCommentInputProps {
  teamName: string;
  taskId: string;
  members: ResolvedTeamMember[];
  replyTo: { author: string; text: string } | null;
  onClearReply: () => void;
}

export const TaskCommentInput = ({
  teamName,
  taskId,
  members,
  replyTo,
  onClearReply,
}: TaskCommentInputProps): React.JSX.Element => {
  const addTaskComment = useStore((s) => s.addTaskComment);
  const addingComment = useStore((s) => s.addingComment);
  const projectPath = useStore((s) => s.selectedTeamData?.config.projectPath ?? null);

  const draft = useDraftPersistence({ key: `taskComment:${teamName}:${taskId}` });
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);

  const mentionSuggestions = useMemo<MentionSuggestion[]>(
    () =>
      members.map((m) => ({
        id: m.name,
        name: m.name,
        subtitle: formatAgentRole(m.role) ?? formatAgentRole(m.agentType) ?? undefined,
        color: colorMap.get(m.name),
      })),
    [members, colorMap]
  );

  const trimmed = draft.value.trim();
  const remaining = MAX_COMMENT_LENGTH - trimmed.length;
  const canSubmit = trimmed.length > 0 && trimmed.length <= MAX_COMMENT_LENGTH && !addingComment;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    try {
      const text = replyTo ? buildReplyBlock(replyTo.author, replyTo.text, trimmed) : trimmed;
      await addTaskComment(teamName, taskId, text);
      draft.clearDraft();
      onClearReply();
    } catch {
      // Error is stored in addCommentError via store
    }
  }, [canSubmit, addTaskComment, teamName, taskId, trimmed, draft, replyTo, onClearReply]);

  return (
    <div>
      {replyTo ? (
        <div className="mb-2 flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-2">
          <div className="min-w-0 flex-1">
            <div className="mb-0.5 text-[10px] font-medium text-[var(--color-text-muted)]">
              Replying to{' '}
              <span
                className="font-semibold"
                style={{
                  color: (() => {
                    const rc = colorMap.get(replyTo.author);
                    return rc ? getTeamColorSet(rc).text : 'var(--color-text-secondary)';
                  })(),
                }}
              >
                @{replyTo.author}
              </span>
            </div>
            <div className="line-clamp-3 text-[11px] text-[var(--color-text-muted)]">
              {replyTo.text}
            </div>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text-secondary)]"
                onClick={onClearReply}
              >
                <X size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">Cancel reply</TooltipContent>
          </Tooltip>
        </div>
      ) : null}

      <div className="relative">
        <MentionableTextarea
          id={`task-comment-${taskId}`}
          placeholder={`Add a comment... (${getModifierKeyName()}+Enter to send)`}
          value={draft.value}
          onValueChange={draft.setValue}
          suggestions={mentionSuggestions}
          projectPath={projectPath}
          minRows={2}
          maxRows={8}
          maxLength={MAX_COMMENT_LENGTH}
          disabled={addingComment}
          cornerAction={
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!canSubmit}
              onClick={() => void handleSubmit()}
            >
              <Send size={12} />
              Comment
            </button>
          }
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
      </div>
    </div>
  );
};
