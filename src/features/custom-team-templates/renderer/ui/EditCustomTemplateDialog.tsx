import React from 'react';

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
import { Textarea } from '@renderer/components/ui/textarea';
import { AlertTriangle, CheckCircle2, Plus, RefreshCw, Trash2 } from 'lucide-react';

import { useEditTemplate } from '../hooks/useEditTemplate';

import type {
  CustomTeamTemplateV1,
  CustomTeamTemplateValidationIssue,
} from '@features/custom-team-templates/contracts';

export interface EditCustomTemplateDialogProps {
  open: boolean;
  template: CustomTeamTemplateV1 | null;
  onClose: () => void;
  onSaved?: (updated: CustomTeamTemplateV1) => void;
}

export const EditCustomTemplateDialog = ({
  open,
  template,
  onClose,
  onSaved,
}: EditCustomTemplateDialogProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');

  const {
    name,
    description,
    teamPrompt,
    members,
    status,
    issues,
    revisionConflict,
    canSave,
    canRecheck,
    setName,
    setDescription,
    setTeamPrompt,
    addMember,
    updateMember,
    removeMember,
    save,
    recheck,
    acceptRevisionConflict,
    overwriteRevisionConflict,
  } = useEditTemplate({
    open,
    template,
    onSaved,
  });

  if (!template) return null;

  const issueMessage = (issue: CustomTeamTemplateValidationIssue): string => {
    switch (issue.code) {
      case 'templateNameRequired':
        return t('customTemplates.errors.issues.templateNameRequired');
      case 'templateNameTooLong':
        return t('customTemplates.errors.issues.templateNameTooLong');
      case 'templateNameInvalidCharacters':
        return t('customTemplates.errors.issues.templateNameInvalidCharacters');
      case 'templateDescriptionTooLong':
        return t('customTemplates.errors.issues.templateDescriptionTooLong');
      case 'teamPromptTooLong':
        return t('customTemplates.errors.issues.teamPromptTooLong');
      case 'tooManyMembers':
        return t('customTemplates.errors.issues.tooManyMembers');
      case 'memberNameRequired':
        return t('customTemplates.errors.issues.memberNameRequired');
      case 'memberNameInvalid':
        return t('customTemplates.errors.issues.memberNameInvalid');
      case 'duplicateMemberName':
        return t('customTemplates.errors.issues.duplicateMemberName');
      case 'memberRoleTooLong':
        return t('customTemplates.errors.issues.memberRoleTooLong');
      case 'memberWorkflowTooLong':
        return t('customTemplates.errors.issues.memberWorkflowTooLong');
      default:
        return t('customTemplates.errors.issues.invalidContent');
    }
  };

  const nameIssues = issues.filter((i) => i.field === 'name');
  const descriptionIssues = issues.filter((i) => i.field === 'description');
  const promptIssues = issues.filter((i) => i.field === 'teamPrompt');
  const memberGeneralIssues = issues.filter((i) => i.field === 'members');
  const generalIssues = issues.filter(
    (i) =>
      i.field !== 'name' &&
      i.field !== 'description' &&
      i.field !== 'teamPrompt' &&
      !i.field.startsWith('members')
  );

  const getMemberIssues = (index: number): CustomTeamTemplateValidationIssue[] =>
    issues.filter((i) => i.field.startsWith(`members[${index}]`));

  const saving = status === 'saving';
  const unresolved = status === 'unresolvedWriteOutcome';
  const locked = saving || unresolved;
  const closeDisabled = saving;

  const handleSave = async (): Promise<void> => {
    const success = await save();
    if (success) {
      // Auto-close on successful save
      onClose();
    }
  };

  const handleRecheck = async (): Promise<void> => {
    const confirmed = await recheck();
    if (confirmed) {
      // A persisted row at the exact next revision with the intended content
      // is the only evidence that the original update committed.
      onClose();
    }
  };

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
          <DialogTitle>{t('customTemplates.edit.title')}</DialogTitle>
          <DialogDescription>{t('customTemplates.edit.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {status === 'saved' ? (
            <div
              role="status"
              data-testid="edit-template-saved"
              className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-200"
            >
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">{t('customTemplates.edit.saved')}</p>
                <p>{t('customTemplates.edit.savedBody', { name })}</p>
              </div>
            </div>
          ) : null}

          {status === 'revisionConflict' && revisionConflict ? (
            <div
              role="alert"
              data-testid="edit-template-revision-conflict"
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="font-medium">{t('customTemplates.edit.conflictTitle')}</p>
                <p>
                  {t('customTemplates.edit.conflictBody', {
                    revision: revisionConflict.revision ?? 1,
                  })}
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={acceptRevisionConflict}
                  >
                    {t('customTemplates.edit.conflictReload')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={overwriteRevisionConflict}
                  >
                    {t('customTemplates.edit.conflictOverwrite')}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {status === 'nameConflict' ? (
            <div
              role="alert"
              data-testid="edit-template-name-conflict"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.nameConflict')}</p>
            </div>
          ) : null}

          {status === 'notFound' ? (
            <div
              role="alert"
              data-testid="edit-template-not-found"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.notFound')}</p>
            </div>
          ) : null}

          {status === 'storageUnavailable' ? (
            <div
              role="alert"
              data-testid="edit-template-storage-unavailable"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.storageUnavailable')}</p>
            </div>
          ) : null}

          {status === 'unreadableRecord' ? (
            <div
              role="alert"
              data-testid="edit-template-unreadable"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.unreadableRecord')}</p>
            </div>
          ) : null}

          {status === 'unresolvedWriteOutcome' ? (
            <div
              role="alert"
              data-testid="edit-template-unresolved"
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="font-medium">{t('customTemplates.states.unresolvedTitle')}</p>
                <p>{t('customTemplates.states.unresolvedMutationBody')}</p>
                <div className="pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="edit-template-recheck"
                    disabled={!canRecheck}
                    onClick={() => void handleRecheck()}
                  >
                    <RefreshCw className="size-3.5" />
                    {t('customTemplates.actions.recheck')}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {status === 'requestFailed' || status === 'requestSizeValidationFailed' ? (
            <div
              role="alert"
              data-testid="edit-template-request-failed"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.requestFailed')}</p>
            </div>
          ) : null}

          {generalIssues.length > 0 ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{generalIssues.map(issueMessage).join(' ')}</p>
            </div>
          ) : null}

          {/* Name Field */}
          <div className="space-y-1.5">
            <Label htmlFor="edit-template-name">{t('customTemplates.edit.nameFieldLabel')}</Label>
            <Input
              id="edit-template-name"
              value={name}
              disabled={locked}
              aria-invalid={nameIssues.length > 0 || undefined}
              aria-describedby={nameIssues.length > 0 ? 'edit-template-name-error' : undefined}
              onChange={(e) => setName(e.target.value)}
            />
            {nameIssues.length > 0 ? (
              <p id="edit-template-name-error" role="alert" className="text-xs text-red-300">
                {nameIssues.map(issueMessage).join(' ')}
              </p>
            ) : null}
          </div>

          {/* Description Field */}
          <div className="space-y-1.5">
            <Label htmlFor="edit-template-description">
              {t('customTemplates.edit.descriptionLabel')}
            </Label>
            <Textarea
              id="edit-template-description"
              value={description}
              disabled={locked}
              aria-invalid={descriptionIssues.length > 0 || undefined}
              aria-describedby={
                descriptionIssues.length > 0 ? 'edit-template-description-error' : undefined
              }
              onChange={(e) => setDescription(e.target.value)}
            />
            {descriptionIssues.length > 0 ? (
              <p id="edit-template-description-error" role="alert" className="text-xs text-red-300">
                {descriptionIssues.map(issueMessage).join(' ')}
              </p>
            ) : null}
          </div>

          {/* Team Prompt Field */}
          <div className="space-y-1.5">
            <Label htmlFor="edit-template-prompt">{t('customTemplates.edit.promptLabel')}</Label>
            <Textarea
              id="edit-template-prompt"
              value={teamPrompt}
              rows={3}
              disabled={locked}
              placeholder={t('customTemplates.edit.promptPlaceholder')}
              aria-invalid={promptIssues.length > 0 || undefined}
              aria-describedby={promptIssues.length > 0 ? 'edit-template-prompt-error' : undefined}
              onChange={(e) => setTeamPrompt(e.target.value)}
            />
            {promptIssues.length > 0 ? (
              <p id="edit-template-prompt-error" role="alert" className="text-xs text-red-300">
                {promptIssues.map(issueMessage).join(' ')}
              </p>
            ) : null}
          </div>

          {/* Members Section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t('customTemplates.edit.membersLabel')}</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1 text-xs"
                disabled={locked}
                onClick={() => addMember()}
              >
                <Plus className="size-3.5" />
                {t('customTemplates.actions.addMember')}
              </Button>
            </div>

            {memberGeneralIssues.length > 0 ? (
              <p role="alert" className="text-xs text-red-300">
                {memberGeneralIssues.map(issueMessage).join(' ')}
              </p>
            ) : null}

            {members.length === 0 ? (
              <p className="rounded border border-dashed border-[var(--color-border)] p-3 text-center text-xs text-[var(--color-text-muted)]">
                {t('customTemplates.edit.membersEmpty')}
              </p>
            ) : (
              <div className="space-y-2">
                {members.map((member, index) => {
                  const mIssues = getMemberIssues(index);
                  return (
                    <div
                      key={`member-${index}`}
                      className="space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-[var(--color-text)]">
                          {t('customTemplates.edit.memberHeader', { index: index + 1 })}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5 text-red-400 hover:text-red-300"
                          disabled={locked}
                          aria-label={t('customTemplates.actions.removeMember')}
                          onClick={() => removeMember(index)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>

                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <div>
                          <Label
                            htmlFor={`member-${index}-name`}
                            className="text-[11px] text-[var(--color-text-muted)]"
                          >
                            {t('customTemplates.edit.memberNameLabel')}
                          </Label>
                          <Input
                            id={`member-${index}-name`}
                            value={member.name}
                            disabled={locked}
                            placeholder={t('customTemplates.edit.memberNamePlaceholder')}
                            aria-invalid={
                              mIssues.some((i) => i.field === `members[${index}].name`)
                                ? true
                                : undefined
                            }
                            aria-describedby={
                              mIssues.some((i) => i.field === `members[${index}].name`)
                                ? `member-${index}-error`
                                : undefined
                            }
                            onChange={(e) => updateMember(index, { name: e.target.value })}
                          />
                        </div>

                        <div>
                          <Label
                            htmlFor={`member-${index}-role`}
                            className="text-[11px] text-[var(--color-text-muted)]"
                          >
                            {t('customTemplates.edit.memberRoleLabel')}
                          </Label>
                          <Input
                            id={`member-${index}-role`}
                            value={member.role ?? ''}
                            disabled={locked}
                            placeholder={t('customTemplates.edit.memberRolePlaceholder')}
                            aria-invalid={
                              mIssues.some((i) => i.field === `members[${index}].role`)
                                ? true
                                : undefined
                            }
                            aria-describedby={
                              mIssues.some((i) => i.field === `members[${index}].role`)
                                ? `member-${index}-error`
                                : undefined
                            }
                            onChange={(e) => updateMember(index, { role: e.target.value })}
                          />
                        </div>

                        <div>
                          <Label
                            htmlFor={`member-${index}-workflow`}
                            className="text-[11px] text-[var(--color-text-muted)]"
                          >
                            {t('customTemplates.edit.memberWorkflowLabel')}
                          </Label>
                          <Input
                            id={`member-${index}-workflow`}
                            value={member.workflow ?? ''}
                            disabled={locked}
                            placeholder={t('customTemplates.edit.memberWorkflowPlaceholder')}
                            aria-invalid={
                              mIssues.some((i) => i.field === `members[${index}].workflow`)
                                ? true
                                : undefined
                            }
                            aria-describedby={
                              mIssues.some((i) => i.field === `members[${index}].workflow`)
                                ? `member-${index}-error`
                                : undefined
                            }
                            onChange={(e) => updateMember(index, { workflow: e.target.value })}
                          />
                        </div>
                      </div>

                      {mIssues.length > 0 ? (
                        <p
                          id={`member-${index}-error`}
                          role="alert"
                          className="text-xs text-red-300"
                        >
                          {mIssues.map(issueMessage).join(' ')}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={closeDisabled} onClick={onClose}>
            {tCommon('actions.cancel')}
          </Button>
          <Button disabled={!canSave} aria-busy={saving} onClick={() => void handleSave()}>
            {saving ? t('customTemplates.edit.saving') : t('customTemplates.edit.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
