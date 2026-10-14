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
import { AlertTriangle, CheckCircle2, Info, RefreshCw } from 'lucide-react';

import { useSaveAsTemplate } from '../hooks/useSaveAsTemplate';

import type { CustomTeamTemplateValidationIssue } from '@features/custom-team-templates/contracts';

export interface SaveAsTemplateDialogProps {
  open: boolean;
  /** Existing team whose saved configuration supplies the template content. */
  sourceTeamName: string;
  /** Proposed template name; the dialog edits only name and description. */
  initialName: string;
  onClose: () => void;
}

interface StateBox {
  message: string;
  tone: 'error' | 'info';
  /** Optional headline; an unresolved outcome must read as its own state. */
  title?: string;
  /** Offer an inline Retry that re-runs preview preparation. */
  retry: boolean;
}

/**
 * Read-only review of the exact allowlisted content plus the two editable
 * fields (name and description).
 *
 * Every typed API outcome is rendered distinctly: a blocked roster or source
 * shows an error with Retry, a name conflict stays inside the dialog with the
 * typed values intact, a stale preview refreshes and asks for a renewed
 * confirmation, and an unresolved write offers Re-check instead of a second
 * create. Success is only ever shown for a confirmed `created`,
 * `alreadySaved` or re-check `saved` result.
 */
