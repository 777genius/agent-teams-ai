import { useEffect, useReducer } from 'react';

import { type TaskDetailIdentity, taskDetailKey } from '@features/team-task-detail/core';

import type { TaskComment } from '@shared/types';

interface CommentPulseState {
  taskKey: string;
  commentCount: number;
  commentIds: Set<string>;
  pulseKey: number;
}

interface CommentPulseSyncAction {
  taskKey: string;
  comments: readonly TaskComment[];
}

const EMPTY_TASK_COMMENTS: readonly TaskComment[] = [];
function createCommentPulseState(
  taskKey: string,
  comments: readonly TaskComment[],
  pulseKey = 0
): CommentPulseState {
  return {
    taskKey,
    commentCount: comments.length,
    commentIds: new Set(comments.map((comment) => comment.id)),
    pulseKey,
  };
}

function hasSameCommentIds(state: CommentPulseState, comments: readonly TaskComment[]): boolean {
  return (
    comments.length === state.commentCount &&
    comments.every((comment) => state.commentIds.has(comment.id))
  );
}

function syncCommentPulseState(
  state: CommentPulseState,
  action: CommentPulseSyncAction
): CommentPulseState {
  if (state.taskKey !== action.taskKey) {
    return createCommentPulseState(action.taskKey, action.comments);
  }

  const hasNewIncomingComment =
    action.comments.length > state.commentCount &&
    action.comments.some(
      (comment) => !state.commentIds.has(comment.id) && comment.author !== 'user'
    );

  if (!hasNewIncomingComment && hasSameCommentIds(state, action.comments)) {
    return state;
  }

  return createCommentPulseState(
    action.taskKey,
    action.comments,
    hasNewIncomingComment ? state.pulseKey + 1 : state.pulseKey
  );
}

export function useTaskCommentPulse(
  identity: TaskDetailIdentity,
  rawComments: readonly TaskComment[] | undefined
): number {
  const taskKey = taskDetailKey(identity);
  const comments = rawComments ?? EMPTY_TASK_COMMENTS;
  const [state, sync] = useReducer(
    syncCommentPulseState,
    { taskKey, comments },
    ({ taskKey, comments }) => createCommentPulseState(taskKey, comments)
  );
  useEffect(() => {
    sync({ taskKey, comments });
  }, [taskKey, comments]);
  return state.taskKey === taskKey ? state.pulseKey : 0;
}
