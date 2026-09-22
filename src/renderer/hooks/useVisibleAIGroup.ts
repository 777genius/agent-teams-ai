import { type RefObject, useCallback, useEffect, useRef } from 'react';

interface UseVisibleAIGroupOptions {
  onVisibleChange: (aiGroupId: string) => void;
  threshold?: number; // Default 0.5
  /** Optional scroll container to observe against (important for nested scroll areas). */
  rootRef?: RefObject<HTMLElement | null>;
}

interface UseVisibleAIGroupReturn {
  registerAIGroupRef: (aiGroupId: string) => (element: HTMLElement | null) => void;
}

export function useVisibleAIGroup(options: UseVisibleAIGroupOptions): UseVisibleAIGroupReturn {
  const { onVisibleChange, threshold = 0.5, rootRef } = options;

  // Track which AI Groups are currently visible (above threshold)
  const visibleAIGroupIds = useRef<Set<string>>(new Set());

  // Track element references by AI Group ID
  const elementRefs = useRef<Map<string, HTMLElement>>(new Map());

  // IntersectionObserver instance
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Calculate and report the topmost visible AI Group
  const updateTopmostVisible = useCallback(() => {
    if (visibleAIGroupIds.current.size === 0) {
      return;
    }

    let topmostId: string | null = null;
    let minTop = Infinity;

    // Find the AI Group with the smallest top position (closest to top of viewport)
    visibleAIGroupIds.current.forEach((id) => {
      const element = elementRefs.current.get(id);
      if (element) {
        const rect = element.getBoundingClientRect();
        if (rect.top < minTop) {
          minTop = rect.top;
          topmostId = id;
        }
      }
    });

    if (topmostId) {
      onVisibleChange(topmostId);
    }
  }, [onVisibleChange]);

  // Set up IntersectionObserver
  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        let changed = false;

        entries.forEach((entry) => {
          const aiGroupId = entry.target.getAttribute('data-aigroup-id');
          if (!aiGroupId) return;

          if (entry.isIntersecting && entry.intersectionRatio >= threshold) {
            // Element is visible above threshold
            if (!visibleAIGroupIds.current.has(aiGroupId)) {
              visibleAIGroupIds.current.add(aiGroupId);
              changed = true;
            }
          } else {
            // Element is not visible or below threshold
            if (visibleAIGroupIds.current.has(aiGroupId)) {
              visibleAIGroupIds.current.delete(aiGroupId);
              changed = true;
            }
          }
        });

        // Recalculate topmost visible AI Group if visibility changed
        if (changed) {
          updateTopmostVisible();
        }
      },
      {
        root: rootRef?.current ?? null,
        threshold,
        // Use root margin to start detection slightly before element enters viewport
        rootMargin: '0px',
      }
    );

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [threshold, updateTopmostVisible, rootRef]);

  // Register an AI Group element for observation
  const registerAIGroupRef = useCallback((aiGroupId: string) => {
    return (element: HTMLElement | null) => {
      const observer = observerRef.current;
      if (!observer) return;

      // Clean up previous element if it exists
      const prevElement = elementRefs.current.get(aiGroupId);
      if (prevElement) {
        observer.unobserve(prevElement);
        elementRefs.current.delete(aiGroupId);
        visibleAIGroupIds.current.delete(aiGroupId);
      }

      // Register new element
      if (element) {
        element.setAttribute('data-aigroup-id', aiGroupId);
        elementRefs.current.set(aiGroupId, element);
        observer.observe(element);
      }
    };
  }, []);

  return {
    registerAIGroupRef,
  };
}
