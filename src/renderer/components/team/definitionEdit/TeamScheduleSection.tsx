import { useAppTranslation } from '@features/localization/renderer';

import { ScheduleSection } from '../schedule/ScheduleSection';

interface Props {
  teamName: string;
  /** A team with separate history per project: the scheduler refuses it. */
  perProject: boolean;
}

/** The schedules of a team, or an honest note for a team that cannot have any yet. */
export const TeamScheduleSection = ({ teamName, perProject }: Readonly<Props>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  if (perProject) {
    return (
      <p className="text-xs text-[var(--color-text-muted)]">{t('schedule.perProjectUnavailable')}</p>
    );
  }
  return <ScheduleSection teamName={teamName} />;
};
