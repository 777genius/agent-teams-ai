import React, { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import { RefreshCw } from 'lucide-react';

import type { CliProviderStatus } from '@shared/types';

interface RetryOpenCodeStatusProps {
  projectPath: string;
  providerStatus: Pick<
    CliProviderStatus,
    'providerId' | 'statusCheckOutcome' | 'statusCheckErrorCode'
  > | null;
  loading: boolean;
  disabled: boolean;
}

export const RetryOpenCodeStatus = ({
  projectPath,
  providerStatus,
  loading,
  disabled,
}: Readonly<RetryOpenCodeStatusProps>): React.JSX.Element | null => {
  const { t } = useAppTranslation('common');
  const fetchCliProviderStatus = useStore((state) => state.fetchCliProviderStatus);
  const [pending, setPending] = useState(false);
  const normalizedProjectPath = projectPath.trim();
  if (
    !normalizedProjectPath ||
    providerStatus?.providerId !== 'opencode' ||
    providerStatus.statusCheckOutcome !== 'transient_error' ||
    providerStatus.statusCheckErrorCode === 'project_missing'
  ) {
    return null;
  }
  const busy = loading || disabled || pending;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="mb-2 h-7 gap-1.5 px-2 text-[11px]"
      disabled={busy}
      onClick={async () => {
        if (busy) return;
        setPending(true);
        try {
          await fetchCliProviderStatus('opencode', {
            projectPath: normalizedProjectPath,
            silent: false,
            checkReason: 'manual_refresh',
          });
        } finally {
          setPending(false);
        }
      }}
    >
      <RefreshCw className="size-3" />
      OpenCode · {t('actions.retry')}
    </Button>
  );
};
