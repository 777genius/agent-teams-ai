import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';

import type { TeamProviderId } from '@shared/types';

interface OpenCodeAuthRequiredModelsNoticeProps {
  count: number;
  expanded: boolean;
  onToggle: () => void;
  onOpenProviderSettings?: (providerId: TeamProviderId) => void;
}

export const OpenCodeAuthRequiredModelsNotice = ({
  count,
  expanded,
  onToggle,
  onOpenProviderSettings,
}: OpenCodeAuthRequiredModelsNoticeProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');

  return (
    <div
      data-testid="team-model-selector-opencode-auth-required"
      className="mb-3 rounded-md border border-sky-300/25 bg-sky-300/[0.07] px-3 py-2 text-[11px] text-[var(--color-text-secondary)]"
    >
      <p>{t('modelSelector.openCodeStatus.authRequiredModels', { count })}</p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-[11px] underline underline-offset-2"
          onClick={onToggle}
        >
          {t(
            expanded
              ? 'modelSelector.openCodeStatus.hideAuthRequired'
              : 'modelSelector.openCodeStatus.showAuthRequired'
          )}
        </Button>
        {onOpenProviderSettings ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-[11px] underline underline-offset-2"
            onClick={() => onOpenProviderSettings('opencode')}
          >
            {t('provisioning.providerStatus.openProviderSettings', { provider: 'OpenCode' })}
          </Button>
        ) : null}
      </div>
    </div>
  );
};
