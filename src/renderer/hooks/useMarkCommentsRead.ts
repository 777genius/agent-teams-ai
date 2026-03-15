import { useRef } from 'react';

/**
 * Provides a stable ref callback for the comments container.
 *
 * Previously this hook auto-marked all comments as read on mount via
 * a useEffect. That behavior has been replaced by viewport-based
 * tracking (useViewportCommentRead) which only marks comments read
 * when they are scrolled into view inside the dialog.
 *
 * This hook is kept for API compatibility with TaskCommentsSection
 * (the ref callback is still attached to the container element).
 */
export function useMarkCommentsRead(
  _teamName: string,
  _taskId: string,
  _comments: unknown[]
): (node: HTMLElement | null) => void {
  const nodeRef = useRef<HTMLElement | null>(null);

  // Stable ref callback (no dependencies — just stores the node)
  const refCallback = useRef((node: HTMLElement | null) => {
    nodeRef.current = node;
  }).current;

  return refCallback;
}
