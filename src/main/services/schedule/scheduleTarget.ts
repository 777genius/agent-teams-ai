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
 * The project folder a create or edit gives a schedule. `from` is the folder the schedule already
 * has (an edit): the project of a schedule of a per-project team is fixed once it is created.
 */
export interface ScheduleFolderChange {
  cwd?: string;
  from?: string;
}

/** What an edit does to the folder: `cwd` is set only when the patch names one (even blank). */
export function folderChange(
  existing: { launchConfig: { cwd: string } },
  patch: { launchConfig?: { cwd?: string } }
): ScheduleFolderChange {
  const config = patch.launchConfig;
  return {
    cwd: config && 'cwd' in config ? (config.cwd ?? '') : undefined,
    from: existing.launchConfig.cwd,
  };
}

/** Asked when a schedule is created, edited, triggered or fired. */
export type ScheduleAdmissionCheck = (
  teamName: string,
  change?: ScheduleFolderChange
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

export async function assertScheduleAdmission(
  admit: ScheduleAdmissionCheck,
  teamName: string,
  change?: ScheduleFolderChange
): Promise<void> {
  const refusal = admissionRefusal(await admit(teamName, change));
  if (refusal) throw new Error(refusal);
}
