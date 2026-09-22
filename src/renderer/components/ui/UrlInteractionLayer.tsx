import * as React from 'react';

import { api } from '@renderer/api';
import { calculateInlineMatchPositions } from '@renderer/utils/chipUtils';
import { findUrlMatches } from '@renderer/utils/urlMatchUtils';
import { X } from 'lucide-react';

import type { InlineMatchPosition } from '@renderer/utils/chipUtils';
import type { TextMatch } from '@renderer/utils/urlMatchUtils';

interface UrlInteractionLayerProps {
  value: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  scrollTop: number;
  onRemove: (match: TextMatch) => void;
}

type PositionedUrlReference = InlineMatchPosition<TextMatch>;

function areUrlPositionsEquivalent(
  current: PositionedUrlReference[],
  next: PositionedUrlReference[]
): boolean {
  if (current.length !== next.length) return false;

  return current.every((position, index) => {
    const nextPosition = next[index];
    return (
      position.start === nextPosition.start &&
      position.end === nextPosition.end &&
      position.token === nextPosition.token &&
      position.top === nextPosition.top &&
      position.left === nextPosition.left &&
      position.width === nextPosition.width &&
      position.height === nextPosition.height &&
      position.item.start === nextPosition.item.start &&
      position.item.end === nextPosition.item.end &&
      position.item.value === nextPosition.item.value
    );
  });
}

export const UrlInteractionLayer = ({
  value,
  textareaRef,
  scrollTop,
  onRemove,
}: UrlInteractionLayerProps): React.JSX.Element | null => {
  const [positions, setPositions] = React.useState<PositionedUrlReference[]>([]);
  const positionsRef = React.useRef<PositionedUrlReference[]>([]);

  const commitPositions = React.useCallback((nextPositions: PositionedUrlReference[]) => {
    if (areUrlPositionsEquivalent(positionsRef.current, nextPositions)) return;
    positionsRef.current = nextPositions;
    setPositions(nextPositions);
  }, []);

  React.useLayoutEffect(() => {
    if (!value.includes('http://') && !value.includes('https://')) {
      commitPositions([]);
      return;
    }

    const textarea = textareaRef.current;
    if (!textarea) return;

    const matches = findUrlMatches(value).map((match) => ({
      item: match,
      start: match.start,
      end: match.end,
      token: match.value,
    }));

    commitPositions(calculateInlineMatchPositions(textarea, value, matches));
  }, [commitPositions, textareaRef, value]);

  if (positions.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      <div style={{ transform: `translateY(-${scrollTop}px)` }}>
        {positions.map((position, index) => (
          <div
            key={`${position.start}:${position.end}:${index}`}
            className="group pointer-events-auto absolute"
            style={{
              top: position.top,
              left: position.left,
              width: position.width,
              height: position.height,
            }}
          >
            <button
              type="button"
              className="absolute inset-0 cursor-pointer rounded-full bg-transparent p-0"
              onMouseDown={(e) => {
                if (e.metaKey || e.ctrlKey) return;
                e.preventDefault();
                const textarea = textareaRef.current;
                if (!textarea) return;

                textarea.focus();
                const clickOffsetX = e.clientX - e.currentTarget.getBoundingClientRect().left;
                const snapTo = clickOffsetX < position.width / 2 ? position.start : position.end;
                textarea.setSelectionRange(snapTo, snapTo);
              }}
              onClick={(e) => {
                if (!e.metaKey && !e.ctrlKey) return;
                e.preventDefault();
                e.stopPropagation();
                void api.openExternal(position.item.value);
              }}
              aria-label={`Open URL ${position.item.value}`}
            />
            <button
              type="button"
              className="pointer-events-none absolute -right-1 -top-1.5 z-30 flex size-3.5 items-center justify-center rounded-full border border-[var(--color-border-emphasis)] bg-[var(--color-surface-raised)] opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onRemove(position.item);
              }}
              aria-label={`Remove URL ${position.item.value}`}
            >
              <X size={8} className="text-[var(--color-text-muted)]" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
