import { type RefObject, useCallback, useLayoutEffect, useRef } from 'react';

export function useTerminalTabReorderMotion({
  draggingTabId,
  orderedTabIdsKey,
  tabElementRefs,
}: Readonly<{
  draggingTabId: string | null;
  orderedTabIdsKey: string;
  tabElementRefs: RefObject<Map<string, HTMLDivElement>>;
}>): {
  captureTabRectsBeforeReorder: () => void;
  clearCapturedTabRects: () => void;
} {
  const tabRectsBeforeReorderRef = useRef<Map<string, DOMRect> | null>(null);
  const prefersReducedMotion = useCallback(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    []
  );

  const clearCapturedTabRects = useCallback((): void => {
    tabRectsBeforeReorderRef.current = null;
  }, []);

  const captureTabRectsBeforeReorder = useCallback((): void => {
    if (prefersReducedMotion()) {
      clearCapturedTabRects();
      return;
    }

    const rects = new Map<string, DOMRect>();
    tabElementRefs.current.forEach((element, tabId) => {
      rects.set(tabId, element.getBoundingClientRect());
    });
    tabRectsBeforeReorderRef.current = rects.size > 1 ? rects : null;
  }, [clearCapturedTabRects, prefersReducedMotion, tabElementRefs]);

  useLayoutEffect(() => {
    const previousRects = tabRectsBeforeReorderRef.current;
    if (!previousRects || prefersReducedMotion()) {
      clearCapturedTabRects();
      return;
    }

    clearCapturedTabRects();
    tabElementRefs.current.forEach((element, tabId) => {
      if (tabId === draggingTabId) {
        return;
      }

      const previousRect = previousRects.get(tabId);
      if (!previousRect) {
        return;
      }

      const nextRect = element.getBoundingClientRect();
      const deltaX = previousRect.left - nextRect.left;
      const deltaY = previousRect.top - nextRect.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) {
        return;
      }

      if (typeof element.animate !== 'function') {
        return;
      }

      element.getAnimations?.().forEach((animation) => animation.cancel());
      element.animate(
        [{ transform: `translate(${deltaX}px, ${deltaY}px)` }, { transform: 'translate(0, 0)' }],
        {
          duration: 180,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        }
      );
    });
  }, [
    clearCapturedTabRects,
    draggingTabId,
    orderedTabIdsKey,
    prefersReducedMotion,
    tabElementRefs,
  ]);

  return {
    captureTabRectsBeforeReorder,
    clearCapturedTabRects,
  };
}
