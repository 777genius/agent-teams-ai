import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { CheckCircle2, Loader2 } from 'lucide-react';

import type { JSX } from 'react';

interface RuntimeProviderModelTestButtonProps {
  readonly modelId: string;
  readonly modelTarget: string;
  readonly disabled: boolean;
  readonly hasProjectContext: boolean;
  readonly testing: boolean;
  readonly onTest: () => void;
}

export const RuntimeProviderModelTestButton = ({
  modelId,
  modelTarget,
  disabled,
  hasProjectContext,
  testing,
  onTest,
}: RuntimeProviderModelTestButtonProps): JSX.Element => {
  const { t } = useAppTranslation('settings');
  const projectMissing = !hasProjectContext;
  const buttonDisabled = disabled || projectMissing || testing;
  const projectHint = projectMissing
    ? t('runtimeProvider.models.selectProjectBeforeTesting')
    : null;
  const button = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-8 min-w-20 justify-center"
      data-testid={`runtime-provider-model-test-${modelId}`}
      aria-label={`${t('runtimeProvider.actions.test')}: ${modelTarget}`}
      disabled={buttonDisabled}
      onClick={(event) => {
        event.stopPropagation();
        if (projectMissing) return;
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

  return (
    <div className="flex flex-col items-end gap-1">
      {projectHint ? (
        <TooltipProvider delayDuration={180}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">{button}</span>
            </TooltipTrigger>
            <TooltipContent side="left">{projectHint}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        button
      )}
      {projectHint ? (
        <p
          className="max-w-[14rem] text-right text-[11px] leading-4 text-amber-200"
          data-testid={`runtime-provider-model-test-hint-${modelId}`}
        >
          {projectHint}
        </p>
      ) : null}
    </div>
  );
};
