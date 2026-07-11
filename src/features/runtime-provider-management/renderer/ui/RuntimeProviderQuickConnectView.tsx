import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
  Settings2,
} from 'lucide-react';

import { ProviderBrandIcon } from './providerBrandIcons';

import type {
  RuntimeProviderQuickConnectGate,
  RuntimeProviderQuickPlanState,
} from '../../core/domain';
import type { OpenCodeRuntimeStatus } from '@shared/types';
import type { JSX, ReactNode } from 'react';

export interface RuntimeProviderQuickCardViewModel {
  id: string;
  providerId: string;
  displayName: string;
  description: string;
  state: RuntimeProviderQuickPlanState;
  stateLabel: string;
  actionLabel: string | null;
  onAction: (() => void) | null;
  progress?: {
    percent: number;
    detail: string | null;
  } | null;
}

interface RuntimeProviderQuickConnectViewProps {
  cards: readonly RuntimeProviderQuickCardViewModel[];
  gate: RuntimeProviderQuickConnectGate;
  runtimeStatus: OpenCodeRuntimeStatus | null;
  directoryError: string | null;
  onInstallOpenCode: () => void;
  onRetryDirectory: () => void;
  onBrowseProviders: () => void;
}

function cardStateClassName(state: RuntimeProviderQuickPlanState): string {
  switch (state) {
    case 'connected':
      return 'text-emerald-300';
    case 'update-required':
    case 'different-credential':
    case 'manual':
      return 'text-amber-300';
    case 'unavailable':
      return 'text-[var(--color-text-muted)]';
    case 'checking':
    case 'connectable':
      return 'text-sky-300';
  }
}

const CardStateIcon = ({ state }: { state: RuntimeProviderQuickPlanState }): JSX.Element => {
  if (state === 'checking') {
    return <Loader2 className="size-3 animate-spin" />;
  }
  if (state === 'connected') {
    return <CheckCircle2 className="size-3" />;
  }
  if (state === 'update-required' || state === 'different-credential' || state === 'manual') {
    return <AlertTriangle className="size-3" />;
  }
  return <span className="size-1.5 rounded-full bg-current" />;
};

