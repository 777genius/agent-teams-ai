import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { formatRuntimeVersionTransition } from '@shared/utils/version';
import { AlertTriangle } from 'lucide-react';

import type { CodexRuntimeStatus } from '../../contracts';

export interface CodexRuntimeUpdateNoticeProps {
  status: CodexRuntimeStatus | null | undefined;
  onUpdate: () => void;
}

export const CodexRuntimeUpdateNotice = ({
  status,
  onUpdate,
}: CodexRuntimeUpdateNoticeProps): React.JSX.Element | null => {
  const { t: commonT } = useAppTranslation('common');
  const { t: dashboardT } = useAppTranslation('dashboard');

  if (!status?.installed || !status.updateAvailable || !status.latestVersion) {
    return null;
  }

  return (
    <div
      data-testid="codex-runtime-update-notice"
      className="mb-3 flex items-center gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-900 dark:border-amber-300/30 dark:bg-amber-300/10 dark:text-amber-100"
    >
      <AlertTriangle className="size-4 shrink-0 text-amber-700 dark:text-amber-200" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{commonT('updateDialog.updateAvailable')}</p>
        <p className="truncate text-[11px] opacity-85">
          Codex {formatRuntimeVersionTransition(status.version ?? '?', status.latestVersion)}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onUpdate}
        className="shrink-0 text-amber-900 dark:text-amber-100"
      >
        {status.version
          ? `${dashboardT('cliStatus.runtimeInstall.update')} ${formatRuntimeVersionTransition(status.version, status.latestVersion)}`
          : dashboardT('cliStatus.actions.updateTo', { version: status.latestVersion })}
      </Button>
    </div>
  );
};
