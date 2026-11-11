import { useLayoutEffect, useRef, useState } from 'react';

import { getOpenCodeModelGridColumnCount } from './teamModelSelectorUi';

import type { ReactNode, RefObject } from 'react';

/** Measure the actual picker width, including when it is nested in a teammate row. */
export function useModelGridColumnCount(ref: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const updateWidth = (): void => setWidth(element.clientWidth);
    updateWidth();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateWidth);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, [ref]);
  return getOpenCodeModelGridColumnCount(width);
}

export const ResponsiveModelGrid = ({
  children,
  className,
  'data-testid': testId,
}: Readonly<{
  children: ReactNode;
  className?: string;
  'data-testid'?: string;
}>): React.JSX.Element => {
  const ref = useRef<HTMLDivElement | null>(null);
  const columns = useModelGridColumnCount(ref);
  return (
    <div
      ref={ref}
      className={className}
      data-testid={testId}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {children}
    </div>
  );
};
