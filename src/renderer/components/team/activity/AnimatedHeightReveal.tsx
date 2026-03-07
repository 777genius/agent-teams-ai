import { useCallback, useEffect, useRef, useState } from 'react';

import type { CSSProperties, MutableRefObject, PropsWithChildren, Ref } from 'react';

export const ENTRY_REVEAL_ANIMATION_MS = 700;
export const ENTRY_REVEAL_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

interface AnimatedHeightRevealProps extends PropsWithChildren {
  animate?: boolean;
  className?: string;
  style?: CSSProperties;
  containerRef?: Ref<HTMLDivElement>;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === 'function') {
    ref(value);
    return;
  }
  const mutableRef = ref as MutableRefObject<T | null>;
  mutableRef.current = value;
}

export const AnimatedHeightReveal = ({
  animate,
  className,
  style,
  containerRef,
  children,
}: AnimatedHeightRevealProps): JSX.Element => {
  const [shouldAnimateOnMount] = useState(() => Boolean(animate));
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [prefersReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  const [isExpanded, setIsExpanded] = useState(
    () => !animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  const setWrapperRef = useCallback(
    (node: HTMLDivElement | null) => {
      wrapperRef.current = node;
      assignRef(containerRef, node);
    },
    [containerRef]
  );

  const clearPendingAnimation = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!shouldAnimateOnMount || prefersReducedMotion) {
      return;
    }

    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = requestAnimationFrame(() => {
        setIsExpanded(true);
        animationFrameRef.current = null;
      });
    });

    return () => {
      clearPendingAnimation();
    };
  }, [clearPendingAnimation, shouldAnimateOnMount, prefersReducedMotion]);

  useEffect(
    () => () => {
      clearPendingAnimation();
    },
    [clearPendingAnimation]
  );

  const shouldTransition = shouldAnimateOnMount && !prefersReducedMotion && isExpanded;

  return (
    <div
      ref={setWrapperRef}
      className={className}
      style={{
        display: 'grid',
        gridTemplateRows: isExpanded ? '1fr' : '0fr',
        opacity: isExpanded ? 1 : 0,
        transition: shouldTransition
          ? [
              `grid-template-rows ${ENTRY_REVEAL_ANIMATION_MS}ms ${ENTRY_REVEAL_EASING}`,
              `opacity ${ENTRY_REVEAL_ANIMATION_MS}ms ease`,
            ].join(', ')
          : undefined,
        ...style,
      }}
    >
      <div style={{ minHeight: 0, overflow: 'hidden' }}>{children}</div>
    </div>
  );
};
