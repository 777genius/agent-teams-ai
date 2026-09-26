import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';
import { AlertTriangle, CheckCircle2, Info, RefreshCw } from 'lucide-react';

export interface ProviderStatusPanelPresentation {
  tone: 'ready' | 'info' | 'warning';
  title: string;
  summary: string | null;
  message: string;
  reason: string | null;
  actionLabel: string | null;
}

// Light-first tones with dark variants: the dark values match the original
// palette, the light values keep the same hue at a readable contrast.
const PANEL_TONE_CLASSES: Record<ProviderStatusPanelPresentation['tone'], string> = {
  ready:
    'border-emerald-600/30 bg-emerald-500/10 text-emerald-900 dark:border-emerald-300/30 dark:bg-emerald-300/10 dark:text-emerald-100',
  info: 'border-sky-600/30 bg-sky-500/10 text-sky-900 dark:border-sky-300/25 dark:bg-sky-300/[0.07] dark:text-sky-100',
  warning:
    'border-amber-600/30 bg-amber-500/10 text-amber-900 dark:border-amber-300/30 dark:bg-amber-300/10 dark:text-amber-100',
};

export const ProviderStatusPanel = ({
  panel,
  retryAction,
  onAction,
}: {
  panel: ProviderStatusPanelPresentation;
  retryAction: boolean;
  onAction: () => void;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <div
      data-testid="team-model-selector-provider-status"
      data-tone={panel.tone}
      className={cn(
        'mb-3 rounded-md border px-3 py-2 text-[11px] leading-relaxed',
        PANEL_TONE_CLASSES[panel.tone]
      )}
    >
      <div className="flex items-start gap-2">
        {panel.tone === 'ready' ? (
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-700 dark:text-emerald-200" />
        ) : panel.tone === 'info' ? (
          <Info className="mt-0.5 size-3.5 shrink-0 text-sky-700 dark:text-sky-200" />
        ) : (
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-200" />
        )}
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{panel.title}</p>
          {panel.summary ? <p className="opacity-90">{panel.summary}</p> : null}
          <p>{panel.message}</p>
          {panel.reason ? (
            <p className="opacity-90">{t('modelSelector.reason', { reason: panel.reason })}</p>
          ) : null}
          {panel.actionLabel ? (
            <button
              type="button"
              data-testid={retryAction ? 'team-model-selector-opencode-runtime-retry' : undefined}
              className="mt-1 inline-flex h-7 items-center rounded-md border border-emerald-600/40 bg-emerald-500/10 px-2.5 text-[11px] font-medium text-emerald-800 transition-colors hover:border-emerald-600/60 hover:bg-emerald-500/15 dark:border-emerald-300/35 dark:bg-emerald-300/10 dark:text-emerald-100 dark:hover:border-emerald-200/50 dark:hover:bg-emerald-300/15"
              onClick={onAction}
            >
              {panel.actionLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export const OpenCodeCatalogRefreshErrorCard = ({
  hasProviderDirectoryCache,
  hasProviderTabs,
  onRetry,
}: {
  hasProviderDirectoryCache: boolean;
  hasProviderTabs: boolean;
  onRetry: () => void;
}): React.JSX.Element => (
  <div
    data-testid="team-model-selector-opencode-catalog-refresh-error"
    className="mb-3 flex items-start gap-2 rounded-md border border-amber-600/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-900 dark:border-amber-300/25 dark:bg-amber-300/[0.07] dark:text-amber-100"
  >
    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-200" />
    <div className="min-w-0 flex-1">
      <p className="font-medium">OpenCode models could not be refreshed</p>
      <p className="mt-0.5 text-amber-900/80 dark:text-amber-100/80">
        {hasProviderDirectoryCache ? 'Provider connections are known from the dashboard. ' : ''}
        {hasProviderTabs
          ? 'The last loaded model catalog remains visible.'
          : 'Local models remain available while you retry.'}
      </p>
    </div>
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 shrink-0 gap-1.5 border-amber-600/35 bg-transparent px-2 text-[11px] text-amber-900 hover:bg-amber-500/10 hover:text-amber-950 dark:border-amber-200/25 dark:text-amber-100 dark:hover:bg-amber-200/10 dark:hover:text-amber-50"
      onClick={onRetry}
    >
      <RefreshCw className="size-3" />
      Retry
    </Button>
  </div>
);
