import { useCallback, useRef } from 'react';

import { taskDetailKey } from '@features/team-task-detail/core';
import { markCommentsRead } from '@renderer/services/commentReadStorage';

import { useViewportObserver } from './useViewportObserver';

import type { TaskDetailIdentity } from '@features/team-task-detail/core';

interface UseViewportCommentReadOptions {
  identity: TaskDetailIdentity;
  enabled: boolean;
  isOriginCurrent: () => boolean;
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
  identity,
  enabled,
  isOriginCurrent,
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
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const identityKey = taskDetailKey(identity);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const isOriginCurrentRef = useRef(isOriginCurrent);
  isOriginCurrentRef.current = isOriginCurrent;

  const trackedIdentityKey = useRef(identityKey);
  if (trackedIdentityKey.current !== identityKey) {
    trackedIdentityKey.current = identityKey;
    seenIdsRef.current = new Set();
    commentElementsRef.current = new Map();
  }

  const persistSeen = useCallback(() => {
    if (!enabledRef.current || !isOriginCurrentRef.current()) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (seenIdsRef.current.size === 0) return;
    markCommentsRead(identityRef.current, Array.from(seenIdsRef.current));
  }, []);

  const handleVisibleChange = useCallback(
    (visibleValues: string[], scopeKey: string | undefined) => {
      if (scopeKey !== taskDetailKey(identityRef.current)) return;
      if (!enabledRef.current || !isOriginCurrentRef.current()) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
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
    enabled,
    scopeKey: identityKey,
    onVisibleChange: handleVisibleChange,
  });

  const registerComment = useCallback(
    (commentId: string) => {
      const registerObservedElement = registerElement(commentId);
      const capturedKey = identityKey;

      return (el: HTMLElement | null) => {
        if (capturedKey !== trackedIdentityKey.current) {
          if (!el) registerObservedElement(null);
          return;
        }
        if (el) {
          commentElementsRef.current.set(commentId, el);
        } else {
          commentElementsRef.current.delete(commentId);
        }

        registerObservedElement(el);
      };
    },
    [identityKey, registerElement]
  );

  const flush = useCallback(() => {
    if (!enabledRef.current || !isOriginCurrentRef.current()) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
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
