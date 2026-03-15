import React, { useMemo } from 'react';

import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { computeAwaitingReply } from '@renderer/utils/taskCommentPendingReply';
import { formatDistanceToNowStrict } from 'date-fns';

import type { ResolvedTeamMember, TaskComment } from '@shared/types';

interface TaskCommentAwaitingReplyProps {
  comments: TaskComment[] | undefined;
  taskOwner: string | undefined;
  taskCreatedBy: string | undefined;
  members: ResolvedTeamMember[];
}

/**
 * Compact indicator shown between the comment input and the comment list
 * when the human user is awaiting a reply from the task owner or creator.
 */
export const TaskCommentAwaitingReply = ({
  comments,
  taskOwner,
  taskCreatedBy,
  members,
}: TaskCommentAwaitingReplyProps): React.JSX.Element | null => {
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const result = useMemo(
    () => computeAwaitingReply(comments, taskOwner, taskCreatedBy),
    [comments, taskOwner, taskCreatedBy]
  );

  if (!result.isAwaiting) return null;

  const since = formatDistanceToNowStrict(result.userCommentAtMs, { addSuffix: true });

  return (
    <div className="my-2 flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-1.5">
      {/* Pulsing dot */}
      <span className="relative inline-flex size-2.5 shrink-0">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex size-full rounded-full bg-emerald-500" />
      </span>

      <span className="text-[10px] text-[var(--color-text-muted)]">Awaiting reply from</span>

      {result.awaitingFrom.map((name, i) => (
        <React.Fragment key={name}>
          {i > 0 && <span className="text-[10px] text-[var(--color-text-muted)]">or</span>}
          <MemberBadge name={name} color={colorMap.get(name)} size="xs" />
        </React.Fragment>
      ))}

      <span className="ml-auto shrink-0 text-[10px] text-[var(--color-text-muted)]">{since}</span>
    </div>
  );
};
