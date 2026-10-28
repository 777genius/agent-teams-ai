import { useAppTranslation } from '@features/localization/renderer';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';

import type { ManagementOperation } from '../../contracts';

export const ManagementOperationView = ({
  operation,
  busy,
  onCancel,
  onRecover,
}: {
  operation: ManagementOperation;
  busy: boolean;
  onCancel(): void;
  onRecover(): void;
}) => {
  const { t } = useAppTranslation('extensions');
  const running = operation.state === 'queued' || operation.state === 'running';
  const recovery =
    !operation.resolvedBy &&
    (operation.state === 'interrupted' ||
      operation.state === 'partial' ||
      ((operation.state === 'failed' || operation.state === 'canceled') &&
        operation.result?.mutated === true) ||
      operation.result?.nextActions.some((action) => /recover|repair|inspect/.test(action.kind)));
  return (
    <div
      className="space-y-2 rounded-lg border border-border bg-surface-raised p-3"
      role="status"
      data-testid="uap-operation"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant="outline">{t(`uap.operationState.${operation.state}`)}</Badge>
        {running && (
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
            {t('uap.cancel')}
          </Button>
        )}
        {recovery && (
          <Button variant="outline" size="sm" onClick={onRecover} disabled={busy}>
            {t('uap.recover')}
          </Button>
        )}
      </div>
      {running && (
        <p className="text-sm">
          {operation.phase}
          {operation.total > 0 ? ` · ${operation.completed}/${operation.total}` : ''}
        </p>
      )}
      {operation.result?.message && <p className="text-sm">{operation.result.message}</p>}
      {operation.result?.nextActions.map((action, index) => (
        <p
          key={index}
          className={
            operation.state === 'succeeded' && !recovery
              ? 'text-sm text-text-secondary'
              : 'text-sm text-amber-400'
          }
        >
          {action.reason}
        </p>
      ))}
      <details className="text-xs text-text-muted">
        <summary className="cursor-pointer">{t('uap.details')}</summary>
        <ul className="mt-2 space-y-1">
          {(operation.result?.items ?? operation.items).map((item, index) => (
            <li key={index}>
              {item.alias} · {item.targetId}: {item.status}
              {item.message ? ` — ${item.message}` : ''}
            </li>
          ))}
        </ul>
        {operation.diagnostics.map((item, index) => (
          <p key={index}>{item.message}</p>
        ))}
        <p className="mt-2 break-all">{operation.operationId}</p>
      </details>
    </div>
  );
};
