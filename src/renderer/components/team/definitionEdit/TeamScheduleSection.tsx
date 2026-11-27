import { useAppTranslation } from '@features/localization/renderer';
import { Clock } from 'lucide-react';

import { CollapsibleTeamSection } from '../CollapsibleTeamSection';
import { ScheduleSection } from '../schedule/ScheduleSection';

interface Props {
  teamName: string;
  /** The logical team of a per-project team; its schedules belong to the team, per project. */
  logicalTeamName?: string;
  /** The project this screen shows: the default project of a new schedule. */
  projectPath?: string;
}

/**
 * The collapsible "Schedules" section of a team screen. A per-project team keeps one list under
 * its own name; each schedule names the project whose copy it runs against.
 */
export const TeamScheduleSection = ({
  teamName,
  logicalTeamName,
  projectPath,
}: Readonly<Props>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <CollapsibleTeamSection
      sectionId="schedules"
      variant="flat"
      title={t('schedule.title')}
      icon={<Clock size={14} />}
      defaultOpen={false}
    >
      {logicalTeamName ? (
        <ScheduleSection teamName={logicalTeamName} projectScope={{ projectPath }} />
      ) : (
        <ScheduleSection teamName={teamName} />
      )}
    </CollapsibleTeamSection>
  );
};
