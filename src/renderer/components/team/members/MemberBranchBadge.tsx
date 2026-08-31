import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { GitBranch } from 'lucide-react';

export const MemberBranchBadge = ({ branch }: { branch?: string }): React.JSX.Element | null => {
  if (!branch) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          // Keyboard users can focus the branch to read its full tooltip.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          data-member-branch={branch}
          data-runtime-telemetry-exempt="true"
          aria-label={`Branch: ${branch}`}
          className="relative z-20 mt-1 flex w-full min-w-0 max-w-full items-center gap-0.5 text-[10px] text-[var(--color-text-muted)]"
        >
          <GitBranch size={10} className="shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm break-all text-xs">
        {branch}
      </TooltipContent>
    </Tooltip>
  );
};
