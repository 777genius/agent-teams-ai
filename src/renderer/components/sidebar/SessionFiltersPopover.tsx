import { useMemo } from 'react';

import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { getTeamProviderLabel } from '@renderer/utils/teamModelCatalog';
import { Filter } from 'lucide-react';

import type { TeamProviderId } from '@shared/types';

export const SESSION_PROVIDER_IDS = [
  'anthropic',
  'codex',
  'gemini',
] as const satisfies readonly TeamProviderId[];

interface SessionFiltersPopoverProps {
  selectedProviderIds: Set<TeamProviderId>;
  providerCounts: Record<TeamProviderId, number>;
  onProviderIdsChange: (next: Set<TeamProviderId>) => void;
}

export const SessionFiltersPopover = ({
  selectedProviderIds,
  providerCounts,
  onProviderIdsChange,
}: SessionFiltersPopoverProps): React.JSX.Element => {
  const activeCount = useMemo(
    () => (selectedProviderIds.size === SESSION_PROVIDER_IDS.length ? 0 : 1),
    [selectedProviderIds]
  );

  const toggleProvider = (providerId: TeamProviderId): void => {
    const next = new Set(selectedProviderIds);
    if (next.has(providerId)) {
      if (next.size === 1) {
        return;
      }
      next.delete(providerId);
    } else {
      next.add(providerId);
    }
    onProviderIdsChange(next);
  };

  const handleReset = (): void => {
    onProviderIdsChange(new Set<TeamProviderId>(SESSION_PROVIDER_IDS));
  };

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="relative h-7 px-2 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              aria-label="Filter sessions"
            >
              <Filter size={14} />
              {activeCount > 0 && (
                <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-blue-500 text-[10px] font-medium text-white">
                  {activeCount}
                </span>
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Filter sessions</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="border-b border-[var(--color-border)] p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Provider
            </p>
            <button
              type="button"
              className="text-[10px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
              disabled={activeCount === 0}
              onClick={handleReset}
            >
              Reset
            </button>
          </div>
          <div className="space-y-1">
            {SESSION_PROVIDER_IDS.map((providerId) => (
              <label
                key={providerId}
                className="flex cursor-pointer items-center gap-2 rounded-md p-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]"
              >
                <Checkbox
                  checked={selectedProviderIds.has(providerId)}
                  onCheckedChange={() => toggleProvider(providerId)}
                />
                <ProviderBrandLogo providerId={providerId} className="size-3.5 shrink-0" />
                <span className="flex-1 truncate">
                  {getTeamProviderLabel(providerId) ?? providerId}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                  {providerCounts[providerId]}
                </span>
              </label>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};
