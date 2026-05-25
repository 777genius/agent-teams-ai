import { useAppTranslation } from '@features/localization/renderer';
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
  const { t } = useAppTranslation('team');
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
          {t('taskLogs.executionSessions.title')}
        </h4>
        {isRefreshing || isPreviewOnline ? (
          <span className="flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
            {isPreviewOnline ? (
              <span
                className="pointer-events-none relative inline-flex size-2 shrink-0"
                title={t('taskLogs.executionSessions.online')}
              >
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
              </span>
            ) : null}
            {isRefreshing ? (
              <span className="flex items-center gap-1">
                <Loader2 size={10} className="animate-spin" />
                {t('taskLogs.executionSessions.updating')}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        {t('taskLogs.executionSessions.description')}
      </p>
      <MemberLogsTab {...props} />
    </div>
  );
};
