import { Component, type JSX, useCallback, useEffect, useRef, useState } from 'react';

import type { CSSProperties, PropsWithChildren, ReactNode, Ref } from 'react';

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
  const mutableRef = ref as { current: T | null };
  mutableRef.current = value;
}

function needsAnimatedWrapper(props: AnimatedHeightRevealProps): boolean {
  return Boolean(props.animate || props.className || props.style || props.containerRef);
}

const AnimatedHeightRevealPassthrough = ({ children }: PropsWithChildren): JSX.Element => (
  // eslint-disable-next-line react/jsx-no-useless-fragment -- preserves a DOM-free passthrough slot.
  <>{children}</>
);

class AnimatedHeightRevealSlot extends Component<AnimatedHeightRevealProps> {
  private hasRenderedInner = needsAnimatedWrapper(this.props);

  // eslint-disable-next-line sonarjs/function-return-type -- latch intentionally switches from passthrough to animated slot once.
  render(): ReactNode {
    const { animate, className, style, containerRef, children } = this.props;
    const needsWrapper = needsAnimatedWrapper(this.props);
    if (needsWrapper) {
      this.hasRenderedInner = true;
    }

    if (!this.hasRenderedInner) {
      return <AnimatedHeightRevealPassthrough>{children}</AnimatedHeightRevealPassthrough>;
    }

    return (
      <AnimatedHeightRevealInner
        animate={animate}
        className={className}
        style={style}
        containerRef={containerRef}
      >
        {children}
      </AnimatedHeightRevealInner>
    );
  }
}

export const AnimatedHeightReveal = (props: AnimatedHeightRevealProps): JSX.Element => {
  // Latch the inner (hook-bearing, animating) variant for the lifetime of this slot.
  // A call site that only passes `animate` (e.g. animate={isNewItem}) flips it true->false
  // on the render right after the item appears. Without the latch the returned element type
  // would switch from AnimatedHeightRevealInner to a bare Fragment on that flip, so React
  // would unmount the inner subtree mid-reveal - aborting the entry animation and remounting
  // the children (losing focus/internal state). Once the inner variant has rendered we keep
  // rendering it so the element type stays stable; items that never need it keep the
  // hook-free fast path.
  return (
    <AnimatedHeightRevealSlot
      animate={props.animate}
      className={props.className}
      style={props.style}
      containerRef={props.containerRef}
    >
      {props.children}
    </AnimatedHeightRevealSlot>
  );
};

const AnimatedHeightRevealInner = ({
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
  // Overflow must stay hidden during the height transition so the grid clip
  // actually works. Switch to visible only after the animation completes.
  const [overflowVisible, setOverflowVisible] = useState(
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

    // Switch overflow to visible after the height transition finishes
    // so popovers/tooltips inside can render outside bounds.
    const overflowTimer = setTimeout(() => {
      setOverflowVisible(true);
    }, ENTRY_REVEAL_ANIMATION_MS + 50);

    return () => {
      clearPendingAnimation();
      clearTimeout(overflowTimer);
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
      <div style={{ minHeight: 0, minWidth: 0, overflow: overflowVisible ? 'visible' : 'hidden' }}>
        {children}
      </div>
    </div>
  );
};
