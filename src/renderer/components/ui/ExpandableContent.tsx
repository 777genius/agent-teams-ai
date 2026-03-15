import { useCallback, useRef, useState } from 'react';

import { ChevronDown, ChevronUp } from 'lucide-react';

const DEFAULT_COLLAPSED_HEIGHT = 200; // px

interface ExpandableContentProps {
  /** Content to render inside the expandable container. */
  children: React.ReactNode;
  /** Maximum height (px) before truncation kicks in. Default: 200. */
  collapsedHeight?: number;
  /** Extra className applied to the outermost wrapper. */
  className?: string;
  /** Called when the user clicks "Show more" to expand the content. */
  onExpand?: () => void;
}

/**
 * Generic expand/collapse wrapper with:
 * - Collapsed: content clipped at `collapsedHeight`, mask-image fade, "Show more" button
 * - Expanded: full content, sticky "Show less" button at viewport bottom
 *
 * Uses CSS `mask-image` for the fade so it works on any background color
 * (zebra stripes, card backgrounds, etc.) without needing to know the bg color.
 */
export const ExpandableContent = ({
  children,
  collapsedHeight = DEFAULT_COLLAPSED_HEIGHT,
  className,
  onExpand,
}: ExpandableContentProps): React.JSX.Element => {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [needsTruncation, setNeedsTruncation] = useState(false);

  // Measure content height via callback ref — re-runs when children change
  const measureRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) {
        requestAnimationFrame(() => {
          setNeedsTruncation(node.scrollHeight > collapsedHeight);
        });
      }
    },
    // Re-measure when children identity changes (content prop in callers)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- children identity triggers re-measure
    [children, collapsedHeight]
  );

  const handleCollapse = useCallback(() => {
    setExpanded(false);
    anchorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  return (
    <div ref={anchorRef} className={className}>
      <div
        ref={measureRef}
        className="relative"
        style={
          !expanded && needsTruncation
            ? {
                maxHeight: collapsedHeight,
                overflow: 'hidden',
                WebkitMaskImage: 'linear-gradient(to bottom, black 60%, transparent 100%)',
                maskImage: 'linear-gradient(to bottom, black 60%, transparent 100%)',
              }
            : undefined
        }
      >
        {children}
      </div>

      {/* Show more */}
      {!expanded && needsTruncation ? (
        <div className="relative flex justify-center" style={{ marginTop: -15 }}>
          <button
            type="button"
            className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)] shadow-sm transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(true);
              onExpand?.();
            }}
          >
            <ChevronDown size={12} />
            Show more
          </button>
        </div>
      ) : null}

      {/* Sticky Show less */}
      {expanded && needsTruncation ? (
        <div className="sticky bottom-0 z-10 flex justify-center pb-1 pt-2">
          <button
            type="button"
            className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-[11px] text-[var(--color-text-muted)] shadow-sm transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text-secondary)]"
            onClick={(e) => {
              e.stopPropagation();
              handleCollapse();
            }}
          >
            <ChevronUp size={12} />
            Show less
          </button>
        </div>
      ) : null}
    </div>
  );
};
