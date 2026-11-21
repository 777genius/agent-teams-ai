import { useAppTranslation } from '@features/localization/renderer';

/** Shows the server-side paths and manual steps without performing recovery. */
export const TemplateRecoveryInstructions = ({
  storageDirectory,
  markerPath,
  interruptedMarkerPath,
  markerWriteFailed,
  interrupted,
}: {
  storageDirectory: string;
  markerPath: string;
  interruptedMarkerPath: string;
  markerWriteFailed?: true;
  interrupted: boolean;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <div className="min-w-0 space-y-2">
      <p>
        {t(
          interrupted
            ? 'customTemplates.library.recoveryInterrupted'
            : 'customTemplates.library.recoveryRequired'
        )}
      </p>
      {markerWriteFailed && <p>{t('customTemplates.library.recoveryMarkerWriteFailed')}</p>}
      <p>{t('customTemplates.library.recoveryStopAndPreserve')}</p>
      <p>
        {t('customTemplates.library.recoveryStorageDirectory')}{' '}
        <code className="break-all" data-testid="template-recovery-directory">
          {storageDirectory}
        </code>
      </p>
      <p>{t('customTemplates.library.recoveryBackupWarning')}</p>
      <p>{t('customTemplates.library.recoveryOtherStores')}</p>
      <p>{t('customTemplates.library.recoveryMarkerInstructions')}</p>
      <p>
        {t('customTemplates.library.recoveryMarkerPath')}{' '}
        <code className="break-all" data-testid="template-recovery-marker">
          {markerPath}
        </code>
      </p>
      <p>
        {t('customTemplates.library.recoveryInterruptedMarkerPath')}{' '}
        <code className="break-all" data-testid="template-recovery-interrupted-marker">
          {interruptedMarkerPath}
        </code>
      </p>
    </div>
  );
};