export const SaveAsTemplateDialog = ({
  open,
  sourceTeamName,
  initialName,
  onClose,
}: SaveAsTemplateDialogProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const flow = useSaveAsTemplate({ open, sourceTeamName, initialName });

  const {
    name,
    description,
    preview,
    preparing,
    blockedReason,
    issues,
    nameConflict,
    notice,
    attempt,
    canSave,
    canRecheck,
    busy,
    setName,
    setDescription,
    save,
    recheck,
    refresh,
  } = flow;

  const attemptStatus = attempt?.status;
  const saved = attemptStatus === 'saved' ? attempt : null;

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
      case 'previewTokenRequired':
      case 'previewTokenUnknown':
        return t('customTemplates.errors.issues.previewTokenInvalid');
      case 'previewTokenExpired':
        return t('customTemplates.errors.issues.previewTokenExpired');
      default:
        return t('customTemplates.errors.issues.invalidContent');
    }
  };

  const nameIssues = issues.filter((issue) => issue.field === 'name');
  const descriptionIssues = issues.filter((issue) => issue.field === 'description');
  const generalIssues = issues.filter(
    (issue) => issue.field !== 'name' && issue.field !== 'description'
  );

  const blockedBox = ((): StateBox | null => {
    switch (blockedReason) {
      case 'rosterUnreadable':
        return {
          message: t('customTemplates.errors.rosterUnreadable'),
          tone: 'error',
          retry: true,
        };
      case 'sourceUnavailable':
        return {
          message: t('customTemplates.errors.sourceUnavailable'),
          tone: 'error',
          retry: true,
        };
      case 'storageUnavailable':
        return {
          message: t('customTemplates.errors.storageUnavailable'),
          tone: 'error',
          retry: true,
        };
      case 'requestFailed':
        return { message: t('customTemplates.errors.requestFailed'), tone: 'error', retry: true };
      case null:
        return null;
    }
  })();

  const stateBox = ((): StateBox | null => {
    if (blockedBox) return blockedBox;
    if (nameConflict) {
      return { message: t('customTemplates.errors.nameConflict'), tone: 'error', retry: true };
    }
    if (generalIssues.length > 0) {
      return {
        message: generalIssues.map(issueMessage).join(' '),
        tone: 'error',
        retry: preview === null,
      };
    }
    if (attemptStatus === 'unresolved') {
      return {
        title: t('customTemplates.states.unresolvedTitle'),
        message: t('customTemplates.states.unresolvedBody'),
        tone: 'error',
        retry: false,
      };
    }
    if (attemptStatus === 'requestFailed') {
      return {
        title: t('customTemplates.states.unresolvedTitle'),
        message: t('customTemplates.errors.saveOutcomeUnknown'),
        tone: 'error',
        retry: false,
      };
    }
    if (attemptStatus === 'notSaved') {
      return { message: t('customTemplates.states.notSaved'), tone: 'info', retry: false };
    }
    if (attemptStatus === 'idConflict') {
      return {
        message: t('customTemplates.errors.templateIdConflict'),
        tone: 'error',
        retry: true,
      };
    }
    if (attempt?.status === 'unavailable') {
      return {
        message:
          attempt.during === 'save'
            ? t('customTemplates.errors.storageUnavailableSave')
            : t('customTemplates.errors.storageUnavailableRecheck'),
        tone: 'error',
        retry: attempt.during === 'save',
      };
    }
    return null;
  })();

  const noticeBox = ((): { message: string } | null => {
    if (notice === 'stale') return { message: t('customTemplates.states.stalePreview') };
    if (notice === 'expired') return { message: t('customTemplates.states.previewExpired') };
    return null;
  })();

  const saving = attemptStatus === 'saving' || attemptStatus === 'rechecking';
  const saveDisabled = !canSave || saving;
  // Only an in-flight write may block dismissal: a slow preview must never
  // trap the dialog.
  const closeDisabled = saving;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !closeDisabled) onClose();
      }}
    >
      <DialogContent
        className="max-w-2xl"
        closeDisabled={closeDisabled}
        onEscapeKeyDown={(event) => closeDisabled && event.preventDefault()}
        onInteractOutside={(event) => closeDisabled && event.preventDefault()}
        // The dialog is portaled for layout but stays a React descendant of the
        // team row that opened it, so an inner click or Enter/Space key press
        // would otherwise bubble into the row's open-team handler and navigate
        // the list away while the dialog is still open. Escape and Tab keep
        // propagating so Radix keeps its own close/focus behaviour.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('customTemplates.save.title')}</DialogTitle>
          <DialogDescription>{t('customTemplates.save.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {noticeBox ? (
            <div
              role="status"
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
            >
              <Info className="mt-0.5 size-4 shrink-0" />
              <p>{noticeBox.message}</p>
            </div>
          ) : null}

          {saved ? (
            <div
              role="status"
              data-testid="custom-template-saved"
              className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-200"
            >
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">{t('customTemplates.states.saved')}</p>
                <p>
                  {saved.alreadyPresent
                    ? t('customTemplates.states.savedAlready')
                    : t('customTemplates.states.savedBody', { name: saved.template.name })}
                </p>
              </div>
            </div>
          ) : null}

          {stateBox ? (
            <div
              role={stateBox.tone === 'error' ? 'alert' : 'status'}
              data-testid="custom-template-state"
              className={`flex items-start gap-2 rounded-md border p-3 text-sm ${
                stateBox.tone === 'error'
                  ? 'border-red-500/40 bg-red-500/10 text-red-200'
                  : 'border-sky-500/40 bg-sky-500/10 text-sky-200'
              }`}
            >
              {stateBox.tone === 'error' ? (
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              ) : (
                <Info className="mt-0.5 size-4 shrink-0" />
              )}
              <div className="min-w-0 flex-1 space-y-2">
                {stateBox.title ? <p className="font-medium">{stateBox.title}</p> : null}
                <p>{stateBox.message}</p>
                {stateBox.retry ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    disabled={busy}
                    onClick={() => void refresh()}
                  >
                    <RefreshCw className="size-3.5" />
                    {t('customTemplates.actions.retry')}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {!preview && preparing ? (
            <p role="status" className="text-sm text-[var(--color-text-muted)]">
              {t('customTemplates.states.preparing')}
            </p>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="custom-template-name">{t('customTemplates.save.nameFieldLabel')}</Label>
            <Input
              id="custom-template-name"
              value={name}
              disabled={saving || saved !== null}
              aria-invalid={nameIssues.length > 0 || undefined}
              aria-describedby={nameIssues.length > 0 ? 'custom-template-name-error' : undefined}
              onChange={(event) => setName(event.target.value)}
            />
            {nameIssues.length > 0 ? (
              <p id="custom-template-name-error" role="alert" className="text-xs text-red-300">
                {nameIssues.map(issueMessage).join(' ')}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="custom-template-description">
              {t('customTemplates.save.descriptionLabel')}
            </Label>
            <Textarea
              id="custom-template-description"
              value={description}
              disabled={saving || saved !== null}
              aria-invalid={descriptionIssues.length > 0 || undefined}
              aria-describedby={
                descriptionIssues.length > 0 ? 'custom-template-description-error' : undefined
              }
              onChange={(event) => setDescription(event.target.value)}
            />
            {descriptionIssues.length > 0 ? (
              <p
                id="custom-template-description-error"
                role="alert"
                className="text-xs text-red-300"
              >
                {descriptionIssues.map(issueMessage).join(' ')}
              </p>
            ) : null}
          </div>

          {preview ? (
            <section
              data-testid="custom-template-preview"
              aria-label={t('customTemplates.preview.title')}
              className="space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-[var(--color-text)]">
                  {t('customTemplates.preview.title')}
                </h3>
                <span className="text-xs text-[var(--color-text-muted)]">
                  {t('customTemplates.preview.sourceTeam')}: {preview.sourceTeamName}
                </span>
              </div>

              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                  {t('customTemplates.preview.prompt')}
                </p>
                {preview.teamPrompt.trim() ? (
                  <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded border border-[var(--color-border)] bg-[var(--color-surface-overlay)] p-2 text-sm text-[var(--color-text)]">
                    {preview.teamPrompt}
                  </p>
                ) : (
                  <p className="text-sm text-[var(--color-text-muted)]">
                    {t('customTemplates.preview.promptEmpty')}
                  </p>
                )}
              </div>

              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                  {t('customTemplates.preview.membersLabel')} (
                  {t('list.membersCount', { count: preview.members.length })})
                </p>
                {preview.members.length > 0 ? (
                  <ul className="space-y-1">
                    {preview.members.map((member, index) => (
                      <li
                        key={`${member.name}-${index}`}
                        className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-overlay)] px-2 py-1.5 text-sm"
                      >
                        <span className="font-medium text-[var(--color-text)]">{member.name}</span>
                        <span className="text-xs text-[var(--color-text-muted)]">
                          {t('customTemplates.preview.roleLabel')}:{' '}
                          {member.role?.trim()
                            ? member.role
                            : t('customTemplates.preview.roleMissing')}
                        </span>
                        <span className="text-xs text-[var(--color-text-muted)]">
                          {t('customTemplates.preview.workflowLabel')}:{' '}
                          {member.workflow?.trim()
                            ? member.workflow
                            : t('customTemplates.preview.workflowMissing')}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-[var(--color-text-muted)]">
                    {t('customTemplates.preview.membersEmpty')}
                  </p>
                )}
              </div>

              {preview.warnings.length > 0 ? (
                <ul className="space-y-1" aria-label={t('customTemplates.preview.warningsLabel')}>
                  {preview.warnings.map((warning, index) => {
                    const informational =
                      warning.code === 'noRecordedRoster' || warning.code === 'emptyRoster';
                    return (
                      <li
                        key={`${warning.code}-${index}`}
                        className={`flex items-start gap-1.5 text-xs ${
                          informational ? 'text-sky-300' : 'text-amber-300'
                        }`}
                      >
                        <Info className="mt-0.5 size-3.5 shrink-0" />
                        <span>
                          {(() => {
                            switch (warning.code) {
                              case 'missingTeamPrompt':
                                return t('customTemplates.warnings.missingTeamPrompt');
                              case 'noRecordedRoster':
                                return t('customTemplates.warnings.noRecordedRoster');
                              case 'emptyRoster':
                                return t('customTemplates.warnings.emptyRoster');
                              case 'missingMemberRole':
                                return t('customTemplates.warnings.missingMemberRole', {
                                  member: warning.memberName,
                                });
                              case 'missingMemberWorkflow':
                                return t('customTemplates.warnings.missingMemberWorkflow', {
                                  member: warning.memberName,
                                });
                              case 'removedMembersExcluded':
                                return t('customTemplates.warnings.removedMembersExcluded', {
                                  total: warning.count,
                                });
                            }
                          })()}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>
          ) : null}

          {attemptStatus === 'rechecking' ? (
            <p role="status" className="text-sm text-[var(--color-text-muted)]">
              {t('customTemplates.states.rechecking')}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          {preview === null && !preparing && !(stateBox?.retry ?? false) ? (
            <Button
              variant="outline"
              className="gap-1.5"
              disabled={busy}
              onClick={() => void refresh()}
            >
              <RefreshCw className="size-3.5" />
              {t('customTemplates.actions.retry')}
            </Button>
          ) : null}
          {canRecheck && attemptStatus !== 'rechecking' ? (
            <Button
              variant="outline"
              className="gap-1.5"
              disabled={busy}
              onClick={() => void recheck()}
            >
              <RefreshCw className="size-3.5" />
              {t('customTemplates.actions.recheck')}
            </Button>
          ) : null}
          <Button variant="outline" disabled={closeDisabled} onClick={onClose}>
            {tCommon('actions.close')}
          </Button>
          {saved ? null : (
            <Button
              disabled={saveDisabled}
              aria-busy={attemptStatus === 'saving'}
              onClick={() => void save()}
            >
              {attemptStatus === 'saving'
                ? t('customTemplates.states.saving')
                : t('customTemplates.actions.save')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
