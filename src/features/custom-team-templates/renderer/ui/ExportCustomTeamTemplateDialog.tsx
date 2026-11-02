import React, { useCallback, useState } from 'react';

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
import { AlertTriangle, Download } from 'lucide-react';

import { useTemplateFileOperations } from '../hooks/useTemplateFileOperations';

import type { ExportCustomTeamTemplateToBrowserFileResult } from '@features/custom-team-templates/contracts';

interface ExportCustomTeamTemplateDialogProps {
  open: boolean;
  templateId: string;
  templateName: string;
  onClose: () => void;
}

export const ExportCustomTeamTemplateDialog = ({
  open,
  templateId,
  templateName,
  onClose,
}: ExportCustomTeamTemplateDialogProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const { platform, desktopFile, browserFile } = useTemplateFileOperations();

  const [exportStage, setExportStage] = useState<'idle' | 'exporting' | 'done'>('idle');
  const [errorState, setErrorState] = useState<
    | 'notFound'
    | 'unreadableRecord'
    | 'storageUnavailable'
    | 'downloadFailed'
    | 'transportFailed'
    | null
  >(null);
  const [busy, setBusy] = useState(false);

  const isBusy = exportStage === 'exporting';

  const handleClose = useCallback(() => {
    setExportStage('idle');
    setErrorState(null);
    onClose();
  }, [onClose]);

  const handleExport = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setExportStage('exporting');
    setErrorState(null);

    let result: ExportCustomTeamTemplateToBrowserFileResult;

    if (platform === 'electron' && desktopFile) {
      const desktopResult = await desktopFile.exportToFile({ templateId });
      // Map desktop-specific file outcomes to browser-facing outcomes.
      switch (desktopResult.status) {
        case 'exported':
          result = { status: 'exported' };
          break;
        case 'notFound':
          result = { status: 'notFound', templateId: desktopResult.templateId };
          break;
        case 'unreadableRecord':
          result = { status: 'unreadableRecord', templateId: desktopResult.templateId };
          break;
        case 'storageUnavailable':
          result = { status: 'storageUnavailable' };
          break;
        case 'cancelled':
        case 'invalidRequest':
        case 'filePickerFailed':
        case 'fileWriteFailed':
        default:
          result = { status: 'cancelled' };
          break;
      }
    } else if (platform === 'browser' && browserFile) {
      result = await browserFile.exportToFile({ templateId });
    } else {
      setBusy(false);
      setExportStage('idle');
      return;
    }

    switch (result.status) {
      case 'exported':
        setExportStage('done');
        setBusy(false);
        break;
      case 'notFound':
        setErrorState('notFound');
        setBusy(false);
        setExportStage('idle');
        break;
      case 'unreadableRecord':
        setErrorState('unreadableRecord');
        setBusy(false);
        setExportStage('idle');
        break;
      case 'storageUnavailable':
        setErrorState('storageUnavailable');
        setBusy(false);
        setExportStage('idle');
        break;
      case 'downloadFailed':
        setErrorState('downloadFailed');
        setBusy(false);
        setExportStage('idle');
        break;
      case 'transportFailed':
        setErrorState('transportFailed');
        setBusy(false);
        setExportStage('idle');
        break;
      case 'cancelled':
      default:
        setBusy(false);
        setExportStage('idle');
        break;
    }
  }, [platform, desktopFile, browserFile, templateId, busy]);

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
          <DialogTitle>{t('customTemplates.export.title')}</DialogTitle>
          <DialogDescription>
            {t('customTemplates.export.description', { name: templateName })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {exportStage === 'done' ? (
            <div
              role="status"
              data-testid="export-template-done"
              className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-200"
            >
              <Download className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">{t('customTemplates.export.success')}</p>
                <p>{t('customTemplates.export.successBody', { name: templateName })}</p>
              </div>
            </div>
          ) : null}

          {errorState === 'notFound' ? (
            <div
              role="alert"
              data-testid="export-template-not-found"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.notFound')}</p>
            </div>
          ) : null}

          {errorState === 'unreadableRecord' ? (
            <div
              role="alert"
              data-testid="export-template-unreadable-record"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.unreadableRecord')}</p>
            </div>
          ) : null}

          {errorState === 'storageUnavailable' ? (
            <div
              role="alert"
              data-testid="export-template-storage-unavailable"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.errors.storageUnavailable')}</p>
            </div>
          ) : null}

          {errorState === 'downloadFailed' ? (
            <div
              role="alert"
              data-testid="export-template-download-failed"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.export.errors.downloadFailed')}</p>
            </div>
          ) : null}

          {errorState === 'transportFailed' ? (
            <div
              role="alert"
              data-testid="export-template-transport-failed"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('customTemplates.export.errors.transportFailed')}</p>
            </div>
          ) : null}

          {platform === 'none' ? (
            <div
              role="status"
              data-testid="export-template-platform-unavailable"
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
          {exportStage === 'done' ? (
            <Button variant="outline" onClick={handleClose} disabled={closeDisabled}>
              {tCommon('actions.close')}
            </Button>
          ) : platform === 'none' ? (
            <Button variant="outline" disabled onClick={handleClose}>
              {tCommon('actions.close')}
            </Button>
          ) : (
            <Button disabled={closeDisabled || busy} aria-busy={busy} onClick={handleExport}>
              {busy ? t('customTemplates.export.exporting') : t('customTemplates.export.action')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
