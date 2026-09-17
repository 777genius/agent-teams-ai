import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { CheckCircle2, Loader2 } from 'lucide-react';

import type { JSX } from 'react';

interface RuntimeProviderModelTestButtonProps {
  readonly modelId: string;
  readonly modelTarget: string;
  readonly disabled: boolean;
  readonly testing: boolean;
  readonly onTest: () => void;
}

export const RuntimeProviderModelTestButton = ({
  modelId,
  modelTarget,
  disabled,
  testing,
  onTest,
}: RuntimeProviderModelTestButtonProps): JSX.Element => {
  const { t } = useAppTranslation('settings');
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-8 min-w-20 justify-center"
      data-testid={`runtime-provider-model-test-${modelId}`}
      aria-label={`${t('runtimeProvider.actions.test')}: ${modelTarget}`}
      disabled={disabled || testing}
      onClick={(event) => {
        event.stopPropagation();
        if (disabled || testing) return;
        onTest();
      }}
    >
      {testing ? (
        <Loader2 className="mr-1 size-3.5 animate-spin" />
      ) : (
        <CheckCircle2 className="mr-1 size-3.5" />
      )}
      {t('runtimeProvider.actions.test')}
    </Button>
  );
};
