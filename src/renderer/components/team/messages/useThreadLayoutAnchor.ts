import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

interface LayoutAnchor {
  rowKey: string | null;
  offset: number;
  scrollTop: number;
}

const MAX_CORRECTION_FRAMES = 3;
const CORRECTION_TOLERANCE_PX = 2;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

export function useThreadLayoutAnchor(
  scrollElementRef: RefObject<HTMLDivElement | null>,
  identity: string
): { beginLayoutTransition: () => void; observationEnabled: boolean } {
  const anchorRef = useRef<LayoutAnchor | null>(null);
  const frameRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const [generation, setGeneration] = useState(0);
  const [observationEnabled, setObservationEnabled] = useState(true);

  const cancel = useCallback((): void => {
    generationRef.current += 1;
    anchorRef.current = null;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    const scroll = scrollElementRef.current;
    if (scroll) scroll.style.removeProperty('overflow-anchor');
    setObservationEnabled(true);
  }, [scrollElementRef]);

  const beginLayoutTransition = useCallback((): void => {
    const scroll = scrollElementRef.current;
    if (!scroll) return;
    const scrollRect = scroll.getBoundingClientRect();
    const rows = Array.from(scroll.querySelectorAll<HTMLElement>('[data-timeline-row-key]'));
    const firstReadable = rows.find(
      (row) => row.getBoundingClientRect().bottom > scrollRect.top + 4
    );
    anchorRef.current = {
      rowKey: firstReadable?.dataset.timelineRowKey ?? null,
      offset: firstReadable ? firstReadable.getBoundingClientRect().top - scrollRect.top : 0,
      scrollTop: scroll.scrollTop,
    };
    scroll.style.setProperty('overflow-anchor', 'none');
    setObservationEnabled(false);
    const nextGeneration = generationRef.current + 1;
    generationRef.current = nextGeneration;
    setGeneration(nextGeneration);
  }, [scrollElementRef]);

  useLayoutEffect(() => {
    if (generation === 0) return;
    const operation = generation;
    const anchor = anchorRef.current;
    const scroll = scrollElementRef.current;
    if (!anchor || !scroll) {
      cancel();
      return;
    }

    let frameCount = 0;
    const finish = (): void => {
      if (generationRef.current !== operation) return;
      anchorRef.current = null;
      frameRef.current = null;
      scroll.style.removeProperty('overflow-anchor');
      setObservationEnabled(true);
    };
    const correct = (): void => {
      if (generationRef.current !== operation || scrollElementRef.current !== scroll) return;
      frameCount += 1;
      const row = anchor.rowKey
        ? Array.from(scroll.querySelectorAll<HTMLElement>('[data-timeline-row-key]')).find(
            (candidate) => candidate.dataset.timelineRowKey === anchor.rowKey
          )
        : undefined;
      if (!row) {
        scroll.scrollTop = Math.min(
          anchor.scrollTop,
          Math.max(0, scroll.scrollHeight - scroll.clientHeight)
        );
        finish();
        return;
      }
      const currentOffset = row.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      const correction = currentOffset - anchor.offset;
      if (Math.abs(correction) <= CORRECTION_TOLERANCE_PX || frameCount >= MAX_CORRECTION_FRAMES) {
        finish();
        return;
      }
      scroll.scrollTop += correction;
      frameRef.current = requestAnimationFrame(correct);
    };

    const cancelForUserInput = (event: Event): void => {
      if (
        event instanceof KeyboardEvent &&
        (!SCROLL_KEYS.has(event.key) ||
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement ||
          (event.target instanceof HTMLElement && event.target.isContentEditable))
      ) {
        return;
      }
      cancel();
    };
    scroll.addEventListener('wheel', cancelForUserInput, { passive: true });
    scroll.addEventListener('touchstart', cancelForUserInput, { passive: true });
    scroll.addEventListener('pointerdown', cancelForUserInput);
    scroll.addEventListener('keydown', cancelForUserInput);
    frameRef.current = requestAnimationFrame(correct);
    return () => {
      scroll.removeEventListener('wheel', cancelForUserInput);
      scroll.removeEventListener('touchstart', cancelForUserInput);
      scroll.removeEventListener('pointerdown', cancelForUserInput);
      scroll.removeEventListener('keydown', cancelForUserInput);
    };
  }, [cancel, generation, scrollElementRef]);

  useEffect(() => cancel, [cancel, identity]);

  return { beginLayoutTransition, observationEnabled };
}
