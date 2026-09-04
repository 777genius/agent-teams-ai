import { useAppTranslation } from '@features/localization/renderer';

import { shouldShowWorkspaceTrustLaunchNotice } from '../view-models/workspaceTrustLaunchNotice';

import type { WorkspaceTrustDisplayStatus } from '../hooks/useWorkspaceTrustStatus';

export const WorkspaceTrustLaunchNotice = (props: {
  status: WorkspaceTrustDisplayStatus;
}): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  if (!shouldShowWorkspaceTrustLaunchNotice(props.status)) {
    return null;
  }

  return (
    <p
      role="note"
      className="max-w-sm text-right text-xs leading-relaxed text-[var(--color-text-muted)]"
    >
      {t('launch.workspaceTrust.description')}
    </p>
  );
};
