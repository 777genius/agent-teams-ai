import React, { useCallback, useRef, useState } from 'react';

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
import { AlertTriangle, Download, Upload } from 'lucide-react';

import { useTemplateFileOperations } from '../hooks/useTemplateFileOperations';
import { useTemplateImport } from '../hooks/useTemplateImport';

import type {
  CustomTeamTemplateValidationIssue,
  ImportCustomTeamTemplateFromBrowserFileResult,
  ImportCustomTeamTemplateFromFileResult,
  ImportCustomTeamTemplateResult,
  PortableCustomTeamTemplateV1,
} from '@features/custom-team-templates/contracts';

/**
 * Every closed import outcome the dialog can receive.
 *
 * The desktop and browser transports differ only by which file-level failures
 * they can report (`fileChanged`/`filePickerFailed` versus `transportFailed`), so
 * the dialog maps the union once instead of duplicating a switch per transport.
 */
type ImportOutcomeResult =
  | ImportCustomTeamTemplateFromFileResult
  | ImportCustomTeamTemplateFromBrowserFileResult;

interface ImportCustomTeamTemplateDialogProps {
  open: boolean;
  onClose: () => void;
}

type ImportStage = 'idle' | 'importing' | 'conflict' | 'done';

/** Every terminal failure the dialog can render, or `null` for a silent outcome. */
type ImportErrorState =
  | 'invalidJson'
  | 'invalidEncoding'
  | 'fileTooLarge'
  | 'fileReadFailed'
  | 'filePickerFailed'
  | 'fileChanged'
  | 'transportFailed'
  | 'unsupportedFormat'
  | 'unsupportedVersion'
  | 'validationFailed'
  | 'storageUnavailable'
  | 'templateIdConflict'
  | 'unresolvedWriteOutcome';

/** The dialog state one finished import attempt maps onto. */
interface ImportOutcomeView {
  /** A finished attempt always leaves `importing`. */
  stage: Exclude<ImportStage, 'importing'>;
  errorState: ImportErrorState | null;
  issues: readonly CustomTeamTemplateValidationIssue[];
}

const NO_ISSUES: readonly CustomTeamTemplateValidationIssue[] = [];

/**
 * Maps one closed import outcome onto the dialog's terminal view state.
 *
 * This is the only place that decides what a finished attempt means, so the
 * browser and desktop entry points cannot drift apart and a handled failure can
 * never leave the dialog stuck in the busy `importing` stage. Success (`done`)
 * and a name conflict (`conflict`) are never degraded to `idle`, and cancelling
 * is deliberately silent. `unresolvedWriteOutcome` is a failure state, not a
 * retry: the write may already have landed, so it must never be re-sent
 * automatically.
 */
function describeImportOutcome(result: ImportOutcomeResult): ImportOutcomeView {
  switch (result.status) {
    case 'imported':
      return { stage: 'done', errorState: null, issues: NO_ISSUES };
    case 'nameConflict':
      return { stage: 'conflict', errorState: null, issues: NO_ISSUES };
    case 'validationFailed':
      return { stage: 'idle', errorState: 'validationFailed', issues: result.issues };
    case 'unsupportedFormat':
      return { stage: 'idle', errorState: 'unsupportedFormat', issues: NO_ISSUES };
    case 'unsupportedVersion':
      return { stage: 'idle', errorState: 'unsupportedVersion', issues: NO_ISSUES };
    case 'storageUnavailable':
      return { stage: 'idle', errorState: 'storageUnavailable', issues: NO_ISSUES };
    case 'templateIdConflict':
      return { stage: 'idle', errorState: 'templateIdConflict', issues: NO_ISSUES };
    case 'unresolvedWriteOutcome':
      return { stage: 'idle', errorState: 'unresolvedWriteOutcome', issues: NO_ISSUES };
    case 'invalidJson':
      return { stage: 'idle', errorState: 'invalidJson', issues: NO_ISSUES };
    case 'invalidEncoding':
      return { stage: 'idle', errorState: 'invalidEncoding', issues: NO_ISSUES };
    case 'fileTooLarge':
      return { stage: 'idle', errorState: 'fileTooLarge', issues: NO_ISSUES };
    case 'fileReadFailed':
      return { stage: 'idle', errorState: 'fileReadFailed', issues: NO_ISSUES };
    case 'filePickerFailed':
      return { stage: 'idle', errorState: 'filePickerFailed', issues: NO_ISSUES };
    case 'fileChanged':
      return { stage: 'idle', errorState: 'fileChanged', issues: NO_ISSUES };
    case 'transportFailed':
      return { stage: 'idle', errorState: 'transportFailed', issues: NO_ISSUES };
    case 'cancelled':
      return { stage: 'idle', errorState: null, issues: NO_ISSUES };
    default:
      // Unreachable while the result contracts stay closed. Treating an unknown
      // status as "nothing happened" is the only safe reading: the dialog leaves
      // the busy stage and the user can try again.
      return { stage: 'idle', errorState: null, issues: NO_ISSUES };
  }
}

