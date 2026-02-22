import { useEffect, useRef } from 'react';

import { getTeamColorSet } from '@renderer/constants/teamColors';

import type { MentionSuggestion } from '@renderer/types/mention';

interface MentionSuggestionListProps {
  suggestions: MentionSuggestion[];
  selectedIndex: number;
  onSelect: (s: MentionSuggestion) => void;
  query: string;
}

const HighlightedName = ({ name, query }: { name: string; query: string }): React.JSX.Element => {
  if (!query) return <span>{name}</span>;

  const lower = name.toLowerCase();
  const qLower = query.toLowerCase();
  const idx = lower.indexOf(qLower);

  if (idx < 0) return <span>{name}</span>;

  const before = name.slice(0, idx);
  const match = name.slice(idx, idx + query.length);
  const after = name.slice(idx + query.length);

  return (
    <span>
      {before}
      <span className="bg-[var(--color-accent)]/25 rounded text-[var(--color-text)]">{match}</span>
      {after}
    </span>
  );
};

export const MentionSuggestionList = ({
  suggestions,
  selectedIndex,
  onSelect,
  query,
}: MentionSuggestionListProps): React.JSX.Element => {
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (suggestions.length === 0) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-overlay)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
        No matching members
      </div>
    );
  }

  return (
    <ul
      ref={listRef}
      role="listbox"
      className="max-h-40 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-overlay)] py-1"
    >
      {suggestions.map((s, i) => {
        const colorSet = s.color ? getTeamColorSet(s.color) : null;
        const isSelected = i === selectedIndex;

        return (
          <li
            key={s.id}
            role="option"
            aria-selected={isSelected}
            className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
              isSelected
                ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)]'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]'
            }`}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(s);
            }}
          >
            <span
              className="inline-block size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: colorSet?.border ?? 'var(--color-text-muted)' }}
            />
            <span className="font-medium" style={colorSet ? { color: colorSet.text } : undefined}>
              <HighlightedName name={s.name} query={query} />
            </span>
            {s.subtitle ? (
              <span className="text-[var(--color-text-muted)]">{s.subtitle}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
};
