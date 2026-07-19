import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  LogOut,
  RefreshCw,
  Stethoscope,
  UserRoundCog,
} from 'lucide-react';

import type {
  RuntimeProviderCompanionActionDto,
  RuntimeProviderCompanionStatusDto,
} from '../../contracts';
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
  onAction: (action: RuntimeProviderCompanionActionDto) => void;
  onManage?: () => void;
  onOpenUsage?: () => void;
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
  'running-action',
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
  onAction,
  onManage,
  onOpenUsage,
  onCopyManualCommand,
  onOpenManualGuide,
}: RuntimeProviderCompanionSetupDialogProps): JSX.Element => {
  const { t } = useAppTranslation('dashboard');
  const [confirmAction, setConfirmAction] = useState<Extract<
    RuntimeProviderCompanionActionDto,
    'logout' | 'switch-account'
  > | null>(null);
  const phaseBusy = busy || (status ? BUSY_PHASES.has(status.phase) : false);
  const connected = status?.phase === 'connected';
  const hasManualFallback = Boolean(status?.manualCommand?.trim() || status?.manualUrl?.trim());
  const showFallback =
    hasManualFallback && (status?.phase === 'needs-manual-step' || status?.phase === 'error');
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

        {status?.authenticated && status.account ? (
          <div className="rounded-lg border border-sky-300/15 bg-sky-300/[0.04] p-3">
            <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              Connected account
            </p>
            <p className="mt-1 text-sm font-semibold text-[var(--color-text)]">
              {status.account.display}
            </p>
            <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
              {[status.account.accountType, status.account.region].filter(Boolean).join(' · ')}
            </p>
          </div>
        ) : null}

        {connected && status?.supportedActions?.length ? (
          <div className="grid grid-cols-2 gap-2">
            {status.supportedActions.includes('switch-account') ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={phaseBusy}
                onClick={() => setConfirmAction('switch-account')}
              >
                <UserRoundCog className="mr-1.5 size-3.5" />
                Switch account
              </Button>
            ) : null}
            {status.supportedActions.includes('logout') ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={phaseBusy}
                onClick={() => setConfirmAction('logout')}
              >
                <LogOut className="mr-1.5 size-3.5" />
                Sign out
              </Button>
            ) : null}
            {status.supportedActions.includes('doctor') ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={phaseBusy}
                onClick={() => onAction('doctor')}
              >
                <Stethoscope className="mr-1.5 size-3.5" />
                Diagnostics
              </Button>
            ) : null}
            {status.supportedActions.includes('update') ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={phaseBusy}
                onClick={() => onAction('update')}
              >
                <RefreshCw className="mr-1.5 size-3.5" />
                Update CLI
              </Button>
            ) : null}
            {onOpenUsage ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="col-span-2"
                onClick={onOpenUsage}
              >
                <ExternalLink className="mr-1.5 size-3.5" />
                Usage, plan and remaining quota
              </Button>
            ) : null}
          </div>
        ) : null}

        {status?.actionOutput ? (
          <details className="rounded-lg border border-[var(--color-border-subtle)] bg-black/15 p-3">
            <summary className="cursor-pointer text-[11px] font-medium text-[var(--color-text-secondary)]">
              CLI output
            </summary>
            <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words text-[10px] text-[var(--color-text-muted)]">
              {status.actionOutput}
            </pre>
          </details>
        ) : null}

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

      <AlertDialog
        open={confirmAction !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setConfirmAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === 'switch-account' ? 'Switch Kiro account?' : 'Sign out of Kiro?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Kiro CLI authentication is user-wide. This affects OpenCode and other local tools that
              use the same Kiro CLI session.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmAction) onAction(confirmAction);
                setConfirmAction(null);
              }}
            >
              {confirmAction === 'switch-account' ? 'Sign out and continue' : 'Sign out'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
};
