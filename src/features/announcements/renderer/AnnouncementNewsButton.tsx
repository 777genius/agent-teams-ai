import { useAppTranslation } from '@features/localization/renderer';
import { isElectronMode } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { Newspaper } from 'lucide-react';

import { openAnnouncementHistory } from './newsNavigation';

/** Keep the global news action reachable on full-window work screens. */
export const AnnouncementNewsButton = (): React.JSX.Element | null => {
  const { t } = useAppTranslation('common');
  if (!isElectronMode()) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-text-muted"
          aria-label={t('announcements.title')}
          onClick={openAnnouncementHistory}
        >
          <Newspaper className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{t('announcements.title')}</TooltipContent>
    </Tooltip>
  );
};
