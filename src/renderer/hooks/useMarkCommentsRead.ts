import { useEffect, useRef } from 'react';

import { markAsRead } from '@renderer/services/commentReadStorage';

import type { TaskComment } from '@shared/types';

/**
 * Marks task comments as read when the component is mounted and
 * whenever the comments list changes while mounted.
 *
 * Previously used IntersectionObserver, but since the component
 * is only rendered inside a CollapsibleTeamSection (conditional
 * mount/unmount controls visibility), a simple effect is both
 * simpler and more reliable — especially inside Dialog portals
 * where IntersectionObserver can miss the initial intersection.
 *
 * Returns a ref callback for the comments container (kept for
 * API compatibility with TaskCommentsSection).
 */
export function useMarkCommentsRead(
  teamName: string,
  taskId: string,
  comments: TaskComment[]
): (node: HTMLElement | null) => void {
  const nodeRef = useRef<HTMLElement | null>(null);

  // Mark as read on mount and whenever comments change
  useEffect(() => {
    if (comments.length === 0) return;
    const latest = Math.max(...comments.map((c) => new Date(c.createdAt).getTime()));
    if (latest > 0) markAsRead(teamName, taskId, latest);
  }, [teamName, taskId, comments]);

  // Stable ref callback (no dependencies — just stores the node)
  const refCallback = useRef((node: HTMLElement | null) => {
    nodeRef.current = node;
  }).current;

  return refCallback;
}
