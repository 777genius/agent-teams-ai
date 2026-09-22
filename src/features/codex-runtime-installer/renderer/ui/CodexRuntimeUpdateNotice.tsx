import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { normalizeVersion } from '@shared/utils/version';
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
  const { t: settingsT } = useAppTranslation('settings');

  if (!status?.installed || !status.updateAvailable || !status.latestVersion) {
    return null;
  }

  return (
    <div
      data-testid="codex-runtime-update-notice"
      className="mb-3 flex items-center gap-3 rounded-md border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-amber-100"
    >
      <AlertTriangle className="size-4 shrink-0 text-amber-200" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{commonT('updateDialog.updateAvailable')}</p>
        <p className="truncate text-[11px] opacity-85">
          Codex{' '}
          {settingsT('cliStatus.versionUpgrade', {
            current: status.version ? normalizeVersion(status.version) : '?',
            latest: status.latestVersion,
          })}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onUpdate} className="shrink-0">
        {dashboardT('cliStatus.actions.updateTo', { version: status.latestVersion })}
      </Button>
    </div>
  );
};
