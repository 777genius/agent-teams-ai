import { useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api, isElectronMode } from '@renderer/api';
import { AlertTriangle } from 'lucide-react';

import type { WindowsElevationStatus } from '@shared/types/api';

export const WindowsAdministratorBanner = (): React.JSX.Element | null => {
  const { t } = useAppTranslation('dashboard');
  const [status, setStatus] = useState<WindowsElevationStatus | null>(null);

  useEffect(() => {
    if (!isElectronMode()) {
      return undefined;
    }

    const getStatus = api.getWindowsElevationStatus;
    if (typeof getStatus !== 'function') {
      return undefined;
    }

    let cancelled = false;
    void getStatus()
      .then((nextStatus) => {
        if (!cancelled) {
          setStatus(nextStatus);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!status?.isWindows || status.isAdministrator !== false) {
    return null;
  }

  return (
    <div
      className="mb-6 flex items-start gap-3 rounded-lg border px-4 py-3"
      role="status"
      style={{
        borderColor: 'rgba(245, 158, 11, 0.35)',
        backgroundColor: 'rgba(245, 158, 11, 0.07)',
      }}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-amber-200">{t('windowsAdmin.title')}</div>
        <p className="mt-1 text-xs leading-5" style={{ color: 'var(--color-text-secondary)' }}>
          {t('windowsAdmin.description')}
        </p>
      </div>
    </div>
  );
};
