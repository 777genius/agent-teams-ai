import { ScheduleSection } from '../schedule/ScheduleSection';

interface Props {
  teamName: string;
  /** The logical team of a per-project team; its schedules belong to the team, per project. */
  logicalTeamName?: string;
  /** The project this screen shows: the default project of a new schedule. */
  projectPath?: string;
}

/**
 * The schedules of a team. A per-project team keeps one list under its own name;
 * each schedule names the project whose copy it runs against.
 */
export const TeamScheduleSection = ({
  teamName,
  logicalTeamName,
  projectPath,
}: Readonly<Props>): React.JSX.Element =>
  logicalTeamName ? (
    <ScheduleSection teamName={logicalTeamName} projectScope={{ projectPath }} />
  ) : (
    <ScheduleSection teamName={teamName} />
  );
