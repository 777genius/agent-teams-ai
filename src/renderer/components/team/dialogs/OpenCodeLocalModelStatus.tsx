import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { Info } from 'lucide-react';

import type { OpenCodeLocalModelPresentation } from './openCodeLocalModelOverlay';

export const OpenCodeLocalModelStatus = ({
  presentation,
  providerDisplayName,
  statusMessage,
  canAdd,
  retry,
}: {
  presentation: OpenCodeLocalModelPresentation;
  providerDisplayName: string;
  statusMessage: string | null;
  canAdd: boolean;
  retry: boolean;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const statusLabel =
    presentation.status === 'ready'
      ? t('modelSelector.localModels.status.ready')
      : presentation.status === 'not_configured'
        ? t('modelSelector.localModels.status.notConfigured')
        : presentation.status === 'needs_verification'
          ? t('modelSelector.localModels.status.needsVerification')
          : presentation.status === 'incompatible'
            ? t('modelSelector.localModels.status.incompatible')
            : presentation.status === 'experimental'
              ? t('modelSelector.localModels.status.experimental')
              : t('modelSelector.localModels.status.adding');

  return (
    <>
      <span className="inline-flex items-center gap-1">
        <span
          data-testid={`team-model-selector-local-model-status-${presentation.status}`}
          className={cn(
            'inline-flex items-center justify-center rounded-full border px-1.5 py-0 text-[9px] font-semibold uppercase',
            presentation.status === 'ready'
              ? 'border-emerald-300/30 bg-emerald-300/10 text-emerald-100'
              : presentation.status === 'incompatible'
                ? 'border-red-300/30 bg-red-400/10 text-red-200'
                : presentation.status === 'experimental' ||
                    presentation.status === 'needs_verification'
                  ? 'border-amber-300/30 bg-amber-300/10 text-amber-200'
                  : 'border-cyan-300/30 bg-cyan-300/10 text-cyan-100'
          )}
        >
          {statusLabel}
        </span>
        {statusMessage ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span aria-label={statusMessage} className="inline-flex shrink-0">
                <Info
                  className="size-3 opacity-55 transition-opacity hover:opacity-85"
                  aria-hidden="true"
                />
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              sideOffset={6}
              collisionPadding={12}
              className="z-[140] max-w-[28rem] whitespace-normal break-words px-3 py-2 text-xs leading-relaxed"
            >
              <p>{statusMessage}</p>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </span>
      {presentation.status === 'not_configured' ? (
        <span className="w-full truncate text-left text-[9px] font-normal text-[var(--color-text-muted)]">
          {t('modelSelector.localModels.installedNotAdded', { provider: providerDisplayName })}
        </span>
      ) : null}
      {canAdd ? (
        <span
          data-testid="team-model-selector-local-model-add-and-test"
          className="mt-0.5 inline-flex items-center rounded border border-cyan-200/35 bg-cyan-300/10 px-1.5 py-0.5 text-[9px] font-semibold text-cyan-100"
        >
          {retry
            ? t('modelSelector.localModels.retryAddAndTest')
            : t('modelSelector.localModels.addAndTest')}
        </span>
      ) : null}
    </>
  );
};
