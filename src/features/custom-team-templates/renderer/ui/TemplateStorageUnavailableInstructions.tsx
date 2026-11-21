import { useAppTranslation } from '@features/localization/renderer';

/** Reports an unavailable worker without guessing the database's integrity. */
export const TemplateStorageUnavailableInstructions = ({
  status,
  storageDirectory,
  databasePath,
}: {
  status: 'storageVerificationRequired' | 'storageSafetyUnavailable';
  storageDirectory: string;
  databasePath: string;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <div className="min-w-0 space-y-2">
      <p>
        {t(
          status === 'storageVerificationRequired'
            ? 'customTemplates.library.storageVerificationRequired'
            : 'customTemplates.library.storageSafetyUnavailable'
        )}
      </p>
      <p>
        {t('customTemplates.library.recoveryStorageDirectory')}{' '}
        <code className="break-all" data-testid="template-unavailable-directory">
          {storageDirectory}
        </code>
      </p>
      {status === 'storageVerificationRequired' && (
        <code className="block break-all" data-testid="template-unverified-database">
          {databasePath}
        </code>
      )}
    </div>
  );
};