const QuickProviderCard = ({ card }: { card: RuntimeProviderQuickCardViewModel }): JSX.Element => {
  return (
    <article
      data-testid={`provider-quick-card-${card.id}`}
      className="relative grid min-h-[4.125rem] grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[auto_auto] content-center items-center gap-x-2.5 gap-y-0 overflow-hidden rounded-lg border p-2.5 transition-colors hover:border-[var(--color-border-emphasis)]"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'color-mix(in srgb, var(--color-surface-raised) 76%, transparent)',
      }}
    >
      <div className="row-span-2 self-center">
        <ProviderBrandIcon
          provider={{ providerId: card.providerId, displayName: card.displayName }}
          size="large"
        />
      </div>
      <div className="col-span-2 col-start-2 row-start-1 flex min-w-0 items-center gap-1">
        <p className="truncate text-xs font-semibold" style={{ color: 'var(--color-text)' }}>
          {card.displayName}
        </p>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`About ${card.displayName}`}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70"
            >
              <Info className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            align="start"
            className="max-w-72 text-pretty text-xs leading-relaxed"
          >
            {card.description}
          </TooltipContent>
        </Tooltip>
      </div>
      <span
        className={cn(
          'col-start-2 row-start-2 flex min-w-0 -translate-y-0.5 items-center gap-1.5 text-[10px] font-medium',
          !card.actionLabel || !card.onAction ? 'col-span-2' : null,
          cardStateClassName(card.state)
        )}
        title={card.stateLabel}
      >
        <CardStateIcon state={card.state} />
        <span className="truncate">{card.stateLabel}</span>
      </span>
      {card.actionLabel && card.onAction ? (
        <Button
          type="button"
          data-testid={`provider-quick-action-${card.id}`}
          variant="outline"
          size="sm"
          className="col-start-3 row-start-2 h-6 shrink-0 -translate-y-0.5 px-2 text-[10px]"
          onClick={card.onAction}
        >
          {card.state === 'update-required' ? (
            <Download className="mr-1 size-3" />
          ) : (
            <Settings2 className="mr-1 size-3" />
          )}
          {card.actionLabel}
        </Button>
      ) : null}
      {card.progress ? (
        <div
          className="absolute inset-x-0 bottom-0 h-0.5 bg-black/20"
          title={card.progress.detail ?? `${card.progress.percent}%`}
        >
          <div
            role="progressbar"
            aria-label={`${card.displayName} setup progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={card.progress.percent}
            className="h-full bg-sky-400 transition-[width] duration-300"
            style={{ width: `${Math.max(0, Math.min(100, card.progress.percent))}%` }}
          />
        </div>
      ) : null}
    </article>
  );
};

const OpenCodePrerequisite = ({
  gate,
  runtimeStatus,
  onInstall,
}: {
  gate: RuntimeProviderQuickConnectGate;
  runtimeStatus: OpenCodeRuntimeStatus | null;
  onInstall: () => void;
}): JSX.Element | null => {
  const { t } = useAppTranslation('dashboard');
  if (gate === 'ready') {
    return null;
  }

  const busy = gate === 'checking' || gate === 'installing';
  const isError = gate === 'error';
  const percent = runtimeStatus?.progress?.percent;
  const detail =
    gate === 'missing'
      ? t('cliStatus.quickConnect.openCodeRequired')
      : gate === 'installing'
        ? typeof percent === 'number'
          ? t('cliStatus.quickConnect.openCodeInstallingPercent', { percent })
          : t('cliStatus.quickConnect.openCodeInstalling')
        : gate === 'checking'
          ? t('cliStatus.quickConnect.openCodeChecking')
          : runtimeStatus?.error || t('cliStatus.quickConnect.openCodeError');

  return (
    <div
      data-testid="provider-quick-opencode-prerequisite"
      className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
      style={{
        borderColor: isError ? 'rgba(248, 113, 113, 0.32)' : 'rgba(56, 189, 248, 0.25)',
        backgroundColor: isError ? 'rgba(248, 113, 113, 0.06)' : 'rgba(56, 189, 248, 0.05)',
      }}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {busy ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-sky-300" />
        ) : isError ? (
          <AlertTriangle className="size-4 shrink-0 text-red-300" />
        ) : (
          <Download className="size-4 shrink-0 text-sky-300" />
        )}
        <div className="min-w-0">
          <p className="text-[11px] font-semibold" style={{ color: 'var(--color-text)' }}>
            {t('cliStatus.quickConnect.openCodeTitle')}
          </p>
          <p className="truncate text-[10.5px]" style={{ color: 'var(--color-text-muted)' }}>
            {detail}
          </p>
        </div>
      </div>
      {!busy ? (
        <Button type="button" variant="outline" size="sm" className="h-7" onClick={onInstall}>
          <Download className="mr-1.5 size-3.5" />
          {isError
            ? t('cliStatus.quickConnect.retryOpenCode')
            : t('cliStatus.quickConnect.installOpenCode')}
        </Button>
      ) : null}
    </div>
  );
};

const InlineNotice = ({ children }: { children: ReactNode }): JSX.Element => {
  return (
    <div
      className="flex items-center gap-2 rounded-md border px-2.5 py-2 text-[10.5px]"
      style={{
        borderColor: 'rgba(248, 113, 113, 0.25)',
        backgroundColor: 'rgba(248, 113, 113, 0.05)',
        color: '#fca5a5',
      }}
    >
      {children}
    </div>
  );
};

export const RuntimeProviderQuickConnectView = ({
  cards,
  gate,
  runtimeStatus,
  directoryError,
  onInstallOpenCode,
  onRetryDirectory,
  onBrowseProviders,
}: RuntimeProviderQuickConnectViewProps): JSX.Element => {
  const { t } = useAppTranslation('dashboard');

  return (
    <section
      aria-labelledby="provider-quick-connect-title"
      className="mt-3 border-t pt-3"
      style={{ borderColor: 'var(--color-border-subtle)' }}
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3
            id="provider-quick-connect-title"
            className="text-xs font-semibold"
            style={{ color: 'var(--color-text)' }}
          >
            {t('cliStatus.quickConnect.title')}
          </h3>
          <p className="mt-0.5 text-[10.5px]" style={{ color: 'var(--color-text-muted)' }}>
            {t('cliStatus.quickConnect.description')}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[10.5px]"
            onClick={onBrowseProviders}
          >
            {t('cliStatus.quickConnect.browseAll')}
            <ExternalLink className="ml-1.5 size-3" />
          </Button>
        </div>
      </div>

      <OpenCodePrerequisite
        gate={gate}
        runtimeStatus={runtimeStatus}
        onInstall={onInstallOpenCode}
      />

      {directoryError && gate === 'ready' ? (
        <div className="mb-3">
          <InlineNotice>
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate" title={directoryError}>
              {t('cliStatus.quickConnect.providerStatusError')}
            </span>
            <button
              type="button"
              className="flex shrink-0 items-center gap-1 font-medium hover:underline"
              onClick={onRetryDirectory}
            >
              <RefreshCw className="size-3" />
              {t('cliStatus.actions.retry')}
            </button>
          </InlineNotice>
        </div>
      ) : null}

      <TooltipProvider delayDuration={180}>
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))' }}
        >
          {cards.map((card) => (
            <QuickProviderCard key={card.id} card={card} />
          ))}
        </div>
      </TooltipProvider>
    </section>
  );
};
