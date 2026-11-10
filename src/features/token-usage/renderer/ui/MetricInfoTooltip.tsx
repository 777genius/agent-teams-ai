import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { Info } from 'lucide-react';

import type React from 'react';

export const MetricInfoTooltip = ({
  label,
  help,
}: {
  label: string;
  help: string;
}): React.JSX.Element => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
        aria-label={`${label} info`}
      >
        <Info className="size-3.5" />
      </button>
    </TooltipTrigger>
    <TooltipContent side="top" align="end" className="max-w-80 text-pretty text-xs leading-relaxed">
      {help}
    </TooltipContent>
  </Tooltip>
);
