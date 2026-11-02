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
  ImportCustomTeamTemplateResult,
  PortableCustomTeamTemplateV1,
} from '@features/custom-team-templates/contracts';

interface ImportCustomTeamTemplateDialogProps {
  open: boolean;
  onClose: () => void;
}

export const ImportCustomTeamTemplateDialog = ({
  open,
  onClose,
}: ImportCustomTeamTemplateDialogProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const { platform, desktopFile, browserFile } = useTemplateFileOperations();
  const { importTemplate } = useTemplateImport();

  const [importStage, setImportStage] = useState<'idle' | 'importing' | 'conflict' | 'done'>(
    'idle'
  );
  const [errorState, setErrorState] = useState<
    | 'invalidJson'
    | 'invalidEncoding'
    | 'fileTooLarge'
    | 'fileReadFailed'
    | 'transportFailed'
    | 'unsupportedFormat'
    | 'unsupportedVersion'
    | 'validationFailed'
    | 'storageUnavailable'
    | 'unresolvedWriteOutcome'
    | null
  >(null);
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
      default:
        return t('customTemplates.errors.issues.invalidContent');
    }
  };

  const handleImportResult = useCallback(
    (result: ImportCustomTeamTemplateFromBrowserFileResult) => {
      switch (result.status) {
        case 'imported':
          setImportStage('done');
          break;
        case 'nameConflict':
          setImportStage('conflict');
          setConflictPortable(result.portable);
          setConflictExistingId(result.existingTemplateId);
          setRenameName(result.portable.name);
          break;
        case 'validationFailed':
          setErrorState('validationFailed');
          setIssues(result.issues);
          break;
        case 'unsupportedFormat':
          setErrorState('unsupportedFormat');
          break;
        case 'unsupportedVersion':
          setErrorState('unsupportedVersion');
          break;
        case 'storageUnavailable':
          setErrorState('storageUnavailable');
          break;
        case 'unresolvedWriteOutcome':
          setErrorState('unresolvedWriteOutcome');
          break;
        case 'invalidJson':
          setErrorState('invalidJson');
          break;
        case 'invalidEncoding':
          setErrorState('invalidEncoding');
          break;
        case 'fileTooLarge':
          setErrorState('fileTooLarge');
          break;
        case 'fileReadFailed':
          setErrorState('fileReadFailed');
          break;
        case 'transportFailed':
          setErrorState('transportFailed');
          break;
        case 'cancelled':
        default:
          break;
      }
    },
    []
  );

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      setImportStage('importing');
      setErrorState(null);
      setIssues([]);

      let result: ImportCustomTeamTemplateFromBrowserFileResult;

      if (platform === 'browser' && browserFile) {
        result = await browserFile.importFromFile(file);
      } else {
        setImportStage('idle');
        return;
      }

      handleImportResult(result);
      resetFileInput();
    },
    [platform, browserFile, handleImportResult, resetFileInput]
  );

  const handleDesktopImport = useCallback(async () => {
    if (!desktopFile) return;

    setImportStage('importing');
    setErrorState(null);
    setIssues([]);

    const result = await desktopFile.importFromFile();

    switch (result.status) {
      case 'imported':
        setImportStage('done');
        break;
      case 'nameConflict':
        setImportStage('conflict');
        setConflictPortable(result.portable);
        setConflictExistingId(result.existingTemplateId);
        setRenameName(result.portable.name);
        break;
      case 'validationFailed':
        setErrorState('validationFailed');
        setIssues(result.issues);
        break;
      case 'unsupportedFormat':
        setErrorState('unsupportedFormat');
        break;
      case 'unsupportedVersion':
        setErrorState('unsupportedVersion');
        break;
      case 'storageUnavailable':
        setErrorState('storageUnavailable');
        break;
      case 'unresolvedWriteOutcome':
        setErrorState('unresolvedWriteOutcome');
        break;
      case 'invalidJson':
        setErrorState('invalidJson');
        break;
      case 'invalidEncoding':
        setErrorState('invalidEncoding');
        break;
      case 'fileTooLarge':
        setErrorState('fileTooLarge');
        break;
      case 'fileReadFailed':
        setErrorState('fileReadFailed');
        break;
      case 'cancelled':
      case 'filePickerFailed':
      case 'fileChanged':
      default:
        setImportStage('idle');
        break;
    }
  }, [desktopFile]);

  const handleRenameConfirm = useCallback(async () => {
    if (!conflictPortable || !conflictExistingId) return;
    if (!renameName.trim()) return;

    setRenameBusy(true);
    setRenameIssues([]);

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

    switch (result?.status) {
      case 'imported':
        setImportStage('done');
        setRenameBusy(false);
        break;
      case 'nameConflict':
        // Preserve the imported data and allow another rename attempt.
        setConflictPortable(result.portable);
        setConflictExistingId(result.existingTemplateId);
        setRenameName(result.portable.name);
        setRenameBusy(false);
        break;
      case 'validationFailed':
        setRenameBusy(false);
        break;
      case 'storageUnavailable':
        setErrorState('storageUnavailable');
        setRenameBusy(false);
        break;
      case 'unresolvedWriteOutcome':
        // Do not blindly retry; keep the data and let the user decide.
        setErrorState('unresolvedWriteOutcome');
        setRenameBusy(false);
        break;
      default:
        setRenameBusy(false);
    }
  }, [conflictPortable, conflictExistingId, importTemplate, renameName]);

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
              <Button
                disabled={renameBusy || !renameName.trim()}
                aria-busy={renameBusy}
                onClick={() => handleRenameConfirm()}
              >
                {renameBusy
                  ? t('customTemplates.import.importing')
                  : t('customTemplates.import.confirmImport')}
              </Button>
            </>
          ) : importStage === 'done' ? (
            <Button variant="outline" onClick={handleClose} disabled={closeDisabled}>
              {tCommon('actions.close')}
            </Button>
          ) : (
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
