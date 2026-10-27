import React, { useEffect, useState } from 'react';

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
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { AlertTriangle } from 'lucide-react';

import { useTemplateManagement } from '../hooks/useTemplateManagement';

import type {
  CustomTeamTemplateV1,
  CustomTeamTemplateValidationIssue,
} from '@features/custom-team-templates/contracts';

export interface DuplicateCustomTemplateDialogProps {
  open: boolean;
  template: CustomTeamTemplateV1 | null;
  onClose: () => void;
  onDuplicated?: (newTemplate: CustomTeamTemplateV1) => void;
}

export const DuplicateCustomTemplateDialog = ({
  open,
  template,
  onClose,
  onDuplicated,
}: DuplicateCustomTemplateDialogProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const { duplicateTemplate, busy } = useTemplateManagement();

  const defaultProposedName = template
    ? t('customTemplates.duplicate.defaultName', { name: template.name })
    : '';

  const [name, setName] = useState(defaultProposedName);
  const [nameConflict, setNameConflict] = useState(false);
  const [errorState, setErrorState] = useState<
    'sourceNotFound' | 'sourceUnreadable' | 'storageUnavailable' | 'requestFailed' | null
  >(null);
  const [issues, setIssues] = useState<readonly CustomTeamTemplateValidationIssue[]>([]);

  useEffect(() => {
    if (open && template) {
      setName(t('customTemplates.duplicate.defaultName', { name: template.name }));
      setNameConflict(false);
      setErrorState(null);
      setIssues([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, template]);

  if (!template) return null;

  const handleDuplicate = async () => {
    if (busy || !name.trim()) return;
    setNameConflict(false);
    setErrorState(null);
    setIssues([]);

    try {
      const result = await duplicateTemplate(template.templateId, name.trim());

      switch (result.status) {
        case 'duplicated':
          onDuplicated?.(result.template);
          onClose();
          return;
        case 'nameConflict':
          setNameConflict(true);
          return;
        case 'validationFailed':
          setIssues(result.issues);
          return;
        case 'sourceNotFound':
          setErrorState('sourceNotFound');
          return;
        case 'sourceUnreadable':
          setErrorState('sourceUnreadable');
          return;
        case 'templateIdConflict':
        case 'storageUnavailable':
          setErrorState('storageUnavailable');
          return;
      }
    } catch {
      setErrorState('requestFailed');
    }
  };

  const nameIssues = issues.filter((i) => i.field === 'name');

  const issueMessage = (issue: CustomTeamTemplateValidationIssue): string => {
    switch (issue.code) {
      case 'templateNameRequired':
        return t('customTemplates.errors.issues.templateNameRequired');
      case 'templateNameTooLong':
        return t('customTemplates.errors.issues.templateNameTooLong');
      case 'templateNameInvalidCharacters':
        return t('customTemplates.errors.issues.templateNameInvalidCharacters');
      default:
        return t('customTemplates.errors.issues.invalidContent');
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
          <DialogTitle>{t('customTemplates.duplicate.title')}</DialogTitle>
          <DialogDescription>
            {t('customTemplates.duplicate.description', { name: template.name })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {nameConflict ? (
            <div
              role="alert"
              data-testid="duplicate-template-name-conflict"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.nameConflict')}</p>
            </div>
          ) : null}

          {errorState === 'sourceNotFound' ? (
            <div
              role="alert"
              data-testid="duplicate-template-not-found"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.sourceNotFound')}</p>
            </div>
          ) : null}

          {errorState === 'sourceUnreadable' ? (
            <div
              role="alert"
              data-testid="duplicate-template-unreadable"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.sourceUnreadable')}</p>
            </div>
          ) : null}

          {errorState === 'storageUnavailable' ? (
            <div
              role="alert"
              data-testid="duplicate-template-storage-unavailable"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.storageUnavailable')}</p>
            </div>
          ) : null}

          {errorState === 'requestFailed' ? (
            <div
              role="alert"
              data-testid="duplicate-template-request-failed"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.requestFailed')}</p>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="duplicate-template-name">
              {t('customTemplates.duplicate.nameFieldLabel')}
            </Label>
            <Input
              id="duplicate-template-name"
              value={name}
              disabled={busy}
              aria-invalid={nameIssues.length > 0 || undefined}
              aria-describedby={nameIssues.length > 0 ? 'duplicate-name-error' : undefined}
              onChange={(e) => {
                setName(e.target.value);
                setNameConflict(false);
                setIssues([]);
              }}
            />
            {nameIssues.length > 0 ? (
              <p id="duplicate-name-error" role="alert" className="text-xs text-red-300">
                {nameIssues.map(issueMessage).join(' ')}
              </p>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={closeDisabled} onClick={onClose}>
            {tCommon('actions.cancel')}
          </Button>
          <Button
            disabled={busy || !name.trim()}
            aria-busy={busy}
            onClick={() => void handleDuplicate()}
          >
            {busy
              ? t('customTemplates.duplicate.duplicating')
              : t('customTemplates.duplicate.action')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
