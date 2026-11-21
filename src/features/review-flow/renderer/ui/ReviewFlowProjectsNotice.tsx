import { useAppTranslation } from '@features/localization/renderer';

import { FLOW_TEXT_KEYS } from './reviewFlowText';

import type { BoardSetting, ProjectTeamReviewFlowStatus } from '../view-model/projectTeamReviewFlow';

interface ReviewFlowProjectsNoticeProps {
  status: ProjectTeamReviewFlowStatus;
  testIdPrefix: string;
}

/**
 * A team with separate history per project has one review flow for all its projects. Says so, and
 * lists the projects whose board does not carry it: they disagree before the team's first save, or
 * a save could not reach them.
 */
export const ReviewFlowProjectsNotice = ({
  status,
  testIdPrefix,
}: Readonly<ReviewFlowProjectsNoticeProps>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const settingText = (setting: BoardSetting): string => {
    if (setting === 'unreadable') return t('reviewFlow.projects.unreadable');
    return setting ? t(FLOW_TEXT_KEYS[setting.reviewFlow].label) : t('reviewFlow.projects.followsDefault');
  };
  const { unsynced } = status;
  return (
    <div className="space-y-1.5" data-testid={`${testIdPrefix}-projects`}>
      <p className="text-xs text-[var(--color-text-muted)]">{t('reviewFlow.projects.scope')}</p>
      {unsynced.length > 0 ? (
        <div
          role="status"
          className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5"
          data-testid={`${testIdPrefix}-projects-unsynced`}
        >
          <p className="text-xs text-[var(--color-text)]">
            {status.saved ? t('reviewFlow.projects.notApplied') : t('reviewFlow.projects.differ')}
          </p>
          <ul className="list-inside list-disc text-xs text-[var(--color-text-muted)]">
            {unsynced.map((board) => (
              <li key={board.projectLabel}>
                {t('reviewFlow.projects.item', {
                  project: board.projectLabel,
                  flow: settingText(board.setting),
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
};
