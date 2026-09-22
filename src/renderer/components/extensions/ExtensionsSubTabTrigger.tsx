import { TabsTrigger } from '@renderer/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { Info } from 'lucide-react';

import type { LucideIcon } from 'lucide-react';

interface ExtensionsSubTabTriggerProps {
  value: 'plugins' | 'mcp-servers' | 'skills' | 'api-keys';
  label: string;
  description: string;
  icon: LucideIcon;
}

export const ExtensionsSubTabTrigger = ({
  value,
  label,
  description,
  icon: Icon,
}: ExtensionsSubTabTriggerProps): React.JSX.Element => {
  return (
    <TabsTrigger
      value={value}
      className="relative gap-1.5 rounded-b-none pr-7 data-[state=active]:z-10 data-[state=active]:-mb-px data-[state=active]:bg-[var(--color-surface)] data-[state=active]:shadow-none data-[state=active]:after:absolute data-[state=active]:after:inset-x-0 data-[state=active]:after:-bottom-px data-[state=active]:after:h-1 data-[state=active]:after:bg-[var(--color-surface)] data-[state=active]:after:content-['']"
    >
      <Icon className="size-3.5" />
      {label}

      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="button"
            tabIndex={0}
            aria-label={`What is ${label}?`}
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.stopPropagation();
              }
            }}
            className="size-4.5 absolute right-2 top-1 z-10 inline-flex items-center justify-center rounded-full text-text-muted transition-colors hover:bg-[var(--color-surface)] hover:text-text"
          >
            <Info className="size-3" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64 text-pretty text-xs leading-relaxed">
          {description}
        </TooltipContent>
      </Tooltip>
    </TabsTrigger>
  );
};
