import { useCallback, useEffect, useRef } from 'react';

import { markAsRead } from '@renderer/services/commentReadStorage';

import type { TaskComment } from '@shared/types';

export function useMarkCommentsRead(
  teamName: string,
  taskId: string,
  comments: TaskComment[]
): (node: HTMLElement | null) => void {
  const isVisibleRef = useRef(false);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Mark comments as read if section is visible
  const markIfVisible = useCallback(() => {
    if (!isVisibleRef.current || comments.length === 0) return;
    const latest = Math.max(...comments.map((c) => new Date(c.createdAt).getTime()));
    if (latest > 0) markAsRead(teamName, taskId, latest);
  }, [teamName, taskId, comments]);

  // Re-mark when new comments arrive while section is visible
  useEffect(() => {
    markIfVisible();
  }, [markIfVisible]);

  // IntersectionObserver ref callback
  const refCallback = useCallback(
    (node: HTMLElement | null) => {
      // Cleanup previous
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }

      if (!node) {
        isVisibleRef.current = false;
        return;
      }

      observerRef.current = new IntersectionObserver(
        ([entry]) => {
          isVisibleRef.current = entry.isIntersecting;
          if (entry.isIntersecting) markIfVisible();
        },
        { threshold: 0.1 }
      );
      observerRef.current.observe(node);
    },
    [markIfVisible]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
    };
  }, []);

  return refCallback;
}
