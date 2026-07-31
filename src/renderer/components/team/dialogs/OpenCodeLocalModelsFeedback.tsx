import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export const OpenCodeLocalModelsTabStatus = ({
  loading,
  error,
  detectedCount,
  configuredCount,
}: {
  loading: boolean;
  error: string | null;
  detectedCount: number;
  configuredCount: number;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1 text-[9px]',
        detectedCount > 0 ? 'text-cyan-200/75' : 'text-[var(--color-text-muted)]'
      )}
    >
      {loading ? (
        '...'
      ) : error ? (
        <span className="inline-flex items-center gap-1 text-amber-200/80">
          <AlertTriangle className="size-3" aria-hidden="true" />
          {t('modelSelector.localModels.check')}
        </span>
      ) : detectedCount > 0 || configuredCount > 0 ? (
        t('modelSelector.localModels.counts', {
          detected: detectedCount,
          configured: configuredCount,
        })
      ) : (
        t('modelSelector.localModels.none')
      )}
    </span>
  );
};

export const OpenCodeLocalModelsLookupError = ({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <div
      data-testid="team-model-selector-local-provider-config-error"
      className="mb-3 flex items-start gap-2 rounded-md border border-amber-300/25 bg-amber-300/[0.07] px-3 py-2 text-[11px] leading-relaxed text-amber-100"
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-200" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t('modelSelector.localModels.lookupErrorTitle')}</p>
        <p className="mt-0.5 text-amber-100/80">
          {error} {t('modelSelector.localModels.lookupErrorFallback')}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 shrink-0 gap-1.5 border-amber-200/25 bg-transparent px-2 text-[11px] text-amber-100 hover:bg-amber-200/10 hover:text-amber-50"
        onClick={onRetry}
      >
        <RefreshCw className="size-3" />
        {t('modelSelector.localModels.retry')}
      </Button>
    </div>
  );
};
