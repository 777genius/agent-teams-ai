import React, { type ComponentProps, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { ProviderActivityStatusStrip } from '@renderer/components/common/ProviderActivityStatusStrip';
import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import { RefreshCw } from 'lucide-react';

import type { CliProviderStatus } from '@shared/types';

type CreateTeamProviderStatusStripProps = ComponentProps<typeof ProviderActivityStatusStrip> & {
  projectPath: string;
  disabled: boolean;
};

export const CreateTeamProviderStatusStrip = ({
  projectPath,
  disabled,
  ...stripProps
}: Readonly<CreateTeamProviderStatusStripProps>): React.JSX.Element => (
  <>
    {/* eslint-disable-next-line react/jsx-props-no-spreading -- Preserve the common strip's presentation props. */}
    <ProviderActivityStatusStrip {...stripProps} />
    {stripProps.providerIds?.includes('opencode') ? (
      <RetryOpenCodeStatus
        projectPath={projectPath}
        providerStatus={stripProps.providerStatusOverride ?? null}
        loading={
          stripProps.cliProviderStatusLoading.opencode === true ||
          stripProps.forceLoadingProviderIds?.includes('opencode') === true
        }
        disabled={disabled}
      />
    ) : null}
  </>
);

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
