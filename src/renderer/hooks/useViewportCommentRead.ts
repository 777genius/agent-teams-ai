import { useCallback, useEffect, useRef } from 'react';

import { markCommentsRead } from '@renderer/services/commentReadStorage';

import { useViewportObserver } from './useViewportObserver';

interface UseViewportCommentReadOptions {
  teamName: string;
  taskId: string;
  /**
   * Scrollable ancestor DOM element (e.g. DialogContent) used as IO root.
   * Pass the actual element (not a RefObject) so that the observer is
   * recreated when the portal mounts. Use useState + callback ref:
   *   const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
   *   <DialogContent ref={setRootEl}>
   */
  scrollContainer: HTMLElement | null;
}

const VISIBILITY_THRESHOLD = 0.1;

export function getVisibleCommentIdsFallback(
  scrollContainer: HTMLElement | null,
  elementsById: ReadonlyMap<string, HTMLElement>
): string[] {
  if (!scrollContainer || elementsById.size === 0) return [];

  const rootRect = scrollContainer.getBoundingClientRect();
  const visibleIds: string[] = [];

  for (const [commentId, element] of elementsById) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    const visibleWidth = Math.min(rect.right, rootRect.right) - Math.max(rect.left, rootRect.left);
    const visibleHeight = Math.min(rect.bottom, rootRect.bottom) - Math.max(rect.top, rootRect.top);

    if (visibleWidth <= 0 || visibleHeight <= 0) continue;
    if (visibleHeight / rect.height < VISIBILITY_THRESHOLD) continue;

    visibleIds.push(commentId);
  }

  return visibleIds;
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
  scrollContainer,
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
  const commentElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const teamNameRef = useRef(teamName);
  const taskIdRef = useRef(taskId);

  useEffect(() => {
    teamNameRef.current = teamName;
    taskIdRef.current = taskId;
  }, [teamName, taskId]);

  // Reset tracked state when team/task changes
  useEffect(() => {
    seenIdsRef.current = new Set();
    commentElementsRef.current.clear();
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
    root: scrollContainer,
    threshold: VISIBILITY_THRESHOLD,
    onVisibleChange: handleVisibleChange,
  });

  const registerComment = useCallback(
    (commentId: string) => {
      const registerObservedElement = registerElement(commentId);

      return (el: HTMLElement | null) => {
        if (el) {
          commentElementsRef.current.set(commentId, el);
        } else {
          commentElementsRef.current.delete(commentId);
        }

        registerObservedElement(el);
      };
    },
    [registerElement]
  );

  const flush = useCallback(() => {
    const fallbackVisibleIds = getVisibleCommentIdsFallback(
      scrollContainer,
      commentElementsRef.current
    );
    for (const commentId of fallbackVisibleIds) {
      seenIdsRef.current.add(commentId);
    }
    persistSeen();
  }, [persistSeen, scrollContainer]);

  return { registerComment, flush };
}
