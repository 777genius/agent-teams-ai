import { useCallback, useEffect, useRef } from 'react';

import { markCommentsRead } from '@renderer/services/commentReadStorage';

import { useViewportObserver } from './useViewportObserver';

import type { RefObject } from 'react';

interface UseViewportCommentReadOptions {
  teamName: string;
  taskId: string;
  /**
   * Scrollable ancestor element (e.g. DialogContent) used as IO root.
   * Required for portalled Dialogs where the default viewport root
   * would not detect intersections correctly.
   */
  scrollContainerRef: RefObject<HTMLElement | null>;
}

/**
 * Marks task comments as read based on viewport visibility.
 *
 * Uses IntersectionObserver (via useViewportObserver) to detect which
 * comment elements are visible in the scroll container and records
 * their individual IDs as read via per-comment ID tracking.
 *
 * Each comment element should be registered via the returned
 * `registerComment(commentId)` ref callback.
 *
 * Only comments that have actually been scrolled into view are marked
 * as read — fixes the bug where DESC-sorted comments caused all
 * comments to be marked read when the newest was visible at the top.
 */
export function useViewportCommentRead({
  teamName,
  taskId,
  scrollContainerRef,
}: UseViewportCommentReadOptions): {
  /** Ref callback factory. Call with the comment's unique ID. */
  registerComment: (commentId: string) => (el: HTMLElement | null) => void;
  /**
   * Flush all observed comment IDs now. Call on dialog close
   * as a safety fallback (e.g. if IO did not fire for portal reasons).
   */
  flush: () => void;
} {
  const seenIdsRef = useRef<Set<string>>(new Set());
  const teamNameRef = useRef(teamName);
  const taskIdRef = useRef(taskId);
  teamNameRef.current = teamName;
  taskIdRef.current = taskId;

  // Reset tracked state when team/task changes
  useEffect(() => {
    seenIdsRef.current = new Set();
  }, [teamName, taskId]);

  const persistSeen = useCallback(() => {
    if (seenIdsRef.current.size > 0) {
      markCommentsRead(teamNameRef.current, taskIdRef.current, Array.from(seenIdsRef.current));
    }
  }, []);

  const handleVisibleChange = useCallback(
    (visibleValues: string[]) => {
      let changed = false;
      for (const id of visibleValues) {
        if (id && !seenIdsRef.current.has(id)) {
          seenIdsRef.current.add(id);
          changed = true;
        }
      }
      if (changed) {
        persistSeen();
      }
    },
    [persistSeen]
  );

  const { registerElement } = useViewportObserver({
    rootRef: scrollContainerRef,
    threshold: 0.1,
    onVisibleChange: handleVisibleChange,
  });

  const registerComment = useCallback(
    (commentId: string) => registerElement(commentId),
    [registerElement]
  );

  const flush = useCallback(() => {
    persistSeen();
  }, [persistSeen]);

  return { registerComment, flush };
}
