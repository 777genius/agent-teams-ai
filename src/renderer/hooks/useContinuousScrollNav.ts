import { type RefObject, useCallback, useRef } from 'react';

import { waitForScrollEnd } from '@renderer/hooks/navigation/utils';

interface UseContinuousScrollNavOptions {
  scrollContainerRef: RefObject<HTMLElement | null>;
}

interface UseContinuousScrollNavReturn {
  scrollToFile: (filePath: string) => void;
  isProgrammaticScroll: RefObject<boolean | null>;
}

export function useContinuousScrollNav(
  options: UseContinuousScrollNavOptions
): UseContinuousScrollNavReturn {
  const { scrollContainerRef } = options;

  const isProgrammaticScroll = useRef(false);
  const scrollGeneration = useRef(0);

  const scrollToFile = useCallback(
    (filePath: string) => {
      const container = scrollContainerRef.current;
      if (!container) return;

      const section = container.querySelector<HTMLElement>(
        `[data-file-path="${CSS.escape(filePath)}"]`
      );
      if (!section) return;

      const gen = ++scrollGeneration.current;
      isProgrammaticScroll.current = true;

      section.scrollIntoView({ behavior: 'smooth', block: 'start' });

      void waitForScrollEnd(container, 500).then(() => {
        if (scrollGeneration.current === gen) {
          isProgrammaticScroll.current = false;
        }
      });
    },
    [scrollContainerRef]
  );

  return {
    scrollToFile,
    isProgrammaticScroll,
  };
}
