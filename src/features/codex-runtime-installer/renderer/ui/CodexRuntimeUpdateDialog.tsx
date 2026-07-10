import { useMemo } from 'react';

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
import { normalizeVersion } from '@shared/utils/version';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';

import { getCodexRuntimeProgressPercent } from '../utils/codexRuntimeProgress';

import type { CodexRuntimeStatus } from '../../contracts';

export interface CodexRuntimeUpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: CodexRuntimeStatus | null | undefined;
  loading: boolean;
  error?: string | null;
  onInstall: () => void;
}

function isRuntimeBusy(status: CodexRuntimeStatus | null | undefined, loading: boolean): boolean {
  return (
    loading ||
    status?.state === 'checking' ||
    status?.state === 'downloading' ||
    status?.state === 'installing'
  );
}

export const CodexRuntimeUpdateDialog = ({
  open,
  onOpenChange,
  status,
  loading,
  error,
  onInstall,
}: CodexRuntimeUpdateDialogProps): React.JSX.Element => {
  const { t: commonT } = useAppTranslation('common');
  const { t: dashboardT } = useAppTranslation('dashboard');
  const { t: settingsT } = useAppTranslation('settings');
  const busy = isRuntimeBusy(status, loading);
  const progressPercent = getCodexRuntimeProgressPercent(status);
  const completed =
    status?.installed === true &&
    status.state === 'ready' &&
    status.updateAvailable === false &&
    status.progress?.phase === 'ready';
  const actionLabel = useMemo(() => {
    if (status?.updateAvailable && status.latestVersion) {
      return dashboardT('cliStatus.actions.updateTo', { version: status.latestVersion });
    }
    if (status?.state === 'failed') {
      return dashboardT('cliStatus.runtimeInstall.retryInstall');
    }
    return dashboardT('cliStatus.runtimeInstall.install');
  }, [dashboardT, status?.latestVersion, status?.state, status?.updateAvailable]);
  const versionSummary =
    status?.version && status.latestVersion
      ? settingsT('cliStatus.versionUpgrade', {
          current: normalizeVersion(status.version),
          latest: status.latestVersion,
        })
      : status?.latestVersion
        ? `v${status.latestVersion}`
        : status?.version
          ? status.version
          : null;
  const detail = status?.progress?.detail ?? error ?? status?.error ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,480px)] max-w-[min(92vw,480px)]">
        <DialogHeader>
          <DialogTitle>
            {completed
              ? commonT('updateDialog.updateReady')
              : commonT('updateDialog.updateAvailable')}
          </DialogTitle>
          <DialogDescription>Codex{versionSummary ? ` ${versionSummary}` : ''}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {progressPercent !== null ? (
            <div className="space-y-1.5">
              <div
                role="progressbar"
                aria-label={detail ?? settingsT('providerRuntime.runtime.updating')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressPercent}
                className="h-2 overflow-hidden rounded-full bg-[var(--color-surface-raised)]"
              >
                <div
                  className="h-full rounded-full bg-blue-500 transition-[width] duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <div className="flex items-center justify-between gap-3 text-xs text-[var(--color-text-muted)]">
                <span className="truncate">{detail}</span>
                <span>{progressPercent}%</span>
              </div>
            </div>
          ) : null}

          {status?.state === 'failed' || error ? (
            <div className="flex items-start gap-2 rounded-md border border-red-300/25 bg-red-400/10 px-3 py-2 text-xs text-red-200">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{detail}</span>
            </div>
          ) : null}

          {completed ? (
            <div className="flex items-center gap-2 rounded-md border border-emerald-300/25 bg-emerald-300/10 px-3 py-2 text-xs text-emerald-100">
              <CheckCircle2 className="size-3.5 shrink-0" />
              <span>{status.progress?.detail}</span>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {completed ? commonT('actions.close') : commonT('updateDialog.later')}
          </Button>
          {!completed ? (
            <Button onClick={onInstall} disabled={busy} className="gap-2 bg-blue-600 text-white">
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {busy ? settingsT('providerRuntime.runtime.updating') : actionLabel}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
