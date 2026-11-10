import { type RefObject, useCallback, useEffect, useRef } from 'react';

import type { FileChangeWithContent } from '@shared/types';

const MAX_CONCURRENT = 3;
const PRELOAD_COUNT = 5;

interface UseLazyFileContentOptions {
  teamName: string;
  memberName: string | undefined;
  filePaths: string[];
  scrollContainerRef: RefObject<HTMLElement | null>;
  fileContents: Record<string, FileChangeWithContent>;
  fileContentsLoading: Record<string, boolean>;
  fetchFileContent: (
    teamName: string,
    memberName: string | undefined,
    filePath: string
  ) => Promise<void>;
  enabled: boolean;
}

interface UseLazyFileContentReturn {
  registerLazyRef: (filePath: string) => (element: HTMLElement | null) => void;
}

export function useLazyFileContent(options: UseLazyFileContentOptions): UseLazyFileContentReturn {
  const { enabled, scrollContainerRef } = options;

  const activeLoads = useRef(new Set<string>());
  const pendingQueue = useRef<string[]>([]);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const elementRefs = useRef(new Map<string, HTMLElement>());

  // Stable ref to avoid stale closures in observer/processQueue callbacks
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const shouldLoad = useCallback((filePath: string): boolean => {
    const opts = optionsRef.current;
    if (opts.fileContents[filePath]) return false;
    if (opts.fileContentsLoading[filePath]) return false;
    if (activeLoads.current.has(filePath)) return false;
    return true;
  }, []);

  // Refs for loadFile/processQueue to avoid circular useCallback deps
  const loadFileRef = useRef<(fp: string) => Promise<void>>(undefined);
  const processQueueRef = useRef<() => void>(undefined);

  loadFileRef.current = async (filePath: string) => {
    if (!shouldLoad(filePath)) return;
    activeLoads.current.add(filePath);
    try {
      const opts = optionsRef.current;
      await opts.fetchFileContent(opts.teamName, opts.memberName, filePath);
    } finally {
      activeLoads.current.delete(filePath);
      processQueueRef.current?.();
    }
  };

  processQueueRef.current = () => {
    while (activeLoads.current.size < MAX_CONCURRENT && pendingQueue.current.length > 0) {
      const nextPath = pendingQueue.current.shift()!;
      if (shouldLoad(nextPath)) {
        void loadFileRef.current?.(nextPath);
      }
    }
  };

  const enqueueLoad = useCallback(
    (filePath: string) => {
      if (!shouldLoad(filePath)) return;

      if (activeLoads.current.size < MAX_CONCURRENT) {
        void loadFileRef.current?.(filePath);
      } else {
        if (!pendingQueue.current.includes(filePath)) {
          pendingQueue.current.push(filePath);
        }
      }
    },
    [shouldLoad]
  );

  // Preload first N files on mount
  useEffect(() => {
    if (!enabled) return;
    const toPreload = optionsRef.current.filePaths.slice(0, PRELOAD_COUNT);
    for (const fp of toPreload) {
      enqueueLoad(fp);
    }
  }, [enabled, enqueueLoad]);

  // IntersectionObserver for lazy loading
  useEffect(() => {
    if (!enabled || !scrollContainerRef.current) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const filePath = entry.target.getAttribute('data-lazy-file');
          if (!filePath) continue;
          enqueueLoad(filePath);
        }
      },
      {
        root: scrollContainerRef.current,
        rootMargin: '200% 0px 200% 0px',
        threshold: 0,
      }
    );

    // Observe already mounted elements
    for (const [, element] of elementRefs.current) {
      observerRef.current.observe(element);
    }

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [enabled, scrollContainerRef, enqueueLoad]);

  const registerLazyRef = useCallback((filePath: string) => {
    return (element: HTMLElement | null) => {
      const observer = observerRef.current;

      const prev = elementRefs.current.get(filePath);
      if (prev && observer) {
        observer.unobserve(prev);
      }
      elementRefs.current.delete(filePath);

      if (element) {
        element.setAttribute('data-lazy-file', filePath);
        elementRefs.current.set(filePath, element);
        if (observer) {
          observer.observe(element);
        }
      }
    };
  }, []);

  return { registerLazyRef };
}
