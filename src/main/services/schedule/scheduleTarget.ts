import type { TeamLaunchRequest, TeamLaunchResponse } from '@shared/types';

/** Where a schedule really runs. Ordinary teams keep their own name. */
export type ScheduleTarget =
  | { kind: 'native' }
  | { kind: 'project'; executionTeamName: string; projectPath: string }
  | { kind: 'refused'; reason: string };

export type ScheduleAdmission = { allowed: true } | { allowed: false; reason: string };

/** A launch the team's own admission turned down; recorded as a skip, never as a failure. */
export interface ScheduleLaunchRefusal {
  refused: string;
}

/** The reason a team may not be scheduled, or null. A plain `false` keeps a generic reason. */
export function admissionRefusal(admission: boolean | ScheduleAdmission): string | null {
  if (admission === true || (admission !== false && admission.allowed)) return null;
  return admission === false ? 'Scheduling is unavailable for this team' : admission.reason;
}

/**
 * Asked when a schedule is created, edited, triggered or fired. `cwd` is the project folder the
 * schedule is about; a per-project team's schedule is refused when it is not a real folder.
 */
export type ScheduleAdmissionCheck = (
  teamName: string,
  cwd?: string
) => Promise<boolean | ScheduleAdmission>;

/** What the scheduler needs from the layer that knows about per-project teams. */
export interface ScheduleTargets {
  admit: ScheduleAdmissionCheck;
  resolve(schedule: { teamName: string; launchConfig: { cwd: string } }): Promise<ScheduleTarget>;
  /** `request.teamName` is the project copy chosen by `resolve`. */
  launch(
    schedule: { teamName: string; launchConfig: { cwd: string } },
    request: TeamLaunchRequest
  ): Promise<TeamLaunchResponse | ScheduleLaunchRefusal>;
}
