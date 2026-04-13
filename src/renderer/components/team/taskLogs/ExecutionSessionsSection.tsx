import { MemberLogsTab } from '@renderer/components/team/members/MemberLogsTab';
import { Loader2 } from 'lucide-react';

import type { ComponentProps } from 'react';

interface ExecutionSessionsSectionProps extends ComponentProps<typeof MemberLogsTab> {
  isRefreshing?: boolean;
  isPreviewOnline?: boolean;
}

export const ExecutionSessionsSection = ({
  isRefreshing = false,
  isPreviewOnline = false,
  ...props
}: ExecutionSessionsSectionProps): React.JSX.Element => {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
          Execution Sessions
        </h4>
        {isRefreshing || isPreviewOnline ? (
          <span className="flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
            {isPreviewOnline ? (
              <span
                className="pointer-events-none relative inline-flex size-2 shrink-0"
                title="Online"
              >
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
              </span>
            ) : null}
            {isRefreshing ? (
              <span className="flex items-center gap-1">
                <Loader2 size={10} className="animate-spin" />
                Updating...
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        Legacy session-centric transcript browsing and previews.
      </p>
      <MemberLogsTab {...props} />
    </div>
  );
};
