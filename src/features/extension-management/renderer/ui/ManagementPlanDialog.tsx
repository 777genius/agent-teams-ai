import { useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';

import type { ManagementPlan, ManagementSession } from '../../contracts';

export const ManagementPlanDialog = ({
  plan,
  targets,
  busy,
  error,
  uncertain,
  onClose,
  onApply,
  onAttestExternalUninstall,
}: {
  plan: ManagementPlan | null;
  targets?: ManagementSession['targets'];
  busy: boolean;
  error: string | null;
  uncertain: boolean;
  onClose(): void;
  onApply(): void;
  onAttestExternalUninstall?: () => void;
}) => {
  const { t } = useAppTranslation('extensions');
  const { t: common } = useAppTranslation('common');
  const [now, setNow] = useState(Date.now());
  const [externalUninstalled, setExternalUninstalled] = useState(false);
  useEffect(() => setExternalUninstalled(false), [plan?.planId]);
  useEffect(() => {
    if (!plan) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Date.parse(plan.expiresAt) - Date.now())
    );
    return () => clearTimeout(timer);
  }, [plan]);
  const expired = Boolean(plan && Date.parse(plan.expiresAt) <= now);
  const actionLabel = (action: string) => {
    switch (action) {
      case 'install':
        return t('uap.install');
      case 'update':
        return t('uap.update');
      case 'repair':
        return t('uap.repair');
      case 'remove':
      case 'delete':
        return t('uap.remove');
      case 'recover':
        return t('uap.recover');
      case 'upsert':
        return common('actions.save');
      case 'restore':
        return t('uap.restoreFilesAction');
      case 'unchanged':
        return t('uap.keep');
      default:
        return action.replaceAll('_', ' ');
    }
  };
  return (
    <Dialog
      open={Boolean(plan)}
      onOpenChange={(open) => {
        if (!open && !busy && !uncertain) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('uap.reviewTitle')}</DialogTitle>
          <DialogDescription>{t('uap.reviewHelp')}</DialogDescription>
        </DialogHeader>
        {(plan?.action === 'update' || plan?.action === 'sync') && (
          <p className="text-xs text-text-muted">{t('uap.updatePolicy')}</p>
        )}
        {plan?.actions.map((action, index) => (
          <div
            key={`${action.targetId}-${index}`}
            className="rounded-md border border-border p-3 text-sm"
          >
            <p className="font-medium">
              {actionLabel(action.action)} {action.alias}
            </p>
            <p className="text-xs text-text-muted">
              {targets?.find((target) => target.id === action.targetId)?.label || action.targetId}
            </p>
            {(action.fromVersion || action.toVersion) && (
              <p className="text-xs text-text-muted">
                {action.fromVersion || '—'} → {action.toVersion || '—'}
              </p>
            )}
            {(action.description || action.destinationPath) && (
              <details className="mt-2 text-xs text-text-muted">
                <summary className="cursor-pointer">{t('uap.details')}</summary>
                {action.description && <p className="mt-2">{action.description}</p>}
                {action.destinationPath && <p className="break-all">{action.destinationPath}</p>}
              </details>
            )}
          </div>
        ))}
        {[...(plan?.warnings ?? []), ...(plan?.conflicts ?? [])].map((item, index) => (
          <p
            key={index}
            role={item.severity === 'error' ? 'alert' : undefined}
            className="text-sm text-amber-400"
          >
            {(item.alias || item.targetId) && (
              <span className="font-medium">
                {[item.alias, item.targetId].filter(Boolean).join(' · ')}:{' '}
              </span>
            )}
            {item.message}
          </p>
        ))}
        {!uncertain &&
          onAttestExternalUninstall &&
          plan?.conflicts.some((item) => item.code === 'EXTERNAL_UNINSTALL_REQUIRED') && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <label className="flex items-start gap-3 text-sm">
                <Checkbox
                  checked={externalUninstalled}
                  disabled={busy}
                  onCheckedChange={(checked) => setExternalUninstalled(checked === true)}
                />
                <span>{t('uap.externalUninstallConfirmation')}</span>
              </label>
              <Button
                variant="outline"
                disabled={busy || !externalUninstalled}
                onClick={onAttestExternalUninstall}
              >
                {t('uap.reviewExternalUninstall')}
              </Button>
            </div>
          )}
        {expired && (
          <p role="alert" className="text-sm text-amber-400">
            {t('uap.expired')}
          </p>
        )}
        {uncertain && <p className="text-sm text-amber-400">{t('uap.uncertainReview')}</p>}
        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy || uncertain}>
            {t('uap.close')}
          </Button>
          <Button
            onClick={onApply}
            disabled={busy || !plan?.confirmable || (expired && !uncertain)}
          >
            {busy ? t('uap.working') : uncertain ? t('uap.retryRequest') : t('uap.apply')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
