import { type RefObject, useCallback, useEffect, useRef } from 'react';

interface UseVisibleFileSectionOptions {
  onVisibleFileChange: (filePath: string) => void;
  scrollContainerRef: RefObject<HTMLElement | null>;
  isProgrammaticScroll: RefObject<boolean | null>;
}

interface UseVisibleFileSectionReturn {
  registerFileSectionRef: (filePath: string) => (element: HTMLElement | null) => void;
}

export function useVisibleFileSection(
  options: UseVisibleFileSectionOptions
): UseVisibleFileSectionReturn {
  const { onVisibleFileChange, scrollContainerRef, isProgrammaticScroll } = options;

  const visibleFilePaths = useRef<Set<string>>(new Set());
  const elementRefs = useRef<Map<string, HTMLElement>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const updateTopmostVisible = useCallback(() => {
    if (isProgrammaticScroll.current) return;
    if (visibleFilePaths.current.size === 0) return;

    let topmostPath: string | null = null;
    let minTop = Infinity;

    visibleFilePaths.current.forEach((filePath) => {
      const element = elementRefs.current.get(filePath);
      if (element) {
        const rect = element.getBoundingClientRect();
        if (rect.top < minTop) {
          minTop = rect.top;
          topmostPath = filePath;
        }
      }
    });

    if (topmostPath) {
      onVisibleFileChange(topmostPath);
    }
  }, [onVisibleFileChange, isProgrammaticScroll]);

  const debouncedUpdate = useCallback(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(updateTopmostVisible, 100);
  }, [updateTopmostVisible]);

  useEffect(() => {
    if (!scrollContainerRef.current) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        let changed = false;

        for (const entry of entries) {
          const filePath = entry.target.getAttribute('data-file-path');
          if (!filePath) continue;

          if (entry.isIntersecting && entry.intersectionRatio >= 0.1) {
            if (!visibleFilePaths.current.has(filePath)) {
              visibleFilePaths.current.add(filePath);
              changed = true;
            }
          } else {
            if (visibleFilePaths.current.has(filePath)) {
              visibleFilePaths.current.delete(filePath);
              changed = true;
            }
          }
        }

        if (changed) {
          debouncedUpdate();
        }
      },
      {
        root: scrollContainerRef.current,
        threshold: 0.1,
        rootMargin: '0px',
      }
    );

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      clearTimeout(debounceRef.current);
    };
  }, [scrollContainerRef, debouncedUpdate]);

  const registerFileSectionRef = useCallback((filePath: string) => {
    return (element: HTMLElement | null) => {
      const observer = observerRef.current;
      if (!observer) return;

      const prev = elementRefs.current.get(filePath);
      if (prev) {
        observer.unobserve(prev);
        elementRefs.current.delete(filePath);
        visibleFilePaths.current.delete(filePath);
      }

      if (element) {
        element.setAttribute('data-file-path', filePath);
        elementRefs.current.set(filePath, element);
        observer.observe(element);
      }
    };
  }, []);

  return { registerFileSectionRef };
}
