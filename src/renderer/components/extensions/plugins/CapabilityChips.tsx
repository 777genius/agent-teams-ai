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
            className={`h-7 rounded-full px-2.5 text-xs font-medium ${
              isActive
                ? 'bg-purple-500/20 text-purple-400 ring-1 ring-purple-500/40 hover:bg-purple-500/30'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {getCapabilityLabel(cap)}
            <span className="ml-1 text-text-muted">({count})</span>
          </Button>
        );
      })}
    </div>
  );
};
