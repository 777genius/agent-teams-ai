import React, { useEffect, useState } from 'react';

import {
  type CustomTeamTemplateV1,
  resolveTemplateRevision,
} from '@features/custom-team-templates/contracts';
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
import { AlertTriangle } from 'lucide-react';

import { useTemplateManagement } from '../hooks/useTemplateManagement';

export interface DeleteCustomTemplateDialogProps {
  open: boolean;
  template: CustomTeamTemplateV1 | null;
  onClose: () => void;
  onDeleted?: (templateId: string) => void;
  onReload?: () => void;
}

export const DeleteCustomTemplateDialog = ({
  open,
  template,
  onClose,
  onDeleted,
  onReload,
}: DeleteCustomTemplateDialogProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const { deleteTemplate, busy } = useTemplateManagement();

  const [expectedRevision, setExpectedRevision] = useState(
    template ? resolveTemplateRevision(template) : 1
  );
  const [revisionConflict, setRevisionConflict] = useState<CustomTeamTemplateV1 | null>(null);
  const [errorState, setErrorState] = useState<
    | 'notFound'
    | 'unreadableRecord'
    | 'storageUnavailable'
    | 'unresolvedWriteOutcome'
    | 'requestFailed'
    | null
  >(null);

  useEffect(() => {
    if (open && template) {
      setExpectedRevision(resolveTemplateRevision(template));
      setRevisionConflict(null);
      setErrorState(null);
    }
  }, [open, template]);

  if (!template) return null;

  const handleDelete = async () => {
    if (busy || revisionConflict) return;
    setErrorState(null);

    try {
      const result = await deleteTemplate({
        templateId: template.templateId,
        expectedRevision,
      });

      switch (result.status) {
        case 'deleted':
          onDeleted?.(result.templateId);
          onClose();
          return;
        case 'revisionConflict':
          setRevisionConflict(result.current);
          return;
        case 'notFound':
          setErrorState('notFound');
          return;
        case 'unreadableRecord':
          // A row that cannot be read is a distinct diagnosis from a storage
          // outage; keep the unreadable state so the copy can say so.
          setErrorState('unreadableRecord');
          return;
        case 'storageUnavailable':
          setErrorState('storageUnavailable');
          return;
        case 'unresolvedWriteOutcome':
          // The row may already be gone. Stay in an explicit unknown state
          // instead of closing as a confirmed delete or offering a blind retry.
          setErrorState('unresolvedWriteOutcome');
          return;
      }
    } catch {
      setErrorState('requestFailed');
    }
  };

  const closeDisabled = busy;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !closeDisabled) onClose();
      }}
    >
      <DialogContent
        className="max-w-md"
        closeDisabled={closeDisabled}
        onEscapeKeyDown={(e) => closeDisabled && e.preventDefault()}
        onInteractOutside={(e) => closeDisabled && e.preventDefault()}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('customTemplates.delete.title')}</DialogTitle>
          <DialogDescription>
            {t('customTemplates.delete.description', { name: template.name })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {revisionConflict ? (
            <div
              role="alert"
              data-testid="delete-template-revision-conflict"
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">{t('customTemplates.delete.conflictTitle')}</p>
                <p>{t('customTemplates.delete.conflictBody')}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onClose();
                    onReload?.();
                  }}
                >
                  {t('customTemplates.edit.conflictReload')}
                </Button>
              </div>
            </div>
          ) : null}

          {errorState === 'unresolvedWriteOutcome' ? (
            <div
              role="alert"
              data-testid="delete-template-unresolved"
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">{t('customTemplates.states.unresolvedTitle')}</p>
                <p>{t('customTemplates.states.unresolvedDeleteBody')}</p>
              </div>
            </div>
          ) : null}

          {errorState === 'notFound' ? (
            <div
              role="alert"
              data-testid="delete-template-not-found"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.notFound')}</p>
            </div>
          ) : null}

          {errorState === 'storageUnavailable' ? (
            <div
              role="alert"
              data-testid="delete-template-storage-unavailable"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.storageUnavailable')}</p>
            </div>
          ) : null}

          {errorState === 'unreadableRecord' ? (
            <div
              role="alert"
              data-testid="delete-template-unreadable"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.unreadableRecord')}</p>
            </div>
          ) : null}

          {errorState === 'requestFailed' ? (
            <div
              role="alert"
              data-testid="delete-template-request-failed"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.requestFailed')}</p>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={closeDisabled} onClick={onClose}>
            {tCommon('actions.cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={busy || revisionConflict !== null}
            aria-busy={busy}
            onClick={() => void handleDelete()}
          >
            {busy ? t('customTemplates.delete.deleting') : t('customTemplates.delete.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
