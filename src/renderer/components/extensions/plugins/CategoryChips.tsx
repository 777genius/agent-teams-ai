/**
 * CategoryChips — horizontal filter chips for plugin categories.
 */

import { useMemo } from 'react';

import { Button } from '@renderer/components/ui/button';
import { normalizeCategory } from '@shared/utils/extensionNormalizers';

import type { EnrichedPlugin } from '@shared/types/extensions';

interface CategoryChipsProps {
  plugins: EnrichedPlugin[];
  selected: string[];
  onToggle: (category: string) => void;
}

export const CategoryChips = ({
  plugins,
  selected,
  onToggle,
}: CategoryChipsProps): React.JSX.Element => {
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of plugins) {
      const cat = normalizeCategory(p.category);
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
    // Sort by count descending
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [plugins]);

  if (categoryCounts.length === 0) return <></>;

  return (
    <div className="flex flex-wrap gap-1.5">
      {categoryCounts.map(([category, count]) => {
        const isActive = selected.includes(category);
        return (
          <Button
            key={category}
            variant="ghost"
            size="sm"
            onClick={() => onToggle(category)}
            aria-pressed={isActive}
            className={`h-7 rounded-full border px-2.5 text-[11px] font-medium transition-all ${
              isActive
                ? 'border-blue-500/40 bg-blue-500/15 text-blue-300 shadow-sm'
                : 'hover:bg-surface-raised/60 border-border bg-transparent text-text-secondary hover:border-border-emphasis hover:text-text'
            }`}
          >
            <span>{category}</span>
            <span
              className={`ml-1.5 rounded-full px-1 py-0.5 text-[9px] leading-none ${
                isActive
                  ? 'bg-surface-raised text-text-secondary'
                  : 'bg-surface-raised/70 text-text-muted'
              }`}
            >
              {count}
            </span>
          </Button>
        );
      })}
    </div>
  );
};