/**
 * Import dialog for one portable team template.
 *
 * Owns a small closed state machine: `idle` (pick a file), `importing` (busy),
 * `conflict` (rename an existing name), `done` (success). Every finished attempt
 * maps through `describeImportOutcome`, so a handled failure always leaves the
 * busy stage and re-enables Close and Import. A name conflict keeps the already
 * validated portable content in memory, so a rename retry never re-reads the
 * file, and an `unresolvedWriteOutcome` blocks the retry because the template may
 * already have been imported.
 */
export const ImportCustomTeamTemplateDialog = ({
  open,
  onClose,
}: ImportCustomTeamTemplateDialogProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const { platform, desktopFile, browserFile } = useTemplateFileOperations();
  const { importTemplate } = useTemplateImport();

  const [importStage, setImportStage] = useState<ImportStage>('idle');
  const [errorState, setErrorState] = useState<ImportErrorState | null>(null);
  const [issues, setIssues] = useState<readonly CustomTeamTemplateValidationIssue[]>([]);
  const [conflictPortable, setConflictPortable] = useState<PortableCustomTeamTemplateV1 | null>(
    null
  );
  const [conflictExistingId, setConflictExistingId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameIssues, setRenameIssues] = useState<readonly CustomTeamTemplateValidationIssue[]>(
    []
  );

  const fileInputRef = useRef<HTMLInputElement>(null);

  const isBusy = importStage === 'importing' || renameBusy;

  const resetFileInput = useCallback(() => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const handleClose = useCallback(() => {
    setImportStage('idle');
    setErrorState(null);
    setIssues([]);
    setConflictPortable(null);
    setConflictExistingId(null);
    setRenameName('');
    setRenameBusy(false);
    setRenameIssues([]);
    resetFileInput();
    onClose();
  }, [onClose, resetFileInput]);

  const issueMessage = (issue: CustomTeamTemplateValidationIssue): string => {
    switch (issue.code) {
      case 'templateNameRequired':
        return t('customTemplates.errors.issues.templateNameRequired');
      case 'templateNameTooLong':
        return t('customTemplates.errors.issues.templateNameTooLong');
      case 'templateNameInvalidCharacters':
        return t('customTemplates.errors.issues.templateNameInvalidCharacters');
      case 'teamPromptInvalidType':
        return t('customTemplates.errors.issues.teamPromptInvalidType');
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
      case 'unexpectedProperty':
        // `parameter` is the bare property name from the imported file. It is
        // interpolated as text, never as markup, and never as a filesystem path.
        return t('customTemplates.errors.issues.unexpectedProperty', {
          property: issue.parameter ?? issue.field,
        });
      default:
        return t('customTemplates.errors.issues.invalidContent');
    }
  };

  const handleImportResult = useCallback((result: ImportOutcomeResult) => {
    const view = describeImportOutcome(result);
    setImportStage(view.stage);
    setErrorState(view.errorState);
    setIssues(view.issues);
    if (result.status === 'nameConflict') {
      // The reviewed portable content is retained so a rename retry never has to
      // re-read or re-parse the untrusted file.
      setConflictPortable(result.portable);
      setConflictExistingId(result.existingTemplateId);
      setRenameName(result.portable.name);
    }
  }, []);

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      setImportStage('importing');
      setErrorState(null);
      setIssues([]);

      try {
        if (platform !== 'browser' || !browserFile) {
          setImportStage('idle');
          return;
        }
        handleImportResult(await browserFile.importFromFile(file));
      } catch {
        // A rejected browser read is definitive: nothing was written, so the
        // dialog must offer a retry instead of staying busy.
        handleImportResult({ status: 'transportFailed' });
      } finally {
        resetFileInput();
      }
    },
    [platform, browserFile, handleImportResult, resetFileInput]
  );

  const handleDesktopImport = useCallback(async () => {
    if (!desktopFile) return;

    setImportStage('importing');
    setErrorState(null);
    setIssues([]);

    try {
      handleImportResult(await desktopFile.importFromFile());
    } catch {
      // The IPC channel rejected instead of answering with a typed outcome, so
      // the read never completed and the dialog must leave the busy stage.
      handleImportResult({ status: 'transportFailed' });
    }
  }, [desktopFile, handleImportResult]);

  const handleRenameConfirm = useCallback(async () => {
    if (!conflictPortable || !conflictExistingId) return;
    if (!renameName.trim()) return;
    // A previous attempt may have committed without a confirmed answer. Retrying
    // it automatically could create a duplicate template, so the user must close
    // the dialog and start a fresh import after checking My Templates.
    if (errorState === 'unresolvedWriteOutcome') return;

    setRenameBusy(true);
    setRenameIssues([]);
    // A new, definitively allowed attempt supersedes the previous failure
    // banner; otherwise a success could render next to a stale error.
    setErrorState(null);

    const renamed: PortableCustomTeamTemplateV1 = {
      ...conflictPortable,
      name: renameName.trim(),
    };

    let result: ImportCustomTeamTemplateResult | undefined;
    try {
      result = await importTemplate(renamed);
    } catch {
      setErrorState('transportFailed');
      setRenameBusy(false);
      return;
    }

    const view = describeImportOutcome(result ?? { status: 'transportFailed' });
    switch (result?.status) {
      case 'imported':
        setImportStage('done');
        break;
      case 'nameConflict':
        // Preserve the imported data and allow another rename attempt.
        setConflictPortable(result.portable);
        setConflictExistingId(result.existingTemplateId);
        setRenameName(result.portable.name);
        break;
      case 'validationFailed':
        setRenameIssues(result.issues);
        break;
      default:
        // Stay in the conflict stage so the reviewed content and the chosen name
        // survive, and surface the failure instead of retrying it silently.
        setErrorState(view.errorState ?? 'transportFailed');
        break;
    }
    setRenameBusy(false);
  }, [conflictPortable, conflictExistingId, errorState, importTemplate, renameName]);

  if (!open) return null;

  const closeDisabled = isBusy;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !closeDisabled) handleClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('customTemplates.import.title')}</DialogTitle>
          <DialogDescription>{t('customTemplates.import.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {importStage === 'done' ? (
            <div
              role="status"
              data-testid="import-template-done"
              className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-200"
            >
              <Download className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">{t('customTemplates.import.success')}</p>
                <p>{t('customTemplates.import.successBody')}</p>
              </div>
            </div>
          ) : null}

          {importStage === 'conflict' ? (
            <div
              role="alert"
              data-testid="import-template-name-conflict"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="font-medium">{t('customTemplates.import.nameConflictTitle')}</p>
                <p>
                  {t('customTemplates.import.nameConflictBody', {
                    name: conflictPortable?.name ?? '',
                  })}
                </p>
              </div>
            </div>
          ) : null}

          {errorState === 'invalidJson' ? (
            <div
              role="alert"
              data-testid="import-template-invalid-json"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.import.errors.invalidJson')}</p>
            </div>
          ) : null}

          {errorState === 'invalidEncoding' ? (
            <div
              role="alert"
              data-testid="import-template-invalid-encoding"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.import.errors.invalidEncoding')}</p>
            </div>
          ) : null}

          {errorState === 'fileTooLarge' ? (
            <div
              role="alert"
              data-testid="import-template-file-too-large"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.import.errors.fileTooLarge')}</p>
            </div>
          ) : null}

          {errorState === 'fileReadFailed' ? (
            <div
              role="alert"
              data-testid="import-template-file-read-failed"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.import.errors.fileReadFailed')}</p>
            </div>
          ) : null}

          {errorState === 'filePickerFailed' ? (
            <div
              role="alert"
              data-testid="import-template-file-picker-failed"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.import.errors.filePickerFailed')}</p>
            </div>
          ) : null}

          {errorState === 'fileChanged' ? (
            <div
              role="alert"
              data-testid="import-template-file-changed"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.import.errors.fileChanged')}</p>
            </div>
          ) : null}

          {errorState === 'transportFailed' ? (
            <div
              role="alert"
              data-testid="import-template-transport-failed"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.import.errors.transportFailed')}</p>
            </div>
          ) : null}

          {errorState === 'unsupportedFormat' ? (
            <div
              role="alert"
              data-testid="import-template-unsupported-format"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.import.errors.unsupportedFormat')}</p>
            </div>
          ) : null}

          {errorState === 'unsupportedVersion' ? (
            <div
              role="alert"
              data-testid="import-template-unsupported-version"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.import.errors.unsupportedVersion')}</p>
            </div>
          ) : null}

          {errorState === 'validationFailed' ? (
            <div
              role="alert"
              data-testid="import-template-validation-failed"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{issues.map(issueMessage).join(' ')}</p>
            </div>
          ) : null}

          {errorState === 'storageUnavailable' ? (
            <div
              role="alert"
              data-testid="import-template-storage-unavailable"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.import.errors.storageUnavailable')}</p>
            </div>
          ) : null}

          {errorState === 'templateIdConflict' ? (
            <div
              role="alert"
              data-testid="import-template-id-conflict"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.templateIdConflict')}</p>
            </div>
          ) : null}

          {errorState === 'unresolvedWriteOutcome' ? (
            <div
              role="alert"
              data-testid="import-template-unresolved"
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">{t('customTemplates.states.unresolvedTitle')}</p>
                <p>{t('customTemplates.states.unresolvedImportBody')}</p>
              </div>
            </div>
          ) : null}

          {importStage === 'conflict' && conflictPortable ? (
            <div className="space-y-1.5">
              <Label htmlFor="import-rename-name">
                {t('customTemplates.import.renameNameFieldLabel')}
              </Label>
              <Input
                id="import-rename-name"
                value={renameName}
                disabled={renameBusy}
                aria-invalid={renameIssues.length > 0 || undefined}
                aria-describedby={renameIssues.length > 0 ? 'import-rename-name-error' : undefined}
                onChange={(e) => {
                  setRenameName(e.target.value);
                  setRenameIssues([]);
                }}
              />
              {renameIssues.length > 0 ? (
                <p id="import-rename-name-error" role="alert" className="text-xs text-red-300">
                  {renameIssues.map(issueMessage).join(' ')}
                </p>
              ) : null}
            </div>
          ) : null}

          {importStage === 'idle' && platform !== 'none' ? (
            <div className="space-y-1.5">
              {platform === 'browser' ? (
                <>
                  <Label htmlFor="import-file-input">
                    {t('customTemplates.import.selectFileLabel')}
                  </Label>
                  <Input
                    id="import-file-input"
                    type="file"
                    accept=".json"
                    disabled={isBusy}
                    ref={fileInputRef}
                    onChange={handleFileSelect}
                    className="block w-full text-sm text-[var(--color-text)] text-[var(--color-text-muted)] file:mr-4 file:rounded-md file:border-0 file:py-2 file:text-sm file:font-semibold hover:file:bg-[var(--color-surface-raised)]"
                  />
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {t('customTemplates.import.fileHint')}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {t('customTemplates.import.platformElectron')}
                  </p>
                </>
              )}
            </div>
          ) : null}

          {platform === 'none' ? (
            <div
              role="status"
              data-testid="import-template-platform-unavailable"
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.import.platformUnavailable')}</p>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={closeDisabled} onClick={handleClose}>
            {tCommon('actions.close')}
          </Button>
          {importStage === 'conflict' ? (
            <>
              <Button
                variant="outline"
                disabled={renameBusy || !renameName.trim()}
                onClick={() => {
                  setImportStage('idle');
                  setConflictPortable(null);
                  setConflictExistingId(null);
                  setRenameName('');
                  resetFileInput();
                }}
              >
                {tCommon('actions.cancel')}
              </Button>
              {/* A possibly committed import is never re-sent automatically, so the
                  retry stays disabled until the user starts a fresh import. */}
              <Button
                disabled={
                  renameBusy || !renameName.trim() || errorState === 'unresolvedWriteOutcome'
                }
                aria-busy={renameBusy}
                onClick={() => handleRenameConfirm()}
              >
                {renameBusy
                  ? t('customTemplates.import.importing')
                  : t('customTemplates.import.confirmImport')}
              </Button>
            </>
          ) : importStage === 'done' ? null : (
            <Button
              variant="outline"
              disabled={closeDisabled || platform === 'none'}
              onClick={
                platform === 'electron'
                  ? handleDesktopImport
                  : () => {
                      const input = fileInputRef.current;
                      if (input) input.click();
                    }
              }
            >
              {isBusy ? (
                t('customTemplates.import.importing')
              ) : (
                <>
                  <Upload className="mr-2 size-3.5" /> {t('customTemplates.import.action')}
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
