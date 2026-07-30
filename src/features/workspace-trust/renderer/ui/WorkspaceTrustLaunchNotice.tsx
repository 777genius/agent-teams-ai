import { useAppTranslation } from '@features/localization/renderer';
import { ShieldAlert } from 'lucide-react';

import {
  shouldShowWorkspaceTrustLaunchNotice,
  useWorkspaceTrustStatus,
} from '../hooks/useWorkspaceTrustStatus';

export const TrustLaunchNotice = (props: {
  on: boolean;
  cwd: string | null;
}): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const status = useWorkspaceTrustStatus({
    enabled: props.on,
    projectPath: props.cwd,
  });
  if (!shouldShowWorkspaceTrustLaunchNotice(status)) {
    return null;
  }

  return (
    <div
      role="note"
      className="absolute bottom-full right-0 mb-2 flex max-w-72 items-start gap-2 rounded-md border border-amber-400/25 bg-amber-400/[0.07] px-2.5 py-2 text-left"
    >
      <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber-300" aria-hidden="true" />
      <p className="min-w-0 text-[10px] leading-[1.35] text-amber-100/75">
        <span className="block font-medium text-amber-100">{t('launch.workspaceTrust.title')}</span>
        <span className="mt-0.5 block">{t('launch.workspaceTrust.description')}</span>
      </p>
    </div>
  );
};
