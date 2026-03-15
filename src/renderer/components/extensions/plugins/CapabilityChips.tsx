/**
 * CapabilityChips — filter chips for plugin capability types.
 */

import { useMemo } from 'react';

import { Button } from '@renderer/components/ui/button';
import { getCapabilityLabel, inferCapabilities } from '@shared/utils/extensionNormalizers';

import type { EnrichedPlugin, PluginCapability } from '@shared/types/extensions';

const ALL_CAPABILITIES: PluginCapability[] = ['lsp', 'mcp', 'agent', 'command', 'hook', 'skill'];

interface CapabilityChipsProps {
  plugins: EnrichedPlugin[];
  selected: PluginCapability[];
  onToggle: (capability: PluginCapability) => void;
}

export const CapabilityChips = ({
  plugins,
  selected,
  onToggle,
}: CapabilityChipsProps): React.JSX.Element => {
  const capabilityCounts = useMemo(() => {
    const counts = new Map<PluginCapability, number>();
    for (const p of plugins) {
      const caps = inferCapabilities(p);
      for (const cap of caps) {
        counts.set(cap, (counts.get(cap) ?? 0) + 1);
      }
    }
    return counts;
  }, [plugins]);

  return (
    <div className="flex flex-wrap gap-1.5">
      {ALL_CAPABILITIES.map((cap) => {
        const count = capabilityCounts.get(cap) ?? 0;
        if (count === 0) return null;
        const isActive = selected.includes(cap);
        return (
          <Button
            key={cap}
            variant="ghost"
            size="sm"
            onClick={() => onToggle(cap)}
            aria-pressed={isActive}
            className={`h-7 rounded-full border px-2.5 text-[11px] font-medium transition-all ${
              isActive
                ? 'border-purple-500/40 bg-purple-500/15 text-purple-300 shadow-sm'
                : 'hover:bg-surface-raised/60 border-border bg-transparent text-text-secondary hover:border-border-emphasis hover:text-text'
            }`}
          >
            <span>{getCapabilityLabel(cap)}</span>
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
