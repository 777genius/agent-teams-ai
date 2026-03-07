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
            className={`h-7 rounded-full px-2.5 text-xs font-medium ${
              isActive
                ? 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/40 hover:bg-blue-500/30'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {category}
            <span className="ml-1 text-text-muted">({count})</span>
          </Button>
        );
      })}
    </div>
  );
};
