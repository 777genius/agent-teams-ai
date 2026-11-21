import { useAppTranslation } from '@features/localization/renderer';

import { FLOW_TEXT_KEYS } from './reviewFlowText';

import type { ReviewFlowSettings } from '../../contracts/types';
import type {
  BoardSetting,
  ProjectTeamReviewFlowStatus,
} from '../view-model/projectTeamReviewFlow';

interface ReviewFlowProjectsNoticeProps {
  status: ProjectTeamReviewFlowStatus;
  /** Puts what one project has into the editor, so saving keeps it for the whole team. */
  onUse: (setting: ReviewFlowSettings | null) => void;
  disabled: boolean;
  testIdPrefix: string;
}

/**
 * A team with separate history per project has one review flow for all its projects. Says so, and
 * lists the projects whose board does not carry it (they disagree before the team's first save, or
 * a save could not reach them) with everything each one has, its instructions included, so nothing
 * a project had is replaced unseen; one of them can be taken over as the team's setting.
 */
export const ReviewFlowProjectsNotice = ({
  status,
  onUse,
  disabled,
  testIdPrefix,
}: Readonly<ReviewFlowProjectsNoticeProps>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const settingText = (setting: BoardSetting): string => {
    if (setting === 'unreadable') return t('reviewFlow.projects.unreadable');
    return setting
      ? t(FLOW_TEXT_KEYS[setting.reviewFlow].label)
      : t('reviewFlow.projects.followsDefault');
  };
  const { unsynced } = status;
  const message = (): string | null => {
    if (status.projectsError !== undefined) {
      return t('reviewFlow.projects.unreadableProjects', { message: status.projectsError });
    }
    if (unsynced.length > 0) {
      return status.saved ? t('reviewFlow.projects.notApplied') : t('reviewFlow.projects.differ');
    }
    return status.saveSuggested ? t('reviewFlow.projects.notSaved') : null;
  };
  const text = message();
  return (
    <div className="space-y-1.5" data-testid={`${testIdPrefix}-projects`}>
      <p className="text-xs text-[var(--color-text-muted)]">{t('reviewFlow.projects.scope')}</p>
      {text ? (
        <div
          role="status"
          className="space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5"
          data-testid={`${testIdPrefix}-projects-unsynced`}
        >
          <p className="text-xs text-[var(--color-text)]">{text}</p>
          {unsynced.length > 0 ? (
            <ul className="space-y-1 text-xs text-[var(--color-text-muted)]">
              {unsynced.map(({ projectLabel, setting }) => (
                <li key={projectLabel} className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p>
                      {t('reviewFlow.projects.item', {
                        project: projectLabel,
                        flow: settingText(setting),
                      })}
                    </p>
                    {setting && setting !== 'unreadable' && setting.reviewFlowPrompt ? (
                      <p className="truncate" title={setting.reviewFlowPrompt}>
                        {t('reviewFlow.projects.prompt', { prompt: setting.reviewFlowPrompt })}
                      </p>
                    ) : null}
                  </div>
                  {setting === 'unreadable' ? null : (
                    <button
                      type="button"
                      disabled={disabled}
                      className="shrink-0 underline-offset-2 hover:text-[var(--color-text)] hover:underline disabled:opacity-50"
                      data-testid={`${testIdPrefix}-use-project`}
                      onClick={() => onUse(setting)}
                    >
                      {t('reviewFlow.projects.use')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
