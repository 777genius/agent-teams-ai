import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Loader2 } from 'lucide-react';

type LaunchTeamDialogLoadingMode = 'launch' | 'relaunch' | 'schedule';

interface LaunchTeamDialogLoadingFallbackProps {
  readonly mode: LaunchTeamDialogLoadingMode;
  readonly teamName?: string;
  readonly isEditingSchedule?: boolean;
  readonly onClose: () => void;
}

export const LaunchTeamDialogLoadingFallback = ({
  mode,
  teamName,
  isEditingSchedule = false,
  onClose,
}: LaunchTeamDialogLoadingFallbackProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');

  const title =
    mode === 'schedule'
      ? isEditingSchedule
        ? t('launch.title.editSchedule')
        : t('launch.title.createSchedule')
      : mode === 'relaunch'
        ? t('launch.title.relaunch')
        : t('launch.title.launch');

  const description =
    mode === 'schedule'
      ? isEditingSchedule && teamName
        ? t('launch.description.editSchedule', { team: teamName })
        : teamName
          ? t('launch.description.createScheduleForTeam', { team: teamName })
          : t('launch.description.createSchedule')
      : mode === 'relaunch'
        ? t('launch.description.relaunchPrefix')
        : t('launch.description.launchPrefix');

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-[52rem]">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="text-xs">
            {mode === 'schedule' ? (
              description
            ) : (
              <>
                {description} <span className="font-mono font-medium">{teamName}</span>{' '}
                {mode === 'relaunch'
                  ? t('launch.description.relaunchSuffix')
                  : t('launch.description.launchSuffix')}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div
          className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-overlay)] px-3 py-2 text-xs text-[var(--color-text-muted)]"
          aria-live="polite"
        >
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          <span>{tCommon('states.loading')}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
};
