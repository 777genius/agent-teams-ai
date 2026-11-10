import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { FolderPlus } from 'lucide-react';

import { getCustomProjectFolderNotice } from './customProjectFolderNoticeModel';

import type { CustomProjectFolderNoticeTone } from './customProjectFolderNoticeModel';
import type { CustomProjectFolderModel } from './useCustomProjectFolder';

const TONE_STYLE: Record<CustomProjectFolderNoticeTone, React.CSSProperties | undefined> = {
  muted: undefined,
  warning: { color: 'var(--warning-text)' },
  error: { color: 'var(--field-error-text)' },
};

export const CustomProjectFolderNotice = ({
  folder,
}: {
  folder: CustomProjectFolderModel;
}): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const notice = getCustomProjectFolderNotice(folder);
  if (!notice && !folder.createError) return null;

  return (
    <div className="space-y-1" data-testid="custom-project-folder-notice">
      {notice ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p
            className={
              notice.tone === 'muted' ? 'text-[11px] text-[var(--color-text-muted)]' : 'text-[11px]'
            }
            style={TONE_STYLE[notice.tone]}
          >
            {t(`projectPath.${notice.message}`)}
          </p>
          {notice.canCreate ? (
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px]"
              disabled={folder.creating || folder.checking}
              onClick={() => void folder.create()}
            >
              <FolderPlus size={12} />
              {folder.creating ? t('projectPath.folder.creating') : t('projectPath.folder.create')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {folder.createError ? (
        <p className="text-[11px]" style={{ color: 'var(--field-error-text)' }} role="alert">
          {t(`projectPath.folder.createFailed.${folder.createError}`)}
        </p>
      ) : null}
    </div>
  );
};
