import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, Loader2 } from 'lucide-react';

import type { RuntimeProviderCompanionStatusDto } from '../../contracts';
import type { JSX } from 'react';

interface RuntimeProviderCompanionSetupDialogProps {
  open: boolean;
  title: string;
  description: string;
  status: RuntimeProviderCompanionStatusDto | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onInstallAndConnect: () => void;
  onConnect: () => void;
  onManage?: () => void;
  onCopyManualCommand: () => void;
  onOpenManualGuide: () => void;
}

const BUSY_PHASES = new Set<RuntimeProviderCompanionStatusDto['phase']>([
  'checking',
  'downloading',
  'installing',
  'verifying-install',
  'signing-in',
  'verifying-auth',
  'verifying-model',
]);

export const RuntimeProviderCompanionSetupDialog = ({
  open,
  title,
  description,
  status,
  busy,
  onOpenChange,
  onInstallAndConnect,
  onConnect,
  onManage,
  onCopyManualCommand,
  onOpenManualGuide,
}: RuntimeProviderCompanionSetupDialogProps): JSX.Element => {
  const { t } = useAppTranslation('dashboard');
  const phaseBusy = busy || (status ? BUSY_PHASES.has(status.phase) : false);
  const connected = status?.phase === 'connected';
  const hasManualFallback = Boolean(status?.manualCommand?.trim() || status?.manualUrl?.trim());
  const showFallback =
    hasManualFallback &&
    (status?.phase === 'needs-manual-step' || (status?.phase === 'error' && !status.installed));
  const needsInstall = !status?.installed;
  const percent = status?.percent;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(calc(100vw-2rem),31rem)] gap-4 p-5">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div
          className="rounded-lg border p-3"
          role={showFallback ? 'alert' : 'status'}
          aria-live={showFallback ? 'assertive' : 'polite'}
          aria-busy={phaseBusy}
          style={{
            borderColor: connected
              ? 'rgba(52, 211, 153, 0.3)'
              : showFallback
                ? 'rgba(248, 113, 113, 0.3)'
                : 'var(--color-border-subtle)',
            backgroundColor: connected ? 'rgba(52, 211, 153, 0.06)' : 'var(--color-surface-raised)',
          }}
        >
          <div className="flex items-start gap-2.5">
            {phaseBusy ? (
              <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-sky-300" />
            ) : connected ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-300" />
            ) : showFallback ? (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-300" />
            ) : (
              <span className="mt-1.5 size-2 shrink-0 rounded-full bg-sky-300" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-[var(--color-text)]">
                {status?.message ?? t('cliStatus.quickConnect.checkingPlan')}
              </p>
              {status?.detail ? (
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                  {status.detail}
                </p>
              ) : null}
              {status?.error ? (
                <p className="mt-1.5 text-[11px] leading-relaxed text-red-300">{status.error}</p>
              ) : null}
            </div>
          </div>

          {typeof percent === 'number' ? (
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between text-[10px] text-[var(--color-text-muted)]">
                <span>{t('cliStatus.quickConnect.kiroSetupProgress')}</span>
                <span>{percent}%</span>
              </div>
              <div
                role="progressbar"
                aria-label={t('cliStatus.quickConnect.kiroSetupProgress')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="h-1.5 overflow-hidden rounded-full bg-black/25"
              >
                <div
                  className="h-full rounded-full bg-sky-400 transition-[width] duration-300"
                  style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
                />
              </div>
            </div>
          ) : null}
        </div>

        {phaseBusy ? (
          <p className="text-center text-[11px] text-[var(--color-text-muted)]">
            Setup continues in the background if you close this window. Reopen the card to check
            progress.
          </p>
        ) : null}

        {showFallback && status ? (
          <div className="rounded-lg border border-amber-300/20 bg-amber-300/[0.04] p-3">
            <p className="text-[11px] font-semibold text-amber-200">
              {t('cliStatus.quickConnect.kiroManualFallback')}
            </p>
            <code className="mt-2 block overflow-x-auto rounded bg-black/25 px-2 py-1.5 text-[10px] text-[var(--color-text-secondary)]">
              {status.manualCommand}
            </code>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onCopyManualCommand}>
                <Copy className="mr-1.5 size-3.5" />
                {t('cliStatus.quickConnect.copyCommand')}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={onOpenManualGuide}>
                <ExternalLink className="mr-1.5 size-3.5" />
                {t('cliStatus.quickConnect.openKiroGuide')}
              </Button>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          {connected ? (
            <>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                {t('cliStatus.quickConnect.done')}
              </Button>
              {onManage ? (
                <Button type="button" variant="outline" onClick={onManage}>
                  {t('cliStatus.actions.manage')}
                </Button>
              ) : null}
              <Button type="button" disabled={phaseBusy} onClick={onConnect}>
                {t('cliStatus.quickConnect.signIn')}
              </Button>
            </>
          ) : needsInstall ? (
            <Button type="button" disabled={phaseBusy} onClick={onInstallAndConnect}>
              {phaseBusy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              {showFallback
                ? t('cliStatus.quickConnect.retryInstall')
                : t('cliStatus.quickConnect.installAndConnect')}
            </Button>
          ) : (
            <Button type="button" disabled={phaseBusy} onClick={onConnect}>
              {phaseBusy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              {t('cliStatus.quickConnect.signIn')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
