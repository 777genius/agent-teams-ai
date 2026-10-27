import React, { useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { TEAM_TEMPLATES } from '@features/team-templates';
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
import { AlertTriangle, ShieldCheck } from 'lucide-react';

import { useTemplateManagement } from '../hooks/useTemplateManagement';

import type {
  BuiltinTeamTemplateId,
  CustomTeamTemplateV1,
  CustomTeamTemplateValidationIssue,
} from '@features/custom-team-templates/contracts';

export interface CopyBuiltinTemplateDialogProps {
  open: boolean;
  onClose: () => void;
  onCopied?: (newTemplate: CustomTeamTemplateV1) => void;
  initialBuiltinId?: BuiltinTeamTemplateId;
}

export const CopyBuiltinTemplateDialog = ({
  open,
  onClose,
  onCopied,
  initialBuiltinId,
}: CopyBuiltinTemplateDialogProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const { copyBuiltinTemplate, busy } = useTemplateManagement();

  const [selectedId, setSelectedId] = useState<BuiltinTeamTemplateId>('software-product');
  const [name, setName] = useState('');
  /**
   * True once the user typed their own name. It stops the seeded name from
   * being replaced by a rerender or a locale change; selecting another
   * built-in still resets the name, which is the established behaviour.
   */
  const [nameEdited, setNameEdited] = useState(false);
  const [nameConflict, setNameConflict] = useState(false);
  const [errorState, setErrorState] = useState<
    'builtinNotFound' | 'storageUnavailable' | 'unresolvedWriteOutcome' | 'requestFailed' | null
  >(null);
  const [issues, setIssues] = useState<readonly CustomTeamTemplateValidationIssue[]>([]);

  const selectedTemplate = TEAM_TEMPLATES.find((tpl) => tpl.id === selectedId) ?? TEAM_TEMPLATES[0];

  useEffect(() => {
    if (open) {
      setSelectedId(initialBuiltinId ?? 'software-product');
      setNameEdited(false);
      setNameConflict(false);
      setErrorState(null);
      setIssues([]);
    }
  }, [open, initialBuiltinId]);

  // Seed the editable name from the same localized label the built-in
  // catalogue renders. This deliberately follows a locale change only while
  // the name is untouched, so an explicit user edit is never overwritten.
  useEffect(() => {
    if (!open || nameEdited) return;
    setName(t(`templates.names.${selectedId}`));
  }, [open, selectedId, nameEdited, t]);

  const handleSelectTemplate = (id: BuiltinTeamTemplateId) => {
    setSelectedId(id);
    setNameEdited(false);
    setName(t(`templates.names.${id}`));
    setNameConflict(false);
    setErrorState(null);
    setIssues([]);
  };

  const handleCopy = async () => {
    if (busy || !name.trim()) return;
    setNameConflict(false);
    setErrorState(null);
    setIssues([]);

    try {
      const result = await copyBuiltinTemplate(selectedId, name.trim());

      switch (result.status) {
        case 'copied':
          onCopied?.(result.template);
          onClose();
          return;
        case 'nameConflict':
          setNameConflict(true);
          return;
        case 'validationFailed':
          setIssues(result.issues);
          return;
        case 'builtinNotFound':
          setErrorState('builtinNotFound');
          return;
        case 'templateIdConflict':
        case 'storageUnavailable':
          setErrorState('storageUnavailable');
          return;
        case 'unresolvedWriteOutcome':
          // The copy may already have been stored. Keep the selection and the
          // name available and never retry automatically.
          setErrorState('unresolvedWriteOutcome');
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
        className="max-h-[90vh] max-w-2xl overflow-y-auto"
        closeDisabled={closeDisabled}
        onEscapeKeyDown={(e) => closeDisabled && e.preventDefault()}
        onInteractOutside={(e) => closeDisabled && e.preventDefault()}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('customTemplates.copyBuiltin.title')}</DialogTitle>
          <DialogDescription>{t('customTemplates.copyBuiltin.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {nameConflict ? (
            <div
              role="alert"
              data-testid="copy-builtin-name-conflict"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.nameConflict')}</p>
            </div>
          ) : null}

          {errorState === 'builtinNotFound' ? (
            <div
              role="alert"
              data-testid="copy-builtin-not-found"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.builtinNotFound')}</p>
            </div>
          ) : null}

          {errorState === 'storageUnavailable' ? (
            <div
              role="alert"
              data-testid="copy-builtin-storage-unavailable"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.storageUnavailable')}</p>
            </div>
          ) : null}

          {errorState === 'unresolvedWriteOutcome' ? (
            <div
              role="alert"
              data-testid="copy-builtin-unresolved"
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">{t('customTemplates.states.unresolvedTitle')}</p>
                <p>{t('customTemplates.states.unresolvedMutationBody')}</p>
              </div>
            </div>
          ) : null}

          {errorState === 'requestFailed' ? (
            <div
              role="alert"
              data-testid="copy-builtin-request-failed"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.requestFailed')}</p>
            </div>
          ) : null}

          {/* Template Selection Grid */}
          <div className="space-y-1.5">
            <Label>{t('customTemplates.copyBuiltin.selectTemplate')}</Label>
            <div
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
              data-testid="builtin-templates-list"
            >
              {TEAM_TEMPLATES.map((tpl) => {
                const isSelected = tpl.id === selectedId;
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    disabled={busy}
                    aria-pressed={isSelected}
                    data-testid={`builtin-template-${tpl.id}`}
                    className={`rounded-md border p-3 text-left transition-colors ${
                      isSelected
                        ? 'border-[var(--color-primary)] bg-[var(--color-surface-raised)] ring-1 ring-[var(--color-primary)]'
                        : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-raised)]'
                    }`}
                    onClick={() => handleSelectTemplate(tpl.id as BuiltinTeamTemplateId)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-semibold text-[var(--color-text)]">
                        {t(`templates.names.${tpl.id}`)}
                      </span>
                      <ShieldCheck className="size-4 shrink-0 text-sky-400" />
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-[var(--color-text-muted)]">
                      {tpl.description}
                    </p>
                    <span className="mt-2 inline-block text-[11px] text-[var(--color-text-secondary)]">
                      {t('customTemplates.copyBuiltin.membersCount', {
                        count: tpl.members.length,
                      })}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Name Field */}
          <div className="space-y-1.5">
            <Label htmlFor="copy-builtin-name">
              {t('customTemplates.copyBuiltin.nameFieldLabel')}
            </Label>
            <Input
              id="copy-builtin-name"
              value={name}
              disabled={busy}
              aria-invalid={nameIssues.length > 0 || undefined}
              aria-describedby={nameIssues.length > 0 ? 'copy-builtin-name-error' : undefined}
              onChange={(e) => {
                setName(e.target.value);
                setNameEdited(true);
                setNameConflict(false);
                setIssues([]);
              }}
            />
            {nameIssues.length > 0 ? (
              <p id="copy-builtin-name-error" role="alert" className="text-xs text-red-300">
                {nameIssues.map(issueMessage).join(' ')}
              </p>
            ) : null}
          </div>

          {/* Read-Only Source Preview */}
          {selectedTemplate ? (
            <div
              className="space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 text-xs"
              data-testid="builtin-preview"
            >
              <div className="flex items-center justify-between text-[var(--color-text-muted)]">
                <span className="font-medium text-[var(--color-text)]">
                  {t(`templates.names.${selectedTemplate.id}`)}
                </span>
                <span className="text-[11px] text-sky-400">
                  {t('customTemplates.copyBuiltin.readOnlySource')}
                </span>
              </div>
              <p className="text-[var(--color-text-secondary)]">{selectedTemplate.teamPrompt}</p>
              <div className="pt-1">
                <span className="font-semibold text-[var(--color-text)]">
                  {t('customTemplates.preview.membersLabel')}:{' '}
                </span>
                <span className="text-[var(--color-text-muted)]">
                  {selectedTemplate.members.map((m) => m.name).join(', ')}
                </span>
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={closeDisabled} onClick={onClose}>
            {tCommon('actions.cancel')}
          </Button>
          <Button
            disabled={busy || !name.trim()}
            aria-busy={busy}
            onClick={() => void handleCopy()}
          >
            {busy
              ? t('customTemplates.copyBuiltin.copying')
              : t('customTemplates.copyBuiltin.action')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
